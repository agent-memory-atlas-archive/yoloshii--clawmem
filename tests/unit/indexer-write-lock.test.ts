/**
 * BACKLOG 75.1 — an index pass waits for the write lock instead of failing at once.
 *
 * `indexCollection` opened its pass with a deferred `BEGIN`. The pass reads first and writes only
 * for a new or changed file, and SQLite does not run the busy handler when a connection that
 * already holds a read transaction asks for the write lock. So while another connection held the
 * write lock, the pass's first write failed with `database is locked` at once: `busy_timeout`
 * never applied, and the whole pass was rolled back (the watcher logged `Watch error: database is
 * locked` and dropped the file until it changed again). `BEGIN IMMEDIATE` takes the write lock
 * first, so the pass waits on `busy_timeout` like every other writer.
 *
 * A separate process holds the lock: while the pass waits, SQLite blocks this thread, so no timer
 * here could release it. The holder reports when it took the lock and when it let go, and the test
 * times the pass's own `BEGIN`. An attempt counts only if that `BEGIN` was called while the lock was
 * held, returned after the holder let go, and blocked for at least MIN_BLOCK_MS: contention at the
 * moment the pass asks for its transaction. A deferred `BEGIN` returns at once, so the old code can
 * never produce a counting attempt; a slow scheduler makes the test retry, never pass vacuously.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createStore, type Store } from "../../src/store.ts";
import { indexCollection, type IndexStats } from "../../src/indexer.ts";
import { setDefaultLlamaCpp } from "../../src/llm.ts";

/** Enrichment after the commit is not under test; keep it off the network. */
const deadLlm = {
  embed: async () => { throw new Error("no embedding endpoint in test"); },
  query: async () => null,
  expandQuery: async () => [],
} as any;

/** Holds the vault's write lock for LOCK_MS. Prints "locked <ms>" once it holds it, "releasing <ms>" just before COMMIT. */
const HOLDER = `
import { Database } from "bun:sqlite";
const db = new Database(process.env.LOCK_DB);
db.exec("PRAGMA busy_timeout = 5000");
db.exec("BEGIN IMMEDIATE");
console.log("locked " + Date.now());
await Bun.sleep(Number(process.env.LOCK_MS));
console.log("releasing " + Date.now());
db.exec("COMMIT");
db.close();
`;

const HOLD_MS = 500;
const ATTEMPTS = 3;
const READY_MS = 10_000;
const MIN_BLOCK_MS = 20;

let root: string;
let content: string;
let store: Store;
let holder: ReturnType<typeof Bun.spawn> | null = null;

/** Collects a child's stdout in the background, so lines can be awaited in turn. */
function watchOutput(stream: ReadableStream<Uint8Array>) {
  let text = "";
  let ended = false;
  const decoder = new TextDecoder();
  void (async () => {
    for await (const chunk of stream) text += decoder.decode(chunk, { stream: true });
    ended = true;
  })();
  return {
    async waitFor(pattern: RegExp, ms: number): Promise<RegExpMatchArray> {
      const deadline = Date.now() + ms;
      for (;;) {
        const match = text.match(pattern);
        if (match) return match;
        if (ended) throw new Error(`lock holder exited without printing ${pattern}: ${text}`);
        if (Date.now() > deadline) throw new Error(`lock holder printed no ${pattern} within ${ms} ms: ${text}`);
        await Bun.sleep(10);
      }
    },
  };
}

/** Starts the holder after this test's store is open (so the open never contends) and waits until it holds the lock. */
async function holdWriteLock() {
  const proc = Bun.spawn([process.execPath, "-e", HOLDER], {
    env: { ...process.env, LOCK_DB: join(root, "vault.sqlite"), LOCK_MS: String(HOLD_MS) },
    stdout: "pipe",
    stderr: "pipe",
  });
  holder = proc; // owned before readiness, so afterEach reaps it even if it never takes the lock
  const out = watchOutput(proc.stdout as ReadableStream<Uint8Array>);
  await out.waitFor(/locked \d+/, READY_MS);
  return { proc, out };
}

/**
 * One pass under contention. `contended` is true only when the pass's `BEGIN` was called before the holder let go,
 * returned after it, and blocked for at least MIN_BLOCK_MS.
 */
async function passUnderLock(): Promise<{ stats: IndexStats; contended: boolean }> {
  const { proc, out } = await holdWriteLock();
  const exec = store.db.exec.bind(store.db);
  let called = 0, returned = 0;
  // Time the pass's own BEGIN only: enrichment after the commit can open transactions of its own.
  store.db.exec = ((sql: string, ...rest: unknown[]) => {
    if (called > 0 || !/^\s*BEGIN\b/i.test(sql)) return (exec as any)(sql, ...rest);
    called = Date.now();
    try { return (exec as any)(sql, ...rest); } finally { returned = Date.now(); }
  }) as typeof store.db.exec;
  let stats: IndexStats;
  try {
    stats = await indexCollection(store, "docs", content, "**/*.md");
  } finally {
    store.db.exec = exec;
  }
  const released = Number((await out.waitFor(/releasing (\d+)/, READY_MS))[1]);
  expect(await proc.exited).toBe(0);
  holder = null;
  return { stats, contended: called > 0 && called < released && returned >= released && returned - called >= MIN_BLOCK_MS };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "clawmem-write-lock-"));
  content = join(root, "content");
  mkdirSync(content, { recursive: true });
  setDefaultLlamaCpp(deadLlm);
  store = createStore(join(root, "vault.sqlite"));
});

afterEach(async () => {
  if (holder) {
    holder.kill();
    await holder.exited;
    holder = null;
  }
  try { store.close(); } catch { /* already closed */ }
  setDefaultLlamaCpp(null);
  rmSync(root, { recursive: true, force: true });
});

describe("75.1: an index pass waits for another connection's write lock", () => {
  it("indexes a new file once the lock is released, instead of failing with database is locked", async () => {
    let tested = false;
    for (let attempt = 1; attempt <= ATTEMPTS && !tested; attempt++) {
      // A fresh file per attempt: a pass that lost the overlap has already indexed the previous one.
      writeFileSync(join(content, `new-${attempt}.md`), `# New ${attempt}\n\nwritten while another connection holds the write lock\n`);
      const { stats, contended } = await passUnderLock();
      expect(stats.added).toBe(1);
      const row = store.db.prepare("SELECT active FROM documents WHERE collection = 'docs' AND path = ?")
        .get(`new-${attempt}.md`) as { active: number } | null;
      expect(row?.active).toBe(1);
      tested = contended;
    }
    // No attempt's BEGIN waited for the holder: the contention never happened, so nothing was tested.
    expect(tested).toBe(true);
  });

  it("still completes a pass with nothing to write under the same contention", async () => {
    writeFileSync(join(content, "same.md"), "# Same\n\nalready indexed\n");
    expect((await indexCollection(store, "docs", content, "**/*.md")).added).toBe(1);

    let tested = false;
    for (let attempt = 1; attempt <= ATTEMPTS && !tested; attempt++) {
      const { stats, contended } = await passUnderLock();
      expect(stats.unchanged).toBe(1);
      expect(stats.added + stats.updated + stats.removed).toBe(0);
      tested = contended;
    }
    expect(tested).toBe(true);
  });
});
