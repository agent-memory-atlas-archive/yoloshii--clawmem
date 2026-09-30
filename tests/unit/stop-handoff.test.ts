/**
 * 62.1 D5: handoff-generator — a digest step (no model, every Stop) and a throttled incremental summary step, each
 * with its own Phase B; a render-only SessionEnd flush (design tests 14, 26, 28, 29, 33, 34, 38, 42, 43).
 *
 * Baseline (8e2579a): every Stop re-reads the last 200 messages and calls `extractSummary` (twice for two Stops with
 * no new turn); nothing records a turn, so a model failure leaves nothing for the failed stretch, and turns past the
 * 200-message window are gone from the summary; there is no SessionEnd hook, and the handoff path is per date and
 * session, so two transcripts of one session id overwrite one document.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { Database } from "bun:sqlite";
import { createStore, type Store } from "../../src/store.ts";
import { createTestStore } from "../helpers/test-store.ts";
import { setDefaultLlamaCpp } from "../../src/llm.ts";
import { handoffGenerator } from "../../src/hooks/handoff-generator.ts";
import { runHandoffDigests, runHandoffSummary, HANDOFF_HOOK } from "../../src/stop-handoff.ts";
import { readStopCursor } from "../../src/stop-cursor.ts";
import { transcriptKey } from "../../src/stop-pairing.ts";
import { monoNow, deadlineAfter, duration } from "../../src/clock.ts";
import { human, assistant, toolResult, ocMessage, writeTranscriptFile, appendEntries, serialize, lineStarts } from "./stop-fixtures.ts";
import {
  handleSessionEnd, setHookRunnerForTests, restoreHookRunnerForTests, setSessionFileResolverForTests,
  restoreSessionFileResolverForTests, type ExecHookFn,
} from "../../src/openclaw/engine.ts";
import { markSessionSurfaced, isSessionSurfaced, _resetAllSessionStateForTests } from "../../src/openclaw/session-state.ts";

const SID = "sess0001-handoff";
let summaryPrompts: string[] = [];
let failSummary = false;
const dirs: string[] = [];

beforeEach(() => {
  summaryPrompts = [];
  failSummary = false;
  setDefaultLlamaCpp({
    generate: async (prompt: string) => {
      if (!prompt.includes("session summarizer")) return { text: "", model: "fake", done: true };
      summaryPrompts.push(prompt);
      if (failSummary) return null;
      const turns = newTurnsOf(prompt);
      return {
        text: `<summary><request>Summary request ${turns[0] ?? "?"}</request><investigated>None</investigated><learned>None</learned>` +
          `<completed>Completed turns ${turns.join(",")}</completed><next_steps>None</next_steps></summary>`,
        model: "fake", done: true,
      };
    },
    embed: async () => ({ embedding: new Float32Array([1, 0, 0, 0]), model: "fake" }),
  } as any);
});
afterEach(() => {
  setDefaultLlamaCpp(null);
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function tmp(): string { const d = mkdtempSync(join(tmpdir(), "clawmem-621-handoff-")); dirs.push(d); return d; }
const deadline = () => deadlineAfter(monoNow(), duration(30_000));

/** The turn numbers a summary prompt hands the model as new turns, in prompt order (the baseline sends a transcript). */
function newTurnsOf(prompt: string): string[] {
  const from = prompt.indexOf("--- NEW TURNS");
  const to = prompt.indexOf("--- END NEW TURNS");
  const section = from >= 0 && to > from ? prompt.slice(from, to) : prompt;
  return [...new Set([...section.matchAll(/question for turn (\d+)/g)].map(m => m[1]!))];
}

/** One turn of four messages: the request, an Edit call, its result, the final answer (two paragraphs). */
const turn = (n: number, t: number, opts?: { pad?: number }) => {
  const pad = opts?.pad ? " " + "x".repeat(opts.pad) : "";
  return [
    human(`question for turn ${n}${pad}`, t),
    assistant(`Working on turn ${n}.`, t + 1, [{ id: `tu${n}`, name: "Edit", input: { file_path: `/repo/src/turn${n}.ts` } }]),
    toolResult(`tu${n}`, "ok", t + 2),
    assistant(`First paragraph of turn ${n}.\n\nFinal answer for turn ${n}: done.${pad}`, t + 3),
  ];
};

