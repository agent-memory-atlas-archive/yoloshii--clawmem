import { DEADLINE_PROTOCOL_IDENTITY } from "../vector-protocol.ts";
/**
 * Run-identity contract for the hook replay-eval — the SHARED definition of
 * what makes two runs comparable.
 *
 * Extracted from hook-run.ts with BUILD-3c: the in-run pair gate made the
 * orchestrator depend on the pair audit, and the pair audit already depended
 * on this validator. Owning the contract here keeps that dependency a
 * straight line (hook-run -> pair-audit -> run-identity) instead of a cycle,
 * and guarantees the audit and the orchestrator can never validate identity
 * by two different rules.
 */

/**
 * The registrable treatment variables of a paired experiment (codex turn-40
 * finding 2): the ranking_policy fields an operator may DECLARE as the
 * difference between two arms. Everything else must always match. An
 * UNREGISTERED treatment difference is refused everywhere — the pair audit,
 * the in-run pair gate, and paired acceptance — so a confounded or
 * accidental policy delta can never masquerade as the registered experiment.
 */
export const PAIR_TREATMENTS = ["rerank_lane_weight", "degeneracy_gate", "admission_policy"] as const;

/**
 * BUILD-4 turn-56 (codex t55 CR-6): the ONE strict canonical parser for the
 * frozen evaluation clock — shared by the runtime resolver
 * (context-surfacing resolveEvalNow), the eval-run preflight
 * (assertEvalNowConfig), and identity validation, so a value cannot be
 * "valid" on one surface and rejected on another. Accepts EXACTLY
 * ISO-8601 UTC `YYYY-MM-DDTHH:mm:ssZ` or `YYYY-MM-DDTHH:mm:ss.sssZ`; the
 * round-trip check rejects calendar-impossible values the shape admits
 * (2026-13-40…). Everything else — offsets, space separators, JS-permissive
 * date prose — returns null.
 */
const EVAL_NOW_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/;
export function parseEvalNowTimestamp(raw: string): Date | null {
  if (!EVAL_NOW_RE.test(raw)) return null;
  const d = new Date(raw);
  if (!Number.isFinite(d.getTime())) return null;
  const normalized = raw.includes(".") ? raw : raw.replace("Z", ".000Z");
  return d.toISOString() === normalized ? d : null;
}
export type PairTreatment = (typeof PAIR_TREATMENTS)[number];

/**
 * Comparable identity of a run — the acceptance gate refuses to compare runs
 * whose identities differ (codex turn-7 finding 4 / turn-8 finding 4).
 */
