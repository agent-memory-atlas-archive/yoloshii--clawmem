/**
 * Surfacing candidate fusion — membership math (BUILD-1, C1/C1c).
 * Pure-function tests over synthetic lanes: mass cap, protected slots,
 * zero-current-mass edge, keep-best-score dedupe, and the expansion-only
 * failure guard.
 */
import { describe, it, expect } from "bun:test";
import type { SearchResult } from "../../src/store.ts";
import {
  selectCandidatePool,
  dropUnarbitrated,
  passesCurrentQueryGate,
  LANE_WEIGHTS,
  POOL_HEADROOM,
  type LaneList,
} from "../../src/hooks/surfacing-fusion.ts";
import { contentTokenSet } from "../../src/retrieval-gate.ts";

function sr(path: string, score: number): SearchResult {
  return {
    filepath: `clawmem://test/${path}`,
    displayPath: `test/${path}`,
    title: path,
    hash: `h-${path}`,
    docid: `d-${path}`,
    collectionName: "test",
    modifiedAt: "",
    bodyLength: 100,
    body: `body of ${path}`,
    context: "",
    score,
    source: "fts",
  } as unknown as SearchResult;
}

function lane(l: LaneList["lane"], paths: string[], variantQuery?: string): LaneList {
  return { lane: l, results: paths.map((p, i) => sr(p, 1 - i * 0.05)), ...(variantQuery ? { variantQuery } : {}) };
}

describe("selectCandidatePool — mass cap (C1c-i)", () => {
  it("with current signal present, post-cap discounted mass stays strictly below current mass", () => {
    // One current hit vs many expansion lists — uncapped, expansion mass would dwarf it.
    const lanes: LaneList[] = [
      lane("fts-fallback", ["current-doc.md"]),
      lane("expansion-lex", ["e1.md", "e2.md", "e3.md", "e4.md", "e5.md"], "v1"),
      lane("expansion-vec", ["e6.md", "e7.md", "e8.md", "e9.md", "e10.md"], "v2"),
      lane("expansion-lex", ["e11.md", "e12.md", "e13.md", "e14.md", "e15.md"], "v3"),
    ];
    const { fusion } = selectCandidatePool(lanes, 10, false);
    expect(fusion.preCapDiscountedMass).toBeGreaterThan(fusion.currentMass); // the raw imbalance
    expect(fusion.capApplied).toBe(true);
    expect(fusion.discountedMass).toBeLessThan(fusion.currentMass);          // the enforced cap
  });

  it("no cap when discounted lanes stay under the current mass", () => {
    const lanes: LaneList[] = [
      lane("vector", ["a.md", "b.md", "c.md"]),
      lane("fts-supplement", ["d.md", "e.md"]),
      lane("expansion-lex", ["x.md"], "v"),
    ];
    const { fusion } = selectCandidatePool(lanes, 10, false);
    expect(fusion.capApplied).toBe(false);
    expect(fusion.discountedMass).toBeLessThan(fusion.currentMass);
  });

  it("zero current mass: certified prior lanes pass, expansion is zeroed", () => {
    const lanes: LaneList[] = [
      lane("prior-fts", ["p1.md", "p2.md"], "prior text"),
      lane("expansion-lex", ["x.md"], "v"),
    ];
    const certified = selectCandidatePool(lanes, 10, true);
    expect(certified.pool.map(r => r.displayPath)).toEqual(["test/p1.md", "test/p2.md"]);
    expect(certified.pool.find(r => r.displayPath === "test/x.md")).toBeUndefined();

    const uncertified = selectCandidatePool(lanes, 10, false);
    expect(uncertified.pool).toHaveLength(0); // no certification → no discounted survivors
  });
});