const stop = (store: Store, path: string, extra: Record<string, unknown> = {}) =>
  handoffGenerator(store, { sessionId: SID, transcriptPath: path, ...extra } as any);
const sessionEnd = (store: Store, path?: string, extra: Record<string, unknown> = {}) =>
  handoffGenerator(store, { sessionId: SID, transcriptPath: path, hookEventName: "SessionEnd", ...extra } as any);

type DigestRow = { seq: number; fp: string; payload: string };
const digests = (store: Store, key?: string) => (store.db.prepare(
  `SELECT seq, fp, payload FROM stop_items WHERE kind = 'turn-digest' ${key ? "AND transcript_key = ?" : ""} ORDER BY seq`
).all(...(key ? [key] : [])) as DigestRow[]).map(r => ({ seq: r.seq, fp: r.fp, ...JSON.parse(r.payload) }));
const summaryItem = (store: Store, key?: string) => {
  const r = store.db.prepare(
    `SELECT payload FROM stop_items WHERE kind = 'handoff-summary' AND fp = 'current' ${key ? "AND transcript_key = ?" : ""}`
  ).get(...(key ? [key] : [])) as { payload: string } | null;
  return r ? JSON.parse(r.payload) : null;
};
const cursorOf = (store: Store, path: string) => readStopCursor(store.db, SID, HANDOFF_HOOK, transcriptKey(path))!;
const handoffRow = (store: Store, key?: string) => store.db.prepare(
  `SELECT path, doc_id, render_needed, ended_at FROM session_docs WHERE kind = 'handoff' ${key ? "AND transcript_key = ?" : ""}`
).get(...(key ? [key] : [])) as { path: string; doc_id: number | null; render_needed: number; ended_at: string | null } | null;
const handoffDoc = (store: Store, key?: string) => {
  const row = handoffRow(store, key);
  if (!row) return null;
  return store.db.prepare(
    `SELECT d.id, d.revision_count, c.doc AS body FROM documents d JOIN content c ON c.hash = d.hash WHERE d.collection = '_clawmem' AND d.path = ?`
  ).get(row.path) as { id: number; revision_count: number; body: string } | null;
};
const backdateLastOutput = (store: Store) =>
  store.db.prepare(`UPDATE stop_cursors SET last_output_at = '2000-01-01T00:00:00.000Z' WHERE hook = ?`).run(HANDOFF_HOOK);

