/**
 * Hook replay-eval — run orchestrator (BUILD-0, CONTRACT-5).
 *
 * Replays labeled UserPromptSubmit cases through the REAL `contextSurfacing`
 * handler — the exact code path the live hook takes, including multi-turn
 * lookback, every retrieval leg, deep escalation, composite scoring, and
 * admission — against a corpus snapshot, and scores the injected documents
 * with the judged metrics plus the hermetic invariant audit.
 *
 * Isolation contract (the hook intrinsically writes telemetry; the harness
 * neutralizes every cross-case channel):
 *  - dedup gate: CLAWMEM_HOOK_DEDUP_WINDOW_SEC=0 for the whole run, so the
 *    same prompt can replay under several shapes/configs;
 *  - multi-turn priors: each case runs under a unique replay session id and
 *    its priors are seeded into `context_usage` for that session only;
 *    seeded + written rows are deleted after the case;
 *  - co-activations: `logInjection` records co-activation pairs for every
 *    injection, and spreading activation READS them globally — the table is
 *    backed up once at run start and restored after every case, so case N
 *    cannot feed case N+1;
 *  - secondary vaults: suppressed by default (the config would point at the
 *    LIVE skill vault, not a snapshot — cross-DB contamination); pass
 *    `skillVaultDb` to replay the secondary lane against a snapshot copy;
 *  - session focus: CLAWMEM_SESSION_FOCUS is cleared; replay session ids are
 *    unique, so no per-session focus file can exist.
 *  - inference caches (`llm_cache`) are deliberately NOT rolled back — same
 *    documented behavior as the query-mode harness, and it keeps expansion
 *    outputs stable across A/B runs on one snapshot.
 *
 * Replay is SEQUENTIAL — parallel cases would contend on the shared
 * expansion/rerank services and corrupt per-case latency.
 */

import { existsSync, mkdirSync, writeFileSync, appendFileSync, readFileSync } from "fs";
import { DEADLINE_PROTOCOL, DEADLINE_PROTOCOL_IDENTITY } from "../vector-protocol.ts";
import { join } from "path";
import { createHash } from "crypto";
import type { Store } from "../store.ts";
import { resolveStore, DEFAULT_EMBED_MODEL, DEFAULT_QUERY_MODEL, DEFAULT_RERANK_MODEL } from "../store.ts";
import { normalizeRemoteLlmReasoningEffort, normalizeRemoteLlmNoThink } from "../llm.ts";
import { contextSurfacing, RERANK_REQUEST_REV, assertHookBudgetConfig, DEFAULT_HOOK_BUDGET_MS, FINALIZATION_RESERVE_MS , resolveEvalNow } from "../hooks/context-surfacing.ts";
import { evidenceMs, elapsed, monoNow, isoNow, epochNow, epochMs, type DurationMs } from "../clock.ts";
import type { VectorLegDeadlineRecord } from "./hook-trace.ts";
import { RERANK_LANE_WEIGHT, FUSION_POLICY_REV, RERANK_DEGENERACY_GATE_ACTIVE, ADMISSION_POLICY_ACTIVE, ADMISSION_POLICY_REV } from "../hooks/surfacing-fusion.ts";
import { spawnEvalVectorDaemon, EvalVectorDaemonError, type EvalVectorDaemon, type EvalVecPrewarm } from "./vec-daemon-child.ts";
import { daemonPing } from "../vector-daemon.ts";
import { describeVectorExec, type VectorExecIdentity } from "./run-identity.ts";
import { clearConfigCache } from "../config.ts";
import { parseHookGoldFile, resolveHookLabels, type HookGoldExample } from "./hook-gold.ts";
import { newSurfacingTrace, type SurfacingTrace } from "./hook-trace.ts";
import { computeHookCaseMetrics, aggregateHookMetrics, type HookAggregate, type HookCaseMetrics } from "./hook-metrics.ts";
import { auditTrace, type InvariantAudit } from "./hook-invariants.ts";
// The run-identity contract lives in its own module so the pair audit and this
// orchestrator validate identity by the SAME rule with no import cycle
// (BUILD-3c); re-exported here because every existing importer addresses it
// through hook-run.
import { TOPOLOGY_FIELDS, validateIdentityShape, PAIR_TREATMENTS, type RunIdentity, type PairTreatment , parseEvalNowTimestamp } from "./run-identity.ts";
export { validateIdentityShape, PAIR_TREATMENTS, type RunIdentity, type PairTreatment } from "./run-identity.ts";
// BUILD-3c in-run pair gate: the SAME comparison function the post-hoc CLI
// audit uses — a gate that judged pairs by its own weaker rule would be
// theatre (codex turn-20: "once the comparison function is complete").
import { comparePairedCase, compareIdentities, readRunTraces, readRunHeader, type PairCaseVerdict } from "./pair-audit.ts";

/** Thrown when injected-document identity cannot be established unambiguously. */
export class HookEvalIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HookEvalIntegrityError";
  }
}

/** The three judged admission bases (surfacing-fusion AdmissionBasis) — the "none" bucket (never reached admission) is deliberately not registrable. */
export const ADMISSION_BASES = ["bm25-rrf", "weighted-rrf", "rerank-fused-rrf"] as const;

/**
 * Per-stratum admission-basis coverage of VALID pairs (codex t68 F3):
 * for every stratum a case belongs to (its profile AND its split), count the
 * valid pairs whose recorded admission_basis equals each judged basis.
 * Pure + exported so the unit suite pins the derivation and the replicated
 * aggregate's reconciliation recomputes the same map from the same rows.
 */
export function deriveValidBasisByStratum(
  rows: { id: string; profile: string; split: string; admission_basis?: string | null }[],
  validSet: ReadonlySet<string>,
): Record<string, number> {
  const acc = new Map<string, number>();
  for (const r of rows) {
    if (!validSet.has(r.id)) continue;
    const b = r.admission_basis;
    if (!b || !(ADMISSION_BASES as readonly string[]).includes(b)) continue;
    for (const stratum of new Set([r.profile, r.split])) {
      const k = `${stratum}:${b}`;
      acc.set(k, (acc.get(k) ?? 0) + 1);
    }
  }
  return Object.fromEntries([...acc.entries()].sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0)));
}

export interface RunHookEvalOptions {
  goldPath: string;
  /** Store opened on the corpus snapshot. Caller owns its lifecycle. */
  store: Store;
  /** k for nDCG@k. Default 10. */
  limit?: number;
  /** Whole-hook latency bar for the timeout-rate metric, ms. Default 8000. */
  budgetMs?: number;
  /** Trust-gate floor for scored cases. Default 30. */
  minExamples?: number;
  /** Operator attests a 10–20% hand-audit of the labels passed. */
  audited?: boolean;
  /** Directory for run artifacts; omit to skip writing (tests). */
  outDir?: string;
  /** Snapshot path for the secondary (skill) vault — enables the secondary lane against it. */
  skillVaultDb?: string;
  /** Override every case's profile (A/B a single profile across the whole set). */
  profileOverride?: "speed" | "balanced" | "deep";
  /**
   * Prior run's hook-run.json for the CONTRACT-5 judged ACCEPTANCE gate:
   * the candidate's held-out slice must not regress the baseline (nDCG,
   * must-include recall, abstention within tolerance; must-not case rate and
   * timeout rate must not increase; p50/p95 latency within tolerance).
   * Acceptance REQUIRES a held-out slice on both sides and a comparable run
   * identity — incomparable runs hard-fail instead of comparing. Without a
   * baseline the run is a TRUST-ONLY run: `gates.acceptance_pass` stays null
   * and `gates.pass` (product acceptance) is false by construction.
   */
  baselinePath?: string;
  /**
   * sha256 of the ORIGINAL corpus snapshot CONTENTS (main db + -wal when
   * present, + the skill snapshot when supplied), CLI-computed before the
   * working copy is made. Content-addressed: a byte-identical snapshot at a
   * different path compares equal; different contents at the same path do
   * not (codex turn-8 finding 4).
   */
  corpusHash?: string;
  /** Human-readable label of the original snapshot (informational only — never compared). */
  corpusLabel?: string;
  /** Best-effort model ids actually served by the endpoints (CLI probes /v1/models). */
  servedModels?: { embed?: string; llm?: string; rerank?: string };
  /**
   * Latency measurement protocol: each case is replayed this many times
   * (fresh replay session per rep — full isolation) and the case latency is
   * the LOWER MEDIAN of the reps. Metrics/trace come from rep 0. Default 3.
   * The protocol is part of the run identity; a baseline measured under a
   * different protocol makes the latency axes unmeasurable, never silently
   * comparable (codex turn-8 finding 3).
   */
  latencyReps?: number;
  /**
   * Acceptance axes explicitly declared out of scope when unmeasured on the
   * held-out slice (no labeled cases for the axis, or latency-protocol
   * mismatch). An UNDECLARED unmeasured required axis FAILS acceptance
   * (codex turn-8 finding 5).
   */
  acceptUnmeasured?: string[];
  /**
   * Expansion-set identifier for identity.ranking_policy (codex turn-17
   * finding 1). Default "sampled" — each case draws its own expansion
   * variants at generation temperature. Superseded automatically by
   * expansionFreeze / expansionCapture, which record "draw:<fingerprint>".
   */
  expansionSet?: string;
  /**
   * PAIRED-COUNTERFACTUAL draw freeze (codex turn-17 finding 2): llm_cache
   * rows captured by a generator arm, injected into this run's working copy
   * BEFORE scoring so expandQuery cache-hits the exact same expansion draw
   * and both arms rank identical inputs. Any llm_cache write during the run
   * (an LLM call the draw did not cover) HARD-FAILS the run — a leaked draw
   * is not a paired arm. The draw's BINDING (gold fingerprint, corpus
   * content hash, models) is validated against THIS run before injection —
   * cached scores are outputs, trustworthy as frozen inputs only under the
   * same gold/corpus/models (codex turn-18 finding 2). Identity records
   * expansion_set = "draw:<fp>". Production expansion stays stochastic;
   * only the replay evaluator freezes draws.
   */
  expansionFreeze?: { fingerprint: string; rows: { hash: string; result: string }[]; binding: ExpansionDrawBinding };
  /**
   * Capture this run's llm_cache delta (vs the working copy's pre-run state,
   * by VALUE — an overwrite of a stale cached row is part of the draw) as a
   * reusable expansion draw: the generator arm of a paired counterfactual.
   * The result carries rows + fingerprint; identity records
   * expansion_set = "draw:<fingerprint>". Mutually exclusive with
   * expansionFreeze.
   */
  expansionCapture?: boolean;
  /**
   * TEST-ONLY seam (integrated failure-path tests, codex turn-24 finding 1):
   * extra timing samples appended before the trust gates are computed —
   * proving a reserve/budget violation fails TRUST and the CLI exit,
   * independent of whether the host happens to be slow. Never set outside
   * tests; the real samples come from the rep loop.
   * `finalizationSubstages` (codex turn-49 finding 2) feeds the report's
   * `finalization_breakdown` and the top-substage naming in the reserve gate
   * reason, so the report-level wiring is a tested product boundary.
   */
  _testTimingSamples?: { finalization?: number[]; totals?: number[]; finalizationSubstages?: Record<string, number>[]; vectorLegs?: VectorLegRunRecord[] };
  /**
   * TEST-ONLY seam, the shape codex specified in turn 30 (finding 3): a
   * transformer applied to each attempt's audit immediately after
   * `auditTrace`, so attempt 0 of a genuinely retried handler case can be
   * given an enforced violation and the report asserted to preserve it and
   * fail `trust_pass`. Receives the real audit plus the case id and the
   * 0-based attempt index; returns the audit to record. Never set outside
   * tests — the real audits come from `auditTrace` untouched.
   */
  _testAuditTransform?: (audit: InvariantAudit, caseId: string, attempt: number) => InvariantAudit;
  /**
   * BUILD-3c (in-run pair gate, the turn-22 obligation): directory of the
   * PARTNER run (traces.jsonl + hook-run.json) this run pairs against.
   * After the case loop, every case's pre-treatment envelope is audited
   * against the partner's (pair-audit); invalid cases are re-run FRESH up to
   * pairMaxRetries rounds (reject + replace — a transient timing dropout
   * gets a fresh replicate instead of poisoning the pair), the report
   * records pair_audit, and ACCEPTANCE is computed over VALID pairs only.
   * Requires pairMinValid (pre-registered — a post-hoc threshold is not a
   * gate). Incompatible with expansionCapture (a capture arm has no partner
   * yet). When baselinePath is also set it must be the partner's own
   * hook-run.json — "acceptance over valid pairs" is meaningless against a
   * third run.
   */
  pairWith?: string;
  /**
   * Pre-registered MINIMUM number of VALID pairs (all splits) the run must
   * end with; fewer ⇒ HookEvalIntegrityError (refusal, not a silent
   * degraded acceptance). Required with pairWith.
   */
  pairMinValid?: number;
  /** Retry rounds for invalid pair-cases (fresh re-runs). Default 2; 0 = audit-only reject. */
  pairMaxRetries?: number;
  /**
   * PRE-REGISTERED case ids that MUST end up valid (codex turn-29 SPEC
   * finding 5). A total-count threshold alone lets an experiment discard
   * every treatment-bearing case and still "pass" on cases where the
   * treatment is inactive — every reported row paired, yet the accepted
   * experiment no longer tests the treatment. Named witnesses make that
   * machine-impossible: BUILD-3d's mandatory leadgen and rankdefect
   * witnesses are enforced here, not inspected afterwards.
   */
  pairRequireIds?: string[];
  /**
   * PRE-REGISTERED minimum valid pairs per STRATUM — `{profile: n}` and/or
   * `{split: n}` (both namespaces are checked; a key matching neither is an
   * error, so a typo cannot silently gate nothing). Guarantees the treatment-
   * bearing strata survive the gate, not just the total.
   */
  pairMinValidByStratum?: Record<string, number>;
  /**
   * Like pairMinValidByStratum, but counts only pairs where the treatment was
   * actually EXPOSED (codex turn-30 SPEC-2; treatment-AWARE since codex
   * turn-40 finding 4 — see treatmentExposed). A `deep` minimum satisfied
   * entirely by degraded RRF cases is not evidence about a rerank-weight
   * treatment, and one satisfied by never-degenerate cases is not evidence
   * about a degeneracy-gate treatment.
   */
  pairMinExposedByStratum?: Record<string, number>;
  /**
   * PRE-REGISTERED per-stratum ADMISSION-BASIS coverage minima (codex t68
   * F3) — keys are `<stratum>:<basis>` (e.g. "speed:bm25-rrf"), counting
   * VALID pairs whose candidate-arm case was judged on that basis
   * (case admission_basis). The machine-decisive form of the R4
   * topology-complete shipping requirement: a shipping gold whose BM25
   * surface never survives the pair gate refuses instead of silently
   * shipping an unvalidated basis.
   */
  pairMinBasisByStratum?: Record<string, number>;
  /**
   * The REGISTERED treatments of this paired experiment (codex turn-40
   * finding 2): exactly these ranking_policy variables may differ from the
   * partner — the in-run identity gate refuses any other policy delta, and
   * paired acceptance permits exactly the registered difference (the
   * unpaired --baseline path stays strict). Default [] — the arms must be
   * policy-identical (a replicate audit). Requires pairWith. Also selects
   * the exposure predicate: a "degeneracy_gate" experiment counts a pair as
   * treatment-exposed only when the assessment actually fired (finding 4).
   */
  pairTreatments?: PairTreatment[];
  /**
   * Codex t76 (daemon-backed eval): the VECTOR EXECUTION PROTOCOL of this run.
   *   - "daemon-required" (the production/shipping protocol): a dedicated
   *     vector-daemon CHILD process is spawned on the store's working copy
   *     before the first case (bounded, VERIFIED readiness — or refusal),
   *     every vector leg (primary, deep, prior) is daemon-REQUIRED for the
   *     whole run (an absent/stale daemon never falls back to the in-process
   *     scan: daemon loss REFUSES the run), and the child is terminated with
   *     a bounded escalation to SIGKILL in `finally`. `prewarm` declares the
   *     daemon's prewarm policy ("steady-state" = the long-lived watcher
   *     topology's periodic prewarm performed before readiness).
   *   - "in-process": the vector legs run the synchronous in-process scan (a
   *     profile timeout cannot fire during it). Recorded as such; the run's
   *     latency evidence is NOT authoritative on vector-exercising profiles
   *     (acceptance treats the latency axes as unmeasured) and it is never
   *     comparable to a daemon-required run.
   * Omitted ⇒ "in-process" ONLY for an in-memory store (a child cannot serve
   * `:memory:`); a file-backed store must declare its protocol — refused
   * otherwise, so no run on a daemon-servable copy is ever in-process by
   * omission. Recorded in identity as `vector_exec` (STRICT on every
   * comparison surface; not a registrable treatment).
   */
  vectorExec?: VectorExecSpec;
  /**
   * TEST-ONLY seam (codex t76 constraint 7 — mid-run daemon death): invoked
   * at the start of every case attempt with the eval daemon's pid, so a test
   * can kill the child on cue and assert the refusal. Never set outside tests.
   */
  _testOnCaseStart?: (info: { index: number; attempt: number; daemonPid: number | null }) => void;
}

/** See RunHookEvalOptions.vectorExec. */
export type VectorExecSpec =
  | {
      protocol: "daemon-required"; prewarm: EvalVecPrewarm; readyTimeoutMs?: number; stopTimeoutMs?: number;
      /**
       * TEST-ONLY seam (codex t78 F1): override of OWNERSHIP_PING_TIMEOUT_MS,
       * the bound on the ownership ping performed BEFORE and AFTER every rep.
       * The production value is the fixed constant — never a CLI flag, never
       * identity — so every real run verifies ownership under one threshold;
       * tests use a small value to make a wedged daemon refuse quickly. Must be
       * a positive finite integer (refused otherwise). Never set outside tests.
       */
      _testOwnershipPingTimeoutMs?: number;
    }
  | { protocol: "in-process" };

/**
 * Codex t77 F2 / t78 F1: the ownership ping bound (ms) — a FIXED production
 * constant, part of the daemon-required protocol rather than a per-run
 * variable. Generous because the child is single-threaded: a ping issued
 * while its synchronous scan is still running is answered only when that
 * scan completes — so every rep also STARTS on an idle, verified daemon. A
 * ping that fails or times out refuses the run.
 */
export const OWNERSHIP_PING_TIMEOUT_MS = 30_000;

/** The identity form of a resolved VectorExecSpec. `response_protocol` (codex t84 CR-5): this
 * build's client always REQUESTS hydrated-v1 on every daemon leg, and the runner REFUSES any
 * rep whose ok leg was served raw-hit (a raw request answered on the socket — defense in depth: a
 * legacy daemon's unattested raw answer is already `skew` since O1 §4) — so a completed
 * daemon-required run's identity truthfully records "hydrated-v1". */
export function vectorExecIdentity(spec: VectorExecSpec): VectorExecIdentity {
  return spec.protocol === "daemon-required"
    ? { protocol: "daemon-required", prewarm: spec.prewarm, response_protocol: "hydrated-v1" }
    : { protocol: "in-process", prewarm: "n/a", response_protocol: "n/a" };
}

/**
 * Whether a run's LATENCY evidence (the handler budget gate, the p50/p95
 * acceptance axes) is authoritative for the daemon-backed production contract
 * (codex t76): under "in-process" a profile's vector timeout cannot fire during
 * the synchronous scan, so a measured overrun is an execution production never
 * performs under the watcher — not evidence. Vacuous on profiles that never run
 * a vector leg (speed): those runs are authoritative under either protocol.
 */
export function latencyEvidenceAuthoritative(vectorExec: VectorExecIdentity, profiles: string): boolean {
  return vectorExec.protocol === "daemon-required" || !exercisedServices(profiles).includes("embed");
}

/**
 * What an expansion draw was captured UNDER — validated on replay before
 * injection (codex turn-18 finding 2). The corpus content hash is the
 * load-bearing member: the reranker's transmitted text is a deterministic
 * function of corpus + code, so binding to corpus content is what makes a
 * cached score trustworthy as a frozen INPUT rather than a stale OUTPUT.
 * rerank_request_rev pins the CODE side of that function (codex turn-19
 * finding 2): corpus content alone does not determine transmitted text
 * across code revisions, so a draw captured under one request construction
 * is refused by a run under another — cross-build replay fails closed until
 * BUILD-3's cache-identity contract (transmitted-text hashes + provider
 * fingerprint) supersedes this coarse revision pin.
 */
export interface ExpansionDrawBinding {
  gold_fingerprint: string;
  corpus: string | null;
  query_model: string;
  rerank_model: string;
  rerank_request_rev: number;
  /**
   * BUILD-3b (binding v3): the served-provider fingerprint of the rerank
   * endpoint the draw was captured against (identity topology `served_rerank`
   * — a probed behavioral fingerprint, "unreachable", or "unknown"). Cached
   * rerank scores are the PROVIDER's outputs; a draw captured against one
   * provider is refused by a run served by another. Compared PRE-injection
   * (the candidate's probe is known before the run).
   */
  served_rerank: string;
  /**
   * BUILD-3b (binding v3): sha256 over the sorted unique per-candidate
   * transmitted-text hashes of the capture run (transmittedTextManifest) —
   * the exact texts the reranker scored, from trace.rerank.sentTextHashes.
   * Validated POST-run on a standalone frozen replay: this run's manifest
   * must equal the draw's, or the cached scores were bound to texts this run
   * never transmitted. Superseded by the per-case pair gate when pairWith is
   * active (the finer instrument — invalid cases are retried/excluded
   * per-case instead of refusing the whole run).
   */
  transmitted_text_manifest: string;
}

/**
 * Content hash over an ordered list of files with LENGTH FRAMING — each
 * file's byte length prefixes its bytes, so ["ab","c"] and ["a","bc"] can
 * never collide (codex turn-9 finding 3). Missing/undefined entries hash as
 * zero-length markers so the file LIST shape is part of the digest. Shared
 * by the eval CLI (which hashes the WORKING COPIES — the bytes actually
 * executed) and the stamp tool (which hashes the attested snapshot).
 */
export async function hashCorpusFiles(paths: (string | undefined)[]): Promise<string> {
  const h = new Bun.CryptoHasher("sha256");
  for (const p of paths) {
    if (!p || !existsSync(p)) {
      h.update(" absent ");
      continue;
    }
    const bytes = await Bun.file(p).arrayBuffer();
    h.update(` ${bytes.byteLength} `);
    h.update(bytes);
  }
  return h.digest("hex");
}

/**
 * Classify a probe failure: a transport-level failure (refused / timeout /
 * DNS / socket) means the endpoint is DOWN — "unreachable", itself an
 * identity-relevant topology state; anything the endpoint ANSWERED but we
 * could not fingerprint is "unknown" (which fails comparability on an
 * exercised service unless the identity is attested).
 */
function probeFailureKind(e: unknown): "unreachable" | "unknown" {
  const err = e as { code?: string; name?: string; message?: string };
  const s = `${err?.code ?? ""} ${err?.name ?? ""} ${err?.message ?? ""}`;
  return /refused|unable to connect|timed? ?out|abort|ENOTFOUND|EHOSTUNREACH|ECONNRESET|ECONNREFUSED|fetch failed|FailedToOpenSocket|ConnectionRefused/i.test(s)
    ? "unreachable"
    : "unknown";
}

/**
 * Probe what an OpenAI-compatible endpoint actually serves (GET /v1/models).
 * Tri-state: model id · "unreachable" (down/refused/timeout) · "unknown"
 * (answered but no model id). Used by the CLI and the stamp tool — never by
 * the runner (tests must not network).
 */
