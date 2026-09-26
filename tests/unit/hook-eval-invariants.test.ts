/**
 * Hook replay-eval invariants — checker behavior on synthetic traces
 * (BUILD-0, CONTRACT-5a). Enforced invariants must catch their violation
 * class; unenforced ones must land in observedViolations (they measure the
 * standing defect until their BUILD flips the flag); contract invariants
 * whose pipeline fields don't exist yet must report not-evaluable, never a
 * silent pass.
 */
import { describe, it, expect } from "bun:test";
import { newSurfacingTrace, type SurfacingTrace } from "../../src/eval/hook-trace.ts";
import { auditTrace, expansionOnlyPaths, HOOK_INVARIANTS } from "../../src/eval/hook-invariants.ts";

/** A minimal internally-consistent injected trace over one document. */
function injectedTrace(): SurfacingTrace {
  const t = newSurfacingTrace();
  t.profileName = "speed";
  t.outcome = "injected";
  t.retrievalQuery = { current: "q", priors: [], combined: "q", multiTurn: false, truncated: false };
  t.candidates.push({ leg: "fts-fallback", filepath: "clawmem://test/a.md", displayPath: "test/a.md", source: "fts", rawScore: 0.9, rank: 0, pooled: true });
  t.composite.push({ filepath: "clawmem://test/a.md", displayPath: "test/a.md", searchScore: 0.9, compositeScore: 0.7 });
  t.admission = { mode: "adaptive", bestScore: 0.7, activationFloor: 0.24, adaptiveMin: 0.45, admitted: [{ candidate: "clawmem://test/a.md", displayPath: "test/a.md", compositeScore: 0.7 }], rejected: [], abstained: false };
  t.injection = { entries: [{ candidate: "clawmem://test/a.md", displayPath: "test/a.md", tier: "WARM", tokens: 40 }], totalTokens: 40 };
  t.finalPaths = ["test/a.md"];
  // BUILD-2: an injected trace records the single ordering key.
  t.rankingKey = "rrf";
  t.finalOrder = [{ candidate: "clawmem://test/a.md", displayPath: "test/a.md", band: 0, keyValue: 0.02 }];
  return t;
}

describe("trace-complete (enforced)", () => {
  it("passes on a consistent injected trace", () => {
    const audit = auditTrace(injectedTrace());
    expect(audit.enforcedViolations).toHaveLength(0);
  });

  it("flags an injected path with no pooled candidate provenance", () => {
    const t = injectedTrace();
    t.candidates = [];
    const audit = auditTrace(t);
    expect(audit.enforcedViolations.some(v => v.id === "trace-complete" && v.violations.some(m => m.includes("no pooled candidate provenance")))).toBe(true);
  });

  it("flags an injected path with no composite record", () => {
    const t = injectedTrace();
    t.composite = [];
    const audit = auditTrace(t);
    expect(audit.enforcedViolations.some(v => v.id === "trace-complete" && v.violations.some(m => m.includes("no composite-scoring record")))).toBe(true);
  });

  it("flags an empty outcome without a reason and an injection/finalPaths mismatch", () => {
    const empty = newSurfacingTrace();
    empty.outcome = "empty";
    expect(auditTrace(empty).enforcedViolations.some(v => v.id === "trace-complete")).toBe(true);

    const mismatch = injectedTrace();
    mismatch.injection!.entries = [];
    expect(auditTrace(mismatch).enforcedViolations.some(v => v.id === "trace-complete" && v.violations.some(m => m.includes("do not match finalPaths")))).toBe(true);
  });

  it("flags a trace with no recorded outcome", () => {
    const t = newSurfacingTrace();
    const audit = auditTrace(t);
    expect(audit.enforcedViolations.some(v => v.id === "trace-complete")).toBe(true);
  });
});

describe("admission-honored (enforced)", () => {
  it("flags an injected doc that admission rejected", () => {
    const t = injectedTrace();
    t.admission!.admitted = [];
    t.admission!.rejected = [{ candidate: "clawmem://test/a.md", displayPath: "test/a.md", compositeScore: 0.7 }];
    const audit = auditTrace(t);
    expect(audit.enforcedViolations.some(v => v.id === "admission-honored")).toBe(true);
  });

  it("does NOT let an injected skill-vault doc borrow its general-vault twin's admission record (candidate identity, codex turn-15)", () => {
    // Two docs share the displayPath "test/t.md" across vaults. Admission
    // admitted ONLY the general-vault twin; injection injected the SKILL-vault
    // twin. A displayPath match would call this honored (its twin is
    // "admitted"); candidate identity must catch that the injected skill doc
    // was never itself admitted. Everything else is kept consistent so
    // admission-honored is the SOLE violation.
    const t = injectedTrace();
    t.candidates.push({ leg: "secondary-vault", filepath: "clawmem://test/t.md", displayPath: "test/t.md", source: "fts", rawScore: 0.4, rank: 0, pooled: true });
    t.composite.push({ filepath: "skill:clawmem://test/t.md", displayPath: "test/t.md", searchScore: 0.4, compositeScore: 0.6 });
    t.admission!.admitted.push({ candidate: "clawmem://test/t.md", displayPath: "test/t.md", compositeScore: 0.6 });
    t.injection!.entries.push({ candidate: "skill:clawmem://test/t.md", displayPath: "test/t.md", tier: "COLD", tokens: 10 });
    t.finalPaths.push("test/t.md");
    t.finalOrder = [
      { candidate: "clawmem://test/a.md", displayPath: "test/a.md", band: 0, keyValue: 0.02 },
      { candidate: "skill:clawmem://test/t.md", displayPath: "test/t.md", band: 0, keyValue: 0.01 },
    ];
    const audit = auditTrace(t);
    expect(audit.enforcedViolations.some(v => v.id === "admission-honored" && v.violations.some(m => m.includes("skill:clawmem://test/t.md")))).toBe(true);
    // Precision: candidate identity is the ONLY thing that failed here.
    expect(audit.enforcedViolations.map(v => v.id)).toEqual(["admission-honored"]);
  });

  it("passes a legitimately-admitted skill-vault doc even when its general-vault twin was rejected", () => {
    // The mirror case: the SKILL twin is both admitted and injected; the
    // GENERAL twin was rejected. A candidate-exact check must NOT over-fire on
    // the shared displayPath — the injected candidate is genuinely admitted.
    const t = injectedTrace();
    t.candidates.push({ leg: "secondary-vault", filepath: "clawmem://test/t.md", displayPath: "test/t.md", source: "fts", rawScore: 0.4, rank: 0, pooled: true });
    t.composite.push({ filepath: "skill:clawmem://test/t.md", displayPath: "test/t.md", searchScore: 0.4, compositeScore: 0.6 });
    t.admission!.admitted.push({ candidate: "skill:clawmem://test/t.md", displayPath: "test/t.md", compositeScore: 0.6 });
    t.admission!.rejected.push({ candidate: "clawmem://test/t.md", displayPath: "test/t.md", compositeScore: 0.1 });
    t.injection!.entries.push({ candidate: "skill:clawmem://test/t.md", displayPath: "test/t.md", tier: "COLD", tokens: 10 });
    t.finalPaths.push("test/t.md");
    t.finalOrder = [
      { candidate: "clawmem://test/a.md", displayPath: "test/a.md", band: 0, keyValue: 0.02 },
      { candidate: "skill:clawmem://test/t.md", displayPath: "test/t.md", band: 0, keyValue: 0.01 },
    ];
    expect(auditTrace(t).enforcedViolations.filter(v => v.id === "admission-honored")).toHaveLength(0);
  });

  it("is not evaluable on an empty outcome", () => {
    const t = newSurfacingTrace();
    t.outcome = "empty";
    t.emptyReason = "gate:short-prompt";
    const audit = auditTrace(t);
    expect(audit.notEvaluable).toContain("admission-honored");
  });
});