export interface RunIdentity {
  /**
   * sha256 over the canonicalized FULL scored gold cases — id, prompt,
   * priors, profile, prior_leg, labels (sorted), expect_abstain, split, tags
   * — so edited labels/prompts/priors change the fingerprint, not just
   * renamed cases.
   */
  gold_fingerprint: string;
  limit: number;
  budget_ms: number;
  /** Sorted unique per-case profiles ("+"-joined) — covers profileOverride and per-case gold profiles alike. */
  profiles: string;
  /** Content hash of the corpus snapshot(s); null when invoked without one (tests). */
  corpus: string | null;
  /** Informational only — never compared. */
  corpus_label?: string;
  /**
   * Inference topology: endpoint envs, the EFFECTIVE model ids (env override
   * or default — what the inference layer actually requests, codex turn-9
   * finding 4), inference-affecting LLM options, and served-model probes.
   * served_* is tri-state: a probed value, "unreachable" (endpoint down —
   * itself identity-relevant: the degraded topology IS the identity), or
   * "unknown" (endpoint up but unfingerprintable) — "unknown" on a service
   * the run's profiles exercise fails comparability unless that side's
   * identity is attested.
   */
  topology: {
    embed: string; llm: string; rerank: string;
    embed_model: string; query_model: string; rerank_model: string;
    llm_effort: string; llm_no_think: string;
    /**
     * CLAWMEM_NO_LOCAL_MODELS policy, normalized the way the inference layer
     * consumes it (strict === "true" → "blocked", else "allowed"). With
     * fallback ALLOWED, an endpoint that fails MID-RUN silently swaps in an
     * UNIDENTIFIED in-process model while the identity keeps the healthy
     * preflight probe — so acceptance comparison FORBIDS "allowed" on the
     * candidate outright and accepts an "allowed" baseline only when it is
     * attested with `fallback_observed: "none"` (codex turn-10 finding 3 +
     * turn-11 findings 3/4). Compared by that POLICY, never by blind strict
     * equality — an attested-none "allowed" baseline is pipeline-equivalent
     * to a "blocked" candidate. The eval CLI forces "blocked" for its runs
     * UNCONDITIONALLY (the ambient env is launcher policy, not an invoker
     * decision), with --allow-local-fallback as the explicit trust-only
     * opt-out.
     */
    local_fallback: "blocked" | "allowed";
    /**
     * Routing attestation for an "allowed" identity (stamp tooling only —
     * never recorded by a live run): "none" = the attester verified from
     * route evidence that no local model executed during the original run;
     * "unknown" = the policy allowed local execution and the route cannot be
     * reconstructed — comparisons against such a baseline are demoted to
     * INFORMATIONAL-only (codex turn-11 finding 4). Meaningless (and
     * rejected) under "blocked", where policy already excludes local
     * execution.
     */
    fallback_observed?: "none" | "unknown";
    served_embed: string; served_llm: string; served_rerank: string;
  };
  latency_protocol: { reps: number; aggregation: "lower-median" };
  /**
   * Final-ordering policy identity (codex turn-17 finding 1): the EFFECTIVE
   * rerank-lane weight (env-overridable — the treatment variable in weight
   * ablations; two runs under different weights execute different ranking
   * policies and must never advertise identical identities), the fusion-
   * policy revision the code under test implements, and the expansion-set
   * protocol ("sampled" = independent per-run draws at generation
   * temperature; "draw:<fp>" = a frozen paired-counterfactual draw).
   * Comparison: rerank_lane_weight and expansion_set STRICT (a weight
   * difference is a treatment — compare within a paired experiment, never
   * via --baseline); fusion_policy_rev differences are informational notes
   * (the code-under-test delta is what acceptance comparison measures).
   * Absent on reports written before turn-18 (legacy — noted, comparison
   * demoted to informational).
   */
  ranking_policy?: {
    rerank_lane_weight: number;
    fusion_policy_rev: number;
    expansion_set: string;
    /**
     * BUILD-3d: state of the per-request degeneracy gate's ACTION
     * (CLAWMEM_RERANK_DEGENERACY_GATE). Same class as the lane weight: two
     * runs of identical code under different toggle states execute different
     * ordering policies — STRICT when both sides carry it. Absent = the
     * report predates BUILD-3d, which is knowable from fusion_policy_rev:
     * rev < 6 code had no gate (compared as a code-under-test delta, noted);
     * a rev ≥ 6 identity WITHOUT this field was not written by this code —
     * refused.
     */
    degeneracy_gate?: "on" | "off";
    /**
     * BUILD-4: the admission policy the run executed
     * (CLAWMEM_ADMISSION_POLICY). "relevance" = admission judged on the
     * final ordering key (the default); "composite" = the pre-BUILD-4
     * composite gate, kept ONLY as the registered treatment's control arm.
     * Same class as the lane weight and the gate toggle: STRICT when both
     * sides carry it; register "admission_policy" to compare across it.
     * Absent = the report predates BUILD-4, knowable from
     * fusion_policy_rev: rev < 7 code had no admission policy field (noted
     * as a code-under-test delta); a rev >= 7 identity without it was not
     * written by this code — refused.
     */
    admission_policy?: "relevance" | "composite";
    /**
     * BUILD-4: revision of the relevance-admission machinery (parameters
     * table + decision shape). Differences are informational notes, like
     * fusion_policy_rev — the code-under-test delta acceptance measures.
     */
    admission_rev?: number;
    /**
     * BUILD-3d: per-draw fingerprint list of a replicated-distribution
     * aggregate — REQUIRED (sorted, unique, length n ≥ 2) when expansion_set
     * is "replicated:<n>", FORBIDDEN otherwise. Distinctness is what makes
     * the protocol replicated: n copies of one draw are one draw.
     */
    expansion_draws?: string[];
  };
  /**
   * BUILD-3a: the handler's effective internal budget (HOOK_BUDGET_MS at
   * run time). A budget difference changes retrieval behavior (escalation
   * window, rerank window) — STRICT in comparison; absent on pre-BUILD-3a
   * reports (legacy — noted, demoted to informational).
   */
  /**
   * BUILD-4 turn-55 (codex turn-54 finding 3): the frozen evaluation clock
   * (CLAWMEM_EVAL_NOW) the composite recency/confidence computation ran on —
   * null = wall clock. A clock difference changes the composite policy
   * inputs, so it is part of identity: the pair audit's identity equality
   * refuses arms on different clocks (it is NOT a registrable treatment).
   */
  eval_now?: string | null;
  hook_budget_ms?: number;
  /**
   * Codex t76 (daemon-backed eval): the VECTOR EXECUTION PROTOCOL the run's
   * vector legs executed under. "daemon-required" = a dedicated vector-daemon
   * child served the working copy and every vector leg was daemon-required
   * (the profile timeouts are authoritative; daemon loss refuses the run);
   * "in-process" = the legs ran the synchronous in-process scan (timeouts
   * cannot fire during it — latency evidence is NOT authoritative on
   * vector-exercising profiles). `prewarm` is the declared daemon prewarm
   * policy ("steady-state" = the long-lived watcher topology's periodic
   * prewarm was performed before readiness; "cold" = none), "n/a" for
   * in-process. STRICT on every comparison surface (baseline, pair,
   * replicated members) and NOT a registrable treatment: two runs under
   * different vector protocols measured different executions. Absent =
   * pre-t76 report — comparison surfaces fail closed (the protocol its
   * vector legs ran under is unidentifiable).
   */
  vector_exec?: VectorExecIdentity;
  /**
   * O1 §4: the handler / evaluator TIMING contract — `DEADLINE_PROTOCOL_IDENTITY`
   * ("monotonic-relative-v1") once O1 is ACTIVATED: every deadline decision,
   * the finalization/trust timing, expansion and rerank cancellation derive
   * from one monotonic anchor and relative windows. Top-level, not under
   * `vector_exec`: the handler's timing changed in speed-only and in-process
   * runs too. Stamped from the exported implementation constant, never a CLI
   * option. Absent = a pre-activation report; from the activation commit on,
   * every comparison surface (acceptance, pair, replicated members, aggregate)
   * FAILS CLOSED on absence. Defining the constant is inert; stamping it here
   * is the activation (O1 §6 step 4).
   */
  deadline_protocol?: string;
  /** Set ONLY by attestation tooling (retro-stamped baselines) — never by a live run. */
  attested?: string;
}