describe("D5 the summary step runs once per new stretch, incrementally (test 14)", () => {
  it("two Stops with no new turn call the summarizer once; the handoff doc renders the summary", async () => {
    const store = createTestStore();
    const path = writeTranscriptFile(tmp(), "s.jsonl", turn(1, 100));
    await stop(store, path);
    await stop(store, path);
    expect(summaryPrompts.length).toBe(1);
    expect(newTurnsOf(summaryPrompts[0]!)).toEqual(["1"]);
    const doc = handoffDoc(store)!;
    expect(doc.body).toContain("Completed turns 1");
    expect(doc.body).toContain("/repo/src/turn1.ts");
    expect(handoffRow(store)!.render_needed).toBe(0);
    expect(digests(store)).toEqual([]);   // covered digests are pruned
    expect(cursorOf(store, path).summaryThrough).toBe(1);
  });

  it("the next summary is incremental: it carries the previous summary and keeps its opening request", async () => {
    const store = createTestStore();
    const path = writeTranscriptFile(tmp(), "s.jsonl", turn(1, 100));
    await stop(store, path);
    appendEntries(path, [...turn(2, 200), ...turn(3, 300), ...turn(4, 400)]);
    await stop(store, path);
    expect(summaryPrompts.length).toBe(2);
    const p = summaryPrompts[1]!;
    expect(p.slice(p.indexOf("--- PREVIOUS SUMMARY"), p.indexOf("--- END PREVIOUS SUMMARY"))).toContain("Completed turns 1");
    expect(newTurnsOf(p)).toEqual(["2", "3", "4"]);
    const s = summaryItem(store)!;
    expect(s.summary.request).toBe("Summary request 1");   // the opening request survives
    expect(s.summary.completed).toBe("Completed turns 2,3,4");
    expect(s.files).toEqual(["/repo/src/turn1.ts", "/repo/src/turn2.ts", "/repo/src/turn3.ts", "/repo/src/turn4.ts"]);
  });

  it("each Stop records its turns' digests; a throttled Stop (1 new digest, < 30 min) does not call the model", async () => {
    const store = createTestStore();
    const path = writeTranscriptFile(tmp(), "s.jsonl", turn(1, 100));
    await stop(store, path);
    appendEntries(path, turn(2, 200));
    await stop(store, path);
    expect(summaryPrompts.length).toBe(1);
    const d = digests(store);
    expect(d.map(x => x.seq)).toEqual([2]);
    expect(d[0]).toMatchObject({ request: "question for turn 2", outcome: "Final answer for turn 2: done.", files: ["/repo/src/turn2.ts"] });
    expect(handoffRow(store)!.render_needed).toBe(1);
  });

  it("SessionEnd renders request + outcome + files for the late turns: no transcript read, no model call, idempotent", async () => {
    const store = createTestStore();
    const path = writeTranscriptFile(tmp(), "s.jsonl", turn(1, 100));
    await stop(store, path);
    appendEntries(path, turn(2, 200));
    await stop(store, path);
    rmSync(path);   // the flush reads no transcript
    const calls = summaryPrompts.length;
    const t0 = performance.now();
    await sessionEnd(store, path);
    expect(performance.now() - t0).toBeLessThan(200);
    expect(summaryPrompts.length).toBe(calls);
    const doc = handoffDoc(store)!;
    const late = doc.body.slice(doc.body.indexOf("## Turns after the last summary"));
    expect(late).toContain("question for turn 2");
    expect(late).toContain("Final answer for turn 2: done.");
    expect(late).toContain("/repo/src/turn2.ts");
    expect(doc.body).toContain("Completed turns 1");
    const row = handoffRow(store)!;
    expect(row.render_needed).toBe(0);
    expect(row.ended_at).not.toBeNull();
    await sessionEnd(store, path);
    expect(handoffDoc(store)!.revision_count).toBe(doc.revision_count);   // same digests → same body → no revision
  });

  it("a session of one short exchange writes no handoff (the pre-62.1 four-message floor), a second turn does", async () => {
    const store = createTestStore();
    const path = writeTranscriptFile(tmp(), "s.jsonl", [human("hi there", 100), assistant("Hello.", 101)]);
    await stop(store, path);
    await sessionEnd(store, path);
    expect(summaryPrompts.length).toBe(0);
    expect(handoffDoc(store)).toBeNull();
    appendEntries(path, [human("question for turn 2", 200), assistant("Final answer for turn 2: done.", 201)]);
    await stop(store, path);
    expect(summaryPrompts.length).toBe(1);
    expect(newTurnsOf(summaryPrompts[0]!)).toEqual(["2"]);
    expect(handoffDoc(store)).not.toBeNull();
  });
});