export async function probeServedModel(url: string | undefined): Promise<string> {
  if (!url) return "unreachable";
  try {
    const resp = await fetch(`${url.replace(/\/$/, "")}/v1/models`, { signal: AbortSignal.timeout(1500) });
    if (!resp.ok) return "unknown";
    const body = await resp.json() as { data?: { id?: string }[] };
    return body?.data?.[0]?.id ?? "unknown";
  } catch (e) {
    return probeFailureKind(e);
  }
}

/**
 * BEHAVIORAL fingerprint of a rerank endpoint: POST a fixed probe pair to
 * /v1/rerank and hash the rounded scores — the seq-cls sidecar exposes no
 * /v1/models, and a swapped model behind the same URL produces different
 * scores for the same fixed inputs (codex turn-9 finding 4).
 */
export async function probeRerankFingerprint(url: string | undefined): Promise<string> {
  if (!url) return "unreachable";
  try {
    const resp = await fetch(`${url.replace(/\/$/, "")}/v1/rerank`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        query: "clawmem topology probe: retrieval ranking identity",
        documents: [
          "clawmem topology probe document about retrieval ranking identity",
          "unrelated text about basket weaving supplies and reorder cadence",
        ],
      }),
      signal: AbortSignal.timeout(3000),
    });
    if (!resp.ok) return "unknown";
    const body = await resp.json() as { results?: { index?: number; relevance_score?: number }[] };
    if (!Array.isArray(body?.results) || body.results.length === 0) return "unknown";
    const canonical = body.results
      .map(r => `${r.index}:${(r.relevance_score ?? 0).toFixed(6)}`)
      .sort()
      .join("|");
    return `behavioral:${createHash("sha256").update(canonical).digest("hex").slice(0, 16)}`;
  } catch (e) {
    return probeFailureKind(e);
  }
}

/**
 * Canonical fingerprint of an expansion draw (paired counterfactuals, codex
 * turn-17 finding 2): sha256 over the hash-sorted (hash, result) pairs,
 * truncated to 16 hex chars. Exported so draw files can be verified without
 * replicating the construction.
 */
export function expansionDrawFingerprint(rows: { hash: string; result: string }[]): string {
  return createHash("sha256")
    .update(JSON.stringify([...rows].map(r => ({ hash: r.hash, result: r.result })).sort((a, b) => (a.hash < b.hash ? -1 : a.hash > b.hash ? 1 : 0))))
    .digest("hex").slice(0, 16);
}

/**
 * Canonical manifest over a run's transmitted rerank texts (BUILD-3b):
 * sha256 over the SORTED UNIQUE per-candidate transmitted-text hashes
 * (trace.rerank.sentTextHashes across all cases). Order- and multiplicity-
 * insensitive by design — the manifest identifies WHAT texts the reranker
 * scored, not how often or in which case. A run that never reranked yields
 * the deterministic empty-set manifest (still comparable: capture and replay
 * arms that both skipped rerank legitimately match). Exported so draw files
 * can be verified without replicating the construction.
 */
export function transmittedTextManifest(hashes: string[]): string {
  return createHash("sha256").update(JSON.stringify([...new Set(hashes)].sort())).digest("hex");
}