describe("selectCandidatePool — protected slots (C1c-ii)", () => {
  it("current-supported candidates cannot be crowded out of the reserved capacity", () => {
    const maxResults = 3;
    const poolBound = maxResults + POOL_HEADROOM; // 8
    // 20 prior candidates (certified) vs 6 current candidates whose fused
    // contributions are LOWER per-candidate — without the reserve, priors
    // would take every slot.
    const priorPaths = Array.from({ length: 20 }, (_, i) => `p${i}.md`);
    const lanes: LaneList[] = [
      { lane: "prior-fts", results: priorPaths.map((p, i) => sr(p, 1 - i * 0.01)), variantQuery: "prior" },
      lane("fts-fallback", ["c1.md", "c2.md", "c3.md", "c4.md", "c5.md", "c6.md"]),
    ];
    const { pool, fusion } = selectCandidatePool(lanes, maxResults, true);
    expect(pool.length).toBeLessThanOrEqual(poolBound);
    expect(fusion.admittedCurrentSupported).toBeGreaterThanOrEqual(fusion.protectedSlots);
    const currentAdmitted = pool.filter(r => r.displayPath.startsWith("test/c")).length;
    expect(currentAdmitted).toBe(fusion.admittedCurrentSupported);
  });

  it("reserve never exceeds the available current-supported candidates", () => {
    const lanes: LaneList[] = [lane("fts-fallback", ["only.md"])];
    const { fusion } = selectCandidatePool(lanes, 10, false);
    expect(fusion.protectedSlots).toBe(1); // min(ceil(15*0.6)=9, available=1)
    expect(fusion.admittedCurrentSupported).toBe(1);
  });
});

describe("selectCandidatePool — dedupe + provenance", () => {
  it("payload pick is deterministic by lane order — never a cross-channel score compare", () => {
    // Same doc in a vector lane (cosine 0.40) and an FTS lane (BM25 transform
    // 0.95): the numerically larger FTS score must NOT win the payload — the
    // first occurrence in lane order (vector, a current leg) does.
    const vecHit = sr("dup.md", 0.40);
    (vecHit as { source: string }).source = "vec";
    const ftsHit = sr("dup.md", 0.95);
    const lanes: LaneList[] = [
      { lane: "vector", results: [vecHit] },
      { lane: "fts-supplement", results: [ftsHit] },
    ];
    const { pool, fusion } = selectCandidatePool(lanes, 10, false);
    expect(pool).toHaveLength(1);
    expect(pool[0]!.score).toBe(0.40);
    expect((pool[0] as { source: string }).source).toBe("vec");
    const cand = fusion.candidates.find(c => c.displayPath === "test/dup.md")!;
    expect(new Set(cand.lanes)).toEqual(new Set(["vector", "fts-supplement"]));
    expect(cand.currentSupported).toBe(true);
    expect(cand.laneContributions.map(l => l.lane).sort()).toEqual(["fts-supplement", "vector"]);
    expect(cand.laneContributions.reduce((s, l) => s + l.contribution, 0)).toBeCloseTo(cand.contribution, 10);
  });

  it("lane weights follow the LANE_WEIGHTS table (current 1.0, prior 0.5, expansion 0.4)", () => {
    expect(LANE_WEIGHTS["vector"]).toBe(1.0);
    expect(LANE_WEIGHTS["prior-fts"]).toBe(0.5);
    expect(LANE_WEIGHTS["expansion-lex"]).toBe(0.4);
  });
});