describe("D5 a model failure never withholds the record (tests 29, 33, 34)", () => {
  it("a failed middle stretch leaves summary and watermark unchanged; the next success summarises every turn since, in order (test 29)", async () => {
    const store = createTestStore();
    const path = writeTranscriptFile(tmp(), "s.jsonl", turn(1, 100));
    await stop(store, path);
    failSummary = true;
    appendEntries(path, [...turn(2, 200), ...turn(3, 300), ...turn(4, 400)]);
    await stop(store, path);
    expect(summaryItem(store)!.summary.completed).toBe("Completed turns 1");
    const c = cursorOf(store, path);
    expect(c.summaryThrough).toBe(1);
    expect(digests(store).map(d => d.request)).toEqual(["question for turn 2", "question for turn 3", "question for turn 4"]);
    expect((store.db.prepare(`SELECT retry_count, last_error FROM stop_cursors WHERE hook = ?`).get(HANDOFF_HOOK) as any).retry_count).toBe(1);
    failSummary = false;
    appendEntries(path, turn(5, 500));
    await stop(store, path);
    expect(newTurnsOf(summaryPrompts.at(-1)!)).toEqual(["2", "3", "4", "5"]);
    expect(summaryItem(store)!.summary.completed).toBe("Completed turns 2,3,4,5");
    expect(cursorOf(store, path).summaryThrough).toBe(5);
    expect(digests(store)).toEqual([]);
    expect((store.db.prepare(`SELECT retry_count FROM stop_cursors WHERE hook = ?`).get(HANDOFF_HOOK) as any).retry_count).toBe(0);
  });

  it("a summary failure followed at once by SessionEnd renders the failed stretch's digests; render_needed clears (test 33)", async () => {
    const store = createTestStore();
    const path = writeTranscriptFile(tmp(), "s.jsonl", turn(1, 100));
    await stop(store, path);
    failSummary = true;
    appendEntries(path, [...turn(2, 200), ...turn(3, 300), ...turn(4, 400)]);
    await stop(store, path);
    await sessionEnd(store, path);
    const body = handoffDoc(store)!.body;
    expect(body).toContain("Completed turns 1");
    const late = body.slice(body.indexOf("## Turns after the last summary"));
    for (const n of [2, 3, 4]) expect(late).toContain(`question for turn ${n}`);
    expect(late.indexOf("question for turn 2")).toBeLessThan(late.indexOf("question for turn 4"));
    expect(cursorOf(store, path).summaryThrough).toBe(1);
    expect(handoffRow(store)!.render_needed).toBe(0);
  });

  it("25 turns while the model is down: all 25 digests kept; SessionEnd shows the latest 20 + a count; the next success summarises them in ordered batches (test 34)", async () => {
    const store = createTestStore();
    failSummary = true;
    const path = writeTranscriptFile(tmp(), "s.jsonl", turn(1, 100, { pad: 250 }));
    await stop(store, path);
    for (let n = 2; n <= 25; n++) {
      appendEntries(path, turn(n, n * 100, { pad: 250 }));
      await stop(store, path);
    }
    expect(digests(store).length).toBe(25);
    expect(digests(store).map(d => d.seq)).toEqual(Array.from({ length: 25 }, (_, i) => i + 1));
    expect(digests(store)[0]!.request.length).toBeLessThanOrEqual(200);
    expect(digests(store)[0]!.outcome.length).toBeLessThanOrEqual(300);
    await sessionEnd(store, path);
    const capped = handoffDoc(store)!.body;
    expect(capped).toContain("5 earlier turns");
    expect(capped).not.toContain("question for turn 5 ");
    expect(capped).toContain("question for turn 6 ");
    expect(capped).toContain("question for turn 25 ");
    expect(handoffRow(store)!.render_needed).toBe(1);   // left for the worker's uncapped render
    failSummary = false;
    summaryPrompts = [];
    await stop(store, path);   // no new turn: the backlog is summarised in batches
    const covered = summaryPrompts.map(newTurnsOf);
    expect(covered.length).toBeGreaterThan(1);
    expect(covered.flat()).toEqual(Array.from({ length: 25 }, (_, i) => String(i + 1)));
    expect(cursorOf(store, path).summaryThrough).toBe(25);
    expect(digests(store)).toEqual([]);
    const body = handoffDoc(store)!.body;
    expect(body).not.toContain("## Turns after the last summary");
    expect(handoffRow(store)!.render_needed).toBe(0);
  });
});