describe("defect measures", () => {
  it("expansion-only leak on a failed/absent rerank is an ENFORCED violation (BUILD-1)", () => {
    const t = injectedTrace();
    // Add an expansion-only candidate that reached output with no rerank at all.
    t.candidates.push({ leg: "expansion-vec", variantQuery: "generic query", filepath: "clawmem://test/x.md", displayPath: "test/x.md", source: "vec", rawScore: 0.3, rank: 0, pooled: true });
    t.composite.push({ filepath: "clawmem://test/x.md", displayPath: "test/x.md", searchScore: 0.3, compositeScore: 0.6 });
    t.admission!.admitted.push({ candidate: "clawmem://test/x.md", displayPath: "test/x.md", compositeScore: 0.6 });
    t.injection!.entries.push({ candidate: "clawmem://test/x.md", displayPath: "test/x.md", tier: "COLD", tokens: 10 });
    t.finalPaths.push("test/x.md");

    expect([...expansionOnlyPaths(t)]).toEqual(["test/x.md"]);
    const audit = auditTrace(t);
    expect(audit.enforcedViolations.some(v => v.id === "no-expansion-leak-on-failed-rerank")).toBe(true);
  });

  it("an expansion-only candidate whose per-candidate gate PASSED is contract-compliant without rerank (codex turn-7 F7)", () => {
    const t = injectedTrace();
    t.candidates.push({ leg: "expansion-vec", variantQuery: "v", filepath: "clawmem://test/x.md", displayPath: "test/x.md", source: "vec", rawScore: 0.3, rank: 0, pooled: true });
    t.composite.push({ filepath: "clawmem://test/x.md", displayPath: "test/x.md", searchScore: 0.3, compositeScore: 0.6 });
    t.admission!.admitted.push({ candidate: "clawmem://test/x.md", displayPath: "test/x.md", compositeScore: 0.6 });
    t.injection!.entries.push({ candidate: "clawmem://test/x.md", displayPath: "test/x.md", tier: "COLD", tokens: 10 });
    t.finalPaths.push("test/x.md");
    // dropUnarbitrated keeps a gate-passer — the invariant must accept the same output.
    t.fusion = {
      lanes: [], gateTokenSource: "current", currentMass: 0.2, discountedMass: 0.05, preCapDiscountedMass: 0.05,
      capApplied: false, capFactor: null, poolBound: 15, protectedSlots: 0, admittedCurrentSupported: 1,
      candidates: [{
        filepath: "clawmem://test/x.md", displayPath: "test/x.md", vault: "general",
        lanes: ["expansion-vec"], contribution: 0.05,
        laneContributions: [{ lane: "expansion-vec", contribution: 0.05 }],
        currentSupported: false, currentQueryGatePassed: true, admitted: true,
      }],
    };
    const audit = auditTrace(t);
    expect(audit.enforcedViolations.some(v => v.id === "no-expansion-leak-on-failed-rerank")).toBe(false);
  });

  it("an expansion-only candidate whose gate FAILED still violates on a failed/absent rerank", () => {
    const t = injectedTrace();
    t.candidates.push({ leg: "expansion-vec", variantQuery: "v", filepath: "clawmem://test/x.md", displayPath: "test/x.md", source: "vec", rawScore: 0.3, rank: 0, pooled: true });
    t.composite.push({ filepath: "clawmem://test/x.md", displayPath: "test/x.md", searchScore: 0.3, compositeScore: 0.6 });
    t.admission!.admitted.push({ candidate: "clawmem://test/x.md", displayPath: "test/x.md", compositeScore: 0.6 });
    t.injection!.entries.push({ candidate: "clawmem://test/x.md", displayPath: "test/x.md", tier: "COLD", tokens: 10 });
    t.finalPaths.push("test/x.md");
    t.fusion = {
      lanes: [], gateTokenSource: "current", currentMass: 0.2, discountedMass: 0.05, preCapDiscountedMass: 0.05,
      capApplied: false, capFactor: null, poolBound: 15, protectedSlots: 0, admittedCurrentSupported: 1,
      candidates: [{
        filepath: "clawmem://test/x.md", displayPath: "test/x.md", vault: "general",
        lanes: ["expansion-vec"], contribution: 0.05,
        laneContributions: [{ lane: "expansion-vec", contribution: 0.05 }],
        currentSupported: false, currentQueryGatePassed: false, admitted: true,
      }],
    };
    const audit = auditTrace(t);
    expect(audit.enforcedViolations.some(v => v.id === "no-expansion-leak-on-failed-rerank")).toBe(true);
  });

  it("a doc with current-leg support is never expansion-only", () => {
    const t = injectedTrace();
    t.candidates.push({ leg: "expansion-lex", variantQuery: "v", filepath: "clawmem://test/a.md", displayPath: "test/a.md", source: "fts", rawScore: 0.5, rank: 0, pooled: true });
    expect(expansionOnlyPaths(t).size).toBe(0);
  });

  it("a COMPLETED zero-weight rerank (coverageComplete, ordering NOT applied) does not arbitrate — a gate-failing expansion-only doc still violates (codex turn-18 F3)", () => {
    const t = injectedTrace();
    t.candidates.push({ leg: "expansion-vec", variantQuery: "v", filepath: "clawmem://test/x.md", displayPath: "test/x.md", source: "vec", rawScore: 0.3, rank: 0, pooled: true });
    t.composite.push({ filepath: "clawmem://test/x.md", displayPath: "test/x.md", searchScore: 0.3, compositeScore: 0.6 });
    t.admission!.admitted.push({ candidate: "clawmem://test/x.md", displayPath: "test/x.md", compositeScore: 0.6 });
    t.injection!.entries.push({ candidate: "clawmem://test/x.md", displayPath: "test/x.md", tier: "COLD", tokens: 10 });
    t.finalPaths.push("test/x.md");
    // The w=0 trace shape: the reranker ANSWERED everything (transport
    // completeness) but the lane never influenced ordering. Coverage alone
    // must not qualify the gate-failing candidate.
    t.rerank = {
      attempted: true, failed: false, coverageComplete: true, orderingApplied: false,
      sentPaths: ["clawmem://test/a.md", "clawmem://test/x.md"],
      coveredPaths: ["clawmem://test/a.md", "clawmem://test/x.md"],
      scores: [{ filepath: "clawmem://test/a.md", score: 0.9 }, { filepath: "clawmem://test/x.md", score: 0.1 }],
    };
    t.fusion = {
      lanes: [], gateTokenSource: "current", currentMass: 0.2, discountedMass: 0.05, preCapDiscountedMass: 0.05,
      capApplied: false, capFactor: null, poolBound: 15, protectedSlots: 0, admittedCurrentSupported: 1,
      candidates: [{
        filepath: "clawmem://test/x.md", displayPath: "test/x.md", vault: "general",
        lanes: ["expansion-vec"], contribution: 0.05,
        laneContributions: [{ lane: "expansion-vec", contribution: 0.05 }],
        currentSupported: false, currentQueryGatePassed: false, admitted: true,
      }],
    };
    const audit = auditTrace(t);
    expect(audit.enforcedViolations.some(v => v.id === "no-expansion-leak-on-failed-rerank")).toBe(true);
    // An APPLIED rerank (active lane, full coverage) still arbitrates.
    t.rerank.orderingApplied = true;
    const audit2 = auditTrace(t);
    expect(audit2.enforcedViolations.some(v => v.id === "no-expansion-leak-on-failed-rerank")).toBe(false);
  });

  it("partial rerank coverage over injected docs lands in observedViolations", () => {
    const t = injectedTrace();
    t.candidates.push({ leg: "fts-fallback", filepath: "clawmem://test/b.md", displayPath: "test/b.md", source: "fts", rawScore: 0.8, rank: 1, pooled: true });
    t.composite.push({ filepath: "clawmem://test/b.md", displayPath: "test/b.md", searchScore: 0.8, compositeScore: 0.65 });
    t.admission!.admitted.push({ candidate: "clawmem://test/b.md", displayPath: "test/b.md", compositeScore: 0.65 });
    t.injection!.entries.push({ candidate: "clawmem://test/b.md", displayPath: "test/b.md", tier: "WARM", tokens: 30 });
    t.finalPaths.push("test/b.md");
    t.finalOrder = [
      { candidate: "clawmem://test/a.md", displayPath: "test/a.md", band: 0, keyValue: 0.02 },
      { candidate: "clawmem://test/b.md", displayPath: "test/b.md", band: 0, keyValue: 0.01 },
    ];
    // Rerank covered only a.md; b.md reached output unreranked while the pool was reordered.
    t.rerank = { attempted: true, sentPaths: ["clawmem://test/a.md"], coveredPaths: ["clawmem://test/a.md"], scores: [{ filepath: "clawmem://test/a.md", score: 0.9 }], orderingApplied: true, failed: false };

    const audit = auditTrace(t);
    expect(audit.enforcedViolations).toHaveLength(0);
    expect(audit.observedViolations.some(v => v.id === "rerank-coverage-or-fallback" && v.violations.some(m => m.includes("test/b.md")))).toBe(true);
  });
});

