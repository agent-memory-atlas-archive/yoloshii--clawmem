/**
 * Daemon-backed hook replay-eval (codex t76 ruling, option (a)) — the CR-3
 * production-boundary suite plus the refusal, death, cleanup and identity
 * contracts of the vector execution protocol.
 *
 * Why this exists: draw 1 of the v0.38.0 ship run refused on a budget breach
 * that production never performs — the eval measured the vector leg
 * IN-PROCESS (no daemon on the working copy), where the profile's vector
 * timeout cannot fire during the synchronous sqlite-vec MATCH. The remedy is
 * a dedicated vector-daemon CHILD on the working copy, daemon-REQUIRED legs,
 * bounded verified readiness, run-identity recording, and bounded cleanup.
 *
 * The synchronous scan's duration is injected through the documented
 * TEST-ONLY seam CLAWMEM_TEST_VEC_SCAN_SYNC_DELAY_MS (a busy-wait where the
 * MATCH would run — in the daemon child under the daemon protocol, on the
 * handler's own loop under the in-process one), so the boundary is
 * deterministic in EITHER topology and needs no embedding server: every
 * inference endpoint here is an unreachable localhost port.
 */
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync, mkdirSync } from "fs";
import { join, basename, dirname } from "path";
import { tmpdir } from "os";
import { createStore, DEFAULT_EMBED_MODEL, type Store } from "../../src/store.ts";
import { seedDocuments } from "../helpers/test-store.ts";
import { runHookEval, HookEvalIntegrityError, latencyEvidenceAuthoritative, OWNERSHIP_PING_TIMEOUT_MS } from "../../src/eval/hook-run.ts";
import { compareIdentities } from "../../src/eval/pair-audit.ts";
import { assertReplicatedMemberIdentity } from "../../src/eval/hook-run.ts";
import { validateIdentityShape, type RunIdentity } from "../../src/eval/run-identity.ts";
import { spawnEvalVectorDaemon, EvalVectorDaemonError } from "../../src/eval/vec-daemon-child.ts";
import { startVectorDaemon, vecDaemonSocketPath, daemonPing, vectorDaemonHealth, type VectorDaemonHandle } from "../../src/vector-daemon.ts";
import { clearConfigCache, surfaceSecondaryVaults } from "../../src/config.ts";

const REPO_ROOT = join(import.meta.dir, "../..");
const OAUTH_PROMPT = "Explain the OAuth refresh token rotation decision we made for the auth service";
const OAUTH_DOC = "test/memory/oauth-refresh-decision.md";

/** The 4-dim vector stored for the OAuth doc — the fake embed server answers every query with it, so a daemon-backed MATCH lands on it at distance 0. */
const OAUTH_VECTOR = new Float32Array([1, 0, 0, 0]);

/**
 * A file-backed fixture snapshot (the daemon child needs a real file). By
 * default it carries a POPULATED vector payload — a dimensioned table with
 * one stored vector (model-tagged DEFAULT_EMBED_MODEL) for the OAuth doc — so
 * the daemon's steady-state prewarm genuinely warms rows and a daemon-backed
 * MATCH can hit (codex t77 F3 / t78 F4). `vectors: "empty"` builds the
 * dimensioned-but-empty table and `vectors: false` the table-less variant —
 * both of which the steady-state payload requirement must refuse.
 */
function makeSnapshot(dir: string, name = "snap.sqlite", opts: { vectors?: boolean | "empty" } = {}): string {
  const p = join(dir, name);
  const s = createStore(p);
  if (opts.vectors !== false) s.ensureVecTable(OAUTH_VECTOR.length);
  seedDocuments(s, [
    {
      path: "memory/oauth-refresh-decision.md",
      title: "OAuth refresh token rotation decision",
      body: "# OAuth refresh token rotation\n\nExplain the OAuth refresh token rotation decision we made for the auth service. Rotation on every refresh, reuse detection revokes the family.",
      contentType: "decision", confidence: 0.9, qualityScore: 0.8,
    },
    {
      path: "memory/database-migrations.md",
      title: "Database migration runbook",
      body: "# Database migrations\n\nRun migrations with the deploy pipeline. Never run them by hand in production.",
      contentType: "note", confidence: 0.6, qualityScore: 0.7,
    },
  ]);
  if (opts.vectors === undefined || opts.vectors === true) {
    const row = s.db.prepare(`SELECT hash FROM documents WHERE path = ? AND active = 1`).get("memory/oauth-refresh-decision.md") as { hash: string } | null;
    if (!row) throw new Error("fixture: oauth doc not seeded");
    s.insertEmbedding(row.hash, 0, 0, OAUTH_VECTOR, DEFAULT_EMBED_MODEL, new Date().toISOString());
  }
  s.close();
  return p;
}

/** An OpenAI-compatible /v1/embeddings server that answers every input with OAUTH_VECTOR under its own model id (a real server reports the model it serves; stored vectors are tagged with that id at embed time — here DEFAULT_EMBED_MODEL). */
function fakeEmbedServer(): { url: string; stop: () => void; calls: () => number } {
  let calls = 0;
  const srv = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    async fetch(req) {
      if (!req.url.endsWith("/v1/embeddings")) return new Response("not found", { status: 404 });
      calls++;
      const body = await req.json() as { input: string | string[]; model?: string };
      const n = Array.isArray(body.input) ? body.input.length : 1;
      void body.model; // the requested alias is irrelevant — the SERVER's model id is what gets tagged/compared
      return Response.json({ object: "list", model: DEFAULT_EMBED_MODEL, data: Array.from({ length: n }, (_, i) => ({ object: "embedding", index: i, embedding: Array.from(OAUTH_VECTOR) })) });
    },
  });
  return { url: `http://127.0.0.1:${srv.port}`, stop: () => srv.stop(true), calls: () => calls };
}

/** Async CLI runner — for cases where THIS process must keep serving (a daemon or an HTTP server) while the CLI runs. */
async function runCliAsync(env: Record<string, string>, args: string[]): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
  const proc = Bun.spawn({ cmd: [process.execPath, "src/clawmem.ts", "eval", "hook-run", ...args], cwd: REPO_ROOT, env, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { exitCode, stdout, stderr };
}

function writeGold(dir: string, lines: unknown[]): string {
  const p = join(dir, "cases.jsonl");
  writeFileSync(p, lines.map(l => JSON.stringify(l)).join("\n") + "\n");
  return p;
}

const BALANCED_CASE = { id: "b1", prompt: OAUTH_PROMPT, profile: "balanced", labels: { must_include: [OAUTH_DOC] }, split: "tuning" };
const SPEED_CASE = { id: "s1", prompt: OAUTH_PROMPT, profile: "speed", labels: { must_include: [OAUTH_DOC] }, split: "tuning" };

/** Env for a spawned CLI: no CLAWMEM_* inheritance, unreachable inference endpoints, private TMPDIR + socket dir. */
function cliEnv(scratch: string, extra: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && !k.startsWith("CLAWMEM_") && k !== "INDEX_PATH" && k !== "XDG_RUNTIME_DIR" && k !== "TMPDIR") env[k] = v;
  }
  const childTmp = join(scratch, "child-tmp");
  const sockDir = join(scratch, "xdg");
  mkdirSync(childTmp, { recursive: true });
  mkdirSync(sockDir, { recursive: true });
  return {
    ...env,
    TMPDIR: childTmp,
    XDG_RUNTIME_DIR: sockDir,
    CLAWMEM_EMBED_URL: "http://127.0.0.1:1",
    CLAWMEM_LLM_URL: "http://127.0.0.1:1",
    CLAWMEM_RERANK_URL: "http://127.0.0.1:1",
    CLAWMEM_NO_LOCAL_MODELS: "true",
    ...extra,
  };
}

function runCli(env: Record<string, string>, args: string[]): { exitCode: number | null; stdout: string; stderr: string } {
  const proc = Bun.spawnSync({ cmd: [process.execPath, "src/clawmem.ts", "eval", "hook-run", ...args], cwd: REPO_ROOT, env, stdout: "pipe", stderr: "pipe" });
  return { exitCode: proc.exitCode, stdout: proc.stdout.toString(), stderr: proc.stderr.toString() };
}

function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

const leftoverSockets = (xdg: string): string[] => existsSync(join(xdg, "clawmem")) ? readdirSync(join(xdg, "clawmem")).filter(n => n.startsWith("vec-")) : [];
const leftoverWorkdirs = (childTmp: string): string[] => readdirSync(childTmp).filter(n => n.startsWith("clawmem-hook-eval-"));