describe("D5 digest sequence, provisional digests, re-anchor (tests 42, 43, 38)", () => {
  it("a digest after a summary that pruned every digest takes seq 2 from next_digest_seq and is summarised and rendered (test 43)", async () => {
    const store = createTestStore();
    const path = writeTranscriptFile(tmp(), "s.jsonl", turn(1, 100));
    await stop(store, path);
    expect(digests(store)).toEqual([]);
    appendEntries(path, turn(2, 200));
    await stop(store, path);
    expect(digests(store).map(d => d.seq)).toEqual([2]);
    await sessionEnd(store, path);
    expect(handoffDoc(store)!.body).toContain("question for turn 2");
    backdateLastOutput(store);
    await stop(store, path);
    expect(newTurnsOf(summaryPrompts.at(-1)!)).toEqual(["2"]);
    expect(cursorOf(store, path).summaryThrough).toBe(2);
  });

  it("the worker digests a turn still in progress provisionally and keeps the cursor at its start; the Stop replaces it (test 42)", async () => {
    const store = createTestStore();
    const path = writeTranscriptFile(tmp(), "s.jsonl", turn(1, 100));
    await stop(store, path);
    // Turn 2 in progress: its request and a tool call so far.
    const turn2Start = readFileSync(path).length;
    appendEntries(path, [
      human("question for turn 2", 200),
      assistant("Running the long build for turn 2.", 201, [{ id: "tu2", name: "Write", input: { file_path: "/repo/src/turn2.ts" } }]),
    ]);
    const w = await runHandoffDigests(store, { sessionId: SID, transcriptPath: path, atStop: false });
    expect(w.provisional).toBe(1);
    const c = cursorOf(store, path);
    expect(c.byteOffset).toBe(turn2Start);
    expect(c.turnStartOffset).toBe(turn2Start);
    expect(digests(store).map(d => [d.seq, d.outcome])).toEqual([[2, "Running the long build for turn 2."]]);
    // A summary covers the provisional digest...
    backdateLastOutput(store);
    const s = await runHandoffSummary(store, { sessionId: SID, transcriptKey: transcriptKey(path), deadline: deadline() });
    expect(s.committed).toBe(1);
    expect(cursorOf(store, path).summaryThrough).toBe(2);
    // ...and the turn completes: the Stop digests it in full with a new seq, past the watermark.
    appendEntries(path, [toolResult("tu2", "ok", 202), assistant("Final answer for turn 2: done.", 203)]);
    await stop(store, path);
    const d = digests(store);
    expect(d.map(x => [x.seq, x.outcome])).toEqual([[3, "Final answer for turn 2: done."]]);
    backdateLastOutput(store);
    await stop(store, path);
    expect(newTurnsOf(summaryPrompts.at(-1)!)).toEqual(["2"]);
    expect(summaryPrompts.at(-1)!).toContain("Final answer for turn 2: done.");
  });

  it("a provisional digest not yet summarised is replaced: the row is deleted and the full digest inserted", async () => {
    const store = createTestStore();
    const path = writeTranscriptFile(tmp(), "s.jsonl", turn(1, 100));
    await stop(store, path);
    appendEntries(path, [human("question for turn 2", 200), assistant("Still going.", 201, [{ id: "tu2", name: "Edit", input: { file_path: "/repo/a.ts" } }])]);
    await runHandoffDigests(store, { sessionId: SID, transcriptPath: path, atStop: false });
    await runHandoffDigests(store, { sessionId: SID, transcriptPath: path, atStop: false });   // unchanged: kept as is
    expect(digests(store).map(d => d.seq)).toEqual([2]);
    appendEntries(path, [toolResult("tu2", "ok", 202), assistant("Final answer for turn 2: done.", 203)]);
    await stop(store, path);
    expect(digests(store).map(d => [d.seq, d.outcome])).toEqual([[3, "Final answer for turn 2: done."]]);
  });

  it("a new inode at the same path (smaller offsets, identical turn bytes) re-anchors: new keys, ordered after the old, summarised (test 38)", async () => {
    const store = createTestStore();
    const dir = tmp();
    const metaLine = { type: "system", content: "x".repeat(400), timestamp: new Date().toISOString() };
    const path = writeTranscriptFile(dir, "s.jsonl", [metaLine, ...turn(1, 100), ...turn(2, 200)]);
    failSummary = true;
    await stop(store, path);   // generation 0: turn 2 (fresh cursor → the current turn), not summarised
    const gen0 = digests(store);
    expect(gen0.map(d => d.fp)).toEqual([`0:${lineStarts(path)[5]}`]);
    // The file is replaced (new inode): without the meta line, plus turn 3.
    const next = join(dir, "s.jsonl.new");
    writeFileSync(next, serialize([...turn(1, 100), ...turn(2, 200), ...turn(3, 300)]));
    renameSync(next, path);
    failSummary = false;
    await stop(store, path);
    expect(cursorOf(store, path).anchorEpoch).toBe(1);
    expect(newTurnsOf(summaryPrompts.at(-1)!)).toEqual(["2", "3"]);   // the old generation's digest first, then the new one — none stranded
    expect(cursorOf(store, path).summaryThrough).toBe(2);
    expect(handoffDoc(store)!.body).toContain("Completed turns 2,3");
  });
});