describe("future-BUILD invariants report not-evaluable on incomplete traces", () => {
  it("mass-cap-without-fusion-record is not-evaluable; single-ranking-key and metadata-band-only EVALUATE on an injected trace with finalOrder (BUILD-2/BUILD-5)", () => {
    const audit = auditTrace(injectedTrace()); // synthetic trace: fusion = null
    expect(audit.notEvaluable).not.toContain("single-ranking-key"); // enforced + evaluable (passes here)
    expect(audit.notEvaluable).toContain("expansion-mass-cap");
    // BUILD-5: the zero-width band evaluates from finalOrder (and passes here).
    expect(audit.notEvaluable).not.toContain("metadata-band-only");
    expect(audit.enforcedViolations.filter(v => v.id === "metadata-band-only").flatMap(v => v.violations)).toHaveLength(0);
  });

  it("registry enforcement flags match the BUILD-2 ratchet state", () => {
    const byId = new Map(HOOK_INVARIANTS.map(i => [i.id, i.enforced]));
    expect(byId.get("trace-complete")).toBe(true);
    expect(byId.get("admission-honored")).toBe(true);
    expect(byId.get("expansion-mass-cap")).toBe(true);            // BUILD-1
    expect(byId.get("no-expansion-leak-on-failed-rerank")).toBe(true); // BUILD-1
    expect(byId.get("single-ranking-key")).toBe(true);            // BUILD-2
    expect(byId.get("rerank-coverage-or-fallback")).toBe(false);  // BUILD-3
    expect(byId.get("metadata-band-only")).toBe(true);            // BUILD-5: zero-width band ENFORCED
  });
});

describe("expansion-mass-cap (enforced, BUILD-1)", () => {
  function fusionTrace(fusion: Partial<NonNullable<SurfacingTrace["fusion"]>>, priorEnabled = false): SurfacingTrace {
    const t = injectedTrace();
    t.priorLeg = { enabled: priorEnabled, reason: priorEnabled ? "anaphora-low-content" : "self-sufficient", priorsUsed: priorEnabled ? 1 : 0 };
    t.fusion = {
      lanes: [], candidates: [], gateTokenSource: "current", currentMass: 0, discountedMass: 0, preCapDiscountedMass: 0,
      capApplied: false, capFactor: null, poolBound: 15, protectedSlots: 0, admittedCurrentSupported: 0,
      ...fusion,
    };
    return t;
  }

  it("passes when discounted mass stays below current mass and slots are honored", () => {
    const t = fusionTrace({ currentMass: 0.1, discountedMass: 0.05, protectedSlots: 2, admittedCurrentSupported: 2 });
    expect(auditTrace(t).enforcedViolations).toHaveLength(0);
  });

  it("flags discounted mass reaching current mass", () => {
    const t = fusionTrace({ currentMass: 0.1, discountedMass: 0.1 });
    expect(auditTrace(t).enforcedViolations.some(v => v.id === "expansion-mass-cap")).toBe(true);
  });

  it("flags a protected-slot shortfall", () => {
    const t = fusionTrace({ currentMass: 0.1, discountedMass: 0.01, protectedSlots: 3, admittedCurrentSupported: 1 });
    expect(auditTrace(t).enforcedViolations.some(v => v.id === "expansion-mass-cap" && v.violations.some(m => m.includes("protected slots")))).toBe(true);
  });

  it("zero-current-mass edge: certified prior leg passes, uncertified fails", () => {
    const certified = fusionTrace({ currentMass: 0, discountedMass: 0.05 }, true);
    expect(auditTrace(certified).enforcedViolations).toHaveLength(0);
    const uncertified = fusionTrace({ currentMass: 0, discountedMass: 0.05 }, false);
    expect(auditTrace(uncertified).enforcedViolations.some(v => v.id === "expansion-mass-cap")).toBe(true);
  });
});

