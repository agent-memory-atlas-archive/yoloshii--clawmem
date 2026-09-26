/**
 * Replicated-distribution aggregation (BUILD-3d) — the distributional
 * acceptance protocol over n frozen-draw member runs of one arm. Structural
 * impossibilities refuse; member gate failures produce a FAILING aggregate;
 * the built identity carries "replicated:<n>" + the itemized draw list and
 * passes the SHARED identity validator; replicated-vs-replicated identities
 * compare through the ordinary acceptance gate at equal n.
 */
import { describe, it, expect, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  aggregateReplicatedRuns,
  aggregateReplicatedRunDirs,
  writeReplicatedArtifacts,
  renderReplicatedMd,
  REPLICATED_SHIPPING_MIN_DRAWS,
} from "../../src/eval/replicated.ts";
import {
  HookEvalIntegrityError,
  assertAcceptanceComparableIdentity,
  assertReplicatedMemberIdentity,
  assertEvalNowConfig,
  type HookRunReport,
} from "../../src/eval/hook-run.ts";
import { validateIdentityShape, parseEvalNowTimestamp, type RunIdentity } from "../../src/eval/run-identity.ts";

function identity(over: Partial<RunIdentity["ranking_policy"] & Record<string, unknown>> = {}, drawFp = "aaaa111111111111"): RunIdentity {
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
    // Turn-56 (codex t55 F1): comparison surfaces fail closed on an ABSENT
    // eval_now — the fixture records the explicit wall-clock state.
    eval_now: null,
    // Codex t76: comparison surfaces fail closed on an ABSENT vector_exec —
    // the fixture records the in-process protocol explicitly.
    vector_exec: { protocol: "in-process", prewarm: "n/a", response_protocol: "n/a" },
    // O1 §4: members fail closed on an ABSENT deadline_protocol — the fixture records the contract.
    deadline_protocol: "monotonic-relative-v1",
    ranking_policy: { rerank_lane_weight: 1.5, fusion_policy_rev: 6, expansion_set: `draw:${drawFp}`, degeneracy_gate: "on", ...(over as object) },
  } as RunIdentity;
}

/** A complete HookAggregate — the shared baseline parser refuses partial blocks. */
function fullAgg(): HookRunReport["aggregate"] {
  return {
    cases: 12, ndcgMean: 0.7, mustNotCaseRate: 0, mustNotDocRate: 0,
    mustIncludeRecallMean: 1, abstentionAccuracy: 1, falseAbstainRate: 0,
    priorLegAccuracy: 1, latencyP50Ms: 400, latencyP95Ms: 900, timeoutRate: 0,
  } as HookRunReport["aggregate"];
}

type AxisRow = { metric: string; baseline: number | null; candidate: number | null; pass: boolean | null };

/**
 * The COMPLETE acceptance-axis set (turn-42 F1: the member validator refuses
 * anything less than exactly what computeAcceptance emits), with per-metric
 * overrides for the tests that vary one axis.
 */
function fullAxes(over: Record<string, Partial<AxisRow>> = {}): AxisRow[] {
  const base: Record<string, AxisRow> = {
    ndcgMean: { metric: "ndcgMean", baseline: 0.7, candidate: 0.72, pass: true },
    mustIncludeRecallMean: { metric: "mustIncludeRecallMean", baseline: 1, candidate: 1, pass: true },
    abstentionAccuracy: { metric: "abstentionAccuracy", baseline: 1, candidate: 1, pass: true },
    priorLegAccuracy: { metric: "priorLegAccuracy", baseline: 1, candidate: 1, pass: true },
    mustNotCaseRate: { metric: "mustNotCaseRate", baseline: 0, candidate: 0, pass: true },
    timeoutRate: { metric: "timeoutRate", baseline: 0, candidate: 0, pass: true },
    latencyP50Ms: { metric: "latencyP50Ms", baseline: 400, candidate: 420, pass: true },
    latencyP95Ms: { metric: "latencyP95Ms", baseline: 900, candidate: 920, pass: true },
  };
  for (const [k, v] of Object.entries(over)) base[k] = { ...base[k]!, ...v };
  return Object.values(base);
}