/** Canonical full-case gold fingerprint over the SCORED examples. */
export function goldFingerprint(examples: HookGoldExample[]): string {
  const canonical = examples
    .map(e => ({
      id: e.id,
      prompt: e.prompt,
      priors: e.priors.map(p => ({ text: p.text, age_minutes: p.age_minutes })),
      profile: e.profile,
      expect_abstain: e.expect_abstain,
      prior_leg: e.prior_leg,
      labels: {
        must_include: [...e.labels.must_include].sort(),
        acceptable: [...e.labels.acceptable].sort(),
        must_not_include: [...e.labels.must_not_include].sort(),
      },
      split: e.split,
      tags: [...e.tags].sort(),
    }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

/** Aggregate metric fields — every one must be a finite number or null in a valid report. */
const AGGREGATE_METRIC_FIELDS = [
  "ndcgMean", "mustNotCaseRate", "mustNotDocRate", "mustIncludeRecallMean",
  "abstentionAccuracy", "falseAbstainRate", "priorLegAccuracy",
  "latencyP50Ms", "latencyP95Ms", "timeoutRate",
] as const;

function validateAggregateShape(v: unknown, what: string, bad: (msg: string) => never): void {
  if (!v || typeof v !== "object" || Array.isArray(v)) bad(`${what} is not an object`);
  const o = v as Record<string, unknown>;
  if (typeof o.cases !== "number" || !Number.isFinite(o.cases)) bad(`${what}.cases is not a finite number`);
  for (const f of AGGREGATE_METRIC_FIELDS) {
    const val = o[f];
    if (val !== null && (typeof val !== "number" || !Number.isFinite(val))) {
      bad(`${what}.${f} is not a finite number or null`);
    }
  }
}

/**
 * Validated parse of a baseline hook-run.json — malformed input (including
 * non-finite/string-typed metric values that would coerce inside the axis
 * comparisons, and malformed identity blocks that would TypeError) throws
 * HookEvalIntegrityError instead of flowing through an unchecked cast
 * (codex turn-8 finding 1).
 */
export function parseBaselineReport(path: string): HookRunReport {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf-8"));
  } catch (e) {
    throw new HookEvalIntegrityError(`baseline ${path} is not readable JSON: ${(e as Error).message}`);
  }
  const bad = (what: string): never => {
    throw new HookEvalIntegrityError(`baseline ${path} is not a valid hook-run report: ${what}`);
  };
  const r = raw as Partial<HookRunReport>;
  if (typeof r.run_id !== "string") bad("missing run_id");
  if (r.surface !== "context-surfacing") bad(`surface is ${JSON.stringify(r.surface)}`);
  if (typeof r.limit !== "number" || !Number.isFinite(r.limit)) bad("limit is not a finite number");
  if (typeof r.budget_ms !== "number" || !Number.isFinite(r.budget_ms)) bad("budget_ms is not a finite number");
  validateAggregateShape(r.aggregate, "aggregate", bad);
  if (!r.by_split || typeof r.by_split !== "object" || Array.isArray(r.by_split)) bad("missing by_split");
  for (const [split, agg] of Object.entries(r.by_split ?? {})) validateAggregateShape(agg, `by_split.${split}`, bad);
  if (!Array.isArray(r.cases) || r.cases.some(c => typeof c?.id !== "string" || typeof c?.split !== "string" || typeof c?.profile !== "string")) {
    bad("missing/malformed cases array");
  }
  if (r.identity !== undefined) validateIdentityShape(r.identity, bad);
  return r as HookRunReport;
}

/**
 * Enforce identity comparability between two ATTESTED identities. Everything
 * except the latency protocol must match exactly — the latency protocol is
 * compared by the caller, which downgrades the latency AXES to unmeasured on
 * mismatch instead of refusing the whole (still-comparable) relevance
 * comparison. Baselines WITHOUT an identity never reach this function — they
 * are informational-only and can never produce acceptance_pass: true
 * (codex turn-8 finding 4).
 */
/** Services a run's profiles actually exercise (per-profile retrieval surface). */
function exercisedServices(profiles: string): ("embed" | "llm" | "rerank")[] {
  const out: ("embed" | "llm" | "rerank")[] = [];
  if (/balanced|deep/.test(profiles)) out.push("embed");
  if (/deep/.test(profiles)) out.push("llm", "rerank");
  return out;
}

function assertComparableIdentity(
  candidate: RunIdentity,
  baseline: RunIdentity,
  baselineRunId: string,
  opts: {
    expansionSet?: "strict" | "frozen-draw-member";
    /**
     * REGISTERED treatments of a paired experiment (codex turn-40 finding 2):
     * paired acceptance permits exactly the registered ranking-policy
     * difference(s) — noted, never a mismatch — while everything else stays
     * strict. Only the pair-gated acceptance path passes this (the baseline
     * is the partner by construction); the plain --baseline path never does.
     */
    registeredTreatments?: readonly PairTreatment[];
  } = {},
): { notes: string[]; informational: string[] } {
  const mismatches: string[] = [];
  if (baseline.gold_fingerprint !== candidate.gold_fingerprint) mismatches.push("gold cases (full-content fingerprint)");
  if (baseline.limit !== candidate.limit) mismatches.push(`limit (${baseline.limit} vs ${candidate.limit})`);
  if (baseline.budget_ms !== candidate.budget_ms) mismatches.push(`budget_ms (${baseline.budget_ms} vs ${candidate.budget_ms})`);
  if (baseline.profiles !== candidate.profiles) mismatches.push(`profiles (${baseline.profiles} vs ${candidate.profiles})`);
  if (baseline.corpus !== candidate.corpus) mismatches.push(`corpus content hash (${baseline.corpus} vs ${candidate.corpus})`);
  const bt = baseline.topology, ct = candidate.topology;
  for (const f of TOPOLOGY_FIELDS) {
    if (bt[f] !== ct[f]) mismatches.push(`topology.${f} (${bt[f]} vs ${ct[f]})`);
  }
  // An "unknown" served model (endpoint up but unfingerprintable) on a
  // service the run's profiles EXERCISE is not comparable evidence — two
  // unknowns matching each other proves nothing about the models (codex
  // turn-9 finding 4). An attested identity carries the operator's explicit
  // claim instead.
  const servedField = { embed: "served_embed", llm: "served_llm", rerank: "served_rerank" } as const;
  for (const svc of exercisedServices(candidate.profiles)) {
    for (const [side, who] of [[baseline, "baseline"], [candidate, "candidate"]] as const) {
      if (side.attested) continue;
      const served = side.topology[servedField[svc]];
      if (served === "unknown") {
        mismatches.push(`${who} served model for exercised service "${svc}" is unknown (endpoint answered but could not be fingerprinted) and the identity is not attested`);
      }
    }
  }
  // Local-fallback POLICY (codex turn-11 findings 3/4) — never blind strict
  // equality. The candidate side is enforced by the caller BEFORE this
  // function ("allowed" candidates are refused outright, legacy baselines
  // included). The baseline side:
  //  - "allowed" UNATTESTED → not comparable (the executed pipeline is
  //    unidentifiable — any mid-run endpoint failure silently executed an
  //    unidentified in-process model);
  //  - "allowed" attested + fallback_observed "none" → comparable (the
  //    attester verified from route evidence that no local model executed —
  //    pipeline-equivalent to "blocked");
  //  - "allowed" attested otherwise → INFORMATIONAL-only (axes computed and
  //    reported; acceptance can never pass against it).
  const informational: string[] = [];
  const notes: string[] = [];
  if (bt.local_fallback === "allowed") {
    if (!baseline.attested) {
      mismatches.push(`baseline ran with local fallback ALLOWED and its identity is not attested — the executed pipeline is unidentifiable; attest it (with fallback_observed) or re-run it under CLAWMEM_NO_LOCAL_MODELS=true`);
    } else if (bt.fallback_observed === "none") {
      notes.push(`baseline ran with local fallback ALLOWED but its attestation carries fallback_observed="none" (no local model executed) — pipeline-equivalent to "blocked"`);
    } else {
      informational.push(
        `baseline ran with local fallback ALLOWED and its routing is ${bt.fallback_observed === "unknown" ? `attested fallback_observed="unknown"` : "not attested per-route"} — ` +
        `whether a local model served any mid-run request cannot be reconstructed, so this comparison is INFORMATIONAL only`
      );
    }
  }
  // Ranking-policy identity (codex turn-17 finding 1). The rerank-lane
  // weight and the expansion protocol are STRICT: a weight difference is a
  // TREATMENT (compare within a paired counterfactual, never via --baseline)
  // and runs under different expansion protocols measured different inputs.
  // fusion_policy_rev differences are the code-under-test delta acceptance
  // comparison exists to measure — informational note only. A baseline
  // written before this block exists is legacy: unverifiable, so the
  // comparison is demoted to INFORMATIONAL rather than trusted.
  const bp = baseline.ranking_policy, cp = candidate.ranking_policy;
  if (!bp && cp) {
    informational.push(
      `baseline predates ranking_policy identity (rerank-lane weight / fusion rev / expansion protocol unverifiable) — this comparison is INFORMATIONAL only`
    );
  } else if (bp && cp) {
    const registered = opts.registeredTreatments ?? [];
    if (bp.rerank_lane_weight !== cp.rerank_lane_weight) {
      if (registered.includes("rerank_lane_weight")) {
        notes.push(`REGISTERED treatment rerank_lane_weight differs by design (baseline ${bp.rerank_lane_weight} → candidate ${cp.rerank_lane_weight}) — paired acceptance measures exactly this difference`);
      } else {
        mismatches.push(`ranking_policy.rerank_lane_weight (${bp.rerank_lane_weight} vs ${cp.rerank_lane_weight}) — a weight difference is a treatment variable; compare arms within a paired experiment with the treatment REGISTERED (pairTreatments / --pair-treatment), not via --baseline`);
      }
    } else if (registered.includes("rerank_lane_weight")) {
      // Registered-but-equal is a NO-OP experiment (codex turn-41 finding 3)
      // — the in-run pair gate refuses it first; this is defense in depth at
      // the acceptance comparison.
      mismatches.push(`registered treatment rerank_lane_weight does NOT differ between the arms (both ${cp.rerank_lane_weight}) — a no-op treatment is not an experiment`);
    }
    if (opts.expansionSet === "frozen-draw-member") {
      // Replicated-aggregate MEMBER comparison (BUILD-3d): the n member runs
      // of one arm must share every identity field EXCEPT the draw — each
      // side must be a frozen draw, and two members sharing one draw are one
      // draw counted twice (the aggregator additionally checks uniqueness
      // across ALL members; the pairwise check here is defense in depth).
      for (const [who, side] of [["baseline", bp], ["candidate", cp]] as const) {
        if (!/^draw:/.test(side.expansion_set)) {
          mismatches.push(`${who} expansion_set "${side.expansion_set}" is not a frozen draw — a replicated aggregate is built from frozen-draw member runs only`);
        }
      }
      if (/^draw:/.test(bp.expansion_set) && bp.expansion_set === cp.expansion_set) {
        mismatches.push(`member runs share the same frozen draw (${bp.expansion_set}) — n copies of one draw are one draw, not a replicated distribution`);
      }
    } else if (bp.expansion_set !== cp.expansion_set) {
      mismatches.push(`ranking_policy.expansion_set (${bp.expansion_set} vs ${cp.expansion_set})`);
    } else if (bp.expansion_set === "sampled" && exercisedServices(candidate.profiles).includes("llm")) {
      // "sampled" === "sampled" is NOT evidence of identical expansion inputs
      // on a run whose profiles exercise expansion (deep): each side drew its
      // own variants at generation temperature, so the two runs measured
      // materially different retrieval inputs while advertising equal
      // identities (codex turn-18 finding 1). Deep acceptance requires a
      // frozen draw on both sides (--capture/--replay-expansions ⇒
      // "draw:<fp>") or the replicated-distribution protocol
      // ("replicated:<n>" — BUILD-3d aggregates). Profiles without
      // expansion (speed/balanced) are unaffected — "sampled" is vacuous
      // there.
      mismatches.push(
        `ranking_policy.expansion_set is "sampled" on both sides while the run's profiles (${candidate.profiles}) exercise expansion — independently sampled draws are different retrieval inputs, not a comparable identity; freeze a draw across both runs (--capture-expansions / --replay-expansions) or use a replicated-distribution protocol`
      );
    } else if (/^replicated:[0-9]+$/.test(bp.expansion_set)) {
      // Replicated-vs-replicated at equal n (the strings are strictly equal
      // here, so equal n is already established): each side's numbers
      // aggregate n independent draws, which is exactly what makes them
      // comparable under expansion sampling variance (codex turn-18 ruling:
      // "replicated independent draws for distributional acceptance").
      // The draw LISTS need not match — identical lists are the stronger
      // draw-paired form; different lists are two independent samples of
      // the same generation distribution. Both are noted so the artifact
      // states which form the comparison took.
      const bd = [...(bp.expansion_draws ?? [])].sort();
      const cd = [...(cp.expansion_draws ?? [])].sort();
      if (bd.length === cd.length && bd.every((v, i) => v === cd[i])) {
        notes.push(`replicated protocol with IDENTICAL draw sets (${bd.length} draws) — the draw-paired form: both arms replayed the same draws`);
      } else {
        notes.push(`replicated protocol with independent draw sets (${bd.length} vs ${cd.length} draws overlapping on ${bd.filter(d => cd.includes(d)).length}) — a distributional comparison across independent samples of the expansion distribution`);
      }
    }
    // BUILD-3d: the degeneracy-gate toggle is a treatment variable (same
    // class as the weight). Both present + different ⇒ refuse. An absent
    // field is knowable from code history: rev < 6 code had no gate, so the
    // difference is part of the code-under-test delta this comparison
    // exists to measure (noted, like hook_budget_ms legacy); an absent
    // field on a rev >= 6 identity is refused by validateIdentityShape
    // before reaching here.
    if (bp.degeneracy_gate !== undefined && cp.degeneracy_gate !== undefined && bp.degeneracy_gate !== cp.degeneracy_gate) {
      if (registered.includes("degeneracy_gate")) {
        notes.push(`REGISTERED treatment degeneracy_gate differs by design (baseline ${bp.degeneracy_gate} → candidate ${cp.degeneracy_gate}) — paired acceptance measures exactly this difference`);
      } else {
        mismatches.push(`ranking_policy.degeneracy_gate (${bp.degeneracy_gate} vs ${cp.degeneracy_gate}) — a gate-toggle difference is a treatment variable; compare arms within a paired experiment with the treatment REGISTERED (pairTreatments / --pair-treatment), not via --baseline`);
      }
    } else if (bp.degeneracy_gate !== undefined && cp.degeneracy_gate !== undefined && registered.includes("degeneracy_gate")) {
      mismatches.push(`registered treatment degeneracy_gate does NOT differ between the arms (both ${cp.degeneracy_gate}) — a no-op treatment is not an experiment`);
    } else if (bp.degeneracy_gate === undefined && cp.degeneracy_gate !== undefined) {
      notes.push(`baseline predates the degeneracy gate (fusion rev ${bp.fusion_policy_rev} — pre-BUILD-3d code had no gate); the gate is part of the code-under-test delta this comparison measures`);
    }
    // BUILD-4: the admission policy is a treatment variable (same class as
    // the weight and the gate toggle). Both present + different ⇒ refuse
    // unless registered. Absent on the baseline is knowable from code
    // history: rev < 7 code had no admission-policy field — noted as the
    // code-under-test delta; a rev >= 7 identity without it is refused by
    // validateIdentityShape before reaching here.
    if (bp.admission_policy !== undefined && cp.admission_policy !== undefined && bp.admission_policy !== cp.admission_policy) {
      if (registered.includes("admission_policy")) {
        notes.push(`REGISTERED treatment admission_policy differs by design (baseline ${bp.admission_policy} → candidate ${cp.admission_policy}) — paired acceptance measures exactly this difference`);
      } else {
        mismatches.push(`ranking_policy.admission_policy (${bp.admission_policy} vs ${cp.admission_policy}) — an admission-policy difference is a treatment variable; compare arms within a paired experiment with the treatment REGISTERED (pairTreatments / --pair-treatment), not via --baseline`);
      }
    } else if (bp.admission_policy !== undefined && cp.admission_policy !== undefined && registered.includes("admission_policy")) {
      mismatches.push(`registered treatment admission_policy does NOT differ between the arms (both ${cp.admission_policy}) — a no-op treatment is not an experiment`);
    } else if (bp.admission_policy === undefined && cp.admission_policy !== undefined) {
      notes.push(`baseline predates the admission policy (fusion rev ${bp.fusion_policy_rev} — pre-BUILD-4 code had no admission-policy field); the policy is part of the code-under-test delta this comparison measures`);
    }
    if (bp.admission_rev !== undefined && cp.admission_rev !== undefined && bp.admission_rev !== cp.admission_rev) {
      notes.push(`admission machinery rev differs (baseline ${bp.admission_rev} → candidate ${cp.admission_rev}) — the code-under-test admission semantics changed between the runs`);
    }
    if (bp.fusion_policy_rev !== cp.fusion_policy_rev) {
      notes.push(`fusion policy rev differs (baseline ${bp.fusion_policy_rev} → candidate ${cp.fusion_policy_rev}) — the code-under-test ordering semantics changed between the runs`);
    }
  }
  // BUILD-3a: the handler's internal budget is a behavioral parameter (it
  // sizes the escalation and rerank windows) — same class as the weight:
  // STRICT. Unlike ranking_policy, a LEGACY report's budget is knowable
  // from code history: pre-BUILD-3a code hardcoded 6000ms with no override,
  // so an absent field compares as exactly that value (noted, not demoted —
  // the build2f forward baselines stay fully comparable).
  if (candidate.hook_budget_ms !== undefined) {
    const baselineBudget = baseline.hook_budget_ms ?? DEFAULT_HOOK_BUDGET_MS;
    if (baseline.hook_budget_ms === undefined) {
      notes.push(`baseline predates hook_budget_ms — pre-BUILD-3a code pinned ${DEFAULT_HOOK_BUDGET_MS}ms (hardcoded, no override existed), compared as that value`);
    }
    if (baselineBudget !== candidate.hook_budget_ms) {
      mismatches.push(`hook_budget_ms (${baselineBudget} vs ${candidate.hook_budget_ms}) — a budget difference is a treatment variable; compare arms within a paired experiment, not via --baseline`);
    }
  }
  // BUILD-4 turn-56 (codex t55 F1): the evaluation clock is identity on
  // EVERY comparison surface — acceptance and replicated members included,
  // not only the pair gate's deep equality. The composite policy inputs
  // (recency/confidence) are functions of the clock, so two runs on
  // different clocks measured different admission inputs. FAIL-CLOSED on a
  // pre-turn-55 identity: an absent field means the clock the run computed
  // on is unidentifiable (turn-55+ code records null for wall clock
  // explicitly, so absence is never a legitimate state).
  for (const [who, side] of [["baseline", baseline], ["candidate", candidate]] as const) {
    if (side.eval_now === undefined) {
      mismatches.push(`${who} predates eval_now recording — the evaluation clock its composite policy inputs were computed on is unidentifiable; re-run it under turn-55+ code (wall clock is recorded explicitly as null)`);
    }
  }
  // Codex t76: the vector execution protocol is identity on EVERY comparison
  // surface — a daemon-required run and an in-process run measured different
  // executions (one whose timeouts are authoritative, one whose are not).
  // FAIL-CLOSED on a pre-t76 identity: an absent field means the protocol the
  // legs ran under is unidentifiable (t76+ code records it unconditionally).
  for (const [who, side] of [["baseline", baseline], ["candidate", candidate]] as const) {
    if (side.vector_exec === undefined) {
      mismatches.push(`${who} predates vector_exec recording — the vector execution protocol its legs ran under (daemon-required vs in-process) is unidentifiable; re-run it under t76+ code`);
    } else if (side.vector_exec.response_protocol === undefined) {
      // Codex t84 CR-5 / t89 P2: the RESPONSE protocol is identity under EVERY vector
      // protocol — a pre-t84 report measured the raw-hit/client-hydration execution
      // and can never compare with a hydrated-v1 run; absence fails closed.
      mismatches.push(`${who} records no vector_exec.response_protocol — a pre-t84 report measured the raw-hit execution (client-side hydration), a DIFFERENT contract from a hydrated-v1 run; re-run it under t84+ code`);
    }
  }
  // O1 §4 / §6 step 5: the handler timing contract is identity on EVERY comparison surface —
  // a report without it measured wall-clock deadline semantics (steppable deadlines and
  // wall-sampled over_ms); FAIL CLOSED on absence, and never compare across a mismatch.
  for (const [who, side] of [["baseline", baseline], ["candidate", candidate]] as const) {
    if (side.deadline_protocol === undefined) {
      mismatches.push(`${who} records no deadline_protocol — it measured the handler under wall-clock deadline semantics (pre-O1), a DIFFERENT timing contract from a "${DEADLINE_PROTOCOL_IDENTITY}" run; re-run it under O1 code`);
    }
  }
  if (baseline.deadline_protocol !== undefined && candidate.deadline_protocol !== undefined && baseline.deadline_protocol !== candidate.deadline_protocol) {
    mismatches.push(`deadline_protocol (${baseline.deadline_protocol} vs ${candidate.deadline_protocol}) — the runs measured the handler under different timing contracts; re-run both under the same build`);
  }
  if (baseline.vector_exec !== undefined && candidate.vector_exec !== undefined
    && (baseline.vector_exec.protocol !== candidate.vector_exec.protocol
      || baseline.vector_exec.prewarm !== candidate.vector_exec.prewarm
      || baseline.vector_exec.response_protocol !== candidate.vector_exec.response_protocol)) {
    mismatches.push(`vector_exec (${describeVectorExec(baseline.vector_exec)} vs ${describeVectorExec(candidate.vector_exec)}) — the runs executed their vector legs under different protocols (response_protocol included, t89 P2); the protocol is not a registrable treatment, re-run both under the same build + --vector-exec/--vector-prewarm`);
  }
  if (baseline.eval_now !== undefined && candidate.eval_now !== undefined && baseline.eval_now !== candidate.eval_now) {
    mismatches.push(`eval_now (${baseline.eval_now ?? "wall-clock"} vs ${candidate.eval_now ?? "wall-clock"}) — the runs computed composite policy inputs on different evaluation clocks; pin CLAWMEM_EVAL_NOW identically on both (run-ab.sh does), or unset it on both`);
  }
  if (mismatches.length > 0) {
    throw new HookEvalIntegrityError(
      `acceptance baseline ${baselineRunId} is not comparable to this run — identity mismatch on: ${mismatches.join("; ")}. ` +
      `Re-run the baseline on the same gold set, snapshot, topology, limit and budget.`
    );
  }
  if (baseline.attested) notes.push(`baseline identity was attested by tooling (${baseline.attested}), not run-time-recorded`);
  return { notes, informational };
}

/**
 * BUILD-3d: member-run comparability for a replicated aggregate — the same
 * identity contract as the acceptance gate with ONE declared difference:
 * each member is its own frozen draw ("draw:<fp>"), so expansion_set is
 * compared by the frozen-draw-member rule (both sides frozen, draws
 * pairwise distinct) instead of strict equality. Everything else — weight,
 * degeneracy gate, budget, topology, gold, corpus — stays strict: the n
 * members ARE one arm. Throws HookEvalIntegrityError on mismatch.
 */
export function assertReplicatedMemberIdentity(
  member: RunIdentity,
  reference: RunIdentity,
  referenceRunId: string,
): { notes: string[]; informational: string[] } {
  return assertComparableIdentity(member, reference, referenceRunId, { expansionSet: "frozen-draw-member" });
}

/**
 * The acceptance-comparison identity gate as a callable contract (BUILD-3d):
 * the exact strict-mode comparison every --baseline flow runs — including
 * the replicated-vs-replicated acceptance rule (equal n comparable, draw
 * lists noted) — exported for aggregate-level comparisons and their tests.
 * Throws HookEvalIntegrityError on mismatch.
 */
export function assertAcceptanceComparableIdentity(
  candidate: RunIdentity,
  baseline: RunIdentity,
  baselineRunId: string,
): { notes: string[]; informational: string[] } {
  return assertComparableIdentity(candidate, baseline, baselineRunId);
}

/**
 * Axes forced unmeasured by the GOLD SET itself: an axis whose label stratum
 * is empty on the held-out slice reports a trivially clean number (e.g.
 * mustNotCaseRate 0 with zero must_not labels) that is indistinguishable
 * from real coverage — the axis is downgraded to unmeasured so the policy
 * decides, never the trivial zero (codex turn-8 finding 5).
 */
export function holdoutForcedUnmeasured(scored: HookGoldExample[]): Map<string, string> {
  const holdout = scored.filter(e => e.split === "holdout");
  const m = new Map<string, string>();
  const some = (pred: (e: HookGoldExample) => boolean) => holdout.some(pred);
  if (!some(e => e.labels.must_include.length + e.labels.acceptable.length > 0)) {
    m.set("ndcgMean", "no relevance-labeled cases in the held-out slice");
  }
  if (!some(e => e.labels.must_include.length > 0)) {
    m.set("mustIncludeRecallMean", "no must_include-labeled cases in the held-out slice");
  }
  if (!some(e => e.expect_abstain)) {
    m.set("abstentionAccuracy", "no expect_abstain cases in the held-out slice");
  }
  if (!some(e => e.labels.must_not_include.length > 0)) {
    m.set("mustNotCaseRate", "no must_not-labeled cases in the held-out slice — a zero rate would be indistinguishable from no coverage");
  }
  if (!some(e => e.prior_leg === "required" || e.prior_leg === "forbidden")) {
    m.set("priorLegAccuracy", "no prior-leg-ruled (required/forbidden) cases in the held-out slice");
  }
  return m;
}

/**
 * Axes an operator MAY declare out of scope when unmeasured. The CORE
 * relevance and damage axes are NON-WAIVABLE (codex turn-9 finding 5): a
 * gold set whose held-out slice cannot measure nDCG, must-include recall,
 * must-not rate, or timeouts is not an acceptance set — fix the gold set,
 * never the declaration.
 */
export const WAIVABLE_ACCEPTANCE_AXES: ReadonlySet<string> = new Set([
  "abstentionAccuracy", "priorLegAccuracy", "latencyP50Ms", "latencyP95Ms",
]);

/**
 * Acceptance policy over computed axes: every axis must pass; an unmeasured
 * axis (pass: null) fails acceptance UNLESS explicitly declared out of scope
 * — and only WAIVABLE axes can be declared (a declaration naming a
 * non-waivable axis is ignored for pass purposes and the axis still fails).
 * Any honored waiver makes the acceptance CONDITIONAL, never an
 * unconditional product pass.
 */
export function resolveAcceptancePass(
  axes: AcceptanceAxis[],
  declared: ReadonlySet<string>
): { pass: boolean; undeclaredUnmeasured: string[]; waived: string[] } {
  const waived = axes
    .filter(a => a.pass === null && declared.has(a.metric) && WAIVABLE_ACCEPTANCE_AXES.has(a.metric))
    .map(a => a.metric);
  const waivedSet = new Set(waived);
  const undeclaredUnmeasured = axes.filter(a => a.pass === null && !waivedSet.has(a.metric)).map(a => a.metric);
  const pass = axes.every(a => a.pass !== false) && undeclaredUnmeasured.length === 0;
  return { pass, undeclaredUnmeasured, waived };
}

/** One acceptance-gate comparison axis. */
export interface AcceptanceAxis {
  metric: string;
  baseline: number | null;
  candidate: number | null;
  pass: boolean | null;
  note?: string;
}

export interface HookCaseResult {
  id: string;
  split: HookGoldExample["split"];
  tags: string[];
  profile: string;
  metrics: HookCaseMetrics;
  injectedPaths: string[];
  outcome: string | null;
  emptyReason: string | null;
  /**
   * BUILD-4 (codex turn-52 finding 3): the admission basis this case was
   * actually judged on — derived from the lanes that RAN, so the report
   * makes the per-case channel topology observable (a balanced case whose
   * vector leg timed out shows "bm25-rrf", not the profile's capability).
   * Null when the case never reached admission (gate/empty outcomes).
   */
  admission_basis?: string | null;
  invariants: InvariantAudit;
  warnings: string[];
  /**
   * BUILD-3c: this case's FINAL pair verdict (absent when the pair gate was
   * not armed). Cases with false are present as evidence but excluded from
   * every reported aggregate and from acceptance.
   */
  pair_valid?: boolean;
  /**
   * Per-case exposure LEDGER (codex turn-44 finding): the base and
   * treatment-aware exposure verdicts for THIS case, recorded so every
   * pair_audit summary (totals, stratum maps, witness receipts) is
   * derivable — and revalidated — from the exact per-case record instead of
   * being independently forgeable. Both are validity-gated at the runner
   * (an invalid pair is never exposed). Absent when the pair gate was not
   * armed.
   */
  pair_base_exposed?: boolean;
  pair_treatment_exposed?: boolean;
  /**
   * Invariant violations recorded by attempts the pair gate REPLACED (codex
   * turn-29 finding 1). `invariants` above describes the surviving attempt —
   * the one whose trace is persisted; these are the discarded ones, kept
   * because they count toward the trust gate and would otherwise leave no
   * trace at all. Absent when no attempt was superseded or none violated.
   */
  superseded_attempts?: {
    attempt: number;
    enforcedViolations: { id: string; violations: string[] }[];
    observedViolations: { id: string; violations: string[] }[];
  }[];
}

export interface HookRunReport {
  run_id: string;
  surface: "context-surfacing";
  created_at: string;
  gold_path: string;
  db_path: string | null;
  clawmem_version: string | null;
  limit: number;
  budget_ms: number;
  min_examples: number;
  audit_attested: boolean;
  secondary_vaults: "suppressed" | "snapshot";
  examples_total: number;
  examples_scored: number;
  /** Comparable run identity — the acceptance gate refuses baselines whose identity differs. Absent only on pre-identity reports. */
  identity?: RunIdentity;
  aggregate: HookAggregate;
  by_split: Record<string, HookAggregate>;
  enforced_invariant_violations: number;
  observed_invariant_violations: number;
  cases: HookCaseResult[];
  unresolved_labels: { example_id: string; refs: string[] }[];
  /**
   * CONTRACT-5 judged acceptance vs a baseline run on the HELD-OUT slice
   * (null when no baseline given). `mode`: "unconditional" = every axis
   * measured and passed; "conditional" = passed with operator-declared
   * waivers on WAIVABLE axes (never an unconditional product pass);
   * "failed" = an axis failed or a required axis was unmeasured undeclared.
   */
  acceptance: {
    baseline_run_id: string; slice: "holdout"; axes: AcceptanceAxis[]; pass: boolean;
    mode: "unconditional" | "conditional" | "failed"; waived: string[]; notes: string[];
  } | null;
  /**
   * BUILD-3c: outcome of the in-run pair gate (null when pairWith absent).
   * valid/invalid count FINAL per-case verdicts after all retry rounds;
   * retried counts re-run ATTEMPTS (a case retried twice contributes 2).
   * invalid_cases carries each still-invalid case's id + bounded divergence
   * evidence. Acceptance (when computed) covered VALID pairs only.
   */
  pair_audit: {
    partner_run_id: string;
    partner_dir: string;
    min_valid: number;
    max_retries: number;
    valid: number;
    invalid: number;
    retried: number;
    /** Pre-registered witness ids the gate enforced (codex turn-29 SPEC-5). */
    required_ids: string[];
    /** Pre-registered per-stratum minimums the gate enforced. */
    min_valid_by_stratum: Record<string, number>;
    /** Pre-registered per-stratum minimums counted over TREATMENT-EXPOSED pairs only. */
    min_exposed_by_stratum: Record<string, number>;
    /**
     * The REGISTERED treatments of this experiment (codex turn-40 finding 2)
     * — exactly these ranking_policy variables were allowed to differ from
     * the partner; [] = policy-identical arms (a replicate audit).
     */
    registered_treatments: PairTreatment[];
    /**
     * The actual CONTRAST per registered treatment — candidate and partner
     * values (codex turn-41 finding 4). Names alone cannot distinguish
     * weight 0-vs-1.5 from 0-vs-0.5; the aggregate requires this contrast
     * to be IDENTICAL across replicated members, so one artifact never
     * mixes materially different experiments. {} for a replicate audit.
     */
    treatment_contrast: Partial<Record<PairTreatment, { candidate: unknown; partner: unknown }>>;
    /** Valid pairs in which the treatment actually operated (treatment-AWARE since turn-40 finding 4: base = complete rerank coverage + >=2 reorderable candidates; a degeneracy_gate experiment additionally requires the assessment to have fired). */
    treatment_exposed: number;
    /**
     * Per-stratum OUTCOME evidence (codex turn-43 finding 2): valid and
     * treatment-exposed pair counts for EVERY profile and split present in
     * the scored set, so an aggregate can validate each declared stratum
     * minimum directly instead of reconstructing sufficiency from totals.
     */
    valid_by_stratum: Record<string, number>;
    treatment_exposed_by_stratum: Record<string, number>;
    /**
     * PRE-REGISTERED per-stratum admission-basis minima (codex t68 F3) and
     * the recorded per-stratum basis coverage of VALID pairs — keys
     * "<stratum>:<basis>", derived from the case rows' admission_basis so
     * the aggregate can reconcile them, and re-verified by the replicated
     * shipping gate as a conjunct of gates.pass.
     */
    min_basis_by_stratum: Record<string, number>;
    valid_basis_by_stratum: Record<string, number>;
    /**
     * Per-witness outcome evidence for every pre-registered required id
     * (codex turn-43 finding 2): the run-time gate refused unless each ended
     * VALID and BASE-exposed — the report now SAYS so, so an artifact
     * claiming enforcement carries the evidence.
     */
    witness_outcomes: { id: string; valid: boolean; base_exposed: boolean }[];
    invalid_cases: { id: string; divergences: string[] }[];
  } | null;
  /**
   * Machine-visible gate split (codex turn-7/9 finding 4/5): `trust_pass` =
   * the run's own trust/invariant gate; `acceptance_pass` = the judged
   * baseline comparison (null when no baseline was given — NOT a pass);
   * `acceptance_waived` = axes waived by explicit declaration; `pass` =
   * UNCONDITIONAL product acceptance — true only when trust holds,
   * acceptance passed, and NOTHING was waived. A trust-only or conditional
   * run can never read as unconditional product acceptance to a machine
   * consumer.
   */
  /**
   * BUILD-3a (codex turn-23 finding 5): finalization measured on EVERY rep
   * of every escalated case, judged against FINALIZATION_RESERVE_MS by MAX
   * (strictest; reps are small so p95≈max — both reported). fits is null
   * when no case escalated (speed/balanced-only runs) — null never fails
   * the gate; false always does.
   */
  finalization: { samples: number; max_ms: number | null; p95_ms: number | null; reserve_ms: number; fits: boolean | null };
  /** BUILD-3d.4 (codex turn-47 finding 2): per-substage finalization breakdown (max/mean ms) across escalated reps — the harness surfaces WHERE the reserve is spent, so the constant's validation is auditable not asserted. Null when no escalated reps carried a breakdown. */
  finalization_breakdown: Record<string, { max_ms: number; mean_ms: number }> | null;
  /**
   * Measured primary-vector-leg deadline adherence (codex t80 P1). Under the
   * daemon-required protocol the daemon bounds the SCAN, but the client then
   * hydrates synchronously — a cold hydrate blocks the race timer and records
   * a leg `ok` past its declared timeout. `adhered` is the MAX overshoot across
   * EVERY primary/prior/deep invocation vs its OWN deadline ≤ tolerance (codex
   * t81 P1+P2 — a per-invocation safety bound, not a typical-case statistic);
   * `worst` names the offending leg/case/rep and its own budget. null = no rep.
   */
  vector_deadline: { samples: number; max_over_ms: number | null; worst: { leg: "primary" | "prior" | "deep"; case: string; attempt: number; rep: number; budget_ms: number } | null; tolerance_ms: number; adhered: boolean | null };
  /**
   * O1 §3 (the evidence contract — the fix for what cost the arc a day): EVERY rep's per-leg
   * timing record, keyed `case` + `rep`, persisted in full — not only the rep-0 trace stream.
   * Refusals a1/a2 had their worst breach in reps 1 and 2, whose traces were discarded, so
   * attribution was unverifiable. Each record carries the monotonic `over_ms` / `budget_ms`, the
   * span on both clocks (`clock_skew_ms` exposes a realtime STEP), the orthogonal `terminal_kind`
   * × `status`, the harness-derived `timing` against the frozen tolerance, and the run's
   * `deadline_protocol` identity (null until O1 activation). Empty when no vector leg completed.
   */
  vector_leg_records: VectorLegPersistedRecord[];
  /**
   * BUILD-4 turn-54 (codex turn-53 ruling R6): per-basis case counts DERIVED
   * from the case rows' admission_basis — a single recomputable source, so
   * any consumer can revalidate the counts against the rows ("none" = cases
   * that never reached admission). Per-case admission_basis remains the
   * outcome-level record; the observed-basis set is deliberately NOT part of
   * run identity. The topology-complete shipping gate enforces its required
   * basis coverage against these counts. Null when no cases were scored.
   */
  admission_basis_counts: Record<string, number> | null;
  /** Codex turn-24 finding 4: total handler elapsed per rep vs the internal budget (+ timer-granularity tolerance). within null = no reps measured. Violations fail TRUST. */
  budget_elapsed: { samples: number; max_ms: number | null; budget_ms: number; tolerance_ms: number; within: boolean | null };
  /**
   * Codex t76: the vector execution protocol the run executed (mirrors
   * identity.vector_exec) plus the eval daemon child's facts when one served
   * the working copy, and whether the run's LATENCY evidence is authoritative
   * for the daemon-backed production contract (false ⇒ `note` says why; the
   * latency acceptance axes are unmeasured). Optional only for pre-t76
   * reports read as baselines.
   */
  vector_exec?: {
    protocol: VectorExecIdentity["protocol"];
    prewarm: VectorExecIdentity["prewarm"];
    /** WHICH response protocol the legs ran under (codex t84 CR-5): "hydrated-v1" daemon-side projection; "n/a" in-process. Mirrors identity.vector_exec.response_protocol. */
    response_protocol: "hydrated-v1" | "raw-hit" | "n/a";
    daemon: { pid: number; socket: string; ready_ms: number; prewarm_ran: boolean; ownership_pings: number; ownership_ping_timeout_ms: number } | null;
    latency_authoritative: boolean;
    note: string | null;
  };
  /** budget_elapsed_ok is null when no rep was measured OR when the latency protocol is non-authoritative (codex t77 F4: in-process vector legs on vector-exercising profiles — the raw timing stays in budget_elapsed as a diagnostic and trust fails as UNMEASURED). */
  gates: { trust_pass: boolean; acceptance_pass: boolean | null; acceptance_waived: string[]; finalization_reserve_ok: boolean | null; budget_elapsed_ok: boolean | null; vector_deadline_ok: boolean | null; pass: boolean; reasons: string[] };
}

export interface RunHookEvalResult {
  report: HookRunReport;
  artifacts: { runJsonPath: string; reportMdPath: string; tracesPath: string } | null;
  /** Captured expansion draw (expansionCapture arm) — reusable via expansionFreeze; binding validated on replay. */
  expansionDraw?: { fingerprint: string; rows: { hash: string; result: string }[]; binding: ExpansionDrawBinding };
}

/** Restore an env var to its pre-run value (delete when it was unset). */
function restoreEnv(name: string, prior: string | undefined): void {
  if (prior === undefined) delete process.env[name];
  else process.env[name] = prior;
}

/**
 * Per-case metric fields a baseline must carry to be re-aggregated over a
 * restricted id set (BUILD-3c). A baseline whose stored cases lack usable
 * metrics cannot be recomputed — silently aggregating garbage would be worse
 * than refusing.
 */
const CASE_METRIC_NULLABLE_FIELDS = ["ndcg", "mustNotRate", "mustIncludeRecall", "abstentionCorrect", "falseAbstain", "priorLegOk"] as const;
/**
 * Counts a baseline must carry as finite non-negative integers. `undefined`
 * is NOT accepted for any field (codex turn-29 finding 2): a missing
 * mustNotCount would recompute the damage rate as clean, and a missing
 * injectedCount would make an abstention look measured — both are silent
 * mis-scoring, which is exactly what refusing exists to prevent.
 */
const CASE_METRIC_COUNT_FIELDS = ["mustNotCount", "injectedCount"] as const;
/** Outcomes that are 0, 1, or null — any other finite value is corrupt, not merely odd (codex turn-30 finding 4). */
const CASE_METRIC_BINARY_FIELDS = ["abstentionCorrect", "falseAbstain", "priorLegOk"] as const;

/**
 * Re-aggregate a BASELINE report's split over an explicit case-id set — the
 * pair gate's requirement that both sides of an acceptance comparison cover
 * the SAME cases (BUILD-3c). Returns undefined when the restricted set is
 * empty for that split (acceptance then reports the slice as missing, which
 * fails closed). Throws when a required case is missing from the baseline or
 * carries a malformed metric block: an id the gate declared VALID must exist
 * on both sides by construction, so its absence is an integrity failure, not
 * a smaller sample.
 */
export function restrictBaselineSlice(
  baseline: HookRunReport,
  validIds: Set<string>,
  split: string,
): HookAggregate | undefined {
  // A case the gate declared VALID has a trace on BOTH sides by construction,
  // and a run writes its cases and its traces from the same set — so an id
  // the partner's report does not carry AT ALL means the run directory is
  // corrupt. (Split membership is not checked here: identity comparability
  // already pins the gold, and a valid id on the OTHER split is simply not
  // part of this slice.)
  // Duplicate ids would enter `wanted` twice and weight one baseline case
  // several times in the recomputed mean (codex turn-30 finding 4).
  const seenIds = new Set<string>();
  const duplicates = new Set<string>();
  for (const c of baseline.cases ?? []) {
    if (seenIds.has(c.id)) duplicates.add(c.id); else seenIds.add(c.id);
  }
  if (duplicates.size > 0) {
    throw new HookEvalIntegrityError(`baseline ${baseline.run_id} carries ${duplicates.size} duplicate case id(s): ${[...duplicates].slice(0, 5).join(", ")} — a duplicate would weight one case several times in the recomputed slice`);
  }
  const byId = new Map((baseline.cases ?? []).map(c => [c.id, c]));
  const missing = [...validIds].filter(id => !byId.has(id));
  if (missing.length > 0) {
    throw new HookEvalIntegrityError(
      `baseline ${baseline.run_id} does not carry ${missing.length} case(s) the pair gate declared VALID: ${missing.slice(0, 5).join(", ")} — its traces and its cases disagree; the partner run directory is corrupt`
    );
  }
  const wanted = (baseline.cases ?? []).filter(c => validIds.has(c.id) && c.split === split);
  for (const c of wanted) {
    const m = c.metrics as unknown as Record<string, unknown> | undefined;
    if (!m || typeof m !== "object") {
      throw new HookEvalIntegrityError(`baseline ${baseline.run_id} case ${c.id} has no metrics block — a pair-gated acceptance recomputes the baseline slice from its per-case metrics`);
    }
    // EVERY field, exact SEMANTICS — `undefined` is refused everywhere (codex
    // turn-29 finding 2: an absent field is not a null measurement), and a
    // finite number is not automatically a valid one (codex turn-30 finding
    // 4: `abstentionCorrect: 20`, `priorLegOk: -1` and `ndcg: 3` would each
    // corrupt a recomputed acceptance).
    for (const f of CASE_METRIC_NULLABLE_FIELDS) {
      if (!(f in m)) {
        throw new HookEvalIntegrityError(`baseline ${baseline.run_id} case ${c.id} is missing metric ${f} — an absent measurement is not a null one`);
      }
      const v = m[f];
      if (v === null) continue;
      if (typeof v !== "number" || !Number.isFinite(v)) {
        throw new HookEvalIntegrityError(`baseline ${baseline.run_id} case ${c.id} metric ${f} is not a finite number or null`);
      }
      if (CASE_METRIC_BINARY_FIELDS.includes(f as never)) {
        if (v !== 0 && v !== 1) {
          throw new HookEvalIntegrityError(`baseline ${baseline.run_id} case ${c.id} metric ${f} is ${v} — a binary outcome must be 0, 1, or null`);
        }
      } else if (v < 0 || v > 1) {
        throw new HookEvalIntegrityError(`baseline ${baseline.run_id} case ${c.id} metric ${f} is ${v} — a rate must fall in [0,1] or be null`);
      }
    }
    for (const f of CASE_METRIC_COUNT_FIELDS) {
      const v = m[f];
      if (typeof v !== "number" || !Number.isInteger(v) || v < 0) {
        throw new HookEvalIntegrityError(`baseline ${baseline.run_id} case ${c.id} metric ${f} is not a finite non-negative integer — a missing count would recompute the damage rate as clean`);
      }
    }
    if (typeof m.elapsedMs !== "number" || !Number.isFinite(m.elapsedMs) || m.elapsedMs < 0) {
      throw new HookEvalIntegrityError(`baseline ${baseline.run_id} case ${c.id} metric elapsedMs is not a finite non-negative number`);
    }
    if (typeof m.timedOut !== "boolean") {
      throw new HookEvalIntegrityError(`baseline ${baseline.run_id} case ${c.id} metric timedOut is not a boolean`);
    }
  }
  if (wanted.length === 0) return undefined;
  return aggregateHookMetrics(wanted.map(c => c.metrics));
}

/**
 * Vault-qualify the injected displayPaths using the fusion candidates' vault
 * provenance (live fusion identity is vault-qualified since the turn-7 fix):
 * a skill-vault document scores as `skill:<displayPath>` so labels can
 * address each vault unambiguously (SCOPE-ALL-LANES; codex turn-6 SPEC-4).
 * A displayPath carried by candidates in BOTH vaults is ambiguous OUTPUT
 * identity — finalPaths are bare displayPaths, so the run hard fails rather
 * than guessing which vault's document was injected.
 */
export function qualifyInjectedPaths(trace: SurfacingTrace, caseId: string): string[] {
  const vaults = new Map<string, Set<"general" | "skill">>();
  for (const c of trace.fusion?.candidates ?? []) {
    let set = vaults.get(c.displayPath);
    if (!set) { set = new Set(); vaults.set(c.displayPath, set); }
    set.add(c.vault);
  }
  return trace.finalPaths.map(p => {
    const v = vaults.get(p);
    if (!v) return p; // no fusion record (gated turn) — general by construction
    if (v.has("skill") && v.has("general")) {
      throw new HookEvalIntegrityError(
        `case ${caseId}: injected "${p}" exists as a candidate in both the general and skill vaults — cross-vault displayPath collision; rename the colliding collection before evaluating`
      );
    }
    return v.has("skill") ? `skill:${p}` : p;
  });
}

/** Comparison tolerance for regression axes of the acceptance gate. */
const ACCEPT_EPS = 0.02;
/** Latency axes tolerate a relative + absolute margin (replay latency is noisy — cold page cache, service warmup). */
const LATENCY_REL_EPS = 0.25;
const LATENCY_ABS_EPS_MS = 150;

/**
 * CONTRACT-5 judged acceptance axes: candidate vs baseline on the held-out
 * slice. Regression axes (nDCG, recall, abstention, prior-leg accuracy)
 * tolerate ACCEPT_EPS; damage axes (must-not, timeouts) may not increase at
 * all; latency axes (p50/p95, measured under the identity's latency
 * protocol) tolerate the latency margins. Null handling (codex turn-7/8
 * finding 4/5 — unknown must never read as pass):
 *  - `forceUnmeasured` axes (empty label stratum on the holdout, or a
 *    latency-protocol mismatch) are recorded pass:null with the reason and
 *    never compared — the trivially clean number they would report is
 *    indistinguishable from no coverage;
 *  - null on exactly ONE side FAILS closed — the runs measured different
 *    things, which is itself a comparability defect;
 *  - null on BOTH sides is likewise recorded pass:null (no labeled cases).
 * The final verdict is the CALLER's via resolveAcceptancePass: an
 * unmeasured axis fails acceptance unless explicitly declared out of scope.
 */
/**
 * The COMPLETE acceptance-axis set, in emission order — every comparison
 * computeAcceptance produces, no more and no less. Consumers that validate a
 * stored acceptance block (the replicated aggregator) require EXACTLY this
 * set, so a report omitting recall/damage/timeout/latency evidence can never
 * ship (codex turn-42 finding 1). Execution-verified below: computeAcceptance
 * asserts its own output against this list on every call, so the constant
 * cannot silently drift from the axes actually emitted.
 */
export const ACCEPTANCE_AXIS_METRICS = [
  "ndcgMean", "mustIncludeRecallMean", "abstentionAccuracy", "priorLegAccuracy",
  "mustNotCaseRate", "timeoutRate", "latencyP50Ms", "latencyP95Ms",
] as const;

export function computeAcceptance(
  baseline: HookAggregate,
  candidate: HookAggregate,
  forceUnmeasured: ReadonlyMap<string, string> = new Map()
): { axes: AcceptanceAxis[]; unmeasured: string[] } {
  const axes: AcceptanceAxis[] = [];
  const unmeasured: string[] = [];
  const cmp = (
    metric: string,
    b: number | null,
    c: number | null,
    ok: (b: number, c: number) => boolean
  ): void => {
    const forced = forceUnmeasured.get(metric);
    if (forced !== undefined) {
      unmeasured.push(metric);
      axes.push({ metric, baseline: b, candidate: c, pass: null, note: `UNMEASURED — ${forced}` });
      return;
    }
    if (b === null && c === null) {
      unmeasured.push(metric);
      axes.push({ metric, baseline: b, candidate: c, pass: null, note: "UNMEASURED — no labeled cases for this axis on either side; not a pass" });
      return;
    }
    if (b === null || c === null) {
      axes.push({ metric, baseline: b, candidate: c, pass: false, note: "measured on one side only — fails closed" });
      return;
    }
    axes.push({ metric, baseline: b, candidate: c, pass: ok(b, c) });
  };
  cmp("ndcgMean", baseline.ndcgMean, candidate.ndcgMean, (b, c) => c >= b - ACCEPT_EPS);
  cmp("mustIncludeRecallMean", baseline.mustIncludeRecallMean, candidate.mustIncludeRecallMean, (b, c) => c >= b - ACCEPT_EPS);
  cmp("abstentionAccuracy", baseline.abstentionAccuracy, candidate.abstentionAccuracy, (b, c) => c >= b - ACCEPT_EPS);
  cmp("priorLegAccuracy", baseline.priorLegAccuracy, candidate.priorLegAccuracy, (b, c) => c >= b - ACCEPT_EPS);
  cmp("mustNotCaseRate", baseline.mustNotCaseRate, candidate.mustNotCaseRate, (b, c) => c <= b);
  cmp("timeoutRate", baseline.timeoutRate, candidate.timeoutRate, (b, c) => c <= b && c === 0);
  const latencyOk = (b: number, c: number) => c <= b * (1 + LATENCY_REL_EPS) + LATENCY_ABS_EPS_MS;
  cmp("latencyP50Ms", baseline.latencyP50Ms, candidate.latencyP50Ms, latencyOk);
  cmp("latencyP95Ms", baseline.latencyP95Ms, candidate.latencyP95Ms, latencyOk);
  // Execution-verified canon: the exported list IS what this function emits.
  // Any drift (an added/removed/renamed cmp) throws on the very next call,
  // so the aggregator's exact-set requirement can never validate against a
  // stale list (codex turn-42 finding 1).
  if (axes.length !== ACCEPTANCE_AXIS_METRICS.length || axes.some((a, i) => a.metric !== ACCEPTANCE_AXIS_METRICS[i])) {
    throw new HookEvalIntegrityError(`computeAcceptance emitted [${axes.map(a => a.metric).join(", ")}] but ACCEPTANCE_AXIS_METRICS declares [${ACCEPTANCE_AXIS_METRICS.join(", ")}] — update the canon constant with the axis change`);
  }
  return { axes, unmeasured };
}

/**
 * BUILD-4 turn-56 (codex t55 CR-6): refuse an eval run whose configured
 * frozen clock is invalid BEFORE any scoring — the runtime resolver fails
 * open to wall time (a production hook must not throw on a stray env var),
 * which inside an experiment would make a typo indistinguishable from an
 * intentional wall-clock run and silently defeat the paired clock pin.
 * Unset/empty = wall clock (legitimate); present-but-invalid = refusal.
 */
export function assertEvalNowConfig(raw: string | undefined = process.env.CLAWMEM_EVAL_NOW): void {
  if (raw !== undefined && raw !== "" && parseEvalNowTimestamp(raw) === null) {
    throw new HookEvalIntegrityError(
      `CLAWMEM_EVAL_NOW is set but is not a canonical ISO-8601 UTC timestamp ("${raw}") — an invalid value would silently fall open to wall time and defeat the paired clock pin. Unset it for wall clock, or supply YYYY-MM-DDTHH:mm:ss[.sss]Z.`
    );
  }
}

/** Env the replay mutates for a run — captured before, restored after, as ONE transaction (codex t77 F1). */
const EVAL_ENV_KEYS = [
  "CLAWMEM_PROFILE", "CLAWMEM_HOOK_DEDUP_WINDOW_SEC", "CLAWMEM_SESSION_FOCUS",
  "CLAWMEM_SURFACE_SECONDARY_VAULTS", "CLAWMEM_VAULTS",
  "CLAWMEM_PRIOR_VECTOR_INPROC", "CLAWMEM_VECTOR_DAEMON_REQUIRED",
  // Codex migration r1 P4: the budget the run executed under is part of the
  // transaction — restored at run end whatever a case hook did to it.
  "CLAWMEM_HOOK_BUDGET_MS",
] as const;

/**
 * Codex migration r1 P4: ONE run executes, identifies and judges ONE accepted
 * budget. The handler keeps its single path to a budget (it reads the
 * environment through `assertHookBudgetConfig`), so the evaluator proves the
 * environment still resolves the budget captured at run start IMMEDIATELY
 * before every handler invocation — no await separates this check from the
 * handler's own read — and refuses the run on any drift, before that case is
 * scored.
 */
function assertRunBudgetUnchanged(runBudget: DurationMs, where: string): void {
  let current: DurationMs;
  try {
    current = assertHookBudgetConfig();
  } catch (e) {
    throw new HookEvalIntegrityError(`CLAWMEM_HOOK_BUDGET_MS became unsupported mid-run (${where}): ${(e as Error).message} — the run is REFUSED`);
  }
  if (evidenceMs(current) !== evidenceMs(runBudget)) {
    throw new HookEvalIntegrityError(
      `CLAWMEM_HOOK_BUDGET_MS changed mid-run (${where}): the run started under ${evidenceMs(runBudget)}ms and the environment now resolves ${evidenceMs(current)}ms — one run executes, identifies and judges ONE budget; the run is REFUSED`,
    );
  }
}

export async function runHookEval(opts: RunHookEvalOptions): Promise<RunHookEvalResult> {
  // Codex t77 F1: the evaluator's environment is a TRANSACTION. Every env
  // mutation the run performs — and every refusal path, preflight or
  // mid-run — is enclosed here, so a refusal thrown before the scoring
  // try/finally (undeclared protocol, pair preflight, label resolution,
  // unresolvable gold) can never leak a mutated env or a stale config cache
  // into the calling process. The inner restore (scoring finally) is kept
  // as belt-and-suspenders; this outer one is the guarantee.
  const priorEnv = new Map<string, string | undefined>(EVAL_ENV_KEYS.map(k => [k, process.env[k]]));
  try {
    return await runHookEvalTransaction(opts);
  } finally {
    for (const [k, v] of priorEnv) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    clearConfigCache();
  }
}

async function runHookEvalTransaction(opts: RunHookEvalOptions): Promise<RunHookEvalResult> {
  assertEvalNowConfig();
  // O1 §2: an unsupported hook budget refuses the RUN before any case is
  // scored — the handler would throw mid-rep otherwise, and a run under an
  // unsupported budget is not a measurable contract. Codex migration r1 P4:
  // the accepted value is CAPTURED — the identity, the budget summary and the
  // per-invocation drift check all use this one value.
  const runBudget = assertHookBudgetConfig();
  const limit = opts.limit ?? 10;
  const budgetMs = opts.budgetMs ?? 8000;
  const minExamples = opts.minExamples ?? 30;
  const latencyReps = Math.max(1, Math.floor(opts.latencyReps ?? 3));
  const createdAt = isoNow();
  const runId = `${createdAt.replace(/[:.]/g, "-")}-hook`;
  const store = opts.store;

  const examples = parseHookGoldFile(opts.goldPath);

  // ---- environment control (restored in finally) ----
  const priorEnv = {
    profile: process.env.CLAWMEM_PROFILE,
    dedup: process.env.CLAWMEM_HOOK_DEDUP_WINDOW_SEC,
    focus: process.env.CLAWMEM_SESSION_FOCUS,
    secondary: process.env.CLAWMEM_SURFACE_SECONDARY_VAULTS,
    vaults: process.env.CLAWMEM_VAULTS,
    priorVecInproc: process.env.CLAWMEM_PRIOR_VECTOR_INPROC,
    daemonRequired: process.env.CLAWMEM_VECTOR_DAEMON_REQUIRED,
  };
  // ---- vector execution protocol (codex t76) ----------------------------
  // Validated BEFORE any environment mutation (codex t77 F1: validate first,
  // then mutate inside the transaction).
  // Resolved BEFORE any env is armed and recorded in identity. An in-memory
  // store implies "in-process" (a child daemon cannot serve it); a file-backed
  // store must DECLARE its protocol — never in-process by omission.
  let vectorExec: VectorExecSpec;
  if (opts.vectorExec) {
    vectorExec = opts.vectorExec;
  } else if (store.dbPath === ":memory:") {
    vectorExec = { protocol: "in-process" };
  } else {
    throw new HookEvalIntegrityError(
      `vectorExec is required for a file-backed store (${store.dbPath}) — declare { protocol: "daemon-required", prewarm: "steady-state" | "cold" } (the production protocol) or { protocol: "in-process" } explicitly; only an in-memory store implies in-process (a child daemon cannot serve it)`
    );
  }
  if (vectorExec.protocol === "daemon-required" && store.dbPath === ":memory:") {
    throw new HookEvalIntegrityError(`vectorExec "daemon-required" needs a file-backed working copy — the store is in-memory (":memory:"), which no child process can serve`);
  }
  const vectorExecId = vectorExecIdentity(vectorExec);
  // The protocol's env arming (CLAWMEM_VECTOR_DAEMON_REQUIRED /
  // CLAWMEM_PRIOR_VECTOR_INPROC) happens INSIDE the scoring try below, whose
  // finally restores it: armed here, a preflight refusal between this point
  // and the try would leak the daemon-required routing into the caller's
  // process (every later hook invocation in a test process would then find
  // no daemon and return no vector results).
  process.env.CLAWMEM_HOOK_DEDUP_WINDOW_SEC = "0";
  delete process.env.CLAWMEM_SESSION_FOCUS;
  if (opts.skillVaultDb) {
    process.env.CLAWMEM_SURFACE_SECONDARY_VAULTS = "true";
    process.env.CLAWMEM_VAULTS = JSON.stringify({ skill: opts.skillVaultDb });
  } else {
    process.env.CLAWMEM_SURFACE_SECONDARY_VAULTS = "false";
  }
  clearConfigCache();

  // Skill store for vault-qualified label resolution (`skill:` prefix) —
  // opened on the snapshot the CLAWMEM_VAULTS override points at.
  let skillStore: Store | undefined;
  if (opts.skillVaultDb) {
    try { skillStore = resolveStore("skill"); } catch { skillStore = undefined; }
  }

  const resolved = resolveHookLabels(store, examples, skillStore);

  // ---- expansion-draw freeze / capture (codex turn-17 finding 2) ----
  // The expansion LLM samples at generation temperature, so every fresh
  // working copy draws different variants — two independently-sampled arms
  // cannot isolate a ranking-policy treatment. A PAIRED counterfactual
  // freezes one draw: the generator arm runs normally and CAPTURES the
  // llm_cache rows it wrote; the replay arm INJECTS those exact rows so
  // expandQuery cache-hits the same draw and both arms rank identical
  // inputs. The weight cannot influence the draw (expansion precedes
  // ordering), so which arm generates is immaterial.
  if (opts.expansionFreeze && opts.expansionCapture) {
    throw new HookEvalIntegrityError("expansionFreeze and expansionCapture are mutually exclusive — an arm either replays a draw or generates one");
  }

  // ---- BUILD-3c: in-run pair gate preflight ----------------------------
  // Every operator error the partner files can reveal is raised BEFORE the
  // first case runs — a mistyped partner directory must not cost a full
  // replay. The identity COMPARISON itself waits until after the run (this
  // run's identity includes the resolved expansion set), and fails closed.
  // Validated, not just floored (codex turn-29 finding 3): Math.floor(Infinity)
  // is Infinity, and the CLI's own range check does not protect this exported
  // runner boundary — a direct caller could loop forever on a permanently
  // divergent case.
  const pairMaxRetriesRaw = opts.pairMaxRetries ?? 2;
  if (!Number.isInteger(pairMaxRetriesRaw) || pairMaxRetriesRaw < 0) {
    throw new HookEvalIntegrityError(`pairMaxRetries must be a finite non-negative integer, got ${String(pairMaxRetriesRaw)} — an unbounded retry budget never terminates on a permanently divergent case`);
  }
  const pairMaxRetries = pairMaxRetriesRaw;
  let partnerTraces: Map<string, Record<string, unknown>> | null = null;
  let partnerRunId = "";
  if (opts.pairWith !== undefined) {
    if (opts.expansionCapture) {
      throw new HookEvalIntegrityError("pairWith and expansionCapture are mutually exclusive — a generator arm has no partner to pair against yet; capture the draw first, then pair the replay arm against the generator's run directory");
    }
    if (opts.pairMinValid === undefined || !Number.isInteger(opts.pairMinValid) || opts.pairMinValid < 1) {
      throw new HookEvalIntegrityError("pairWith requires a pre-registered pairMinValid (positive integer) — a valid-pair count chosen after seeing the audit is not a gate");
    }
    const header = readRunHeader(opts.pairWith);
    if (!header.run_id || !header.identity) {
      throw new HookEvalIntegrityError(`pairWith ${opts.pairWith} has no readable hook-run.json with a run_id and identity — the partner must be a completed, identified run`);
    }
    partnerRunId = header.run_id;
    try {
      partnerTraces = readRunTraces(opts.pairWith);
    } catch (e) {
      throw new HookEvalIntegrityError(`pairWith ${opts.pairWith} has no readable traces.jsonl: ${(e as Error).message} — the partner's per-case traces are the pair evidence`);
    }
    if (partnerTraces.size === 0) {
      throw new HookEvalIntegrityError(`pairWith ${opts.pairWith} carries zero traces — nothing to pair against`);
    }
    if (opts.pairRequireIds !== undefined) {
      if (!Array.isArray(opts.pairRequireIds) || opts.pairRequireIds.some(id => typeof id !== "string" || id.length === 0)) {
        throw new HookEvalIntegrityError("pairRequireIds must be an array of non-empty case ids");
      }
      const goldIds = new Set(examples.map(e => e.id));
      const unknown = opts.pairRequireIds.filter(id => !goldIds.has(id));
      if (unknown.length > 0) {
        throw new HookEvalIntegrityError(
          `pairRequireIds names ${unknown.length} case(s) absent from the gold set: ${unknown.join(", ")} — a witness that cannot be scored is not a witness (typo, or the wrong gold file)`
        );
      }
    }
    for (const [optName, strata] of [["pairMinValidByStratum", opts.pairMinValidByStratum], ["pairMinExposedByStratum", opts.pairMinExposedByStratum]] as const) {
      if (strata === undefined) continue;
      if (!strata || typeof strata !== "object" || Array.isArray(strata)) {
        throw new HookEvalIntegrityError(`${optName} must be an object of {stratum: minimum}`);
      }
      const knownProfiles = new Set(examples.map(e => opts.profileOverride ?? e.profile));
      const knownSplits = new Set(examples.map(e => e.split));
      for (const [k, v] of Object.entries(strata)) {
        if (!Number.isInteger(v) || v < 1) {
          throw new HookEvalIntegrityError(`${optName}.${k} must be a positive integer, got ${String(v)}`);
        }
        if (!knownProfiles.has(k as never) && !knownSplits.has(k as never)) {
          throw new HookEvalIntegrityError(
            `${optName} names "${k}", which is neither a profile (${[...knownProfiles].sort().join("/")}) nor a split (${[...knownSplits].sort().join("/")}) present in this gold set — a stratum that matches nothing would gate nothing`
          );
        }
      }
    }
    if (opts.pairMinBasisByStratum !== undefined) {
      const strata = opts.pairMinBasisByStratum;
      if (!strata || typeof strata !== "object" || Array.isArray(strata)) {
        throw new HookEvalIntegrityError("pairMinBasisByStratum must be an object of {\"stratum:basis\": minimum}");
      }
      const knownProfiles = new Set(examples.map(e => opts.profileOverride ?? e.profile));
      const knownSplits = new Set(examples.map(e => e.split));
      for (const [k, v] of Object.entries(strata)) {
        if (!Number.isInteger(v) || v < 1) {
          throw new HookEvalIntegrityError(`pairMinBasisByStratum.${k} must be a positive integer, got ${String(v)}`);
        }
        const colon = k.indexOf(":");
        const stratum = colon > 0 ? k.slice(0, colon) : "";
        const basis = colon > 0 ? k.slice(colon + 1) : "";
        if (!stratum || !(ADMISSION_BASES as readonly string[]).includes(basis)) {
          throw new HookEvalIntegrityError(`pairMinBasisByStratum key "${k}" must be <stratum>:<basis> with basis one of ${ADMISSION_BASES.join(", ")}`);
        }
        if (!knownProfiles.has(stratum as never) && !knownSplits.has(stratum as never)) {
          throw new HookEvalIntegrityError(
            `pairMinBasisByStratum names stratum "${stratum}", which is neither a profile (${[...knownProfiles].sort().join("/")}) nor a split (${[...knownSplits].sort().join("/")}) present in this gold set — a stratum that matches nothing would gate nothing`
          );
        }
      }
    }
    // Registered treatments (codex turn-40 finding 2): validated up front —
    // an unknown name or a duplicate is a refused registration, never a
    // silently-ignored one.
    for (const t of opts.pairTreatments ?? []) {
      if (!(PAIR_TREATMENTS as readonly string[]).includes(t)) {
        throw new HookEvalIntegrityError(`pairTreatments names "${t}" — registrable treatments are: ${PAIR_TREATMENTS.join(", ")}`);
      }
    }
    if (new Set(opts.pairTreatments ?? []).size !== (opts.pairTreatments ?? []).length) {
      throw new HookEvalIntegrityError("pairTreatments contains duplicates — register each treatment once");
    }
    // Registered treatments must DIFFER, checked in PREFLIGHT (codex turn-42
    // finding 2): the full identity gate runs after scoring, so a registered
    // no-op configuration would otherwise consume an entire (GPU) run before
    // refusing. The candidate's effective values are module constants,
    // available before any case is scored; the later full compareIdentities
    // gate is retained unchanged.
    if ((opts.pairTreatments ?? []).length > 0) {
      const preflightPartnerRp = (readRunHeader(opts.pairWith!).identity as { ranking_policy?: Record<string, unknown> } | null)?.ranking_policy;
      if (!preflightPartnerRp) {
        throw new HookEvalIntegrityError(`pair gate (preflight): partner run at ${opts.pairWith} carries no ranking_policy identity — the registered treatment cannot be verified before scoring`);
      }
      const candidateValues: Record<PairTreatment, unknown> = {
        rerank_lane_weight: RERANK_LANE_WEIGHT,
        degeneracy_gate: RERANK_DEGENERACY_GATE_ACTIVE ? "on" : "off",
        admission_policy: ADMISSION_POLICY_ACTIVE,
      };
      for (const t of opts.pairTreatments ?? []) {
        if (candidateValues[t] === preflightPartnerRp[t]) {
          throw new HookEvalIntegrityError(`pair gate (preflight): registered treatment ${t} does NOT differ from the partner (both ${JSON.stringify(candidateValues[t])}) — a no-op experiment is refused BEFORE any case is scored`);
        }
      }
    }
    // Codex t76: the vector execution protocol is identity, not a treatment —
    // refused in PREFLIGHT (a protocol mismatch would otherwise consume the
    // whole run before the post-scoring identity gate refuses it).
    {
      const partnerVe = (readRunHeader(opts.pairWith!).identity as { vector_exec?: VectorExecIdentity } | null)?.vector_exec;
      if (!partnerVe) {
        throw new HookEvalIntegrityError(`pair gate (preflight): partner run at ${opts.pairWith} carries no vector_exec identity — the vector execution protocol its legs ran under is unidentifiable; re-run the partner under t76+ code`);
      }
      if (partnerVe.protocol !== vectorExecId.protocol || partnerVe.prewarm !== vectorExecId.prewarm || partnerVe.response_protocol !== vectorExecId.response_protocol) {
        throw new HookEvalIntegrityError(`pair gate (preflight): vector execution protocol differs from the partner (partner ${describeVectorExec(partnerVe)} vs this run ${describeVectorExec(vectorExecId)}) — the protocol (response_protocol included, codex t84 CR-5: a pre-t84 partner records none and fails closed here) is identity, not a registrable treatment; run both arms under the same build + --vector-exec/--vector-prewarm`);
      }
    }
    // O1 §4: the handler timing contract is identity too — refused in PREFLIGHT on absence or mismatch.
    {
      const partnerDp = (readRunHeader(opts.pairWith!).identity as { deadline_protocol?: string } | null)?.deadline_protocol;
      if (partnerDp === undefined) {
        throw new HookEvalIntegrityError(`pair gate (preflight): partner run at ${opts.pairWith} carries no deadline_protocol identity — it measured the handler under wall-clock deadline semantics (pre-O1); re-run the partner under O1 code`);
      }
      if (partnerDp !== DEADLINE_PROTOCOL_IDENTITY) {
        throw new HookEvalIntegrityError(`pair gate (preflight): deadline_protocol differs from the partner (partner ${partnerDp} vs this run ${DEADLINE_PROTOCOL_IDENTITY}) — the handler timing contract is identity, not a registrable treatment; run both arms under the same build`);
      }
    }
    if (opts.baselinePath) {
      // Acceptance under the pair gate recomputes BOTH sides over the valid
      // ids, which is only meaningful when the baseline IS the partner: a
      // third run's cases were never paired with anything here.
      const baselineRunId = parseBaselineReport(opts.baselinePath).run_id;
      if (baselineRunId !== partnerRunId) {
        throw new HookEvalIntegrityError(
          `pairWith partner is run ${partnerRunId} but --baseline is run ${baselineRunId} — under the pair gate acceptance is computed over VALID PAIRS on both sides, which requires the baseline to be the partner's own report`
        );
      }
    }
  } else if (
    opts.pairMinValid !== undefined || opts.pairMaxRetries !== undefined ||
    opts.pairRequireIds !== undefined || opts.pairMinValidByStratum !== undefined ||
    opts.pairMinExposedByStratum !== undefined || opts.pairMinBasisByStratum !== undefined || opts.pairTreatments !== undefined
  ) {
    // Every pair-gate option, not just the first two (codex turn-30 finding
    // 5): the CLI refused this composition while the exported runner silently
    // ignored the pre-registration.
    throw new HookEvalIntegrityError("pairMinValid / pairMaxRetries / pairRequireIds / pairMinValidByStratum / pairMinExposedByStratum / pairMinBasisByStratum / pairTreatments are meaningless without pairWith — there is no partner run to audit against");
  }

  const unresolvedLabels: HookRunReport["unresolved_labels"] = [];
  const toScore: typeof resolved = [];
  for (const r of resolved) {
    if (r.unresolved.length > 0) {
      unresolvedLabels.push({ example_id: r.example.id, refs: r.unresolved });
      continue;
    }
    toScore.push(r);
  }
  // The profiles this run exercises — known BEFORE the daemon is spawned, so
  // the steady-state prewarm requirement (codex t77 F3) and the latency
  // authority rule can be decided before the first case. Same derivation as
  // identity.profiles (which is computed from the scored cases afterwards).
  const runProfiles = opts.profileOverride ? opts.profileOverride : [...new Set(toScore.map(t => t.example.profile))].sort().join("+");

  // The binding a draw is captured under, and the values a replayed draw is
  // validated against (codex turn-18 finding 2): cached scores are OUTPUTS —
  // they are evidence of identical reranker/expansion INPUTS only when the
  // gold cases, the corpus content, and the models are the same. The corpus
  // content-hash binding is what makes a cached rerank score trustworthy:
  // the transmitted document text is a deterministic function of corpus +
  // code, so a same-path content change (the stale-score hazard) changes the
  // corpus hash and the draw is refused.
  // BUILD-3b (binding v3): served_rerank is knowable BEFORE the run (the CLI
  // probes it into identity.topology) and is checked pre-injection;
  // transmitted_text_manifest is only knowable AFTER the run, so it is filled
  // by the caller at capture time and checked post-run on replay.
  const drawBinding = (manifest: string): ExpansionDrawBinding => ({
    gold_fingerprint: goldFingerprint(toScore.map(t => t.example)),
    corpus: opts.corpusHash ?? null,
    query_model: process.env.CLAWMEM_LLM_MODEL?.trim() || DEFAULT_QUERY_MODEL,
    rerank_model: DEFAULT_RERANK_MODEL,
    rerank_request_rev: RERANK_REQUEST_REV,
    served_rerank: opts.servedModels?.rerank ?? "unreachable",
    transmitted_text_manifest: manifest,
  });
  let llmCachePre: Map<string, string> | null = null;
  if (opts.expansionFreeze || opts.expansionCapture) {
    llmCachePre = new Map(
      (store.db.prepare(`SELECT hash, result FROM llm_cache`).all() as { hash: string; result: string }[])
        .map(r => [r.hash, r.result])
    );
    if (opts.expansionFreeze) {
      const fp = expansionDrawFingerprint(opts.expansionFreeze.rows);
      if (fp !== opts.expansionFreeze.fingerprint) {
        throw new HookEvalIntegrityError(
          `expansion draw fingerprint mismatch: the draw file claims ${opts.expansionFreeze.fingerprint} but its rows hash to ${fp} — corrupt or hand-edited draw`
        );
      }
      // Pre-run members only. served_rerank joins them at v3 (BUILD-3b):
      // cached rerank scores are the PROVIDER's outputs, so a draw captured
      // against one served reranker is not evidence under another — and the
      // candidate's probe is already known here, before injection.
      const want = drawBinding("");
      const got = opts.expansionFreeze.binding;
      for (const k of ["gold_fingerprint", "corpus", "query_model", "rerank_model", "rerank_request_rev", "served_rerank"] as const) {
        if (got[k] !== want[k]) {
          throw new HookEvalIntegrityError(
            `expansion draw binding mismatch on ${k}: the draw was captured under "${got[k]}" but this run has "${want[k]}" — cached scores are outputs, not evidence of identical inputs; re-capture the draw on THIS gold set / corpus / model / served-provider configuration`
          );
        }
      }
      // Fresh created_at keeps injected rows clear of setCachedResult's
      // newest-1000 opportunistic prune.
      const stamp = isoNow();
      const ins = store.db.prepare(`INSERT OR REPLACE INTO llm_cache (hash, result, created_at) VALUES (?, ?, ?)`);
      for (const r of opts.expansionFreeze.rows) ins.run(r.hash, r.result, stamp);
    }
  }

  // ---- co-activation isolation: back up once, restore after every case ----
  let coactBackedUp = false;
  try {
    store.db.exec(`DROP TABLE IF EXISTS temp._hook_eval_coact_backup`);
    store.db.exec(`CREATE TEMP TABLE _hook_eval_coact_backup AS SELECT * FROM co_activations`);
    coactBackedUp = true;
  } catch { /* co_activations may not exist on a minimal fixture store */ }
  const restoreCoact = (): void => {
    if (!coactBackedUp) return;
    // Transactional: a crash between DELETE and INSERT must not leave the
    // working copy with an empty co_activations table mid-run (codex turn-6
    // STANDARDS-2 / CR-2). The working copy itself is disposable — the CLI
    // layer never opens the operator's snapshot directly.
    try {
      store.db.exec(`BEGIN IMMEDIATE`);
      try {
        store.db.exec(`DELETE FROM co_activations`);
        store.db.exec(`INSERT INTO co_activations SELECT * FROM _hook_eval_coact_backup`);
        store.db.exec(`COMMIT`);
      } catch (e) {
        try { store.db.exec(`ROLLBACK`); } catch { /* not in txn */ }
        throw e;
      }
    } catch { /* fail-open: worst case is a stale co-activation pair in a scratch copy */ }
  };

  const cases: HookCaseResult[] = [];
  // BUILD-3a (codex turn-23 finding 5): finalization samples from EVERY rep
  // of every escalated case — the machine-decisive reserve criterion. Under
  // the pair gate a REJECTED attempt's samples are kept too: the reserve and
  // budget gates measure the HOST, and a rejected attempt ran on it.
  const allFinalizations: number[] = [];
  // Codex t80 P1: per-rep PRIMARY vector-leg wall time (trace.timings.vectorMs)
  // with the profile's declared vectorTimeout, for vector-exercising reps —
  // the measured evidence that the daemon-required deadline actually held.
  const allVectorLegs: VectorLegRunRecord[] = [];
  // BUILD-3d.4 (codex turn-47 finding 2): per-substage finalization breakdown
  // across every escalated rep, so the report shows WHERE the reserve is spent
  // (filters/enrich/scoring/ordering/buildContext/inject/facts/tail) instead of
  // asserting a bare aggregate against the constant.
  const allFinalizationSubstages: Record<string, number>[] = [];
  // Codex turn-24 finding 4: total handler elapsed per rep, every profile —
  // gated against the internal budget.
  const allTotals: number[] = [];
  // BUILD-3b: transmitted-text hashes across every case (and every attempt) —
  // the draw binding's manifest is built from these.
  const allSentTextHashes: string[] = [];
  const traces: { id: string; trace: SurfacingTrace }[] = [];
  // BUILD-3c pair-gate state (null verdicts = the gate was not armed).
  let pairVerdicts: PairCaseVerdict[] | null = null;
  let pairRetried = 0;
  // Codex turn-29 finding 1: invariant audits from EVERY attempt, keyed by
  // case id in attempt order. A retry REPLACES the case result and its trace,
  // so counting only the survivor let a violating first attempt be retried
  // out of existence — out of the trust gate AND out of the artifacts.
  const attemptAudits = new Map<string, InvariantAudit[]>();

  // Codex t76 constraints 1-3: the daemon CHILD on the exact working copy,
  // spawned before the first case with bounded VERIFIED readiness; any
  // startup/bind/verification failure refuses the run here. Stopped in the
  // outer finally (constraint 6) on success and refusal alike.
  let evalDaemon: EvalVectorDaemon | null = null;
  let ownershipPings = 0;
  let ownershipPingTimeoutMs = 0;
  if (vectorExec.protocol === "daemon-required") {
    const override = vectorExec._testOwnershipPingTimeoutMs;
    if (override !== undefined && (typeof override !== "number" || !Number.isFinite(override) || !Number.isInteger(override) || override <= 0)) {
      throw new HookEvalIntegrityError(`_testOwnershipPingTimeoutMs must be a positive finite integer, got ${String(override)} — a collapsed or unbounded ownership timeout would corrupt which reps are accepted`);
    }
    ownershipPingTimeoutMs = override ?? OWNERSHIP_PING_TIMEOUT_MS;
  }
  const assertDaemonAlive = (when: string): void => {
    if (!evalDaemon) return;
    if (!evalDaemon.alive()) {
      throw new HookEvalIntegrityError(
        `vector daemon child pid ${evalDaemon.pid} died ${when} (exit code ${evalDaemon.exitCode()}) — the daemon-required protocol cannot continue; the run is REFUSED (never silently measured in-process)`
      );
    }
  };
  // Codex t77 F2: ownership is verified THROUGHOUT the measured run, not only
  // at startup — before and after every rep the daemon must answer a ping
  // with the exact working DB and the child's own pid. A daemon killed
  // during a request (whose leg reads as "error" while the exit promise has
  // not settled), a listener that vanished while the pid lives, or a socket
  // taken over by another daemon all fail here and REFUSE the run; "error"
  // outcomes remain ordinary bounded fallbacks only when this check passes.
  const assertDaemonOwned = async (when: string): Promise<void> => {
    if (!evalDaemon) return;
    assertDaemonAlive(when);
    const pong = await daemonPing(evalDaemon.dbPath, ownershipPingTimeoutMs);
    ownershipPings++;
    if (pong.status !== "ok") {
      throw new HookEvalIntegrityError(
        `vector daemon ownership check failed ${when}: ${pong.status === "absent" ? "no listener on" : "no answer within " + ownershipPingTimeoutMs + "ms from"} ${evalDaemon.sockPath} (child pid ${evalDaemon.pid} ${evalDaemon.alive() ? "alive" : `exited ${evalDaemon.exitCode()}`}) — the daemon-required protocol was not in force for the measured rep; the run is REFUSED`
      );
    }
    if (pong.db !== evalDaemon.dbPath || pong.pid !== evalDaemon.pid) {
      throw new HookEvalIntegrityError(
        `vector daemon ownership check failed ${when}: socket ${evalDaemon.sockPath} answered as pid ${pong.pid} serving ${pong.db}, not child pid ${evalDaemon.pid} serving ${evalDaemon.dbPath} — a foreign daemon took the socket; the run is REFUSED`
      );
    }
    // Codex t84: capability attestation — the identity records response_protocol "hydrated-v1",
    // so the child must ATTEST it can serve that protocol; a daemon that cannot would answer the
    // hydrated legs with raw hits — `skew` per leg since O1 (caught per-rep too, but refuse at the ping).
    if (!pong.protocols.includes("hydrated-v1")) {
      throw new HookEvalIntegrityError(
        `vector daemon ownership check failed ${when}: child pid ${pong.pid} does not attest the hydrated-v1 response protocol (advertised: ${pong.protocols.join(", ") || "none"}) — the daemon-required run's identity is response_protocol "hydrated-v1"; the run is REFUSED`
      );
    }
    // O1 §4: the run's identity is deadline_protocol "monotonic-relative-v1" — every daemon leg
    // must run under the relative-budget wire (deadline-rel-v1). A daemon that cannot attest it
    // would run its scans under NO deadline (caught per-leg as `skew` too, but refuse at the ping).
    if (!pong.protocols.includes(DEADLINE_PROTOCOL)) {
      throw new HookEvalIntegrityError(
        `vector daemon ownership check failed ${when}: child pid ${pong.pid} does not attest the ${DEADLINE_PROTOCOL} deadline protocol (advertised: ${pong.protocols.join(", ") || "none"}) — the run's identity is deadline_protocol "${DEADLINE_PROTOCOL_IDENTITY}"; the run is REFUSED`
      );
    }
  };
  try {
    if (vectorExec.protocol === "daemon-required") {
      // Every vector leg is daemon-REQUIRED for the run: the prior leg's
      // in-process override stays OFF and the primary/deep legs route through
      // searchVecDaemonRequired (context-surfacing) — an absent daemon returns
      // [] and is detected below as daemon loss, never scanned in-process.
      delete process.env.CLAWMEM_PRIOR_VECTOR_INPROC;
      process.env.CLAWMEM_VECTOR_DAEMON_REQUIRED = "1";
    } else {
      // In-process protocol: the replay MEASURES the prior-vector leg on a
      // daemon-less store via the override (live hooks without it stay
      // daemon-only — codex turn-6 STANDARDS-1); the primary/deep legs take
      // the production fallback (in-process scan). Recorded as "in-process".
      delete process.env.CLAWMEM_VECTOR_DAEMON_REQUIRED;
      process.env.CLAWMEM_PRIOR_VECTOR_INPROC = "1";
    }
    if (vectorExec.protocol === "daemon-required") {
      try {
        evalDaemon = await spawnEvalVectorDaemon(store.dbPath, {
          prewarm: vectorExec.prewarm,
          readyTimeoutMs: vectorExec.readyTimeoutMs,
          stopTimeoutMs: vectorExec.stopTimeoutMs,
          log: (msg) => console.error(msg),
        });
      } catch (e) {
        if (e instanceof EvalVectorDaemonError) throw new HookEvalIntegrityError(`daemon-required protocol could not start: ${e.message}`);
        throw e;
      }
      // Codex t77 F3: "steady-state" is a claim that the vector payload was
      // warmed before readiness. When the run's profiles exercise vectors,
      // a prewarm that did NOT run (no dimensioned vector table on the
      // working copy) means there is no vector payload to measure — the run
      // would validate only the FTS fallback while its identity claimed the
      // measured daemon-backed vector topology. Refused; vacuous (speed-only)
      // runs are allowed and the report records prewarm_ran honestly.
      // Codex t78 F4: the judgment is on the PAYLOAD (stored vector rows), not
      // on the table's existence — a dimensioned table with zero rows warms
      // nothing and would let a vector-exercising run validate only the FTS
      // fallback under a daemon-backed identity. Missing table and empty
      // table refuse alike.
      if (evalDaemon.prewarm === "steady-state" && exercisedServices(runProfiles).includes("embed") && (!evalDaemon.prewarmRan || evalDaemon.vectorRows === 0)) {
        throw new HookEvalIntegrityError(
          `steady-state prewarm declared but the working copy has no vector payload to warm (${evalDaemon.prewarmRan ? `dimensioned vector table with ${evalDaemon.vectorRows} rows` : "no dimensioned vector table"}) while the run's profiles (${runProfiles}) exercise vectors — the daemon-backed vector topology cannot be measured on this snapshot; embed the snapshot, or run --vector-prewarm cold only if a cold-start protocol is intended`
        );
      }
    }
    // One case, scored end to end. Factored out for BUILD-3c: an invalid
    // pair-case is RE-RUN through this exact path (reject + replace), so a
    // retried case is measured by the same protocol as a first attempt —
    // never a cheaper one.
    const scoreCase = async (index: number, attempt: number): Promise<{ result: HookCaseResult; trace: SurfacingTrace }> => {
      if (opts._testOnCaseStart) opts._testOnCaseStart({ index, attempt, daemonPid: evalDaemon?.pid ?? null });
      const { example, warnings } = toScore[index]!;
      const profile = opts.profileOverride ?? example.profile;
      process.env.CLAWMEM_PROFILE = profile;

      // Latency protocol (codex turn-8 finding 3): replay the case
      // `latencyReps` times, each rep under its OWN session id with its own
      // seeded priors and full cleanup — reps are as isolated from each
      // other as cases are. The case latency is the LOWER MEDIAN of the rep
      // latencies (single-run replay latency is machine-state noise);
      // metrics and the trace come from rep 0. Reps share `llm_cache` by
      // design (same as cases), so the protocol measures warm-expansion
      // latency — stable and comparable across A/B runs on one snapshot.
      const repElapsed: number[] = [];
      const trace = newSurfacingTrace();
      for (let rep = 0; rep < latencyReps; rep++) {
        // The attempt index keeps retry sessions distinct from the original's
        // (a re-used session id would collide with rows a crashed cleanup
        // left behind).
        const sessionId = `eval-hook-${runId}-${index}-a${attempt}-r${rep}`;
        // Seed priors OLDEST-FIRST so the newest prior gets the highest row
        // id (the lookback query orders by id DESC).
        const nowMs = epochMs(epochNow());
        for (let p = example.priors.length - 1; p >= 0; p--) {
          const prior = example.priors[p]!;
          store.insertUsage({
            sessionId,
            timestamp: new Date(nowMs - prior.age_minutes * 60_000).toISOString(),
            hookName: "context-surfacing",
            injectedPaths: [],
            estimatedTokens: 0,
            wasReferenced: 0,
            turnIndex: example.priors.length - 1 - p,
            queryText: prior.text,
          });
        }

        const repTrace = rep === 0 ? trace : newSurfacingTrace();
        // Constraint 4: daemon liveness is asserted around EVERY rep, and a
        // leg that found the daemon ABSENT (stale/missing socket → [] under
        // the required protocol) refuses the run — a rep measured without
        // the daemon is not the daemon-required protocol.
        await assertDaemonOwned(`before case ${example.id} rep ${rep}`);
        assertRunBudgetUnchanged(runBudget, `case ${example.id} rep ${rep}`); // P4: synchronous up to the handler's own budget read
        const t0 = monoNow();
        try {
          await contextSurfacing(store, { prompt: example.prompt, sessionId }, { trace: repTrace });
          repElapsed.push(evidenceMs(elapsed(t0)));
          if (evalDaemon) {
            const lost = (repTrace.vectorLegs ?? []).filter(l => l.path === "absent");
            if (lost.length > 0) {
              throw new HookEvalIntegrityError(
                `vector daemon lost during case ${example.id} rep ${rep}: ${lost.map(l => l.leg).join(", ")} leg(s) found no daemon on ${evalDaemon.sockPath} (child pid ${evalDaemon.pid} ${evalDaemon.alive() ? "still alive" : `exited ${evalDaemon.exitCode()}`}) — the daemon-required protocol was not executed; the run is REFUSED`
              );
            }
            // O1 §4: a leg answered WITHOUT the deadline attestation ran under NO daemon-side
            // deadline — a pre-O1 daemon on this vault's socket. Like `absent`, it is not the
            // daemon-required protocol; refuse, never mislabel.
            const skew = (repTrace.vectorLegs ?? []).filter(l => l.path === "skew");
            if (skew.length > 0) {
              throw new HookEvalIntegrityError(
                `vector daemon on ${evalDaemon.sockPath} answered ${skew.map(l => l.leg).join(", ")} leg(s) without attesting deadline-rel-v1 during case ${example.id} rep ${rep} (child pid ${evalDaemon.pid}) — a daemon that ignores the relative budget is not the daemon-required protocol; the run is REFUSED`
              );
            }
            // Codex t84 CR-5: the identity records response_protocol "hydrated-v1" — an ok leg
            // served RAW HITS (a non-hydrated request; a legacy daemon's unattested raw answer is
            // already `skew` since O1 §4, so this is defense in depth) means a DIFFERENT
            // execution (synchronous client-side hydrate) was measured; refuse, never mislabel.
            const rawHit = (repTrace.vectorLegs ?? []).filter(l => l.path === "ok" && l.protocol !== "hydrated-v1");
            if (rawHit.length > 0) {
              throw new HookEvalIntegrityError(
                `daemon answered ${rawHit.map(l => l.leg).join(", ")} leg(s) with the raw-hit protocol during case ${example.id} rep ${rep} — the run's identity is vector_exec.response_protocol "hydrated-v1", so a raw-hit execution (a non-hydrated request answered on ${evalDaemon.sockPath}) is a DIFFERENT measured contract; the run is REFUSED`
              );
            }
            await assertDaemonOwned(`after case ${example.id} rep ${rep}`);
          }
          // BUILD-3a (codex turn-23 finding 5): finalization is measured on
          // EVERY repetition — rep-0-only measurement let an undersized
          // reserve hide in the discarded reps.
          if (typeof repTrace.timings.finalizationMs === "number") allFinalizations.push(repTrace.timings.finalizationMs);
          // Codex t80 P1 → O1: the PRIMARY vector leg's MONOTONIC elapsed time
          // (vectorMs, stamped only when the profile exercised the vector leg;
          // under hydrated-v1 no client hydrate runs inside it). Codex t81
          // P1+P2 + O1 §3: EVERY completed vector invocation (primary/prior/
          // deep) is recorded against its OWN monotonic deadline, keyed case +
          // attempt + rep, and the MAX overshoot drives the HARD
          // vector_deadline_ok trust gate (codex t82 P1) — a breach FAILS the
          // member; it is never a waivable or "unmeasured" latency axis.
          for (const d of repTrace.vectorLegDeadlines ?? []) {
            allVectorLegs.push({ ...d, case: example.id, attempt, rep });
          }
          if (repTrace.timings.finalizationSubstages) allFinalizationSubstages.push(repTrace.timings.finalizationSubstages);
          if (typeof repTrace.timings.totalMs === "number") allTotals.push(repTrace.timings.totalMs);
        } finally {
          // Cleanup runs even when the handler throws — a failed rep must not
          // leak its telemetry or co-activations into the next rep or case.
          // EVERY participating store is cleaned: secondary-vault injections
          // mirror context_usage + recall_events rows into the SKILL store
          // (codex turn-9 finding 2 — general-store-only cleanup let those
          // rows survive across reps and cases).
          try { store.db.prepare(`DELETE FROM context_usage WHERE session_id = ?`).run(sessionId); } catch { /* non-fatal */ }
          try { store.db.prepare(`DELETE FROM recall_events WHERE session_id = ?`).run(sessionId); } catch { /* non-fatal */ }
          if (skillStore) {
            try { skillStore.db.prepare(`DELETE FROM context_usage WHERE session_id = ?`).run(sessionId); } catch { /* non-fatal */ }
            try { skillStore.db.prepare(`DELETE FROM recall_events WHERE session_id = ?`).run(sessionId); } catch { /* non-fatal */ }
          }
          restoreCoact();
        }
      }
      // Lower median (deterministic for even counts).
      const sortedElapsed = [...repElapsed].sort((a, b) => a - b);
      const elapsedMs = sortedElapsed[(sortedElapsed.length - 1) >> 1]!;

      const injectedPaths = qualifyInjectedPaths(trace, example.id);
      const priorLegEnabled = trace.retrievalQuery?.multiTurn ?? false;
      const metrics = computeHookCaseMetrics(example, injectedPaths, elapsedMs, budgetMs, limit, priorLegEnabled);
      const invariants = opts._testAuditTransform
        ? opts._testAuditTransform(auditTrace(trace), example.id, attempt)
        : auditTrace(trace);
      const priorAudits = attemptAudits.get(example.id);
      if (priorAudits) priorAudits.push(invariants); else attemptAudits.set(example.id, [invariants]);
      // BUILD-3b: rep 0's transmitted-text hashes (the trace kept for the
      // report) feed the run manifest.
      if (trace.rerank?.sentTextHashes) allSentTextHashes.push(...trace.rerank.sentTextHashes);

      return {
        result: {
          id: example.id,
          split: example.split,
          tags: example.tags,
          profile,
          metrics,
          injectedPaths,
          outcome: trace.outcome,
          emptyReason: trace.emptyReason,
          admission_basis: trace.admission?.basis ?? null,
          invariants,
          warnings,
        },
        trace,
      };
    };

    for (let i = 0; i < toScore.length; i++) {
      const { result, trace } = await scoreCase(i, 0);
      cases.push(result);
      traces.push({ id: result.id, trace });
    }

    // ---- BUILD-3c: in-run pair gate (reject + replace) -------------------
    // The turn-22 obligation: a paired counterfactual's acceptance must be
    // computed over pairs that are ACTUALLY pairs. Each case's pre-treatment
    // envelope is compared against the partner's by the same function the
    // post-hoc CLI audit uses; a case whose envelope diverged is RE-RUN
    // fresh (a transient dropout deserves a replacement replicate, not a
    // poisoned mean), and one that keeps diverging is excluded — never
    // silently averaged in.
    if (partnerTraces) {
      const indexOfId = new Map(toScore.map((t, i) => [t.example.id, i]));
      const verdictOf = (caseId: string): PairCaseVerdict => {
        const mine = traces.find(t => t.id === caseId)!.trace as unknown as Record<string, unknown>;
        const theirs = partnerTraces!.get(caseId);
        if (!theirs) return { id: caseId, valid: false, divergences: [`case absent from the partner run — nothing to pair with`] };
        return comparePairedCase(caseId, mine, theirs, opts.pairTreatments ?? []);
      };
      let verdicts = cases.map(c => verdictOf(c.id));
      for (let round = 1; round <= pairMaxRetries; round++) {
        // Only a case the partner actually HAS can be repaired by a re-run;
        // an absent partner case is permanently unpaired and retrying it
        // would burn the budget for nothing.
        const retryable = verdicts.filter(v => !v.valid && partnerTraces!.has(v.id));
        if (retryable.length === 0) break;
        for (const v of retryable) {
          const idx = indexOfId.get(v.id);
          if (idx === undefined) continue;
          const { result, trace } = await scoreCase(idx, round);
          pairRetried++;
          const ci = cases.findIndex(c => c.id === v.id);
          if (ci >= 0) cases[ci] = result;
          const ti = traces.findIndex(t => t.id === v.id);
          if (ti >= 0) traces[ti] = { id: result.id, trace };
        }
        verdicts = cases.map(c => verdictOf(c.id));
      }
      pairVerdicts = verdicts;
    }
  } finally {
    // Constraint 6: terminate + await the child (bounded escalation to
    // SIGKILL) and remove its socket — on success AND on refusal — before the
    // caller removes the working directory.
    if (evalDaemon) {
      const stopped = await evalDaemon.stop();
      console.error(`[eval] vector daemon child pid ${evalDaemon.pid} stopped (exit ${stopped.exitCode ?? "unknown"}${stopped.escalated ? ", escalated to SIGKILL" : ""}${stopped.socketRemoved ? ", socket removed" : ""})`);
    }
    // The last case's per-case finally already restored co-activations; this
    // outer restore is idempotent belt-and-suspenders for a throw between
    // cases, before the scratch table is dropped.
    restoreCoact();
    restoreEnv("CLAWMEM_PROFILE", priorEnv.profile);
    restoreEnv("CLAWMEM_HOOK_DEDUP_WINDOW_SEC", priorEnv.dedup);
    restoreEnv("CLAWMEM_SESSION_FOCUS", priorEnv.focus);
    restoreEnv("CLAWMEM_SURFACE_SECONDARY_VAULTS", priorEnv.secondary);
    restoreEnv("CLAWMEM_VAULTS", priorEnv.vaults);
    restoreEnv("CLAWMEM_PRIOR_VECTOR_INPROC", priorEnv.priorVecInproc);
    restoreEnv("CLAWMEM_VECTOR_DAEMON_REQUIRED", priorEnv.daemonRequired);
    clearConfigCache();
    try { store.db.exec(`DROP TABLE IF EXISTS temp._hook_eval_coact_backup`); } catch { /* already gone */ }
  }

  // ---- BUILD-3c: which cases the reported metrics are computed over -----
  // With the pair gate armed, EVERY reported mean is a paired mean: the
  // aggregates cover VALID pairs only (the turn-22 obligation — non-pairs in
  // a mean is exactly the defect BUILD-2 spent turns removing). Rejected
  // cases stay in `cases[]` with pair_valid:false, so the unrestricted view
  // is always recoverable; only the METRICS are restricted.
  const validPairIds = pairVerdicts ? new Set(pairVerdicts.filter(v => v.valid).map(v => v.id)) : null;
  if (pairVerdicts) {
    const byId = new Map(pairVerdicts.map(v => [v.id, v]));
    for (const cse of cases) cse.pair_valid = byId.get(cse.id)?.valid ?? false;
  }
  const metricCases = validPairIds ? cases.filter(c => validPairIds.has(c.id)) : cases;

  const bySplit: Record<string, HookAggregate> = {};
  {
    const bySplitMetrics = new Map<string, HookCaseMetrics[]>();
    for (const cse of metricCases) {
      let bucket = bySplitMetrics.get(cse.split);
      if (!bucket) { bucket = []; bySplitMetrics.set(cse.split, bucket); }
      bucket.push(cse.metrics);
    }
    for (const [split, ms] of bySplitMetrics) bySplit[split] = aggregateHookMetrics(ms);
  }

  // ---- expansion-draw harvest / freeze-leak audit (codex turn-17 F2) ----
  let expansionDraw: RunHookEvalResult["expansionDraw"];
  let expansionSetId = opts.expansionSet ?? "sampled";
  if (llmCachePre) {
    const post = store.db.prepare(`SELECT hash, result FROM llm_cache`).all() as { hash: string; result: string }[];
    if (opts.expansionFreeze) {
      // Every row must be pre-existing or injected, byte-identical: a new or
      // rewritten row means an LLM call the draw did not cover ran live —
      // this arm did NOT replay the paired inputs and the pair is invalid.
      // (Prune deletions are ignored: absence is not a leak.)
      const expected = new Map(llmCachePre);
      for (const r of opts.expansionFreeze.rows) expected.set(r.hash, r.result);
      const leaks = post.filter(r => expected.get(r.hash) !== r.result);
      if (leaks.length > 0) {
        // Preserve the evidence IN the error: the working copy is disposed
        // after this throw, so the leaked keys + whether each is novel or a
        // rewrite are otherwise unrecoverable (codex turn-19: the draw-3
        // refusal disposed the only diagnostic evidence).
        const detail = leaks.slice(0, 20).map(r =>
          `${r.hash} [${expected.has(r.hash) ? "REWRITTEN" : "NEW"}] result ${r.result.length}ch: ${r.result.slice(0, 120).replace(/\s+/g, " ")}`
        ).join("\n  ");
        throw new HookEvalIntegrityError(
          `expansion freeze LEAKED: ${leaks.length} llm_cache row(s) generated or rewritten during a frozen-draw replay — the draw did not cover every LLM call; the pair is invalid. Re-capture the draw on this gold set. Leaked rows (evidence — the working copy is disposed):\n  ${detail}`
        );
      }
      // BUILD-3b: the manifest is a POST-run member — this run's transmitted
      // texts must be the ones the cached scores were produced from. Checked
      // ONLY when the per-case pair gate is not armed: the gate is the finer
      // instrument (it rejects and replaces the diverging CASES), and a
      // whole-run manifest refusal would throw away pairs the gate already
      // proved valid.
      if (!pairVerdicts) {
        const mine = transmittedTextManifest(allSentTextHashes);
        const theirs = opts.expansionFreeze.binding.transmitted_text_manifest;
        if (mine !== theirs) {
          throw new HookEvalIntegrityError(
            `transmitted-text manifest mismatch: the draw was captured over texts hashing to ${theirs} but this run transmitted ${mine} (${new Set(allSentTextHashes).size} unique candidate text(s)) — the cached rerank scores were produced from different text than this run sent, so they are stale outputs, not frozen inputs. Re-capture the draw on THIS corpus, or pair the arms per-case with pairWith.`
          );
        }
      }
      expansionSetId = `draw:${opts.expansionFreeze.fingerprint}`;
    } else {
      const rows = post
        .filter(r => llmCachePre!.get(r.hash) !== r.result)
        .map(r => ({ hash: r.hash, result: r.result }));
      const fp = expansionDrawFingerprint(rows);
      expansionDraw = { fingerprint: fp, rows, binding: drawBinding(transmittedTextManifest(allSentTextHashes)) };
      expansionSetId = `draw:${fp}`;
    }
  }

  // Counted over EVERY case that ran, including pair-rejected ones, AND over
  // every ATTEMPT of each case (codex turn-29 finding 1). An enforced
  // invariant violation means the harness produced a structurally invalid
  // trace — a defect whether or not that case ended in a valid pair, and
  // whether or not a later retry happened to come out clean. Restricting
  // either dimension lets the pair gate hide real harness failures.
  const auditsFor = (id: string): InvariantAudit[] => attemptAudits.get(id) ?? [];
  const enforcedCount = cases.reduce((s, cse) => s + countAttemptViolations(auditsFor(cse.id), "enforcedViolations"), 0);
  const observedCount = cases.reduce((s, cse) => s + countAttemptViolations(auditsFor(cse.id), "observedViolations"), 0);
  for (const cse of cases) {
    const superseded = supersededAttemptEvidence(auditsFor(cse.id));
    if (superseded.length > 0) cse.superseded_attempts = superseded;
  }

  // Comparable run identity — embedded in the report and enforced against
  // the baseline before any metric comparison (codex turn-7/8 finding 4).
  const envOrUnset = (name: string): string => process.env[name] ?? "unset";
  const scoredExamples = toScore.map(t => t.example);
  const identity: RunIdentity = {
    gold_fingerprint: goldFingerprint(scoredExamples),
    limit,
    budget_ms: budgetMs,
    profiles: opts.profileOverride ? opts.profileOverride : [...new Set(cases.map(c => c.profile))].sort().join("+"),
    corpus: opts.corpusHash ?? null,
    ...(opts.corpusLabel ? { corpus_label: opts.corpusLabel } : {}),
    topology: {
      embed: envOrUnset("CLAWMEM_EMBED_URL"),
      llm: envOrUnset("CLAWMEM_LLM_URL"),
      rerank: envOrUnset("CLAWMEM_RERANK_URL"),
      // EFFECTIVE values only — what the inference layer actually honors
      // (codex turn-10 finding 4): embed/llm models take the env overrides
      // getDefaultLlamaCpp reads; the RERANK model does NOT (the hook passes
      // the store constant and no rerank-model override exists), so the
      // constant is recorded and CLAWMEM_RERANK_MODEL is deliberately NOT
      // consulted; effort/no-think are recorded through the SAME normalizers
      // the runtime applies, so equivalent spellings fingerprint equally.
      embed_model: process.env.CLAWMEM_EMBED_MODEL?.trim() || DEFAULT_EMBED_MODEL,
      query_model: process.env.CLAWMEM_LLM_MODEL?.trim() || DEFAULT_QUERY_MODEL,
      rerank_model: DEFAULT_RERANK_MODEL,
      llm_effort: normalizeRemoteLlmReasoningEffort(process.env.CLAWMEM_LLM_REASONING_EFFORT) ?? "default",
      // EFFECTIVE boolean, not the raw env state: the LlamaCpp constructor
      // defaults noThink TRUE when the normalizer yields undefined
      // (`config.remoteLlmNoThink ?? true` — llm.ts), so an unset env and
      // an explicit "true"/"1"/"yes" are the SAME runtime behavior and must
      // fingerprint identically (codex turn-11 finding 5). llm_effort keeps
      // "default" — a null effort genuinely omits the field from requests,
      // a distinct effective state.
      llm_no_think: String(normalizeRemoteLlmNoThink(process.env.CLAWMEM_LLM_NO_THINK) ?? true),
      local_fallback: process.env.CLAWMEM_NO_LOCAL_MODELS === "true" ? "blocked" : "allowed",
      served_embed: opts.servedModels?.embed ?? "unreachable",
      served_llm: opts.servedModels?.llm ?? "unreachable",
      served_rerank: opts.servedModels?.rerank ?? "unreachable",
    },
    latency_protocol: { reps: latencyReps, aggregation: "lower-median" },
    // EFFECTIVE ranking policy — the weight the fusion module resolved (env
    // override included) and the fusion revision the code under test
    // implements, so treatment arms self-identify (codex turn-17 finding 1).
    // BUILD-3d: the degeneracy-gate toggle is recorded unconditionally —
    // same class as the weight (a toggle difference is a treatment).
    ranking_policy: {
      rerank_lane_weight: RERANK_LANE_WEIGHT,
      fusion_policy_rev: FUSION_POLICY_REV,
      expansion_set: expansionSetId,
      degeneracy_gate: RERANK_DEGENERACY_GATE_ACTIVE ? "on" : "off",
      // BUILD-4: the admission policy is a treatment variable (same class
      // as the weight and the gate toggle); its revision is a note.
      admission_policy: ADMISSION_POLICY_ACTIVE,
      admission_rev: ADMISSION_POLICY_REV,
    },
    // BUILD-3a: the handler's effective internal budget — a budget difference
    // changes the escalation/rerank windows, so budget arms self-identify
    // (same class as the weight: codex turn-17 finding 1).
    hook_budget_ms: evidenceMs(runBudget), // P4: the captured budget every rep executed under
    // BUILD-4 turn-55 (codex turn-54 finding 3): the EFFECTIVE frozen
    // evaluation clock (null = wall clock) — recorded through the SAME
    // resolver the handler's composite scoring consults, so the identity
    // states the clock the policy inputs were actually computed on. Not a
    // treatment: a clock mismatch refuses the pair via identity equality.
    eval_now: resolveEvalNow()?.toISOString() ?? null,
    // Codex t76: the vector execution protocol the legs ran under — STRICT
    // on every comparison surface, not a treatment.
    vector_exec: vectorExecId,
    // O1 §4 ACTIVATION: the handler / evaluator timing contract, stamped from the exported
    // implementation constant for EVERY run (speed-only and in-process included). Strict on
    // every comparison surface; a report without it measured wall-clock deadline semantics.
    deadline_protocol: DEADLINE_PROTOCOL_IDENTITY,
  };
  // Two independent contracts, both measured (codex t77 F4 + t81 P1/P2 + t82 P1):
  if (opts._testTimingSamples?.vectorLegs) allVectorLegs.push(...opts._testTimingSamples.vectorLegs);
  const vectorDeadline = summarizeVectorDeadline(allVectorLegs);
  // BUDGET authority = TOPOLOGY: the handler's total elapsed is a representative
  // production number iff the run was daemon-backed. A daemon-backed run's
  // hook-budget number stays authoritative even when a vector SUB-deadline blew,
  // because that overrun is real daemon execution the watcher also performs.
  const budgetAuthoritative = latencyEvidenceAuthoritative(vectorExecId, identity.profiles);
  // LATENCY-AXIS authority is TOPOLOGY-scoped too (codex t82 P1): under the
  // in-process protocol the timeouts cannot fire, so p50/p95 are not evidence
  // about the daemon-backed contract and the latency axes are UNMEASURED. A
  // MEASURED per-invocation deadline breach is NOT a latency-authority
  // question — it is an INDEPENDENT trust failure (the vector_deadline_ok
  // gate below): the member fails outright rather than having its latency
  // axes quietly waived into "unmeasured".
  const latencyAxesAuthoritative = budgetAuthoritative;
  const vectorExecReport: HookRunReport["vector_exec"] = {
    protocol: vectorExecId.protocol,
    prewarm: vectorExecId.prewarm,
    response_protocol: vectorExecId.response_protocol ?? "n/a",
    daemon: evalDaemon ? { pid: evalDaemon.pid, socket: evalDaemon.sockPath, ready_ms: evalDaemon.readyMs, prewarm_ran: evalDaemon.prewarmRan, ownership_pings: ownershipPings, ownership_ping_timeout_ms: ownershipPingTimeoutMs } : null,
    latency_authoritative: latencyAxesAuthoritative,
    note: latencyAxesAuthoritative
      ? null
      : `vector legs executed IN-PROCESS on vector-exercising profiles (${identity.profiles}) — a profile timeout cannot fire during the synchronous scan, so BOTH the hook-budget gate and the latency axes are UNMEASURED; run under the daemon-required protocol (eval hook-run default) for authoritative evidence.`
  };

  // ---- BUILD-3c: pair-gate verdict (refusal, never a silent degrade) ----
  let pairAudit: HookRunReport["pair_audit"] = null;
  if (pairVerdicts) {
    // Trace equality proves nothing across runs that differ outside the
    // REGISTERED treatment(s) — the registration is the contract (codex
    // turn-40 finding 2): exactly the registered variables may differ; an
    // empty registration demands policy-identical arms. Fail-closed
    // (codex turn-21).
    const registeredTreatments = opts.pairTreatments ?? [];
    const partnerIdentity = readRunHeader(opts.pairWith!).identity;
    const idv = compareIdentities(
      identity as unknown as Record<string, unknown>,
      partnerIdentity,
      registeredTreatments,
    );
    if (!idv.comparable) {
      throw new HookEvalIntegrityError(
        `pair gate: this run and partner ${partnerRunId} are NOT identity-comparable — mismatches outside the registered treatment(s) (${registeredTreatments.length ? registeredTreatments.join(", ") : "none registered — arms must be policy-identical"}): ${idv.mismatches.join("; ")}. Per-case pair verdicts prove nothing across such runs.`
      );
    }
    // The actual treatment CONTRAST — candidate and partner values of every
    // registered variable (codex turn-41 finding 4): treatment NAMES alone
    // cannot distinguish weight 0-vs-1.5 from 0-vs-0.5, so an aggregate could
    // mix materially different experiments under one label. compareIdentities
    // above already proved each registered variable differs and everything
    // else matches, so this is a faithful record of the experiment's one
    // contrast.
    const partnerRp = (partnerIdentity as { ranking_policy?: Record<string, unknown> } | null)?.ranking_policy ?? {};
    const treatmentContrast = Object.fromEntries(registeredTreatments.map(t => [t, {
      candidate: (identity.ranking_policy as unknown as Record<string, unknown>)[t] ?? null,
      partner: partnerRp[t] ?? null,
    }])) as NonNullable<HookRunReport["pair_audit"]>["treatment_contrast"];
    const invalid = pairVerdicts.filter(v => !v.valid);
    const valid = pairVerdicts.length - invalid.length;
    const validSet = new Set(pairVerdicts.filter(v => v.valid).map(v => v.id));
    // Treatment EXPOSURE, not just pair validity (codex turn-30 SPEC-2): a
    // valid pair in which the rerank lane never answered is a pair of two
    // degraded runs, and proves nothing about the policy under test. Two
    // predicates since codex turn-40 finding 4:
    //  - BASE exposure — the pre-treatment REACH predicate of the registered
    //    treatment family (rerank coverage + >=2 sent for rerank-lane
    //    treatments and the no-treatment audit; a nonempty admission-input
    //    ledger for admission_policy — see baseExposed): the regression-watch
    //    bar the pre-registered witnesses must meet (they must have REACHED
    //    the policy, whatever the treatment);
    //  - TREATMENT-aware exposure — what min_exposed_by_stratum counts: for
    //    a degeneracy_gate experiment only assessment-fired pairs prove the
    //    treatment operated.
    const baseExposedSet = new Set(
      traces.filter(t => validSet.has(t.id) && baseExposed(t.trace as never, registeredTreatments)).map(t => t.id)
    );
    const exposedSet = new Set(
      traces.filter(t => validSet.has(t.id) && treatmentExposed(t.trace as never, registeredTreatments)).map(t => t.id)
    );
    // Per-stratum OUTCOME evidence (codex turn-43 finding 2): counts for
    // EVERY profile and split present in the scored set (key-sorted, so the
    // artifact is canonical), letting an aggregate validate each declared
    // stratum minimum directly instead of reconstructing from totals.
    const strataNames = [...new Set(cases.flatMap(c => [c.profile, c.split]))].sort();
    const validByStratum: Record<string, number> = {};
    const exposedByStratum: Record<string, number> = {};
    for (const name of strataNames) {
      validByStratum[name] = cases.filter(c => validSet.has(c.id) && (c.profile === name || c.split === name)).length;
      exposedByStratum[name] = cases.filter(c => exposedSet.has(c.id) && (c.profile === name || c.split === name)).length;
    }
    const witnessOutcomes = (opts.pairRequireIds ?? []).map(id => ({
      id, valid: validSet.has(id), base_exposed: baseExposedSet.has(id),
    }));
    // Per-stratum ADMISSION-BASIS coverage of VALID pairs (codex t68 F3) —
    // derived from the case rows' admission_basis, keyed "<stratum>:<basis>",
    // key-sorted for a canonical artifact. Recomputable by any consumer
    // (the replicated aggregate reconciles it against the rows).
    const validBasisByStratum = deriveValidBasisByStratum(cases, validSet);
    // Per-case outcome LEDGER (codex turn-44 finding): the flags every
    // summary above is derived from — recorded on the case rows so an
    // aggregate revalidates totals, stratum maps and witness receipts from
    // the exact per-case record instead of trusting free-standing numbers.
    for (const cse of cases) {
      cse.pair_base_exposed = baseExposedSet.has(cse.id);
      cse.pair_treatment_exposed = exposedSet.has(cse.id);
    }
    pairAudit = {
      partner_run_id: partnerRunId,
      partner_dir: opts.pairWith!,
      min_valid: opts.pairMinValid!,
      max_retries: pairMaxRetries,
      valid,
      invalid: invalid.length,
      retried: pairRetried,
      required_ids: opts.pairRequireIds ?? [],
      min_valid_by_stratum: opts.pairMinValidByStratum ?? {},
      min_exposed_by_stratum: opts.pairMinExposedByStratum ?? {},
      registered_treatments: registeredTreatments,
      treatment_contrast: treatmentContrast,
      treatment_exposed: exposedSet.size,
      valid_by_stratum: validByStratum,
      treatment_exposed_by_stratum: exposedByStratum,
      min_basis_by_stratum: opts.pairMinBasisByStratum ?? {},
      valid_basis_by_stratum: validBasisByStratum,
      witness_outcomes: witnessOutcomes,
      invalid_cases: invalid.map(v => ({ id: v.id, divergences: v.divergences.slice(0, 6) })),
    };
    // Codex turn-29 SPEC-5: the TOTAL count alone is not the experiment. A
    // named witness that ended invalid, or a stratum that lost its
    // pre-registered minimum, refuses the run even when the total is met —
    // otherwise an arm could discard every treatment-bearing case and still
    // report a "fully paired" acceptance.
    const witnessFailures = (opts.pairRequireIds ?? []).map(id => {
      if (!validSet.has(id)) {
        const v = pairVerdicts!.find(x => x.id === id);
        return `${id}: NOT A VALID PAIR — ${v ? v.divergences.slice(0, 2).join(" | ") : "never scored in this run"}`;
      }
      // Witnesses are regression-watch cases: they must have REACHED the
      // policy (BASE exposure), but a gate-treatment experiment must not
      // demand their score sets be degenerate — a discriminating leadgen is
      // still the mandatory regression witness (codex turn-40 finding 4).
      // Treatment-specific firing minimums belong to min_exposed_by_stratum.
      if (!baseExposedSet.has(id)) {
        // Report the ACTUAL exposure inputs (codex turn-32 finding 2): citing
        // finalOrder could claim "never operated" while displaying several
        // downstream ordered candidates.
        const t = traces.find(x => x.id === id)?.trace as ExposureTrace | undefined;
        return `${id}: valid pair but the TREATMENT NEVER OPERATED (registered: ${registeredTreatments.join(",") || "none"}) — rerank coverageComplete=${String(t?.rerank?.coverageComplete)}, ${t?.rerank?.sentPaths?.length ?? 0} candidate(s) sent to the reranker; admission-input ledger ${t?.admissionInput?.candidates?.length ?? 0} candidate(s)`;
      }
      return null;
    }).filter((x): x is string => x !== null);
    if (witnessFailures.length > 0) {
      throw new HookEvalIntegrityError(
        `pair gate REFUSED: ${witnessFailures.length} PRE-REGISTERED witness case(s) did not survive as valid, base-exposed pairs (the registered treatment family was not reached) — the experiment would no longer test what it registered. Evidence:\n  ${witnessFailures.join("\n  ")}`
      );
    }
    const strataShort: string[] = [];
    for (const [stratum, minimum] of Object.entries(opts.pairMinValidByStratum ?? {})) {
      const got = cases.filter(c => validSet.has(c.id) && (c.profile === stratum || c.split === stratum)).length;
      if (got < minimum) strataShort.push(`${stratum}: ${got} valid < ${minimum} required`);
    }
    for (const [stratum, minimum] of Object.entries(opts.pairMinExposedByStratum ?? {})) {
      const got = cases.filter(c => exposedSet.has(c.id) && (c.profile === stratum || c.split === stratum)).length;
      if (got < minimum) strataShort.push(`${stratum}: ${got} treatment-EXPOSED < ${minimum} required`);
    }
    for (const [key, minimum] of Object.entries(opts.pairMinBasisByStratum ?? {})) {
      const got = validBasisByStratum[key] ?? 0;
      if (got < minimum) strataShort.push(`${key}: ${got} valid pair(s) judged on that admission basis < ${minimum} required`);
    }
    if (strataShort.length > 0) {
      throw new HookEvalIntegrityError(
        `pair gate REFUSED: ${strataShort.length} pre-registered stratum minimum(s) unmet — a total-count pass that drops (or degrades) the treatment-bearing stratum is not the registered experiment. ${strataShort.join("; ")}`
      );
    }
    if (valid < opts.pairMinValid!) {
      // Carry the evidence IN the error: this run's artifacts are not written
      // on a throw, and the working copy is disposed by the CLI (same lesson
      // as the turn-19 freeze-leak refusal, which destroyed its own
      // diagnostic).
      const detail = invalid.slice(0, 10).map(v => `${v.id}: ${v.divergences.slice(0, 3).join(" | ")}`).join("\n  ");
      throw new HookEvalIntegrityError(
        `pair gate REFUSED: ${valid} valid pair(s) < pre-registered pairMinValid ${opts.pairMinValid} ` +
        `(${invalid.length} invalid after ${pairRetried} retry attempt(s), max ${pairMaxRetries} round(s) vs partner ${partnerRunId}). ` +
        `Acceptance over too few pairs is not the experiment that was registered. Invalid cases (evidence):\n  ${detail}`
      );
    }
  }

  // CONTRACT-5 judged acceptance vs a baseline run, on the HELD-OUT slice
  // ONLY. A missing holdout slice on either side FAILS acceptance — there is
  // no overall-aggregate fallback (the held-out contract is the point).
  // A baseline WITHOUT an attested identity is an INFORMATIONAL comparator:
  // its axes are computed and reported, but acceptance can never pass
  // against it (codex turn-8 finding 4).
  let acceptance: HookRunReport["acceptance"] = null;
  if (opts.baselinePath) {
    // Acceptance FORBIDS an allowed-fallback CANDIDATE outright (codex
    // turn-11 finding 3): a preflight-healthy endpoint can fail mid-run and
    // silently execute an unidentified in-process model while the identity
    // keeps the healthy probe. --allow-local-fallback remains available for
    // trust-only exploration runs (no --baseline).
    if (identity.topology.local_fallback === "allowed") {
      throw new HookEvalIntegrityError(
        `acceptance comparison forbids local_fallback=allowed on the candidate — a mid-run endpoint failure would silently execute an unidentified in-process model while the identity kept the healthy preflight probe. ` +
        `Re-run under CLAWMEM_NO_LOCAL_MODELS=true (the eval CLI's default; drop --allow-local-fallback); the flag remains available for trust-only exploration runs without --baseline.`
      );
    }
    const baselineReport = parseBaselineReport(opts.baselinePath);
    // BUILD-3c: a baseline whose OWN aggregates were restricted to valid
    // pairs reports paired means; comparing them against this run's
    // unrestricted means compares different case sets — the very defect the
    // pair gate exists to prevent. Refused unless this run is itself pair-
    // gated (in which case both sides are recomputed over ITS valid ids
    // below, and the baseline's stored aggregates are never read).
    if (baselineReport.pair_audit && !pairVerdicts) {
      throw new HookEvalIntegrityError(
        `baseline ${baselineReport.run_id} was produced under a pair gate — its reported aggregates cover VALID PAIRS ONLY, so comparing them against this run's unrestricted aggregates would compare different case sets. Re-run this arm with pairWith pointing at that run's directory, or use an ungated baseline.`
      );
    }
    const declared = new Set(opts.acceptUnmeasured ?? []);
    const legacyBaseline = !baselineReport.identity;
    // Reasons the comparison is INFORMATIONAL-only (acceptance can never
    // pass): a legacy baseline without identity, or an attested
    // allowed-fallback baseline whose routing is not attested "none".
    let identityNotes: string[];
    let informationalReasons: string[];
    if (legacyBaseline) {
      identityNotes = [`baseline ${baselineReport.run_id} carries no run identity — INFORMATIONAL comparison only; acceptance cannot pass against an unattested baseline`];
      informationalReasons = ["baseline carries no run identity"];
    } else {
      // Under the pair gate the baseline IS the partner (enforced in
      // preflight), so paired acceptance permits exactly the REGISTERED
      // treatment difference — that difference is what the experiment
      // measures (codex turn-40 finding 2). The unpaired --baseline path
      // passes no registration and stays strict.
      const comp = assertComparableIdentity(identity, baselineReport.identity!, baselineReport.run_id,
        pairVerdicts ? { registeredTreatments: opts.pairTreatments ?? [] } : {}); // throws on mismatch
      identityNotes = [...comp.informational.map(r => `INFORMATIONAL comparison only — ${r}`), ...comp.notes];
      informationalReasons = comp.informational;
    }
    const candidateSlice = bySplit["holdout"];
    // BUILD-3c: under the pair gate BOTH sides are recomputed over the SAME
    // valid-pair ids — the partner's stored holdout aggregate covers its own
    // full case set, which is a different set once cases were rejected here.
    // Its per-case metrics are the raw material; a partner missing them for
    // a valid id is a hard integrity failure, never a silently smaller mean.
    const baselineSlice = validPairIds
      ? restrictBaselineSlice(baselineReport, validPairIds, "holdout")
      : baselineReport.by_split?.["holdout"];
    if (!candidateSlice || !baselineSlice) {
      const missing = [!candidateSlice ? "candidate" : null, !baselineSlice ? "baseline" : null].filter(Boolean).join(" and ");
      acceptance = {
        baseline_run_id: baselineReport.run_id,
        slice: "holdout",
        axes: [],
        pass: false,
        mode: "failed",
        waived: [],
        notes: [...identityNotes, `held-out slice missing on ${missing} — acceptance REQUIRES a held-out slice; there is no overall fallback`],
      };
    } else {
      // Axes forced unmeasured: empty label strata on the held-out slice,
      // plus the latency axes when the baseline was measured under a
      // different latency protocol (relevance axes stay comparable). Under
      // the pair gate the strata are computed over the VALID examples — a
      // stratum whose only cases were rejected is genuinely unmeasured, and
      // reporting it as measured would compare an empty set.
      const forced = holdoutForcedUnmeasured(
        validPairIds ? scoredExamples.filter(e => validPairIds.has(e.id)) : scoredExamples
      );
      const blp = baselineReport.identity?.latency_protocol;
      if (!legacyBaseline && (blp?.reps !== identity.latency_protocol.reps || blp?.aggregation !== identity.latency_protocol.aggregation)) {
        const why = `latency protocol differs (baseline ${blp ? `${blp.reps}×${blp.aggregation}` : "unrecorded"} vs candidate ${identity.latency_protocol.reps}×${identity.latency_protocol.aggregation}) — latencies are not comparable measurements`;
        forced.set("latencyP50Ms", why);
        forced.set("latencyP95Ms", why);
      }
      // Codex t76: latency evidence gathered under the in-process protocol on
      // vector-exercising profiles is not evidence about the daemon-backed
      // contract (the timeouts could not fire) — the latency axes are
      // UNMEASURED, so acceptance can pass only with an explicit waiver, never
      // silently on numbers production never produces.
      if (!latencyAxesAuthoritative) {
        const why = vectorExecReport.note!;
        forced.set("latencyP50Ms", why);
        forced.set("latencyP95Ms", why);
      }
      const { axes } = computeAcceptance(baselineSlice, candidateSlice, forced);
      const { pass: axesPass, undeclaredUnmeasured, waived } = resolveAcceptancePass(axes, declared);
      const notes = [...identityNotes];
      const nonWaivableDeclared = [...declared].filter(m => !WAIVABLE_ACCEPTANCE_AXES.has(m));
      if (nonWaivableDeclared.length > 0) {
        notes.push(`declaration IGNORED for non-waivable axes: ${nonWaivableDeclared.join(", ")} — core relevance/damage axes cannot be waived`);
      }
      if (waived.length > 0) {
        notes.push(`waived (unmeasured, declared out of scope via --accept-unmeasured): ${waived.join(", ")} — acceptance is CONDITIONAL, not an unconditional product pass`);
      }
      if (undeclaredUnmeasured.length > 0) {
        notes.push(`UNDECLARED unmeasured required axes fail acceptance: ${undeclaredUnmeasured.join(", ")} — add held-out coverage or (waivable axes only) declare them with --accept-unmeasured`);
      }
      const pass = informationalReasons.length === 0 && axesPass;
      acceptance = {
        baseline_run_id: baselineReport.run_id,
        slice: "holdout",
        axes,
        pass,
        mode: pass ? (waived.length > 0 ? "conditional" : "unconditional") : "failed",
        waived,
        notes,
      };
    }
  }

  if (opts._testTimingSamples?.finalization) allFinalizations.push(...opts._testTimingSamples.finalization);
  if (opts._testTimingSamples?.totals) allTotals.push(...opts._testTimingSamples.totals);
  if (opts._testTimingSamples?.finalizationSubstages) allFinalizationSubstages.push(...opts._testTimingSamples.finalizationSubstages);

  const gateReasons: string[] = [];
  // The metric-bearing set is what minExamples is about (statistical trust in
  // the reported numbers) — under the pair gate that is the VALID pairs, not
  // every case that happened to run (BUILD-3c).
  if (metricCases.length < minExamples) {
    gateReasons.push(
      pairVerdicts
        ? `scored ${metricCases.length} valid pair(s) < min ${minExamples} (${cases.length} case(s) ran; ${cases.length - metricCases.length} excluded by the pair gate)`
        : `scored ${cases.length} < min ${minExamples}`
    );
  }
  if (unresolvedLabels.length > 0) gateReasons.push(`${unresolvedLabels.length} case(s) with unresolved must/must-not labels`);
  if (!(opts.audited ?? false)) gateReasons.push("gold labels not audit-attested (--audited)");
  if (enforcedCount > 0) gateReasons.push(`${enforcedCount} enforced invariant violation(s)`);
  // BUILD-3a (codex turn-23 finding 5 + turn-24 finding 1): the reserve and
  // total-elapsed checks feed gateReasons BEFORE trustPass is computed, so a
  // violation fails TRUST — which every CLI exit mode gates on. Computing
  // them after trustPass made the "machine-decisive" gate advisory.
  const finalization = summarizeFinalization(allFinalizations);
  const finalizationBreakdown = summarizeFinalizationBreakdown(allFinalizationSubstages);
  if (finalization.fits === false) {
    const worst = finalizationBreakdown
      ? Object.entries(finalizationBreakdown).sort((a, b) => b[1].max_ms - a[1].max_ms).slice(0, 3).map(([k, v]) => `${k}=${v.max_ms}ms`).join(", ")
      : "no substage breakdown";
    gateReasons.push(
      `finalization exceeded the reserve: max ${finalization.max_ms}ms > FINALIZATION_RESERVE_MS ${FINALIZATION_RESERVE_MS}ms across ${finalization.samples} escalated rep(s) — top substages: ${worst}`
    );
  }
  // Codex turn-24 finding 4 (last clause): total handler elapsed is gated
  // against the internal budget — the budget is the CONTRACT, not advice.
  // Small tolerance absorbs timer granularity only.
  const budgetElapsed = summarizeBudgetElapsed(allTotals, runBudget);
  // Codex t77 F4: the budget gate carries authoritative pass/fail semantics
  // ONLY under an authoritative latency protocol. Under in-process execution
  // on vector-exercising profiles neither direction establishes the daemon-
  // backed contract (an overrun is an execution production never performs
  // under the watcher; a warm in-process pass is not universally conservative
  // — the daemon adds IPC and spends its own deadline), so the required
  // budget evidence is UNMEASURED: trust fails for that reason, the raw
  // timing stays in budget_elapsed as a diagnostic, and the gate is null.
  const budgetElapsedOk: boolean | null = budgetAuthoritative ? budgetElapsed.within : null;
  if (!budgetAuthoritative) {
    gateReasons.push(
      `budget evidence UNMEASURED: ${vectorExecReport.note} (observed handler elapsed max ${budgetElapsed.max_ms ?? "n/a"}ms vs HOOK_BUDGET_MS ${budgetElapsed.budget_ms}ms is recorded DIAGNOSTICALLY only — it is neither a pass nor a failure of the daemon-backed contract)`
    );
  } else if (budgetElapsed.within === false) {
    gateReasons.push(
      `handler elapsed exceeded the internal budget: max ${budgetElapsed.max_ms}ms > HOOK_BUDGET_MS ${budgetElapsed.budget_ms}ms (+${budgetElapsed.tolerance_ms}ms tolerance) across ${budgetElapsed.samples} rep(s) — the budget is not authoritative on this host`
    );
  }
  // Codex t82 P1: a MEASURED per-invocation vector-deadline breach is an
  // INDEPENDENT trust failure — a separate contract from the whole-handler
  // budget, never a waivable latency axis. Judged only under an authoritative
  // topology (in-process legs cannot measure the daemon-backed contract, so
  // their overshoot is not evidence); null = no vector invocation to judge
  // (or topology unmeasured, which already fails trust above).
  const vdWorst = vectorDeadline.worst;
  const vectorDeadlineOk: boolean | null = budgetAuthoritative ? vectorDeadline.adhered : null;
  if (vectorDeadlineOk === false) {
    gateReasons.push(
      `measured vector deadline did NOT hold: the ${vdWorst?.leg} leg (case ${vdWorst?.case}, attempt ${vdWorst?.attempt}, rep ${vdWorst?.rep}) finished ${vectorDeadline.max_over_ms}ms past its ${vdWorst?.budget_ms}ms deadline — the MAX overshoot across ${vectorDeadline.samples} vector invocation(s) (tolerance ${vectorDeadline.tolerance_ms}ms). A per-request deadline is a separate contract from the whole-handler budget: the member FAILS trust (codex t82 P1); this is not a latency-axis waiver.`
    );
  }
  const trustPass = gateReasons.length === 0;
  const acceptancePass: boolean | null = acceptance ? acceptance.pass : null;
  if (acceptance && !acceptance.pass) {
    const failed = acceptance.axes.filter(a => a.pass === false).map(a => a.metric).join(", ");
    gateReasons.push(`acceptance vs ${acceptance.baseline_run_id} FAILED on ${acceptance.slice}: ${failed || acceptance.notes.join("; ")}`);
  }

  let clawmemVersion: string | null = null;
  try {
    const pkg = await import("../../package.json", { with: { type: "json" } }) as { default?: { version?: string } };
    clawmemVersion = pkg.default?.version ?? null;
  } catch { /* best-effort */ }

  // Turn-54 (R6): derived, key-sorted per-basis counts — see the field doc.
  const admissionBasisCounts: Record<string, number> | null = cases.length === 0 ? null : (() => {
    const acc = new Map<string, number>();
    for (const c of cases) {
      const b = c.admission_basis ?? "none";
      acc.set(b, (acc.get(b) ?? 0) + 1);
    }
    return Object.fromEntries([...acc.entries()].sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0)));
  })();

  const report: HookRunReport = {
    run_id: runId,
    surface: "context-surfacing",
    created_at: createdAt,
    gold_path: opts.goldPath,
    db_path: (store.db as { filename?: string }).filename ?? null,
    clawmem_version: clawmemVersion,
    limit,
    budget_ms: budgetMs,
    min_examples: minExamples,
    audit_attested: opts.audited ?? false,
    secondary_vaults: opts.skillVaultDb ? "snapshot" : "suppressed",
    examples_total: examples.length,
    examples_scored: cases.length,
    identity,
    // Under the pair gate every reported aggregate covers VALID PAIRS ONLY
    // (BUILD-3c) — see pair_audit for what was excluded and why.
    aggregate: aggregateHookMetrics(metricCases.map(c => c.metrics)),
    by_split: bySplit,
    enforced_invariant_violations: enforcedCount,
    observed_invariant_violations: observedCount,
    cases,
    unresolved_labels: unresolvedLabels,
    acceptance,
    pair_audit: pairAudit,
    finalization,
    finalization_breakdown: finalizationBreakdown,
    vector_deadline: vectorDeadline,
    // O1 §3: every rep's records, in full, with the harness-derived timing class.
    vector_leg_records: allVectorLegs.map(r => ({ ...r, timing: vectorLegTiming(r.over_ms), deadline_protocol: identity.deadline_protocol ?? null })),
    admission_basis_counts: admissionBasisCounts,
    budget_elapsed: budgetElapsed,
    vector_exec: vectorExecReport,
    gates: {
      trust_pass: trustPass,
      acceptance_pass: acceptancePass,
      acceptance_waived: acceptance?.waived ?? [],
      finalization_reserve_ok: finalization.fits,
      budget_elapsed_ok: budgetElapsedOk,
      vector_deadline_ok: vectorDeadlineOk,
      // Reserve/elapsed/deadline violations already fail TRUST (they feed
      // gateReasons before trustPass) — the explicit clauses here keep the
      // product gate self-describing for machine consumers.
      pass: trustPass && acceptancePass === true && (acceptance?.waived.length ?? 0) === 0 && finalization.fits !== false && budgetElapsedOk !== false && vectorDeadlineOk !== false,
      reasons: gateReasons,
    },
  };

  let artifacts: RunHookEvalResult["artifacts"] = null;
  if (opts.outDir) {
    mkdirSync(opts.outDir, { recursive: true });
    const runJsonPath = join(opts.outDir, "hook-run.json");
    const reportMdPath = join(opts.outDir, "report.md");
    const tracesPath = join(opts.outDir, "traces.jsonl");
    writeFileSync(runJsonPath, JSON.stringify(report, null, 2));
    if (existsSync(tracesPath)) writeFileSync(tracesPath, "");
    for (const t of traces) appendFileSync(tracesPath, JSON.stringify(t) + "\n");
    writeFileSync(reportMdPath, renderHookReportMd(report));
    artifacts = { runJsonPath, reportMdPath, tracesPath };
  }

  return { report, artifacts, ...(expansionDraw ? { expansionDraw } : {}) };
}

