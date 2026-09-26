/**
 * BUILD-5 t60/t61 — production subprocess regressions for codex F59-1,
 * F60-2, and F60-4: what the REAL CLI does when SQLite writes block past the
 * deadline, and how the post-stdout handoff decouples from the hook process.
 *
 * Test 1 (F59-1 + F60-2, the contended case): a competing writer holds
 * BEGIN IMMEDIATE from BEFORE hook turn 1 until long past its internal
 * deadline. The hook's retrieval-commit alignment insert is bounded by
 * busy_timeout and FAILS — and t61's contract is FAIL-CLOSED: no injection
 * without its alignment row (an injected-but-untracked turn would corrupt
 * count-derived turn_index and drop the prompt from prior lookback). So the
 * CLI must exit bounded with an EMPTY hook output, and land NOTHING. After
 * the lock is released, turn 2 must inject normally, take turn_index 0 (the
 * failed turn wrote no row, so the count never moved), persist its
 * query_text, and its bookkeeping must land via the spool pipeline.
 *
 * Test 2 (F60-4): the hook process's completion must not depend on the
 * spool-ingest child's progress. The child is forced to hang before it
 * reads/persists anything; the parent must still exit promptly with its
 * payload — proving the parent performs no post-stdout fs/SQLite work and
 * never waits on the child.
 */
import { describe, it, expect } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, readdirSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Database } from "bun:sqlite";
import { createStore } from "../../src/store.ts";
import { seedDocuments } from "../helpers/test-store.ts";
import { spoolDirForDb, SPOOL_JOB_MAX_BYTES, serializeSurfacingBookkeepingJob, type SurfacingBookkeepingJob } from "../../src/hooks/surfacing-bookkeeping.ts";

const REPO = join(import.meta.dir, "../..");
const CLI = join(REPO, "src/clawmem.ts");

function makeEnv(dbPath: string, cfgDir: string, extra?: Record<string, string>): Record<string, string> {
  const env = { ...process.env } as Record<string, string>;
  delete env.CLAWMEM_JUDGE_SPAWN;
  delete env.CLAWMEM_EVAL_NOW;
  delete env.CLAWMEM_SESSION_FOCUS;
  delete env.CLAWMEM_VAULTS;
  delete env.CLAWMEM_TEST_SPOOL_INGEST_HANG_MS;
  env.INDEX_PATH = dbPath;
  env.CLAWMEM_CONFIG_DIR = cfgDir;          // hermetic: no configured vaults
  env.CLAWMEM_PROFILE = "balanced";
  env.CLAWMEM_HOOK_BUDGET_MS = "3000";
  env.CLAWMEM_HOOK_DEDUP_WINDOW_SEC = "0";
  env.CLAWMEM_SURFACE_SECONDARY_VAULTS = "false";
  return { ...env, ...extra };
}

function runHookCli(env: Record<string, string>, prompt: string) {
  const t0 = Date.now();
  const proc = Bun.spawnSync([process.execPath, CLI, "hook", "context-surfacing"], {
    cwd: REPO,
    env,
    stdin: Buffer.from(JSON.stringify({ session_id: "blk-s1", prompt, hook_event_name: "UserPromptSubmit" })),
  });
  const wallMs = Date.now() - t0;
  const stdout = proc.stdout.toString();
  const jsonLine = stdout.trim().split("\n").reverse().find(l => l.startsWith("{"));
  return { proc, wallMs, stdout, stderr: proc.stderr.toString(), jsonLine };
}

function seedTempStore(dir: string): string {
  const dbPath = join(dir, "index.sqlite");
  const seedStore = createStore(dbPath);
  seedDocuments(seedStore, [
    { path: "m/ib1.md", title: "billing invoice export", body: "billing invoice export retries flow for enterprise tenants", contentType: "decision", confidence: 0.9, qualityScore: 0.8 },
    { path: "m/ib2.md", title: "billing invoice retries", body: "billing invoice retries enterprise and the export dead letter queue", contentType: "decision", confidence: 0.9, qualityScore: 0.8 },
  ]);
  seedStore.close();
  return dbPath;
}