/** Minimal member report carrying exactly what the aggregator reads — and enough to pass parseBaselineReport when written to disk. */
function report(runId: string, drawFp: string, over: Partial<{
  trust: boolean;
  acceptancePass: boolean | null;
  acceptanceMode: "unconditional" | "conditional" | "failed" | null;
  axes: AxisRow[];
  pair: { partner: string; valid: number; exposed: number } | null;
  identity: RunIdentity;
}> = {}): HookRunReport {
  const trust = over.trust ?? true;
  const mode = over.acceptanceMode === undefined ? "unconditional" : over.acceptanceMode;
  // A "failed" acceptance must carry a genuinely failing axis, and a
  // "conditional" one a waived-null axis — the member validator refuses a
  // verdict that disagrees with its own axes (turn-41 F1).
  const axes = over.axes ?? fullAxes(
    mode === "failed" ? { ndcgMean: { candidate: 0.55, pass: false } }
    : mode === "conditional" ? { latencyP95Ms: { candidate: null, pass: null } }
    : {},
  );
  const pair = over.pair === undefined ? { partner: `partner-${drawFp}`, valid: 10, exposed: 4 } : over.pair;
  // Per-case outcome LEDGER (turn-44): every summary must reconcile with the
  // case rows, so the fixture derives its rows FROM the pair spec — the
  // first `valid` of 10 rows are valid pairs (all base-exposed), the first
  // `exposed` of those are treatment-exposed; leadgen/rankdefect are REAL
  // case ids (the witness receipts must reconcile).
  const caseRows = Array.from({ length: 10 }, (_, i) => {
    const id = i === 0 ? "leadgen" : i === 1 ? "rankdefect" : `c${i + 1}`;
    const valid = pair !== null && i < pair.valid;
    return {
      id, split: "holdout", profile: "deep",
      ...(pair !== null ? { pair_valid: valid, pair_base_exposed: valid, pair_treatment_exposed: valid && i < pair.exposed } : {}),
    } as unknown as HookRunReport["cases"][number];
  });
  return {
    run_id: runId,
    surface: "context-surfacing",
    vector_leg_records: [],
    created_at: "2026-08-14T00:00:00.000Z",
    gold_path: "gold.jsonl", db_path: null, clawmem_version: null,
    limit: 10, budget_ms: 30000, min_examples: 1, audit_attested: true,
    secondary_vaults: "suppressed",
    examples_total: 12, examples_scored: 12,
    identity: over.identity ?? identity({}, drawFp),
    aggregate: fullAgg(),
    by_split: { holdout: fullAgg() },
    enforced_invariant_violations: 0,
    observed_invariant_violations: 0,
    cases: caseRows,
    unresolved_labels: [],
    acceptance: mode === null ? null : {
      baseline_run_id: pair ? pair.partner : "base-x",
      slice: "holdout",
      axes: axes.map(a => ({ ...a })),
      pass: over.acceptancePass ?? (mode !== "failed"),
      mode,
      waived: mode === "conditional" ? ["latencyP95Ms"] : [],
      notes: [],
    },
    pair_audit: pair === null ? null : {
      partner_run_id: pair.partner, partner_dir: "/tmp/x",
      min_valid: 8, max_retries: 2, valid: pair.valid, invalid: 0, retried: 0,
      required_ids: ["leadgen", "rankdefect"],
      min_valid_by_stratum: {}, min_exposed_by_stratum: { deep: 2 },
      registered_treatments: ["degeneracy_gate"],
      treatment_contrast: { degeneracy_gate: { candidate: "on", partner: "off" } },
      treatment_exposed: pair.exposed,
      valid_by_stratum: { deep: pair.valid, holdout: pair.valid },
      treatment_exposed_by_stratum: { deep: pair.exposed, holdout: pair.exposed },
      witness_outcomes: [
        { id: "leadgen", valid: true, base_exposed: true },
        { id: "rankdefect", valid: true, base_exposed: true },
      ],
      invalid_cases: [],
    },
    finalization: { samples: 0, max_ms: null, p95_ms: null, reserve_ms: 1200, fits: null },
    finalization_breakdown: null,
    vector_deadline: { samples: 0, max_over_ms: null, worst: null, tolerance_ms: 150, adhered: null },
    admission_basis_counts: null,
    budget_elapsed: { samples: 0, max_ms: null, budget_ms: 30000, tolerance_ms: 50, within: null },
    gates: {
      trust_pass: trust,
      acceptance_pass: mode === null ? null : (over.acceptancePass ?? (mode !== "failed")),
      acceptance_waived: mode === "conditional" ? ["latencyP95Ms"] : [],
      finalization_reserve_ok: null, budget_elapsed_ok: null, vector_deadline_ok: null,
      pass: trust && mode === "unconditional",
      reasons: [],
    },
  } as HookRunReport;
}

const m = (runId: string, drawFp: string, over: Parameters<typeof report>[2] = {}) =>
  ({ dir: `/runs/${runId}`, report: report(runId, drawFp, over) });

describe("aggregateReplicatedRuns — structure", () => {
  it("aggregates 3 draws into a replicated identity that passes the SHARED validator — machine-marked PILOT, never a product pass (codex turn-41 F5)", () => {
    const agg = aggregateReplicatedRuns([m("r1", "cccc"), m("r2", "aaaa"), m("r3", "bbbb")]);
    expect(agg.n).toBe(3);
    expect(agg.identity.ranking_policy!.expansion_set).toBe("replicated:3");
    expect(agg.identity.ranking_policy!.expansion_draws).toEqual(["aaaa", "bbbb", "cccc"]);
    // The shared validator accepts the built identity (self-check already ran; prove it here too).
    expect(() => validateIdentityShape(agg.identity as unknown, (msg: string): never => { throw new Error(msg); })).not.toThrow();
    expect(agg.gates.trust_all_pass).toBe(true);
    expect(agg.gates.acceptance_all_pass).toBe(true);
    expect(agg.gates.pair_all_present).toBe(true);
    // n=3 < REPLICATED_SHIPPING_MIN_DRAWS: valid evidence, non-shipping.
    expect(agg.pilot).toBe(true);
    expect(agg.gates.pass).toBe(false);
    expect(agg.gates.reasons.join("\n")).toContain("PILOT");
    expect(agg.members.map(x => x.draw)).toEqual(["cccc", "aaaa", "bbbb"]); // member order preserved in evidence
  });

  it("a 5-draw aggregate with one consistent contrast SHIPS: pilot false, pass true, the experiment recorded (codex turn-41 F4/F5)", () => {
    const agg = aggregateReplicatedRuns([m("r1", "aaaa"), m("r2", "bbbb"), m("r3", "cccc"), m("r4", "dddd"), m("r5", "eeee")]);
    expect(agg.n).toBe(REPLICATED_SHIPPING_MIN_DRAWS);
    expect(agg.pilot).toBe(false);
    expect(agg.gates.pass).toBe(true);
    expect(agg.treatment).toEqual({
      registered: ["degeneracy_gate"],
      contrast: { degeneracy_gate: { candidate: "on", partner: "off" } },
    });
  });

  it("refuses fewer than 2 members", () => {
    expect(() => aggregateReplicatedRuns([m("r1", "aaaa")])).toThrow(/n >= 2/);
  });

  it("refuses a duplicate draw — n copies of one draw are one draw", () => {
    expect(() => aggregateReplicatedRuns([m("r1", "aaaa"), m("r2", "aaaa")])).toThrow(/appears on more than one member/);
  });

  it("refuses a member that is not a frozen draw (sampled)", () => {
    const sampled = m("r2", "bbbb");
    sampled.report.identity!.ranking_policy!.expansion_set = "sampled";
    expect(() => aggregateReplicatedRuns([m("r1", "aaaa"), sampled])).toThrow(/frozen-draw member runs only/);
  });

  it("refuses a member with no ranking_policy (legacy — the draw protocol is unidentified)", () => {
    const legacy = m("r2", "bbbb");
    delete (legacy.report.identity as { ranking_policy?: unknown }).ranking_policy;
    expect(() => aggregateReplicatedRuns([m("r1", "aaaa"), legacy])).toThrow(/predates ranking_policy/);
  });

  it("refuses members that differ outside the draw (the arm identity is one identity)", () => {
    const other = m("r2", "bbbb");
    other.report.identity!.ranking_policy!.rerank_lane_weight = 0;
    expect(() => aggregateReplicatedRuns([m("r1", "aaaa"), other])).toThrow(/does not share the arm identity/);
    const otherCorpus = m("r3", "cccc");
    otherCorpus.report.identity!.corpus = "different";
    expect(() => aggregateReplicatedRuns([m("r1", "aaaa"), otherCorpus])).toThrow(/does not share the arm identity/);
  });

  it("refuses a gate-toggle difference between members — the toggle is a treatment, and one arm runs ONE policy", () => {
    const other = m("r2", "bbbb");
    other.report.identity!.ranking_policy!.degeneracy_gate = "off";
    expect(() => aggregateReplicatedRuns([m("r1", "aaaa"), other])).toThrow(/does not share the arm identity/);
  });

  it("refuses an unidentifiable pipeline on ANY member (local fallback allowed, unattested)", () => {
    const loose = m("r2", "bbbb");
    loose.report.identity!.topology.local_fallback = "allowed";
    expect(() => aggregateReplicatedRuns([m("r1", "aaaa"), loose])).toThrow(/unidentifiable/);
  });

  it("refuses mixed pair-gate presence and mixed acceptance presence (one protocol per arm)", () => {
    expect(() => aggregateReplicatedRuns([m("r1", "aaaa"), m("r2", "bbbb", { pair: null })])).toThrow(/pair-gated/);
    expect(() => aggregateReplicatedRuns([m("r1", "aaaa"), m("r2", "bbbb", { acceptanceMode: null })])).toThrow(/acceptance comparison/);
  });
});

