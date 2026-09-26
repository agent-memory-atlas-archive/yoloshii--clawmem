/**
 * Paired-run validity audit (codex turn-19 finding 1 + turn-20 finding 1):
 * the COMPLETE pre-treatment envelope must match per case; treatment-
 * downstream surfaces must NOT invalidate; run identities must be equal
 * except the declared treatment weight. The dropout shape mirrors the two
 * real build2f invalid pairs (an arm that never escalated); the false-valid
 * shapes (rawScore-only, gate-status-only, coverageComplete-only,
 * identity-corpus) are the turn-20 finding's named escapes.
 */
import { describe, it, expect } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { comparePairedCase, compareIdentities, auditPairedRuns } from "../../src/eval/pair-audit.ts";

function deepTrace(): Record<string, any> {
  return {
    profileName: "deep",
    sessionTopic: "billing",
    isRecencyIntent: false,
    retrievalQuery: { current: "how does reranking work", priors: [], combined: "how does reranking work", multiTurn: false, truncated: false },
    priorLeg: { enabled: false, reason: "no-anaphora", priorsUsed: 0 },
    expansion: { attempted: true, failed: false, variants: [{ type: "lex", query: "rerank mechanics", used: true }] },
    candidates: [
      { leg: "vector", filepath: "clawmem://t/a.md", displayPath: "t/a.md", source: "vec", rawScore: 0.61, rank: 0, pooled: true },
      { leg: "expansion-lex", variantQuery: "rerank mechanics", filepath: "clawmem://t/b.md", displayPath: "t/b.md", source: "fts", rawScore: 0.42, rank: 0, pooled: true },
    ],
    fusion: {
      lanes: [{ lane: "vector", weight: 1, count: 1 }, { lane: "expansion-lex", weight: 0.4, count: 1 }],
      candidates: [
        { filepath: "clawmem://t/a.md", displayPath: "t/a.md", vault: "general", lanes: ["vector"], contribution: 0.05, laneContributions: [{ lane: "vector", contribution: 0.05 }], currentSupported: true, currentQueryGatePassed: true, admitted: true },
        { filepath: "clawmem://t/b.md", displayPath: "t/b.md", vault: "general", lanes: ["expansion-lex"], contribution: 0.03, laneContributions: [{ lane: "expansion-lex", contribution: 0.03 }], currentSupported: false, currentQueryGatePassed: true, admitted: true },
      ],
      gateTokenSource: "current",
      currentMass: 0.05, discountedMass: 0.03, preCapDiscountedMass: 0.03,
      capApplied: false, capFactor: null, poolBound: 20, protectedSlots: 3, admittedCurrentSupported: 1,
    },
    rerank: {
      attempted: true, failed: false, coverageComplete: true, orderingApplied: true,
      sentPaths: ["clawmem://t/a.md", "clawmem://t/b.md"],
      sentTextHashes: ["a".repeat(64), "b".repeat(64)],
      coveredPaths: ["clawmem://t/a.md", "clawmem://t/b.md"],
      scores: [{ filepath: "clawmem://t/a.md", score: 0.9 }, { filepath: "clawmem://t/b.md", score: 0.2 }],
    },
    rankingKey: "rerank",
    finalOrder: [{ candidate: "clawmem://t/a.md", displayPath: "t/a.md", band: 0, keyValue: 0.06 }],
    finalPaths: ["t/a.md", "t/b.md"],
    filters: { privateDropped: [], snoozedDropped: [], noiseDropped: [], dedupeCollapsed: 0 },
    admission: { mode: "adaptive", bestScore: 0.5, activationFloor: 0.1, admitted: [], rejected: [], abstained: false },
  };
}

