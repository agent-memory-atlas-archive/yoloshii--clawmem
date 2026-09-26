/**
 * Replicated-distribution aggregation (BUILD-3d) — the distributional
 * acceptance protocol codex ruled in turn 18: "frozen paired draws for
 * causal experiments, replicated independent draws for distributional
 * acceptance". Expansion sampling variance is a first-order noise source on
 * deep behavior (violation load 3→8 across draws of the same arm in the
 * build2d evidence), so a single-draw deep comparison is a point estimate of
 * a distribution. This module aggregates n frozen-draw member runs of ONE
 * arm — each already trust-gated, pair-gated against its partner draw, and
 * acceptance-compared per draw — into one artifact whose identity is
 * `expansion_set = "replicated:<n>"` with the per-draw fingerprint list, so
 * distributional claims are itemizable and two aggregates compare via the
 * ordinary identity gate (replicated-vs-replicated at equal n).
 *
 * REFUSAL vs FAILURE: structural impossibilities (a member that is not a
 * frozen draw, duplicate draws, identity mismatch between members, mixed
 * pair/acceptance presence, an unidentifiable pipeline) REFUSE — the
 * aggregate would be meaningless. Trust/acceptance failures on a member
 * produce a FAILING aggregate (gates.pass false, artifact still written) —
 * the evidence is meaningful and preserved, mirroring the run-level report
 * contract.
 */
import { writeFileSync, mkdirSync } from "fs";
import { isoNow } from "../clock.ts";
import { join } from "path";
import { parseBaselineReport, HookEvalIntegrityError, assertReplicatedMemberIdentity, ACCEPTANCE_AXIS_METRICS, type HookRunReport, type AcceptanceAxis, deriveValidBasisByStratum } from "./hook-run.ts";
import { validateIdentityShape, PAIR_TREATMENTS, type RunIdentity, type PairTreatment } from "./run-identity.ts";

/** One acceptance axis summarized across the n member draws. */
export interface ReplicatedAxisSummary {
  metric: string;
  /** Per-draw values in member order (run_id names the draw run). */
  draws: { run_id: string; baseline: number | null; candidate: number | null; pass: boolean | null }[];
  /** Every draw's axis passed (false on any fail OR any unmeasured draw — fail-closed). */
  all_pass: boolean;
  baseline_mean: number | null;
  candidate_mean: number | null;
  candidate_min: number | null;
  candidate_max: number | null;
  /** Mean of per-draw (candidate - baseline) over draws where both are measured. */
  delta_mean: number | null;
  /**
   * All measured per-draw deltas share one sign (zeros count with either) —
   * the machine form of the build2d discipline that only cross-draw-stable
   * conclusions are claimed. Null when no delta is measurable.
   */
  direction_stable: boolean | null;
}

export interface ReplicatedMemberSummary {
  dir: string;
  run_id: string;
  /** Bare draw fingerprint (expansion_set "draw:<fp>" without the prefix). */
  draw: string;
  trust_pass: boolean;
  acceptance_pass: boolean | null;
  acceptance_mode: "unconditional" | "conditional" | "failed" | null;
  acceptance_baseline_run_id: string | null;
  pair_partner_run_id: string | null;
  pair_valid: number | null;
  pair_treatment_exposed: number | null;
  /** The member's registered treatments + actual contrast (codex turn-41 finding 4) — required identical across members. Null when not pair-gated. */
  pair_registered_treatments: PairTreatment[] | null;
  pair_treatment_contrast: Partial<Record<PairTreatment, { candidate: unknown; partner: unknown }>> | null;
  /** The member's full pair-gate PROTOCOL (codex turn-42 finding 4) — required identical across members. Null when not pair-gated. */
  pair_protocol: {
    min_valid: number;
    max_retries: number;
    required_ids: string[];
    min_valid_by_stratum: Record<string, number>;
    min_exposed_by_stratum: Record<string, number>;
    /** Pre-registered per-stratum admission-basis minima (codex t68 F3); {} on members that declared none. */
    min_basis_by_stratum: Record<string, number>;
  } | null;
}

/**
 * Minimum draws for a SHIPPING distributional acceptance (codex turn-40/41
 * ruling): below this the aggregate is a machine-marked PILOT — valid
 * evidence for pre-registering the shipping run, never product acceptance.
 */
export const REPLICATED_SHIPPING_MIN_DRAWS = 5;

export interface ReplicatedAggregate {
  schema: "replicated-aggregate-v1";
  created_at: string;
  n: number;
  /** n < REPLICATED_SHIPPING_MIN_DRAWS — machine-marked non-shipping (codex turn-41 finding 5); a pilot can never produce gates.pass=true. */
  pilot: boolean;
  members: ReplicatedMemberSummary[];
  /** Shared member identity with expansion_set "replicated:<n>" + the sorted per-draw fingerprint list. */
  identity: RunIdentity;
  /**
   * The ONE experiment this aggregate certifies (codex turn-41 finding 4):
   * the registered treatments and their shared candidate/partner contrast,
   * identical across every member by refusal. Null when members are not
   * pair-gated (which also blocks the product pass).
   */
  treatment: { registered: PairTreatment[]; contrast: Partial<Record<PairTreatment, { candidate: unknown; partner: unknown }>> } | null;
  /**
   * The ONE pair-gate protocol every member ran under (codex turn-42
   * finding 4): witnesses, valid/exposed minima, retry budget — identical
   * across members by refusal, preserved so the artifact states its full
   * pre-registration. Null when members are not pair-gated.
   */
  pair_protocol: ReplicatedMemberSummary["pair_protocol"];
  gates: {
    /** Every member run's own trust gate passed. */
    trust_all_pass: boolean;
    /** Every member's per-draw acceptance passed (null when the arm carried no acceptance comparisons). */
    acceptance_all_pass: boolean | null;
    /** Every member was pair-gated (false = none were; mixed presence REFUSES before this is written). */
    pair_all_present: boolean;
    /**
     * Unconditional distributional acceptance: trust on every draw,
     * acceptance passed on every draw, EVERY draw pair-gated (codex turn-40
     * finding 3 — unpaired per-draw acceptances are not paired evidence),
     * every AXIS passed on every draw (turn-41 finding 1 — the verdict never
     * outruns its evidence), n >= REPLICATED_SHIPPING_MIN_DRAWS (turn-41
     * finding 5 — a pilot is never product acceptance), and no draw's
     * acceptance was conditional (waived axes never aggregate into an
     * unconditional pass).
     */
    pass: boolean;
    reasons: string[];
  };
  axes: ReplicatedAxisSummary[];
  notes: string[];
}

