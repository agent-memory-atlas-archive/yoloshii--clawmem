/**
 * BUILD-3b/3c at the CLI boundary — the argument contract operators actually
 * type. The runHookEval-level refusals are covered in the hook-replay
 * integration suite; what is proven HERE is that the CLI's own validation
 * (draw-file schema v3 and the pair-gate flag triad) refuses before any run
 * starts and says exactly what to do about it.
 *
 * Real subprocess against the real CLI: a validation path that only ever ran
 * under a mocked parser is not the path the operator hits.
 */
import { describe, it, expect } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { createStore } from "../../src/store.ts";

const ROOT = join(import.meta.dir, "../..");

/** A minimal on-disk snapshot + gold pair, so argument validation is what fails — not the inputs. */
function fixture(): { dir: string; db: string; gold: string } {
  const dir = mkdtempSync(join(tmpdir(), "clawmem-evalcli-"));
  const db = join(dir, "snap.sqlite");
  createStore(db).db.close(); // a real on-disk vault so --db passes its file check
  const gold = join(dir, "cases.jsonl");
  writeFileSync(gold, JSON.stringify({
    id: "c1", prompt: "Explain the OAuth refresh token rotation decision we made", profile: "speed",
    labels: { must_include: ["test/memory/x.md"] }, split: "tuning",
  }) + "\n");
  return { dir, db, gold };
}

function runEval(args: string[]): string {
  const env = { ...process.env } as Record<string, string>;
  env.CLAWMEM_NO_LOCAL_MODELS = "true";
  env.CLAWMEM_EMBED_URL = "http://127.0.0.1:1";
  env.CLAWMEM_LLM_URL = "http://127.0.0.1:1";
  env.CLAWMEM_RERANK_URL = "http://127.0.0.1:1";
  const proc = Bun.spawnSync([process.execPath, "src/clawmem.ts", "eval", "hook-run", ...args], { env, cwd: ROOT });
  return proc.stdout.toString() + proc.stderr.toString();
}

