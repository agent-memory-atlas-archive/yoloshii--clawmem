/**
 * 62.1 D10: the stop pipeline's health, for `clawmem doctor` (lines + pass/fail) and `clawmem status` (one line):
 * migration and fence, older writers caught by the fence, the one-time recompute, queue depths and oldest ages,
 * causal markers runnable vs waiting on mode `off`, causal runs stuck in progress, keyless usage rows awaiting their
 * binding, preserved antipattern bodies, and the grace-expiry projection.
 */

import type { Database } from "bun:sqlite";
import { epochNow, epochMs } from "./clock.ts";
import { missingStopSchema } from "./stop-schema.ts";
import { recomputeDone, graceExpiryProjection } from "./stop-repair.ts";
import { antipatternBodiesPreserved } from "./stop-recover.ts";
import { resolveCausalWriterMode } from "./causal-writer.ts";

const HOUR_MS = 3_600_000;
/** A queue item older than this is reported (the worker should have drained it). */
export const STALE_QUEUE_MS = 24 * HOUR_MS;
/** An older writer the fence caught within this long still fails doctor; one seen only before is reported as past. */
export const LEGACY_WRITER_RECENT_MS = 24 * HOUR_MS;

export type QueueHealth = { count: number; oldest: string | null };

export type LegacyWriter = { surface: string; count: number; firstAt: string; lastAt: string };

export type StopHealth = {
  missing: string[];
  /** Every surface the fence has caught an older writer on (the log keeps its rows). */
  legacyWriters: LegacyWriter[];
  /** Those whose last caught write is within LEGACY_WRITER_RECENT_MS: an older process is (still) running. */
  legacyWritersRecent: LegacyWriter[];
  recomputeDone: boolean;
  bodiesPreserved: boolean;
  recoveredBodies: number;
  stopRetries: QueueHealth;
  unavailableRanges: number;
  feedbackPending: QueueHealth;
  /** Verdicts credited provisionally on a quiet transcript and still open (final on a later turn, a Stop, a session end). */
  feedbackProvisional: QueueHealth;
  keylessPending: number;
  judgeDeferred: QueueHealth;
  handoffRenders: QueueHealth;
  causalRunnable: number;
  causalWaitingOff: number;
  causalStuck: number;
  graceByWeek: number[];
};

function hasTable(db: Database, name: string): boolean {
  return !!db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(name);
}

function queue(db: Database, sql: string, ...args: (string | number)[]): QueueHealth {
  const r = db.prepare(sql).get(...args) as { n: number; oldest: string | null };
  return { count: r.n, oldest: r.oldest };
}