function refuse(msg: string): never {
  throw new HookEvalIntegrityError(`replicated aggregate refused — ${msg}`);
}

const mean = (xs: number[]): number | null => (xs.length === 0 ? null : xs.reduce((a, b) => a + b, 0) / xs.length);

/**
 * Key-sorted shallow copy — the canonical form for the record-shaped
 * protocol/contrast members compared by JSON.stringify (codex turn-43
 * finding 1: {deep:4, holdout:2} and {holdout:2, deep:4} are the same
 * pre-registration and must never read as different experiments).
 */
function sortRecord<T>(rec: Record<string, T>): Record<string, T> {
  return Object.fromEntries(Object.entries(rec).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

/**
 * Baseline-grade validation of every member-report field this aggregator
 * CONSUMES (codex turn-40 finding 1): parseBaselineReport validates the
 * metrics/cases/identity a --baseline flow reads, but the aggregator also
 * trusts gates, acceptance (+axes), and pair_audit — a string "false" in
 * gates.trust_pass is truthy, and a malformed axis number would reach the
 * mean/min/max arithmetic unchecked. Types first, then CONSISTENCY: a
 * report whose gates disagree with its own acceptance block, whose
 * "unconditional" mode carries waivers, or whose acceptance baseline is not
 * its pair partner was not written by this code and is refused.
 */
function validateMemberReport(report: HookRunReport, where: string): void {
  const bad = (what: string): never => refuse(`member ${where}: ${what}`);
  const isBool = (v: unknown): v is boolean => typeof v === "boolean";
  const isFiniteOrNull = (v: unknown): boolean => v === null || (typeof v === "number" && Number.isFinite(v));
  const isStringArray = (v: unknown): v is string[] => Array.isArray(v) && v.every(x => typeof x === "string");

  const g = report.gates as unknown as Record<string, unknown> | null | undefined;
  if (!g || typeof g !== "object") bad("gates block missing or not an object");
  if (!isBool(g!.trust_pass)) bad(`gates.trust_pass is ${JSON.stringify(g!.trust_pass)}, not a boolean`);
  if (g!.acceptance_pass !== null && !isBool(g!.acceptance_pass)) bad(`gates.acceptance_pass is ${JSON.stringify(g!.acceptance_pass)}, not a boolean or null`);
  if (!isStringArray(g!.acceptance_waived)) bad("gates.acceptance_waived is not a string array");
  if (!isBool(g!.pass)) bad(`gates.pass is ${JSON.stringify(g!.pass)}, not a boolean`);

  const a = report.acceptance as unknown as Record<string, unknown> | null | undefined;
  if (a !== null && a !== undefined) {
    if (typeof a !== "object") bad("acceptance is not an object or null");
    if (typeof a.baseline_run_id !== "string" || a.baseline_run_id.length === 0) bad("acceptance.baseline_run_id is not a non-empty string");
    if (!isBool(a.pass)) bad(`acceptance.pass is ${JSON.stringify(a.pass)}, not a boolean`);
    if (a.mode !== "unconditional" && a.mode !== "conditional" && a.mode !== "failed") bad(`acceptance.mode is ${JSON.stringify(a.mode)}`);
    if (!isStringArray(a.waived)) bad("acceptance.waived is not a string array");
    if (!Array.isArray(a.axes)) bad("acceptance.axes is not an array");
    for (const ax of a.axes as unknown[]) {
      const x = ax as Record<string, unknown> | null;
      if (!x || typeof x !== "object") bad("acceptance.axes entry is not an object");
      if (typeof x!.metric !== "string" || x!.metric.length === 0) bad("acceptance axis has no metric name");
      if (!isFiniteOrNull(x!.baseline)) bad(`acceptance axis ${String(x!.metric)}: baseline ${JSON.stringify(x!.baseline)} is not finite-or-null`);
      if (!isFiniteOrNull(x!.candidate)) bad(`acceptance axis ${String(x!.metric)}: candidate ${JSON.stringify(x!.candidate)} is not finite-or-null`);
      if (x!.pass !== null && !isBool(x!.pass)) bad(`acceptance axis ${String(x!.metric)}: pass ${JSON.stringify(x!.pass)} is not boolean-or-null`);
    }
    // SEMANTIC consistency (codex turn-41 finding 1): the stored verdict must
    // agree with its own axes — a report claiming pass=true over a failed or
    // undeclared-unmeasured axis was not written by this code. Duplicate
    // metric names would make the per-metric aggregation silently ambiguous.
    const axes = a.axes as { metric: string; pass: boolean | null }[];
    const metricNames = axes.map(x => x.metric);
    if (new Set(metricNames).size !== metricNames.length) bad("duplicate acceptance axis metric names");
    // The COMPLETE axis set is required — exactly what computeAcceptance
    // emits (codex turn-42 finding 1): a report that omits the recall,
    // damage, timeout or latency evidence must never ship, and an unknown
    // metric was not written by this code. The canon list is execution-
    // verified inside computeAcceptance itself, so it cannot drift.
    const canon = new Set<string>(ACCEPTANCE_AXIS_METRICS);
    const missing = ACCEPTANCE_AXIS_METRICS.filter(mName => !metricNames.includes(mName));
    const unknown = metricNames.filter(mName => !canon.has(mName));
    if (missing.length > 0) bad(`acceptance.axes is missing required axis evidence: ${missing.join(", ")} — the complete computeAcceptance set is required`);
    if (unknown.length > 0) bad(`acceptance.axes carries unknown metric(s): ${unknown.join(", ")} — not written by this code`);
    const waivedSet = new Set(a.waived as string[]);
    const impliedPass = axes.every(x => x.pass === true || (x.pass === null && waivedSet.has(x.metric)));
    if ((a.pass as boolean) !== impliedPass) {
      bad(`acceptance.pass is ${String(a.pass)} but its own axes imply ${String(impliedPass)} (an axis ${impliedPass ? "set that passes" : "that failed or is unmeasured-undeclared"}) — the verdict disagrees with its evidence`);
    }
  }

  const p = report.pair_audit as unknown as Record<string, unknown> | null | undefined;
  if (p !== null && p !== undefined) {
    if (typeof p !== "object") bad("pair_audit is not an object or null");
    if (typeof p.partner_run_id !== "string" || p.partner_run_id.length === 0) bad("pair_audit.partner_run_id is not a non-empty string");
    for (const f of ["valid", "invalid", "retried", "treatment_exposed"] as const) {
      const v = p[f];
      if (typeof v !== "number" || !Number.isInteger(v) || v < 0) bad(`pair_audit.${f} is ${JSON.stringify(v)}, not a non-negative integer`);
    }
    if (!isStringArray(p.required_ids)) bad("pair_audit.required_ids is not a string array");
    // The pair-gate PROTOCOL fields the aggregate preserves and requires
    // identical across members (codex turn-42 finding 4).
    for (const f of ["min_valid", "max_retries"] as const) {
      const v = p[f];
      if (typeof v !== "number" || !Number.isInteger(v) || v < 0) bad(`pair_audit.${f} is ${JSON.stringify(v)}, not a non-negative integer`);
    }
    for (const f of ["min_valid_by_stratum", "min_exposed_by_stratum"] as const) {
      const rec = p[f];
      if (!rec || typeof rec !== "object" || Array.isArray(rec)) bad(`pair_audit.${f} is not an object`);
      for (const [k, v] of Object.entries(rec as Record<string, unknown>)) {
        if (typeof v !== "number" || !Number.isInteger(v) || v < 1) bad(`pair_audit.${f}.${k} is ${JSON.stringify(v)}, not a positive integer`);
      }
    }
    // Registered treatments + the actual contrast (codex turn-41 findings 3+4).
    // Absent on pre-turn-41 reports — refused: an aggregate cannot certify a
    // contrast the member never recorded.
    if (!isStringArray(p.registered_treatments)) bad("pair_audit.registered_treatments is not a string array (pre-turn-41 report — re-run the member)");
    for (const t of p.registered_treatments as string[]) {
      if (!(PAIR_TREATMENTS as readonly string[]).includes(t)) bad(`pair_audit.registered_treatments names unknown treatment "${t}"`);
    }
    const contrast = p.treatment_contrast as Record<string, { candidate?: unknown; partner?: unknown }> | undefined;
    if (!contrast || typeof contrast !== "object" || Array.isArray(contrast)) bad("pair_audit.treatment_contrast is missing or not an object (pre-turn-41 report — re-run the member)");
    const registeredSet = new Set(p.registered_treatments as string[]);
    for (const key of Object.keys(contrast!)) {
      if (!registeredSet.has(key)) bad(`pair_audit.treatment_contrast carries "${key}" which is not in registered_treatments`);
    }
    for (const t of registeredSet) {
      const cRaw = contrast![t];
      if (cRaw === undefined || cRaw === null || typeof cRaw !== "object") bad(`pair_audit.treatment_contrast is missing the registered treatment "${t}"`);
      const c = cRaw as { candidate?: unknown; partner?: unknown };
      if (c.candidate === undefined || c.partner === undefined) bad(`pair_audit.treatment_contrast.${t} lacks candidate/partner values`);
      // A recorded NO-OP contrast (equal values) contradicts the gate that
      // wrote it (registered treatments must differ) — not written by this code.
      if (JSON.stringify(c.candidate) === JSON.stringify(c.partner)) bad(`pair_audit.treatment_contrast.${t} records equal values (${JSON.stringify(c.candidate)}) — a no-op treatment contrast was not written by this code`);
    }
    // Per-stratum OUTCOME evidence + scalar consistency (codex turn-43
    // finding 2): the run-time gate enforced the declared minima by refusal
    // — a completed report must CARRY the evidence and SATISFY its own
    // declarations, or it was not written by this code.
    for (const f of ["valid_by_stratum", "treatment_exposed_by_stratum"] as const) {
      const rec = p[f];
      if (!rec || typeof rec !== "object" || Array.isArray(rec)) bad(`pair_audit.${f} is missing or not an object (pre-turn-44 report — re-run the member)`);
      for (const [k, v] of Object.entries(rec as Record<string, unknown>)) {
        if (typeof v !== "number" || !Number.isInteger(v) || v < 0) bad(`pair_audit.${f}.${k} is ${JSON.stringify(v)}, not a non-negative integer`);
      }
    }
    const validBy = p.valid_by_stratum as Record<string, number>;
    const exposedBy = p.treatment_exposed_by_stratum as Record<string, number>;
    if ((p.min_valid as number) < 1) bad(`pair_audit.min_valid is ${String(p.min_valid)} — the runner requires a positive pre-registered count`);
    if ((p.valid as number) < (p.min_valid as number)) bad(`pair_audit.valid (${String(p.valid)}) is below its own min_valid (${String(p.min_valid)}) — the run-time gate refuses that outcome, so this report was not written by this code`);
    if ((p.treatment_exposed as number) > (p.valid as number)) bad(`pair_audit.treatment_exposed (${String(p.treatment_exposed)}) exceeds valid pairs (${String(p.valid)}) — exposure is counted over valid pairs only`);
    for (const [k, v] of Object.entries(exposedBy)) {
      if (v > (validBy[k] ?? 0)) bad(`pair_audit.treatment_exposed_by_stratum.${k} (${v}) exceeds valid_by_stratum.${k} (${validBy[k] ?? 0})`);
    }
    for (const [k, minimum] of Object.entries(p.min_valid_by_stratum as Record<string, number>)) {
      if ((validBy[k] ?? 0) < minimum) bad(`declared min_valid_by_stratum.${k}=${minimum} is not satisfied by the recorded valid_by_stratum.${k}=${validBy[k] ?? 0} — the run-time gate refuses that outcome`);
    }
    for (const [k, minimum] of Object.entries(p.min_exposed_by_stratum as Record<string, number>)) {
      if ((exposedBy[k] ?? 0) < minimum) bad(`declared min_exposed_by_stratum.${k}=${minimum} is not satisfied by the recorded treatment_exposed_by_stratum.${k}=${exposedBy[k] ?? 0} — the run-time gate refuses that outcome`);
    }
    // Admission-basis coverage (codex t68 F3). Absent fields = a member that
    // predates the mechanism AND declared no minima — tolerated; the moment
    // minima are declared, the recorded coverage must exist and satisfy them.
    const minBasis = (p as { min_basis_by_stratum?: unknown }).min_basis_by_stratum ?? {};
    if (!minBasis || typeof minBasis !== "object" || Array.isArray(minBasis)) bad("pair_audit.min_basis_by_stratum is not an object");
    for (const [k, v] of Object.entries(minBasis as Record<string, unknown>)) {
      if (typeof v !== "number" || !Number.isInteger(v) || v < 1) bad(`pair_audit.min_basis_by_stratum.${k} is ${JSON.stringify(v)}, not a positive integer`);
    }
    const recordedBasis = (p as { valid_basis_by_stratum?: unknown }).valid_basis_by_stratum;
    if (Object.keys(minBasis as Record<string, number>).length > 0 && (recordedBasis === undefined || recordedBasis === null)) {
      bad("pair_audit declares min_basis_by_stratum but records no valid_basis_by_stratum — not written by this code");
    }
    if (recordedBasis !== undefined && recordedBasis !== null) {
      if (typeof recordedBasis !== "object" || Array.isArray(recordedBasis)) bad("pair_audit.valid_basis_by_stratum is not an object");
      for (const [k, v] of Object.entries(recordedBasis as Record<string, unknown>)) {
        if (typeof v !== "number" || !Number.isInteger(v) || v < 0) bad(`pair_audit.valid_basis_by_stratum.${k} is ${JSON.stringify(v)}, not a non-negative integer`);
      }
      for (const [k, minimum] of Object.entries(minBasis as Record<string, number>)) {
        if (((recordedBasis as Record<string, number>)[k] ?? 0) < minimum) {
          bad(`declared min_basis_by_stratum.${k}=${minimum} is not satisfied by the recorded valid_basis_by_stratum.${k}=${(recordedBasis as Record<string, number>)[k] ?? 0} — the run-time gate refuses that outcome`);
        }
      }
    }
    // Witness outcomes: every pre-registered id, recorded VALID + BASE-exposed.
    const outcomes = p.witness_outcomes;
    if (!Array.isArray(outcomes)) bad("pair_audit.witness_outcomes is missing (pre-turn-44 report — re-run the member)");
    const outcomeIds = new Set((outcomes as { id?: unknown }[]).map(w => String(w.id)));
    for (const id of p.required_ids as string[]) {
      if (!outcomeIds.has(id)) bad(`pair_audit.witness_outcomes lacks required witness "${id}"`);
    }
    for (const w of outcomes as { id?: unknown; valid?: unknown; base_exposed?: unknown }[]) {
      if (typeof w.id !== "string" || typeof w.valid !== "boolean" || typeof w.base_exposed !== "boolean") {
        bad("pair_audit.witness_outcomes entry is malformed");
      } else if ((p.required_ids as string[]).includes(w.id) && (!w.valid || !w.base_exposed)) {
        bad(`witness "${w.id}" is recorded ${!w.valid ? "INVALID" : "not base-exposed"} — the run-time gate refuses that outcome, so this report was not written by this code`);
      }
    }
    // ---- Per-case outcome LEDGER reconciliation (codex turn-44 finding) ----
    // Free-standing summaries are independently forgeable and can be
    // internally contradictory. Every total, stratum map, and witness
    // receipt is now RE-DERIVED from the per-case {pair_valid,
    // pair_base_exposed, pair_treatment_exposed} record and must match
    // exactly — a summary that cannot be re-derived was not written by this
    // code. Missing, extra, or duplicate ids reject.
    const rows = report.cases as unknown as { id?: unknown; profile?: unknown; split?: unknown; pair_valid?: unknown; pair_base_exposed?: unknown; pair_treatment_exposed?: unknown }[];
    const rowIds = new Set<string>();
    for (const r of rows) {
      if (typeof r.id !== "string" || r.id.length === 0) bad("a case row lacks an id");
      if (rowIds.has(r.id as string)) bad(`duplicate case id "${String(r.id)}"`);
      rowIds.add(r.id as string);
      if (typeof r.pair_valid !== "boolean" || typeof r.pair_base_exposed !== "boolean" || typeof r.pair_treatment_exposed !== "boolean") {
        bad(`case "${String(r.id)}" lacks the per-case pair ledger (pair_valid/pair_base_exposed/pair_treatment_exposed booleans) — pre-turn-45 report; re-run the member`);
      }
      // The exposure IMPLICATION CHAIN (codex turn-45 finding 2):
      // pair_treatment_exposed ⇒ pair_base_exposed ⇒ pair_valid.
      // treatmentExposed() gates the base predicate FIRST, so treatment
      // exposure is structurally a subset of base exposure — a row claiming
      // treatment exposure without base exposure is impossible, and with
      // consistently-derived summaries it would otherwise fabricate firing
      // evidence that meets a shipping minimum.
      if (r.pair_treatment_exposed === true && r.pair_base_exposed !== true) {
        bad(`case "${String(r.id)}" records treatment exposure without base exposure — treatment exposure is structurally a subset of base exposure (the base predicate gates first)`);
      }
      if (r.pair_base_exposed === true && r.pair_valid !== true) {
        bad(`case "${String(r.id)}" records exposure without a valid pair — exposure is counted over valid pairs only`);
      }
    }
    const dValid = rows.filter(r => r.pair_valid === true).length;
    const dInvalid = rows.length - dValid;
    const dExposed = rows.filter(r => r.pair_treatment_exposed === true).length;
    if ((p.valid as number) !== dValid) bad(`pair_audit.valid (${String(p.valid)}) does not reconcile with the per-case ledger (${dValid} valid row(s))`);
    if ((p.invalid as number) !== dInvalid) bad(`pair_audit.invalid (${String(p.invalid)}) does not reconcile with the per-case ledger (${dInvalid} invalid row(s))`);
    if ((p.treatment_exposed as number) !== dExposed) bad(`pair_audit.treatment_exposed (${String(p.treatment_exposed)}) does not reconcile with the per-case ledger (${dExposed} exposed row(s))`);
    const dValidBy: Record<string, number> = {};
    const dExposedBy: Record<string, number> = {};
    for (const name of [...new Set(rows.flatMap(r => [String(r.profile), String(r.split)]))].sort()) {
      dValidBy[name] = rows.filter(r => r.pair_valid === true && (r.profile === name || r.split === name)).length;
      dExposedBy[name] = rows.filter(r => r.pair_treatment_exposed === true && (r.profile === name || r.split === name)).length;
    }
    if (JSON.stringify(sortRecord(validBy)) !== JSON.stringify(dValidBy)) {
      bad(`pair_audit.valid_by_stratum does not reconcile with the per-case ledger (recorded ${JSON.stringify(sortRecord(validBy))}, derived ${JSON.stringify(dValidBy)})`);
    }
    if (JSON.stringify(sortRecord(exposedBy)) !== JSON.stringify(dExposedBy)) {
      bad(`pair_audit.treatment_exposed_by_stratum does not reconcile with the per-case ledger (recorded ${JSON.stringify(sortRecord(exposedBy))}, derived ${JSON.stringify(dExposedBy)})`);
    }
    // Admission-basis coverage reconciles with the case rows (codex t68 F3):
    // recomputed with the runner's own exported derivation, so recorded and
    // derived can only diverge if the summary was hand-edited.
    if (recordedBasis !== undefined && recordedBasis !== null) {
      const validIds = new Set(rows.filter(r => r.pair_valid === true).map(r => String(r.id)));
      const basisRows = rows as unknown as { id: string; profile: string; split: string; admission_basis?: string | null }[];
      const dBasis = deriveValidBasisByStratum(basisRows, validIds);
      if (JSON.stringify(sortRecord(recordedBasis as Record<string, number>)) !== JSON.stringify(dBasis)) {
        bad(`pair_audit.valid_basis_by_stratum does not reconcile with the per-case ledger (recorded ${JSON.stringify(sortRecord(recordedBasis as Record<string, number>))}, derived ${JSON.stringify(dBasis)})`);
      }
    }
    for (const id of p.required_ids as string[]) {
      if (!rowIds.has(id)) bad(`required witness "${id}" is not a scored case id`);
    }
    for (const w of outcomes as { id: string; valid: boolean; base_exposed: boolean }[]) {
      const row = rows.find(r => r.id === w.id);
      if (!row) bad(`witness_outcomes names "${w.id}" which is not a scored case id`);
      if (w.valid !== (row!.pair_valid === true) || w.base_exposed !== (row!.pair_base_exposed === true)) {
        bad(`witness receipt for "${w.id}" does not reconcile with the per-case ledger`);
      }
    }
  }

  // ---- Consistency (codex turn-40 findings 1 + 3) ----
  if (g!.acceptance_pass !== ((a as Record<string, unknown> | null | undefined)?.pass ?? null)) {
    bad(`gates.acceptance_pass (${JSON.stringify(g!.acceptance_pass)}) disagrees with acceptance.pass (${JSON.stringify((a as Record<string, unknown> | null | undefined)?.pass ?? null)})`);
  }
  if (a) {
    const waived = a.waived as string[];
    if (a.mode === "unconditional" && (waived.length > 0 || (g!.acceptance_waived as string[]).length > 0)) {
      bad(`acceptance mode is "unconditional" but waivers are recorded (${[...waived, ...(g!.acceptance_waived as string[])].join(", ")}) — an unconditional pass with waivers was not written by this code`);
    }
    if (a.mode === "conditional" && waived.length === 0) {
      bad(`acceptance mode is "conditional" with no waived axes — a conditional pass without waivers was not written by this code`);
    }
  }
  if (a && p && (a.baseline_run_id as string) !== (p.partner_run_id as string)) {
    bad(`acceptance baseline is run ${String(a.baseline_run_id)} but the pair partner is run ${String(p.partner_run_id)} — pair-gated acceptance is computed against the PARTNER's report; a third-run comparison is not the paired experiment`);
  }
}

/**
 * Aggregate n frozen-draw member runs of one arm into a replicated
 * distributional artifact. Members are (dir, parsed report) pairs — the CLI
 * parses via parseBaselineReport so every member passes the same shape and
 * identity validation a baseline does.
 */
export function aggregateReplicatedRuns(members: { dir: string; report: HookRunReport }[]): ReplicatedAggregate {
  if (members.length < 2) refuse(`${members.length} member run(s) — a replicated distribution needs n >= 2 independent draws`);
  const notes: string[] = [];

  // ---- Per-member structural validation ------------------------------------
  const summaries: ReplicatedMemberSummary[] = [];
  for (const { dir, report } of members) {
    // Baseline-grade validation of every field this aggregator consumes,
    // plus internal consistency (codex turn-40 findings 1 + 3) — BEFORE any
    // value is read into arithmetic or a gate.
    validateMemberReport(report, `${report.run_id ?? "?"} (${dir})`);
    const id = report.identity;
    if (!id) refuse(`member ${dir} has no run identity — not aggregatable`);
    const rp = id.ranking_policy;
    if (!rp) refuse(`member ${report.run_id} (${dir}) predates ranking_policy identity — the draw protocol is unidentified`);
    // Codex t84 CR-5: pre-t84 daemon-required members measured the raw-hit execution (the
    // synchronous client hydrate that produced the late-`ok` draws) — a DIFFERENT contract from
    // hydrated-v1 members. Fail closed on absence so old members can NEVER mix into a rerun.
    const ve = id.vector_exec;
    // t89 P2: absence fails closed under EVERY protocol (in-process included) —
    // a member without response_protocol measured a pre-t84 execution.
    if (ve && ve.response_protocol === undefined) {
      refuse(`member ${report.run_id} (${dir}) records no vector_exec.response_protocol (protocol ${ve.protocol}) — a pre-t84 member measured the raw-hit/client-hydration execution and cannot aggregate with t84+ members (codex t84 CR-5 / t89 P2); re-run this draw`);
    }
    const m = /^draw:(.+)$/.exec(rp.expansion_set);
    if (!m) refuse(`member ${report.run_id} (${dir}) has expansion_set "${rp.expansion_set}" — a replicated aggregate is built from frozen-draw member runs only ("draw:<fp>"); capture each draw with --capture-expansions`);
    // An unidentifiable pipeline poisons the whole aggregate: the same rule
    // acceptance applies to a baseline, applied to EVERY member (the
    // pairwise identity comparison below checks only the reference side).
    if (id.topology.local_fallback === "allowed" && !(id.attested && id.topology.fallback_observed === "none")) {
      refuse(`member ${report.run_id} (${dir}) ran with local fallback ALLOWED and is not attested fallback_observed="none" — the executed pipeline is unidentifiable`);
    }
    summaries.push({
      dir,
      run_id: report.run_id,
      draw: m[1]!,
      trust_pass: report.gates.trust_pass,
      acceptance_pass: report.gates.acceptance_pass,
      acceptance_mode: report.acceptance?.mode ?? null,
      acceptance_baseline_run_id: report.acceptance?.baseline_run_id ?? null,
      pair_partner_run_id: report.pair_audit?.partner_run_id ?? null,
      pair_valid: report.pair_audit?.valid ?? null,
      pair_treatment_exposed: report.pair_audit?.treatment_exposed ?? null,
      pair_registered_treatments: report.pair_audit ? [...report.pair_audit.registered_treatments].sort() as PairTreatment[] : null,
      pair_treatment_contrast: report.pair_audit ? sortRecord(report.pair_audit.treatment_contrast as Record<string, unknown>) as ReplicatedMemberSummary["pair_treatment_contrast"] : null,
      pair_protocol: report.pair_audit ? {
        min_valid: report.pair_audit.min_valid,
        max_retries: report.pair_audit.max_retries,
        required_ids: [...report.pair_audit.required_ids].sort(),
        min_valid_by_stratum: sortRecord(report.pair_audit.min_valid_by_stratum),
        min_exposed_by_stratum: sortRecord(report.pair_audit.min_exposed_by_stratum),
        min_basis_by_stratum: sortRecord((report.pair_audit as { min_basis_by_stratum?: Record<string, number> }).min_basis_by_stratum ?? {}),
      } : null,
    });
  }

  // ---- Draw distinctness (what makes it replicated) ------------------------
  const draws = summaries.map(s => s.draw);
  if (new Set(draws).size !== draws.length) {
    const dup = draws.find((d, i) => draws.indexOf(d) !== i)!;
    refuse(`draw fingerprint ${dup} appears on more than one member — n copies of one draw are one draw, not a replicated distribution`);
  }

  // ---- Mutual identity comparability (everything but the draw) -------------
  const ref = members[0]!.report.identity!;
  for (let i = 1; i < members.length; i++) {
    const mem = members[i]!;
    try {
      const cmp = assertReplicatedMemberIdentity(mem.report.identity!, ref, members[0]!.report.run_id);
      // An INFORMATIONAL demotion means the comparison could not be trusted
      // (legacy/unattested identity) — a replicated identity cannot be built
      // from members whose equality is only informational.
      if (cmp.informational.length > 0) refuse(`member ${mem.report.run_id} (${mem.dir}) compares to ${members[0]!.report.run_id} as INFORMATIONAL only: ${cmp.informational.join("; ")}`);
      notes.push(...cmp.notes.map(n => `member ${mem.report.run_id}: ${n}`));
    } catch (e) {
      if (e instanceof HookEvalIntegrityError) refuse(`member ${mem.report.run_id} (${mem.dir}) does not share the arm identity: ${e.message}`);
      throw e;
    }
  }

  // ---- Pair-gate and acceptance presence: all-or-none ----------------------
  const withPair = summaries.filter(s => s.pair_partner_run_id !== null);
  if (withPair.length !== 0 && withPair.length !== summaries.length) {
    refuse(`${withPair.length}/${summaries.length} members are pair-gated — an arm is aggregated under ONE protocol; re-run the unpaired members with --pair-with or aggregate the unpaired arm separately`);
  }
  const withAcceptance = summaries.filter(s => s.acceptance_mode !== null);
  if (withAcceptance.length !== 0 && withAcceptance.length !== summaries.length) {
    refuse(`${withAcceptance.length}/${summaries.length} members carry an acceptance comparison — an arm is aggregated under ONE protocol; give every member the same --baseline or none`);
  }

  // ---- ONE consistent experiment: contrast AND protocol --------------------
  // Treatment NAMES alone cannot distinguish weight 0-vs-1.5 from 0-vs-0.5,
  // and a mix of treated pairs and policy-identical replicates is not one
  // experiment (codex turn-41 finding 4); likewise members run under
  // different pre-registrations — witness sets, valid/exposed minima, retry
  // budgets — are different experiments (turn-42 finding 4). Every
  // pair-gated member must carry the SAME registered set, the SAME
  // candidate/partner contrast, AND the SAME pair-gate protocol; both are
  // preserved in the artifact so the aggregate certifies exactly one
  // experiment.
  let treatment: ReplicatedAggregate["treatment"] = null;
  let pairProtocol: ReplicatedAggregate["pair_protocol"] = null;
  if (withPair.length > 0) {
    const key = (s: ReplicatedMemberSummary): string =>
      JSON.stringify({ registered: s.pair_registered_treatments, contrast: s.pair_treatment_contrast, protocol: s.pair_protocol });
    const ref0 = summaries[0]!;
    for (const s of summaries.slice(1)) {
      if (key(s) !== key(ref0)) {
        refuse(`members do not share ONE experiment — ${ref0.run_id} ran ${key(ref0)} but ${s.run_id} ran ${key(s)}; a replicated aggregate certifies exactly one experiment (same registered treatments, same candidate/partner contrast, same pair-gate protocol on every draw)`);
      }
    }
    treatment = { registered: ref0.pair_registered_treatments ?? [], contrast: ref0.pair_treatment_contrast ?? {} };
    pairProtocol = ref0.pair_protocol;
  }

  // ---- Axis aggregation across draws ---------------------------------------
  const axes: ReplicatedAxisSummary[] = [];
  if (withAcceptance.length > 0) {
    const metrics = [...new Set(members.flatMap(m => (m.report.acceptance?.axes ?? []).map(a => a.metric)))];
    for (const metric of metrics) {
      const perDraw = members.map(m => {
        const ax: AcceptanceAxis | undefined = m.report.acceptance?.axes.find(a => a.metric === metric);
        return {
          run_id: m.report.run_id,
          baseline: ax?.baseline ?? null,
          candidate: ax?.candidate ?? null,
          pass: ax ? ax.pass : null,
        };
      });
      const cands = perDraw.map(d => d.candidate).filter((v): v is number => v !== null);
      const bases = perDraw.map(d => d.baseline).filter((v): v is number => v !== null);
      const deltas = perDraw
        .filter(d => d.baseline !== null && d.candidate !== null)
        .map(d => d.candidate! - d.baseline!);
      axes.push({
        metric,
        draws: perDraw,
        all_pass: perDraw.every(d => d.pass === true),
        baseline_mean: mean(bases),
        candidate_mean: mean(cands),
        candidate_min: cands.length ? Math.min(...cands) : null,
        candidate_max: cands.length ? Math.max(...cands) : null,
        delta_mean: mean(deltas),
        direction_stable: deltas.length === 0 ? null : deltas.every(d => d >= 0) || deltas.every(d => d <= 0),
      });
    }
  }

  // ---- Gates ---------------------------------------------------------------
  const reasons: string[] = [];
  const trustAll = summaries.every(s => s.trust_pass);
  if (!trustAll) reasons.push(`trust failed on: ${summaries.filter(s => !s.trust_pass).map(s => s.run_id).join(", ")}`);
  let acceptanceAll: boolean | null = null;
  if (withAcceptance.length > 0) {
    acceptanceAll = summaries.every(s => s.acceptance_pass === true);
    if (!acceptanceAll) reasons.push(`acceptance did not pass on: ${summaries.filter(s => s.acceptance_pass !== true).map(s => s.run_id).join(", ")}`);
    const conditional = summaries.filter(s => s.acceptance_mode === "conditional");
    if (conditional.length > 0) reasons.push(`acceptance was CONDITIONAL (waived axes) on: ${conditional.map(s => s.run_id).join(", ")} — a waived draw never aggregates into an unconditional pass`);
  } else {
    reasons.push("no member carries an acceptance comparison — trust-only aggregate, never a product pass");
  }
  // A distributional PRODUCT pass requires the pair gate on every draw
  // (codex turn-40 finding 3): unconditional per-draw acceptance without a
  // pair audit means pre-treatment equality was never verified — the very
  // property that makes the per-draw comparisons paired evidence. (The
  // partner==acceptance-baseline consistency is enforced per member in
  // validateMemberReport.)
  const pairAll = withPair.length === summaries.length && summaries.length > 0;
  if (!pairAll && withAcceptance.length > 0) {
    reasons.push("members are not pair-gated — pre-treatment equality is unverified, so the per-draw acceptances are not paired evidence; a distributional product pass requires the pair gate on every draw");
  }
  // Belt on the per-member semantic validation (codex turn-41 finding 1):
  // the aggregate pass additionally requires every AXIS to have passed on
  // every draw — the verdict never outruns its evidence.
  const axesAllPass = axes.length > 0 && axes.every(a => a.all_pass);
  if (withAcceptance.length > 0 && !axesAllPass) {
    reasons.push(`not every acceptance axis passed on every draw: ${axes.filter(a => !a.all_pass).map(a => a.metric).join(", ") || "(no axes)"}`);
  }
  // Machine-visible PILOT mode (codex turn-41 finding 5 + ruling): a run
  // below the shipping draw count reports valid evidence but can NEVER be
  // product acceptance — the "three-draw pilot / five-draw acceptance"
  // ruling is enforced by the gate, not by prose.
  const pilot = summaries.length < REPLICATED_SHIPPING_MIN_DRAWS;
  if (pilot) {
    reasons.push(`n=${summaries.length} is a PILOT (non-shipping): distributional product acceptance requires >= ${REPLICATED_SHIPPING_MIN_DRAWS} draws (codex turn-40/41 ruling); pilot evidence informs the shipping run's pre-registration`);
  }
  // SHIPPING treatment-exposure contract (codex turn-42 finding 4, made
  // per-stratum-decisive by turn-43 finding 2): five registered gate-
  // treatment draws with ZERO firings must never product-pass. A non-pilot
  // aggregate with registered treatments requires a POSITIVE pre-registered
  // treatment-exposure minimum, and EVERY declared stratum minimum is
  // validated DIRECTLY against every member's recorded
  // treatment_exposed_by_stratum — no reconstruction from totals (a report
  // with four exposed deep/tuning pairs and zero exposed holdout pairs must
  // not satisfy a holdout minimum). validateMemberReport already refused
  // members violating their own declarations; this is the aggregate-level
  // belt and the reason line. The PILOT intentionally omits it: it MEASURES
  // firing to pre-register the minimum.
  let exposureOk = true;
  if (!pilot && (treatment?.registered.length ?? 0) > 0) {
    const declared = Object.entries(pairProtocol?.min_exposed_by_stratum ?? {});
    if (declared.length === 0) {
      exposureOk = false;
      reasons.push("registered-treatment shipping run has NO pre-registered treatment-exposure minimum (min_exposed_by_stratum is empty) — a shipping acceptance must pre-register a positive firing minimum from the pilot's evidence");
    } else {
      const short: string[] = [];
      for (const { report } of members) {
        const exposedBy = report.pair_audit?.treatment_exposed_by_stratum ?? {};
        for (const [stratum, minimum] of declared) {
          if ((exposedBy[stratum] ?? 0) < minimum) short.push(`${report.run_id} ${stratum}: ${exposedBy[stratum] ?? 0} < ${minimum}`);
        }
      }
      if (short.length > 0) {
        exposureOk = false;
        reasons.push(`treatment exposure below the pre-registered per-stratum minimum on: ${short.join("; ")} — the treatment did not demonstrably operate on those draws' strata`);
      }
    }
  }
  // Admission-basis coverage (codex t68 F3): when the ONE shared protocol
  // pre-registered basis minima, every member's recorded coverage must
  // satisfy them — the aggregate-level belt over validateMemberReport, and
  // the conjunct that makes topology coverage machine-decisive in the
  // shipping verdict.
  let basisOk = true;
  {
    const declaredBasis = Object.entries(pairProtocol?.min_basis_by_stratum ?? {});
    if (!pilot && declaredBasis.length > 0) {
      const short: string[] = [];
      for (const { report } of members) {
        const recorded = ((report.pair_audit as unknown as { valid_basis_by_stratum?: Record<string, number> })?.valid_basis_by_stratum) ?? {};
        for (const [key, minimum] of declaredBasis) {
          if ((recorded[key] ?? 0) < minimum) short.push(`${report.run_id} ${key}: ${recorded[key] ?? 0} < ${minimum}`);
        }
      }
      if (short.length > 0) {
        basisOk = false;
        reasons.push(`admission-basis coverage below the pre-registered per-stratum minimum on: ${short.join("; ")} — the registered topology was not demonstrably validated on those draws`);
      }
    }
  }
  const pass = trustAll && acceptanceAll === true && pairAll && axesAllPass && !pilot && exposureOk && basisOk
    && summaries.every(s => s.acceptance_mode === "unconditional");

  // ---- Replicated identity -------------------------------------------------
  const identity: RunIdentity = {
    ...ref,
    ranking_policy: {
      ...ref.ranking_policy!,
      expansion_set: `replicated:${summaries.length}`,
      expansion_draws: [...draws].sort(),
    },
  };
  // Self-check with the SHARED validator — a malformed aggregate identity
  // must throw here, not surface later as an incomparable artifact.
  validateIdentityShape(identity, (msg: string): never => {
    throw new HookEvalIntegrityError(`replicated aggregate built an invalid identity (bug): ${msg}`);
  });

  return {
    schema: "replicated-aggregate-v1",
    created_at: isoNow(),
    n: summaries.length,
    pilot,
    members: summaries,
    identity,
    treatment,
    pair_protocol: pairProtocol,
    gates: {
      trust_all_pass: trustAll,
      acceptance_all_pass: acceptanceAll,
      pair_all_present: pairAll,
      pass,
      reasons,
    },
    axes,
    notes,
  };
}

/** Load member run directories (each containing hook-run.json) and aggregate. */
export function aggregateReplicatedRunDirs(dirs: string[]): ReplicatedAggregate {
  return aggregateReplicatedRuns(dirs.map(dir => ({ dir, report: parseBaselineReport(join(dir, "hook-run.json")) })));
}

export function renderReplicatedMd(agg: ReplicatedAggregate): string {
  const lines: string[] = [];
  const fmt = (v: number | null, d = 3) => (v === null ? "—" : v.toFixed(d));
  lines.push(`# Replicated aggregate — ${agg.n} draws${agg.pilot ? " (PILOT — non-shipping)" : ""}`);
  lines.push("");
  lines.push(`- created: ${agg.created_at}`);
  const rp = agg.identity.ranking_policy!;
  lines.push(`- identity: expansion ${rp.expansion_set} · weight ${rp.rerank_lane_weight} · fusion rev ${rp.fusion_policy_rev} · degeneracy gate ${rp.degeneracy_gate ?? "(pre-BUILD-3d)"} · profiles ${agg.identity.profiles}`);
  lines.push(`- draws: ${rp.expansion_draws!.join(", ")}`);
  if (agg.treatment) {
    const contrastStr = Object.entries(agg.treatment.contrast).map(([t, c]) => `${t}: ${JSON.stringify((c as { partner: unknown }).partner)} → ${JSON.stringify((c as { candidate: unknown }).candidate)}`).join(" · ");
    lines.push(`- experiment: registered [${agg.treatment.registered.join(", ") || "none — replicate audit"}]${contrastStr ? ` · contrast ${contrastStr}` : ""}`);
  }
  if (agg.pair_protocol) {
    const p = agg.pair_protocol;
    lines.push(`- protocol: min_valid ${p.min_valid} · max_retries ${p.max_retries} · witnesses [${p.required_ids.join(", ") || "none"}] · valid minima ${JSON.stringify(p.min_valid_by_stratum)} · exposed minima ${JSON.stringify(p.min_exposed_by_stratum)}`);
  }
  lines.push(`- gates: trust ${agg.gates.trust_all_pass ? "PASS (all draws)" : "FAIL"} · acceptance ${agg.gates.acceptance_all_pass === null ? "n/a" : agg.gates.acceptance_all_pass ? "PASS (all draws)" : "FAIL"} · pair gate ${agg.gates.pair_all_present ? "present on all draws" : "absent"} · overall ${agg.gates.pass ? "PASS" : "FAIL"}`);
  for (const r of agg.gates.reasons) lines.push(`  - ${r}`);
  lines.push("");
  lines.push(`## Members`);
  lines.push("");
  lines.push(`| run | draw | trust | acceptance | pair valid | exposed |`);
  lines.push(`|---|---|---|---|---|---|`);
  for (const m of agg.members) {
    lines.push(`| ${m.run_id} | ${m.draw} | ${m.trust_pass ? "PASS" : "FAIL"} | ${m.acceptance_mode ?? "—"} | ${m.pair_valid ?? "—"} | ${m.pair_treatment_exposed ?? "—"} |`);
  }
  if (agg.axes.length > 0) {
    lines.push("");
    lines.push(`## Axes across draws`);
    lines.push("");
    lines.push(`| metric | all pass | baseline mean | candidate mean | candidate range | Δ mean | direction stable |`);
    lines.push(`|---|---|---|---|---|---|---|`);
    for (const a of agg.axes) {
      lines.push(`| ${a.metric} | ${a.all_pass ? "yes" : "NO"} | ${fmt(a.baseline_mean)} | ${fmt(a.candidate_mean)} | ${fmt(a.candidate_min)}–${fmt(a.candidate_max)} | ${fmt(a.delta_mean)} | ${a.direction_stable === null ? "—" : a.direction_stable ? "yes" : "NO"} |`);
    }
    lines.push("");
    lines.push(`Per-draw axis values:`);
    for (const a of agg.axes) {
      lines.push(`- ${a.metric}: ${a.draws.map(d => `${d.run_id} ${fmt(d.baseline)}→${fmt(d.candidate)} ${d.pass === null ? "(unmeasured)" : d.pass ? "pass" : "FAIL"}`).join(" · ")}`);
    }
  }
  if (agg.notes.length > 0) {
    lines.push("");
    lines.push(`## Notes`);
    for (const n of agg.notes) lines.push(`- ${n}`);
  }
  lines.push("");
  return lines.join("\n");
}

/** Write replicated.json + replicated.md into outDir (created if absent). */
export function writeReplicatedArtifacts(agg: ReplicatedAggregate, outDir: string): { jsonPath: string; mdPath: string } {
  mkdirSync(outDir, { recursive: true });
  const jsonPath = join(outDir, "replicated.json");
  const mdPath = join(outDir, "replicated.md");
  writeFileSync(jsonPath, JSON.stringify(agg, null, 2) + "\n");
  writeFileSync(mdPath, renderReplicatedMd(agg));
  return { jsonPath, mdPath };
}