describe("single-ranking-key (ENFORCED since BUILD-2)", () => {
  it("passes on an injected trace with an rrf key and non-increasing order", () => {
    const t = injectedTrace();
    const audit = auditTrace(t);
    expect(audit.enforcedViolations.filter(v => v.id === "single-ranking-key")).toHaveLength(0);
    expect(audit.notEvaluable).not.toContain("single-ranking-key");
  });

  it("flags an injected trace still ordered by the composite key", () => {
    const t = injectedTrace();
    t.rankingKey = "composite";
    expect(auditTrace(t).enforcedViolations.some(v => v.id === "single-ranking-key" && v.violations.some(m => m.includes("composite")))).toBe(true);
  });

  it("flags an injected trace without a finalOrder record", () => {
    const t = injectedTrace();
    t.finalOrder = null;
    expect(auditTrace(t).enforcedViolations.some(v => v.id === "single-ranking-key" && v.violations.some(m => m.includes("finalOrder")))).toBe(true);
  });

  it("flags an injected path missing from the key record and a key inversion", () => {
    const t = injectedTrace();
    t.candidates.push({ leg: "fts-fallback", filepath: "clawmem://test/b.md", displayPath: "test/b.md", source: "fts", rawScore: 0.8, rank: 1, pooled: true });
    t.composite.push({ filepath: "clawmem://test/b.md", displayPath: "test/b.md", searchScore: 0.8, compositeScore: 0.6 });
    t.admission!.admitted.push({ candidate: "clawmem://test/b.md", displayPath: "test/b.md", compositeScore: 0.6 });
    t.injection!.entries.push({ candidate: "clawmem://test/b.md", displayPath: "test/b.md", tier: "WARM", tokens: 40 });
    t.finalPaths = ["test/a.md", "test/b.md"];
    // Missing key record for b:
    expect(auditTrace(t).enforcedViolations.some(v => v.id === "single-ranking-key" && v.violations.some(m => m.includes("no final-ordering key record")))).toBe(true);
    // Inversion: b carries a LARGER key than a but is injected after it.
    t.finalOrder = [
      { candidate: "clawmem://test/a.md", displayPath: "test/a.md", band: 0, keyValue: 0.02 },
      { candidate: "clawmem://test/b.md", displayPath: "test/b.md", band: 0, keyValue: 0.05 },
    ];
    expect(auditTrace(t).enforcedViolations.some(v => v.id === "single-ranking-key" && v.violations.some(m => m.includes("inverts the relevance key")))).toBe(true);
    // Correct non-increasing order passes; a buildContext SKIP (a path in
    // finalOrder but absent from finalPaths) does not violate.
    t.finalOrder = [
      { candidate: "clawmem://test/a.md", displayPath: "test/a.md", band: 0, keyValue: 0.05 },
      { candidate: "clawmem://skipped/by-budget.md", displayPath: "skipped/by-budget.md", band: 0, keyValue: 0.03 },
      { candidate: "clawmem://test/b.md", displayPath: "test/b.md", band: 0, keyValue: 0.02 },
    ];
    expect(auditTrace(t).enforcedViolations.filter(v => v.id === "single-ranking-key")).toHaveLength(0);
  });

  it("flags a band-1 (discounted-only) doc injected above a band-0 (current-anchored) doc", () => {
    const t = injectedTrace();
    t.candidates.push({ leg: "expansion-vec", variantQuery: "v", filepath: "clawmem://test/e.md", displayPath: "test/e.md", source: "vec", rawScore: 0.3, rank: 0, pooled: true });
    t.composite.push({ filepath: "clawmem://test/e.md", displayPath: "test/e.md", searchScore: 0.3, compositeScore: 0.6 });
    t.admission!.admitted.push({ candidate: "clawmem://test/e.md", displayPath: "test/e.md", compositeScore: 0.6 });
    t.injection!.entries = [
      { candidate: "clawmem://test/e.md", displayPath: "test/e.md", tier: "COLD", tokens: 10 },
      { candidate: "clawmem://test/a.md", displayPath: "test/a.md", tier: "WARM", tokens: 40 },
    ];
    t.finalPaths = ["test/e.md", "test/a.md"];
    // The discounted-only doc out-massed the current one but must still order below.
    t.finalOrder = [
      { candidate: "clawmem://test/e.md", displayPath: "test/e.md", band: 1, keyValue: 0.08 },
      { candidate: "clawmem://test/a.md", displayPath: "test/a.md", band: 0, keyValue: 0.02 },
    ];
    expect(auditTrace(t).enforcedViolations.some(v => v.id === "single-ranking-key" && v.violations.some(m => m.includes("must order below current-anchored")))).toBe(true);
    // The compliant order (band 0 first) passes even though its mass is smaller.
    t.finalPaths = ["test/a.md", "test/e.md"];
    t.injection!.entries = [
      { candidate: "clawmem://test/a.md", displayPath: "test/a.md", tier: "WARM", tokens: 40 },
      { candidate: "clawmem://test/e.md", displayPath: "test/e.md", tier: "COLD", tokens: 10 },
    ];
    t.finalOrder = [
      { candidate: "clawmem://test/a.md", displayPath: "test/a.md", band: 0, keyValue: 0.02 },
      { candidate: "clawmem://test/e.md", displayPath: "test/e.md", band: 1, keyValue: 0.08 },
    ];
    // (fusion record marks e.md gate-passed so the BUILD-1 leak guard accepts it)
    t.fusion = {
      lanes: [], gateTokenSource: "current", currentMass: 0.2, discountedMass: 0.05, preCapDiscountedMass: 0.05,
      capApplied: false, capFactor: null, poolBound: 15, protectedSlots: 0, admittedCurrentSupported: 1,
      candidates: [{
        filepath: "clawmem://test/e.md", displayPath: "test/e.md", vault: "general",
        lanes: ["expansion-vec"], contribution: 0.08,
        laneContributions: [{ lane: "expansion-vec", contribution: 0.08 }],
        currentSupported: false, currentQueryGatePassed: true, admitted: true,
      }],
    };
    expect(auditTrace(t).enforcedViolations.filter(v => v.id === "single-ranking-key")).toHaveLength(0);
  });

  it("is not evaluable on an empty outcome (the ordering step never ran)", () => {
    const t = newSurfacingTrace();
    t.outcome = "empty";
    t.emptyReason = "no-results";
    expect(auditTrace(t).notEvaluable).toContain("single-ranking-key");
  });
});

describe("metadata-band-only (ENFORCED since BUILD-5 — the zero-width band)", () => {
  it("passes when equal-key neighbors follow the candidateKey lexicographic tie-break", () => {
    const t = injectedTrace();
    t.finalOrder = [
      { candidate: "clawmem://test/a.md", displayPath: "test/a.md", band: 0, keyValue: 0.02 },
      { candidate: "clawmem://test/b.md", displayPath: "test/b.md", band: 0, keyValue: 0.02 },
      { candidate: "clawmem://test/c.md", displayPath: "test/c.md", band: 0, keyValue: 0.01 },
    ];
    const audit = auditTrace(t);
    expect(audit.notEvaluable).not.toContain("metadata-band-only");
    expect(audit.enforcedViolations.filter(v => v.id === "metadata-band-only").flatMap(v => v.violations)).toHaveLength(0);
  });

  it("flags equal-key neighbors OUT of tie order — the one place metadata could still hide", () => {
    const t = injectedTrace();
    t.finalOrder = [
      { candidate: "clawmem://test/b.md", displayPath: "test/b.md", band: 0, keyValue: 0.02 },
      { candidate: "clawmem://test/a.md", displayPath: "test/a.md", band: 0, keyValue: 0.02 },
    ];
    const audit = auditTrace(t);
    expect(audit.enforcedViolations.some(v => v.id === "metadata-band-only" && v.violations.some(m => m.includes("out of deterministic tie order")))).toBe(true);
  });

  it("not evaluable without a finalOrder (empty outcomes, pre-BUILD-2 traces)", () => {
    const t = injectedTrace();
    t.finalOrder = null;
    expect(auditTrace(t).notEvaluable).toContain("metadata-band-only");
  });
});

describe("finalization-fits-reserve (BUILD-3a, observed)", () => {
  const { HOOK_INVARIANTS } = require("../../src/eval/hook-invariants.ts");
  const { FINALIZATION_RESERVE_MS } = require("../../src/hooks/context-surfacing.ts");
  const { newSurfacingTrace } = require("../../src/eval/hook-trace.ts");
  const inv = HOOK_INVARIANTS.find((i: { id: string }) => i.id === "finalization-fits-reserve")!;

  it("is registered OBSERVED, never enforced (a host timing property)", () => {
    expect(inv).toBeDefined();
    expect(inv.enforced).toBe(false);
  });

  it("not evaluable when the deep escalation never ran (finalizationMs null)", () => {
    const t = newSurfacingTrace();
    const r = inv.check(t);
    expect(r.evaluable).toBe(false);
  });

  it("finalization within the reserve is clean; over the reserve is an observed violation naming both numbers", () => {
    const t = newSurfacingTrace();
    t.timings.finalizationMs = FINALIZATION_RESERVE_MS - 50;
    expect(inv.check(t).violations).toEqual([]);
    t.timings.finalizationMs = FINALIZATION_RESERVE_MS + 150;
    const r = inv.check(t);
    expect(r.evaluable).toBe(true);
    expect(r.violations.length).toBe(1);
    expect(r.violations[0]).toContain(`${FINALIZATION_RESERVE_MS + 150}ms`);
    expect(r.violations[0]).toContain(`${FINALIZATION_RESERVE_MS}ms`);
  });
});

describe("summarizeFinalization — the machine-decisive reserve criterion (BUILD-3a, codex turn-23 F5)", () => {
  const { summarizeFinalization } = require("../../src/eval/hook-run.ts");
  const { FINALIZATION_RESERVE_MS } = require("../../src/hooks/context-surfacing.ts");

  it("no escalated reps ⇒ fits null (not evidence either way; the gate must not fail on it)", () => {
    const s = summarizeFinalization([]);
    expect(s).toEqual({ samples: 0, max_ms: null, p95_ms: null, reserve_ms: FINALIZATION_RESERVE_MS, fits: null });
  });

  it("all samples within the reserve ⇒ fits true; decision basis is MAX", () => {
    const s = summarizeFinalization([50, FINALIZATION_RESERVE_MS, 120]);
    expect(s.fits).toBe(true);
    expect(s.max_ms).toBe(FINALIZATION_RESERVE_MS);
    expect(s.samples).toBe(3);
  });

  it("a SINGLE over-reserve rep anywhere in the run ⇒ fits false (rep-0-only measurement could not see this)", () => {
    const s = summarizeFinalization([50, 80, FINALIZATION_RESERVE_MS + 1]);
    expect(s.fits).toBe(false);
    expect(s.max_ms).toBe(FINALIZATION_RESERVE_MS + 1);
    expect(s.p95_ms).toBe(FINALIZATION_RESERVE_MS + 1);
  });
});