describe("aggregateReplicatedRuns — gates and axes", () => {
  it("a trust-failing member yields a FAILING aggregate (artifact, not refusal) naming the run", () => {
    const agg = aggregateReplicatedRuns([m("r1", "aaaa"), m("r2", "bbbb", { trust: false })]);
    expect(agg.gates.trust_all_pass).toBe(false);
    expect(agg.gates.pass).toBe(false);
    expect(agg.gates.reasons.join("\n")).toContain("r2");
  });

  it("a failed per-draw acceptance fails the aggregate; a CONDITIONAL draw can never aggregate into an unconditional pass", () => {
    const failed = aggregateReplicatedRuns([m("r1", "aaaa"), m("r2", "bbbb", { acceptanceMode: "failed", acceptancePass: false })]);
    expect(failed.gates.acceptance_all_pass).toBe(false);
    expect(failed.gates.pass).toBe(false);

    const conditional = aggregateReplicatedRuns([m("r1", "aaaa"), m("r2", "bbbb", { acceptanceMode: "conditional", acceptancePass: true })]);
    expect(conditional.gates.acceptance_all_pass).toBe(true);
    expect(conditional.gates.pass).toBe(false);
    expect(conditional.gates.reasons.join("\n")).toContain("CONDITIONAL");
  });

  it("a trust-only arm (no acceptance anywhere) reports acceptance null and never passes", () => {
    const agg = aggregateReplicatedRuns([m("r1", "aaaa", { acceptanceMode: null }), m("r2", "bbbb", { acceptanceMode: null })]);
    expect(agg.gates.acceptance_all_pass).toBeNull();
    expect(agg.gates.pass).toBe(false);
    expect(agg.axes).toEqual([]);
  });

  it("axes aggregate per-draw values: means, range, delta mean, direction stability, and fail-closed all_pass", () => {
    const agg = aggregateReplicatedRuns([
      m("r1", "aaaa", { axes: fullAxes({ ndcgMean: { baseline: 0.70, candidate: 0.80 } }) }),
      m("r2", "bbbb", { axes: fullAxes({ ndcgMean: { baseline: 0.72, candidate: 0.70 } }) }),
      m("r3", "cccc", { axes: fullAxes({ ndcgMean: { baseline: 0.71, candidate: 0.75 } }) }),
    ]);
    const ax = agg.axes.find(a => a.metric === "ndcgMean")!;
    expect(ax.all_pass).toBe(true);
    expect(ax.baseline_mean).toBeCloseTo((0.70 + 0.72 + 0.71) / 3, 10);
    expect(ax.candidate_mean).toBeCloseTo((0.80 + 0.70 + 0.75) / 3, 10);
    expect(ax.candidate_min).toBeCloseTo(0.70, 10);
    expect(ax.candidate_max).toBeCloseTo(0.80, 10);
    expect(ax.delta_mean).toBeCloseTo((0.10 - 0.02 + 0.04) / 3, 10);
    // Deltas +0.10, -0.02, +0.04 straddle zero — NOT direction-stable.
    expect(ax.direction_stable).toBe(false);
  });

  it("direction_stable is true when every measured delta shares a sign, and an unmeasured draw fails all_pass closed", () => {
    const agg = aggregateReplicatedRuns([
      m("r1", "aaaa", { axes: fullAxes({ ndcgMean: { baseline: 0.70, candidate: 0.75 } }) }),
      m("r2", "bbbb", { axes: fullAxes({ ndcgMean: { baseline: 0.70, candidate: 0.70 } }) }),
      // An unmeasured-undeclared axis makes the member's OWN acceptance
      // "failed" — the semantically consistent shape (turn-41 F1 refuses a
      // pass verdict over a null axis).
      m("r3", "cccc", { acceptanceMode: "failed", axes: fullAxes({ ndcgMean: { baseline: null, candidate: null, pass: null } }) }),
    ]);
    const ax = agg.axes.find(a => a.metric === "ndcgMean")!;
    expect(ax.direction_stable).toBe(true); // +0.05 and 0 share the non-negative sign
    expect(ax.all_pass).toBe(false);        // the unmeasured draw fails closed
  });
});

