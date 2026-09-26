/**
 * Experiment-level frozen clock (codex t56 F1): separately LAUNCHED draw
 * invocations must share ONE CLAWMEM_EVAL_NOW, or the replicated-member
 * identity check refuses their aggregate. scripts/experiment-clock.sh
 * persists the pin under EXPERIMENT_DIR; these tests spawn REAL separate
 * bash launches against one experiment dir — the exact "draw 1 today,
 * draw 2 tomorrow" shape the runbook produces.
 */
import { describe, it, expect, afterAll } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, chmodSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { parseEvalNowTimestamp, type RunIdentity } from "../../src/eval/run-identity.ts";
import { assertReplicatedMemberIdentity } from "../../src/eval/hook-run.ts";

const SCRIPT = join(import.meta.dir, "../../scripts/experiment-clock.sh");
const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
const newDir = (): string => { const d = mkdtempSync(join(tmpdir(), "clawmem-expclock-")); dirs.push(d); return d; };

/** One REAL separate bash launch: source the script, print the exported clock. */
function launch(dir: string, evalNow?: string): { code: number; out: string; err: string } {
  const env: Record<string, string> = { ...process.env as Record<string, string>, EXPERIMENT_DIR: dir };
  delete env.CLAWMEM_EVAL_NOW;
  if (evalNow !== undefined) env.CLAWMEM_EVAL_NOW = evalNow;
  const proc = Bun.spawnSync(["bash", "-c", `source "${SCRIPT}" && printf '%s' "$CLAWMEM_EVAL_NOW"`], { env });
  return { code: proc.exitCode, out: proc.stdout.toString(), err: proc.stderr.toString() };
}