describe("summarizeVectorDeadline — MAX overshoot per vector invocation vs its OWN deadline (codex t81 P1+P2)", () => {
  const { summarizeVectorDeadline, VECTOR_DEADLINE_TOLERANCE_MS } = require("../../src/eval/hook-run.ts");

  it("no vector invocation ⇒ adhered null (no evidence; must not fail the authority gate)", () => {
    expect(summarizeVectorDeadline([])).toEqual({ samples: 0, max_over_ms: null, worst: null, tolerance_ms: VECTOR_DEADLINE_TOLERANCE_MS, adhered: null });
  });

  it("every invocation within its deadline+tol ⇒ adhered true; worst overshoot is the MAX (a negative = finished early)", () => {
    const s = summarizeVectorDeadline([
      { leg: "primary", over_ms: -400, budget_ms: 900, case: "a", rep: 0 },
      { leg: "deep", over_ms: 120, budget_ms: 2000, case: "a", rep: 0 },
      { leg: "prior", over_ms: -50, budget_ms: 400, case: "b", rep: 1 },
    ]);
    expect(s.adhered).toBe(true);
    expect(s.max_over_ms).toBe(120);
    expect(s.worst).toEqual({ leg: "deep", case: "a", rep: 0, budget_ms: 2000 });
  });

  it("a SINGLE late invocation anywhere ⇒ adhered false, and worst names its leg/case/rep/budget (a lower median would have drowned it — the t81 pooling bug)", () => {
    const s = summarizeVectorDeadline([
      // many fast primary reps of other cases...
      { leg: "primary", over_ms: -300, budget_ms: 900, case: "a", rep: 0 },
      { leg: "primary", over_ms: -320, budget_ms: 900, case: "b", rep: 0 },
      { leg: "primary", over_ms: -310, budget_ms: 900, case: "c", rep: 0 },
      // ...and ONE persistently late deep leg on case d.
      { leg: "deep", over_ms: 2100, budget_ms: 2000, case: "d", rep: 2 },
    ]);
    expect(s.adhered).toBe(false);                 // MAX = 2100 > tol; a global lower median would be negative and PASS
    expect(s.max_over_ms).toBe(2100);
    expect(s.worst).toEqual({ leg: "deep", case: "d", rep: 2, budget_ms: 2000 });
  });

  it("exactly at tolerance adheres; one ms over does not — a per-invocation safety bound", () => {
    expect(summarizeVectorDeadline([{ leg: "primary", over_ms: VECTOR_DEADLINE_TOLERANCE_MS, budget_ms: 900, case: "a", rep: 0 }]).adhered).toBe(true);
    expect(summarizeVectorDeadline([{ leg: "primary", over_ms: VECTOR_DEADLINE_TOLERANCE_MS + 1, budget_ms: 900, case: "a", rep: 0 }]).adhered).toBe(false);
  });

  it("each invocation is judged against its OWN budget (over_ms is already end − that leg's deadline), so mixed budgets never cross-attribute", () => {
    // deep 2000ms budget finished 100ms late; balanced 900ms budget finished early — the deep breach is not masked by the balanced budget.
    const s = summarizeVectorDeadline([
      { leg: "deep", over_ms: 300, budget_ms: 2000, case: "a", rep: 0 },
      { leg: "primary", over_ms: -10, budget_ms: 900, case: "a", rep: 0 },
    ]);
    expect(s.worst!.budget_ms).toBe(2000);         // the OFFENDING leg's own budget, never a run-wide max
    expect(s.adhered).toBe(false);
  });
});

describe("summarizeFinalizationBreakdown — WHERE the reserve is spent (BUILD-3d.4, codex turn-47 F2 / turn-48 F2)", () => {
  const { summarizeFinalizationBreakdown } = require("../../src/eval/hook-run.ts");

  it("no reps ⇒ null (nothing to attribute)", () => {
    expect(summarizeFinalizationBreakdown([])).toBeNull();
  });

  it("aggregates max/mean per substage across reps and exposes the true largest (the gate-reason input)", () => {
    const breakdown = summarizeFinalizationBreakdown([
      { filters: 10, enrich: 60, inject: 40, facts: 8, tail: 0 },
      { filters: 20, enrich: 80, inject: 2780, facts: 12, tail: 0 }, // rep with an inject stall
      { filters: 15, enrich: 70, inject: 50, facts: 10, tail: 0 },
    ]);
    expect(breakdown).not.toBeNull();
    // inject carries the stall: max 2780, mean round((40+2780+50)/3)=957
    expect(breakdown.inject).toEqual({ max_ms: 2780, mean_ms: 957 });
    expect(breakdown.enrich).toEqual({ max_ms: 80, mean_ms: 70 });
    // the largest-by-max substage is inject — what the reserve-violation reason names
    const largest = Object.entries(breakdown).sort((a: any, b: any) => b[1].max_ms - a[1].max_ms)[0]!;
    expect(largest[0]).toBe("inject");
  });

  it("a substage present in only some reps aggregates from those reps alone (early empty returns set fewer stamps)", () => {
    const breakdown = summarizeFinalizationBreakdown([
      { filters: 10, tail: 5 },                 // early return: never reached enrich..facts
      { filters: 12, enrich: 40, inject: 30, facts: 6, tail: 0 },
    ]);
    expect(breakdown.filters).toEqual({ max_ms: 12, mean_ms: 11 }); // both reps
    expect(breakdown.enrich).toEqual({ max_ms: 40, mean_ms: 40 });  // only the second rep
  });

  it("drops non-finite samples rather than poisoning the mean", () => {
    const breakdown = summarizeFinalizationBreakdown([
      { inject: 40 },
      { inject: NaN as unknown as number },
      { inject: 60 },
    ]);
    expect(breakdown.inject).toEqual({ max_ms: 60, mean_ms: 50 });
  });
});

describe("summarizeBudgetElapsed — total handler elapsed vs the internal budget (codex turn-24 F4)", () => {
  const { summarizeBudgetElapsed, BUDGET_ELAPSED_TOLERANCE_MS } = require("../../src/eval/hook-run.ts");
  const { HOOK_BUDGET_MS } = require("../../src/hooks/context-surfacing.ts");

  it("no reps ⇒ within null", () => {
    const s = summarizeBudgetElapsed([]);
    expect(s.within).toBeNull();
    expect(s.max_ms).toBeNull();
  });

  it("max within budget + tolerance ⇒ within true", () => {
    const s = summarizeBudgetElapsed([100, HOOK_BUDGET_MS + BUDGET_ELAPSED_TOLERANCE_MS]);
    expect(s.within).toBe(true);
  });

  it("a single rep past budget + tolerance ⇒ within false", () => {
    const s = summarizeBudgetElapsed([100, HOOK_BUDGET_MS + BUDGET_ELAPSED_TOLERANCE_MS + 1]);
    expect(s.within).toBe(false);
    expect(s.max_ms).toBe(HOOK_BUDGET_MS + BUDGET_ELAPSED_TOLERANCE_MS + 1);
  });
});

// ---------------------------------------------------------------------------
// BUILD-3b — transmitted-text manifest (the draw binding's content identity)
// ---------------------------------------------------------------------------
describe("transmittedTextManifest (BUILD-3b)", () => {
  const { transmittedTextManifest } = require("../../src/eval/hook-run.ts");
  const h = (n: string) => n.repeat(64).slice(0, 64);

  it("identifies the SET of transmitted texts — order and multiplicity are not identity", () => {
    const a = transmittedTextManifest([h("a"), h("b")]);
    expect(transmittedTextManifest([h("b"), h("a")])).toBe(a);       // order
    expect(transmittedTextManifest([h("a"), h("b"), h("a")])).toBe(a); // multiplicity
  });

  it("a different text set is a different manifest", () => {
    expect(transmittedTextManifest([h("a")])).not.toBe(transmittedTextManifest([h("c")]));
    expect(transmittedTextManifest([h("a")])).not.toBe(transmittedTextManifest([h("a"), h("b")]));
  });

  it("a run that transmitted nothing has the deterministic empty-set manifest (two such arms match)", () => {
    expect(transmittedTextManifest([])).toBe(transmittedTextManifest([]));
    expect(transmittedTextManifest([])).toMatch(/^[0-9a-f]{64}$/);
  });
});

