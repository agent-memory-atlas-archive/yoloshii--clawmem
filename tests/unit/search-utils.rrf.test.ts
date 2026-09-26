import { describe, test, expect } from "bun:test";
import { reciprocalRankFusion, type RankedResult } from "../../src/search-utils.ts";

function makeResult(file: string, score: number): RankedResult {
  return { file, displayPath: file, title: file, body: "", score };
}

describe("reciprocalRankFusion", () => {
  test("merges two ranked lists", () => {
    const list1 = [makeResult("a.md", 1.0), makeResult("b.md", 0.8)];
    const list2 = [makeResult("b.md", 1.0), makeResult("c.md", 0.6)];

    const result = reciprocalRankFusion([list1, list2], [1, 1]);
    expect(result.length).toBe(3);
    // b.md appears in both → highest score
    expect(result[0]!.file).toBe("b.md");
  });

  test("respects weights", () => {
    const list1 = [makeResult("a.md", 1.0)];
    const list2 = [makeResult("b.md", 1.0)];

    const result = reciprocalRankFusion([list1, list2], [10, 1]);
    // a.md has weight 10, b.md has weight 1
    expect(result[0]!.file).toBe("a.md");
  });

  test("throws on weight/list length mismatch", () => {
    const list1 = [makeResult("a.md", 1.0)];
    expect(() => reciprocalRankFusion([list1], [1, 2])).toThrow("must match");
  });

  test("handles empty lists", () => {
    const result = reciprocalRankFusion([], []);
    expect(result).toHaveLength(0);
  });

  test("handles empty weights (defaults to 1)", () => {
    const list1 = [makeResult("a.md", 1.0)];
    const result = reciprocalRankFusion([list1], []);
    expect(result).toHaveLength(1);
  });

  test("single list passthrough", () => {
    const list1 = [makeResult("a.md", 1.0), makeResult("b.md", 0.5)];
    const result = reciprocalRankFusion([list1], [1]);
    expect(result).toHaveLength(2);
    expect(result[0]!.file).toBe("a.md");
  });

  test("sanitizes NaN weights to 1", () => {
    const list1 = [makeResult("a.md", 1.0)];
    const list2 = [makeResult("b.md", 1.0)];
    const result = reciprocalRankFusion([list1, list2], [NaN, 1]);
    expect(result).toHaveLength(2);
    // NaN weight becomes 1, so both lists have equal weight
    expect(result.every(r => Number.isFinite(r.score))).toBe(true);
  });

  test("sanitizes negative weights to 1", () => {
    const list1 = [makeResult("a.md", 1.0)];
    const result = reciprocalRankFusion([list1], [-5]);
    expect(result).toHaveLength(1);
    expect(result[0]!.score).toBeGreaterThan(0);
  });

  test("skips zero-weight lists", () => {
    const list1 = [makeResult("a.md", 1.0)];
    const list2 = [makeResult("b.md", 1.0)];
    const result = reciprocalRankFusion([list1, list2], [1, 0]);
    // b.md from zero-weight list should not appear
    expect(result).toHaveLength(1);
    expect(result[0]!.file).toBe("a.md");
  });

  test("sanitizes invalid k to default 60", () => {
    const list1 = [makeResult("a.md", 1.0)];
    const result = reciprocalRankFusion([list1], [1], NaN);
    expect(result).toHaveLength(1);
    expect(Number.isFinite(result[0]!.score)).toBe(true);
  });
});

describe("reciprocalRankFusion — fusion policy (C1b, BUILD-1)", () => {
  test("an omitted options object and {weightBonuses:false} produce byte-identical output", () => {
    const list1 = [makeResult("a.md", 1.0), makeResult("b.md", 0.9)];
    const list2 = [makeResult("b.md", 0.8), makeResult("c.md", 0.7)];
    const omitted = reciprocalRankFusion([list1, list2], [1, 0.5]);
    const explicit = reciprocalRankFusion([list1, list2], [1, 0.5], 60, { weightBonuses: false });
    expect(JSON.stringify(explicit)).toBe(JSON.stringify(omitted));
  });

  test("unweighted bonuses let a discounted lane's rank-0 hit outscore a full-weight lane; weightBonuses closes that", () => {
    // Full-weight lane ranks x.md at rank 3 (no bonus); a 0.1-weight lane ranks
    // y.md at rank 0 (+0.05 bonus). Unweighted: y.md's bonus dominates.
    const fullLane = [makeResult("a.md", 1), makeResult("b.md", 0.9), makeResult("c.md", 0.8), makeResult("x.md", 0.7)];
    const weakLane = [makeResult("y.md", 1)];

    const unweighted = reciprocalRankFusion([fullLane, weakLane], [1, 0.1]);
    const xU = unweighted.find(r => r.file === "x.md")!.score;
    const yU = unweighted.find(r => r.file === "y.md")!.score;
    expect(yU).toBeGreaterThan(xU); // the defect shape: bonus ignores the lane weight

    const weighted = reciprocalRankFusion([fullLane, weakLane], [1, 0.1], 60, { weightBonuses: true });
    const xW = weighted.find(r => r.file === "x.md")!.score;
    const yW = weighted.find(r => r.file === "y.md")!.score;
    expect(xW).toBeGreaterThan(yW); // weighted bonus keeps the discounted lane discounted
  });

  test("weightBonuses does not change single-full-weight-list results", () => {
    const list = [makeResult("a.md", 1), makeResult("b.md", 0.9)];
    const off = reciprocalRankFusion([list], [1]);
    const on = reciprocalRankFusion([list], [1], 60, { weightBonuses: true });
    expect(JSON.stringify(on)).toBe(JSON.stringify(off));
  });
});