describe("D5 SessionEnd under a busy vault; two transcripts of one session id (tests 26, 28)", () => {
  it("SessionEnd while another writer holds the vault returns inside 1.5 s with render_needed left set (test 26)", async () => {
    const dir = tmp();
    const dbPath = join(dir, "vault.sqlite");
    const store = createStore(dbPath, { busyTimeout: 250 });
    const path = writeTranscriptFile(dir, "s.jsonl", turn(1, 100));
    await stop(store, path);
    appendEntries(path, turn(2, 200));
    await stop(store, path);
    expect(handoffRow(store)!.render_needed).toBe(1);
    const other = new Database(dbPath);
    other.exec("BEGIN IMMEDIATE");
    try {
      const t0 = performance.now();
      await sessionEnd(store, path);
      expect(performance.now() - t0).toBeLessThan(1500);
      expect(handoffRow(store)!.render_needed).toBe(1);
      expect(handoffDoc(store)!.body).not.toContain("question for turn 2");
    } finally {
      other.exec("ROLLBACK");
      other.close();
    }
    await sessionEnd(store, path);
    expect(handoffDoc(store)!.body).toContain("question for turn 2");
    store.close();
  });

  it("two OpenClaw transcripts of one session id keep separate digests, summaries and handoff docs (test 28)", async () => {
    const store = createTestStore();
    const dir = tmp();
    const oc = (n: number, t: number) => [ocMessage("user", `question for turn ${n}`, t), ocMessage("assistant", `First part.\n\nFinal answer for turn ${n}: done.`, t + 1)];
    const base = writeTranscriptFile(dir, `${SID}.jsonl`, oc(1, 100));
    const topic = writeTranscriptFile(dir, `${SID}-topic-7.jsonl`, oc(11, 150));
    const B = { host: "openclaw", sessionKey: "agent:main:main" };
    const T = { host: "openclaw", sessionKey: "agent:main:topic:7" };
    await stop(store, base, B);
    await stop(store, topic, T);
    appendEntries(base, oc(2, 200));
    appendEntries(topic, oc(12, 250));
    await stop(store, base, B);
    await stop(store, topic, T);
    const kb = transcriptKey(base);
    const kt = transcriptKey(topic);
    expect(summaryItem(store, kb)!.summary.completed).toBe("Completed turns 1,2");
    expect(summaryItem(store, kt)!.summary.completed).toBe("Completed turns 11,12");
    const pb = handoffRow(store, kb)!.path;
    const pt = handoffRow(store, kt)!.path;
    expect(pb).toMatch(/^handoffs\/\d{4}-\d{2}-\d{2}-sess0001\.md$/);
    expect(pt).toBe(pb.replace(/\.md$/, `-${kt.slice(0, 6)}.md`));
    expect(handoffDoc(store, kb)!.body).toContain("Completed turns 1,2");
    expect(handoffDoc(store, kt)!.body).toContain("Completed turns 11,12");
  });
});