// ---------------------------------------------------------------------------
// BUILD-3c — restricting a baseline slice to the valid-pair id set
// ---------------------------------------------------------------------------
describe("restrictBaselineSlice (BUILD-3c)", () => {
  const { restrictBaselineSlice, HookEvalIntegrityError } = require("../../src/eval/hook-run.ts");

  const caseOf = (id: string, split: string, ndcg: number | null) => ({
    id, split, tags: [], profile: "speed",
    metrics: {
      ndcg, mustNotRate: 0, mustNotCount: 0, mustIncludeRecall: ndcg === null ? null : ndcg,
      abstentionCorrect: null, falseAbstain: 0, priorLegOk: null,
      injectedCount: 1, elapsedMs: 12, timedOut: false,
    },
    injectedPaths: [], outcome: "injected", emptyReason: null,
    invariants: { enforcedViolations: [], observedViolations: [] }, warnings: [],
  });
  const report = (cases: unknown[]) => ({ run_id: "base-1", cases } as never);

  it("aggregates ONLY the valid ids on the requested split", () => {
    const r = report([caseOf("a", "holdout", 1), caseOf("b", "holdout", 0), caseOf("c", "tuning", 1)]);
    const agg = restrictBaselineSlice(r, new Set(["a", "c"]), "holdout");
    expect(agg.cases).toBe(1);
    expect(agg.ndcgMean).toBeCloseTo(1, 10); // b excluded; c is another split
  });

  it("a slice with no valid cases yields undefined (acceptance then reports it missing, failing closed)", () => {
    // Every valid id lives on the other split — the holdout restriction is
    // legitimately empty, which acceptance must treat as no slice at all.
    const r = report([caseOf("a", "tuning", 1), caseOf("b", "holdout", 0)]);
    expect(restrictBaselineSlice(r, new Set(["a"]), "holdout")).toBeUndefined();
  });

  it("a valid-pair id the baseline does not carry at all is an integrity failure (corrupt partner dir)", () => {
    const r = report([caseOf("a", "holdout", 1)]);
    expect(() => restrictBaselineSlice(r, new Set(["a", "ghost"]), "holdout")).toThrow(/does not carry 1 case\(s\).*ghost/s);
    // A valid id living on ANOTHER split is not missing — it is simply not in this slice.
    const r2 = report([caseOf("a", "holdout", 1), caseOf("t", "tuning", 0)]);
    expect(restrictBaselineSlice(r2, new Set(["a", "t"]), "holdout").cases).toBe(1);
  });

  it("an ABSENT nullable metric is refused — a missing measurement is not a null one (codex turn-29 F2)", () => {
    const c = caseOf("a", "holdout", 1) as Record<string, any>;
    delete c.metrics.ndcg;
    expect(() => restrictBaselineSlice(report([c]), new Set(["a"]), "holdout")).toThrow(/missing metric ndcg/);
  });

  it("counts must be finite non-negative integers — a missing count would recompute damage as clean (codex turn-29 F2)", () => {
    for (const field of ["mustNotCount", "injectedCount"]) {
      const missing = caseOf("a", "holdout", 1) as Record<string, any>;
      delete missing.metrics[field];
      expect(() => restrictBaselineSlice(report([missing]), new Set(["a"]), "holdout"))
        .toThrow(new RegExp(`${field} is not a finite non-negative integer`));
      const negative = caseOf("a", "holdout", 1) as Record<string, any>;
      negative.metrics[field] = -1;
      expect(() => restrictBaselineSlice(report([negative]), new Set(["a"]), "holdout"))
        .toThrow(new RegExp(`${field} is not a finite non-negative integer`));
      const fractional = caseOf("a", "holdout", 1) as Record<string, any>;
      fractional.metrics[field] = 1.5;
      expect(() => restrictBaselineSlice(report([fractional]), new Set(["a"]), "holdout"))
        .toThrow(new RegExp(`${field} is not a finite non-negative integer`));
    }
  });

  it("a malformed per-case metric block is an integrity failure, never a silently smaller mean", () => {
    const broken = caseOf("a", "holdout", 1) as Record<string, any>;
    broken.metrics.ndcg = "1.0"; // a string would coerce inside the mean
    expect(() => restrictBaselineSlice(report([broken]), new Set(["a"]), "holdout")).toThrow(/is not a finite number or null/);

    const noMetrics = caseOf("b", "holdout", 1) as Record<string, any>;
    delete noMetrics.metrics;
    expect(() => restrictBaselineSlice(report([noMetrics]), new Set(["b"]), "holdout")).toThrow(/has no metrics block/);

    const badElapsed = caseOf("c", "holdout", 1) as Record<string, any>;
    badElapsed.metrics.elapsedMs = null;
    expect(() => restrictBaselineSlice(report([badElapsed]), new Set(["c"]), "holdout")).toThrow(/elapsedMs is not a finite non-negative number/);
  });
});

// ---------------------------------------------------------------------------
// Codex turn-29 finding 1 — retries must not erase invariant violations
// ---------------------------------------------------------------------------
describe("attempt-level invariant accounting (codex turn-29 F1)", () => {
  const { countAttemptViolations, supersededAttemptEvidence } = require("../../src/eval/hook-run.ts");
  const audit = (enforced: string[][], observed: string[][] = []) => ({
    enforcedViolations: enforced.map((violations, i) => ({ id: `enf-${i}`, violations })),
    observedViolations: observed.map((violations, i) => ({ id: `obs-${i}`, violations })),
  });

  it("counts EVERY attempt, not just the surviving one", () => {
    // Attempt 0 violated twice; the retry came out clean. The trust gate must
    // still see 2 — the harness produced an invalid trace, and a lucky retry
    // does not undo that.
    const audits = [audit([["a", "b"]]), audit([])];
    expect(countAttemptViolations(audits, "enforcedViolations")).toBe(2);
    // Counting only the survivor (the pre-fix behavior) would report 0.
    expect(countAttemptViolations([audits[1]], "enforcedViolations")).toBe(0);
  });

  it("counts observed violations across attempts too", () => {
    expect(countAttemptViolations([audit([], [["x"]]), audit([], [["y", "z"]])], "observedViolations")).toBe(3);
  });

  it("a single clean attempt yields no evidence and no counts", () => {
    expect(countAttemptViolations([audit([])], "enforcedViolations")).toBe(0);
    expect(supersededAttemptEvidence([audit([])])).toEqual([]);
  });

  it("preserves the SUPERSEDED attempts' violations as bounded evidence (their traces were replaced)", () => {
    const ev = supersededAttemptEvidence([audit([["boom"]]), audit([])]);
    expect(ev.length).toBe(1);
    expect(ev[0].attempt).toBe(0);
    expect(ev[0].enforcedViolations[0].violations).toEqual(["boom"]);
  });

  it("keeps only attempts that actually violated, and bounds each list", () => {
    const many = Array.from({ length: 9 }, (_, i) => `v${i}`);
    const ev = supersededAttemptEvidence([audit([]), audit([many]), audit([])]);
    expect(ev.map((e: { attempt: number }) => e.attempt)).toEqual([1]); // the clean attempt 0 is not evidence
    expect(ev[0].enforcedViolations[0].violations.length).toBe(5); // bounded
  });
});