describe("scripts/experiment-clock.sh — one experiment, one clock (codex t56 F1)", () => {
  it("two SEPARATE launches against one experiment dir export the SAME canonical clock", () => {
    const dir = newDir();
    const a = launch(dir);
    const b = launch(dir);
    expect(a.code).toBe(0);
    expect(b.code).toBe(0);
    expect(a.out).toBe(b.out);
    // Canonical through the SAME strict parser the runner preflight enforces.
    expect(parseEvalNowTimestamp(a.out)).not.toBeNull();
    expect(readFileSync(join(dir, "EVAL_NOW"), "utf-8").trim()).toBe(a.out);
  });

  it("an explicit env value seeds the experiment; later env-less launches inherit it", () => {
    const dir = newDir();
    const seeded = launch(dir, "2026-08-25T10:00:00Z");
    expect(seeded.code).toBe(0);
    expect(seeded.out).toBe("2026-08-25T10:00:00Z");
    expect(launch(dir).out).toBe("2026-08-25T10:00:00Z");
    expect(launch(dir, "2026-08-25T10:00:00Z").code).toBe(0); // matching env passes
  });

  it("a CONFLICTING env value refuses (exit 71) instead of silently forking the experiment clock", () => {
    const dir = newDir();
    launch(dir, "2026-08-25T10:00:00Z");
    const conflict = launch(dir, "2026-08-25T11:00:00Z");
    expect(conflict.code).toBe(71);
    expect(conflict.err).toContain("one experiment, one clock");
  });

  it("CONCURRENT conflicting initializers cannot fork the clock: exactly one explicit value persists atomically; every winner exports it, every loser refuses (codex t57 F1)", async () => {
    const dir = newDir();
    const clocks = Array.from({ length: 8 }, (_, i) => `2026-08-25T0${i}:00:00Z`);
    const procs = clocks.map(c => {
      const env: Record<string, string> = { ...process.env as Record<string, string>, EXPERIMENT_DIR: dir, CLAWMEM_EVAL_NOW: c };
      return Bun.spawn(["bash", "-c", `source "${SCRIPT}" && printf '%s' "$CLAWMEM_EVAL_NOW"`], { env, stdout: "pipe", stderr: "pipe" });
    });
    const results = await Promise.all(procs.map(async p => ({
      code: await p.exited, out: await new Response(p.stdout).text(),
    })));
    const persisted = readFileSync(join(dir, "EVAL_NOW"), "utf-8").trim();
    expect(clocks).toContain(persisted);                     // exactly one supplied value won, atomically
    expect(results.every(r => r.code === 0 || r.code === 71)).toBe(true);
    const winners = results.filter(r => r.code === 0);
    expect(winners.length).toBeGreaterThanOrEqual(1);
    for (const w of winners) expect(w.out).toBe(persisted);  // every success exported the DURABLE value
    // No two successes on different clocks — the fork codex named is unrepresentable.
    expect(new Set(winners.map(w => w.out)).size).toBe(1);
  });

  it("a lost NO-env race ADOPTS the durable winner — the export is always the file's value", () => {
    const dir = newDir();
    const first = launch(dir, "2026-08-25T10:00:00Z");
    expect(first.code).toBe(0);
    const second = launch(dir); // no env: must adopt, never regenerate
    expect(second.code).toBe(0);
    expect(second.out).toBe("2026-08-25T10:00:00Z");
  });

  it("an empty or CORRUPT pin REFUSES (exit 72) and is NEVER silently reseeded", () => {
    const dir = newDir();
    writeFileSync(join(dir, "EVAL_NOW"), "not-a-clock\n");
    const corrupt = launch(dir);
    expect(corrupt.code).toBe(72);
    expect(corrupt.err).toContain("refusing to reseed");
    expect(readFileSync(join(dir, "EVAL_NOW"), "utf-8")).toBe("not-a-clock\n"); // untouched
    const dir2 = newDir();
    writeFileSync(join(dir2, "EVAL_NOW"), "");
    expect(launch(dir2).code).toBe(72);
  });

  it("an UNWRITABLE experiment dir REFUSES (exit 73) — never an unpersisted exported clock", () => {
    const dir = newDir();
    chmodSync(dir, 0o500);
    try {
      const r = launch(dir);
      expect(r.code).toBe(73);
      expect(r.err).toContain("unpersisted");
    } finally {
      chmodSync(dir, 0o700);
    }
  });

  it("a noncanonical explicit CLAWMEM_EVAL_NOW on a fresh experiment REFUSES (exit 74)", () => {
    const r = launch(newDir(), "2026-08-25 10:00:00Z");
    expect(r.code).toBe(74);
  });

  it("draws launched separately under the shared clock AGGREGATE: replicated-member identity accepts them", () => {
    const dir = newDir();
    const clock = launch(dir).out;
    const clockAgain = launch(dir).out; // the second, separate launch
    const member = (drawFp: string, evalNow: string): RunIdentity => ({
      gold_fingerprint: "f".repeat(64), limit: 10, budget_ms: 30000, profiles: "deep",
      corpus: "abc123",
      topology: {
        embed: "http://x:1", llm: "http://x:2", rerank: "http://x:3",
        embed_model: "e1", query_model: "q1", rerank_model: "r1",
        llm_effort: "default", llm_no_think: "true", local_fallback: "blocked",
        served_embed: "se", served_llm: "sl", served_rerank: "sr",
      },
      latency_protocol: { reps: 3, aggregation: "lower-median" },
      eval_now: evalNow,
      // Codex t76: member comparison fails closed on an ABSENT vector_exec.
      vector_exec: { protocol: "in-process", prewarm: "n/a", response_protocol: "n/a" },
      deadline_protocol: "monotonic-relative-v1", // a CURRENT member: every run is stamped since O1 activation (an unstamped one is refused)
      ranking_policy: { rerank_lane_weight: 1.5, fusion_policy_rev: 6, expansion_set: `draw:${drawFp}`, degeneracy_gate: "on" },
    } as RunIdentity);
    expect(() => assertReplicatedMemberIdentity(member("aaaa111111111111", clock), member("bbbb222222222222", clockAgain), "ref-1")).not.toThrow();
  });
});