function identity(weight: number): Record<string, any> {
  // Passes the SHARED validateIdentityShape (codex turn-21: the audit gates
  // on the same validator the baseline parser uses).
  return {
    gold_fingerprint: "f".repeat(64), limit: 10, budget_ms: 30000, profiles: "deep",
    corpus: "abc123",
    topology: {
      embed: "http://x:1", llm: "http://x:2", rerank: "http://x:3",
      embed_model: "e1", query_model: "q1", rerank_model: "r1",
      llm_effort: "default", llm_no_think: "true", local_fallback: "blocked",
      served_embed: "se", served_llm: "sl", served_rerank: "sr",
    },
    latency_protocol: { reps: 3, aggregation: "lower-median" },
    // Turn-57 (codex t56 F2): the post-hoc audit fails closed on an ABSENT
    // eval_now — the fixture records the explicit wall-clock state.
    eval_now: null,
    // Codex t76: comparison surfaces fail closed on an ABSENT vector_exec —
    // the fixture records the in-process protocol explicitly.
    vector_exec: { protocol: "in-process", prewarm: "n/a", response_protocol: "n/a" },
    ranking_policy: { rerank_lane_weight: weight, fusion_policy_rev: 5, expansion_set: "draw:0123456789abcdef" },
  };
}

describe("pair-audit: pre-treatment comparability (codex turn-19 F1 + turn-20 F1)", () => {
  it("identical arms are a valid pair", () => {
    const v = comparePairedCase("c", deepTrace(), deepTrace());
    expect(v.valid).toBe(true);
    expect(v.divergences).toEqual([]);
  });

  it("treatment-downstream differences do NOT invalidate: rankingKey, orderingApplied, final order, admission, filter lists", () => {
    const a = deepTrace();
    const b = deepTrace();
    b.rankingKey = "rrf";
    b.rerank.orderingApplied = false;
    b.finalOrder = [];
    b.finalPaths = ["t/b.md"];
    b.filters.noiseDropped = ["t/x.md"];
    b.admission.admitted = [{ candidate: "clawmem://t/a.md", displayPath: "t/a.md", compositeScore: 0.4 }];
    const v = comparePairedCase("c", a, b);
    expect(v.valid).toBe(true);
  });

  it("an arm that never escalated (the build2f dropout shape) is INVALID on every lost surface", () => {
    const a = deepTrace();
    const b = deepTrace();
    b.expansion = null;
    b.fusion.lanes = [{ lane: "vector", weight: 1, count: 1 }];
    b.fusion.candidates = [b.fusion.candidates[0]];
    b.candidates = [b.candidates[0]];
    b.rerank = null;
    const v = comparePairedCase("c", a, b);
    expect(v.valid).toBe(false);
    const joined = v.divergences.join("\n");
    expect(joined).toContain("expansion");
    expect(joined).toContain("candidates: 1 only-A");
    expect(joined).toContain("fusion.candidates: 1 only-A");
    expect(joined).toContain("fusion.lanes");
    expect(joined).toContain("rerank");
  });

  it("a rawScore-only difference in the raw candidates is INVALID (turn-20: rawScore feeds composite admission)", () => {
    const a = deepTrace();
    const b = deepTrace();
    b.candidates[1].rawScore = 0.43;
    const v = comparePairedCase("c", a, b);
    expect(v.valid).toBe(false);
    expect(v.divergences.join("\n")).toContain("candidates: 0 only-A, 0 only-B, 1 changed");
  });

  it("a currentQueryGatePassed-only flip in the fusion envelope is INVALID (turn-20: gate status drives the w=0 guard)", () => {
    const a = deepTrace();
    const b = deepTrace();
    b.fusion.candidates[1].currentQueryGatePassed = false;
    const v = comparePairedCase("c", a, b);
    expect(v.valid).toBe(false);
    expect(v.divergences.join("\n")).toContain("fusion.candidates: 0 only-A, 0 only-B, 1 changed");
  });

  it("a coverageComplete-only flip is INVALID (rerank outcome state is pre-treatment; only orderingApplied is treatment-derived)", () => {
    const a = deepTrace();
    const b = deepTrace();
    b.rerank.coverageComplete = false;
    const v = comparePairedCase("c", a, b);
    expect(v.valid).toBe(false);
    expect(v.divergences.join("\n")).toContain("rerank.coverageComplete");
  });

  it("a sessionTopic difference is INVALID (topic steers the rerank request and the boost inputs)", () => {
    const a = deepTrace();
    const b = deepTrace();
    b.sessionTopic = "gardening";
    const v = comparePairedCase("c", a, b);
    expect(v.valid).toBe(false);
    expect(v.divergences.join("\n")).toContain("sessionTopic");
  });

  it("a single rerank score drift is INVALID", () => {
    const a = deepTrace();
    const b = deepTrace();
    b.rerank.scores[1].score = 0.21;
    const v = comparePairedCase("c", a, b);
    expect(v.valid).toBe(false);
    expect(v.divergences.join("\n")).toContain("rerank.scores");
  });

  it("a sentPaths ORDER difference is INVALID (the transmitted pool order is pre-treatment)", () => {
    const a = deepTrace();
    const b = deepTrace();
    b.rerank.sentPaths = ["clawmem://t/b.md", "clawmem://t/a.md"];
    const v = comparePairedCase("c", a, b);
    expect(v.valid).toBe(false);
    expect(v.divergences.join("\n")).toContain("first divergence at [0]");
  });

  it("SAME sentPaths but DIFFERENT transmitted TEXT is INVALID (BUILD-3b: identical paths prove nothing about what the reranker read)", () => {
    const a = deepTrace();
    const b = deepTrace();
    b.rerank.sentTextHashes[1] = "c".repeat(64); // same doc path, edited content
    const v = comparePairedCase("c", a, b);
    expect(v.valid).toBe(false);
    expect(v.divergences.join("\n")).toContain("rerank");
  });

  it("a pre-BUILD-3b arm paired against a recording arm is INVALID (a cross-era pair is not a pair)", () => {
    const a = deepTrace();
    const b = deepTrace();
    delete b.rerank.sentTextHashes;
    expect(comparePairedCase("c", a, b).valid).toBe(false);
    // Two pre-BUILD-3b arms still pair with each other — the field is simply absent on both.
    const c = deepTrace(); delete c.rerank.sentTextHashes;
    expect(comparePairedCase("c", b, c).valid).toBe(true);
  });

  it("a contribution change with identical membership is INVALID (fusion masses are pre-treatment)", () => {
    const a = deepTrace();
    const b = deepTrace();
    b.fusion.candidates[0].contribution = 0.06;
    b.fusion.candidates[0].laneContributions[0].contribution = 0.06;
    const v = comparePairedCase("c", a, b);
    expect(v.valid).toBe(false);
    expect(v.divergences.join("\n")).toContain("changed");
  });
});

