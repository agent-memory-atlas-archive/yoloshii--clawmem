/**
 * Hook replay-eval — CONTRACT-5 judged acceptance gate (codex turn-7 F4/F2).
 *
 * The acceptance gate is only authoritative if it cannot pass by accident:
 * null axes fail closed, latency has explicit axes, a baseline is parsed
 * through validation (never an unchecked cast), identity mismatches refuse
 * to compare, and a run without a baseline is machine-distinguishable from
 * product acceptance (trust_pass vs acceptance_pass vs pass).
 */
import { describe, it, expect, afterAll } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { computeAcceptance, resolveAcceptancePass, parseBaselineReport, holdoutForcedUnmeasured, HookEvalIntegrityError } from "../../src/eval/hook-run.ts";
import type { HookAggregate } from "../../src/eval/hook-metrics.ts";
import type { HookGoldExample } from "../../src/eval/hook-gold.ts";

/** Final verdict shorthand: axes + policy with no declared out-of-scope axes. */
function verdict(baseline: HookAggregate, candidate: HookAggregate, declared: string[] = []): boolean {
  const { axes } = computeAcceptance(baseline, candidate);
  return resolveAcceptancePass(axes, new Set(declared)).pass;
}

function agg(overrides: Partial<HookAggregate> = {}): HookAggregate {
  return {
    cases: 3,
    ndcgMean: 0.7,
    mustNotCaseRate: 0.0,
    mustNotDocRate: 0.0,
    mustIncludeRecallMean: 1.0,
    abstentionAccuracy: 1.0,
    falseAbstainRate: 0.0,
    priorLegAccuracy: 1.0,
    latencyP50Ms: 400,
    latencyP95Ms: 900,
    timeoutRate: 0,
    ...overrides,
  };
}

describe("computeAcceptance — axis semantics", () => {
  it("passes when every axis holds (within eps / no damage increase / latency margins)", () => {
    const { axes } = computeAcceptance(agg(), agg({ ndcgMean: 0.69, latencyP95Ms: 1000 }));
    expect(axes.every(a => a.pass === true)).toBe(true);
    expect(resolveAcceptancePass(axes, new Set()).pass).toBe(true);
    // The CONTRACT-5 latency + prior-leg metrics are real axes, not just report fields.
    expect(axes.map(a => a.metric)).toContain("latencyP50Ms");
    expect(axes.map(a => a.metric)).toContain("latencyP95Ms");
    expect(axes.map(a => a.metric)).toContain("priorLegAccuracy");
  });

  it("fails on a regression axis beyond eps", () => {
    const { axes } = computeAcceptance(agg(), agg({ ndcgMean: 0.6 }));
    expect(verdict(agg(), agg({ ndcgMean: 0.6 }))).toBe(false);
    expect(axes.find(a => a.metric === "ndcgMean")!.pass).toBe(false);
  });

  it("fails when a damage axis increases at all (must-not rate)", () => {
    expect(verdict(agg(), agg({ mustNotCaseRate: 0.01 }))).toBe(false);
  });

  it("fails on a prior-leg accuracy regression (codex turn-8 F5)", () => {
    expect(verdict(agg(), agg({ priorLegAccuracy: 0.5 }))).toBe(false);
  });

  it("fails on any nonzero candidate timeout rate even when the baseline had timeouts", () => {
    expect(verdict(agg({ timeoutRate: 0.5 }), agg({ timeoutRate: 0.1 }))).toBe(false);
  });

  it("fails on latency regression beyond the relative+absolute margin", () => {
    // 900 * 1.25 + 150 = 1275 — 1300 is out.
    const { axes } = computeAcceptance(agg(), agg({ latencyP95Ms: 1300 }));
    expect(axes.find(a => a.metric === "latencyP95Ms")!.pass).toBe(false);
  });

  it("an axis null on ONE side FAILS closed (codex turn-7 F4)", () => {
    const { axes } = computeAcceptance(agg({ abstentionAccuracy: null }), agg());
    const axis = axes.find(a => a.metric === "abstentionAccuracy")!;
    expect(axis.pass).toBe(false);
    expect(axis.note).toContain("fails closed");
  });

  it("an UNDECLARED unmeasured axis FAILS acceptance; a declared one passes the policy (codex turn-8 F5)", () => {
    const { axes, unmeasured } = computeAcceptance(
      agg({ abstentionAccuracy: null }),
      agg({ abstentionAccuracy: null })
    );
    expect(unmeasured).toEqual(["abstentionAccuracy"]);
    const axis = axes.find(a => a.metric === "abstentionAccuracy")!;
    expect(axis.pass).toBeNull();
    expect(axis.note).toContain("UNMEASURED");
    // Policy: unmeasured + undeclared → acceptance FAILS (the note alone never decides).
    const undeclared = resolveAcceptancePass(axes, new Set());
    expect(undeclared.pass).toBe(false);
    expect(undeclared.undeclaredUnmeasured).toEqual(["abstentionAccuracy"]);
    // Explicitly declared out of scope (a WAIVABLE axis) → the remaining
    // axes decide, and the waiver is tracked — conditional, never silent.
    const declared = resolveAcceptancePass(axes, new Set(["abstentionAccuracy"]));
    expect(declared.pass).toBe(true);
    expect(declared.waived).toEqual(["abstentionAccuracy"]);
  });

  it("an empty label stratum forces the axis unmeasured even when the number is a trivially clean zero", () => {
    // Both sides report mustNotCaseRate 0 — but the holdout carries no
    // must_not labels, so 0 is indistinguishable from no coverage.
    const forced = new Map([["mustNotCaseRate", "no must_not-labeled cases in the held-out slice"]]);
    const { axes, unmeasured } = computeAcceptance(agg(), agg(), forced);
    expect(unmeasured).toContain("mustNotCaseRate");
    expect(axes.find(a => a.metric === "mustNotCaseRate")!.pass).toBeNull();
    expect(resolveAcceptancePass(axes, new Set()).pass).toBe(false);
  });

  it("a CORE axis cannot be waived — declaring it is ignored and acceptance still fails (codex turn-9 F5)", () => {
    const forced = new Map([["mustNotCaseRate", "no must_not-labeled cases in the held-out slice"]]);
    const { axes } = computeAcceptance(agg(), agg(), forced);
    const r = resolveAcceptancePass(axes, new Set(["mustNotCaseRate"]));
    expect(r.pass).toBe(false);
    expect(r.waived).toEqual([]);
    expect(r.undeclaredUnmeasured).toEqual(["mustNotCaseRate"]);
  });
});