export function stopPipelineHealth(db: Database): StopHealth {
  const missing = missingStopSchema(db);
  const empty: QueueHealth = { count: 0, oldest: null };
  const h: StopHealth = {
    missing, legacyWriters: [], legacyWritersRecent: [], recomputeDone: false, bodiesPreserved: false, recoveredBodies: 0,
    stopRetries: empty, unavailableRanges: 0, feedbackPending: empty, feedbackProvisional: empty, keylessPending: 0, judgeDeferred: empty,
    handoffRenders: empty, causalRunnable: 0, causalWaitingOff: 0, causalStuck: 0, graceByWeek: [],
  };
  if (hasTable(db, "legacy_writer_log")) {
    h.legacyWriters = (db.prepare(`SELECT surface, count, first_at, last_at FROM legacy_writer_log ORDER BY last_at DESC`).all() as
      { surface: string; count: number; first_at: string; last_at: string }[])
      .map(r => ({ surface: r.surface, count: r.count, firstAt: r.first_at, lastAt: r.last_at }));
    const since = epochMs(epochNow()) - LEGACY_WRITER_RECENT_MS;
    h.legacyWritersRecent = h.legacyWriters.filter(w => !(Date.parse(w.lastAt) < since));   // unparsable counts as recent
  }
  if (missing.some(m => m.startsWith("table ") || m.startsWith("flag "))) return h;
  h.recomputeDone = recomputeDone(db);
  h.bodiesPreserved = antipatternBodiesPreserved(db);
  h.recoveredBodies = (db.prepare(`SELECT COUNT(*) AS n FROM recovered_antipattern_bodies`).get() as { n: number }).n;
  h.stopRetries = queue(db, `SELECT COUNT(*) AS n, MIN(first_failed_at) AS oldest FROM stop_retries WHERE state IN ('queued', 'claimed')`);
  h.unavailableRanges = (db.prepare(`SELECT COUNT(*) AS n FROM stop_retries WHERE state = 'unavailable'`).get() as { n: number }).n;
  h.feedbackPending = queue(db,
    `SELECT COUNT(*) AS n, MIN(u.timestamp) AS oldest FROM feedback_turns f JOIN context_usage u ON u.id = f.usage_id WHERE f.state = 'pending'`);
  h.feedbackProvisional = queue(db,
    `SELECT COUNT(*) AS n, MIN(u.timestamp) AS oldest FROM feedback_turns f JOIN context_usage u ON u.id = f.usage_id
     WHERE f.state = 'attributed' AND f.reason = 'provisional'`);
  h.keylessPending = (db.prepare(
    `SELECT COUNT(*) AS n FROM feedback_turns f JOIN context_usage u ON u.id = f.usage_id
     WHERE f.state = 'pending' AND u.transcript_key IS NULL AND u.source_usage_id IS NULL`
  ).get() as { n: number }).n;
  h.judgeDeferred = queue(db, `SELECT COUNT(*) AS n, MIN(queued_at) AS oldest FROM judge_deferred WHERE state = 'queued'`);
  h.handoffRenders = queue(db,
    `SELECT COUNT(*) AS n, MIN(created_at) AS oldest FROM session_docs WHERE kind = 'handoff' AND render_needed = 1`);
  const queued = (db.prepare(`SELECT COUNT(*) AS n FROM causal_due WHERE state IN ('queued', 'claimed')`).get() as { n: number }).n;
  if (resolveCausalWriterMode() === "off") h.causalWaitingOff = queued; else h.causalRunnable = queued;
  if (hasTable(db, "causal_runs")) {
    h.causalStuck = (db.prepare(`SELECT COUNT(*) AS n FROM causal_runs WHERE outcome = 'in_progress' AND started_at < ?`)
      .get(new Date(epochMs(epochNow()) - HOUR_MS).toISOString()) as { n: number }).n;
  }
  h.graceByWeek = graceExpiryProjection(db);
  return h;
}

export function isStale(q: QueueHealth): boolean {
  return q.count > 0 && q.oldest !== null && epochMs(epochNow()) - Date.parse(q.oldest) > STALE_QUEUE_MS;
}

/** The one-line `clawmem status` summary. */
export function stopHealthLine(h: StopHealth): string {
  if (h.missing.length > 0) return `Stop pipeline: NOT READY (${h.missing.length} schema item(s) missing — run 'clawmem doctor')`;
  const parts = [
    h.legacyWritersRecent.length > 0 ? `older writer caught (${h.legacyWritersRecent.length} surface(s))`
      : h.legacyWriters.length > 0 ? `fence clean (older writer last seen ${h.legacyWriters[0]!.lastAt.slice(0, 10)})` : "fence clean",
    h.recomputeDone ? "counters recomputed" : "recompute pending",
    `retries ${h.stopRetries.count}`,
    `feedback pending ${h.feedbackPending.count}${h.feedbackProvisional.count > 0 ? ` (+${h.feedbackProvisional.count} provisional)` : ""}`,
    `handoff renders ${h.handoffRenders.count}`,
    `causal ${h.causalRunnable}${h.causalWaitingOff > 0 ? ` (+${h.causalWaitingOff} waiting on mode off)` : ""}`,
  ];
  return `Stop pipeline: ${parts.join(" · ")}`;
}