/**
 * Summarize finalization samples against the reserve (BUILD-3a, codex
 * turn-23 finding 5). Pure — unit-tested directly. Decision basis = MAX
 * (strictest; p95 reported alongside). Empty samples ⇒ fits null (the run
 * never escalated — not evidence either way).
 */
/**
 * Summarize total handler elapsed against the internal budget (codex
 * turn-24 finding 4, last clause). Pure — unit-tested directly. The
 * tolerance absorbs timer granularity ONLY; empty ⇒ within null.
 */
/**
 * Total violations of one kind across EVERY attempt of a case (codex turn-29
 * finding 1). Pure — unit-tested directly. A retry REPLACES the case result
 * and its trace, so counting only the survivor let a violating first attempt
 * be retried out of the trust gate entirely.
 */
export function countAttemptViolations(audits: InvariantAudit[], kind: "enforcedViolations" | "observedViolations"): number {
  return audits.reduce((s, a) => s + a[kind].reduce((n, v) => n + v.violations.length, 0), 0);
}

/**
 * Bounded evidence for the attempts a retry SUPERSEDED — all but the
 * surviving one, and only those that actually violated something. Their
 * traces were replaced, so without this their violations would be counted by
 * the gate while appearing nowhere in the artifacts (codex turn-29 finding 1).
 */