/** The vector execution protocol as recorded in identity (see RunIdentity.vector_exec).
 * `response_protocol` (codex #28 t84 CR-5 / t85): WHICH response protocol the daemon-required
 * legs ran under — "hydrated-v1" (daemon-side projection) vs "raw-hit" (raw hits + client-side
 * hydration, the pre-v0.38 execution whose synchronous hydrate produced the late-`ok` draws).
 * Two runs under different response protocols measured DIFFERENT executions. Optional so
 * pre-t84 reports still parse — every comparison surface fails closed on absence, which is
 * exactly what quarantines the already-produced raw-hit members from a hydrated rerun. */
export type VectorExecIdentity =
  | { protocol: "daemon-required"; prewarm: "steady-state" | "cold"; response_protocol?: "hydrated-v1" | "raw-hit" }
  | { protocol: "in-process"; prewarm: "n/a"; response_protocol?: "n/a" };

/** Human-readable identity of a vector protocol (comparison messages). */
export function describeVectorExec(v: VectorExecIdentity | undefined): string {
  if (!v) return "unrecorded";
  return v.protocol === "in-process" ? "in-process" : `${v.protocol}/${v.prewarm}/${v.response_protocol ?? "unrecorded-response-protocol"}`;
}

/**
 * Topology fields compared by STRICT equality (all strings). local_fallback
 * is deliberately NOT here — it is compared by the fallback POLICY in
 * assertComparableIdentity (an attested-none "allowed" baseline must remain
 * comparable to a "blocked" candidate; codex turn-11 finding 4).
 */
