/**
 * 62.1 D2-D4: decision-extractor over the transcript DELTA — each range read once, committed once.
 *
 * From the hook's cursor (D2), complete turns are packed in order into batches that fit the observer's input bounds
 * (at least one turn per batch). Each batch is one Phase A → Phase B:
 *  - Phase A (no memory writes): admission (the batch must hold assistant text of 40+ characters or a tool action),
 *    the observer with a CONTEXT section (the two turns before the batch and this session's recorded observation
 *    titles), the regex decisions and antipatterns.
 *  - Phase B (one IMMEDIATE transaction): the cursor must still be where Phase A read it — else the work is
 *    discarded (another writer did it). `ok`/`empty` write the batch's effects (observation documents, triples, items,
 *    the session documents' renders) and advance the cursor past the batch; `retryable` QUARANTINES the range in
 *    `stop_retries` (D3) and advances the cursor, so later turns progress and nothing is dropped.
 * The handler loops batches while the Stop budget allows; unprocessed turns wait for the next Stop.
 */

import { closeSync, existsSync, openSync, readSync } from "fs";
import { randomUUID } from "crypto";
import type { Store } from "./store.ts";
import type { TranscriptMessage } from "./hooks.ts";
import { isoNow } from "./clock.ts";
import {
  monoNow, deadlineAfter, deadlineBefore, remainingForTimeout, shorterThan, duration,
  type MonoDeadline,
} from "./clock.ts";
import { lastChanges, stopPipelineReady, nextRetryAt, RETRY_BACKOFF_MS } from "./stop-schema.ts";
import { judgePhaseA, judgePhaseB, type JudgePrepared } from "./stop-judge.ts";
import { insertCausalMarker } from "./stop-causal.ts";
import { insertJudgeRunBestEffort } from "./judge-audit.ts";
import { stopHostOf, transcriptKey } from "./stop-pairing.ts";
import { locatorPath, registerTranscript } from "./stop-identity.ts";
import {
  readLines, segmentTurns, rangeSha, resolveCursorStart, readStopCursor, casAdvanceCursor, streamLines,
  STOP_READ_MAX_BYTES, type StopCursor, type TranscriptLine, type FileIdentity, type StreamEnd,
} from "./stop-cursor.ts";
import {
  extractObservationsResult, observerRenderChars, OBSERVER_MAX_MESSAGES, OBSERVER_MAX_RENDER_CHARS, OBSERVER_BATCH_RESERVED_CHARS,
  type Observation, type ObservationResult,
} from "./observer.ts";
import { insertStopItem, itemFingerprint, reconcileSessionDocs } from "./stop-session-docs.ts";
import { PERSIST_RESERVE_MS, CAUSAL_MIN_BUDGET_MS } from "./causal-writer.ts";
import type { ObservationWithDoc } from "./amem.ts";
import {
  persistObservationDoc, insertObservationTriples, extractDecisions, extractAntipatterns,
} from "./hooks/decision-extractor.ts";

export const DECISION_HOOK = "decision-extractor";
const ADMISSION_TEXT_CHARS = 40;
const CONTEXT_PRIOR_TURNS = 2;
const RECORDED_TITLES_MAX = 30;
const DEFAULT_RUN_BUDGET_MS = 30_000;
/** The CONTEXT before a batch is read from at most this far back (it is advisory: "already recorded — do not extract"). */
const CONTEXT_MAX_BYTES = 4 * 1024 * 1024;
/** Characters kept per accumulated message (the observer renders at most 1,000 of one). */
const ACCUMULATED_MESSAGE_CHARS = 2_000;
/**
 * A safety bound on the regex items one streamed stretch keeps (every distinct one below it is kept — the batch path
 * keeps them all too); reaching it is logged, never silent (T25 #3).
 */
const ACCUMULATED_ITEMS_MAX = 2_000;
/** The tools whose calls name the files a turn changed (handoff digests). */
export const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
const ACCUMULATED_FILES_MAX = 50;
export { RETRY_BACKOFF_MS };

/** A transcript's lines as the observer's messages: human → user, assistant and tool results as rendered. */
export function toObserverMessages(lines: readonly TranscriptLine[]): TranscriptMessage[] {
  const out: TranscriptMessage[] = [];
  for (const l of lines) {
    if (l.kind === "human") out.push({ role: "user", content: l.text });
    else if (l.kind === "assistant") out.push({ role: "assistant", content: l.rendered });
    else if (l.kind === "tool_result") out.push({ role: "user", content: l.rendered });
  }
  return out;
}