describe("passesCurrentQueryGate — per-candidate CONTRACT-1(d) gate", () => {
  it("passes on content-token overlap (prefix, FTS-style) and fails without it", () => {
    const tokens = contentTokenSet("clawmem ranking defect diagnosis");
    expect(passesCurrentQueryGate({ title: "Ranking defect handoff", body: "composite scoring" }, tokens)).toBe(true);
    // Prefix direction mirrors FTS: the DOC token must start with the QUERY
    // token — "rankings" matches query "ranking"; bare "rank" does not.
    expect(passesCurrentQueryGate({ title: "Rankings compared", body: "ordered lists" }, tokens)).toBe(true);
    expect(passesCurrentQueryGate({ title: "Garden bed layout", body: "rank the planting beds by sun" }, tokens)).toBe(false);
    expect(passesCurrentQueryGate({ title: "Owl mascot artwork", body: "newsletter banner sizing" }, tokens)).toBe(false);
  });

  it("fails closed on an empty gate token set — vacuous success is not a relevance gate (codex turn-7 F3)", () => {
    expect(passesCurrentQueryGate({ title: "anything", body: "at all" }, new Set())).toBe(false);
  });

  it("gates against PRIOR tokens on a pure-anaphora prompt (caller passes the fallback set)", () => {
    // "do that" has zero content tokens; the caller substitutes the prior
    // turns' tokens, so candidates are checked against the delegated context.
    const priorTokens = contentTokenSet("clawmem ranking defect diagnosis");
    expect(contentTokenSet("do that").size).toBe(0);
    expect(passesCurrentQueryGate({ title: "Ranking defect handoff", body: "composite scoring" }, priorTokens)).toBe(true);
    expect(passesCurrentQueryGate({ title: "Owl mascot artwork", body: "newsletter banner sizing" }, priorTokens)).toBe(false);
  });
});

describe("selectCandidatePool — vault-qualified identity (codex turn-7 F5)", () => {
  it("cross-vault documents sharing one filepath stay two distinct candidates", () => {
    const generalDoc = sr("shared.md", 0.6);
    const skillDoc = sr("shared.md", 0.9);
    (skillDoc as { _fromVault?: string })._fromVault = "skill";
    skillDoc.body = "skill vault twin — different document, same path";
    const lanes: LaneList[] = [
      { lane: "vector", results: [generalDoc] },
      { lane: "secondary-vault", results: [skillDoc] },
    ];
    const { pool, fusion } = selectCandidatePool(lanes, 10, false);
    expect(pool).toHaveLength(2);
    const keys = fusion.candidates.map(c => c.filepath).sort();
    expect(keys).toEqual(["clawmem://test/shared.md", "skill:clawmem://test/shared.md"]);
    const vaults = fusion.candidates.map(c => c.vault).sort();
    expect(vaults).toEqual(["general", "skill"]);
    // Both payloads survive — neither doc's body was replaced by the other's.
    const bodies = new Set(pool.map(r => r.body));
    expect(bodies.size).toBe(2);
  });

  it("dropUnarbitrated matches on the qualified identity — a dropped skill doc never removes its general twin", () => {
    const tokens = contentTokenSet("alpha topic");
    const generalDoc = sr("twin.md", 0.6);
    generalDoc.body = "notes on the alpha topic";           // passes the gate
    const skillDoc = sr("twin.md", 0.9);
    (skillDoc as { _fromVault?: string })._fromVault = "skill";
    skillDoc.title = "unrelated";
    skillDoc.body = "basket weaving";                        // fails the gate
    const lanes: LaneList[] = [
      { lane: "prior-fts", results: [generalDoc], variantQuery: "p" },
      { lane: "prior-fts", results: [skillDoc], variantQuery: "p2" },
    ];
    const { pool, fusion } = selectCandidatePool(lanes, 10, true, tokens);
    const guarded = dropUnarbitrated(pool, fusion);
    expect(guarded).toHaveLength(1);
    expect((guarded[0] as { _fromVault?: string })._fromVault).toBeUndefined();
  });
});