describe("t60/t61: blocked writes never hold hook output; alignment fails closed under contention (real CLI subprocess)", () => {
  it("contended two-turn: turn 1 under the lock fails closed (empty, bounded, zero rows); turn 2 after release injects with turn_index 0 and its bookkeeping lands", async () => {
    const dir = mkdtempSync(join(tmpdir(), "clawmem-blk-"));
    const cfgDir = join(dir, "cfg-empty");
    mkdirSync(cfgDir, { recursive: true });
    const readyFile = join(dir, "locker-ready");
    const LOCK_HOLD_MS = 30_000;

    try {
      const dbPath = seedTempStore(dir);

      // The locker: takes the write lock, signals readiness, holds it.
      const lockerScript = join(dir, "locker.ts");
      writeFileSync(lockerScript, `
        import { Database } from "bun:sqlite";
        import { writeFileSync } from "node:fs";
        const db = new Database(${JSON.stringify(dbPath)});
        db.exec("PRAGMA busy_timeout = 2000");
        db.exec("BEGIN IMMEDIATE");
        writeFileSync(${JSON.stringify(readyFile)}, "1");
        await Bun.sleep(${LOCK_HOLD_MS});
        db.exec("ROLLBACK");
        db.close();
      `);
      const locker = Bun.spawn({ cmd: [process.execPath, lockerScript], cwd: REPO, stdout: "ignore", stderr: "pipe" });
      try {
        const t0 = Date.now();
        while (!existsSync(readyFile)) {
          if (Date.now() - t0 > 10_000) throw new Error(`locker never signaled ready: ${await new Response(locker.stderr).text()}`);
          await Bun.sleep(50);
        }

        // ── Turn 1: under the held write lock ──
        const r1 = runHookCli(makeEnv(dbPath, cfgDir), "billing invoice export retries enterprise");

        // Bounded exit while the lock is held for another ~15s+: the ONLY
        // in-lifetime write is the alignment insert (busy_timeout 1500ms).
        expect(r1.proc.exitCode).toBe(0);
        expect(r1.wallMs).toBeLessThan(15_000);
        expect(r1.jsonLine, `no hook JSON.\nstdout:\n${r1.stdout}\nstderr:\n${r1.stderr}`).toBeDefined();
        const out1 = JSON.parse(r1.jsonLine!) as { hookSpecificOutput?: { additionalContext?: string } };
        // FAIL-CLOSED (F60-2): no alignment row could be written, so the
        // hook must NOT inject an untracked turn.
        expect(out1.hookSpecificOutput?.additionalContext ?? "").toBe("");

        // Nothing landed and nothing was handed off (no injection happened).
        const ro = new Database(dbPath, { readonly: true });
        try {
          expect((ro.prepare("SELECT COUNT(*) c FROM context_usage WHERE session_id = 'blk-s1'").get() as { c: number }).c).toBe(0);
          expect((ro.prepare("SELECT COUNT(*) c FROM recall_events WHERE session_id = 'blk-s1'").get() as { c: number }).c).toBe(0);
        } finally { ro.close(); }
        const spool = spoolDirForDb(dbPath);
        const spooled1 = existsSync(spool) ? readdirSync(spool).filter(n => !n.endsWith(".tmp")) : [];
        expect(spooled1.length).toBe(0);
      } finally {
        locker.kill();
        await locker.exited;
      }

      // ── Turn 2: lock released — normal injection, correct alignment ──
      const r2 = runHookCli(makeEnv(dbPath, cfgDir), "billing invoice retries dead letter queue");
      expect(r2.proc.exitCode).toBe(0);
      const out2 = JSON.parse(r2.jsonLine!) as { hookSpecificOutput?: { additionalContext?: string } };
      expect(out2.hookSpecificOutput?.additionalContext ?? "").toContain("<vault-context>");

      // The failed turn wrote no row, so the count never moved: this first
      // SUCCESSFUL turn takes index 0, with its prompt persisted.
      const ro2 = new Database(dbPath, { readonly: true });
      try {
        const rows = ro2.prepare("SELECT turn_index, query_text FROM context_usage WHERE session_id = 'blk-s1' ORDER BY id").all() as { turn_index: number; query_text: string | null }[];
        expect(rows.length).toBe(1);
        expect(rows[0]!.turn_index).toBe(0);
        expect(rows[0]!.query_text).toBe("billing invoice retries dead letter queue");
      } finally { ro2.close(); }

      // The bookkeeping lands via the spool pipeline (the ingest child
      // drains on its own; poll, with an explicit drain as belt).
      let events = 0;
      const deadline = Date.now() + 20_000;
      while (Date.now() < deadline) {
        const roE = new Database(dbPath, { readonly: true });
        try {
          events = (roE.prepare("SELECT COUNT(*) c FROM recall_events WHERE session_id = 'blk-s1'").get() as { c: number }).c;
        } finally { roE.close(); }
        if (events > 0) break;
        Bun.spawnSync([process.execPath, CLI, "spool-drain"], { cwd: REPO, env: makeEnv(dbPath, cfgDir) });
        await Bun.sleep(300);
      }
      expect(events).toBeGreaterThan(0);
      // And the alignment row got its paths fill-in (guarded UPDATE matched).
      const ro3 = new Database(dbPath, { readonly: true });
      try {
        const row = ro3.prepare("SELECT injected_paths FROM context_usage WHERE session_id = 'blk-s1'").get() as { injected_paths: string };
        expect((JSON.parse(row.injected_paths) as string[]).length).toBeGreaterThan(0);
      } finally { ro3.close(); }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);

  it("F60-4: the hook process exits promptly with its payload even when the spool-ingest child hangs before persisting anything", async () => {
    const dir = mkdtempSync(join(tmpdir(), "clawmem-hang-"));
    const cfgDir = join(dir, "cfg-empty");
    mkdirSync(cfgDir, { recursive: true });
    try {
      const dbPath = seedTempStore(dir);
      // Child sleeps 20s before reading stdin or touching the spool — far
      // past the parent's budget. The parent must not wait for it.
      const r = runHookCli(makeEnv(dbPath, cfgDir, { CLAWMEM_TEST_SPOOL_INGEST_HANG_MS: "20000" }), "billing invoice export retries enterprise");
      expect(r.proc.exitCode).toBe(0);
      expect(r.wallMs).toBeLessThan(12_000); // bun cold start + budget; NOT 20s+
      const out = JSON.parse(r.jsonLine!) as { hookSpecificOutput?: { additionalContext?: string } };
      expect(out.hookSpecificOutput?.additionalContext ?? "").toContain("<vault-context>");
      // At parent exit the hanging child has persisted NOTHING — the spool is
      // empty or absent (the handoff rode the pipe, not the parent's fs).
      const spool = spoolDirForDb(dbPath);
      const spooled = existsSync(spool) ? readdirSync(spool).filter(n => n.endsWith(".json")) : [];
      expect(spooled.length).toBe(0);
      // The alignment row is already there (written in-handler, pre-payload).
      const ro = new Database(dbPath, { readonly: true });
      try {
        expect((ro.prepare("SELECT COUNT(*) c FROM context_usage WHERE session_id = 'blk-s1'").get() as { c: number }).c).toBe(1);
      } finally { ro.close(); }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});

describe("t62 F61-3: the pipe handoff stays nonblocking at the maximum admissible job size (real spool-ingest child)", () => {
  it("writing a max-size job into a HUNG child's stdin completes promptly (bounded handoff — no pipe-capacity assumption)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "clawmem-pipe-"));
    const cfgDir = join(dir, "cfg-empty");
    mkdirSync(cfgDir, { recursive: true });
    try {
      const dbPath = seedTempStore(dir);
      // Build the LARGEST admissible payload: grow injectedPaths until the
      // serializer refuses, then step back one — the true boundary, not an
      // assumed "ordinary" size.
      const base: SurfacingBookkeepingJob = {
        v: 1, kind: "surfacing-bookkeeping", jobId: "job-max", sessionId: "pipe-s1",
        turnIndex: 0, usageId: 1, queryHash: "qh", injectedPaths: [], estimatedTokens: 1,
        vaults: [{ vault: null, docs: [{ displayPath: "test/m/ib1.md", searchScore: 0.9 }] }],
      };
      let raw: string | null = null;
      for (let n = 0; n <= 200; n++) {
        const cand = { ...base, injectedPaths: Array.from({ length: n }, (_, i) => `test/m/${"p".repeat(150)}-${i}.md`) };
        const ser = serializeSurfacingBookkeepingJob(cand);
        if (ser === null) break;
        raw = ser;
      }
      expect(raw).not.toBeNull();
      expect(Buffer.byteLength(raw!, "utf-8")).toBeLessThanOrEqual(SPOOL_JOB_MAX_BYTES);
      expect(Buffer.byteLength(raw!, "utf-8")).toBeGreaterThan(SPOOL_JOB_MAX_BYTES - 1200); // genuinely at the boundary

      const env = makeEnv(dbPath, cfgDir, { CLAWMEM_TEST_SPOOL_INGEST_HANG_MS: "20000" });
      const child = Bun.spawn({
        cmd: [process.execPath, CLI, "spool-ingest"],
        cwd: REPO,
        env,
        stdin: "pipe",
        stdout: "ignore",
        stderr: "ignore",
      });
      try {
        const t0 = Date.now();
        child.stdin.write(raw!);
        await child.stdin.end();
        const writeMs = Date.now() - t0;
        // The child sleeps 20s before its first read — a handoff that
        // depended on the child draining the pipe would take ~20s. The cap
        // plus the FileSink's user-space buffering keep the parent-side
        // write+end far under the bound on any host.
        expect(writeMs).toBeLessThan(2_000);
      } finally {
        child.kill();
        await child.exited;
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});

describe("t63 F62-3: the ingest child aborts an oversized stdin stream at the cap — never after buffering it", () => {
  it("a 100KB stream is aborted AT the cap: the child stops consuming mid-stream and persists nothing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "clawmem-oversz-"));
    const cfgDir = join(dir, "cfg-empty");
    mkdirSync(cfgDir, { recursive: true });
    try {
      const dbPath = seedTempStore(dir);
      const child = Bun.spawn({
        cmd: [process.execPath, CLI, "spool-ingest"],
        cwd: REPO,
        env: makeEnv(dbPath, cfgDir),
        stdin: "pipe",
        stdout: "ignore",
        stderr: "ignore",
      });
      // Stream well past SPOOL_JOB_MAX_BYTES in paced 8KB chunks. The
      // DISCRIMINATOR is the abort behavior itself, observed as TIMING: a
      // bounded reader crosses the 32KB cap around chunk 5 and the child
      // EXITS while the stream is still being written — child.exited
      // resolves BEFORE end() is ever called. An unbounded reader consumes
      // to EOF and exits only after end() — turning this red is exactly
      // what disabling the in-read cap does (mutation M-I). Write errors
      // are NOT the signal (Bun's FileSink swallows EPIPE to a dead
      // reader), which is why the exit clock is the assertion.
      let exitedAt: number | null = null;
      void child.exited.then(() => { exitedAt = Date.now(); });
      const chunk = "x".repeat(8192);
      for (let i = 0; i < 13; i++) {
        try { child.stdin.write(chunk); await child.stdin.flush(); } catch { /* child gone — keep pacing the clock */ }
        await Bun.sleep(150);
      }
      const endCalledAt = Date.now();
      try { await child.stdin.end(); } catch { /* already closed — fine */ }
      const code = await child.exited;
      expect(code).toBe(0);
      // The bounded reader aborted mid-stream: the child was ALREADY gone
      // well before the stream finished (~5×150ms vs 13×150ms of pacing).
      expect(exitedAt).not.toBeNull();
      expect(exitedAt!).toBeLessThan(endCalledAt);
      const spool = spoolDirForDb(dbPath);
      const spooled = existsSync(spool) ? readdirSync(spool) : [];
      expect(spooled.length).toBe(0); // nothing persisted
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});

describe("t64 F63-2: the handoff race's LOSER is cleaned up — the child is dropped, nothing persists late", () => {
  it("forced race-loss (delayed-flush seam): the hook exits promptly and the hung child is killed BEFORE it can persist", async () => {
    const dir = mkdtempSync(join(tmpdir(), "clawmem-loser-"));
    const cfgDir = join(dir, "cfg-empty");
    mkdirSync(cfgDir, { recursive: true });
    try {
      const dbPath = seedTempStore(dir);
      // Seam: the race's view of the flush is delayed 3s → the 250ms bound
      // always loses → the loser branch (sink unref + child.kill) fires.
      // The child itself sleeps 1.5s before reading; WITHOUT the kill it
      // would wake, find its full payload + EOF, and persist+drain (~1.5s)
      // — the post-exit spool/DB check below would then see bookkeeping.
      const env = makeEnv(dbPath, cfgDir, {
        CLAWMEM_TEST_HANDOFF_END_DELAY_MS: "3000",
        CLAWMEM_TEST_SPOOL_INGEST_HANG_MS: "1500",
      });
      const r = runHookCli(env, "billing invoice export retries enterprise");
      expect(r.proc.exitCode).toBe(0);
      const out = JSON.parse(r.jsonLine!) as { hookSpecificOutput?: { additionalContext?: string } };
      expect(out.hookSpecificOutput?.additionalContext ?? "").toContain("<vault-context>");
      // The parent paid the 250ms bound, never the 3s seam delay.
      expect(r.wallMs).toBeLessThan(12_000);
      // Give a surviving child ample time to wake and persist — then prove
      // it never did: the kill landed before its hang elapsed.
      await Bun.sleep(4_000);
      const spool = spoolDirForDb(dbPath);
      const spooled = existsSync(spool) ? readdirSync(spool).filter(n => n.endsWith(".json")) : [];
      expect(spooled.length).toBe(0);
      const ro = new Database(dbPath, { readonly: true });
      try {
        expect((ro.prepare("SELECT COUNT(*) c FROM recall_events WHERE session_id = 'blk-s1'").get() as { c: number }).c).toBe(0);
        // The alignment row is untouched by the drop (written in-handler).
        expect((ro.prepare("SELECT COUNT(*) c FROM context_usage WHERE session_id = 'blk-s1'").get() as { c: number }).c).toBe(1);
      } finally { ro.close(); }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