describe("pair-audit: admission-input ledger for admission-only pairs (t53-F3 + t54-F2/F3)", () => {
  const ent = (key: string, over: Partial<{ band: 0 | 1; mass: number; compositeScore: number }> = {}) =>
    ({ key, band: 0 as 0 | 1, mass: 0.05, compositeScore: 0.4, ...over });
  const withLedger = (t: Record<string, any>, candidates: unknown[] | null): Record<string, any> =>
    ({ ...t, admissionInput: candidates === null ? null : { candidates } });

  it("the ledger is NOT compared without an admission treatment, under a rerank-lane treatment, or under a COMBINED registration (the upstream treatment legitimately changes the admission input)", () => {
    const a = withLedger(deepTrace(), [ent("clawmem://t/a.md")]);
    const b = withLedger(deepTrace(), [ent("clawmem://t/a.md"), ent("clawmem://t/b.md")]);
    expect(comparePairedCase("c", a, b).valid).toBe(true);
    expect(comparePairedCase("c", a, b, ["rerank_lane_weight"]).valid).toBe(true);
    expect(comparePairedCase("c", a, b, ["admission_policy", "rerank_lane_weight"]).valid).toBe(true);
    expect(comparePairedCase("c", a, b, ["admission_policy", "degeneracy_gate"]).valid).toBe(true);
  });

  it("an admission-only pair with differing candidate sets is INVALID — the arms judged different inputs", () => {
    const a = withLedger(deepTrace(), [ent("clawmem://t/a.md")]);
    const b = withLedger(deepTrace(), [ent("clawmem://t/a.md"), ent("clawmem://t/b.md")]);
    const v = comparePairedCase("c", a, b, ["admission_policy"]);
    expect(v.valid).toBe(false);
    expect(v.divergences.join(" ")).toContain("admissionInput");
  });

  it("same identities but different POLICY INPUTS diverge — composite-score or ordering-key drift is not a pair (t54-F3)", () => {
    const a = withLedger(deepTrace(), [ent("clawmem://t/a.md", { compositeScore: 0.41 })]);
    const b = withLedger(deepTrace(), [ent("clawmem://t/a.md", { compositeScore: 0.40 })]);
    const v = comparePairedCase("c", a, b, ["admission_policy"]);
    expect(v.valid).toBe(false);
    expect(v.divergences.join(" ")).toContain("changed policy inputs");
    const massDrift = withLedger(deepTrace(), [ent("clawmem://t/a.md", { mass: 0.06 })]);
    expect(comparePairedCase("c", withLedger(deepTrace(), [ent("clawmem://t/a.md")]), massDrift, ["admission_policy"]).valid).toBe(false);
  });

  it("matching entries pass regardless of recorded order; null-on-both (never reached admission) is symmetric evidence, not a divergence", () => {
    const a = withLedger(deepTrace(), [ent("clawmem://t/a.md"), ent("clawmem://t/b.md", { mass: 0.03 })]);
    const b = withLedger(deepTrace(), [ent("clawmem://t/b.md", { mass: 0.03 }), ent("clawmem://t/a.md")]);
    expect(comparePairedCase("c", a, b, ["admission_policy"]).valid).toBe(true);
    expect(comparePairedCase("c", withLedger(deepTrace(), null), withLedger(deepTrace(), null), ["admission_policy"]).valid).toBe(true);
  });

  it("fail-closed: an UNRECORDED ledger (pre-turn-54 trace) cannot form an admission-only pair; null-vs-entries diverges", () => {
    const old = deepTrace(); // no admissionInput key at all
    const neu = withLedger(deepTrace(), [ent("clawmem://t/a.md")]);
    expect(comparePairedCase("c", old, neu, ["admission_policy"]).valid).toBe(false);
    expect(comparePairedCase("c", old, deepTrace(), ["admission_policy"]).valid).toBe(false);
    expect(comparePairedCase("c", withLedger(deepTrace(), null), neu, ["admission_policy"]).valid).toBe(false);
  });

  it("fail-closed on MALFORMED ledgers — corrupt artifacts refuse, never coerce to the never-reached state (t54-F2)", () => {
    const good = withLedger(deepTrace(), [ent("clawmem://t/a.md")]);
    const corrupt = () => ({ ...deepTrace(), admissionInput: { candidates: "corrupt" } });
    // Two identically-corrupt artifacts must NOT pair as a legitimate null/null.
    expect(comparePairedCase("c", corrupt(), corrupt(), ["admission_policy"]).valid).toBe(false);
    expect(comparePairedCase("c", corrupt(), good, ["admission_policy"]).divergences.join(" ")).toContain("MALFORMED");
    // Pre-t55 string-entry format, duplicate keys, non-finite/absent numbers,
    // empty keys, and out-of-range bands all refuse.
    expect(comparePairedCase("c", withLedger(deepTrace(), ["clawmem://t/a.md"]), good, ["admission_policy"]).valid).toBe(false);
    expect(comparePairedCase("c", withLedger(deepTrace(), [ent("clawmem://t/a.md"), ent("clawmem://t/a.md")]), good, ["admission_policy"]).valid).toBe(false);
    expect(comparePairedCase("c", withLedger(deepTrace(), [ent("clawmem://t/a.md", { mass: Number.NaN })]), good, ["admission_policy"]).valid).toBe(false);
    expect(comparePairedCase("c", withLedger(deepTrace(), [{ key: "clawmem://t/a.md", band: 0, mass: null, compositeScore: 0.4 }]), good, ["admission_policy"]).valid).toBe(false);
    expect(comparePairedCase("c", withLedger(deepTrace(), [ent("")]), good, ["admission_policy"]).valid).toBe(false);
    expect(comparePairedCase("c", withLedger(deepTrace(), [{ key: "clawmem://t/a.md", band: 2, mass: 0.05, compositeScore: 0.4 }]), good, ["admission_policy"]).valid).toBe(false);
  });
});