/** Admission (D4): the batch holds an assistant message with 40+ characters of text, or a tool action. */
export function admitsBatch(lines: readonly TranscriptLine[]): boolean {
  return lines.some(l => l.kind === "assistant" && (l.text.trim().length >= ADMISSION_TEXT_CHARS || (l.toolUses?.length ?? 0) > 0));
}

/**
 * T24 #1/#5: what the Stop consumers need from lines streamed past one read's bound, kept bounded whatever the length
 * streamed: the first human entry, the last OBSERVER_MAX_MESSAGES observer messages (each capped — the observer
 * renders at most 1,000 characters of one, and only its last 100 messages), admission, the last assistant text, the
 * files the edit tools touched, and the regex decisions/antipatterns (each found in its full message, with the
 * preceding user message as context, as the batch extractors do).
 */
export type LineAccumulator = {
  start: number;
  end: number;
  lines: number;
  humanText: string | null;
  humanTs: number | null;
  humanStart: number | null;
  firstTs: number | null;
  messages: TranscriptMessage[];
  messageCount: number;
  admits: boolean;
  lastAssistantText: string;
  files: string[];
  decisions: { text: string; context: string }[];
  antipatterns: { text: string; context: string }[];
  lastLineSha: string | null;
  /** A stop marker was read after the stretch's last assistant line (Claude Code: the turn ended, T25 #1). */
  stopMarked: boolean;
  /** The stretch holds an assistant line. */
  answered: boolean;
  /** Keys of the kept regex items (dedup across the stream), and whether the safety bound was reached. */
  itemKeys: Set<string>;
  itemsCapped: boolean;
};

export function newAccumulator(start: number): LineAccumulator {
  return {
    start, end: start, lines: 0, humanText: null, humanTs: null, humanStart: null, firstTs: null, messages: [],
    messageCount: 0, admits: false, lastAssistantText: "", files: [], decisions: [], antipatterns: [], lastLineSha: null,
    stopMarked: false, answered: false, itemKeys: new Set(), itemsCapped: false,
  };
}

function pushUnique(acc: LineAccumulator, kind: "d" | "a", items: { text: string; context: string }[]): void {
  const list = kind === "d" ? acc.decisions : acc.antipatterns;
  for (const it of items) {
    const key = `${kind}:${it.text.slice(0, 80).toLowerCase()}`;
    if (acc.itemKeys.has(key)) continue;
    if (list.length >= ACCUMULATED_ITEMS_MAX) {
      if (!acc.itemsCapped) console.warn(`[decision-extractor] a streamed stretch at ${acc.start} holds over ${ACCUMULATED_ITEMS_MAX} regex items of one kind — later ones not kept`);
      acc.itemsCapped = true;
      continue;
    }
    acc.itemKeys.add(key);
    list.push(it);
  }
}

export function accumulateLine(acc: LineAccumulator, l: TranscriptLine): void {
  if (acc.lines === 0) acc.start = l.start;
  if (l.kind === "human" && acc.humanStart === null) { acc.humanText = l.text; acc.humanTs = l.ts; acc.humanStart = l.start; }
  if (acc.firstTs === null && l.ts !== null) acc.firstTs = l.ts;
  for (const m of toObserverMessages([l])) {
    if (m.role === "assistant") {
      const recent = [...acc.messages.slice(-3), m];
      pushUnique(acc, "d", extractDecisions(recent).map(d => ({ text: d.text, context: d.context })));
      pushUnique(acc, "a", extractAntipatterns([m]));
    }
    acc.messages.push(m.content.length > ACCUMULATED_MESSAGE_CHARS ? { ...m, content: m.content.slice(0, ACCUMULATED_MESSAGE_CHARS) } : m);
    if (acc.messages.length > OBSERVER_MAX_MESSAGES) acc.messages.shift();
    acc.messageCount++;
  }
  if (l.stopMarker && acc.answered) acc.stopMarked = true;   // closes only an answered stretch (T26 #1)
  if (l.kind === "assistant") {
    acc.answered = true;
    acc.stopMarked = false;   // the turn went on past an earlier marker (a Stop hook that blocked)
    if (l.text.trim().length >= ADMISSION_TEXT_CHARS || (l.toolUses?.length ?? 0) > 0) acc.admits = true;
    if (l.text.trim().length > 0) acc.lastAssistantText = l.text;
    for (const u of l.toolUses ?? []) {
      if (!EDIT_TOOLS.has(u.name) || acc.files.length >= ACCUMULATED_FILES_MAX) continue;
      const f = u.input.file_path ?? u.input.notebook_path;
      if (typeof f === "string" && f.length > 0 && f.length < 500 && !acc.files.includes(f)) acc.files.push(f);
    }
  }
  acc.end = l.end;
  acc.lastLineSha = l.sha;
  acc.lines++;
}