describe("selectCandidatePool — structural payload precedence (codex turn-7 F6)", () => {
  it("a current-class occurrence displaces a discounted-lane payload regardless of lane order", () => {
    // The doc is FIRST found by a prior lane (discounted), THEN by a
    // current-class lane appended later (the live handler adds file-aware
    // and secondary lanes after the prior leg). The payload must be the
    // current-class occurrence — by CLASS, never by score.
    const priorHit = sr("late.md", 0.95);
    const currentHit = sr("late.md", 0.10);
    (currentHit as { source: string }).source = "vec";
    const lanes: LaneList[] = [
      { lane: "prior-fts", results: [priorHit], variantQuery: "p" },
      { lane: "file-aware", results: [currentHit], variantQuery: "late.md" },
    ];
    const { pool } = selectCandidatePool(lanes, 10, true);
    expect(pool).toHaveLength(1);
    expect(pool[0]!.score).toBe(0.10);
    expect((pool[0] as { source: string }).source).toBe("vec");
  });

  it("within one class, the first occurrence in lane order wins (deterministic)", () => {
    const first = sr("same-class.md", 0.2);
    (first as { source: string }).source = "vec";
    const second = sr("same-class.md", 0.9);
    const lanes: LaneList[] = [
      { lane: "vector", results: [first] },
      { lane: "fts-supplement", results: [second] },
    ];
    const { pool } = selectCandidatePool(lanes, 10, false);
    expect(pool).toHaveLength(1);
    expect(pool[0]!.score).toBe(0.2);
  });
});

describe("dropUnarbitrated — failure guard (CONTRACT-1d)", () => {
  const promptTokens = contentTokenSet("current topic alpha document");

  it("drops non-current candidates that fail the per-candidate gate; keeps gate-passers", () => {
    const cur = sr("cur.md", 0.9);
    const priOnTopic = sr("pri-on.md", 0.8);
    priOnTopic.body = "notes about the alpha document lineage";
    const priOffTopic = sr("pri-off.md", 0.8);
    priOffTopic.body = "completely unrelated basket weaving";
    priOffTopic.title = "weaving";
    const expOffTopic = sr("exp-off.md", 0.7);
    expOffTopic.body = "another unrelated subject entirely";
    expOffTopic.title = "unrelated";

    const lanes: LaneList[] = [
      { lane: "fts-fallback", results: [cur] },
      { lane: "prior-fts", results: [priOnTopic, priOffTopic], variantQuery: "prior" },
      { lane: "expansion-vec", results: [expOffTopic], variantQuery: "variant" },
    ];
    const { pool, fusion } = selectCandidatePool(lanes, 10, true, promptTokens);
    const guarded = dropUnarbitrated(pool, fusion);
    const paths = guarded.map(r => r.displayPath).sort();
    expect(paths).toContain("test/cur.md");      // current support
    expect(paths).toContain("test/pri-on.md");   // gate passed (token overlap)
    expect(paths).not.toContain("test/pri-off.md");  // prior lane enabled ≠ document certified
    expect(paths).not.toContain("test/exp-off.md");
  });

  it("keeps a doc that expansion AND a current lane both found", () => {
    const lanes: LaneList[] = [
      lane("fts-fallback", ["both.md"]),
      lane("expansion-lex", ["both.md"], "variant"),
    ];
    const { pool, fusion } = selectCandidatePool(lanes, 10, false, promptTokens);
    expect(dropUnarbitrated(pool, fusion).map(r => r.displayPath)).toEqual(["test/both.md"]);
  });
});

