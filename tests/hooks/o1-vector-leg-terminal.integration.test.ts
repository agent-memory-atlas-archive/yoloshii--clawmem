/**
 * Codex migration review r1 S1 — the per-invocation terminal record at the HANDLER boundary.
 *
 * The daemon client's own deadline timer is registered before the handler's outer race on the
 * same deadline, so when a daemon stalls it is the CLIENT timer that ends the leg: the vector
 * promise settles (it never rejects) and the handler's race records `settled`. Before the fix
 * that timer resolved `{status:"error"}` — indistinguishable from a misbehaving daemon — and the
 * record read `terminal_kind: "fallback"`. The client now resolves `deadline`, the handler maps it
 * to `abandonment`, and each invocation's record reads ITS OWN classified path (an invocation-local
 * recorder), never the latest entry of the shared leg-named ledger — deep invocations share one
 * name, so three in one handler call must each carry their own outcome.
 */
import { describe, it, expect, afterEach, beforeEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { contextSurfacing } from "../../src/hooks/context-surfacing.ts";
import { newSurfacingTrace } from "../../src/eval/hook-trace.ts";
import { startVectorDaemon, type VectorDaemonHandle } from "../../src/vector-daemon.ts";
import { VECTOR_DEADLINE_TOLERANCE_MS } from "../../src/eval/hook-run.ts";
import { createTestStore, seedDocuments } from "../helpers/test-store.ts";
import type { Store } from "../../src/store.ts";

const ENV_KEYS = ["CLAWMEM_PROFILE", "CLAWMEM_HOOK_BUDGET_MS", "CLAWMEM_HOOK_DEDUP_WINDOW_SEC", "CLAWMEM_SURFACE_SECONDARY_VAULTS", "CLAWMEM_VECTOR_DAEMON_REQUIRED", "CLAWMEM_SESSION_FOCUS", "CLAWMEM_VAULTS", "XDG_RUNTIME_DIR"];
const savedEnv: Record<string, string | undefined> = {};
let runtimeDir: string | null = null;
let handle: VectorDaemonHandle | null = null;
let release: (() => void) | null = null;

beforeEach(() => {
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  process.env.CLAWMEM_HOOK_DEDUP_WINDOW_SEC = "0";
  process.env.CLAWMEM_SURFACE_SECONDARY_VAULTS = "false";
  delete process.env.CLAWMEM_VECTOR_DAEMON_REQUIRED;
  delete process.env.CLAWMEM_SESSION_FOCUS;
  delete process.env.CLAWMEM_VAULTS;
  // An isolated socket dir: the ONLY daemon for this vault is the one each test starts.
  runtimeDir = mkdtempSync(join(tmpdir(), "clawmem-o1-terminal-"));
  process.env.XDG_RUNTIME_DIR = runtimeDir;
});
afterEach(() => {
  release?.(); release = null;           // let a stalled scan finish so single-flight releases
  handle?.close(); handle = null;
  for (const k of ENV_KEYS) { if (savedEnv[k] === undefined) delete process.env[k]; else process.env[k] = savedEnv[k]; }
  if (runtimeDir) rmSync(runtimeDir, { recursive: true, force: true });
  runtimeDir = null;
});

function seededStore(): Store {
  const store = createTestStore();
  seedDocuments(store, [
    { path: "m/rt1.md", title: "release train cadence", body: "release train cadence and stage gates for the platform", contentType: "decision", confidence: 0.9, qualityScore: 0.8 },
    { path: "m/rt2.md", title: "release train ownership", body: "release train cadence ownership and the platform stage gates responsibilities", contentType: "decision", confidence: 0.9, qualityScore: 0.8 },
  ]);
  return store;
}

describe("codex migration r1 S1: the daemon client's own deadline is recorded as ABANDONMENT, per invocation", () => {
  it("primary leg: a stalled daemon scan is ended by the CLIENT timer — status `deadline`, terminal `abandonment`, on time", async () => {
    process.env.CLAWMEM_PROFILE = "balanced"; // vectorTimeout 900
    process.env.CLAWMEM_HOOK_BUDGET_MS = "4000";
    const store = seededStore();
    const gate = new Promise<void>((r) => { release = r; });
    handle = await startVectorDaemon(store, () => {}, async () => { await gate; return []; });
    const trace = newSurfacingTrace();
    await contextSurfacing(store, { prompt: "release train cadence stage gates platform", sessionId: "o1-term-primary" }, { trace });
    const primary = (trace.vectorLegDeadlines ?? []).filter(d => d.leg === "primary");
    expect(primary.length).toBe(1);
    expect(primary[0]!.status).toBe("deadline");          // pre-fix: "error"
    expect(primary[0]!.terminal_kind).toBe("abandonment"); // pre-fix: "fallback"
    expect(primary[0]!.over_ms).toBeGreaterThanOrEqual(0);
    expect(primary[0]!.over_ms).toBeLessThanOrEqual(VECTOR_DEADLINE_TOLERANCE_MS);
    // S2: the record is internally consistent — one terminal sample.
    expect(primary[0]!.mono_elapsed_ms - primary[0]!.budget_ms).toBeCloseTo(primary[0]!.over_ms, 6);
    expect(trace.vectorLegs).toContainEqual({ leg: "primary", path: "deadline" });
  }, 20_000);

  it("deep legs: three invocations in ONE handler call each carry their own outcome — ok → completion, daemon error → fallback, client deadline → abandonment", async () => {
    process.env.CLAWMEM_PROFILE = "deep";
    process.env.CLAWMEM_HOOK_BUDGET_MS = "3000";
    const store = seededStore();
    store.expandQuery = async () => [
      { type: "vec", query: "variant one" },
      { type: "vec", query: "variant two" },
      { type: "vec", query: "variant three" },
    ] as Awaited<ReturnType<Store["expandQuery"]>>;
    store.rerank = async (_q, docs) => docs.map((d, i) => ({ file: d.file, score: 0.9 - i * 0.1 }));
    const gate = new Promise<void>((r) => { release = r; });
    handle = await startVectorDaemon(store, () => {}, async (query) => {
      if (query === "variant two") throw new Error("scan failed"); // → `internal: …` → client `error`
      if (query === "variant three") { await gate; return []; }      // stalls → the client's deadline wins
      return [];                                                     // the prompt and variant one: ok (0 hits)
    });
    const trace = newSurfacingTrace();
    await contextSurfacing(store, { prompt: "release train cadence stage gates platform", sessionId: "o1-term-deep" }, { trace });
    const deep = (trace.vectorLegDeadlines ?? []).filter(d => d.leg === "deep");
    expect(deep.map(d => [d.terminal_kind, d.status])).toEqual([
      ["completion", "ok"],
      ["fallback", "error"],
      ["abandonment", "deadline"], // pre-fix: ["fallback", "error"]
    ]);
    const abandoned = deep[2]!;
    expect(abandoned.over_ms).toBeGreaterThanOrEqual(0);
    expect(abandoned.over_ms).toBeLessThanOrEqual(VECTOR_DEADLINE_TOLERANCE_MS);
    // The shared ledger still carries every invocation, in order — the record no longer READS it.
    expect((trace.vectorLegs ?? []).filter(l => l.leg === "deep").map(l => l.path)).toEqual(["ok", "error", "deadline"]);
  }, 20_000);
});