/** The observer's messages of an accumulated stretch: its human request first even when the kept tail dropped it. */
export function accumulatedMessages(acc: LineAccumulator): TranscriptMessage[] {
  if (acc.humanText !== null && acc.messageCount > acc.messages.length) {
    return [{ role: "user", content: acc.humanText }, ...acc.messages.slice(1)];
  }
  return acc.messages;
}

/**
 * Stream lines from `from` into an accumulator — through `to`, or (stopAtNextHuman) until the next human entry after
 * the first line: one turn, however large, read once in bounded reads and processed as ONE turn (T24 #1). `reachedHuman`:
 * the turn's end was seen.
 */
export function accumulateLines(
  path: string,
  from: number,
  opts: { stopAtNextHuman: boolean; to?: number; maxBytes?: number; deadline?: MonoDeadline; releaseTrailingCommand?: boolean },
): { acc: LineAccumulator; stream: StreamEnd; reachedHuman: boolean } {
  const acc = newAccumulator(from);
  let reachedHuman = false;
  const stream = streamLines(path, from, l => {
    if (opts.stopAtNextHuman && acc.lines > 0 && l.kind === "human") { reachedHuman = true; return false; }
    accumulateLine(acc, l);
  }, { maxBytes: opts.maxBytes, to: opts.to, deadline: opts.deadline, releaseTrailingCommand: opts.releaseTrailingCommand });
  return { acc, stream, reachedHuman };
}

/** Pack complete turns, in order, into batches within the observer's bounds; at least one turn per batch. */
export function packTurnBatches<T extends { messages: TranscriptMessage[] }>(
  turns: readonly T[],
  bounds: { maxMessages: number; maxChars: number; reservedChars?: number },
): T[][] {
  const batches: T[][] = [];
  let cur: T[] = [];
  const fits = (b: T[]) => {
    const msgs = b.flatMap(t => t.messages);
    return msgs.length <= bounds.maxMessages && observerRenderChars(msgs) + (bounds.reservedChars ?? 0) <= bounds.maxChars;
  };
  for (const t of turns) {
    if (cur.length > 0 && !fits([...cur, t])) { batches.push(cur); cur = []; }
    cur.push(t);
  }
  if (cur.length > 0) batches.push(cur);
  return batches;
}

type Turn = { lines: TranscriptLine[]; messages: TranscriptMessage[]; start: number; end: number };

/**
 * The lines of the last `n` turns that end at `offset` (the CONTEXT before the first batch), read from at most
 * CONTEXT_MAX_BYTES back: past a huge earlier turn, its tail is the context (it is advisory).
 */
function lastTurnsBefore(path: string, offset: number, n: number): TranscriptLine[] {
  if (offset <= 0) return [];
  const from = offset <= CONTEXT_MAX_BYTES ? 0 : alignToLineStart(path, offset - CONTEXT_MAX_BYTES);
  if (from >= offset) return [];
  const read = readLines(path, from, { to: offset, maxBytes: offset - from, releaseTrailingCommand: true });
  const humans = read.lines.map((l, i) => (l.kind === "human" ? i : -1)).filter(i => i >= 0);
  return read.lines.slice(humans.length >= n ? humans[humans.length - n]! : 0);
}

/** The first line start at or after `pos` (the byte after the first '\n' at or after pos - 1). */
function alignToLineStart(path: string, pos: number): number {
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.allocUnsafe(64 * 1024);
    for (let p = pos - 1; ; p += buf.length) {
      const n = readSync(fd, buf, 0, buf.length, p);
      if (n <= 0) return p;
      const nl = buf.subarray(0, n).indexOf(0x0a);
      if (nl >= 0) return p + nl + 1;
    }
  } finally {
    closeSync(fd);
  }
}