export const TOPOLOGY_FIELDS = [
  "embed", "llm", "rerank", "embed_model", "query_model", "rerank_model",
  "llm_effort", "llm_no_think",
  "served_embed", "served_llm", "served_rerank",
] as const;

export function validateIdentityShape(v: unknown, bad: (msg: string) => never): void {
  if (!v || typeof v !== "object") bad("identity is not an object");
  const o = v as Record<string, unknown>;
  if (typeof o.gold_fingerprint !== "string" || !/^[0-9a-f]{64}$/.test(o.gold_fingerprint)) bad("identity.gold_fingerprint is not a sha256 hex string");
  if (typeof o.limit !== "number" || !Number.isFinite(o.limit)) bad("identity.limit is not a finite number");
  if (typeof o.budget_ms !== "number" || !Number.isFinite(o.budget_ms)) bad("identity.budget_ms is not a finite number");
  if (typeof o.profiles !== "string") bad("identity.profiles is not a string");
  if (o.corpus !== null && typeof o.corpus !== "string") bad("identity.corpus is not a string or null");
  const t = o.topology as Record<string, unknown> | null | undefined;
  if (!t || typeof t !== "object") bad("identity.topology is not an object");
  for (const f of TOPOLOGY_FIELDS) {
    if (typeof (t as Record<string, unknown>)[f] !== "string") bad(`identity.topology.${f} is not a string`);
  }
  if ((t as Record<string, unknown>).local_fallback !== "blocked" && (t as Record<string, unknown>).local_fallback !== "allowed") {
    bad(`identity.topology.local_fallback is not "blocked" or "allowed"`);
  }
  const fo = (t as Record<string, unknown>).fallback_observed;
  if (fo !== undefined) {
    if (fo !== "none" && fo !== "unknown") bad(`identity.topology.fallback_observed is not "none" or "unknown"`);
    if ((t as Record<string, unknown>).local_fallback !== "allowed") {
      bad(`identity.topology.fallback_observed is only meaningful with local_fallback "allowed" — "blocked" already excludes local execution by policy`);
    }
  }
  const lp = o.latency_protocol as Record<string, unknown> | null | undefined;
  if (!lp || typeof lp !== "object") bad("identity.latency_protocol is not an object");
  const reps = (lp as Record<string, unknown>).reps;
  if (typeof reps !== "number" || !Number.isInteger(reps) || reps < 1) bad("identity.latency_protocol.reps is not a positive integer");
  if ((lp as Record<string, unknown>).aggregation !== "lower-median") bad(`identity.latency_protocol.aggregation is not "lower-median"`);
  if (o.attested !== undefined && typeof o.attested !== "string") bad("identity.attested is not a string");
  // O1 §4: optional until activation; when present it must be the ONE identity this code
  // implements — any other value was not written by this build.
  if (o.deadline_protocol !== undefined && o.deadline_protocol !== DEADLINE_PROTOCOL_IDENTITY) {
    bad(`identity.deadline_protocol is not "${DEADLINE_PROTOCOL_IDENTITY}" (got ${JSON.stringify(o.deadline_protocol)}) — the only handler timing contract this build implements`);
  }
  // ranking_policy is optional (absent = legacy pre-turn-18 report); when
  // present its shape must be valid or the comparison would silently skip
  // the strict checks (codex turn-17 finding 1).
  const rp = o.ranking_policy as Record<string, unknown> | undefined;
  if (rp !== undefined) {
    if (!rp || typeof rp !== "object" || Array.isArray(rp)) bad("identity.ranking_policy is not an object");
    if (typeof rp.rerank_lane_weight !== "number" || !Number.isFinite(rp.rerank_lane_weight) || rp.rerank_lane_weight < 0) {
      bad("identity.ranking_policy.rerank_lane_weight is not a finite non-negative number");
    }
    if (typeof rp.fusion_policy_rev !== "number" || !Number.isInteger(rp.fusion_policy_rev) || rp.fusion_policy_rev < 1) {
      bad("identity.ranking_policy.fusion_policy_rev is not a positive integer");
    }
    if (typeof rp.expansion_set !== "string" || rp.expansion_set.length === 0) {
      bad("identity.ranking_policy.expansion_set is not a non-empty string");
    }
    if (rp.degeneracy_gate !== undefined && rp.degeneracy_gate !== "on" && rp.degeneracy_gate !== "off") {
      bad(`identity.ranking_policy.degeneracy_gate is not "on" or "off"`);
    }
    // BUILD-3d: a rev-6+ identity records the degeneracy-gate state
    // unconditionally, so its absence there means the identity was not
    // written by this code — refused rather than silently compared as a
    // legacy report (rev < 6 predates the gate and is legitimately absent).
    if (rp.degeneracy_gate === undefined && typeof rp.fusion_policy_rev === "number" && rp.fusion_policy_rev >= 6) {
      bad("identity.ranking_policy.degeneracy_gate is absent on a fusion_policy_rev >= 6 identity — rev-6 code records the gate state unconditionally, so this identity was not written by rev-6 code");
    }
    if (rp.admission_policy !== undefined && rp.admission_policy !== "relevance" && rp.admission_policy !== "composite") {
      bad(`identity.ranking_policy.admission_policy is not "relevance" or "composite"`);
    }
    if (rp.admission_rev !== undefined && (typeof rp.admission_rev !== "number" || !Number.isInteger(rp.admission_rev) || rp.admission_rev < 1)) {
      bad("identity.ranking_policy.admission_rev is not a positive integer");
    }
    if ((rp.admission_policy === undefined) !== (rp.admission_rev === undefined)) {
      bad("identity.ranking_policy.admission_policy and admission_rev must be present together — a policy without its revision (or vice versa) was not written by this code");
    }
    // BUILD-4: a rev-7+ identity records the admission policy
    // unconditionally, so its absence there means the identity was not
    // written by this code (rev < 7 predates the policy field and is
    // legitimately absent).
    if (rp.admission_policy === undefined && typeof rp.fusion_policy_rev === "number" && rp.fusion_policy_rev >= 7) {
      bad("identity.ranking_policy.admission_policy is absent on a fusion_policy_rev >= 7 identity — rev-7 code records the admission policy unconditionally, so this identity was not written by rev-7 code");
    }
    // BUILD-3d: replicated-distribution protocol identity. The per-draw
    // fingerprint list is REQUIRED with "replicated:<n>" (length n, unique,
    // n >= 2 — n copies of one draw are one draw) and FORBIDDEN with any
    // other protocol, so a report can never advertise replication it cannot
    // itemize.
    const repMatch = /^replicated:([0-9]+)$/.exec(rp.expansion_set as string);
    if (repMatch) {
      const n = Number(repMatch[1]);
      if (!Number.isInteger(n) || n < 2) bad(`identity.ranking_policy.expansion_set "replicated:<n>" requires n >= 2 (got ${rp.expansion_set}) — a single draw is the frozen-draw protocol, not a replicated distribution`);
      const draws = rp.expansion_draws;
      if (!Array.isArray(draws)) bad(`identity.ranking_policy.expansion_draws is required with expansion_set "${rp.expansion_set}" — a replicated identity must itemize its draws`);
      const list = draws as unknown[];
      if (list.length !== n) bad(`identity.ranking_policy.expansion_draws has ${list.length} entries but expansion_set declares ${n}`);
      if (list.some(d => typeof d !== "string" || (d as string).length === 0)) bad("identity.ranking_policy.expansion_draws entries must be non-empty strings");
      if (new Set(list as string[]).size !== list.length) bad("identity.ranking_policy.expansion_draws entries must be unique — n copies of one draw are one draw, not a replicated distribution");
    } else if (rp.expansion_draws !== undefined) {
      bad(`identity.ranking_policy.expansion_draws is only meaningful with expansion_set "replicated:<n>" (got "${rp.expansion_set}")`);
    }
  }
  // eval_now is optional (absent = legacy pre-turn-55 report; the comparison
  // surfaces fail closed on absence); when present it must be null (wall
  // clock, recorded explicitly) or a CANONICAL ISO-8601 UTC timestamp
  // through the same strict parser the runtime uses (codex t55 CR-6 — the
  // permissive Date() parser accepted noncanonical strings, so a "valid"
  // identity could carry a clock the runtime would have refused).
  if (o.eval_now !== undefined && o.eval_now !== null) {
    if (typeof o.eval_now !== "string" || parseEvalNowTimestamp(o.eval_now) === null) {
      bad("identity.eval_now is not null or a canonical ISO-8601 UTC timestamp (YYYY-MM-DDTHH:mm:ss[.sss]Z)");
    }
  }
  // hook_budget_ms is optional (absent = legacy pre-BUILD-3a report); when
  // present it must be a positive finite number — a malformed budget would
  // silently skip the strict comparison below.
  if (o.hook_budget_ms !== undefined) {
    if (typeof o.hook_budget_ms !== "number" || !Number.isFinite(o.hook_budget_ms) || o.hook_budget_ms <= 0) {
      bad("identity.hook_budget_ms is not a positive finite number");
    }
  }
  // vector_exec is optional (absent = pre-t76 report; the comparison surfaces
  // fail closed on absence); when present it must be one of the two recorded
  // protocol shapes — a malformed block would silently skip the strict check.
  if (o.vector_exec !== undefined) {
    const v = o.vector_exec as Record<string, unknown> | null;
    if (!v || typeof v !== "object" || Array.isArray(v)) bad("identity.vector_exec is not an object");
    const vv = v as Record<string, unknown>;
    if (vv.protocol === "daemon-required") {
      if (vv.prewarm !== "steady-state" && vv.prewarm !== "cold") bad(`identity.vector_exec.prewarm must be "steady-state" or "cold" under protocol "daemon-required"`);
      // response_protocol optional (absent = pre-t84 report → comparison surfaces fail closed);
      // when present it must be one of the two recorded executions (codex t84 CR-5).
      if (vv.response_protocol !== undefined && vv.response_protocol !== "hydrated-v1" && vv.response_protocol !== "raw-hit") {
        bad(`identity.vector_exec.response_protocol must be "hydrated-v1" or "raw-hit" under protocol "daemon-required"`);
      }
    } else if (vv.protocol === "in-process") {
      if (vv.prewarm !== "n/a") bad(`identity.vector_exec.prewarm must be "n/a" under protocol "in-process"`);
      if (vv.response_protocol !== undefined && vv.response_protocol !== "n/a") {
        bad(`identity.vector_exec.response_protocol must be "n/a" under protocol "in-process"`);
      }
    } else {
      bad(`identity.vector_exec.protocol is not "daemon-required" or "in-process"`);
    }
  }
}