// ---------------------------------------------------------------------------
// Codex turn-30 — treatment exposure + exact metric semantics
// ---------------------------------------------------------------------------
describe("treatmentExposed — PRE-treatment only (codex turn-30 SPEC-2, corrected turn-31 SPEC-3)", () => {
  const { treatmentExposed } = require("../../src/eval/hook-run.ts");
  const sent2 = ["a", "b"];

  it("requires the rerank lane to have ANSWERED completely", () => {
    expect(treatmentExposed({ rerank: { coverageComplete: true, sentPaths: sent2 } })).toBe(true);
    // Both arms timing out before rerank is a valid PAIR in which the policy never ran.
    expect(treatmentExposed({ rerank: { coverageComplete: false, sentPaths: sent2 } })).toBe(false);
    expect(treatmentExposed({ rerank: null })).toBe(false);
    expect(treatmentExposed({})).toBe(false);
  });

  it("requires at least two candidates to have been SENT — a single-candidate request orders the same under every weight", () => {
    expect(treatmentExposed({ rerank: { coverageComplete: true, sentPaths: ["a"] } })).toBe(false);
    expect(treatmentExposed({ rerank: { coverageComplete: true, sentPaths: [] } })).toBe(false);
  });

  it("is DIRECTION-INDEPENDENT: finalOrder is downstream of the treatment and must not decide exposure", () => {
    // The w=0 arm can drop an unarbitrated candidate and finish with one
    // output while the w=1.5 arm keeps two. Same pair, same request — the
    // exposure verdict must not depend on which arm asks.
    const w0 = { rerank: { coverageComplete: true, sentPaths: sent2 }, finalOrder: [{ candidate: "a" }] };
    const w15 = { rerank: { coverageComplete: true, sentPaths: sent2 }, finalOrder: [{ candidate: "a" }, { candidate: "b" }] };
    expect(treatmentExposed(w0)).toBe(treatmentExposed(w15));
    expect(treatmentExposed(w0)).toBe(true);
  });

  it("an absent trace is not exposure", () => {
    expect(treatmentExposed(undefined)).toBe(false);
  });

  // BUILD-4 (codex turn-52 finding 2): an admission_policy experiment is
  // NOT gated on rerank coverage — the policy operates on every case,
  // including balanced/speed cases where the rerank lane never runs.
  it("admission_policy exposure: a balanced case with no rerank but a nonempty admission-input LEDGER IS exposed (t53-F3)", () => {
    const t = { rerank: null, admissionInput: { candidates: ["a", "b", "c"] } };
    expect(treatmentExposed(t, ["admission_policy"])).toBe(true);
    // ...while the SAME trace under a rerank-lane treatment is not.
    expect(treatmentExposed(t, ["rerank_lane_weight"])).toBe(false);
    // And with no registered treatment the base predicate governs (unchanged).
    expect(treatmentExposed(t)).toBe(false);
  });

  it("admission_policy exposure: nothing reached the policy branch → not exposed; the treatment-downstream admitted/rejected split NEVER decides (t53-F3)", () => {
    expect(treatmentExposed({ rerank: null, admissionInput: { candidates: [] } }, ["admission_policy"])).toBe(false);
    expect(treatmentExposed({ rerank: null, admissionInput: null }, ["admission_policy"])).toBe(false);
    expect(treatmentExposed({ rerank: null }, ["admission_policy"])).toBe(false);
    // Fail-closed: a pre-turn-54 trace carrying only the split is NOT
    // exposure — the split is produced by the selected policy arm, so
    // reading it would make exposure depend on which arm is inspected.
    expect(treatmentExposed({ rerank: null, admission: { admitted: [{}], rejected: [{}, {}] } }, ["admission_policy"])).toBe(false);
  });

  it("confounded two-factor registration requires BOTH predicates", () => {
    const gateFiredWithAdmission = {
      rerank: { coverageComplete: true, sentPaths: sent2, degeneracy: { degenerate: true } },
      admissionInput: { candidates: ["a"] },
    };
    const gateNotFired = {
      rerank: { coverageComplete: true, sentPaths: sent2, degeneracy: { degenerate: false } },
      admissionInput: { candidates: ["a"] },
    };
    expect(treatmentExposed(gateFiredWithAdmission, ["degeneracy_gate", "admission_policy"])).toBe(true);
    expect(treatmentExposed(gateNotFired, ["degeneracy_gate", "admission_policy"])).toBe(false);
  });
});

describe("baseExposed — the pre-treatment REACH predicate of the registered treatment family (ship-draw aggregate refusal 2026-08-26)", () => {
  const { baseExposed, treatmentExposed, PAIR_TREATMENTS } = require("../../src/eval/hook-run.ts");
  const sent2 = ["a", "b"];
  const balanced = { rerank: null, admissionInput: { candidates: ["a", "b", "c"] } };
  const unreached = { rerank: null, admissionInput: { candidates: [] } };
  const deepDegenerate = { rerank: { coverageComplete: true, sentPaths: sent2, degeneracy: { degenerate: true } }, admissionInput: { candidates: ["a"] } };
  const deepHealthy = { rerank: { coverageComplete: true, sentPaths: sent2, degeneracy: { degenerate: false } }, admissionInput: { candidates: ["a"] } };
  const deepNoLedger = { rerank: { coverageComplete: true, sentPaths: sent2 } };

  it("admission_policy: a balanced case that REACHED the policy is base-exposed with no rerank lane at all (every balanced/speed member row tripped the aggregate's treatment⇒base invariant before this)", () => {
    expect(baseExposed(balanced, ["admission_policy"])).toBe(true);
    expect(treatmentExposed(balanced, ["admission_policy"])).toBe(true);
    expect(baseExposed(unreached, ["admission_policy"])).toBe(false);
    expect(baseExposed({ rerank: null }, ["admission_policy"])).toBe(false);
  });

  it("no registered treatment (replicate audit): base = the rerank predicate, unchanged", () => {
    expect(baseExposed(balanced)).toBe(false);
    expect(baseExposed(balanced, [])).toBe(false);
    expect(baseExposed(deepNoLedger)).toBe(true);
    expect(baseExposed(deepNoLedger, [])).toBe(true);
    expect(baseExposed(undefined)).toBe(false);
  });

  it("degeneracy_gate: base is REACH (coverage + >=2 sent) without the firing condition; the treatment adds firing", () => {
    expect(baseExposed(deepHealthy, ["degeneracy_gate"])).toBe(true);
    expect(treatmentExposed(deepHealthy, ["degeneracy_gate"])).toBe(false);
    expect(baseExposed(deepDegenerate, ["degeneracy_gate"])).toBe(true);
    expect(treatmentExposed(deepDegenerate, ["degeneracy_gate"])).toBe(true);
    // A confounded registration requires EVERY family's reach for base.
    expect(baseExposed(deepNoLedger, ["degeneracy_gate", "admission_policy"])).toBe(false);
    expect(baseExposed(deepHealthy, ["degeneracy_gate", "admission_policy"])).toBe(true);
  });

  it("treatmentExposed ⇒ baseExposed for every trace × every registered subset — the implication chain the aggregate re-derives (codex turn-45 F2)", () => {
    const traces = [balanced, unreached, deepDegenerate, deepHealthy, deepNoLedger, { rerank: null }, {}, undefined];
    const all = PAIR_TREATMENTS as string[];
    const subsets: string[][] = [];
    for (let m = 0; m < (1 << all.length); m++) subsets.push(all.filter((_, i) => m & (1 << i)));
    let treatmentHits = 0;
    for (const t of traces) {
      for (const sub of subsets) {
        if (treatmentExposed(t, sub)) { treatmentHits++; expect(baseExposed(t, sub)).toBe(true); }
        if (!baseExposed(t, sub)) expect(treatmentExposed(t, sub)).toBe(false);
      }
      if (treatmentExposed(t)) expect(baseExposed(t)).toBe(true);
    }
    expect(treatmentHits).toBeGreaterThan(0);
  });
});