export function supersededAttemptEvidence(audits: InvariantAudit[]): NonNullable<HookCaseResult["superseded_attempts"]> {
  if (audits.length <= 1) return [];
  return audits.slice(0, -1)
    .map((a, i) => ({
      attempt: i,
      enforcedViolations: a.enforcedViolations.map(v => ({ id: v.id, violations: v.violations.slice(0, 5) })),
      observedViolations: a.observedViolations.map(v => ({ id: v.id, violations: v.violations.slice(0, 5) })),
    }))
    .filter(a => a.enforcedViolations.length > 0 || a.observedViolations.length > 0);
}

/**
 * Did the ranking treatment actually get a chance to OPERATE on this case
 * (codex turn-30 SPEC finding 2)? Pair-validity only proves the two arms saw
 * identical inputs — a deep witness where both arms timed out before
 * reranking is a perfectly valid pair in which the rerank weight never ran,
 * so counting it as a witness would accept an experiment that never tested
 * the policy. BASE exposure is the PRE-treatment REACH predicate of the
 * REGISTERED treatment FAMILY (see baseExposed): rerank-lane treatments and
 * the no-treatment replicate audit require the rerank lane to have ANSWERED
 * completely with at least two candidates SENT (a single-candidate request
 * is the same ordering under every weight); admission_policy requires a
 * nonempty admission-input ledger to have reached the policy branch (it runs
 * on every case, including speed/balanced cases with no rerank lane); a
 * confounded registration requires every family's reach. treatmentExposed
 * adds the treatment-specific FIRING condition on top, so treatment exposure
 * is structurally a subset of base exposure. Both members are pre-treatment,
 * so the verdict is identical from either arm.
 */
