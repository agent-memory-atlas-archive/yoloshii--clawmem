/**
 * Hook replay-eval metrics — judged-metric math (BUILD-0, CONTRACT-5b).
 */
import { describe, it, expect } from "bun:test";
import { computeHookCaseMetrics, aggregateHookMetrics } from "../../src/eval/hook-metrics.ts";
import type { HookGoldExample } from "../../src/eval/hook-gold.ts";

function example(overrides: Partial<HookGoldExample> = {}): HookGoldExample {
  return {
    id: "m-1",
    prompt: "a sufficiently long test prompt about things",
    priors: [],
    profile: "balanced",
    expect_abstain: false,
    prior_leg: "harmless",
    labels: { must_include: [], acceptable: [], must_not_include: [] },
    split: "tuning",
    tags: [],
    ...overrides,
  };
}

describe("hook case metrics", () => {
  it("nDCG is 1.0 for a perfectly ordered injection and null when nothing is labeled positive", () => {
    const ex = example({ labels: { must_include: ["a", "b"], acceptable: ["c"], must_not_include: [] } });
    const perfect = computeHookCaseMetrics(ex, ["a", "b", "c"], 100, 8000);
    expect(perfect.ndcg).toBeCloseTo(1.0, 10);

    const inverted = computeHookCaseMetrics(ex, ["c", "b", "a"], 100, 8000);
    expect(inverted.ndcg!).toBeLessThan(1.0);
    expect(inverted.ndcg!).toBeGreaterThan(0);

    const unlabeled = computeHookCaseMetrics(example(), ["x", "y"], 100, 8000);
    expect(unlabeled.ndcg).toBeNull();
  });

  it("must-not rate and count measure injected must_not_include docs", () => {
    const ex = example({ labels: { must_include: [], acceptable: [], must_not_include: ["bad"] } });
    const m = computeHookCaseMetrics(ex, ["ok1", "bad", "ok2", "ok3"], 100, 8000);
    expect(m.mustNotCount).toBe(1);
    expect(m.mustNotRate).toBeCloseTo(0.25, 10);
    const empty = computeHookCaseMetrics(ex, [], 100, 8000);
    expect(empty.mustNotRate).toBeNull();
  });

  it("must-include recall counts retrieved must docs", () => {
    const ex = example({ labels: { must_include: ["a", "b"], acceptable: [], must_not_include: [] } });
    expect(computeHookCaseMetrics(ex, ["a", "x"], 100, 8000).mustIncludeRecall).toBeCloseTo(0.5, 10);
    expect(computeHookCaseMetrics(example(), ["a"], 100, 8000).mustIncludeRecall).toBeNull();
  });

  it("abstention accuracy and false-abstain are mutually exclusive per case", () => {
    const abstainCase = example({ expect_abstain: true });
    expect(computeHookCaseMetrics(abstainCase, [], 100, 8000).abstentionCorrect).toBe(1);
    expect(computeHookCaseMetrics(abstainCase, ["x"], 100, 8000).abstentionCorrect).toBe(0);
    expect(computeHookCaseMetrics(abstainCase, [], 100, 8000).falseAbstain).toBeNull();

    const mustCase = example({ labels: { must_include: ["a"], acceptable: [], must_not_include: [] } });
    expect(computeHookCaseMetrics(mustCase, [], 100, 8000).falseAbstain).toBe(1);
    expect(computeHookCaseMetrics(mustCase, ["a"], 100, 8000).falseAbstain).toBe(0);
    expect(computeHookCaseMetrics(mustCase, [], 100, 8000).abstentionCorrect).toBeNull();
  });

  it("prior-leg correctness follows the label", () => {
    const req = example({ prior_leg: "required" });
    expect(computeHookCaseMetrics(req, [], 100, 8000, 10, true).priorLegOk).toBe(1);
    expect(computeHookCaseMetrics(req, [], 100, 8000, 10, false).priorLegOk).toBe(0);
    const forb = example({ prior_leg: "forbidden" });
    expect(computeHookCaseMetrics(forb, [], 100, 8000, 10, true).priorLegOk).toBe(0);
    expect(computeHookCaseMetrics(forb, [], 100, 8000, 10, false).priorLegOk).toBe(1);
    const harmless = example({ prior_leg: "harmless" });
    expect(computeHookCaseMetrics(harmless, [], 100, 8000, 10, true).priorLegOk).toBeNull();
  });

  it("timeout flag fires when elapsed exceeds the budget", () => {
    expect(computeHookCaseMetrics(example(), [], 8100, 8000).timedOut).toBe(true);
    expect(computeHookCaseMetrics(example(), [], 7900, 8000).timedOut).toBe(false);
  });

  it("nDCG respects k", () => {
    const ex = example({ labels: { must_include: ["a"], acceptable: [], must_not_include: [] } });
    // "a" injected at position 4 with k=3 → outside the window → nDCG 0
    const m = computeHookCaseMetrics(ex, ["x", "y", "z", "a"], 100, 8000, 3);
    expect(m.ndcg).toBeCloseTo(0, 10);
  });
});

describe("hook aggregate metrics", () => {
  it("aggregates rates, means, and latency percentiles", () => {
    const ex = example({ labels: { must_include: ["a"], acceptable: [], must_not_include: ["bad"] } });
    const perCase = [
      computeHookCaseMetrics(ex, ["a"], 100, 8000),          // clean hit
      computeHookCaseMetrics(ex, ["bad", "a"], 200, 8000),   // must-not injected
      computeHookCaseMetrics(ex, [], 9000, 8000),            // false abstain + timeout
    ];
    const agg = aggregateHookMetrics(perCase);
    expect(agg.cases).toBe(3);
    expect(agg.mustNotCaseRate).toBeCloseTo(1 / 3, 10);
    expect(agg.mustNotDocRate).toBeCloseTo(1 / 3, 10); // 1 must-not of 3 injected docs pooled
    expect(agg.mustIncludeRecallMean).toBeCloseTo((1 + 1 + 0) / 3, 10);
    expect(agg.falseAbstainRate).toBeCloseTo(1 / 3, 10);
    expect(agg.timeoutRate).toBeCloseTo(1 / 3, 10);
    expect(agg.latencyP50Ms).toBe(200);
    expect(agg.latencyP95Ms).toBe(9000);
  });

  it("returns nulls on an empty input", () => {
    const agg = aggregateHookMetrics([]);
    expect(agg.cases).toBe(0);
    expect(agg.ndcgMean).toBeNull();
    expect(agg.mustNotCaseRate).toBeNull();
    expect(agg.timeoutRate).toBeNull();
  });
});