describe("replicated-vs-replicated identity comparability (the acceptance rule)", () => {
  const replicatedIdentity = (draws: string[]): RunIdentity => {
    const id = identity();
    id.ranking_policy = { ...id.ranking_policy!, expansion_set: `replicated:${draws.length}`, expansion_draws: [...draws].sort() };
    return id;
  };

  it("equal n with IDENTICAL draw sets is comparable — noted as the draw-paired form", () => {
    const r = assertAcceptanceComparableIdentity(replicatedIdentity(["a", "b", "c"]), replicatedIdentity(["a", "b", "c"]), "base-1");
    expect(r.notes.join("\n")).toContain("IDENTICAL draw sets");
  });

  it("equal n with independent draw sets is comparable — noted as a distributional comparison", () => {
    const r = assertAcceptanceComparableIdentity(replicatedIdentity(["a", "b", "c"]), replicatedIdentity(["x", "y", "z"]), "base-1");
    expect(r.notes.join("\n")).toContain("independent draw sets");
  });

  it("unequal n refuses (replicated:3 vs replicated:2), and replicated-vs-sampled refuses", () => {
    expect(() => assertAcceptanceComparableIdentity(replicatedIdentity(["a", "b", "c"]), replicatedIdentity(["x", "y"]), "base-1")).toThrow(HookEvalIntegrityError);
    const sampled = identity();
    sampled.ranking_policy = { ...sampled.ranking_policy!, expansion_set: "sampled" };
    expect(() => assertAcceptanceComparableIdentity(replicatedIdentity(["a", "b"]), sampled, "base-1")).toThrow(HookEvalIntegrityError);
  });
});

describe("evaluation-clock identity on every comparison surface (codex t55 F1) + strict parser (CR-6)", () => {
  const withClock = (clock: string | null | undefined, drawFp = "aaaa111111111111"): RunIdentity => {
    const id = identity({}, drawFp);
    if (clock === undefined) delete (id as unknown as Record<string, unknown>).eval_now;
    else (id as unknown as Record<string, unknown>).eval_now = clock;
    return id;
  };

  it("acceptance: differing clocks refuse; equal pinned clocks and explicit wall-clock (null/null) compare", () => {
    expect(() => assertAcceptanceComparableIdentity(withClock("2026-08-25T00:00:00.000Z"), withClock("2026-08-25T01:00:00.000Z"), "base-1"))
      .toThrow(/eval_now/);
    expect(() => assertAcceptanceComparableIdentity(withClock(null), withClock("2026-08-25T00:00:00.000Z"), "base-1"))
      .toThrow(/eval_now/);
    expect(() => assertAcceptanceComparableIdentity(withClock("2026-08-25T00:00:00.000Z"), withClock("2026-08-25T00:00:00.000Z"), "base-1")).not.toThrow();
    expect(() => assertAcceptanceComparableIdentity(withClock(null), withClock(null), "base-1")).not.toThrow();
  });

  it("FAIL-CLOSED on a pre-turn-55 identity: an ABSENT eval_now refuses, naming the side", () => {
    expect(() => assertAcceptanceComparableIdentity(withClock(null), withClock(undefined), "base-1"))
      .toThrow(/baseline predates eval_now recording/);
    expect(() => assertAcceptanceComparableIdentity(withClock(undefined), withClock(null), "base-1"))
      .toThrow(/candidate predates eval_now recording/);
  });

  it("replicated MEMBERS on different clocks refuse — an aggregate must not mix clocks (t55 F1)", () => {
    expect(() => assertReplicatedMemberIdentity(withClock("2026-08-25T00:00:00.000Z", "bbbb222222222222"), withClock(null), "ref-1"))
      .toThrow(/eval_now/);
    expect(() => assertReplicatedMemberIdentity(withClock(null, "bbbb222222222222"), withClock(null), "ref-1")).not.toThrow();
    // t56 F1 (aggregate half): separately launched draws sharing ONE
    // experiment clock are comparable members — the experiment-clock script
    // proves the sharing; this proves the aggregate accepts it.
    expect(() => assertReplicatedMemberIdentity(withClock("2026-08-25T00:00:00Z", "bbbb222222222222"), withClock("2026-08-25T00:00:00Z"), "ref-1")).not.toThrow();
  });

  it("parseEvalNowTimestamp accepts ONLY canonical ISO-8601 UTC (CR-6)", () => {
    expect(parseEvalNowTimestamp("2026-08-25T10:00:00Z")?.toISOString()).toBe("2026-08-25T10:00:00.000Z");
    expect(parseEvalNowTimestamp("2026-08-25T10:00:00.123Z")?.toISOString()).toBe("2026-08-25T10:00:00.123Z");
    // JS-permissive forms the old parser accepted must all refuse.
    expect(parseEvalNowTimestamp("2026-08-25 10:00:00Z")).toBeNull();
    expect(parseEvalNowTimestamp("2026-08-25")).toBeNull();
    expect(parseEvalNowTimestamp("2026-08-25T10:00:00+02:00")).toBeNull();
    expect(parseEvalNowTimestamp("2026-8-1T0:0:0Z")).toBeNull();
    expect(parseEvalNowTimestamp("tomorrow")).toBeNull();
    expect(parseEvalNowTimestamp("2026-13-40T00:00:00Z")).toBeNull(); // shape-valid, calendar-impossible
    expect(parseEvalNowTimestamp("")).toBeNull();
  });

  it("identity validation uses the SAME strict parser — a noncanonical eval_now is a shape error", () => {
    const bad = (id: unknown) => { let msg = ""; try { validateIdentityShape(id, (m: string): never => { msg = m; throw new Error(m); }); } catch { /* expected */ } return msg; };
    expect(bad({ ...withClock("2026-08-25 10:00:00Z") })).toContain("eval_now");
    expect(bad({ ...withClock("2026-08-25T10:00:00+02:00") })).toContain("eval_now");
    expect(() => validateIdentityShape(withClock("2026-08-25T10:00:00Z"), (m: string): never => { throw new Error(m); })).not.toThrow();
    expect(() => validateIdentityShape(withClock(null), (m: string): never => { throw new Error(m); })).not.toThrow();
  });

  it("assertEvalNowConfig refuses a present-but-invalid clock BEFORE scoring; unset/empty is wall clock", () => {
    expect(() => assertEvalNowConfig("garbage")).toThrow(/CLAWMEM_EVAL_NOW/);
    expect(() => assertEvalNowConfig("2026-08-25 10:00:00Z")).toThrow(/canonical ISO-8601/);
    expect(() => assertEvalNowConfig("2026-08-25T10:00:00Z")).not.toThrow();
    expect(() => assertEvalNowConfig(undefined)).not.toThrow();
    expect(() => assertEvalNowConfig("")).not.toThrow();
  });
});

