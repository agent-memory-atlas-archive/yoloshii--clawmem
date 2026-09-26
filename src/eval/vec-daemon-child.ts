/**
 * Eval vector-daemon CHILD + spawner (codex t76 ruling, option (a)).
 *
 * The hook replay-eval (`clawmem eval hook-run`) measures the context-surfacing
 * handler against a working COPY of a corpus snapshot. Without a vector daemon
 * the handler's vector legs run the synchronous sqlite-vec MATCH IN-PROCESS,
 * where the profile's vector timeout (a `Promise.race` timer on the same event
 * loop) can never fire — a cold scan on a multi-GB copy blocks the handler
 * for its full duration and the budget gate measures an execution production
 * never performs under the watcher (draw 1 of the v0.38.0 ship run refused on
 * exactly that artifact: vectorMs 6036 against a 900ms deadline).
 *
 * This module makes the daemon topology REAL for the eval, as a separate OS
 * process (constraint 1 — `startVectorDaemon` inside the evaluator's own
 * process would still block the same event loop):
 *
 *   child  — opens the working DB, optionally runs the declared steady-state
 *            prewarm (the long-lived watcher topology prewarms periodically;
 *            the shipping protocol records that it did the same), binds the
 *            per-DB socket via the PRODUCTION `startVectorDaemon`, verifies it
 *            owns that socket, signals readiness on stdout, and stays alive.
 *            No watcher, no indexing, no timers (constraint 2).
 *   parent — `spawnEvalVectorDaemon`: spawns the child, waits for BOUNDED
 *            readiness, VERIFIES it with a real socket round trip (the daemon
 *            answers with the exact DB path + its pid — a foreign daemon on
 *            the same socket is refused), and hands back a handle whose
 *            `stop()` terminates the child with a bounded escalation to
 *            SIGKILL and removes the socket (constraints 3 + 6).
 *
 * Refusal is the only failure mode: a child that cannot start, bind, or be
 * verified throws before the first case is scored. The evaluator never falls
 * back to the in-process scan under this protocol (constraint 4 lives in
 * hook-run.ts + context-surfacing.ts: CLAWMEM_VECTOR_DAEMON_REQUIRED).
 */
import { existsSync, rmSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createStore, prewarmVectors, searchVecMatch, type Store } from "../store.ts";
import { startVectorDaemon, vecDaemonSocketPath, daemonPing, testSyncScanDelay, type VectorDaemonHandle } from "../vector-daemon.ts";

/** Declared prewarm policy of the eval daemon — part of the run identity (vector_exec.prewarm). */
export type EvalVecPrewarm = "steady-state" | "cold";

/** One newline-terminated JSON line on the child's stdout: readiness, or the refusal reason. */
export type ChildReadyLine =
  | {
      ready: true; sock: string; db: string; pid: number;
      /** "ran" = the zero-vector MATCH executed over a dimensioned table; "no-vectors" = no dimensioned table; "skipped" = not declared. */
      prewarm: "ran" | "no-vectors" | "skipped";
      /** Stored vector rows on the working copy (0 for a missing OR dimensioned-but-empty table) — the payload a steady-state prewarm actually warmed (codex t78 F4). */
      vectorRows: number;
    }
  | { ready: false; error: string };

export interface EvalVectorDaemon {
  pid: number;
  sockPath: string;
  dbPath: string;
  prewarm: EvalVecPrewarm;
  /** Whether the declared prewarm scan actually executed (false ⇔ the DB has no dimensioned vector table). */
  prewarmRan: boolean;
  /** Stored vector rows on the working copy — 0 for a missing or dimensioned-but-empty table (codex t78 F4: a dimensioned table with no rows is not a warmed payload). */
  vectorRows: number;
  /** Spawn → verified-ready wall time, ms. */
  readyMs: number;
  /** True while the child process has not exited. */
  alive(): boolean;
  /** Child exit code once it has exited, else null. */
  exitCode(): number | null;
  /**
   * Terminate the child (stdin close + SIGTERM), await it for `stopTimeoutMs`,
   * escalate to SIGKILL, await again (bounded), then unlink the socket.
   * Idempotent; never throws.
   */
  stop(): Promise<{ escalated: boolean; exitCode: number | null; socketRemoved: boolean }>;
}