describe("holdoutForcedUnmeasured — label-stratum coverage of the held-out slice", () => {
  const ex = (over: Partial<HookGoldExample>): HookGoldExample => ({
    id: "x", prompt: "p", priors: [], profile: "speed", expect_abstain: false,
    prior_leg: "harmless", labels: { must_include: [], acceptable: [], must_not_include: [] },
    split: "holdout", tags: [], ...over,
  } as HookGoldExample);

  it("maps each empty stratum to its axis", () => {
    const m = holdoutForcedUnmeasured([ex({})]);
    expect([...m.keys()].sort()).toEqual([
      "abstentionAccuracy", "mustIncludeRecallMean", "mustNotCaseRate", "ndcgMean", "priorLegAccuracy",
    ]);
  });

  it("covered strata are not forced", () => {
    const m = holdoutForcedUnmeasured([
      ex({ id: "a", labels: { must_include: ["m.md"], acceptable: [], must_not_include: ["n.md"] }, prior_leg: "forbidden" }),
      ex({ id: "b", expect_abstain: true }),
    ]);
    expect(m.size).toBe(0);
  });

  it("tuning-slice labels do not satisfy holdout strata", () => {
    const m = holdoutForcedUnmeasured([
      ex({ id: "t", split: "tuning", labels: { must_include: ["m.md"], acceptable: [], must_not_include: ["n.md"] }, expect_abstain: true, prior_leg: "required" }),
      ex({ id: "h" }),
    ]);
    expect(m.size).toBe(5);
  });
});