describe("artifacts + dir loading", () => {
  const dir = mkdtempSync(join(tmpdir(), "clawmem-replicated-test-"));
  afterAll(() => { rmSync(dir, { recursive: true, force: true }); });

  it("aggregateReplicatedRunDirs parses each member with baseline-grade validation and the artifacts round-trip", () => {
    const d1 = join(dir, "run1"); const d2 = join(dir, "run2");
    mkdirSync(d1); mkdirSync(d2);
    writeFileSync(join(d1, "hook-run.json"), JSON.stringify(report("r1", "aaaa")));
    writeFileSync(join(d2, "hook-run.json"), JSON.stringify(report("r2", "bbbb")));
    const agg = aggregateReplicatedRunDirs([d1, d2]);
    expect(agg.n).toBe(2);
    expect(agg.members.map(x => x.dir)).toEqual([d1, d2]);

    const out = join(dir, "agg");
    const { jsonPath, mdPath } = writeReplicatedArtifacts(agg, out);
    expect(existsSync(jsonPath)).toBe(true);
    const roundTrip = JSON.parse(readFileSync(jsonPath, "utf-8"));
    expect(roundTrip.identity.ranking_policy.expansion_set).toBe("replicated:2");
    const md = readFileSync(mdPath, "utf-8");
    expect(md).toContain("replicated:2");
    expect(md).toContain("r1");
    expect(renderReplicatedMd(agg)).toContain("Members");
  });

  it("a malformed member file refuses through the shared baseline parser", () => {
    const d3 = join(dir, "run3");
    mkdirSync(d3);
    writeFileSync(join(d3, "hook-run.json"), JSON.stringify({ nope: true }));
    expect(() => aggregateReplicatedRunDirs([join(dir, "run1"), d3])).toThrow(HookEvalIntegrityError);
  });
});

describe("member-report validation (codex turn-40 F1) + pair-required pass (F3)", () => {
  it("a string 'false' in gates.trust_pass is refused, never truthy", () => {
    const bad = m("r2", "bbbb");
    (bad.report.gates as unknown as Record<string, unknown>).trust_pass = "false";
    expect(() => aggregateReplicatedRuns([m("r1", "aaaa"), bad])).toThrow(/not a boolean/);
  });

  it("a malformed acceptance axis number is refused before it reaches the mean/min/max arithmetic", () => {
    const bad = m("r2", "bbbb");
    (bad.report.acceptance!.axes[0] as unknown as Record<string, unknown>).candidate = "0.72";
    expect(() => aggregateReplicatedRuns([m("r1", "aaaa"), bad])).toThrow(/not finite-or-null/);
  });

  it("gates.acceptance_pass disagreeing with acceptance.pass is refused — the report was not written by this code", () => {
    const bad = m("r2", "bbbb");
    (bad.report.gates as unknown as Record<string, unknown>).acceptance_pass = false;
    expect(() => aggregateReplicatedRuns([m("r1", "aaaa"), bad])).toThrow(/disagrees with acceptance.pass/);
  });

  it("an 'unconditional' acceptance carrying waivers is refused", () => {
    const bad = m("r2", "bbbb");
    (bad.report.acceptance as unknown as Record<string, unknown>).waived = ["latencyP95Ms"];
    expect(() => aggregateReplicatedRuns([m("r1", "aaaa"), bad])).toThrow(/unconditional.*waivers|waivers are recorded/);
  });

  it("an acceptance baseline that is not the pair partner is refused (pair-gated acceptance is against the PARTNER)", () => {
    const bad = m("r2", "bbbb");
    (bad.report.acceptance as unknown as Record<string, unknown>).baseline_run_id = "some-third-run";
    expect(() => aggregateReplicatedRuns([m("r1", "aaaa"), bad])).toThrow(/not the paired experiment|pair partner/);
  });

  it("unconditional acceptance WITHOUT any pair gate can no longer produce a product pass (codex turn-40 F3)", () => {
    const agg = aggregateReplicatedRuns([
      m("r1", "aaaa", { pair: null }),
      m("r2", "bbbb", { pair: null }),
    ]);
    expect(agg.gates.acceptance_all_pass).toBe(true);
    expect(agg.gates.pair_all_present).toBe(false);
    expect(agg.gates.pass).toBe(false);
    expect(agg.gates.reasons.join("\n")).toContain("pre-treatment equality is unverified");
  });
});