export type ExposureTrace = {
  rerank?: { coverageComplete?: boolean; sentPaths?: unknown[]; degeneracy?: { degenerate?: boolean } | null } | null;
  admissionInput?: { candidates: unknown[] } | null;
};
/**
 * BASE exposure = the PRE-treatment REACH predicate of the registered
 * treatment FAMILY, without any treatment-specific firing condition: the
 * case must have reached the surface the treatment operates on. Rerank-lane
 * treatments (weight, gate) and the no-treatment replicate audit reach via
 * the rerank predicate (coverage complete + >=2 sent); admission_policy
 * reaches via a nonempty admission-input ledger; a confounded registration
 * requires every family's reach. `treatmentExposed` = base ∧ firing, so
 * treatment exposure is structurally a subset of base exposure — the
 * implication chain the replicated aggregate re-derives (codex turn-45 F2).
 * Regression (2026-08-26 ship draws): the base ledger was computed with the
 * NO-treatment predicate for an admission_policy experiment, so every
 * balanced/speed member row read treatment-exposed without base exposure
 * and the aggregate refused all five clean members.
 */
export function baseExposed(trace: ExposureTrace | undefined, treatments?: readonly PairTreatment[]): boolean {
  return exposure(trace, treatments, false);
}
export function treatmentExposed(trace: ExposureTrace | undefined, treatments?: readonly PairTreatment[]): boolean {
  return exposure(trace, treatments, true);
}
function exposure(
  trace: ExposureTrace | undefined,
  treatments: readonly PairTreatment[] | undefined,
  requireFiring: boolean,
): boolean {
  if (!trace) return false;
  const has = (t: PairTreatment) => !!treatments?.includes(t);
  // The RERANK base predicate applies to experiments whose treatment lives
  // in the rerank lane (weight, gate) — and to the no-treatment replicate
  // audit, whose exposure notion predates BUILD-4 and stays unchanged. An
  // admission_policy experiment must NOT be gated on rerank coverage: the
  // policy operates on every case, including balanced/speed cases where the
  // rerank lane never runs — gating on coverage silently excluded exactly
  // the balanced cases the treatment changed (codex turn-52 finding 2).
  const rerankRelevant = !treatments || treatments.length === 0
    || has("rerank_lane_weight") || has("degeneracy_gate");
  if (rerankRelevant) {
    if (trace.rerank?.coverageComplete !== true) return false;
    // PRE-treatment surface only (codex turn-31 SPEC finding 3): finalOrder
    // is DOWNSTREAM of the treatment and of the zero-weight failure guard —
    // a w=0 arm can legitimately drop an unarbitrated candidate and finish
    // with one output while the w=1.5 arm keeps two, so judging exposure on
    // it made the same pair "exposed" or not depending on which arm asked.
    // What the reranker was SENT is symmetric across arms by construction.
    if ((trace.rerank?.sentPaths?.length ?? 0) < 2) return false;
    // Treatment-AWARE exposure (codex turn-40 finding 4): a degeneracy-GATE
    // experiment's arms differ ONLY on requests whose assessment fired: a
    // never-degenerate case executed identically in both arms and proves
    // nothing about the gate. The assessment is itself pre-treatment (a
    // pure function of the compared scores, recorded in BOTH arms
    // regardless of the toggle), so this stays arm-symmetric.
    if (requireFiring && has("degeneracy_gate") && trace.rerank?.degeneracy?.degenerate !== true) return false;
  }
  if (has("admission_policy")) {
    // Admission-specific, PRE-treatment predicate (codex turn-52 finding 2;
    // re-based on the LEDGER per turn-53 finding 3): the treatment operated
    // iff a nonempty candidate set actually REACHED the policy branch — read
    // from the ADMISSION-INPUT LEDGER recorded immediately BEFORE the branch
    // (arm-symmetric by construction), NEVER from the admitted/rejected
    // split, which is produced by the selected policy arm and is exactly the
    // surface the pair gate excludes from comparison. Fail-closed: a trace
    // without the ledger (pre-turn-54) proves nothing and is not exposure.
    if ((trace.admissionInput?.candidates?.length ?? 0) === 0) return false;
  }
  return true;
}

