/**
 * codex t68 F3 — deriveValidBasisByStratum: the ONE derivation both the
 * runner's recorded valid_basis_by_stratum and the replicated aggregate's
 * ledger reconciliation compute. Pinned here so the map's semantics (valid
 * pairs only; profile AND split strata; judged bases only; key-sorted) are
 * regression-locked independent of any full replay.
 */
import { describe, it, expect } from "bun:test";
import { deriveValidBasisByStratum, ADMISSION_BASES } from "../../src/eval/hook-run.ts";

const row = (id: string, profile: string, split: string, basis: string | null | undefined) =>
  ({ id, profile, split, admission_basis: basis });

describe("deriveValidBasisByStratum (codex t68 F3)", () => {
  it("counts valid rows under BOTH their profile and split strata, judged bases only", () => {
    const rows = [
      row("a", "speed", "holdout", "bm25-rrf"),
      row("b", "deep", "holdout", "rerank-fused-rrf"),
      row("c", "balanced", "tuning", "weighted-rrf"),
      row("d", "speed", "holdout", "bm25-rrf"),      // NOT valid — excluded
      row("e", "speed", "holdout", null),             // never reached admission — excluded
      row("f", "deep", "tuning", "none"),            // "none" is not a judged basis — excluded
    ];
    const out = deriveValidBasisByStratum(rows, new Set(["a", "b", "c", "e", "f"]));
    expect(out).toEqual({
      "balanced:weighted-rrf": 1,
      "deep:rerank-fused-rrf": 1,
      "holdout:bm25-rrf": 1,
      "holdout:rerank-fused-rrf": 1,
      "speed:bm25-rrf": 1,
      "tuning:weighted-rrf": 1,
    });
    // canonical: key-sorted
    expect(Object.keys(out)).toEqual([...Object.keys(out)].sort());
  });

  it("returns {} when nothing is valid or no basis was judged", () => {
    expect(deriveValidBasisByStratum([row("a", "deep", "holdout", "bm25-rrf")], new Set())).toEqual({});
    expect(deriveValidBasisByStratum([row("a", "deep", "holdout", undefined)], new Set(["a"]))).toEqual({});
  });

  it("the registrable basis set is exactly the three judged bases", () => {
    expect([...ADMISSION_BASES].sort()).toEqual(["bm25-rrf", "rerank-fused-rrf", "weighted-rrf"]);
  });
});