describe("turn-41: one consistent contrast + semantic acceptance validation + pilot", () => {
  it("members with DIFFERENT contrasts (or a replicate-audit member among treated pairs) refuse — one artifact, one experiment (F41-4)", () => {
    const other = m("r2", "bbbb");
    (other.report.pair_audit as unknown as Record<string, unknown>).registered_treatments = [];
    (other.report.pair_audit as unknown as Record<string, unknown>).treatment_contrast = {};
    expect(() => aggregateReplicatedRuns([m("r1", "aaaa"), other])).toThrow(/do not share ONE experiment/);
  });

  it("a recorded NO-OP contrast (equal candidate/partner values) is refused at member validation (F41-3)", () => {
    const noop = m("r2", "bbbb");
    (noop.report.pair_audit as unknown as { treatment_contrast: Record<string, unknown> }).treatment_contrast = { degeneracy_gate: { candidate: "on", partner: "on" } };
    expect(() => aggregateReplicatedRuns([m("r1", "aaaa"), noop])).toThrow(/no-op treatment contrast/);
  });

  it("a pre-turn-41 member (no registered_treatments/contrast in pair_audit) is refused, not silently aggregated", () => {
    const legacy = m("r2", "bbbb");
    delete (legacy.report.pair_audit as unknown as Record<string, unknown>).registered_treatments;
    delete (legacy.report.pair_audit as unknown as Record<string, unknown>).treatment_contrast;
    expect(() => aggregateReplicatedRuns([m("r1", "aaaa"), legacy])).toThrow(/pre-turn-41 report/);
  });

  it("acceptance.pass disagreeing with its own axes is refused — pass=true over a failed axis (F41-1)", () => {
    const lying = m("r2", "bbbb");
    (lying.report.acceptance!.axes[0] as unknown as Record<string, unknown>).pass = false;
    // gates.acceptance_pass and acceptance.pass still claim true — the axes say otherwise.
    expect(() => aggregateReplicatedRuns([m("r1", "aaaa"), lying])).toThrow(/disagrees with its evidence/);
  });

  it("duplicate acceptance axis metric names are refused (F41-1)", () => {
    const dup = m("r2", "bbbb");
    dup.report.acceptance!.axes.push({ ...dup.report.acceptance!.axes[0]! });
    expect(() => aggregateReplicatedRuns([m("r1", "aaaa"), dup])).toThrow(/duplicate acceptance axis metric/);
  });
});

describe("turn-42: complete axis set + one protocol + machine-decisive shipping exposure", () => {
  it("a member missing axis evidence is refused — recall/damage/timeout/latency cannot be omitted (F42-1)", () => {
    const partial = m("r2", "bbbb", { axes: fullAxes().filter(a => a.metric === "ndcgMean") });
    expect(() => aggregateReplicatedRuns([m("r1", "aaaa"), partial])).toThrow(/missing required axis evidence/);
  });

  it("an unknown axis metric is refused (F42-1)", () => {
    const alien = m("r2", "bbbb", { axes: [...fullAxes(), { metric: "vibes", baseline: 1, candidate: 1, pass: true }] });
    expect(() => aggregateReplicatedRuns([m("r1", "aaaa"), alien])).toThrow(/unknown metric/);
  });

  it("members under DIFFERENT pair-gate protocols refuse — one artifact, one pre-registration (F42-4)", () => {
    const other = m("r2", "bbbb");
    (other.report.pair_audit as unknown as { min_valid: number }).min_valid = 9;
    expect(() => aggregateReplicatedRuns([m("r1", "aaaa"), other])).toThrow(/do not share ONE experiment/);
    const otherWitness = m("r3", "cccc");
    (otherWitness.report.pair_audit as unknown as { required_ids: string[] }).required_ids = ["leadgen"];
    expect(() => aggregateReplicatedRuns([m("r1", "aaaa"), otherWitness])).toThrow(/do not share ONE experiment/);
  });

  it("the shared protocol is preserved in the artifact", () => {
    const agg = aggregateReplicatedRuns([m("r1", "aaaa"), m("r2", "bbbb")]);
    expect(agg.pair_protocol).toEqual({
      min_valid: 8, max_retries: 2, required_ids: ["leadgen", "rankdefect"],
      min_valid_by_stratum: {}, min_exposed_by_stratum: { deep: 2 },
      min_basis_by_stratum: {},
    });
  });

  it("a SHIPPING registered-treatment aggregate with NO exposure pre-registration cannot pass (F42-4)", () => {
    const members = ["aaaa", "bbbb", "cccc", "dddd", "eeee"].map((fp, i) => {
      const mem = m(`r${i + 1}`, fp);
      (mem.report.pair_audit as unknown as { min_exposed_by_stratum: Record<string, number> }).min_exposed_by_stratum = {};
      return mem;
    });
    const agg = aggregateReplicatedRuns(members);
    expect(agg.pilot).toBe(false);
    expect(agg.gates.pass).toBe(false);
    expect(agg.gates.reasons.join("\n")).toContain("NO pre-registered treatment-exposure minimum");
  });

  it("a zero-firing member under a declared exposure minimum is REFUSED outright — the run-time gate would have refused that run, so the report was not written by this code (F42-4, tightened by F43-2)", () => {
    const members = ["aaaa", "bbbb", "cccc", "dddd", "eeee"].map((fp, i) =>
      m(`r${i + 1}`, fp, { pair: { partner: `partner-${fp}`, valid: 10, exposed: 0 } }));
    expect(() => aggregateReplicatedRuns(members)).toThrow(/min_exposed_by_stratum\.deep=2 is not satisfied/);
  });

  it("the PILOT intentionally omits the exposure requirement — its reasons never demand a firing minimum", () => {
    const members = ["aaaa", "bbbb", "cccc"].map((fp, i) => {
      const mem = m(`r${i + 1}`, fp, { pair: { partner: `partner-${fp}`, valid: 10, exposed: 0 } });
      (mem.report.pair_audit as unknown as { min_exposed_by_stratum: Record<string, number> }).min_exposed_by_stratum = {};
      return mem;
    });
    const agg = aggregateReplicatedRuns(members);
    expect(agg.pilot).toBe(true);
    expect(agg.gates.pass).toBe(false); // pilot never passes — but only for the PILOT reason
    expect(agg.gates.reasons.join("\n")).not.toContain("exposure");
    expect(agg.gates.reasons.join("\n")).toContain("PILOT");
  });
});

