/**
 * Hook replay-eval — judged metrics (BUILD-0, CONTRACT-5b).
 *
 * Metric set fixed by the cleared design: graded nDCG on the injected order,
 * must-not-include rate, abstention accuracy, must-include recall, latency
 * p50/p95, and whole-hook timeout rate — reported per split (tuning vs
 * held-out acceptance) so thresholds tuned on one slice are proven on the
 * other.
 *
 * Gains: must_include = 2, acceptable = 1, unlabeled = 0, must_not_include =
 * 0 (its damage is measured by the dedicated rate, not by nDCG — a negative
 * gain would double-count it and make nDCG incomparable across cases).
 */

import type { HookGoldExample } from "./hook-gold.ts";
import { mean, p95 } from "./metrics.ts";

export interface HookCaseMetrics {
  /** Graded nDCG@k over the injected order (null when the ideal DCG is 0 — nothing labeled positive). */
  ndcg: number | null;
  /** Injected docs labeled must_not_include / injected docs (null when nothing injected). */
  mustNotRate: number | null;
  /** Count of injected must_not_include docs. */
  mustNotCount: number;
  /** |injected ∩ must_include| / |must_include| (null when must_include is empty). */
  mustIncludeRecall: number | null;
  /** For expect_abstain cases: 1 = correctly injected nothing, 0 = injected. Null on non-abstain cases. */
  abstentionCorrect: 0 | 1 | null;
  /** For non-abstain cases with a non-empty must_include: 1 = wrongly injected nothing. Null otherwise. */
  falseAbstain: 0 | 1 | null;
  /**
   * Prior-leg decision correctness against the case's `prior_leg` label:
   * required → the prior leg must have been enabled; forbidden → it must not
   * have been; harmless → null (either is fine). The observed decision is the
   * trace's `retrievalQuery.multiTurn` flag.
   */
  priorLegOk: 0 | 1 | null;
  injectedCount: number;
  elapsedMs: number;
  timedOut: boolean;
}

/** DCG with gains 2^rel - 1 and log2 rank discount. */
function dcg(gains: number[]): number {
  let sum = 0;
  for (let i = 0; i < gains.length; i++) {
    sum += (Math.pow(2, gains[i]!) - 1) / Math.log2(i + 2);
  }
  return sum;
}

/**
 * Score one replayed case. `injectedPaths` is the final injected displayPath
 * order from the trace (authoritative, not re-parsed from the rendered
 * context). `budgetMs` is the whole-hook latency bar for the timeout rate.
 */
export function computeHookCaseMetrics(
  example: HookGoldExample,
  injectedPaths: string[],
  elapsedMs: number,
  budgetMs: number,
  k: number = 10,
  priorLegEnabled: boolean = false
): HookCaseMetrics {
  const must = new Set(example.labels.must_include);
  const acceptable = new Set(example.labels.acceptable);
  const mustNot = new Set(example.labels.must_not_include);

  const gain = (p: string): number => (must.has(p) ? 2 : acceptable.has(p) ? 1 : 0);

  const topK = injectedPaths.slice(0, k);
  const actualGains = topK.map(gain);

  // Ideal ordering: every must doc first, then every acceptable doc, capped at k.
  const idealGains = [
    ...Array<number>(must.size).fill(2),
    ...Array<number>(acceptable.size).fill(1),
  ].slice(0, k);

  const idealDcg = dcg(idealGains);
  const ndcg = idealDcg > 0 ? dcg(actualGains) / idealDcg : null;

  const mustNotCount = injectedPaths.filter(p => mustNot.has(p)).length;
  const mustNotRate = injectedPaths.length > 0 ? mustNotCount / injectedPaths.length : null;

  const mustHits = example.labels.must_include.filter(p => injectedPaths.includes(p)).length;
  const mustIncludeRecall = must.size > 0 ? mustHits / must.size : null;

  const abstentionCorrect: 0 | 1 | null = example.expect_abstain
    ? (injectedPaths.length === 0 ? 1 : 0)
    : null;
  const falseAbstain: 0 | 1 | null = !example.expect_abstain && must.size > 0
    ? (injectedPaths.length === 0 ? 1 : 0)
    : null;

  const priorLegOk: 0 | 1 | null =
    example.prior_leg === "harmless" ? null :
    example.prior_leg === "required" ? (priorLegEnabled ? 1 : 0) :
    (priorLegEnabled ? 0 : 1);

  return {
    ndcg,
    mustNotRate,
    mustNotCount,
    mustIncludeRecall,
    abstentionCorrect,
    falseAbstain,
    priorLegOk,
    injectedCount: injectedPaths.length,
    elapsedMs,
    timedOut: elapsedMs > budgetMs,
  };
}

export interface HookAggregate {
  cases: number;
  ndcgMean: number | null;
  /** Fraction of cases that injected ≥1 must_not_include doc. */
  mustNotCaseRate: number | null;
  /** Injected must_not docs / all injected docs, pooled. */
  mustNotDocRate: number | null;
  mustIncludeRecallMean: number | null;
  /** Correct abstentions / expect_abstain cases. */
  abstentionAccuracy: number | null;
  /** Wrong empty injections / cases with must_include labels. */
  falseAbstainRate: number | null;
  /** Correct prior-leg decisions / cases labeled required or forbidden. */
  priorLegAccuracy: number | null;
  latencyP50Ms: number | null;
  latencyP95Ms: number | null;
  timeoutRate: number | null;
}

/** Nearest-rank p50. */
function p50(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil(0.5 * sorted.length);
  return sorted[Math.max(0, rank - 1)]!;
}

export function aggregateHookMetrics(perCase: HookCaseMetrics[]): HookAggregate {
  const ndcgs = perCase.map(m => m.ndcg).filter((v): v is number => v !== null);
  const recalls = perCase.map(m => m.mustIncludeRecall).filter((v): v is number => v !== null);
  const abstentions = perCase.map(m => m.abstentionCorrect).filter((v): v is 0 | 1 => v !== null);
  const falseAbstains = perCase.map(m => m.falseAbstain).filter((v): v is 0 | 1 => v !== null);
  const priorLegs = perCase.map(m => m.priorLegOk).filter((v): v is 0 | 1 => v !== null);
  const latencies = perCase.map(m => m.elapsedMs);

  const totalInjected = perCase.reduce((s, m) => s + m.injectedCount, 0);
  const totalMustNot = perCase.reduce((s, m) => s + m.mustNotCount, 0);
  const casesWithMustNot = perCase.filter(m => m.mustNotCount > 0).length;

  return {
    cases: perCase.length,
    ndcgMean: mean(ndcgs),
    mustNotCaseRate: perCase.length > 0 ? casesWithMustNot / perCase.length : null,
    mustNotDocRate: totalInjected > 0 ? totalMustNot / totalInjected : null,
    mustIncludeRecallMean: mean(recalls),
    abstentionAccuracy: abstentions.length > 0 ? mean(abstentions.map(Number)) : null,
    falseAbstainRate: falseAbstains.length > 0 ? mean(falseAbstains.map(Number)) : null,
    priorLegAccuracy: priorLegs.length > 0 ? mean(priorLegs.map(Number)) : null,
    latencyP50Ms: p50(latencies),
    latencyP95Ms: p95(latencies),
    timeoutRate: perCase.length > 0 ? perCase.filter(m => m.timedOut).length / perCase.length : null,
  };
}