export const BUDGET_ELAPSED_TOLERANCE_MS = 50;
/**
 * Tolerance on the per-invocation vector-leg deadline (codex t80 P1) — a
 * primary/prior/deep leg may run slightly past its declared deadline on timer
 * granularity + IPC without the daemon contract being violated. Wider than
 * the budget tolerance because a leg legitimately spends its whole timeout
 * PLUS the bounded per-line decode of the daemon's answer (under hydrated-v1
 * hydration runs daemon-side; the pre-t84 client hydrate is gone).
 *
 * O1 §3: `over_ms` is measured on the MONOTONIC clock — finish minus the leg's
 * own monotonic deadline. The value is FROZEN at 150 ms and was NOT re-fitted
 * against post-migration data: monotonic subtraction RESTORES the metric this
 * tolerance always meant (milliseconds of lag) rather than redefining it —
 * wall-clock sampling was the contamination, not the definition. The five
 * rerun draws validate the migration against it; they never tune it.
 */
export const VECTOR_DEADLINE_TOLERANCE_MS = 150;

/** O1 §3: one vector invocation's record as the harness collects it — the trace record keyed by case + ATTEMPT + rep
 * (codex migration r2 #6: the pair gate re-scores a case under a new attempt, and every attempt's legs stay evidence —
 * case + rep alone would give two attempts indistinguishable keys while both feed the trust gate). */