export interface SpawnEvalVectorDaemonOptions {
  prewarm: EvalVecPrewarm;
  /** Bound on spawn → verified-ready (prewarm of a multi-GB copy included). Default 120000. */
  readyTimeoutMs?: number;
  /** Bound on the SIGTERM grace period before SIGKILL. Default 5000. */
  stopTimeoutMs?: number;
  log?: (msg: string) => void;
  /**
   * TEST-ONLY seam: an alternate child entry script. The production spawner
   * always runs THIS module; tests use it to spawn a child that refuses or
   * dies on cue. Never set outside tests.
   */
  _testChildEntry?: string;
}

export class EvalVectorDaemonError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EvalVectorDaemonError";
  }
}

const DEFAULT_READY_TIMEOUT_MS = 120_000;
const DEFAULT_STOP_TIMEOUT_MS = 5_000;
const KILL_TIMEOUT_MS = 2_000;
const PING_TIMEOUT_MS = 5_000;

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms));

/**
 * Race `p` against a deadline WITHOUT leaving the deadline timer pending: a
 * ref'd setTimeout that loses the race would keep the evaluator process alive
 * until it fires (a 120s ready timeout held the CLI open for 120s after the
 * run completed). Resolves `{ timedOut: true }` at the deadline.
 */
async function withDeadline<T>(p: Promise<T>, ms: number): Promise<{ timedOut: false; value: T } | { timedOut: true }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<{ timedOut: true }>(resolve => { timer = setTimeout(() => resolve({ timedOut: true }), Math.max(1, ms)); });
  try {
    return await Promise.race([p.then(value => ({ timedOut: false as const, value })), deadline]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** The child entry: this very module, run as main. */
export const EVAL_VEC_DAEMON_CHILD_ENTRY = fileURLToPath(import.meta.url);

// ─────────────────────────────────────────────────────────────────────────────
// Parent: spawn + bounded verified readiness + bounded teardown
// ─────────────────────────────────────────────────────────────────────────────

export async function spawnEvalVectorDaemon(dbPath: string, opts: SpawnEvalVectorDaemonOptions): Promise<EvalVectorDaemon> {
  const log = opts.log ?? (() => {});
  const readyTimeoutMs = opts.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS;
  const stopTimeoutMs = opts.stopTimeoutMs ?? DEFAULT_STOP_TIMEOUT_MS;
  if (!Number.isFinite(readyTimeoutMs) || readyTimeoutMs <= 0) throw new EvalVectorDaemonError(`readyTimeoutMs must be a positive finite number, got ${String(readyTimeoutMs)}`);
  if (!Number.isFinite(stopTimeoutMs) || stopTimeoutMs <= 0) throw new EvalVectorDaemonError(`stopTimeoutMs must be a positive finite number, got ${String(stopTimeoutMs)}`);
  if (dbPath === ":memory:" || !existsSync(dbPath) || !statSync(dbPath).isFile()) {
    throw new EvalVectorDaemonError(`vector daemon requires a file-backed working copy; got ${JSON.stringify(dbPath)} — an in-memory store cannot be served by a child process`);
  }
  const sockPath = vecDaemonSocketPath(dbPath);
  const entry = opts._testChildEntry ?? EVAL_VEC_DAEMON_CHILD_ENTRY;
  const t0 = Date.now();
  const proc = Bun.spawn([process.execPath, entry, "--db", dbPath, ...(opts.prewarm === "steady-state" ? ["--prewarm"] : [])], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "inherit",
    env: process.env as Record<string, string>,
  });
  let exitCode: number | null = null;
  const exited = proc.exited.then(code => { exitCode = code; return code; }, () => { exitCode = -1; return -1; });

  const reader = proc.stdout.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let readyLine: ChildReadyLine | null = null;
  let timedOut = false;
  let nonJson: string | null = null;
  while (readyLine === null && !timedOut && nonJson === null) {
    const next = await withDeadline(reader.read(), readyTimeoutMs - (Date.now() - t0));
    if (next.timedOut) { timedOut = true; break; }
    if (next.value.done) break; // child closed stdout without a ready line (it died)
    buf += decoder.decode(next.value.value as Uint8Array, { stream: true });
    const nl = buf.indexOf("\n");
    if (nl >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      try { readyLine = JSON.parse(line) as ChildReadyLine; }
      catch { nonJson = line.slice(0, 200); }
    }
  }
  // Keep draining stdout so the child can never block on a full pipe (it prints nothing after the
  // ready line, but a refusal path must not depend on that).
  void (async () => { try { for (;;) { const r = await reader.read(); if (r.done) break; } } catch { /* pipe gone */ } })();

  const stopChild = async (): Promise<{ escalated: boolean; exitCode: number | null; socketRemoved: boolean }> => {
    let escalated = false;
    if (exitCode === null) {
      try { proc.stdin.end(); } catch { /* already closed */ }
      try { proc.kill("SIGTERM"); } catch { /* already gone */ }
      await withDeadline(exited, stopTimeoutMs);
      if (exitCode === null) {
        escalated = true;
        try { proc.kill("SIGKILL"); } catch { /* already gone */ }
        await withDeadline(exited, KILL_TIMEOUT_MS);
      }
    }
    // Unlink the socket ONLY when no live daemon serves it: the child's own SIGTERM path unlinks
    // its socket; SIGKILL leaves a stale file (removed here); a socket a FOREIGN live daemon owns
    // (the refusal path for a contested socket) must never be clobbered — unlinking it would
    // strand that daemon unreachable-by-path while it keeps running.
    let socketRemoved = false;
    try {
      if (existsSync(sockPath)) {
        const probe = await daemonPing(dbPath, 500);
        if (probe.status === "absent") { rmSync(sockPath, { force: true }); socketRemoved = true; }
      }
    } catch { /* best-effort */ }
    return { escalated, exitCode, socketRemoved };
  };
  const refuse = async (why: string): Promise<never> => {
    await stopChild();
    throw new EvalVectorDaemonError(why);
  };

  if (nonJson !== null) return refuse(`vector daemon child emitted a non-JSON readiness line: ${nonJson}`);
  if (timedOut) return refuse(`vector daemon child did not become ready within ${readyTimeoutMs}ms (db ${dbPath}, prewarm ${opts.prewarm}) — refusing before the first case`);
  if (readyLine === null) {
    await withDeadline(exited, KILL_TIMEOUT_MS);
    return refuse(`vector daemon child exited (code ${exitCode}) before signalling readiness (db ${dbPath}) — refusing before the first case`);
  }
  const ready: ChildReadyLine = readyLine;
  if (!ready.ready) return refuse(`vector daemon child refused to start: ${ready.error} (db ${dbPath})`);
  if (typeof ready.vectorRows !== "number" || !Number.isInteger(ready.vectorRows) || ready.vectorRows < 0) {
    return refuse(`vector daemon child readiness carries no vector row count (db ${dbPath})`);
  }
  if (ready.db !== dbPath || ready.sock !== sockPath || ready.pid !== proc.pid) {
    return refuse(`vector daemon child readiness does not describe this spawn (db ${ready.db} vs ${dbPath}; sock ${ready.sock} vs ${sockPath}; pid ${ready.pid} vs ${proc.pid})`);
  }
  if (opts.prewarm === "steady-state" && ready.prewarm === "skipped") {
    return refuse(`vector daemon child skipped the declared steady-state prewarm (db ${dbPath})`);
  }
  // VERIFIED readiness (constraint 3): a real round trip on the socket, answered by the process
  // that owns it, naming the exact DB it serves. A foreign live daemon on this socket path (or a
  // child that died between its ready line and now) is refused here, never trusted.
  const pong = await daemonPing(dbPath, PING_TIMEOUT_MS);
  if (pong.status !== "ok") {
    return refuse(`vector daemon child signalled ready but the socket did not answer a ping (${pong.status}; db ${dbPath}) — refusing before the first case`);
  }
  if (pong.db !== dbPath || pong.pid !== proc.pid) {
    return refuse(`vector daemon socket ${sockPath} is served by pid ${pong.pid} for db ${pong.db}, not by this eval's child pid ${proc.pid} for ${dbPath} — a foreign daemon owns the socket; refusing`);
  }
  if (exitCode !== null) {
    return refuse(`vector daemon child exited (code ${exitCode}) right after readiness (db ${dbPath}) — refusing before the first case`);
  }
  const readyMs = Date.now() - t0;
  log(`[eval] vector daemon child pid ${proc.pid} ready in ${readyMs}ms on ${sockPath} (prewarm ${opts.prewarm}: ${ready.prewarm})`);

  let stopped: Promise<{ escalated: boolean; exitCode: number | null; socketRemoved: boolean }> | null = null;
  return {
    pid: proc.pid,
    sockPath,
    dbPath,
    prewarm: opts.prewarm,
    prewarmRan: ready.prewarm === "ran",
    vectorRows: ready.vectorRows,
    readyMs,
    alive: () => exitCode === null,
    exitCode: () => exitCode,
    stop: () => { if (!stopped) stopped = stopChild(); return stopped; },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Child: open DB → (prewarm) → bind → self-verify → ready → stay alive
// ─────────────────────────────────────────────────────────────────────────────

function emit(line: ChildReadyLine): void {
  process.stdout.write(JSON.stringify(line) + "\n");
}

async function childMain(argv: string[]): Promise<void> {
  let dbPath: string | undefined;
  let prewarm = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--db") { dbPath = argv[++i]; continue; }
    if (argv[i] === "--prewarm") { prewarm = true; continue; }
    emit({ ready: false, error: `unknown argument ${argv[i]}` });
    process.exit(2);
  }
  if (!dbPath || dbPath === ":memory:" || !existsSync(dbPath)) {
    emit({ ready: false, error: `--db must name an existing file-backed working copy (got ${JSON.stringify(dbPath)})` });
    process.exit(2);
  }
  let store: Store;
  try {
    store = createStore(dbPath, { busyTimeout: 5000 });
  } catch (e) {
    emit({ ready: false, error: `open failed: ${(e as Error).message}` });
    process.exit(2);
  }
  let prewarmState: "ran" | "no-vectors" | "skipped" = "skipped";
  if (prewarm) {
    try {
      prewarmState = prewarmVectors(store.db) ? "ran" : "no-vectors";
    } catch (e) {
      emit({ ready: false, error: `prewarm failed: ${(e as Error).message}` });
      process.exit(2);
    }
  }
  // The payload actually present: a dimensioned table with zero rows warms nothing, so the row
  // count — not the table's existence — is what the parent judges a steady-state claim against.
  let vectorRows = 0;
  try {
    const hasTable = !!store.db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='vectors_vec'`).get();
    if (hasTable) vectorRows = (store.db.prepare(`SELECT COUNT(*) AS n FROM vectors_vec`).get() as { n: number }).n;
  } catch (e) {
    emit({ ready: false, error: `vector row count failed: ${(e as Error).message}` });
    process.exit(2);
  }
  const log = (msg: string): void => { process.stderr.write(`${msg}\n`); };
  let handle: VectorDaemonHandle | null;
  try {
    // The PRODUCTION daemon — same server, same single-flight + deadline-on-receipt contract the
    // watcher runs. The scan is the real searchVecMatch (embed + synchronous MATCH); the test
    // seam in front of it is the documented CLAWMEM_TEST_VEC_SCAN_SYNC_DELAY_MS busy-wait, a no-op
    // unless that env is set.
    handle = await startVectorDaemon(store, log, (query, model, limit, deadlineMs) => {
      testSyncScanDelay();
      return searchVecMatch(store.db, query, model, limit, deadlineMs);
    });
  } catch (e) {
    emit({ ready: false, error: `daemon start threw: ${(e as Error).message}` });
    process.exit(2);
  }
  if (!handle) {
    emit({ ready: false, error: "daemon socket bind failed" });
    process.exit(2);
  }
  // Self-verify ownership: startVectorDaemon yields a no-op handle when a LIVE daemon already owns
  // the socket (it never clobbers one). That daemon is not this child — refuse rather than report
  // readiness for a socket some other process serves.
  const pong = await daemonPing(dbPath, PING_TIMEOUT_MS);
  if (pong.status !== "ok" || pong.pid !== process.pid || pong.db !== dbPath) {
    handle.close();
    emit({ ready: false, error: pong.status === "ok" ? `socket already served by foreign pid ${pong.pid} serving ${pong.db}` : `self-ping failed (${pong.status})` });
    process.exit(3);
  }
  const sockPath = vecDaemonSocketPath(dbPath);
  let shuttingDown = false;
  const shutdown = (): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    try { handle!.close(); } catch { /* best-effort */ }
    try { store.close(); } catch { /* best-effort */ }
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
  process.on("SIGHUP", shutdown);
  // A parent that disappears closes our stdin: exit rather than linger as an orphan daemon.
  process.stdin.resume();
  process.stdin.on("end", shutdown);
  process.stdin.on("close", shutdown);
  process.stdin.on("error", shutdown);
  emit({ ready: true, sock: sockPath, db: dbPath, pid: process.pid, prewarm: prewarmState, vectorRows });
  // Bun.listen keeps the event loop alive; nothing else runs here — no watcher, no indexing, no
  // periodic timers (constraint 2).
}

if (import.meta.main) {
  childMain(process.argv.slice(2)).catch((e) => {
    emit({ ready: false, error: `child crashed: ${(e as Error).message}` });
    process.exit(2);
  });
}