describe("turn-43: canonical map ordering + per-stratum outcome evidence", () => {
  it("semantically identical protocols in different KEY ORDER are one experiment (F43-1)", () => {
    const a = m("r1", "aaaa");
    (a.report.pair_audit as unknown as { min_exposed_by_stratum: Record<string, number> }).min_exposed_by_stratum = { deep: 2, holdout: 1 };
    const b = m("r2", "bbbb");
    (b.report.pair_audit as unknown as { min_exposed_by_stratum: Record<string, number> }).min_exposed_by_stratum = { holdout: 1, deep: 2 };
    const agg = aggregateReplicatedRuns([a, b]);
    expect(agg.pair_protocol!.min_exposed_by_stratum).toEqual({ deep: 2, holdout: 1 });
  });

  it("scalar consistency: min_valid=0, valid<min_valid, exposed>valid, exposed_by>valid_by all refuse (F43-2)", () => {
    const zeroMin = m("r2", "bbbb");
    (zeroMin.report.pair_audit as unknown as { min_valid: number }).min_valid = 0;
    expect(() => aggregateReplicatedRuns([m("r1", "aaaa"), zeroMin])).toThrow(/min_valid is 0/);

    const shortValid = m("r3", "cccc", { pair: { partner: "partner-cccc", valid: 5, exposed: 4 } });
    // fixture min_valid is 8 — valid 5 < 8 is a run-time-refused outcome.
    expect(() => aggregateReplicatedRuns([m("r1", "aaaa"), shortValid])).toThrow(/below its own min_valid/);

    const overExposed = m("r4", "dddd");
    (overExposed.report.pair_audit as unknown as { treatment_exposed: number }).treatment_exposed = 99;
    expect(() => aggregateReplicatedRuns([m("r1", "aaaa"), overExposed])).toThrow(/exceeds valid pairs/);

    const overStratum = m("r5", "eeee");
    (overStratum.report.pair_audit as unknown as { treatment_exposed_by_stratum: Record<string, number> }).treatment_exposed_by_stratum = { deep: 99, holdout: 4 };
    expect(() => aggregateReplicatedRuns([m("r1", "aaaa"), overStratum])).toThrow(/exceeds valid_by_stratum/);
  });

  it("a declared PER-STRATUM minimum unmet in the RECORDED counts refuses even when the total would satisfy it — codex's tuning-vs-holdout example (F43-2)", () => {
    const skewed = m("r2", "bbbb");
    // Total exposed 4 >= max(minima)=2, but the deep stratum records 0.
    (skewed.report.pair_audit as unknown as { treatment_exposed_by_stratum: Record<string, number> }).treatment_exposed_by_stratum = { deep: 0, holdout: 4 };
    expect(() => aggregateReplicatedRuns([m("r1", "aaaa"), skewed])).toThrow(/min_exposed_by_stratum\.deep=2 is not satisfied/);
  });

  it("witness outcomes: a missing or failed required witness refuses (F43-2)", () => {
    const missing = m("r2", "bbbb");
    (missing.report.pair_audit as unknown as { witness_outcomes: unknown[] }).witness_outcomes = [{ id: "leadgen", valid: true, base_exposed: true }];
    expect(() => aggregateReplicatedRuns([m("r1", "aaaa"), missing])).toThrow(/lacks required witness "rankdefect"/);

    const failed = m("r3", "cccc");
    (failed.report.pair_audit as unknown as { witness_outcomes: unknown[] }).witness_outcomes = [
      { id: "leadgen", valid: true, base_exposed: false },
      { id: "rankdefect", valid: true, base_exposed: true },
    ];
    expect(() => aggregateReplicatedRuns([m("r1", "aaaa"), failed])).toThrow(/not base-exposed/);
  });

  it("a pre-turn-44 member (no per-stratum outcome records) is refused, never silently aggregated", () => {
    const legacy = m("r2", "bbbb");
    delete (legacy.report.pair_audit as unknown as Record<string, unknown>).valid_by_stratum;
    expect(() => aggregateReplicatedRuns([m("r1", "aaaa"), legacy])).toThrow(/pre-turn-44 report/);
  });
});

describe("turn-44: the per-case outcome LEDGER — summaries are derived, never trusted", () => {
  it("codex's forged shape is unrepresentable: treatment_exposed=0 with exposed_by_stratum.deep=2 refuses on reconciliation", () => {
    const forged = m("r2", "bbbb");
    const pa = forged.report.pair_audit as unknown as Record<string, unknown>;
    pa.treatment_exposed = 0;
    // exposed_by claims 2 while the ledger records 4 exposed rows — and the
    // total contradicts both. NOTHING here reconciles with the case rows.
    pa.treatment_exposed_by_stratum = { deep: 2, holdout: 2 };
    expect(() => aggregateReplicatedRuns([m("r1", "aaaa"), forged])).toThrow(/does not reconcile with the per-case ledger/);
  });

  it("a forged TOTAL (valid) that disagrees with the case rows refuses — the old fixture's own shape (codex proved it against us)", () => {
    const forged = m("r2", "bbbb");
    (forged.report.pair_audit as unknown as { valid: number }).valid = 9;
    (forged.report.pair_audit as unknown as { valid_by_stratum: Record<string, number> }).valid_by_stratum = { deep: 9, holdout: 9 };
    expect(() => aggregateReplicatedRuns([m("r1", "aaaa"), forged])).toThrow(/does not reconcile with the per-case ledger/);
  });

  it("duplicate case ids and witnesses that are not real case ids refuse", () => {
    const dup = m("r2", "bbbb");
    dup.report.cases.push({ ...dup.report.cases[0]! });
    expect(() => aggregateReplicatedRuns([m("r1", "aaaa"), dup])).toThrow(/duplicate case id/);

    const ghost = m("r3", "cccc");
    (ghost.report.pair_audit as unknown as { required_ids: string[] }).required_ids = ["leadgen", "rankdefect", "ghost-case"];
    (ghost.report.pair_audit as unknown as { witness_outcomes: unknown[] }).witness_outcomes = [
      { id: "leadgen", valid: true, base_exposed: true },
      { id: "rankdefect", valid: true, base_exposed: true },
      { id: "ghost-case", valid: true, base_exposed: true },
    ];
    // Protocol equality would refuse first on required_ids — give member r1 the same protocol.
    const r1 = m("r1", "aaaa");
    (r1.report.pair_audit as unknown as { required_ids: string[] }).required_ids = ["leadgen", "rankdefect", "ghost-case"];
    (r1.report.pair_audit as unknown as { witness_outcomes: unknown[] }).witness_outcomes = [
      { id: "leadgen", valid: true, base_exposed: true },
      { id: "rankdefect", valid: true, base_exposed: true },
      { id: "ghost-case", valid: true, base_exposed: true },
    ];
    expect(() => aggregateReplicatedRuns([r1, ghost])).toThrow(/not a scored case id/);
  });

  it("a witness receipt that disagrees with the ledger, and exposure without validity, refuse", () => {
    const badReceipt = m("r2", "bbbb", { pair: { partner: "partner-bbbb", valid: 1, exposed: 1 } });
    // Only row 0 (leadgen) is a valid pair; rankdefect's RECEIPT still claims
    // valid+base-exposed (the fixture default) — the ledger says otherwise.
    // Loosen the scalar/declared knobs so the WITNESS reconciliation is the
    // check that fires.
    const pa2 = badReceipt.report.pair_audit as unknown as Record<string, unknown>;
    pa2.valid = 1;
    pa2.invalid = 9;
    pa2.min_valid = 1;
    pa2.min_exposed_by_stratum = {};
    expect(() => aggregateReplicatedRuns([m("r1", "aaaa"), badReceipt])).toThrow(/does not reconcile with the per-case ledger/);

    const leak = m("r3", "cccc");
    (leak.report.cases[9] as unknown as Record<string, unknown>).pair_treatment_exposed = true; // row 9 valid... all 10 valid by default — flip validity off instead
    (leak.report.cases[9] as unknown as Record<string, unknown>).pair_valid = false;
    expect(() => aggregateReplicatedRuns([m("r1", "aaaa"), leak])).toThrow(/exposure without a valid pair/);
  });

  it("a pre-turn-45 member (case rows without the ledger flags) refuses with re-run guidance", () => {
    const legacy = m("r2", "bbbb");
    for (const c of legacy.report.cases) delete (c as unknown as Record<string, unknown>).pair_base_exposed;
    expect(() => aggregateReplicatedRuns([m("r1", "aaaa"), legacy])).toThrow(/pre-turn-45 report/);
  });
});