describe("pair-audit: run-identity comparability (codex turn-20 F1)", () => {
  it("absent/absent eval_now REFUSES — two unidentified legacy clocks are not equal clocks (codex t56 F2)", () => {
    const legacy = (): Record<string, any> => { const id = identity(1.5); delete id.eval_now; return id; };
    const v = compareIdentities(legacy(), legacy());
    expect(v.comparable).toBe(false);
    expect(v.mismatches.join("\n")).toContain("eval_now");
    // One-sided absence names the side; explicit wall clock (null/null) compares.
    expect(compareIdentities(legacy(), identity(1.5)).mismatches.join("\n")).toContain("identity on A has no eval_now");
    expect(compareIdentities(identity(1.5), identity(1.5)).comparable).toBe(true);
  });

  it("identities equal except the declared treatment weight are comparable", () => {
    const v = compareIdentities(identity(1.5), identity(0));
    expect(v.comparable).toBe(true);
    expect(v.weights).toEqual([1.5, 0]);
    expect(v.mismatches).toEqual([]);
  });

  it("equal weights are also comparable (same-arm replicate audit)", () => {
    expect(compareIdentities(identity(0), identity(0)).comparable).toBe(true);
  });

  it("any identity difference OUTSIDE the treatment refuses comparison, naming the path", () => {
    const b = identity(0);
    b.corpus = "different";
    const v = compareIdentities(identity(1.5), b);
    expect(v.comparable).toBe(false);
    expect(v.mismatches).toContain("corpus");

    const c = identity(0);
    c.ranking_policy.expansion_set = "draw:ffffffffffffffff";
    const v2 = compareIdentities(identity(1.5), c);
    expect(v2.comparable).toBe(false);
    expect(v2.mismatches).toContain("ranking_policy.expansion_set");
  });

  it("a missing identity is not comparable", () => {
    const v = compareIdentities(null, identity(0));
    expect(v.comparable).toBe(false);
    expect(v.mismatches.join("\n")).toContain("identity missing on A");
  });

  it("identity present but TREATMENT absent is not comparable (codex turn-21: [undefined, undefined] must never read as comparable)", () => {
    const a = identity(1.5);
    const b = identity(0);
    delete a.ranking_policy;
    delete b.ranking_policy;
    const v = compareIdentities(a, b);
    expect(v.comparable).toBe(false);
    expect(v.weights).toEqual([undefined, undefined]);
    expect(v.mismatches.join("\n")).toContain("identity on A has no ranking_policy");
    expect(v.mismatches.join("\n")).toContain("identity on B has no ranking_policy");
  });

  it("a malformed treatment weight is not comparable (shared validator: finite non-negative number)", () => {
    const neg = identity(0);
    neg.ranking_policy.rerank_lane_weight = -1;
    const v = compareIdentities(identity(1.5), neg);
    expect(v.comparable).toBe(false);
    expect(v.mismatches.join("\n")).toContain("identity on B invalid");
    expect(v.mismatches.join("\n")).toContain("rerank_lane_weight");

    const str = identity(0);
    str.ranking_policy.rerank_lane_weight = "1.5";
    expect(compareIdentities(identity(1.5), str).comparable).toBe(false);
  });

  it("a structurally invalid identity is not comparable (shared validator, not a bespoke shape check)", () => {
    const broken = identity(0);
    delete broken.topology;
    const v = compareIdentities(identity(1.5), broken);
    expect(v.comparable).toBe(false);
    expect(v.mismatches.join("\n")).toContain("identity on B invalid: identity.topology");
  });

  it("auditPairedRuns reads BOTH hook-run.json identities and gates on them end-to-end", () => {
    const dirA = mkdtempSync(join(tmpdir(), "pair-audit-a-"));
    const dirB = mkdtempSync(join(tmpdir(), "pair-audit-b-"));
    try {
      const line = JSON.stringify({ id: "case1", trace: deepTrace() });
      writeFileSync(join(dirA, "traces.jsonl"), line + "\n");
      writeFileSync(join(dirB, "traces.jsonl"), line + "\n");
      writeFileSync(join(dirA, "hook-run.json"), JSON.stringify({ identity: identity(1.5) }));
      writeFileSync(join(dirB, "hook-run.json"), JSON.stringify({ identity: identity(0) }));
      const ok = auditPairedRuns(dirA, dirB);
      expect(ok.identity.comparable).toBe(true);
      expect(ok.validIds).toEqual(["case1"]);

      const bad = identity(0);
      bad.gold_fingerprint = "0".repeat(64);
      writeFileSync(join(dirB, "hook-run.json"), JSON.stringify({ identity: bad }));
      const refused = auditPairedRuns(dirA, dirB);
      expect(refused.identity.comparable).toBe(false);
      expect(refused.identity.mismatches).toContain("gold_fingerprint");
    } finally {
      rmSync(dirA, { recursive: true, force: true });
      rmSync(dirB, { recursive: true, force: true });
    }
  });
});