export type VectorLegRunRecord = VectorLegDeadlineRecord & { case: string; attempt: number; rep: number };
/** O1 §3: the persisted form — plus the harness-derived timing class and the run's deadline-protocol identity. */
export type VectorLegPersistedRecord = VectorLegRunRecord & { timing: VectorLegTiming; deadline_protocol: string | null };
/** `early` = finished before its deadline; `on_time` = past it but within the frozen tolerance; `late` = beyond it. */
export type VectorLegTiming = "early" | "on_time" | "late";
export function vectorLegTiming(over_ms: number): VectorLegTiming {
  return over_ms <= 0 ? "early" : over_ms <= VECTOR_DEADLINE_TOLERANCE_MS ? "on_time" : "late";
}
/**
 * Did the measured per-invocation vector deadline hold? Each sample is ONE
 * primary/prior/deep vector invocation: its MONOTONIC overshoot past its OWN
 * deadline (over_ms) and the budget it ran under.
 * `adhered` is judged on the MAX overshoot across every invocation (codex t81
 * P1): a request deadline is a per-invocation safety bound, not a typical-case
 * statistic — one late invocation anywhere breaks adherence, and no warm-up
 * rep may hide the cold first request. null adhered = no invocation to judge.
 */
export function summarizeVectorDeadline(samples: { leg: "primary" | "prior" | "deep"; over_ms: number; budget_ms: number; case: string; attempt: number; rep: number }[]): { samples: number; max_over_ms: number | null; worst: { leg: "primary" | "prior" | "deep"; case: string; attempt: number; rep: number; budget_ms: number } | null; tolerance_ms: number; adhered: boolean | null } {
  if (samples.length === 0) {
    return { samples: 0, max_over_ms: null, worst: null, tolerance_ms: VECTOR_DEADLINE_TOLERANCE_MS, adhered: null };
  }
  // MAX overshoot across EVERY vector invocation (codex t81 P1): a request
  // deadline is a per-invocation safety bound, not a typical-case statistic, so
  // one late invocation anywhere in the run breaks adherence — a lower median
  // would let fast reps of other cases drown a persistently late case, and no
  // warm-up rep may hide the cold first request.
  let worst = samples[0]!;
  for (const x of samples) if (x.over_ms > worst.over_ms) worst = x;
  return {
    samples: samples.length,
    max_over_ms: worst.over_ms,
    worst: { leg: worst.leg, case: worst.case, attempt: worst.attempt, rep: worst.rep, budget_ms: worst.budget_ms },
    tolerance_ms: VECTOR_DEADLINE_TOLERANCE_MS,
    adhered: worst.over_ms <= VECTOR_DEADLINE_TOLERANCE_MS,
  };
}
export function summarizeBudgetElapsed(samples: number[], budget: DurationMs): { samples: number; max_ms: number | null; budget_ms: number; tolerance_ms: number; within: boolean | null } {
  // O1 §2 + codex migration r1 P4: the SAME accepted budget the handler ran
  // under — the run's captured value, passed in, never re-read here.
  const budgetMs = evidenceMs(budget);
  const sorted = [...samples].sort((a, b) => a - b);
  const max = sorted.length ? sorted[sorted.length - 1]! : null;
  return {
    samples: sorted.length,
    max_ms: max,
    budget_ms: budgetMs,
    tolerance_ms: BUDGET_ELAPSED_TOLERANCE_MS,
    within: max === null ? null : max <= budgetMs + BUDGET_ELAPSED_TOLERANCE_MS,
  };
}

export function summarizeFinalization(samples: number[]): { samples: number; max_ms: number | null; p95_ms: number | null; reserve_ms: number; fits: boolean | null } {
  const sorted = [...samples].sort((a, b) => a - b);
  const max = sorted.length ? sorted[sorted.length - 1]! : null;
  const p95 = sorted.length ? sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * 0.95) - 1))]! : null;
  return {
    samples: sorted.length,
    max_ms: max,
    p95_ms: p95,
    reserve_ms: FINALIZATION_RESERVE_MS,
    fits: max === null ? null : max <= FINALIZATION_RESERVE_MS,
  };
}

/**
 * BUILD-3d.4 (codex turn-47 finding 2): per-substage max/mean across escalated
 * reps, so the report shows WHERE finalization time is spent. Keys are whatever
 * substages the traces carried (filters/enrich/scoring/ordering/buildContext/
 * inject/facts/tail); a substage absent from a rep (early empty return) simply
 * does not contribute that rep's sample. Null when no rep carried a breakdown.
 */
export function summarizeFinalizationBreakdown(
  samples: Record<string, number>[]
): Record<string, { max_ms: number; mean_ms: number }> | null {
  if (samples.length === 0) return null;
  const acc = new Map<string, number[]>();
  for (const s of samples) {
    for (const [k, v] of Object.entries(s)) {
      if (typeof v !== "number" || !Number.isFinite(v)) continue;
      let arr = acc.get(k);
      if (!arr) { arr = []; acc.set(k, arr); }
      arr.push(v);
    }
  }
  if (acc.size === 0) return null;
  const out: Record<string, { max_ms: number; mean_ms: number }> = {};
  for (const [k, arr] of acc) {
    out[k] = { max_ms: Math.max(...arr), mean_ms: Math.round(arr.reduce((a, b) => a + b, 0) / arr.length) };
  }
  return out;
}

function fmt(v: number | null, digits = 3): string {
  return v === null ? "—" : v.toFixed(digits);
}

/** Human companion report for hand-auditing a run. */
export function renderHookReportMd(report: HookRunReport): string {
  const lines: string[] = [];
  lines.push(`# Hook replay-eval run ${report.run_id}`);
  lines.push("");
  lines.push(`- surface: ${report.surface} · k=${report.limit} · budget ${report.budget_ms}ms · secondary vaults ${report.secondary_vaults}`);
  lines.push(`- gold: ${report.gold_path}`);
  lines.push(`- db: ${report.db_path ?? "(in-memory)"} · clawmem ${report.clawmem_version ?? "?"}`);
  lines.push(`- scored ${report.examples_scored}/${report.examples_total} · audited: ${report.audit_attested}`);
  if (report.identity) {
    lines.push(`- identity: gold ${report.identity.gold_fingerprint.slice(0, 12)}… · profiles ${report.identity.profiles} · corpus ${report.identity.corpus ?? "(unlabeled)"} · topology embed=${report.identity.topology.embed} llm=${report.identity.topology.llm} rerank=${report.identity.topology.rerank}`);
  }
  const g = report.gates;
  const acceptLabel = g.acceptance_pass === null
    ? "NOT EVALUATED (no baseline) — this run is NOT product acceptance"
    : g.acceptance_pass
      ? (g.acceptance_waived.length > 0 ? `CONDITIONAL PASS (waived: ${g.acceptance_waived.join(", ")})` : "PASS")
      : "FAIL";
  lines.push(`- gates: trust ${g.trust_pass ? "PASS" : "FAIL"} · acceptance ${acceptLabel} · unconditional product acceptance ${g.pass ? "PASS" : "NO"}${g.reasons.length ? ` — ${g.reasons.join("; ")}` : ""}`);
  const fin = report.finalization;
  lines.push(`- finalization vs reserve: ${fin.samples === 0 ? "no escalated reps (n/a)" : `max ${fin.max_ms}ms / p95 ${fin.p95_ms}ms vs reserve ${fin.reserve_ms}ms over ${fin.samples} rep(s) — ${fin.fits ? "FITS" : "EXCEEDS"}`}`);
  if (report.finalization_breakdown) {
    const fb = report.finalization_breakdown;
    const parts = Object.entries(fb).map(([k, v]) => `${k} ${v.max_ms}/${v.mean_ms}`).join(" · ");
    lines.push(`  - substage max/mean ms (where the reserve is spent): ${parts}`);
  }
  const vd = report.vector_deadline;
  if (vd.samples > 0) {
    const w = vd.worst;
    lines.push(`- vector deadline (max over ${vd.samples} primary/prior/deep invocation(s), +${vd.tolerance_ms}ms tol): ${vd.adhered === false ? `DID NOT HOLD — ${w?.leg} leg (case ${w?.case}, attempt ${w?.attempt}, rep ${w?.rep}) ${vd.max_over_ms}ms past its ${w?.budget_ms}ms deadline${g.vector_deadline_ok === false ? " → TRUST FAIL (vector_deadline_ok gate)" : " (topology non-authoritative — not contract evidence)"}` : `held (worst overshoot ${vd.max_over_ms}ms)`}`);
  }
  if (report.admission_basis_counts) {
    const abc = Object.entries(report.admission_basis_counts).map(([k, v]) => `${k} ${v}`).join(" · ");
    lines.push(`- admission bases (per-case channel topology, derived from case rows): ${abc}`);
  }
  const be = report.budget_elapsed;
  lines.push(`- handler elapsed vs budget: ${be.samples === 0 ? "no reps measured (n/a)" : `max ${be.max_ms}ms vs budget ${be.budget_ms}ms (+${be.tolerance_ms}ms) over ${be.samples} rep(s) — ${be.within ? "WITHIN" : "EXCEEDS"}`}`);
  // S2 (codex t82): budget authority renders from the RECORDED gate state —
  // budget_elapsed_ok === null with a topology note means the budget number is
  // diagnostic, while a deadline breach (vector_deadline_ok=false) leaves
  // budget authority intact under the split.
  if (report.gates.budget_elapsed_ok === null && report.vector_exec?.note) {
    lines.push(`  - budget authority: DIAGNOSTIC ONLY — ${report.vector_exec.note}`);
  }
  if (report.vector_exec) {
    const ve = report.vector_exec;
    lines.push(`- vector execution: ${ve.protocol}${ve.protocol === "daemon-required" ? ` (prewarm ${ve.prewarm}, response ${ve.response_protocol}${ve.daemon ? `; daemon child pid ${ve.daemon.pid} ready in ${ve.daemon.ready_ms}ms, prewarm ${ve.daemon.prewarm_ran ? "ran" : "no vectors"}` : ""})` : ""} — latency evidence ${ve.latency_authoritative ? "AUTHORITATIVE (daemon-backed contract)" : `NOT authoritative: ${ve.note}`}`);
  }
  const pa = report.pair_audit;
  if (pa) {
    lines.push(`- **pair gate vs ${pa.partner_run_id}**: ${pa.valid} valid / ${pa.invalid} invalid (min ${pa.min_valid}, ${pa.retried} retry attempt(s), max ${pa.max_retries} round(s)) — **every aggregate below covers VALID PAIRS ONLY**`);
    if (pa.required_ids.length > 0) lines.push(`  - pre-registered witnesses (all valid): ${pa.required_ids.join(", ")}`);
    for (const [k, v] of Object.entries(pa.min_valid_by_stratum)) lines.push(`  - pre-registered stratum minimum met: ${k} >= ${v} valid`);
    for (const [k, v] of Object.entries(pa.min_exposed_by_stratum)) lines.push(`  - pre-registered stratum minimum met: ${k} >= ${v} TREATMENT-EXPOSED`);
    for (const [k, v] of Object.entries(pa.min_basis_by_stratum ?? {})) lines.push(`  - pre-registered admission-basis minimum met: ${k} >= ${v} valid pair(s)`);
    lines.push(`  - treatment-exposed pairs (registered treatment family FIRED — rerank coverage+>=2 reorderable for a rerank-lane treatment, and for degeneracy_gate the assessment additionally recorded degenerate=true; a nonempty admission-input ledger for admission_policy): ${pa.treatment_exposed}/${pa.valid}`);
    for (const ic of pa.invalid_cases) lines.push(`  - excluded ${ic.id}: ${ic.divergences.join(" | ")}`);
  }
  if (report.acceptance) {
    lines.push(`- acceptance vs ${report.acceptance.baseline_run_id} on ${report.acceptance.slice}: ${report.acceptance.pass ? report.acceptance.mode.toUpperCase() : "FAIL"}`);
    for (const note of report.acceptance.notes) lines.push(`  - note: ${note}`);
    for (const a of report.acceptance.axes) {
      const verdict = a.pass === true ? "ok" : a.pass === null ? `UNMEASURED${a.note ? ` (${a.note})` : ""}` : `FAIL${a.note ? ` (${a.note})` : ""}`;
      lines.push(`  - ${a.metric}: ${fmt(a.baseline)} → ${fmt(a.candidate)} ${verdict}`);
    }
  }
  lines.push("");
  const aggRow = (name: string, a: HookAggregate): string =>
    `| ${name} | ${a.cases} | ${fmt(a.ndcgMean)} | ${fmt(a.mustNotCaseRate)} | ${fmt(a.mustNotDocRate)} | ${fmt(a.mustIncludeRecallMean)} | ${fmt(a.abstentionAccuracy)} | ${fmt(a.falseAbstainRate)} | ${fmt(a.priorLegAccuracy)} | ${fmt(a.latencyP50Ms, 0)} | ${fmt(a.latencyP95Ms, 0)} | ${fmt(a.timeoutRate)} |`;
  lines.push(`| slice | n | nDCG | mustNot(case) | mustNot(doc) | mustRecall | abstAcc | falseAbst | priorLeg | p50ms | p95ms | timeout |`);
  lines.push(`|---|---|---|---|---|---|---|---|---|---|---|---|`);
  lines.push(aggRow("all", report.aggregate));
  for (const [split, agg] of Object.entries(report.by_split)) lines.push(aggRow(split, agg));
  lines.push("");
  lines.push(`- enforced invariant violations: ${report.enforced_invariant_violations}`);
  lines.push(`- observed (unenforced) invariant violations: ${report.observed_invariant_violations}`);
  lines.push("");
  lines.push(`## Cases`);
  for (const c of report.cases) {
    lines.push(`### ${c.id} (${c.split}, ${c.profile})${c.pair_valid === false ? " — PAIR-EXCLUDED (not in any reported mean)" : ""}`);
    lines.push(`- outcome: ${c.outcome}${c.emptyReason ? ` (${c.emptyReason})` : ""} · injected ${c.metrics.injectedCount} · nDCG ${fmt(c.metrics.ndcg)} · mustNot ${c.metrics.mustNotCount} · recall ${fmt(c.metrics.mustIncludeRecall)} · ${c.metrics.elapsedMs.toFixed(0)}ms${c.metrics.timedOut ? " TIMEOUT" : ""}`);
    if (c.injectedPaths.length > 0) lines.push(`- injected: ${c.injectedPaths.join(" · ")}`);
    for (const v of c.invariants.enforcedViolations) lines.push(`- ENFORCED VIOLATION [${v.id}]: ${v.violations.join("; ")}`);
    for (const a of c.superseded_attempts ?? []) {
      for (const v of a.enforcedViolations) lines.push(`- ENFORCED VIOLATION [${v.id}] on SUPERSEDED attempt ${a.attempt} (trace replaced by a retry): ${v.violations.join("; ")}`);
      for (const v of a.observedViolations) lines.push(`- observed [${v.id}] on superseded attempt ${a.attempt}: ${v.violations.join("; ")}`);
    }
    for (const v of c.invariants.observedViolations) lines.push(`- observed [${v.id}]: ${v.violations.join("; ")}`);
    for (const w of c.warnings) lines.push(`- warning: ${w}`);
  }
  lines.push("");
  return lines.join("\n");
}