function recordedTitles(store: Store, sessionId: string, sourceTime: string | null): string[] {
  const sid8 = sessionId.slice(0, 8);
  const rows = store.db.prepare(
    `SELECT title FROM documents WHERE collection = '_clawmem' AND path LIKE 'observations/%' AND path LIKE ? AND active = 1
       ${sourceTime ? "AND created_at <= ?" : ""} ORDER BY created_at DESC LIMIT ?`
  ).all(...[`%-${sid8}-%`, ...(sourceTime ? [sourceTime] : []), RECORDED_TITLES_MAX]) as { title: string }[];
  return rows.map(r => r.title).reverse();
}

export type RangeRef = {
  anchorEpoch: number;
  from: number;
  to: number;
  sha: string;
  key: string;
  sourceTime: string | null;
};

function rangeRefOf(path: string, epoch: number, lines: readonly TranscriptLine[]): RangeRef {
  const from = lines[0]!.start;
  const to = lines.at(-1)!.end;
  const sha = rangeSha(path, from, to)!;
  const first = lines.find(l => l.kind === "human" && l.ts !== null) ?? lines.find(l => l.ts !== null);
  return {
    anchorEpoch: epoch, from, to, sha, key: `${epoch}-${from}-${to}-${sha.slice(0, 16)}`,
    sourceTime: first?.ts != null ? new Date(first.ts).toISOString() : null,
  };
}

export type RegexItems = { decisions: { text: string; context: string }[]; antipatterns: { text: string; context: string }[] };

function regexItemsOf(messages: TranscriptMessage[]): RegexItems {
  return {
    decisions: extractDecisions(messages).map(d => ({ text: d.text, context: d.context })),
    antipatterns: extractAntipatterns(messages),
  };
}

/** The Phase B effects of an `ok`/`empty` batch (inside the transaction). Returns the persisted observations. */
function writeBatchEffects(
  store: Store,
  sessionId: string,
  key: string,
  range: RangeRef,
  observations: Observation[],
  regex: RegexItems,
  now: string,
  replay: boolean,
): ObservationWithDoc[] {
  const db = store.db;
  const dateStr = now.slice(0, 10);
  const persisted: ObservationWithDoc[] = [];
  for (const obs of observations) {
    const wit = persistObservationDoc(store, obs, sessionId, dateStr, now);
    if (!wit) continue;
    if (replay && range.sourceTime) store.updateDocumentMeta(wit.docId, { authored_at: range.sourceTime });   // D3: source time
    persisted.push(wit);
  }
  insertObservationTriples(store, observations, persisted);
  const item = (kind: "decision" | "antipattern", payload: unknown) => insertStopItem(db, {
    sessionId, transcriptKey: key, kind, fp: itemFingerprint(payload), payload,
    anchorEpoch: range.anchorEpoch, rangeFrom: range.from, rangeTo: range.to, rangeSha: range.sha,
  });
  for (const o of observations.filter(o => o.type === "decision")) {
    item("decision", { source: "observer", title: o.title, facts: o.facts, narrative: o.narrative, filesModified: o.filesModified });
  }
  for (const d of regex.decisions) item("decision", { source: "regex", text: d.text, context: d.context });
  for (const a of regex.antipatterns) item("antipattern", { text: a.text, context: a.context });
  reconcileSessionDocs(db, sessionId, key, now);
  return persisted;
}

/** Quarantine a failed range (inside the Phase B transaction): retried with backoff, never skipped. */
function quarantineRange(store: Store, p: { sessionId: string; key: string; path: string; file: FileIdentity; range: RangeRef; reason: string; now: string }): void {
  const next = nextRetryAt(p.now, 1);
  store.db.prepare(
    `INSERT OR IGNORE INTO stop_retries (session_id, transcript_key, hook, transcript_path, file_dev, file_ino, first_line_sha,
       anchor_epoch, from_offset, to_offset, range_key, range_sha, source_time, attempts, last_error, first_failed_at,
       next_retry_at, state)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, 'queued')`
  ).run(p.sessionId, p.key, DECISION_HOOK, p.path, p.file.dev, p.file.ino, p.file.firstLineSha, p.range.anchorEpoch,
    p.range.from, p.range.to, p.range.key, p.range.sha, p.range.sourceTime, p.reason, p.now, next);
}

class CursorMoved extends Error {}
class ClaimLost extends Error {}

type PhaseAOut = {
  result: ObservationResult;
  judged: JudgePrepared | null;
  decisionFacts: { obs: Observation; fact: string }[];
};

