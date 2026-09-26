/**
 * Hook replay-eval — vault-qualified EVALUATOR boundary (codex turn-8
 * finding 2): `skill:` label resolution against the secondary snapshot,
 * qualified injected-path production, and the cross-vault displayPath
 * collision hard failure. The fusion-level identity tests live in
 * surfacing-fusion.test.ts; these lock the evaluator side.
 */
import { describe, it, expect } from "bun:test";
import { resolveHookLabels, type HookGoldExample } from "../../src/eval/hook-gold.ts";
import { qualifyInjectedPaths, HookEvalIntegrityError } from "../../src/eval/hook-run.ts";
import { newSurfacingTrace, type SurfacingTrace, type TraceFusionCandidate } from "../../src/eval/hook-trace.ts";
import { createTestStore, seedDocuments } from "../helpers/test-store.ts";

function goldExample(labels: Partial<HookGoldExample["labels"]>): HookGoldExample {
  return {
    id: "vb-1", prompt: "boundary prompt", priors: [], profile: "speed",
    expect_abstain: false, prior_leg: "harmless",
    labels: { must_include: [], acceptable: [], must_not_include: [], ...labels },
    split: "tuning", tags: [],
  } as HookGoldExample;
}

describe("resolveHookLabels — skill: label routing", () => {
  const general = createTestStore();
  seedDocuments(general, [
    { path: "m/general-doc.md", title: "general doc", body: "general vault content", contentType: "note", confidence: 0.9, qualityScore: 0.8 },
  ]);
  const skill = createTestStore();
  seedDocuments(skill, [
    { path: "m/skill-doc.md", title: "skill doc", body: "skill vault content", contentType: "note", confidence: 0.9, qualityScore: 0.8 },
  ]);

  it("a skill: label resolves against the SKILL snapshot, never the general one", () => {
    const [r] = resolveHookLabels(general, [goldExample({ must_include: ["skill:test/m/skill-doc.md"] })], skill);
    expect(r!.unresolved).toHaveLength(0);
  });

  it("a skill: label WITHOUT a skill snapshot is unresolved (fails the trust gate upstream)", () => {
    const [r] = resolveHookLabels(general, [goldExample({ must_include: ["skill:test/m/skill-doc.md"] })]);
    expect(r!.unresolved).toEqual(["must_include: skill:test/m/skill-doc.md"]);
  });

  it("a bare label never resolves through the skill snapshot", () => {
    // skill-doc exists only in the skill vault; addressing it bare must fail.
    const [r] = resolveHookLabels(general, [goldExample({ must_not_include: ["test/m/skill-doc.md"] })], skill);
    expect(r!.unresolved).toEqual(["must_not_include: test/m/skill-doc.md"]);
  });

  it("an unresolved skill: acceptable label is removed from scoring with a warning", () => {
    const [r] = resolveHookLabels(general, [goldExample({ acceptable: ["skill:test/m/missing.md"] })], skill);
    expect(r!.unresolved).toHaveLength(0);
    expect(r!.example.labels.acceptable).toHaveLength(0);
    expect(r!.warnings.join(" ")).toContain("skill:test/m/missing.md");
  });
});

describe("qualifyInjectedPaths — vault-qualified output identity", () => {
  function fusionCandidate(over: Partial<TraceFusionCandidate>): TraceFusionCandidate {
    return {
      filepath: "clawmem://test/m/doc.md", displayPath: "test/m/doc.md", vault: "general",
      lanes: ["vector"], contribution: 0.1, laneContributions: [{ lane: "vector", contribution: 0.1 }],
      currentSupported: true, currentQueryGatePassed: true, admitted: true,
      ...over,
    };
  }
  function traceWith(candidates: TraceFusionCandidate[], finalPaths: string[]): SurfacingTrace {
    const t = newSurfacingTrace();
    t.outcome = "injected";
    t.finalPaths = finalPaths;
    t.fusion = {
      lanes: [], candidates, gateTokenSource: "current", currentMass: 0.1, discountedMass: 0,
      preCapDiscountedMass: 0, capApplied: false, capFactor: null, poolBound: 15,
      protectedSlots: 0, admittedCurrentSupported: 1,
    };
    return t;
  }

  it("a skill-vault candidate's injected path scores as skill:<displayPath>", () => {
    const t = traceWith(
      [fusionCandidate({ filepath: "skill:clawmem://s/doc.md", displayPath: "s/doc.md", vault: "skill", lanes: ["secondary-vault"] })],
      ["s/doc.md"]
    );
    expect(qualifyInjectedPaths(t, "case-skill")).toEqual(["skill:s/doc.md"]);
  });

  it("a general-vault candidate stays bare", () => {
    const t = traceWith([fusionCandidate({})], ["test/m/doc.md"]);
    expect(qualifyInjectedPaths(t, "case-general")).toEqual(["test/m/doc.md"]);
  });

  it("the SAME displayPath carried by candidates in BOTH vaults hard-fails (ambiguous output identity)", () => {
    const t = traceWith(
      [
        fusionCandidate({ displayPath: "shared/doc.md", filepath: "clawmem://shared/doc.md" }),
        fusionCandidate({ displayPath: "shared/doc.md", filepath: "skill:clawmem://shared/doc.md", vault: "skill", lanes: ["secondary-vault"] }),
      ],
      ["shared/doc.md"]
    );
    expect(() => qualifyInjectedPaths(t, "case-collision")).toThrow(HookEvalIntegrityError);
  });

  it("a gated turn without a fusion record stays bare (general by construction)", () => {
    const t = newSurfacingTrace();
    t.outcome = "injected";
    t.finalPaths = ["test/m/doc.md"];
    expect(qualifyInjectedPaths(t, "case-no-fusion")).toEqual(["test/m/doc.md"]);
  });
});