/** The child's socket key is the WORKING COPY path — the CLI prints it on stderr. */
function workDbFromStderr(stderr: string): string {
  const m = /working copy: (\S+) \(snapshot/.exec(stderr);
  if (!m) throw new Error(`no working-copy line in stderr:\n${stderr.slice(0, 2000)}`);
  return m[1]!;
}

describe("daemon-backed hook replay-eval (codex t76)", () => {
  let scratch: string;
  let snapPath: string;
  // Direct runHookEval calls run in THIS process: acceptance forbids
  // local_fallback=allowed on the candidate (the CLI forces "blocked" for its
  // runs), and every endpoint must be an unreachable localhost port so no
  // inference is attempted.
  const ENV_KEYS = ["CLAWMEM_NO_LOCAL_MODELS", "CLAWMEM_EMBED_URL", "CLAWMEM_LLM_URL", "CLAWMEM_RERANK_URL"] as const;
  const priorEnv: Record<string, string | undefined> = {};
  beforeAll(() => {
    scratch = mkdtempSync(join(tmpdir(), "clawmem-vecd-"));
    snapPath = makeSnapshot(scratch);
    for (const k of ENV_KEYS) priorEnv[k] = process.env[k];
    process.env.CLAWMEM_NO_LOCAL_MODELS = "true";
    process.env.CLAWMEM_EMBED_URL = "http://127.0.0.1:1";
    process.env.CLAWMEM_LLM_URL = "http://127.0.0.1:1";
    process.env.CLAWMEM_RERANK_URL = "http://127.0.0.1:1";
  });
  afterAll(() => {
    for (const k of ENV_KEYS) { if (priorEnv[k] === undefined) delete process.env[k]; else process.env[k] = priorEnv[k]; }
    rmSync(scratch, { recursive: true, force: true });
  });

  // ---------------------------------------------------------------------
  // CR-3 production boundary — the REAL CLI, the real child, a scan that
  // exceeds the profile timeout. Daemon-backed: the handler returns via FTS
  // inside the budget and the protocol is recorded. Reverting the bridge
  // (--vector-exec in-process) reproduces the overrun on the same scan.
  // ---------------------------------------------------------------------
  it("CR-3: a child scan longer than the profile timeout returns via FTS within budget under daemon-required, and the in-process revert reproduces the overrun", () => {
    const dir = mkdtempSync(join(scratch, "cr3-"));
    const goldPath = writeGold(dir, [BALANCED_CASE]);
    // balanced vectorTimeout = 900ms; the scan busy-waits 2500ms; the budget
    // is 1800ms — a scan that blocks the handler's loop MUST overrun it, a
    // scan in the daemon child MUST NOT.
    const env = cliEnv(dir, { CLAWMEM_TEST_VEC_SCAN_SYNC_DELAY_MS: "2500", CLAWMEM_HOOK_BUDGET_MS: "1800" });
    const common = ["--gold", goldPath, "--db", snapPath, "--min-examples", "1", "--audited", "--latency-reps", "1"];

    // --- daemon-required (the default; spelled out) ---
    const outD = join(dir, "daemon");
    const d = runCli(env, [...common, "--vector-exec", "daemon-required", "--vector-prewarm", "steady-state", "--out", outD]);
    expect(d.stderr).toContain("vector daemon child pid");
    expect(d.exitCode).toBe(0);
    const rd = JSON.parse(readFileSync(join(outD, "hook-run.json"), "utf-8"));
    expect(rd.identity.vector_exec).toEqual({ protocol: "daemon-required", prewarm: "steady-state", response_protocol: "hydrated-v1" });
    expect(rd.vector_exec.protocol).toBe("daemon-required");
    expect(rd.vector_exec.response_protocol).toBe("hydrated-v1");
    expect(rd.vector_exec.latency_authoritative).toBe(true);
    expect(rd.vector_exec.note).toBeNull();
    expect(typeof rd.vector_exec.daemon.pid).toBe("number");
    expect(rd.vector_exec.daemon.prewarm_ran).toBe(true); // the steady-state prewarm genuinely ran on the dimensioned table (codex t77 F3)
    expect(rd.vector_exec.daemon.ownership_pings).toBe(2); // before + after the single rep (codex t77 F2)
    expect(rd.vector_exec.daemon.ownership_ping_timeout_ms).toBe(OWNERSHIP_PING_TIMEOUT_MS); // the fixed production constant (codex t78 F1)
    expect(rd.budget_elapsed.within).toBe(true);
    expect(rd.gates.budget_elapsed_ok).toBe(true);
    expect(rd.budget_elapsed.max_ms).toBeLessThan(1800);
    expect(rd.gates.trust_pass).toBe(true);
    const caseD = rd.cases.find((c: { id: string }) => c.id === "b1");
    expect(caseD.outcome).toBe("injected");
    expect(caseD.metrics.mustIncludeRecall).toBe(1); // FTS carried the turn
    const traceD = readFileSync(join(outD, "traces.jsonl"), "utf-8").split("\n").filter(Boolean).map(l => JSON.parse(l)).find((t: { id: string }) => t.id === "b1").trace;
    // The daemon was present and bounded the leg: the client's own deadline
    // ended it ("deadline" — never "absent", never the in-process scan, and
    // since codex migration r1 S1 never the generic "error") and the vector
    // wall time is the deadline, not the scan.
    expect(traceD.vectorLegs).toEqual([{ leg: "primary", path: "deadline" }]);
    expect(traceD.timings.vectorMs).toBeLessThan(1500);
    expect(traceD.timings.vectorMs).toBeGreaterThanOrEqual(800);
    expect(traceD.fusion.lanes.map((l: { lane: string }) => l.lane)).toContain("fts-fallback");
    expect(rd.gates.reasons).toEqual([]);
    // Cleanup (constraint 6): the child is gone, its socket unlinked, the working directory removed.
    expect(pidAlive(rd.vector_exec.daemon.pid)).toBe(false);
    expect(existsSync(rd.vector_exec.daemon.socket)).toBe(false);
    expect(leftoverSockets(env.XDG_RUNTIME_DIR!)).toEqual([]);
    expect(leftoverWorkdirs(env.TMPDIR!)).toEqual([]);
    // Keyed by the WORKING COPY path, under the CLI's (private) socket dir.
    expect(basename(rd.vector_exec.daemon.socket)).toBe(basename(vecDaemonSocketPath(workDbFromStderr(d.stderr))));
    expect(dirname(rd.vector_exec.daemon.socket)).toBe(join(env.XDG_RUNTIME_DIR!, "clawmem"));

    // --- revert the bridge: in-process on the SAME scan → overrun ---
    const outI = join(dir, "inproc");
    const i = runCli(env, [...common, "--vector-exec", "in-process", "--out", outI]);
    expect(i.exitCode).toBe(1); // trust FAIL
    const ri = JSON.parse(readFileSync(join(outI, "hook-run.json"), "utf-8"));
    expect(ri.identity.vector_exec).toEqual({ protocol: "in-process", prewarm: "n/a", response_protocol: "n/a" });
    expect(ri.vector_exec.daemon).toBeNull();
    expect(ri.vector_exec.latency_authoritative).toBe(false);
    expect(ri.vector_exec.note).toContain("IN-PROCESS");
    // Codex t77 F4: the raw overrun is preserved DIAGNOSTICALLY, but trust fails
    // because the budget evidence is UNMEASURED under in-process execution —
    // never as a production-looking "exceeded the budget" verdict.
    expect(ri.budget_elapsed.within).toBe(false);
    expect(ri.budget_elapsed.max_ms).toBeGreaterThanOrEqual(2500);
    expect(ri.gates.budget_elapsed_ok).toBeNull();
    expect(ri.gates.trust_pass).toBe(false);
    expect(ri.gates.reasons.join("\n")).toContain("budget evidence UNMEASURED");
    expect(ri.gates.reasons.join("\n")).not.toContain("handler elapsed exceeded the internal budget");
    expect(readFileSync(join(outI, "report.md"), "utf-8")).toContain("budget authority: DIAGNOSTIC ONLY");
    const traceI = readFileSync(join(outI, "traces.jsonl"), "utf-8").split("\n").filter(Boolean).map(l => JSON.parse(l)).find((t: { id: string }) => t.id === "b1").trace;
    expect(traceI.vectorLegs).toEqual([{ leg: "primary", path: "absent" }]); // no daemon: the in-process scan ran
    expect(traceI.timings.vectorMs).toBeGreaterThanOrEqual(2500);
    expect(leftoverWorkdirs(env.TMPDIR!)).toEqual([]);
    expect(i.stderr).not.toContain("vector daemon child pid");
  }, 120_000);

  // ---------------------------------------------------------------------
  // CR-3b → Path A (codex t80 P1 → t83–t88 lock ii): the shipping draws' LATE-`ok` shape — a
  // slow hydrate AFTER a fast daemon scan — is STRUCTURALLY ELIMINATED by projection-complete
  // daemon hydration: the hydrate/projection now runs INSIDE the daemon (the seam stalls the
  // daemon mid-projection), the hook's event loop stays FREE, so the client's deadline timer
  // WINS at the leg's own deadline and the leg falls to FTS with the measured deadline
  // ADHERING. The hard vector_deadline_ok gate for a genuinely measured breach is locked
  // separately with injected samples (hook-replay "measured vector-deadline gate").
  // ---------------------------------------------------------------------
  it("CR-3b/Path-A: a slow DAEMON-side projection is cut off at the leg deadline — error→FTS, deadline ADHERES, trust PASSES", () => {
    const dir = mkdtempSync(join(scratch, "cr3b-"));
    const goldPath = writeGold(dir, [BALANCED_CASE]);
    // The projection stall (2000ms) far exceeds the balanced 900ms vector budget; the hook
    // budget is generous so the leg deadline is the only interesting bound.
    const env = cliEnv(dir, { CLAWMEM_TEST_VEC_HYDRATE_SYNC_DELAY_MS: "2000", CLAWMEM_HOOK_BUDGET_MS: "6000" });
    const common = ["--gold", goldPath, "--db", snapPath, "--min-examples", "1", "--audited", "--latency-reps", "1"];
    const outD = join(dir, "daemon");
    const d = runCli(env, [...common, "--vector-exec", "daemon-required", "--vector-prewarm", "steady-state", "--out", outD]);
    expect(d.stderr).toContain("vector daemon child pid");
    const rd = JSON.parse(readFileSync(join(outD, "hook-run.json"), "utf-8"));
    const traceD = readFileSync(join(outD, "traces.jsonl"), "utf-8").split("\n").filter(Boolean).map(l => JSON.parse(l)).find((t: { id: string }) => t.id === "b1").trace;
    // The daemon never answered within the deadline — the leg was CUT OFF by the client's own
    // deadline (codex migration r1 S1: `deadline`, recorded as abandonment), never a late ok.
    expect(traceD.vectorLegs).toEqual([{ leg: "primary", path: "deadline" }]);
    // The leg finished essentially AT its own deadline: the timer could actually fire because
    // the hook's loop was free while the DAEMON stalled — the whole point of Path A.
    expect(traceD.vectorLegDeadlines[0].leg).toBe("primary");
    expect(traceD.vectorLegDeadlines[0].over_ms).toBeLessThanOrEqual(150);
    // Measured deadline ADHERED → the hard gate and trust PASS; exit 0.
    expect(rd.vector_exec.protocol).toBe("daemon-required");
    expect(rd.vector_deadline.adhered).toBe(true);
    expect(rd.gates.vector_deadline_ok).toBe(true);
    expect(rd.gates.trust_pass).toBe(true);
    expect(rd.vector_exec.latency_authoritative).toBe(true);
    expect(rd.gates.budget_elapsed_ok).not.toBeNull();
    expect(d.exitCode).toBe(0);
  }, 120_000);

  // t88 lock (b), eval layer: a SYNCHRONOUS intra-entry decode stall cannot be
  // preempted — the per-entry before/after deadline checks reclassify (never a
  // late `ok`), and the measured overrun FAILS the independent hard
  // vector_deadline_ok gate. The 1100ms per-line stall guarantees the FIRST
  // parsed line already completes past the 900ms balanced deadline with
  // over_ms ≥ ~200 (> the 150ms tolerance) regardless of daemon latency; the
  // remaining lines are never parsed (decode cancelled mid-stream). A live
  // embed server makes the scan return a REAL hit so the hydrated response
  // carries an actual entry (an unreachable one would answer an empty
  // 2-line response and change the timing shape).
  it("t88(b): a synchronous intra-entry decode stall is never a late ok — the leg reclassifies to error and the HARD deadline gate fails the member", async () => {
    const dir = mkdtempSync(join(scratch, "stall-"));
    const goldPath = writeGold(dir, [BALANCED_CASE]);
    const embed = fakeEmbedServer();
    try {
      const env = cliEnv(dir, { CLAWMEM_EMBED_URL: embed.url, CLAWMEM_TEST_VEC_ENTRY_DECODE_SYNC_DELAY_MS: "1100", CLAWMEM_HOOK_BUDGET_MS: "8000" });
      const common = ["--gold", goldPath, "--db", snapPath, "--min-examples", "1", "--audited", "--latency-reps", "1"];
      const out = join(dir, "daemon");
      const d = await runCliAsync(env, [...common, "--vector-exec", "daemon-required", "--vector-prewarm", "steady-state", "--out", out]);
      expect(d.stderr).toContain("vector daemon child pid");
      const rd = JSON.parse(readFileSync(join(out, "hook-run.json"), "utf-8"));
      const traceD = readFileSync(join(out, "traces.jsonl"), "utf-8").split("\n").filter(Boolean).map(l => JSON.parse(l)).find((t: { id: string }) => t.id === "b1").trace;
      // Never a late ok: the after-parse monotonic check found the deadline crossed (codex
      // migration r1 S1: `deadline`, never the generic `error`).
      expect(traceD.vectorLegs).toEqual([{ leg: "primary", path: "deadline" }]);
      // The measured overrun exceeded tolerance → the INDEPENDENT hard gate fails the member.
      expect(rd.vector_deadline.adhered).toBe(false);
      expect(rd.vector_deadline.max_over_ms).toBeGreaterThan(150);
      expect(rd.gates.vector_deadline_ok).toBe(false);
      expect(rd.gates.trust_pass).toBe(false);
      expect(rd.gates.reasons.join("\n")).toContain("measured vector deadline did NOT hold");
      // Authority stays topology-scoped; budget independently evaluated.
      expect(rd.vector_exec.latency_authoritative).toBe(true);
      expect(rd.gates.budget_elapsed_ok).not.toBeNull();
      expect(d.exitCode).toBe(1);
    } finally {
      embed.stop();
    }
  }, 120_000);

  it("CLI default protocol is daemon-required and records the daemon in the report", () => {
    const dir = mkdtempSync(join(scratch, "default-"));
    const goldPath = writeGold(dir, [SPEED_CASE]);
    const env = cliEnv(dir, {});
    const out = join(dir, "run");
    const r = runCli(env, ["--gold", goldPath, "--db", snapPath, "--min-examples", "1", "--audited", "--latency-reps", "1", "--out", out]);
    expect(r.exitCode).toBe(0);
    const rep = JSON.parse(readFileSync(join(out, "hook-run.json"), "utf-8"));
    expect(rep.identity.vector_exec).toEqual({ protocol: "daemon-required", prewarm: "steady-state", response_protocol: "hydrated-v1" });
    expect(rep.vector_exec.daemon).not.toBeNull();
    expect(rep.vector_exec.daemon.prewarm_ran).toBe(true);
    expect(pidAlive(rep.vector_exec.daemon.pid)).toBe(false);
    expect(leftoverSockets(env.XDG_RUNTIME_DIR!)).toEqual([]);
    expect(leftoverWorkdirs(env.TMPDIR!)).toEqual([]);
    expect(readFileSync(join(out, "report.md"), "utf-8")).toContain("vector execution: daemon-required");
  }, 60_000);

  it("CLI refuses malformed --vector-exec / --vector-prewarm / ready-timeout values", () => {
    const dir = mkdtempSync(join(scratch, "flags-"));
    const goldPath = writeGold(dir, [SPEED_CASE]);
    const env = cliEnv(dir, {});
    const base = ["--gold", goldPath, "--db", snapPath, "--min-examples", "1"];
    expect(runCli(env, [...base, "--vector-exec", "bogus"]).stderr).toContain("--vector-exec must be daemon-required");
    expect(runCli(env, [...base, "--vector-prewarm", "warm"]).stderr).toContain("--vector-prewarm must be steady-state");
    expect(runCli(env, [...base, "--vector-daemon-ready-timeout-ms", "0"]).stderr).toContain("--vector-daemon-ready-timeout-ms must be a positive integer");
  }, 60_000);

  // ---------------------------------------------------------------------
  // Startup refusal (constraint 3): the run refuses BEFORE the first case,
  // and cleanup still runs (constraint 6 on the refusal path).
  // ---------------------------------------------------------------------
  it("startup refusal: readiness timeout refuses before the first case; the CLI cleans the working dir, socket dir, and leaves no child", () => {
    const dir = mkdtempSync(join(scratch, "ready-to-"));
    const goldPath = writeGold(dir, [SPEED_CASE]);
    const env = cliEnv(dir, {});
    const out = join(dir, "run");
    const r = runCli(env, ["--gold", goldPath, "--db", snapPath, "--min-examples", "1", "--audited", "--vector-daemon-ready-timeout-ms", "1", "--out", out]);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("daemon-required protocol could not start");
    expect(r.stderr).toContain("did not become ready within 1ms");
    expect(existsSync(join(out, "hook-run.json"))).toBe(false); // nothing scored, nothing written
    expect(leftoverWorkdirs(env.TMPDIR!)).toEqual([]);
    expect(leftoverSockets(env.XDG_RUNTIME_DIR!)).toEqual([]);
    const ps = Bun.spawnSync({ cmd: ["pgrep", "-f", `vec-daemon-child.ts --db ${env.TMPDIR}`], stdout: "pipe", stderr: "pipe" });
    expect(ps.stdout.toString().trim()).toBe("");
  }, 60_000);

  it("startup refusal: a foreign LIVE daemon on the working copy's socket is never trusted — the child self-refuses and the run refuses", async () => {
    const dir = mkdtempSync(join(scratch, "foreign-"));
    const work = makeSnapshot(dir, "work.sqlite");
    const goldPath = writeGold(dir, [SPEED_CASE]);
    // A foreign daemon in THIS process owning the socket keyed by the working copy path.
    const foreign: VectorDaemonHandle | null = await startVectorDaemon({ dbPath: work } as unknown as Store, () => {}, async () => []);
    expect(foreign).not.toBeNull();
    const store = createStore(work);
    let caseStarted = false;
    try {
      await expect(runHookEval({
        goldPath, store, minExamples: 1, audited: true,
        vectorExec: { protocol: "daemon-required", prewarm: "cold", readyTimeoutMs: 30_000 },
        _testOnCaseStart: () => { caseStarted = true; },
      // Tight on the CHILD's self-refusal (the scratch dir name contains "foreign-",
      // so a loose pattern would match the path suffix of ANY refusal message).
      })).rejects.toThrow(/daemon-required protocol could not start: vector daemon child refused to start: socket already served by foreign pid \d+ serving /);
      expect(caseStarted).toBe(false);
      // The foreign daemon was NOT clobbered: it still answers, as THIS process.
      const pong = await daemonPing(work, 2000);
      expect(pong.status).toBe("ok");
      if (pong.status === "ok") expect(pong.pid).toBe(process.pid);
    } finally {
      foreign!.close();
      store.close();
    }
    expect(existsSync(vecDaemonSocketPath(work))).toBe(false);
  }, 60_000);

  it("spawner refuses a working copy the child cannot open, and an in-memory / missing path outright", async () => {
    const dir = mkdtempSync(join(scratch, "badopen-"));
    const notADb = join(dir, "not-a-db.sqlite");
    writeFileSync(notADb, "this is not a sqlite database\n");
    await expect(spawnEvalVectorDaemon(notADb, { prewarm: "cold", readyTimeoutMs: 30_000 })).rejects.toThrow(/refused to start: open failed/);
    expect(existsSync(vecDaemonSocketPath(notADb))).toBe(false);
    await expect(spawnEvalVectorDaemon(":memory:", { prewarm: "cold" })).rejects.toThrow(EvalVectorDaemonError);
    await expect(spawnEvalVectorDaemon(join(dir, "missing.sqlite"), { prewarm: "cold" })).rejects.toThrow(/file-backed working copy/);
    await expect(spawnEvalVectorDaemon(notADb, { prewarm: "cold", readyTimeoutMs: 0 })).rejects.toThrow(/readyTimeoutMs/);
  }, 60_000);

  it("runner refuses daemon-required on an in-memory store, and refuses an UNDECLARED protocol on a file-backed store", async () => {
    const dir = mkdtempSync(join(scratch, "declare-"));
    const goldPath = writeGold(dir, [SPEED_CASE]);
    const mem = createStore(":memory:");
    await expect(runHookEval({ goldPath, store: mem, minExamples: 1, audited: true, vectorExec: { protocol: "daemon-required", prewarm: "cold" } }))
      .rejects.toThrow(/needs a file-backed working copy/);
    mem.close();
    const work = makeSnapshot(dir, "work.sqlite");
    const file = createStore(work);
    await expect(runHookEval({ goldPath, store: file, minExamples: 1, audited: true })).rejects.toThrow(/vectorExec is required for a file-backed store/);
    file.close();
  }, 30_000);

  // ---------------------------------------------------------------------
  // Mid-run death (constraint 4): the child dies between cases → the run is
  // REFUSED (never measured in-process), and the socket is cleaned up.
  // ---------------------------------------------------------------------
  it("mid-run child death refuses the run and cleans the socket", async () => {
    const dir = mkdtempSync(join(scratch, "death-"));
    const work = makeSnapshot(dir, "work.sqlite");
    const goldPath = writeGold(dir, [
      { ...BALANCED_CASE, id: "d1" },
      { ...BALANCED_CASE, id: "d2" },
    ]);
    const store = createStore(work);
    let killedPid: number | null = null;
    try {
      await expect(runHookEval({
        goldPath, store, minExamples: 1, audited: true, latencyReps: 1,
        vectorExec: { protocol: "daemon-required", prewarm: "cold", readyTimeoutMs: 30_000 },
        _testOnCaseStart: ({ index, daemonPid }) => {
          if (index === 1 && daemonPid !== null) { killedPid = daemonPid; process.kill(daemonPid, "SIGKILL"); }
        },
      // The pre-rep ownership ping (codex t77 F2) catches the death BEFORE the
      // rep; the exit-promise check or the post-rep absent check are the fallbacks.
      })).rejects.toThrow(/vector daemon (child pid \d+ died|ownership check failed before case d2 rep 0|lost during case d2)/);
    } finally {
      store.close();
    }
    expect(killedPid).not.toBeNull();
    expect(pidAlive(killedPid!)).toBe(false);
    expect(existsSync(vecDaemonSocketPath(work))).toBe(false); // stop() removed the stale socket
    // The refusal restored the env — the in-process override is NOT left armed.
    expect(process.env.CLAWMEM_VECTOR_DAEMON_REQUIRED).toBeUndefined();
  }, 60_000);

  it("a stale socket (daemon gone before the run) refuses at the first leg as daemon loss — never the in-process scan", async () => {
    const dir = mkdtempSync(join(scratch, "stale-"));
    const work = makeSnapshot(dir, "work.sqlite");
    const goldPath = writeGold(dir, [BALANCED_CASE]);
    const store = createStore(work);
    // The in-process scan, if entered, would busy-wait 3000ms (the seam is
    // live in THIS process too): a refusal that arrives faster than that
    // proves the daemon-required legs never fell back to the in-process scan
    // before refusing — the routing bridge in context-surfacing, not just the
    // post-rep trace check, is what this asserts.
    process.env.CLAWMEM_TEST_VEC_SCAN_SYNC_DELAY_MS = "3000";
    const t0 = Date.now();
    try {
      await expect(runHookEval({
        goldPath, store, minExamples: 1, audited: true, latencyReps: 1,
        vectorExec: { protocol: "daemon-required", prewarm: "cold", readyTimeoutMs: 30_000 },
        // Kill on the FIRST case: the socket file stays (SIGKILL never unlinks),
        // so the primary leg meets a STALE socket → "absent" → refusal.
        _testOnCaseStart: ({ index, daemonPid }) => { if (index === 0 && daemonPid !== null) process.kill(daemonPid, "SIGKILL"); },
      })).rejects.toThrow(/vector daemon (child pid \d+ died|ownership check failed before case b1 rep 0|lost during case b1)/);
    } finally {
      delete process.env.CLAWMEM_TEST_VEC_SCAN_SYNC_DELAY_MS;
      store.close();
    }
    expect(Date.now() - t0).toBeLessThan(2500); // refused WITHOUT the 3000ms in-process scan (the handler-boundary routing proof lives in hook-lanes)
    expect(existsSync(vecDaemonSocketPath(work))).toBe(false);
  }, 60_000);

  // ---------------------------------------------------------------------
  // Identity (constraint 5): the protocol is STRICT on every comparison
  // surface — baseline, pair (preflight + audit), replicated members — and
  // absence fails closed.
  // ---------------------------------------------------------------------
  it("identity: baseline vs candidate under different protocols (or prewarm) is refused; the pair gate refuses in PREFLIGHT", async () => {
    const dir = mkdtempSync(join(scratch, "ident-"));
    const work = makeSnapshot(dir, "work.sqlite");
    const goldPath = writeGold(dir, [SPEED_CASE, { ...SPEED_CASE, id: "s2", split: "holdout", labels: { must_include: [OAUTH_DOC], must_not_include: ["test/memory/database-migrations.md"] } }]);
    const store = createStore(work);
    try {
      const inproc = join(dir, "inproc");
      await runHookEval({ goldPath, store, minExamples: 1, audited: true, latencyReps: 1, vectorExec: { protocol: "in-process" }, outDir: inproc });
      const cold = join(dir, "cold");
      await runHookEval({ goldPath, store, minExamples: 1, audited: true, latencyReps: 1, vectorExec: { protocol: "daemon-required", prewarm: "cold", readyTimeoutMs: 30_000 }, outDir: cold });

      // --baseline: protocol mismatch refused (identity, not a treatment).
      await expect(runHookEval({
        goldPath, store, minExamples: 1, audited: true, latencyReps: 1,
        vectorExec: { protocol: "daemon-required", prewarm: "cold", readyTimeoutMs: 30_000 },
        baselinePath: join(inproc, "hook-run.json"),
      })).rejects.toThrow(/vector_exec \(in-process vs daemon-required\/cold\/hydrated-v1\)/);
      // --baseline: prewarm mismatch refused.
      await expect(runHookEval({
        goldPath, store, minExamples: 1, audited: true, latencyReps: 1,
        vectorExec: { protocol: "daemon-required", prewarm: "steady-state", readyTimeoutMs: 30_000 },
        baselinePath: join(cold, "hook-run.json"),
      })).rejects.toThrow(/vector_exec \(daemon-required\/cold\/hydrated-v1 vs daemon-required\/steady-state\/hydrated-v1\)/);
      // Same protocol: comparable (the self-comparison proceeds to acceptance).
      const same = await runHookEval({
        goldPath, store, minExamples: 1, audited: true, latencyReps: 1,
        vectorExec: { protocol: "daemon-required", prewarm: "cold", readyTimeoutMs: 30_000 },
        baselinePath: join(cold, "hook-run.json"), acceptUnmeasured: ["abstentionAccuracy", "priorLegAccuracy"],
      });
      expect(same.report.acceptance).not.toBeNull();
      expect(same.report.vector_exec!.latency_authoritative).toBe(true);
      expect(same.report.acceptance!.axes.find(a => a.metric === "latencyP95Ms")!.pass).not.toBeNull(); // MEASURED under daemon-required

      // Pair gate: refused in PREFLIGHT — no case runs.
      let caseStarted = false;
      await expect(runHookEval({
        goldPath, store, minExamples: 1, audited: true, latencyReps: 1,
        vectorExec: { protocol: "daemon-required", prewarm: "cold", readyTimeoutMs: 30_000 },
        pairWith: inproc, pairMinValid: 1,
        _testOnCaseStart: () => { caseStarted = true; },
      })).rejects.toThrow(/pair gate \(preflight\): vector execution protocol differs from the partner \(partner in-process vs this run daemon-required\/cold\/hydrated-v1\)/);
      expect(caseStarted).toBe(false);

      // Legacy partner (no vector_exec) refused in preflight too.
      const legacy = join(dir, "legacy");
      mkdirSync(legacy);
      const hr = JSON.parse(readFileSync(join(cold, "hook-run.json"), "utf-8"));
      delete hr.identity.vector_exec;
      writeFileSync(join(legacy, "hook-run.json"), JSON.stringify(hr));
      writeFileSync(join(legacy, "traces.jsonl"), readFileSync(join(cold, "traces.jsonl")));
      await expect(runHookEval({
        goldPath, store, minExamples: 1, audited: true, latencyReps: 1,
        vectorExec: { protocol: "daemon-required", prewarm: "cold", readyTimeoutMs: 30_000 },
        pairWith: legacy, pairMinValid: 1,
      })).rejects.toThrow(/pair gate \(preflight\): partner run .* carries no vector_exec identity/);
      // --baseline against the legacy report: fails closed too.
      await expect(runHookEval({
        goldPath, store, minExamples: 1, audited: true, latencyReps: 1,
        vectorExec: { protocol: "daemon-required", prewarm: "cold", readyTimeoutMs: 30_000 },
        baselinePath: join(legacy, "hook-run.json"),
      })).rejects.toThrow(/baseline predates vector_exec recording/);
    } finally {
      store.close();
    }
  }, 180_000);

  it("identity: pair audit + replicated members + shape validation enforce vector_exec", () => {
    const base = (): RunIdentity => ({
      gold_fingerprint: "f".repeat(64), limit: 10, budget_ms: 30000, profiles: "deep", corpus: "abc",
      topology: {
        embed: "http://x:1", llm: "http://x:2", rerank: "http://x:3",
        embed_model: "e1", query_model: "q1", rerank_model: "r1",
        llm_effort: "default", llm_no_think: "true", local_fallback: "blocked",
        served_embed: "se", served_llm: "sl", served_rerank: "sr",
      },
      latency_protocol: { reps: 3, aggregation: "lower-median" },
      eval_now: null,
      vector_exec: { protocol: "daemon-required", prewarm: "steady-state", response_protocol: "hydrated-v1" },
      ranking_policy: { rerank_lane_weight: 1.5, fusion_policy_rev: 6, expansion_set: "draw:aaaa111111111111", degeneracy_gate: "on" },
    } as RunIdentity);
    const other = base(); other.vector_exec = { protocol: "in-process", prewarm: "n/a", response_protocol: "n/a" };
    // pair audit: a protocol difference is a mismatch OUTSIDE the treatments.
    const v = compareIdentities(base() as unknown as Record<string, any>, other as unknown as Record<string, any>, []);
    expect(v.comparable).toBe(false);
    expect(v.mismatches.join("\n")).toContain("vector_exec.protocol");
    const absent = base(); delete (absent as unknown as Record<string, unknown>).vector_exec;
    const va = compareIdentities(absent as unknown as Record<string, any>, base() as unknown as Record<string, any>, []);
    expect(va.comparable).toBe(false);
    expect(va.mismatches.join("\n")).toContain("identity on A has no vector_exec");
    // replicated members: strict.
    const memberB = base(); memberB.ranking_policy!.expansion_set = "draw:bbbb222222222222";
    expect(() => assertReplicatedMemberIdentity(memberB, base(), "ref")).not.toThrow();
    const memberOther = base(); memberOther.ranking_policy!.expansion_set = "draw:bbbb222222222222"; memberOther.vector_exec = { protocol: "daemon-required", prewarm: "cold", response_protocol: "hydrated-v1" };
    expect(() => assertReplicatedMemberIdentity(memberOther, base(), "ref")).toThrow(/vector_exec \(daemon-required\/steady-state\/hydrated-v1 vs daemon-required\/cold\/hydrated-v1\)/);
    // t89 P2 boundary locks: an explicit raw-hit identity can NEVER compare with a
    // hydrated-v1 identity (baseline/member surface)…
    const memberRaw = base(); memberRaw.ranking_policy!.expansion_set = "draw:bbbb222222222222"; memberRaw.vector_exec = { protocol: "daemon-required", prewarm: "steady-state", response_protocol: "raw-hit" };
    expect(() => assertReplicatedMemberIdentity(memberRaw, base(), "ref")).toThrow(/response_protocol included/);
    // …and ABSENT response_protocol fails closed under EVERY protocol on the same surface…
    const memberNoRp = base(); memberNoRp.ranking_policy!.expansion_set = "draw:bbbb222222222222"; delete (memberNoRp.vector_exec as unknown as Record<string, unknown>).response_protocol;
    expect(() => assertReplicatedMemberIdentity(memberNoRp, base(), "ref")).toThrow(/records no vector_exec.response_protocol/);
    // …including ABSENT-vs-ABSENT (two pre-t84 sides must not compare as equal) on the pair surface.
    const noRpA = base(); delete (noRpA.vector_exec as unknown as Record<string, unknown>).response_protocol;
    const noRpB = base(); delete (noRpB.vector_exec as unknown as Record<string, unknown>).response_protocol;
    const vAbsent = compareIdentities(noRpA as unknown as Record<string, any>, noRpB as unknown as Record<string, any>, []);
    expect(vAbsent.comparable).toBe(false);
    expect(vAbsent.mismatches.join("\n")).toContain("records no vector_exec.response_protocol");
    // shape: malformed blocks refused by the SHARED validator.
    const bad = (msg: string): never => { throw new Error(msg); };
    const m1 = base() as unknown as Record<string, unknown>; m1.vector_exec = { protocol: "daemon-required", prewarm: "n/a" };
    expect(() => validateIdentityShape(m1, bad)).toThrow(/prewarm must be "steady-state" or "cold"/);
    const m2 = base() as unknown as Record<string, unknown>; m2.vector_exec = { protocol: "in-process", prewarm: "cold" };
    expect(() => validateIdentityShape(m2, bad)).toThrow(/prewarm must be "n\/a"/);
    const m3 = base() as unknown as Record<string, unknown>; m3.vector_exec = { protocol: "hybrid", prewarm: "cold" };
    expect(() => validateIdentityShape(m3, bad)).toThrow(/vector_exec.protocol/);
    expect(() => validateIdentityShape(base(), bad)).not.toThrow();
  });

  // ---------------------------------------------------------------------
  // Latency authority: in-process on a vector-exercising profile is NOT
  // evidence about the daemon-backed contract — the latency axes are
  // unmeasured; speed-only runs are vacuously authoritative.
  // ---------------------------------------------------------------------
  it("latency authority: in-process + balanced ⇒ latency axes unmeasured (acceptance fails undeclared); speed-only stays authoritative", async () => {
    expect(latencyEvidenceAuthoritative({ protocol: "in-process", prewarm: "n/a" }, "balanced")).toBe(false);
    expect(latencyEvidenceAuthoritative({ protocol: "in-process", prewarm: "n/a" }, "speed")).toBe(true);
    expect(latencyEvidenceAuthoritative({ protocol: "daemon-required", prewarm: "cold" }, "balanced+deep")).toBe(true);
    const dir = mkdtempSync(join(scratch, "authority-"));
    const goldPath = writeGold(dir, [BALANCED_CASE, { ...BALANCED_CASE, id: "b2", split: "holdout", labels: { must_include: [OAUTH_DOC], must_not_include: ["test/memory/database-migrations.md"] } }]);
    const mem = createStore(":memory:"); // implied in-process
    seedDocuments(mem, [
      { path: "memory/oauth-refresh-decision.md", title: "OAuth refresh token rotation decision", body: "Explain the OAuth refresh token rotation decision we made for the auth service.", contentType: "decision", confidence: 0.9, qualityScore: 0.8 },
      { path: "memory/database-migrations.md", title: "Database migration runbook", body: "Run migrations with the deploy pipeline.", contentType: "note", confidence: 0.6, qualityScore: 0.7 },
    ]);
    try {
      const out = join(dir, "base");
      const { report: baseRun } = await runHookEval({ goldPath, store: mem, minExamples: 1, audited: true, latencyReps: 1, outDir: out });
      expect(baseRun.identity!.vector_exec).toEqual({ protocol: "in-process", prewarm: "n/a", response_protocol: "n/a" });
      expect(baseRun.vector_exec!.latency_authoritative).toBe(false);
      // t82: the in-process note now states BOTH gates unmeasured (the split leaves
      // the in-process branch — no daemon → neither budget nor latency is evidence).
      expect(baseRun.vector_exec!.note).toContain("IN-PROCESS");
      expect(baseRun.vector_exec!.note).toContain("BOTH the hook-budget gate and the latency axes are UNMEASURED");
      // Codex t77 F4: the budget gate is UNMEASURED (null), trust fails for that
      // reason only, and the raw timing is still reported.
      expect(baseRun.gates.budget_elapsed_ok).toBeNull();
      expect(baseRun.gates.trust_pass).toBe(false);
      expect(baseRun.gates.reasons).toEqual([expect.stringContaining("budget evidence UNMEASURED")]);
      expect(baseRun.budget_elapsed.samples).toBeGreaterThan(0);
      const { report: cand } = await runHookEval({ goldPath, store: mem, minExamples: 1, audited: true, latencyReps: 1, baselinePath: join(out, "hook-run.json"), acceptUnmeasured: ["abstentionAccuracy", "priorLegAccuracy"] });
      expect(cand.acceptance!.pass).toBe(false);
      expect(cand.acceptance!.notes.join("\n")).toMatch(/UNDECLARED unmeasured required axes fail acceptance: .*latencyP50Ms/);
      const lat = cand.acceptance!.axes.find(a => a.metric === "latencyP95Ms")!;
      expect(lat.pass).toBeNull();
      expect(lat.note).toContain("IN-PROCESS");
      // Declared, the waiver is honoured — CONDITIONAL, never an unconditional product pass.
      const { report: waived } = await runHookEval({ goldPath, store: mem, minExamples: 1, audited: true, latencyReps: 1, baselinePath: join(out, "hook-run.json"), acceptUnmeasured: ["abstentionAccuracy", "priorLegAccuracy", "latencyP50Ms", "latencyP95Ms"] });
      expect(waived.acceptance!.pass).toBe(true);
      expect(waived.acceptance!.mode).toBe("conditional");
      expect(waived.gates.pass).toBe(false);
    } finally {
      mem.close();
    }
  }, 120_000);

  // ---------------------------------------------------------------------
  // Codex t77 F1: the evaluator environment is a transaction.
  // ---------------------------------------------------------------------
  it("F1: every refusal path restores the evaluator env byte-for-byte and clears the config cache", async () => {
    const dir = mkdtempSync(join(scratch, "envtx-"));
    const work = makeSnapshot(dir, "work.sqlite");
    const goldPath = writeGold(dir, [SPEED_CASE]);
    const seeded: Record<string, string> = {
      CLAWMEM_PROFILE: "deep",
      CLAWMEM_HOOK_DEDUP_WINDOW_SEC: "77",
      CLAWMEM_SESSION_FOCUS: "seeded-focus-topic",
      CLAWMEM_SURFACE_SECONDARY_VAULTS: "true",
      CLAWMEM_VAULTS: JSON.stringify({ skill: join(dir, "no-such-skill.sqlite") }),
      CLAWMEM_PRIOR_VECTOR_INPROC: "1",
      CLAWMEM_VECTOR_DAEMON_REQUIRED: "1",
    };
    const prior: Record<string, string | undefined> = {};
    for (const k of Object.keys(seeded)) { prior[k] = process.env[k]; process.env[k] = seeded[k]; }
    clearConfigCache();
    expect(surfaceSecondaryVaults()).toBe(true);
    const expectSeeded = (): void => { for (const k of Object.keys(seeded)) expect(process.env[k]).toBe(seeded[k]); };
    const store = createStore(work);
    try {
      // (a) refused BEFORE any mutation — undeclared protocol on a file-backed store.
      await expect(runHookEval({ goldPath, store, minExamples: 1, audited: true })).rejects.toThrow(/vectorExec is required/);
      expectSeeded();
      // (b) refused in preflight AFTER the secondary-vault + dedup mutations.
      await expect(runHookEval({ goldPath, store, minExamples: 1, audited: true, vectorExec: { protocol: "in-process" }, pairMinValid: 1 }))
        .rejects.toThrow(/meaningless without pairWith/);
      expectSeeded();
      expect(surfaceSecondaryVaults()).toBe(true); // the config cache was cleared on the way out, not left at "false"
      // (c) a completed run, then a pair-preflight protocol refusal against it.
      const partner = join(dir, "partner");
      await runHookEval({ goldPath, store, minExamples: 1, audited: true, latencyReps: 1, vectorExec: { protocol: "in-process" }, outDir: partner });
      expectSeeded();
      await expect(runHookEval({
        goldPath, store, minExamples: 1, audited: true, latencyReps: 1,
        vectorExec: { protocol: "daemon-required", prewarm: "cold", readyTimeoutMs: 30_000 },
        pairWith: partner, pairMinValid: 1,
      })).rejects.toThrow(/pair gate \(preflight\): vector execution protocol differs/);
      expectSeeded();
      expect(surfaceSecondaryVaults()).toBe(true);
      // (d) a daemon startup refusal (readiness timeout) inside the scoring try.
      await expect(runHookEval({
        goldPath, store, minExamples: 1, audited: true, latencyReps: 1,
        vectorExec: { protocol: "daemon-required", prewarm: "cold", readyTimeoutMs: 1 },
      })).rejects.toThrow(/did not become ready within 1ms/);
      expectSeeded();
    } finally {
      for (const k of Object.keys(seeded)) { if (prior[k] === undefined) delete process.env[k]; else process.env[k] = prior[k]; }
      clearConfigCache();
      store.close();
    }
  }, 120_000);

  // ---------------------------------------------------------------------
  // Codex t77 F2: ownership is verified around EVERY rep.
  // ---------------------------------------------------------------------
  it("F2: a wedged daemon (pid alive, listener not answering) is refused at the post-rep ownership ping — an \"error\" leg is never accepted unverified", async () => {
    const dir = mkdtempSync(join(scratch, "wedged-"));
    const work = makeSnapshot(dir, "work.sqlite");
    const goldPath = writeGold(dir, [BALANCED_CASE]);
    const store = createStore(work);
    let daemonPid: number | null = null;
    // The child's first scan busy-waits 20s: the leg times out at 900ms ("error"),
    // the child stays ALIVE but cannot answer — exactly the state the old
    // exit-promise check accepted.
    process.env.CLAWMEM_TEST_VEC_SCAN_SYNC_DELAY_MS = "20000";
    const t0 = Date.now();
    try {
      await expect(runHookEval({
        goldPath, store, minExamples: 1, audited: true, latencyReps: 1,
        vectorExec: { protocol: "daemon-required", prewarm: "cold", readyTimeoutMs: 30_000, _testOwnershipPingTimeoutMs: 2000, stopTimeoutMs: 1000 },
        _testOnCaseStart: ({ daemonPid: pid }) => { daemonPid = pid; },
      })).rejects.toThrow(/vector daemon ownership check failed after case b1 rep 0: no answer within 2000ms/);
    } finally {
      delete process.env.CLAWMEM_TEST_VEC_SCAN_SYNC_DELAY_MS;
      store.close();
    }
    expect(Date.now() - t0).toBeLessThan(15_000); // refused + torn down long before the 20s scan would end
    expect(daemonPid).not.toBeNull();
    expect(pidAlive(daemonPid!)).toBe(false); // SIGTERM could not be handled by the blocked child → escalated to SIGKILL
    expect(existsSync(vecDaemonSocketPath(work))).toBe(false); // the stale socket was removed (no live listener)
  }, 60_000);

  it("F2: a daemon killed DURING a request is refused by the post-rep ownership check even though the leg read as a bounded fallback", async () => {
    const dir = mkdtempSync(join(scratch, "killmid-"));
    const work = makeSnapshot(dir, "work.sqlite");
    const goldPath = writeGold(dir, [BALANCED_CASE]);
    const store = createStore(work);
    process.env.CLAWMEM_TEST_VEC_SCAN_SYNC_DELAY_MS = "2500";
    try {
      await expect(runHookEval({
        goldPath, store, minExamples: 1, audited: true, latencyReps: 1,
        vectorExec: { protocol: "daemon-required", prewarm: "cold", readyTimeoutMs: 30_000, _testOwnershipPingTimeoutMs: 2000 },
        // Kill 300ms INTO the request (the child is mid-scan): the socket file
        // survives SIGKILL, the client's connection drops → "error", and the
        // exit promise may not have settled by the post-rep check.
        _testOnCaseStart: ({ index, daemonPid }) => { if (index === 0 && daemonPid !== null) setTimeout(() => { try { process.kill(daemonPid, "SIGKILL"); } catch { /* gone */ } }, 300); },
      })).rejects.toThrow(/vector daemon (child pid \d+ died after case b1 rep 0|ownership check failed after case b1 rep 0)/);
    } finally {
      delete process.env.CLAWMEM_TEST_VEC_SCAN_SYNC_DELAY_MS;
      store.close();
    }
    expect(existsSync(vecDaemonSocketPath(work))).toBe(false);
  }, 60_000);

  // ---------------------------------------------------------------------
  // Codex t77 F3: steady-state must have warmed a real vector payload when
  // the run's profiles exercise vectors.
  // ---------------------------------------------------------------------
  it("F3: steady-state on a snapshot WITHOUT a vector payload (missing table OR dimensioned-but-empty) refuses on vector-exercising profiles; speed-only is vacuous and recorded honestly", async () => {
    const dir = mkdtempSync(join(scratch, "novec-"));
    const bare = makeSnapshot(dir, "bare.sqlite", { vectors: false });
    const empty = makeSnapshot(dir, "empty.sqlite", { vectors: "empty" });
    const store = createStore(bare);
    const emptyStore = createStore(empty);
    try {
      const balanced = writeGold(join(dir), [BALANCED_CASE]);
      await expect(runHookEval({
        goldPath: balanced, store, minExamples: 1, audited: true, latencyReps: 1,
        vectorExec: { protocol: "daemon-required", prewarm: "steady-state", readyTimeoutMs: 30_000 },
      })).rejects.toThrow(/steady-state prewarm declared but the working copy has no vector payload to warm \(no dimensioned vector table\) while the run's profiles \(balanced\) exercise vectors/);
      expect(existsSync(vecDaemonSocketPath(bare))).toBe(false); // refused AND cleaned up
      // Codex t78 F4: a dimensioned table with ZERO rows is not a warmed payload either.
      await expect(runHookEval({
        goldPath: balanced, store: emptyStore, minExamples: 1, audited: true, latencyReps: 1,
        vectorExec: { protocol: "daemon-required", prewarm: "steady-state", readyTimeoutMs: 30_000 },
      })).rejects.toThrow(/no vector payload to warm \(dimensioned vector table with 0 rows\) while the run's profiles \(balanced\) exercise vectors/);
      expect(existsSync(vecDaemonSocketPath(empty))).toBe(false);
      const speedDir = mkdtempSync(join(dir, "speed-"));
      const speed = writeGold(speedDir, [SPEED_CASE]);
      const { report } = await runHookEval({
        goldPath: speed, store, minExamples: 1, audited: true, latencyReps: 1,
        vectorExec: { protocol: "daemon-required", prewarm: "steady-state", readyTimeoutMs: 30_000 },
      });
      expect(report.vector_exec!.daemon!.prewarm_ran).toBe(false);
      expect(report.vector_exec!.latency_authoritative).toBe(true);
      expect(report.gates.trust_pass).toBe(true);
      // cold never claims a warmed payload — allowed on any profile.
      const { report: cold } = await runHookEval({
        goldPath: balanced, store, minExamples: 1, audited: true, latencyReps: 1,
        vectorExec: { protocol: "daemon-required", prewarm: "cold", readyTimeoutMs: 30_000 },
      });
      expect(cold.identity!.vector_exec).toEqual({ protocol: "daemon-required", prewarm: "cold", response_protocol: "hydrated-v1" });
    } finally {
      store.close();
      emptyStore.close();
    }
  }, 120_000);

  it("F3/F4: a POPULATED payload — the daemon-backed MATCH over stored vectors answers the primary leg (vector lane, distance 0) under steady-state, bounded and authoritative", async () => {
    const dir = mkdtempSync(join(scratch, "match-"));
    const goldPath = writeGold(dir, [BALANCED_CASE]);
    const embed = fakeEmbedServer();
    try {
      // The eval child inherits the env: its scan embeds the query at the fake
      // server (4-dim, model echoed) and runs the REAL sqlite-vec MATCH over the
      // snapshot's stored vector — no seam delay, so the leg completes.
      const env = cliEnv(dir, { CLAWMEM_EMBED_URL: embed.url });
      const out = join(dir, "run");
      const r = await runCliAsync(env, ["--gold", goldPath, "--db", snapPath, "--min-examples", "1", "--audited", "--latency-reps", "1", "--vector-exec", "daemon-required", "--vector-prewarm", "steady-state", "--out", out]);
      expect(r.exitCode).toBe(0);
      expect(embed.calls()).toBeGreaterThan(0); // the daemon child embedded the query
      const rep = JSON.parse(readFileSync(join(out, "hook-run.json"), "utf-8"));
      expect(rep.vector_exec.daemon.prewarm_ran).toBe(true);
      expect(rep.vector_exec.latency_authoritative).toBe(true);
      expect(rep.gates.budget_elapsed_ok).toBe(true);
      expect(rep.gates.trust_pass).toBe(true);
      const trace = readFileSync(join(out, "traces.jsonl"), "utf-8").split("\n").filter(Boolean).map(l => JSON.parse(l)).find((t: { id: string }) => t.id === "b1").trace;
      expect(trace.vectorLegs).toEqual([{ leg: "primary", path: "ok", protocol: "hydrated-v1" }]); // answered BY the daemon, projection-complete
      const lanes = trace.fusion.lanes.map((l: { lane: string }) => l.lane);
      expect(lanes).toContain("vector");
      expect(lanes).not.toContain("fts-fallback");
      const vectorLane = trace.fusion.lanes.find((l: { lane: string; count: number }) => l.lane === "vector");
      expect(vectorLane.count).toBe(1); // the one stored vector, hydrated locally from the daemon's hit
      // Per-candidate evidence: the OAuth doc arrived through the "vec" channel (the daemon's MATCH), and was injected.
      const oauthCandidates = trace.candidates.filter((c: { displayPath: string }) => c.displayPath === OAUTH_DOC);
      expect(JSON.stringify(oauthCandidates)).toContain('"vec"');
      expect(trace.finalPaths).toContain(OAUTH_DOC);
      expect(trace.timings.vectorMs).toBeLessThan(900); // completed inside the deadline, not cut by it
      expect(rep.cases[0].metrics.mustIncludeRecall).toBe(1);
      expect(pidAlive(rep.vector_exec.daemon.pid)).toBe(false);
    } finally {
      embed.stop();
    }
  }, 120_000);

  it("F1 (t78): the ownership-ping seam is validated — non-positive, fractional, or non-finite values are refused before any daemon is spawned", async () => {
    const dir = mkdtempSync(join(scratch, "pingval-"));
    const work = makeSnapshot(dir, "work.sqlite");
    const goldPath = writeGold(dir, [SPEED_CASE]);
    const store = createStore(work);
    try {
      for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
        let spawned = false;
        await expect(runHookEval({
          goldPath, store, minExamples: 1, audited: true, latencyReps: 1,
          vectorExec: { protocol: "daemon-required", prewarm: "cold", readyTimeoutMs: 30_000, _testOwnershipPingTimeoutMs: bad },
          _testOnCaseStart: () => { spawned = true; },
        })).rejects.toThrow(/_testOwnershipPingTimeoutMs must be a positive finite integer/);
        expect(spawned).toBe(false);
        expect(existsSync(vecDaemonSocketPath(work))).toBe(false);
      }
    } finally {
      store.close();
    }
  }, 60_000);

  // ---------------------------------------------------------------------
  // Codex t77 F5: the deployed vault's daemon is an ENFORCED prerequisite —
  // a real round trip, exit 0 only when live and serving exactly the DB.
  // ---------------------------------------------------------------------
  it("F5: vec-daemon-health — absent/stale exit 1, live-for-this-DB exit 0 (pid of the owner)", async () => {
    const dir = mkdtempSync(join(scratch, "health-"));
    const vault = makeSnapshot(dir, "vault.sqlite");
    const env = cliEnv(dir, {});
    env.INDEX_PATH = vault;
    // Async spawn: the LIVE case hosts the daemon in THIS process, whose event
    // loop must stay free to answer the CLI's ping (spawnSync would block it).
    const health = async (): Promise<{ exitCode: number | null; json: Record<string, unknown> }> => {
      const proc = Bun.spawn({ cmd: [process.execPath, "src/clawmem.ts", "vec-daemon-health", "--json"], cwd: REPO_ROOT, env, stdout: "pipe", stderr: "pipe" });
      const [out, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
      const line = out.trim().split("\n").pop() ?? "{}";
      return { exitCode, json: JSON.parse(line) };
    };
    // absent
    let h = await health();
    expect(h.exitCode).toBe(1);
    expect(h.json.status).toBe("absent");
    expect(h.json.live).toBe(false);
    // stale: a socket file nobody listens on, in the CLI's socket dir
    const priorXdg = process.env.XDG_RUNTIME_DIR;
    process.env.XDG_RUNTIME_DIR = env.XDG_RUNTIME_DIR!;
    try {
      const sock = vecDaemonSocketPath(vault);
      mkdirSync(dirname(sock), { recursive: true });
      writeFileSync(sock, "");
      h = await health();
      expect(h.exitCode).toBe(1);
      expect(h.json.status).toBe("stale");
      rmSync(sock, { force: true });
      // unresponsive: a listener that never answers
      const hung = Bun.listen<{ buf: string }>({ unix: sock, socket: { open(s) { s.data = { buf: "" }; }, data() { /* never respond */ } } });
      try {
        h = await health();
        expect(h.exitCode).toBe(1);
        expect(h.json.status).toBe("unresponsive");
      } finally { hung.stop(true); rmSync(sock, { force: true }); }
      // live-legacy: a pre-v0.38 clawmem daemon answers the frame with its exact
      // `malformed` refusal — a LISTENER, but neither attested nor hydrated-capable:
      // NON-authoritative, exit 1 (t89 P1).
      const legacy = Bun.listen<{ buf: string }>({ unix: sock, socket: { open(s) { s.data = { buf: "" }; }, data(s) { s.write(JSON.stringify({ error: "malformed" }) + "\n"); s.end(); } } });
      try {
        h = await health();
        expect(h.exitCode).toBe(1);
        expect(h.json.status).toBe("live-legacy");
        expect(h.json.attested).toBe(false);
        expect(h.json.live).toBe(true);          // a listener exists…
        expect(h.json.authoritative).toBe(false); // …but not the Path-A contract
      } finally { legacy.stop(true); rmSync(sock, { force: true }); }
      // live-raw (t89 P1): an ATTESTED pong (exact db/pid) WITHOUT the hydrated-v1
      // capability — a daemon serving the raw-hit execution: live, attested, NOT
      // authoritative, exit 1.
      const rawDaemon = Bun.listen<{ buf: string }>({ unix: sock, socket: { open(s) { s.data = { buf: "" }; }, data(s) { s.write(JSON.stringify({ pong: true, db: vault, pid: process.pid }) + "\n"); s.end(); } } });
      try {
        h = await health();
        expect(h.exitCode).toBe(1);
        expect(h.json.status).toBe("live-raw");
        expect(h.json.attested).toBe(true);
        expect(h.json.authoritative).toBe(false);
        const directRaw = await vectorDaemonHealth(vault, 1000);
        expect(directRaw.status).toBe("live-raw");
      } finally { rawDaemon.stop(true); rmSync(sock, { force: true }); }
      // live: a daemon in THIS process serving exactly the vault — v0.38 build,
      // so it advertises hydrated-v1: the ONLY authoritative (exit 0) state.
      const mine = await startVectorDaemon({ dbPath: vault } as unknown as Store, () => {}, async () => []);
      expect(mine).not.toBeNull();
      try {
        h = await health();
        expect(h.exitCode).toBe(0);
        expect(h.json.status).toBe("live");
        expect(h.json.attested).toBe(true);
        expect(h.json.authoritative).toBe(true);
        expect((h.json.protocols as string[])).toContain("hydrated-v1");
        expect(h.json.pid).toBe(process.pid);
        expect(h.json.db).toBe(vault);
        // the helper itself, same answers
        const direct = await vectorDaemonHealth(vault, 1000);
        expect(direct.status).toBe("live");
        // a daemon serving a DIFFERENT db on this vault's socket path is foreign-db, not live
        const other = makeSnapshot(dir, "other.sqlite");
        const foreignOnPath = await vectorDaemonHealth(other, 1000);
        expect(foreignOnPath.status).toBe("absent"); // other vault has its own socket key
      } finally {
        mine!.close();
      }
    } finally {
      if (priorXdg === undefined) delete process.env.XDG_RUNTIME_DIR; else process.env.XDG_RUNTIME_DIR = priorXdg;
    }
    expect((await health()).json.status).toBe("absent");
  }, 60_000);
});