/**
 * Phase A for one range — admission, the observer (with CONTEXT), the judge's call. No memory writes. `null` when the
 * budget does not allow starting it and the caller should stop rather than quarantine (`quarantineIfNoBudget` false).
 */
async function phaseA(
  store: Store,
  p: {
    sessionId: string; admits: boolean; messages: TranscriptMessage[]; prior: TranscriptLine[];
    sourceTime: string | null; deadline: MonoDeadline; quarantineIfNoBudget: boolean; phaseSkipNotes?: string[];
  },
): Promise<PhaseAOut | null> {
  let result: ObservationResult;
  if (!p.admits) {
    result = { status: "empty" };
  } else {
    const remaining = remainingForTimeout(deadlineBefore(p.deadline, duration(PERSIST_RESERVE_MS)));
    if (remaining === null || shorterThan(remaining, duration(CAUSAL_MIN_BUDGET_MS))) {
      if (!p.quarantineIfNoBudget) return null;
      p.phaseSkipNotes?.push("observation extraction skipped: Stop budget below the floor — range quarantined");
      result = { status: "retryable", reason: "Stop budget below the observer floor" };
    } else {
      result = await extractObservationsResult(p.messages, {
        timeoutMs: remaining,
        context: { priorMessages: toObserverMessages(p.prior), recordedTitles: recordedTitles(store, p.sessionId, p.sourceTime) },
      });
    }
  }
  // The contradiction judge for the range's decisions (D3): inference only; effects wait for Phase B.
  const decisionFacts = (result.status === "ok" ? result.observations : [])
    .filter(o => o.type === "decision").flatMap(o => o.facts.map(fact => ({ obs: o, fact })));
  let judged: JudgePrepared | null = null;
  if (decisionFacts.length > 0) {
    try {
      judged = await judgePhaseA(store, decisionFacts.map(f => f.fact), p.sessionId, p.deadline, { sourceTime: p.sourceTime });
    } catch (err) {
      console.error(`[decision-extractor] Error in contradiction detection:`, err);
    }
  }
  return { result, judged, decisionFacts };
}