describe("eval hook-run CLI — BUILD-3b draw schema v3 + BUILD-3c pair flags", () => {
  it("a pre-BUILD-3b draw file is refused with a RE-CAPTURE instruction (v3 adds provider + manifest)", () => {
    const { dir, db, gold } = fixture();
    try {
      // Exactly the shape the previous build wrote: valid v2, missing both v3 members.
      const draw = join(dir, "draw-v2.json");
      writeFileSync(draw, JSON.stringify({
        fingerprint: "0".repeat(16),
        rows: [{ hash: "h", result: "[]" }],
        binding: { gold_fingerprint: "a".repeat(64), corpus: null, query_model: "q", rerank_model: "r", rerank_request_rev: 1 },
      }));
      const out = runEval(["--gold", gold, "--db", db, "--replay-expansions", draw]);
      expect(out).toContain("draw file is malformed");
      expect(out).toContain("served_rerank");
      expect(out).toContain("transmitted_text_manifest");
      expect(out).toMatch(/RE-CAPTURED/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 90_000);

  it("--pair-with without --pair-min-valid is refused: a threshold chosen after the audit is not a gate", () => {
    const { dir, db, gold } = fixture();
    try {
      const out = runEval(["--gold", gold, "--db", db, "--pair-with", dir]);
      expect(out).toContain("requires --pair-min-valid");
      expect(out).toContain("PRE-REGISTERED");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 90_000);

  it("--pair-min-valid without --pair-with is refused (no partner to audit against)", () => {
    const { dir, db, gold } = fixture();
    try {
      const out = runEval(["--gold", gold, "--db", db, "--pair-min-valid", "5"]);
      expect(out).toContain("--pair-min-valid");
      expect(out).toContain("require --pair-with");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 90_000);

  it("--pair-with must name a run DIRECTORY, not a report file", () => {
    const { dir, db, gold } = fixture();
    try {
      const notADir = join(dir, "hook-run.json");
      writeFileSync(notADir, "{}");
      const out = runEval(["--gold", gold, "--db", db, "--pair-with", notADir, "--pair-min-valid", "1"]);
      expect(out).toContain("must be a completed run DIRECTORY");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 90_000);

  it("pre-registration flags require --pair-with and are shape-checked (codex turn-29 SPEC-5)", () => {
    const { dir, db, gold } = fixture();
    try {
      expect(runEval(["--gold", gold, "--db", db, "--pair-require-ids", "a,b"]))
        .toContain("require --pair-with");
      expect(runEval(["--gold", gold, "--db", db, "--pair-min-valid-stratum", "deep=8"]))
        .toContain("require --pair-with");
      expect(runEval(["--gold", gold, "--db", db, "--pair-with", dir, "--pair-min-valid", "1", "--pair-min-valid-stratum", "deep"]))
        .toContain("expects comma-separated <stratum>=<n> pairs");
      expect(runEval(["--gold", gold, "--db", db, "--pair-with", dir, "--pair-min-valid", "1", "--pair-min-valid-stratum", "deep=0"]))
        .toContain("must be <stratum>=<positive integer>");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 150_000);

  it("--pair-treatment is enum-checked and requires --pair-with (codex turn-40 F2)", () => {
    const { dir, db, gold } = fixture();
    try {
      expect(runEval(["--gold", gold, "--db", db, "--pair-treatment", "degeneracy_gate"]))
        .toContain("require --pair-with");
      expect(runEval(["--gold", gold, "--db", db, "--pair-with", dir, "--pair-min-valid", "1", "--pair-treatment", "banding"]))
        .toContain("not a registrable treatment");
      expect(runEval(["--gold", gold, "--db", db, "--pair-with", dir, "--pair-min-valid", "1", "--pair-treatment", "degeneracy_gate,degeneracy_gate"]))
        .toContain("duplicates");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 150_000);

  it("--pair-min-valid and --pair-max-retries are range-checked", () => {
    const { dir, db, gold } = fixture();
    try {
      expect(runEval(["--gold", gold, "--db", db, "--pair-with", dir, "--pair-min-valid", "0"]))
        .toContain("--pair-min-valid must be a positive integer");
      // `=` form: parseArgs rejects a bare leading-dash value before any of
      // our validation runs, so this is how a negative actually reaches it.
      expect(runEval(["--gold", gold, "--db", db, "--pair-with", dir, "--pair-min-valid", "2", "--pair-max-retries=-1"]))
        .toContain("--pair-max-retries must be a non-negative integer");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);
});

describe("eval hook-aggregate CLI — BUILD-3d replicated aggregation boundary", () => {
  function runAggregate(args: string[]): { out: string; code: number | null } {
    const proc = Bun.spawnSync([process.execPath, "src/clawmem.ts", "eval", "hook-aggregate", ...args], { env: { ...process.env } as Record<string, string>, cwd: ROOT });
    return { out: proc.stdout.toString() + proc.stderr.toString(), code: proc.exitCode };
  }

  /** A complete on-disk member report (passes parseBaselineReport). */
  function memberReport(runId: string, drawFp: string): Record<string, unknown> {
    const agg = {
      cases: 12, ndcgMean: 0.7, mustNotCaseRate: 0, mustNotDocRate: 0,
      mustIncludeRecallMean: 1, abstentionAccuracy: 1, falseAbstainRate: 0,
      priorLegAccuracy: 1, latencyP50Ms: 400, latencyP95Ms: 900, timeoutRate: 0,
    };
    return {
      run_id: runId, surface: "context-surfacing", limit: 10, budget_ms: 30000,
      aggregate: agg, by_split: { holdout: agg },
      cases: [{ id: "c1", split: "holdout", profile: "deep" }],
      identity: {
        gold_fingerprint: "f".repeat(64), limit: 10, budget_ms: 30000, profiles: "deep",
        corpus: "abc123",
        topology: {
          embed: "http://x:1", llm: "http://x:2", rerank: "http://x:3",
          embed_model: "e1", query_model: "q1", rerank_model: "r1",
          llm_effort: "default", llm_no_think: "true", local_fallback: "blocked",
          served_embed: "se", served_llm: "sl", served_rerank: "sr",
        },
        latency_protocol: { reps: 3, aggregation: "lower-median" },
        // Turn-56 (codex t55 F1): member comparison fails closed on an
        // ABSENT eval_now — record the explicit wall-clock state.
        eval_now: null,
        // Codex t76: member comparison fails closed on an ABSENT vector_exec.
        vector_exec: { protocol: "in-process", prewarm: "n/a", response_protocol: "n/a" },
        ranking_policy: { rerank_lane_weight: 1.5, fusion_policy_rev: 6, expansion_set: `draw:${drawFp}`, degeneracy_gate: "on" },
      },
      gates: { trust_pass: true, acceptance_pass: null, acceptance_waived: [], finalization_reserve_ok: null, budget_elapsed_ok: null, pass: false, reasons: [] },
      acceptance: null, pair_audit: null,
    };
  }

  it("refuses missing --runs and fewer than 2 member dirs", () => {
    expect(runAggregate([]).out).toContain("hook-aggregate");
    const dir = mkdtempSync(join(tmpdir(), "clawmem-aggcli-"));
    try {
      writeFileSync(join(dir, "hook-run.json"), JSON.stringify(memberReport("r1", "aaaa")));
      expect(runAggregate(["--runs", dir]).out).toContain("at least 2 member run directories");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 90_000);

  it("refuses a member dir without hook-run.json before parsing anything", () => {
    const d1 = mkdtempSync(join(tmpdir(), "clawmem-aggcli-a-"));
    const d2 = mkdtempSync(join(tmpdir(), "clawmem-aggcli-b-"));
    try {
      writeFileSync(join(d1, "hook-run.json"), JSON.stringify(memberReport("r1", "aaaa")));
      const r = runAggregate(["--runs", `${d1},${d2}`]);
      expect(r.out).toContain("has no hook-run.json");
    } finally {
      rmSync(d1, { recursive: true, force: true });
      rmSync(d2, { recursive: true, force: true });
    }
  }, 90_000);

  it("aggregates two trust-only members end-to-end: artifact written, replicated identity stamped, exit 1 (trust-only is never a product pass)", () => {
    const d1 = mkdtempSync(join(tmpdir(), "clawmem-aggcli-c-"));
    const d2 = mkdtempSync(join(tmpdir(), "clawmem-aggcli-d-"));
    const out = mkdtempSync(join(tmpdir(), "clawmem-aggcli-out-"));
    try {
      writeFileSync(join(d1, "hook-run.json"), JSON.stringify(memberReport("r1", "aaaa")));
      writeFileSync(join(d2, "hook-run.json"), JSON.stringify(memberReport("r2", "bbbb")));
      const r = runAggregate(["--runs", `${d1},${d2}`, "--out", out, "--json"]);
      const agg = JSON.parse(r.out.slice(r.out.indexOf("{")));
      expect(agg.identity.ranking_policy.expansion_set).toBe("replicated:2");
      expect(agg.identity.ranking_policy.expansion_draws).toEqual(["aaaa", "bbbb"]);
      expect(agg.gates.pass).toBe(false); // no acceptance comparisons — trust-only
      expect(r.code).toBe(1);
      expect(JSON.parse(readFileSync(join(out, "replicated.json"), "utf-8")).n).toBe(2);
    } finally {
      rmSync(d1, { recursive: true, force: true });
      rmSync(d2, { recursive: true, force: true });
      rmSync(out, { recursive: true, force: true });
    }
  }, 90_000);

  it("a duplicate draw across members is refused with the one-draw explanation", () => {
    const d1 = mkdtempSync(join(tmpdir(), "clawmem-aggcli-e-"));
    const d2 = mkdtempSync(join(tmpdir(), "clawmem-aggcli-f-"));
    try {
      writeFileSync(join(d1, "hook-run.json"), JSON.stringify(memberReport("r1", "aaaa")));
      writeFileSync(join(d2, "hook-run.json"), JSON.stringify(memberReport("r2", "aaaa")));
      const r = runAggregate(["--runs", `${d1},${d2}`]);
      expect(r.out).toContain("appears on more than one member");
    } finally {
      rmSync(d1, { recursive: true, force: true });
      rmSync(d2, { recursive: true, force: true });
    }
  }, 90_000);
});

describe("eval hook-run CLI — --pair-min-basis-stratum (codex t68 F3)", () => {
  it("shape, basis name, and positivity are validated, and the flag requires --pair-with", () => {
    const { dir, db, gold } = fixture();
    try {
      expect(runEval(["--gold", gold, "--db", db, "--pair-with", dir, "--pair-min-valid", "1", "--pair-min-basis-stratum", "speed=bm25-rrf"]))
        .toContain("expects comma-separated <stratum>:<basis>=<n>");
      expect(runEval(["--gold", gold, "--db", db, "--pair-with", dir, "--pair-min-valid", "1", "--pair-min-basis-stratum", "speed:frisbee=2"]))
        .toContain("not an admission basis");
      expect(runEval(["--gold", gold, "--db", db, "--pair-with", dir, "--pair-min-valid", "1", "--pair-min-basis-stratum", "speed:bm25-rrf=0"]))
        .toContain("<stratum>:<basis>=<positive integer>");
      // codex t69 F2: a duplicated canonical key must refuse, never silently
      // keep the last value (mirrors the registered-treatment duplicate rule).
      expect(runEval(["--gold", gold, "--db", db, "--pair-with", dir, "--pair-min-valid", "1", "--pair-min-basis-stratum", "speed:bm25-rrf=1,speed:bm25-rrf=2"]))
        .toContain('duplicate entry for "speed:bm25-rrf"');
      expect(runEval(["--gold", gold, "--db", db, "--pair-min-basis-stratum", "speed:bm25-rrf=1"]))
        .toContain("require --pair-with");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 240_000);
});