describe("parseBaselineReport — validated parse, never an unchecked cast", () => {
  const dir = mkdtempSync(join(tmpdir(), "clawmem-accept-test-"));
  const writeJson = (name: string, value: unknown): string => {
    const p = join(dir, name);
    writeFileSync(p, JSON.stringify(value));
    return p;
  };

  it("rejects non-JSON and non-report JSON with HookEvalIntegrityError", () => {
    const notJson = join(dir, "garbage.json");
    writeFileSync(notJson, "not json {");
    expect(() => parseBaselineReport(notJson)).toThrow(HookEvalIntegrityError);
    expect(() => parseBaselineReport(writeJson("empty.json", {}))).toThrow(HookEvalIntegrityError);
    expect(() => parseBaselineReport(writeJson("wrong-surface.json", {
      run_id: "x", surface: "query", limit: 10, budget_ms: 8000, aggregate: {}, by_split: {}, cases: [],
    }))).toThrow(HookEvalIntegrityError);
    expect(() => parseBaselineReport(writeJson("bad-cases.json", {
      run_id: "x", surface: "context-surfacing", limit: 10, budget_ms: 8000, aggregate: agg(), by_split: {}, cases: [{ nope: true }],
    }))).toThrow(HookEvalIntegrityError);
  });

  it("rejects string-typed / non-finite metric values that would coerce inside the axis comparisons (codex turn-8 F1)", () => {
    const base = {
      run_id: "x", surface: "context-surfacing", limit: 10, budget_ms: 8000,
      cases: [{ id: "c1", split: "holdout", profile: "balanced" }],
    };
    expect(() => parseBaselineReport(writeJson("string-metric.json", {
      ...base, aggregate: { ...agg(), ndcgMean: "0.7" }, by_split: {},
    }))).toThrow(HookEvalIntegrityError);
    expect(() => parseBaselineReport(writeJson("bool-metric.json", {
      ...base, aggregate: agg(), by_split: { holdout: { ...agg(), latencyP95Ms: true } },
    }))).toThrow(HookEvalIntegrityError);
    expect(() => parseBaselineReport(writeJson("missing-agg-field.json", {
      ...base, aggregate: { cases: 3 }, by_split: {},
    }))).toThrow(HookEvalIntegrityError); // absent metric fields are undefined, not null — incomplete aggregate
  });

  it("rejects a malformed identity block instead of TypeErroring later (codex turn-8 F1)", () => {
    const base = {
      run_id: "x", surface: "context-surfacing", limit: 10, budget_ms: 8000,
      aggregate: agg(), by_split: { holdout: agg() },
      cases: [{ id: "c1", split: "holdout", profile: "balanced" }],
    };
    expect(() => parseBaselineReport(writeJson("bad-identity.json", {
      ...base, identity: { gold_fingerprint: "nope", limit: 10, budget_ms: 8000, profiles: "balanced", corpus: null, topology: {}, latency_protocol: {} },
    }))).toThrow(HookEvalIntegrityError);
    expect(() => parseBaselineReport(writeJson("identity-topology-null.json", {
      ...base, identity: { gold_fingerprint: "a".repeat(64), limit: 10, budget_ms: 8000, profiles: "balanced", corpus: null, topology: null, latency_protocol: { reps: 1, aggregation: "lower-median" } },
    }))).toThrow(HookEvalIntegrityError);
  });

  it("rejects a malformed latency protocol / attested marker (codex turn-9 F1)", () => {
    const topology = {
      embed: "unset", llm: "unset", rerank: "unset",
      embed_model: "m", query_model: "m", rerank_model: "m",
      llm_effort: "default", llm_no_think: "default", local_fallback: "blocked",
      served_embed: "unreachable", served_llm: "unreachable", served_rerank: "unreachable",
    };
    const base = {
      run_id: "x", surface: "context-surfacing", limit: 10, budget_ms: 8000,
      aggregate: agg(), by_split: { holdout: agg() },
      cases: [{ id: "c1", split: "holdout", profile: "balanced" }],
    };
    const ident = (over: Record<string, unknown>) => ({
      gold_fingerprint: "a".repeat(64), limit: 10, budget_ms: 8000, profiles: "balanced",
      corpus: null, topology, latency_protocol: { reps: 1, aggregation: "lower-median" }, ...over,
    });
    expect(() => parseBaselineReport(writeJson("reps-zero.json", { ...base, identity: ident({ latency_protocol: { reps: 0, aggregation: "lower-median" } }) }))).toThrow(HookEvalIntegrityError);
    expect(() => parseBaselineReport(writeJson("reps-neg.json", { ...base, identity: ident({ latency_protocol: { reps: -1, aggregation: "lower-median" } }) }))).toThrow(HookEvalIntegrityError);
    expect(() => parseBaselineReport(writeJson("agg-arbitrary.json", { ...base, identity: ident({ latency_protocol: { reps: 1, aggregation: "arbitrary" } }) }))).toThrow(HookEvalIntegrityError);
    expect(() => parseBaselineReport(writeJson("attested-num.json", { ...base, identity: ident({ attested: 42 }) }))).toThrow(HookEvalIntegrityError);
    expect(() => parseBaselineReport(writeJson("bad-fallback.json", { ...base, identity: ident({ topology: { ...topology, local_fallback: "sometimes" } }) }))).toThrow(HookEvalIntegrityError);
    // fallback_observed (codex turn-11 F4): enum-checked, and meaningless —
    // rejected — under "blocked" (policy already excludes local execution).
    expect(() => parseBaselineReport(writeJson("bad-observed.json", { ...base, identity: ident({ topology: { ...topology, local_fallback: "allowed", fallback_observed: "sometimes" } }) }))).toThrow(HookEvalIntegrityError);
    expect(() => parseBaselineReport(writeJson("observed-on-blocked.json", { ...base, identity: ident({ topology: { ...topology, local_fallback: "blocked", fallback_observed: "none" } }) }))).toThrow(HookEvalIntegrityError);
    expect(() => parseBaselineReport(writeJson("observed-ok.json", { ...base, identity: ident({ topology: { ...topology, local_fallback: "allowed", fallback_observed: "none" } }) }))).not.toThrow();
    expect(() => parseBaselineReport(writeJson("identity-ok.json", { ...base, identity: ident({}) }))).not.toThrow();
    // ranking_policy (codex turn-17 F1): optional (legacy), but when present
    // its shape must validate — a malformed block would silently skip the
    // strict weight/protocol comparability checks.
    expect(() => parseBaselineReport(writeJson("rankpol-ok.json", { ...base, identity: ident({ ranking_policy: { rerank_lane_weight: 1.5, fusion_policy_rev: 4, expansion_set: "sampled" } }) }))).not.toThrow();
    expect(() => parseBaselineReport(writeJson("rankpol-zero-ok.json", { ...base, identity: ident({ ranking_policy: { rerank_lane_weight: 0, fusion_policy_rev: 4, expansion_set: "draw:abc123" } }) }))).not.toThrow();
    expect(() => parseBaselineReport(writeJson("rankpol-neg.json", { ...base, identity: ident({ ranking_policy: { rerank_lane_weight: -1, fusion_policy_rev: 4, expansion_set: "sampled" } }) }))).toThrow(HookEvalIntegrityError);
    expect(() => parseBaselineReport(writeJson("rankpol-badrev.json", { ...base, identity: ident({ ranking_policy: { rerank_lane_weight: 1.5, fusion_policy_rev: 0, expansion_set: "sampled" } }) }))).toThrow(HookEvalIntegrityError);
    expect(() => parseBaselineReport(writeJson("rankpol-noexp.json", { ...base, identity: ident({ ranking_policy: { rerank_lane_weight: 1.5, fusion_policy_rev: 4, expansion_set: "" } }) }))).toThrow(HookEvalIntegrityError);
    expect(() => parseBaselineReport(writeJson("rankpol-arr.json", { ...base, identity: ident({ ranking_policy: [] }) }))).toThrow(HookEvalIntegrityError);
  });

  it("degeneracy_gate (BUILD-3d): enum-checked; REQUIRED at fusion rev >= 6, legitimately absent below", () => {
    const topology = {
      embed: "unset", llm: "unset", rerank: "unset",
      embed_model: "m", query_model: "m", rerank_model: "m",
      llm_effort: "default", llm_no_think: "default", local_fallback: "blocked",
      served_embed: "unreachable", served_llm: "unreachable", served_rerank: "unreachable",
    };
    const base = {
      run_id: "x", surface: "context-surfacing", limit: 10, budget_ms: 8000,
      aggregate: agg(), by_split: { holdout: agg() },
      cases: [{ id: "c1", split: "holdout", profile: "balanced" }],
    };
    const ident = (rp: Record<string, unknown>) => ({
      gold_fingerprint: "a".repeat(64), limit: 10, budget_ms: 8000, profiles: "balanced",
      corpus: null, topology, latency_protocol: { reps: 1, aggregation: "lower-median" }, ranking_policy: rp,
    });
    const rp = (over: Record<string, unknown>) => ({ rerank_lane_weight: 1.5, fusion_policy_rev: 6, expansion_set: "sampled", degeneracy_gate: "on", ...over });
    expect(() => parseBaselineReport(writeJson("dg-on.json", { ...base, identity: ident(rp({})) }))).not.toThrow();
    expect(() => parseBaselineReport(writeJson("dg-off.json", { ...base, identity: ident(rp({ degeneracy_gate: "off" })) }))).not.toThrow();
    expect(() => parseBaselineReport(writeJson("dg-bad.json", { ...base, identity: ident(rp({ degeneracy_gate: "shadow" })) }))).toThrow(HookEvalIntegrityError);
    // Rev-6 code records the gate unconditionally — a rev-6 identity WITHOUT
    // it was not written by rev-6 code and is refused, never compared as legacy.
    expect(() => parseBaselineReport(writeJson("dg-rev6-missing.json", { ...base, identity: ident({ rerank_lane_weight: 1.5, fusion_policy_rev: 6, expansion_set: "sampled" }) }))).toThrow(HookEvalIntegrityError);
    // Rev < 6 predates the gate — absence is the legacy shape, accepted.
    expect(() => parseBaselineReport(writeJson("dg-rev5-legacy.json", { ...base, identity: ident({ rerank_lane_weight: 1.5, fusion_policy_rev: 5, expansion_set: "sampled" }) }))).not.toThrow();
  });

  it("replicated protocol (BUILD-3d): the draw list must itemize exactly n unique draws, and is forbidden elsewhere", () => {
    const topology = {
      embed: "unset", llm: "unset", rerank: "unset",
      embed_model: "m", query_model: "m", rerank_model: "m",
      llm_effort: "default", llm_no_think: "default", local_fallback: "blocked",
      served_embed: "unreachable", served_llm: "unreachable", served_rerank: "unreachable",
    };
    const base = {
      run_id: "x", surface: "context-surfacing", limit: 10, budget_ms: 8000,
      aggregate: agg(), by_split: { holdout: agg() },
      cases: [{ id: "c1", split: "holdout", profile: "balanced" }],
    };
    const ident = (rp: Record<string, unknown>) => ({
      gold_fingerprint: "a".repeat(64), limit: 10, budget_ms: 8000, profiles: "balanced",
      corpus: null, topology, latency_protocol: { reps: 1, aggregation: "lower-median" }, ranking_policy: rp,
    });
    const rp = (over: Record<string, unknown>) => ({ rerank_lane_weight: 1.5, fusion_policy_rev: 6, expansion_set: "replicated:3", degeneracy_gate: "on", expansion_draws: ["a1", "b2", "c3"], ...over });
    expect(() => parseBaselineReport(writeJson("rep-ok.json", { ...base, identity: ident(rp({})) }))).not.toThrow();
    // n must match the list, entries unique + non-empty, n >= 2.
    expect(() => parseBaselineReport(writeJson("rep-short.json", { ...base, identity: ident(rp({ expansion_draws: ["a1", "b2"] })) }))).toThrow(HookEvalIntegrityError);
    expect(() => parseBaselineReport(writeJson("rep-dup.json", { ...base, identity: ident(rp({ expansion_draws: ["a1", "a1", "c3"] })) }))).toThrow(HookEvalIntegrityError);
    expect(() => parseBaselineReport(writeJson("rep-empty-entry.json", { ...base, identity: ident(rp({ expansion_draws: ["a1", "", "c3"] })) }))).toThrow(HookEvalIntegrityError);
    expect(() => parseBaselineReport(writeJson("rep-missing.json", { ...base, identity: ident(rp({ expansion_draws: undefined })) }))).toThrow(HookEvalIntegrityError);
    expect(() => parseBaselineReport(writeJson("rep-one.json", { ...base, identity: ident(rp({ expansion_set: "replicated:1", expansion_draws: ["a1"] })) }))).toThrow(HookEvalIntegrityError);
    // A non-replicated protocol must NOT carry a draw list.
    expect(() => parseBaselineReport(writeJson("rep-forbidden.json", { ...base, identity: ident(rp({ expansion_set: "sampled" })) }))).toThrow(HookEvalIntegrityError);
  });

  it("accepts a well-formed report (including a pre-identity one)", () => {
    const p = writeJson("ok.json", {
      run_id: "base-1", surface: "context-surfacing", limit: 10, budget_ms: 8000,
      aggregate: agg(), by_split: { holdout: agg() },
      cases: [{ id: "c1", split: "holdout", profile: "balanced" }],
    });
    const r = parseBaselineReport(p);
    expect(r.run_id).toBe("base-1");
    expect(r.identity).toBeUndefined();
  });

  afterAll(() => { rmSync(dir, { recursive: true, force: true }); });
});