describe("D5 SessionEnd wiring (setup hooks, OpenClaw session_end)", () => {
  const ROOT = join(import.meta.dir, "../..");
  it("`setup hooks` installs handoff-generator under SessionEnd; `--remove` removes it", () => {
    const home = tmp();
    const env = { ...process.env, HOME: home } as Record<string, string>;
    delete env.CLAWMEM_HOOK_BUDGET_MS;
    const run = (...args: string[]) => Bun.spawnSync([process.execPath, "src/clawmem.ts", "setup", "hooks", ...args], { env, cwd: ROOT });
    expect(run().exitCode).toBe(0);
    const settings = JSON.parse(readFileSync(join(home, ".claude", "settings.json"), "utf-8"));
    const groups = settings.hooks.SessionEnd as { matcher: string; hooks: { command: string; timeout: number }[] }[];
    expect(groups.length).toBe(1);
    expect(groups[0]!.hooks.map(h => h.command.split(" hook ")[1])).toEqual(["handoff-generator"]);
    expect(groups[0]!.hooks[0]!.timeout).toBeGreaterThanOrEqual(2);
    expect(run("--remove").exitCode).toBe(0);
    expect(JSON.parse(readFileSync(join(home, ".claude", "settings.json"), "utf-8")).hooks.SessionEnd).toBeUndefined();
  });

  it("through the real `clawmem hook` process: SessionEnd renders; with the vault held it returns inside 1.5 s, marker kept", async () => {
    const dir = tmp();
    const dbPath = join(dir, "vault.sqlite");
    const path = writeTranscriptFile(dir, "s.jsonl", turn(1, 100));
    const store = createStore(dbPath);
    failSummary = true;
    await stop(store, path);
    store.close();
    const hook = async () => {
      const t0 = performance.now();
      const p = Bun.spawn([process.execPath, "src/clawmem.ts", "hook", "handoff-generator"], {
        env: { ...process.env, INDEX_PATH: dbPath, HOME: join(dir, "home") },
        stdin: new Blob([JSON.stringify({ session_id: SID, transcript_path: path, hook_event_name: "SessionEnd", reason: "other" })]),
        stdout: "pipe", stderr: "pipe", cwd: ROOT,
      });
      await p.exited;
      return { ms: performance.now() - t0, exit: p.exitCode };
    };
    const reopen = () => { const s = createStore(dbPath); const r = handoffRow(s)!; const d = handoffDoc(s); s.close(); return { r, d }; };
    const other = new Database(dbPath);
    other.exec("BEGIN IMMEDIATE");
    let held: { ms: number; exit: number | null };
    try { held = await hook(); } finally { other.exec("ROLLBACK"); other.close(); }
    expect(held.exit).toBe(0);
    expect(held.ms).toBeLessThan(1500);
    expect(reopen().r.render_needed).toBe(1);
    const free = await hook();
    expect(free.exit).toBe(0);
    const after = reopen();
    expect(after.r.render_needed).toBe(0);
    expect(after.d!.body).toContain("question for turn 1");
  });

  it("OpenClaw session_end awaits the handoff flush (SessionEnd, transcript, host, key) before clearing session state", async () => {
    _resetAllSessionStateForTests();
    const calls: { name: string; input: Record<string, unknown>; surfacedDuring: boolean }[] = [];
    const exec: ExecHookFn = async (_cfg, name, input) => {
      await new Promise(r => setTimeout(r, 20));
      calls.push({ name, input, surfacedDuring: isSessionSurfaced("oc-sess-1") });
      return { stdout: "", stderr: "", exitCode: 0 };
    };
    setHookRunnerForTests({ execHook: exec });
    setSessionFileResolverForTests(p => `/tmp/oc/agents/main/sessions/${p.sessionId}.jsonl`);
    try {
      markSessionSurfaced("oc-sess-1");
      const cfg = { clawmemBin: "clawmem", tokenBudget: 800, profile: "balanced", enableTools: false, servePort: 7438, env: {} } as any;
      const logger = { debug() {}, info() {}, warn() {}, error() {} };
      await handleSessionEnd(cfg, logger, { sessionId: "oc-sess-1", sessionKey: "agent:main:main", messageCount: 4 }, { agentId: "main" });
      expect(calls.map(c => c.name)).toEqual(["handoff-generator"]);
      expect(calls[0]!.input).toMatchObject({
        session_id: "oc-sess-1", hook_event_name: "SessionEnd", host: "openclaw", session_key: "agent:main:main",
        transcript_path: "/tmp/oc/agents/main/sessions/oc-sess-1.jsonl",
      });
      expect(calls[0]!.surfacedDuring).toBe(true);   // the flush ran before clearSessionState
      expect(isSessionSurfaced("oc-sess-1")).toBe(false);
    } finally {
      restoreHookRunnerForTests();
      restoreSessionFileResolverForTests();
    }
  });
});