/** Phase B effects of an `ok`/`empty` range (inside the transaction): documents, items, renders, causal marker, verdicts. */
function commitRangeEffects(
  store: Store,
  p: { sessionId: string; key: string; range: RangeRef; a: PhaseAOut; regex: RegexItems; now: string; replay: boolean },
): ObservationWithDoc[] {
  const observations = p.a.result.status === "ok" ? p.a.result.observations : [];
  const persisted = writeBatchEffects(store, p.sessionId, p.key, p.range, observations, p.regex, p.now, p.replay);
  // D3: the range owes its causal step (Phase C), keyed by the range — at most one run, whatever happens next. A
  // replayed range's window is its source time.
  insertCausalMarker(store, {
    sessionId: p.sessionId, transcriptKey: p.key, rangeKey: p.range.key, obsDocIds: persisted.map(x => x.docId),
    sourceTime: p.range.sourceTime, windowAt: p.replay ? (p.range.sourceTime ?? p.now) : p.now, now: p.now,
  });
  const judged = p.a.judged;
  if (judged) {
    const docOf = new Map(persisted.map(x => [x.facts, x.docId] as const));
    const factDocIds = p.a.decisionFacts.map(f => docOf.get(f.obs.facts) ?? null);
    try {
      const j = judgePhaseB(store, judged, factDocIds, p.sessionId);
      if (j.contradictions > 0) console.error(`[decision-extractor] Found ${j.contradictions} contradiction(s) with prior decisions`);
    } catch (err) {
      // The verdicts' own savepoint rolled back; the range still commits (§J7: an unauditable erosion never lands).
      insertJudgeRunBestEffort(store.db, {
        sessionId: p.sessionId, consumer: "decision-extractor", lane: judged.audit.lane, model: judged.audit.model,
        endpoint: judged.audit.endpoint, promptVersion: judged.audit.promptVersion, newFactCount: judged.newFacts.length,
        candidateCount: judged.candidates.length, responseSha256: judged.audit.responseSha256, outcome: "write_error",
      });
      console.error(`[decision-extractor] contradiction apply FAILED — no verdict applied: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return persisted;
}

export type ExtractionArgs = {
  sessionId: string;
  transcriptPath: string;
  host?: string;
  sessionKey?: string;
  /** The Stop handler's whole-handler deadline (monotonic); default: 30 s from now. */
  deadline?: MonoDeadline;
  /** Test seam: stop after this many batches. */
  maxBatches?: number;
  /** Test seam: runs between a batch's Phase A and its Phase B. */
  beforePhaseB?: () => void;
  phaseSkipNotes?: string[];
  /** Test seam: the read's byte bound (default STOP_READ_MAX_BYTES). */
  readMaxBytes?: number;
  /** Called after each committed batch (Phase C: the causal step owed by that range). */
  afterCommit?: (committed: { range: RangeRef; observations: Observation[]; persisted: ObservationWithDoc[] }) => Promise<void>;
};

export type ExtractionRun = {
  batches: number;
  committed: number;
  quarantined: number;
  discarded: number;
  observations: Observation[];
  persisted: ObservationWithDoc[];
};

/** One unit of work: a batch of complete turns, or one turn too large for a read, streamed whole (T24 #1). */
type Unit = {
  range: RangeRef;
  messages: TranscriptMessage[];
  admits: boolean;
  regex: RegexItems;
  tailSha: string;
  lastHumanStart: number | null;
  humans: number;
  /** The CONTEXT lines the NEXT unit sees (this unit's last turns). */
  tailLines: TranscriptLine[];
};

function unitOfBatch(path: string, epoch: number, batch: Turn[]): Unit {
  const lines = batch.flatMap(t => t.lines);
  const messages = batch.flatMap(t => t.messages);
  const humans = lines.filter(l => l.kind === "human");
  return {
    range: rangeRefOf(path, epoch, lines), messages, admits: admitsBatch(lines), regex: regexItemsOf(messages),
    tailSha: lines.at(-1)!.sha, lastHumanStart: humans.at(-1)?.start ?? null, humans: humans.length,
    tailLines: batch.slice(-CONTEXT_PRIOR_TURNS).flatMap(t => t.lines),
  };
}

function rangeOfAccumulator(path: string, epoch: number, acc: LineAccumulator): RangeRef {
  const sha = rangeSha(path, acc.start, acc.end)!;
  const ts = acc.humanTs ?? acc.firstTs;
  return {
    anchorEpoch: epoch, from: acc.start, to: acc.end, sha, key: `${epoch}-${acc.start}-${acc.end}-${sha.slice(0, 16)}`,
    sourceTime: ts !== null ? new Date(ts).toISOString() : null,
  };
}

export async function runDecisionExtraction(store: Store, args: ExtractionArgs): Promise<ExtractionRun> {
  const run: ExtractionRun = { batches: 0, committed: 0, quarantined: 0, discarded: 0, observations: [], persisted: [] };
  const db = store.db;
  const path = locatorPath(args.transcriptPath);
  if (!stopPipelineReady(db) || !path || !existsSync(path)) return run;
  const key = transcriptKey(path);
  registerTranscript(db, args.sessionId, path, stopHostOf(args.host), args.sessionKey ?? null);
  const deadline = args.deadline ?? deadlineAfter(monoNow(), duration(DEFAULT_RUN_BUDGET_MS));

  const start = resolveCursorStart(db, args.sessionId, DECISION_HOOK, key, path, { host: stopHostOf(args.host) });
  if (!start) return run;
  if (start.reason === "re-anchor") {
    console.error(`[decision-extractor] transcript changed under the cursor (${start.detail}) — re-anchored at the current turn (generation ${start.anchorEpoch})`);
  }
  const read = readLines(path, start.start, { maxBytes: args.readMaxBytes });
  const segs = segmentTurns(read.lines, { trailingComplete: read.eof }).filter(s => s.complete);
  let units: Unit[];
  if (segs.length === 0 && read.bounded) {
    // One turn larger than a read (T24 #1): streamed to its end in bounded reads, processed as ONE turn — never as
    // pieces, so its inference sees the turn's end. At a Stop the turn is over at the next human entry or at the end.
    const big = accumulateLines(path, start.start, { stopAtNextHuman: true, maxBytes: args.readMaxBytes, deadline });
    if (big.stream.expired || !(big.reachedHuman || big.stream.eof) || big.acc.lines === 0) return run;   // redone next Stop
    const acc = big.acc;
    units = [{
      range: rangeOfAccumulator(path, start.anchorEpoch, acc), messages: accumulatedMessages(acc), admits: acc.admits,
      regex: { decisions: acc.decisions, antipatterns: acc.antipatterns }, tailSha: acc.lastLineSha!,
      lastHumanStart: acc.humanStart, humans: acc.humanStart !== null ? 1 : 0, tailLines: [],
    }];
  } else {
    const turns: Turn[] = segs.map(s => ({ lines: s.lines, messages: toObserverMessages(s.lines), start: s.start, end: s.end }));
    if (turns.length === 0) return run;
    // Each batch leaves the CONTEXT's and a retry's share of the render budget (v0.41.1): the observer renders it whole.
    units = packTurnBatches(turns, { maxMessages: OBSERVER_MAX_MESSAGES, maxChars: OBSERVER_MAX_RENDER_CHARS, reservedChars: OBSERVER_BATCH_RESERVED_CHARS })
      .map(batch => unitOfBatch(path, start.anchorEpoch, batch));
  }

  let prior = lastTurnsBefore(path, units[0]!.range.from, CONTEXT_PRIOR_TURNS);
  let cursor: StopCursor | null = start.cursor;
  for (const u of units) {
    if (args.maxBatches !== undefined && run.batches >= args.maxBatches) break;
    const range = u.range;

    // Phase A — inference, no memory writes. The first batch of a Stop is always decided (a budget skip quarantines
    // it); later batches wait for the next Stop.
    const a = await phaseA(store, {
      sessionId: args.sessionId, admits: u.admits, messages: u.messages, prior, sourceTime: null, deadline,
      quarantineIfNoBudget: run.batches === 0, phaseSkipNotes: args.phaseSkipNotes,
    });
    if (!a) break;
    run.batches++;
    args.beforePhaseB?.();

    // Phase B — one transaction, CAS on the cursor position Phase A read.
    const now = isoNow();
    let persisted: ObservationWithDoc[] = [];
    try {
      db.transaction(() => {
        if (a.result.status === "retryable") {
          quarantineRange(store, { sessionId: args.sessionId, key, path, file: start.file, range, reason: a.result.reason, now });
        } else {
          persisted = commitRangeEffects(store, { sessionId: args.sessionId, key, range, a, regex: u.regex, now, replay: false });
        }
        const moved = !casAdvanceCursor(db, args.sessionId, DECISION_HOOK, key, cursor, {
          transcriptPath: path, file: start.file, anchorEpoch: start.anchorEpoch, byteOffset: range.to,
          tailSha: u.tailSha, turnStartOffset: u.lastHumanStart ?? cursor?.turnStartOffset ?? null,
          humanTurns: (cursor?.humanTurns ?? 0) + u.humans,
        });
        if (moved) throw new CursorMoved();
      }).immediate();
    } catch (err) {
      if (err instanceof CursorMoved) { run.discarded++; break; }   // another writer committed this range
      throw err;
    }
    cursor = readStopCursor(db, args.sessionId, DECISION_HOOK, key);
    if (a.result.status === "retryable") {
      run.quarantined++;
    } else {
      const observations = a.result.status === "ok" ? a.result.observations : [];
      run.committed++;
      run.observations.push(...observations);
      run.persisted.push(...persisted);
      if (args.afterCommit) await args.afterCommit({ range, observations, persisted });
    }
    prior = u.tailLines;
  }
  return run;
}

// ── Replay of quarantined ranges (D3) ───────────────────────────────────────────────────────────────────────────

const LEASE_MS = 5 * 60_000;

type RetryRow = {
  id: number; session_id: string; transcript_key: string; transcript_path: string; anchor_epoch: number;
  from_offset: number; to_offset: number; range_key: string; range_sha: string; source_time: string | null; attempts: number;
};

export type ReplayRun = { replayed: number; unavailable: number; rescheduled: number; persisted: ObservationWithDoc[]; ranges: RangeRef[] };

/**
 * Replay due quarantined ranges (later Stops: at most one, inside their budget; the worker: bounded). Each is claimed
 * with a 5-minute lease (a crashed claimant's item is reclaimable after it), its bytes are re-read by its own locator
 * and verified against `range_sha` first — changed bytes → `unavailable`, nothing processed — and its Phase B writes
 * the effects (with the range's SOURCE time) and marks it `done` in one transaction that CAS-checks the claim token.
 * The range is streamed into a bounded accumulator (T24): one read of any size, never all of it in memory.
 */
export async function replayDueRetries(
  store: Store,
  opts: { deadline: MonoDeadline; sessionId?: string; limit?: number; beforePhaseB?: () => void; afterClaim?: () => void },
): Promise<ReplayRun> {
  const out: ReplayRun = { replayed: 0, unavailable: 0, rescheduled: 0, persisted: [], ranges: [] };
  const db = store.db;
  if (!stopPipelineReady(db)) return out;
  const now0 = isoNow();
  const due = db.prepare(
    `SELECT id, session_id, transcript_key, transcript_path, anchor_epoch, from_offset, to_offset, range_key, range_sha, source_time, attempts
     FROM stop_retries WHERE hook = ?
       AND ((state = 'queued' AND next_retry_at <= ?) OR (state = 'claimed' AND lease_expires_at < ?))
       ${opts.sessionId ? "AND session_id = ?" : ""}
     ORDER BY next_retry_at, id LIMIT ?`
  ).all(...[DECISION_HOOK, now0, now0, ...(opts.sessionId ? [opts.sessionId] : []), opts.limit ?? 1]) as RetryRow[];
  for (const r of due) {
    const token = randomUUID();
    const claimAt = isoNow();
    db.prepare(
      `UPDATE stop_retries SET state = 'claimed', claim_token = ?, lease_expires_at = ?
       WHERE id = ? AND ((state = 'queued' AND next_retry_at <= ?) OR (state = 'claimed' AND lease_expires_at < ?))`
    ).run(token, new Date(Date.parse(claimAt) + LEASE_MS).toISOString(), r.id, claimAt, claimAt);
    if (lastChanges(db) !== 1) continue;   // another processor holds it
    opts.afterClaim?.();
    const setState = (sql: string, ...args: (string | number | null)[]) => {
      db.prepare(`UPDATE stop_retries SET ${sql} WHERE id = ? AND claim_token = ?`).run(...args, r.id, token);
      return lastChanges(db) === 1;
    };
    // Integrity first: the range must hold exactly the bytes that failed.
    if (!existsSync(r.transcript_path) || rangeSha(r.transcript_path, r.from_offset, r.to_offset) !== r.range_sha) {
      if (setState(`state = 'unavailable', claim_token = NULL, lease_expires_at = NULL, last_error = 'range bytes changed or transcript gone'`)) out.unavailable++;
      continue;
    }
    const replayRead = accumulateLines(r.transcript_path, r.from_offset, {
      stopAtNextHuman: false, to: r.to_offset, maxBytes: STOP_READ_MAX_BYTES, deadline: opts.deadline, releaseTrailingCommand: true,
    });
    if (replayRead.stream.expired) {
      setState(`state = 'queued', claim_token = NULL, lease_expires_at = NULL`);   // out of budget: due again at once
      break;
    }
    const acc = replayRead.acc;
    const range: RangeRef = { anchorEpoch: r.anchor_epoch, from: r.from_offset, to: r.to_offset, sha: r.range_sha, key: r.range_key, sourceTime: r.source_time };
    const prior = lastTurnsBefore(r.transcript_path, r.from_offset, CONTEXT_PRIOR_TURNS);
    const a = await phaseA(store, {
      sessionId: r.session_id, admits: acc.admits, messages: accumulatedMessages(acc), prior, sourceTime: r.source_time,
      deadline: opts.deadline, quarantineIfNoBudget: true,
    });
    opts.beforePhaseB?.();
    const now = isoNow();
    let persisted: ObservationWithDoc[] = [];
    try {
      db.transaction(() => {
        if (a!.result.status === "retryable") {
          if (!setState(`state = 'queued', claim_token = NULL, lease_expires_at = NULL, attempts = attempts + 1, last_error = ?, next_retry_at = ?`,
            a!.result.reason, nextRetryAt(now, r.attempts + 1))) throw new ClaimLost();
          return;
        }
        persisted = commitRangeEffects(store, {
          sessionId: r.session_id, key: r.transcript_key, range, a: a!, regex: { decisions: acc.decisions, antipatterns: acc.antipatterns }, now, replay: true,
        });
        if (!setState(`state = 'done', claim_token = NULL, lease_expires_at = NULL`)) throw new ClaimLost();
      }).immediate();
    } catch (err) {
      if (err instanceof ClaimLost) continue;   // the lease expired and another processor took it: nothing of ours stands
      throw err;
    }
    if (a!.result.status === "retryable") { out.rescheduled++; continue; }
    out.replayed++;
    out.persisted.push(...persisted);
    out.ranges.push(range);
  }
  return out;
}