describe("turn-45: the exposure implication chain", () => {
  it("treatment exposure WITHOUT base exposure refuses on the SEMANTIC relation even when every summary reconciles (F45-2)", () => {
    const impossible = m("r2", "bbbb");
    // Row 2 (c3) is valid + treatment-exposed by the fixture; flip only its
    // base flag. No summary anywhere counts base exposure (witness receipts
    // cover leadgen/rankdefect only), so totals and stratum maps still
    // reconcile with the rows — ONLY the implication chain can refuse.
    (impossible.report.cases[2] as unknown as Record<string, unknown>).pair_base_exposed = false;
    expect(() => aggregateReplicatedRuns([m("r1", "aaaa"), impossible])).toThrow(/treatment exposure without base exposure/);
  });
});

describe("codex t68 F3: pre-registered admission-basis coverage", () => {
  const withBasis = (runId: string, fp: string, opts: { declared?: Record<string, number>; recorded?: Record<string, number> | null } = {}) => {
    const mem = m(runId, fp);
    const pa = mem.report.pair_audit as unknown as Record<string, unknown>;
    for (const r of mem.report.cases as unknown as { pair_valid?: boolean; admission_basis?: string }[]) {
      if (r.pair_valid) r.admission_basis = "rerank-fused-rrf";
    }
    const valid = pa.valid as number;
    pa.min_basis_by_stratum = opts.declared ?? {};
    if (opts.recorded === null) delete pa.valid_basis_by_stratum;
    else pa.valid_basis_by_stratum = opts.recorded ?? { "deep:rerank-fused-rrf": valid, "holdout:rerank-fused-rrf": valid };
    return mem;
  };

  it("declared minima satisfied: the shared protocol carries them and gates raise no basis reason", () => {
    const a = withBasis("r1", "aaaa", { declared: { "deep:rerank-fused-rrf": 2 } });
    const b = withBasis("r2", "bbbb", { declared: { "deep:rerank-fused-rrf": 2 } });
    const agg = aggregateReplicatedRuns([a, b]);
    expect(agg.pair_protocol!.min_basis_by_stratum).toEqual({ "deep:rerank-fused-rrf": 2 });
    expect(agg.gates.reasons.join("\n")).not.toContain("admission-basis");
  });

  it("recorded coverage below a declared minimum refuses — the run-time gate refuses that outcome", () => {
    const a = withBasis("r1", "aaaa", { declared: { "deep:rerank-fused-rrf": 11 } });
    const b = withBasis("r2", "bbbb", { declared: { "deep:rerank-fused-rrf": 11 } });
    expect(() => aggregateReplicatedRuns([a, b])).toThrow(/min_basis_by_stratum\.deep:rerank-fused-rrf=11 is not satisfied/);
  });

  it("O1 §4: a member without deadline_protocol is REFUSED — it measured wall-clock deadline semantics and cannot aggregate", () => {
    const a = m("r1", "aaaa111111111111");
    const b = m("r2", "bbbb222222222222");
    delete b.report.identity!.deadline_protocol;
    expect(() => aggregateReplicatedRuns([a, b])).toThrow(/records no deadline_protocol/);
  });

  it("declaring minima without recorded coverage refuses — not written by this code", () => {
    const a = withBasis("r1", "aaaa", { declared: { "deep:rerank-fused-rrf": 1 } });
    const b = withBasis("r2", "bbbb", { declared: { "deep:rerank-fused-rrf": 1 }, recorded: null });
    expect(() => aggregateReplicatedRuns([a, b])).toThrow(/records no valid_basis_by_stratum/);
  });

  it("recorded coverage must reconcile with the case rows' admission_basis (forged summary refused)", () => {
    const a = withBasis("r1", "aaaa", {});
    const forged = withBasis("r2", "bbbb", { recorded: { "deep:rerank-fused-rrf": 9, "holdout:rerank-fused-rrf": 9 } });
    expect(() => aggregateReplicatedRuns([a, forged])).toThrow(/valid_basis_by_stratum does not reconcile/);
  });

  it("members whose declared basis minima differ do not share ONE experiment", () => {
    const a = withBasis("r1", "aaaa", { declared: { "deep:rerank-fused-rrf": 2 } });
    const b = withBasis("r2", "bbbb", {});
    expect(() => aggregateReplicatedRuns([a, b])).toThrow(/do not share ONE experiment/);
  });
});