describe("finalOrderingKeys + fuseRerankLane + compareOrderingKeys (BUILD-2, C2)", () => {
  it("finalOrderingKeys maps identities to (band, mass): current-supported = band 0, discounted-only = band 1 — UNCONDITIONAL on current support", async () => {
    const { finalOrderingKeys, fuseRerankLane } = await import("../../src/hooks/surfacing-fusion.ts");
    const cur = sr("a.md", 0.9);
    const expOnly = sr("e.md", 0.7);
    expOnly.body = "body of e.md"; // shares "body" with the gate tokens
    const lanes: LaneList[] = [
      { lane: "fts-fallback", results: [cur, sr("b.md", 0.8)] },
      { lane: "expansion-lex", results: [expOnly], variantQuery: "v" },
    ];
    const { fusion } = selectCandidatePool(lanes, 10, false, contentTokenSet("body"));
    const keys = finalOrderingKeys(fusion);
    for (const c of fusion.candidates) {
      const k = keys.get(c.filepath)!;
      expect(k.mass).toBe(c.contribution);
      expect(k.band).toBe(c.currentSupported ? 0 : 1);
    }
    expect(keys.get("clawmem://test/a.md")!.band).toBe(0);
    expect(keys.get("clawmem://test/e.md")!.band).toBe(1);
    // Codex turn-15: an APPLIED full-coverage rerank proves the reranker
    // ANSWERED for every candidate, not that it DISCRIMINATED. Fusing the
    // rerank over the WHOLE candidate set — even one that ranks the
    // discounted-only e.md FIRST (the inert-reranker attack) — adds mass but
    // NEVER elevates a band: e.md stays band 1, strictly below the anchor.
    const others = [...keys.keys()].filter(k => k !== "clawmem://test/e.md");
    const fused = fuseRerankLane(keys, ["clawmem://test/e.md", ...others]);
    expect(fused.get("clawmem://test/a.md")!.band).toBe(0);
    expect(fused.get("clawmem://test/e.md")!.band).toBe(1);
    // The rerank contributed mass to e.md, yet the band held.
    expect(fused.get("clawmem://test/e.md")!.mass).toBeGreaterThan(keys.get("clawmem://test/e.md")!.mass);
  });

  it("compareOrderingKeys: band ASC beats mass DESC — a heavier band-1 key still orders below band 0", async () => {
    const { compareOrderingKeys } = await import("../../src/hooks/surfacing-fusion.ts");
    // Codex turn-14 F4 arithmetic: expansion-only rank-0 in three variants
    // (~0.0797) out-masses a current rank-0 (~0.0664) — the band must decide.
    expect(compareOrderingKeys({ band: 0, mass: 0.0664 }, { band: 1, mass: 0.0797 })).toBeLessThan(0);
    expect(compareOrderingKeys({ band: 1, mass: 0.0797 }, { band: 0, mass: 0.0664 })).toBeGreaterThan(0);
    expect(compareOrderingKeys({ band: 0, mass: 0.02 }, { band: 0, mass: 0.05 })).toBeGreaterThan(0);
    expect(compareOrderingKeys({ band: 0, mass: 0.05 }, { band: 0, mass: 0.05 })).toBe(0);
  });

  it("fuseRerankLane adds the SHARED weighted-RRF rank term to the mass and leaves unlisted keys untouched", async () => {
    const { fuseRerankLane, RERANK_LANE_WEIGHT } = await import("../../src/hooks/surfacing-fusion.ts");
    const { reciprocalRankFusion } = await import("../../src/search-utils.ts");
    const base = new Map([
      ["k1", { band: 0 as const, mass: 0.010 }],
      ["k2", { band: 0 as const, mass: 0.020 }],
      ["k3", { band: 0 as const, mass: 0.030 }],
    ]);
    const rerankedDesc = ["k1", "k2"]; // k3 not covered by this synthetic list
    const fused = fuseRerankLane(base, rerankedDesc);
    // Expected increments come from the SAME shared helper with the same
    // weight/k/bonuses — this pins the WIRING, not a re-derived constant.
    const expected = reciprocalRankFusion(
      [rerankedDesc.map(k => ({ file: k, displayPath: k, title: "", body: "", score: 0 }))],
      [RERANK_LANE_WEIGHT], 60, { weightBonuses: true }
    );
    const incByFile = new Map(expected.map(e => [e.file, e.score]));
    expect(fused.get("k1")!.mass).toBeCloseTo(0.010 + incByFile.get("k1")!, 12);
    expect(fused.get("k2")!.mass).toBeCloseTo(0.020 + incByFile.get("k2")!, 12);
    expect(fused.get("k3")!.mass).toBe(0.030); // untouched
    // Rank 1 earns strictly more than rank 2, bands survive, and the base
    // map is not mutated.
    expect(incByFile.get("k1")!).toBeGreaterThan(incByFile.get("k2")!);
    expect(fused.get("k1")!.band).toBe(0);
    expect(base.get("k1")!.mass).toBe(0.010);
  });

  it("resolveRerankLaneWeight: default 1.5, 0 is a valid ablation value, junk falls back", async () => {
    const { resolveRerankLaneWeight } = await import("../../src/hooks/surfacing-fusion.ts");
    expect(resolveRerankLaneWeight(undefined)).toBe(1.5);
    expect(resolveRerankLaneWeight("")).toBe(1.5);
    expect(resolveRerankLaneWeight("  ")).toBe(1.5);
    expect(resolveRerankLaneWeight("0")).toBe(0); // RRF-only counterfactual — lane skipped
    expect(resolveRerankLaneWeight("2.5")).toBe(2.5);
    expect(resolveRerankLaneWeight("-1")).toBe(1.5);
    expect(resolveRerankLaneWeight("NaN")).toBe(1.5);
    expect(resolveRerankLaneWeight("bogus")).toBe(1.5);
  });

  it("CLAWMEM_RERANK_LANE_WEIGHT=0 resolves an INACTIVE lane at module load (codex turn-17 F1)", async () => {
    // The weight is resolved at module load, so the env path needs a fresh
    // process — the same shape the eval CLI arms use. RERANK_LANE_ACTIVE is
    // the seam the handler keys orderingApplied/rankingKey on.
    const script = `
      import { RERANK_LANE_WEIGHT, RERANK_LANE_ACTIVE, FUSION_POLICY_REV } from "${import.meta.dir}/../../src/hooks/surfacing-fusion.ts";
      console.log(JSON.stringify({ w: RERANK_LANE_WEIGHT, active: RERANK_LANE_ACTIVE, rev: FUSION_POLICY_REV }));
    `;
    const run = (env: Record<string, string | undefined>) => {
      const proc = Bun.spawnSync(["bun", "-e", script], { env: { ...process.env, ...env } });
      return JSON.parse(proc.stdout.toString().trim()) as { w: number; active: boolean; rev: number };
    };
    const zero = run({ CLAWMEM_RERANK_LANE_WEIGHT: "0" });
    expect(zero.w).toBe(0);
    expect(zero.active).toBe(false);
    const dflt = run({ CLAWMEM_RERANK_LANE_WEIGHT: undefined });
    expect(dflt.w).toBe(1.5);
    expect(dflt.active).toBe(true);
    expect(dflt.rev).toBe(zero.rev); // the policy REV is code, not env
  });
});