describe("restrictBaselineSlice — exact metric semantics (codex turn-30 F4)", () => {
  const { restrictBaselineSlice } = require("../../src/eval/hook-run.ts");
  const caseOf = (id: string, split: string, over: Record<string, unknown> = {}) => ({
    id, split, tags: [], profile: "speed",
    metrics: {
      ndcg: 1, mustNotRate: 0, mustNotCount: 0, mustIncludeRecall: 1,
      abstentionCorrect: null, falseAbstain: 0, priorLegOk: null,
      injectedCount: 1, elapsedMs: 12, timedOut: false, ...over,
    },
    injectedPaths: [], outcome: "injected", emptyReason: null,
    invariants: { enforcedViolations: [], observedViolations: [] }, warnings: [],
  });
  const report = (cases: unknown[]) => ({ run_id: "base-1", cases } as never);
  const restrict = (over: Record<string, unknown>) =>
    () => restrictBaselineSlice(report([caseOf("a", "holdout", over)]), new Set(["a"]), "holdout");

  it("a binary outcome outside {0,1,null} is corrupt, not merely odd", () => {
    expect(restrict({ abstentionCorrect: 20 })).toThrow(/abstentionCorrect is 20 — a binary outcome must be 0, 1, or null/);
    expect(restrict({ priorLegOk: -1 })).toThrow(/priorLegOk is -1 — a binary outcome/);
    expect(restrict({ falseAbstain: 0.5 })).toThrow(/falseAbstain is 0.5 — a binary outcome/);
    expect(restrict({ abstentionCorrect: 1 })).not.toThrow();
  });

  it("a rate outside [0,1] is refused", () => {
    expect(restrict({ ndcg: 3 })).toThrow(/ndcg is 3 — a rate must fall in \[0,1\] or be null/);
    expect(restrict({ mustNotRate: -0.1 })).toThrow(/mustNotRate is -0.1 — a rate/);
    expect(restrict({ mustIncludeRecall: 1 })).not.toThrow();
  });

  it("elapsedMs must be non-negative", () => {
    expect(restrict({ elapsedMs: -1 })).toThrow(/elapsedMs is not a finite non-negative number/);
  });

  it("duplicate case ids are refused before re-aggregation (they would weight one case twice)", () => {
    const dup = report([caseOf("a", "holdout"), caseOf("a", "holdout")]);
    expect(() => restrictBaselineSlice(dup, new Set(["a"]), "holdout")).toThrow(/duplicate case id\(s\): a/);
  });
});

describe("degeneracy-gate-honored (enforced — BUILD-3d)", () => {
  const degenTrace = (over: Partial<NonNullable<NonNullable<SurfacingTrace["rerank"]>["degeneracy"]>>, orderingApplied: boolean): SurfacingTrace => {
    const t = injectedTrace();
    t.rerank = {
      attempted: true, failed: false,
      sentPaths: ["clawmem://test/a.md", "clawmem://test/b.md"],
      coveredPaths: ["clawmem://test/a.md", "clawmem://test/b.md"],
      scores: [{ filepath: "clawmem://test/a.md", score: 0.5 }, { filepath: "clawmem://test/b.md", score: 0.5 }],
      coverageComplete: true,
      orderingApplied,
      degeneracy: {
        gated: true, degenerate: true, reason: "inert", maxScore: 0.5, spread: 0,
        thresholds: { calibFloor: 0.05, spreadFloor: 0.05 },
        ...over,
      },
    };
    if (orderingApplied) t.rankingKey = "rerank";
    return t;
  };

  it("flags a degenerate set applied to ordering while the gate is ARMED — the gate's teeth", () => {
    const audit = auditTrace(degenTrace({}, true));
    expect(audit.enforcedViolations.some(v => v.id === "degeneracy-gate-honored" && v.violations.some(m => m.includes("inert")))).toBe(true);
  });

  it("passes when the armed gate discarded the lane (orderingApplied false)", () => {
    const audit = auditTrace(degenTrace({}, false));
    expect(audit.enforcedViolations.filter(v => v.id === "degeneracy-gate-honored")).toHaveLength(0);
    expect(audit.notEvaluable).not.toContain("degeneracy-gate-honored");
  });

  it("the UN-gated shadow assessment constrains nothing — a control arm applying a degenerate set is clean", () => {
    const audit = auditTrace(degenTrace({ gated: false }, true));
    expect(audit.enforcedViolations.filter(v => v.id === "degeneracy-gate-honored")).toHaveLength(0);
    expect(audit.notEvaluable).not.toContain("degeneracy-gate-honored");
  });

  it("a non-degenerate assessment with ordering applied is clean", () => {
    const audit = auditTrace(degenTrace({ degenerate: false, reason: null, maxScore: 0.9, spread: 0.4 }, true));
    expect(audit.enforcedViolations.filter(v => v.id === "degeneracy-gate-honored")).toHaveLength(0);
  });

  it("a trace with no assessment (pre-BUILD-3d, or coverage never reached) is NOT evaluable — never a silent pass or fail", () => {
    const t = injectedTrace();
    t.rerank = { attempted: true, failed: true, sentPaths: [], coveredPaths: [], scores: [], orderingApplied: false };
    const audit = auditTrace(t);
    expect(audit.notEvaluable).toContain("degeneracy-gate-honored");
  });
});

describe("treatmentExposed — treatment-AWARE exposure (codex turn-40 F4)", () => {
  const { treatmentExposed } = require("../../src/eval/hook-run.ts");
  const sent2 = ["a", "b"];
  const base = { rerank: { coverageComplete: true, sentPaths: sent2 } };
  const degen = { rerank: { coverageComplete: true, sentPaths: sent2, degeneracy: { degenerate: true } } };
  const healthy = { rerank: { coverageComplete: true, sentPaths: sent2, degeneracy: { degenerate: false } } };

  it("a degeneracy_gate experiment counts only assessment-FIRED cases as exposed — a never-degenerate case executed identically in both arms", () => {
    expect(treatmentExposed(degen, ["degeneracy_gate"])).toBe(true);
    expect(treatmentExposed(healthy, ["degeneracy_gate"])).toBe(false);
    // No assessment recorded (coverage never reached full on a pre-BUILD-3d trace shape) → not gate-exposed.
    expect(treatmentExposed(base, ["degeneracy_gate"])).toBe(false);
  });

  it("a rerank_lane_weight experiment (and the base/no-treatment form) keeps the coverage + >=2-sent predicate", () => {
    expect(treatmentExposed(base, ["rerank_lane_weight"])).toBe(true);
    expect(treatmentExposed(healthy, ["rerank_lane_weight"])).toBe(true);
    expect(treatmentExposed(base, [])).toBe(true);
    expect(treatmentExposed(base)).toBe(true);
  });

  it("the base predicate still gates first: no coverage or <2 sent is never exposed under ANY treatment", () => {
    expect(treatmentExposed({ rerank: { coverageComplete: false, sentPaths: sent2, degeneracy: { degenerate: true } } }, ["degeneracy_gate"])).toBe(false);
    expect(treatmentExposed({ rerank: { coverageComplete: true, sentPaths: ["a"], degeneracy: { degenerate: true } } }, ["degeneracy_gate"])).toBe(false);
  });

  it("exposure stays arm-symmetric for the gate treatment: the assessment is recorded in BOTH arms regardless of the toggle", () => {
    // gated true vs false is the toggle's state — the DEGENERATE verdict is
    // the score-derived part, identical across arms for identical scores.
    const armOn = { rerank: { coverageComplete: true, sentPaths: sent2, degeneracy: { gated: true, degenerate: true } } };
    const armOff = { rerank: { coverageComplete: true, sentPaths: sent2, degeneracy: { gated: false, degenerate: true } } };
    expect(treatmentExposed(armOn, ["degeneracy_gate"])).toBe(treatmentExposed(armOff, ["degeneracy_gate"]));
  });
});