describe("pair-audit: degeneracy_gate as a second declared treatment (BUILD-3d)", () => {
  const gated = (weight: number, gate: "on" | "off"): Record<string, any> => {
    const id = identity(weight);
    id.ranking_policy = { ...id.ranking_policy, fusion_policy_rev: 6, degeneracy_gate: gate };
    return id;
  };

  it("identities equal except the gate toggle are comparable, and BOTH treatments are surfaced", () => {
    const v = compareIdentities(gated(1.5, "on"), gated(1.5, "off"));
    expect(v.comparable).toBe(true);
    expect(v.gates).toEqual(["on", "off"]);
    expect(v.weights).toEqual([1.5, 1.5]);
    expect(v.mismatches).toEqual([]);
  });

  it("a TWO-FACTOR difference (weight AND gate) is REFUSED without explicit registration — a confounded pair must not read as comparable (codex turn-40 ruling)", () => {
    const v = compareIdentities(gated(1.5, "on"), gated(0, "off"));
    expect(v.comparable).toBe(false);
    expect(v.weights).toEqual([1.5, 0]);
    expect(v.gates).toEqual(["on", "off"]);
    expect(v.mismatches.join("\n")).toContain("two-factor pair is confounded");
    // The SAME pair compares when the multi-factor experiment is explicitly registered.
    const registered = compareIdentities(gated(1.5, "on"), gated(0, "off"), ["rerank_lane_weight", "degeneracy_gate"]);
    expect(registered.comparable).toBe(true);
  });

  it("an explicit registration is EXACT: an unregistered treatment difference refuses, and an empty registration demands policy-identical arms", () => {
    // Gate differs but only the weight is registered → refused, naming the registration.
    const wrong = compareIdentities(gated(1.5, "on"), gated(1.5, "off"), ["rerank_lane_weight"]);
    expect(wrong.comparable).toBe(false);
    expect(wrong.mismatches.join("\n")).toContain("NOT a registered treatment");
    expect(wrong.mismatches.join("\n")).toContain("does NOT differ"); // the registered weight is ALSO equal — a no-op experiment
    // Empty registration: any treatment difference refuses (replicate audit).
    const empty = compareIdentities(gated(1.5, "on"), gated(0, "on"), []);
    expect(empty.comparable).toBe(false);
    expect(empty.mismatches.join("\n")).toContain("arms must be policy-identical");
    // Registered + differing → comparable.
    expect(compareIdentities(gated(1.5, "on"), gated(1.5, "off"), ["degeneracy_gate"]).comparable).toBe(true);
  });

  it("a REGISTERED treatment must actually DIFFER — a no-op experiment refuses (codex turn-41 F3)", () => {
    const v = compareIdentities(gated(1.5, "on"), gated(1.5, "on"), ["degeneracy_gate"]);
    expect(v.comparable).toBe(false);
    expect(v.mismatches.join("\n")).toContain("does NOT differ");
    expect(v.mismatches.join("\n")).toContain("no-op");
    // The same arms with NO registration remain comparable — the replicate audit.
    expect(compareIdentities(gated(1.5, "on"), gated(1.5, "on"), []).comparable).toBe(true);
    expect(compareIdentities(gated(1.5, "on"), gated(1.5, "on")).comparable).toBe(true);
  });

  it("equal toggles remain comparable and non-treatment differences still refuse", () => {
    expect(compareIdentities(gated(1.5, "on"), gated(1.5, "on")).comparable).toBe(true);
    const b = gated(1.5, "on");
    b.corpus = "different";
    const v = compareIdentities(gated(1.5, "on"), b);
    expect(v.comparable).toBe(false);
    expect(v.mismatches).toContain("corpus");
  });

  it("legacy rev-5 identities (no gate field) still pair with each other — gates read [undefined, undefined]", () => {
    const v = compareIdentities(identity(1.5), identity(0));
    expect(v.comparable).toBe(true);
    expect(v.gates).toEqual([undefined, undefined]);
  });
});