// ---------------------------------------------------------------------------
// BUILD-4 (C4): relevanceAdmission — admission on the ordering basis
// ---------------------------------------------------------------------------
import {
  relevanceAdmission,
  resolveAdmissionBasis,
  finalOrderingKeys,
  ADMISSION_PARAMS,
} from "../../src/hooks/surfacing-fusion.ts";
import type { TraceFusion } from "../../src/eval/hook-trace.ts";

describe("relevanceAdmission — BUILD-4 (C4) admission on the ordering basis", () => {
  // Explicit params so these tests pin STRUCTURE; the shipped per-basis
  // values in ADMISSION_PARAMS are eval-calibrated and may move.
  const P = { floorRatio: 0.5, spreadK: 5 };
  const presentOf = (fusion: TraceFusion) =>
    fusion.candidates.filter(c => c.admitted).map(c => c.filepath);

  it("resolveAdmissionBasis derives from lanes that ACTUALLY ran, never profile capability (t52-F3)", () => {
    const basisOf = (fusion: TraceFusion, rerank = false) =>
      resolveAdmissionBasis(fusion, rerank, presentOf(fusion), finalOrderingKeys(fusion));
    const ftsOnly = selectCandidatePool([lane("fts-fallback", ["a.md"])], 10, false).fusion;
    const withVec = selectCandidatePool([lane("fts-fallback", ["a.md"]), lane("vector", ["a.md"])], 10, false).fusion;
    const vecEmpty = selectCandidatePool([lane("fts-fallback", ["a.md"]), lane("vector", [])], 10, false).fusion;
    expect(basisOf(ftsOnly)).toBe("bm25-rrf");
    expect(basisOf(withVec)).toBe("weighted-rrf");
    // A vector leg that returned NOTHING (timeout / empty) is a bm25 basis.
    expect(basisOf(vecEmpty)).toBe("bm25-rrf");
    expect(basisOf(withVec, true)).toBe("rerank-fused-rrf");
  });

  it("basis follows the candidates ACTUALLY JUDGED: a nonempty vector lane whose candidates were all filtered out pre-admission is a bm25 basis (t53-F1)", () => {
    // fts found a.md; the vector leg returned ONLY b.md, which the filters
    // (private/snoozed/noise/dedupe) then removed — the judged set is
    // FTS-only, so a weighted-rrf label would key the wrong calibration row.
    const { fusion } = selectCandidatePool([
      lane("fts-fallback", ["a.md"]),
      lane("vector", ["b.md"]),
    ], 10, false);
    const keys = finalOrderingKeys(fusion);
    const all = presentOf(fusion);
    const noVec = all.filter(k => !k.includes("b.md"));
    expect(resolveAdmissionBasis(fusion, false, noVec, keys)).toBe("bm25-rrf");
    // ...with the vector-borne candidate still present it stays weighted.
    expect(resolveAdmissionBasis(fusion, false, all, keys)).toBe("weighted-rrf");
    // Judged-BAND scoping: with band 0 present, a band-1 vector contribution
    // (expansion-vec survivor) does not make the basis vector-bearing —
    // admission judges band 0, so band 0's channels ARE the basis.
    const { fusion: mixed } = selectCandidatePool([
      lane("fts-fallback", ["cur.md"]),
      lane("expansion-vec", ["exp.md"], "v1"),
    ], 10, false);
    expect(resolveAdmissionBasis(mixed, false, presentOf(mixed), finalOrderingKeys(mixed))).toBe("bm25-rrf");
  });

  it("abstains no-current-support when every present candidate lacks current-class support", () => {
    // The current-supported doc exists in the pool but was noise-filtered out
    // of the enriched set — admission judges what could actually be injected.
    const { fusion } = selectCandidatePool([
      lane("fts-fallback", ["cur.md"]),
      lane("expansion-lex", ["e1.md"], "v1"),
    ], 10, false);
    const keys = finalOrderingKeys(fusion);
    const pres = presentOf(fusion).filter(k => !k.includes("cur.md"));
    const d = relevanceAdmission(pres, keys, fusion, "weighted-rrf", P);
    expect(d.abstain).toBe("no-current-support");
    expect(d.admitted).toEqual([]);
  });

  it("zero-current-mass certified-prior edge: band-1 prior docs judged under their own floor, tail cut", () => {
    const { fusion } = selectCandidatePool([
      lane("prior-fts", ["p1.md", "p2.md", "p3.md", "p4.md"]),
      lane("prior-vector", ["p1.md"]),
    ], 10, true);
    const keys = finalOrderingKeys(fusion);
    const d = relevanceAdmission(presentOf(fusion), keys, fusion, "weighted-rrf", P);
    expect(d.abstain).toBeNull();
    // p1 rides two prior lanes (rank-1 both) — the clear leader survives;
    // the single-lane rank-4 tail falls below half its mass.
    expect(d.admitted).toContain("clawmem://test/p1.md");
    const p4 = d.rejected.find(r => r.key === "clawmem://test/p4.md");
    expect(p4?.reason).toBe("band-floor");
  });

  it("degenerate-basis abstention: band 0 present but ZERO keyword-class agreement (vector-only pool)", () => {
    const { fusion } = selectCandidatePool([
      lane("vector", ["j1.md", "j2.md", "j3.md", "j4.md"]),
    ], 10, false);
    const keys = finalOrderingKeys(fusion);
    const d = relevanceAdmission(presentOf(fusion), keys, fusion, "weighted-rrf", P);
    expect(d.abstain).toBe("degenerate-basis");
    expect(d.admitted).toEqual([]);
    expect(d.stats.keywordAgreed).toBe(0);
    expect(new Set(d.rejected.map(r => r.reason))).toEqual(new Set(["degenerate"]));
  });

  it("keyword agreement unlocks band 0; the relative floor cuts the vector-only tail", () => {
    const { fusion } = selectCandidatePool([
      lane("fts-fallback", ["target.md"]),
      lane("vector", ["target.md", "noise1.md", "noise2.md"]),
    ], 10, false);
    const keys = finalOrderingKeys(fusion);
    const d = relevanceAdmission(presentOf(fusion), keys, fusion, "weighted-rrf", P);
    expect(d.abstain).toBeNull();
    // target: fts r1 + vector r1 (two-lane agreement ≈ doubles mass);
    // noise1: vector r2 alone ≈ 0.27 of top → below the 0.5 floor.
    expect(d.admitted).toEqual(["clawmem://test/target.md"]);
    const noise = d.rejected.find(r => r.key === "clawmem://test/noise1.md");
    expect(noise?.reason).toBe("floor");
  });

  it("anti-suppression guard: multi-lane-agreed cluster members above the floor are ALL admitted", () => {
    const { fusion } = selectCandidatePool([
      lane("fts-fallback", ["a.md", "b.md"]),
      lane("vector", ["b.md", "a.md"]),
    ], 10, false);
    const keys = finalOrderingKeys(fusion);
    const d = relevanceAdmission(presentOf(fusion), keys, fusion, "weighted-rrf", P);
    expect(d.abstain).toBeNull();
    expect(new Set(d.admitted)).toEqual(new Set(["clawmem://test/a.md", "clawmem://test/b.md"]));
    expect(d.rejected).toEqual([]);
  });

  it("band-1 is wholly rejected when band 0 exists — no automatic exploration slot (C4/OG-1, t52-F4)", () => {
    const { fusion } = selectCandidatePool([
      lane("fts-fallback", ["cur.md"]),
      lane("prior-fts", ["q1.md", "q2.md", "q3.md", "q4.md"]),
    ], 10, true);
    const keys = finalOrderingKeys(fusion);
    const d = relevanceAdmission(presentOf(fusion), keys, fusion, "weighted-rrf", P);
    expect(d.abstain).toBeNull();
    expect(d.admitted).toEqual(["clawmem://test/cur.md"]);
    // A band-relative floor would ALWAYS pass the band-1 top (its own top
    // always clears its own floor) — a guaranteed discounted-only admission
    // beside current evidence, which the locked contract forbids. Every
    // band-1 candidate is rejected here, leader included.
    for (const q of ["q1.md", "q2.md", "q3.md", "q4.md"]) {
      const rj = d.rejected.find(r => r.key === `clawmem://test/${q}`);
      expect(rj?.reason).toBe("band-floor");
    }
  });

  it("defaults resolve from ADMISSION_PARAMS by basis and are recorded in stats", () => {
    const { fusion } = selectCandidatePool([lane("fts-fallback", ["x.md"])], 10, false);
    const keys = finalOrderingKeys(fusion);
    const d = relevanceAdmission(presentOf(fusion), keys, fusion, "bm25-rrf");
    expect(d.stats.basis).toBe("bm25-rrf");
    expect(ADMISSION_PARAMS["bm25-rrf"].floorRatio).toBeGreaterThan(0);
    expect(d.abstain).toBeNull();
    expect(d.admitted).toEqual(["clawmem://test/x.md"]);
  });
});