// ---------------------------------------------------------------------------
// BUILD-4: identity-shape rules for the admission policy
// ---------------------------------------------------------------------------
import { validateIdentityShape } from "../../src/eval/run-identity.ts";

describe("validateIdentityShape — BUILD-4 admission-policy rules", () => {
  const idWith = (rp: Record<string, unknown>) => ({
    gold_fingerprint: "f".repeat(64), limit: 10, budget_ms: 30000, profiles: "deep",
    corpus: "abc123",
    topology: {
      embed: "http://x:1", llm: "http://x:2", rerank: "http://x:3",
      embed_model: "e1", query_model: "q1", rerank_model: "r1",
      llm_effort: "default", llm_no_think: "true", local_fallback: "blocked",
      served_embed: "se", served_llm: "sl", served_rerank: "sr",
    },
    latency_protocol: { reps: 3, aggregation: "lower-median" },
    ranking_policy: { rerank_lane_weight: 1.5, expansion_set: "draw:0123456789abcdef", ...rp },
  });
  const check = (id: unknown) => () => validateIdentityShape(id, (m: string) => { throw new Error(m); });

  it("rev >= 7 without the admission policy is refused — not written by rev-7 code", () => {
    expect(check(idWith({ fusion_policy_rev: 7, degeneracy_gate: "on" })))
      .toThrow(/admission_policy is absent on a fusion_policy_rev >= 7/);
  });

  it("admission_policy and admission_rev must be present together", () => {
    expect(check(idWith({ fusion_policy_rev: 7, degeneracy_gate: "on", admission_policy: "relevance" })))
      .toThrow(/must be present together/);
    expect(check(idWith({ fusion_policy_rev: 7, degeneracy_gate: "on", admission_rev: 1 })))
      .toThrow(/must be present together/);
  });

  it("invalid values are refused", () => {
    expect(check(idWith({ fusion_policy_rev: 7, degeneracy_gate: "on", admission_policy: "hybrid", admission_rev: 1 })))
      .toThrow(/admission_policy is not/);
    expect(check(idWith({ fusion_policy_rev: 7, degeneracy_gate: "on", admission_policy: "relevance", admission_rev: 0 })))
      .toThrow(/admission_rev is not a positive integer/);
  });

  it("rev < 7 legitimately lacks the admission fields; rev 7 with both passes", () => {
    expect(check(idWith({ fusion_policy_rev: 6, degeneracy_gate: "on" }))).not.toThrow();
    expect(check(idWith({ fusion_policy_rev: 7, degeneracy_gate: "on", admission_policy: "relevance", admission_rev: 1 }))).not.toThrow();
  });
});
