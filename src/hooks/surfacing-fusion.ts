/**
 * Context-surfacing candidate fusion — lane-based membership selection
 * (BUILD-1: C1 / C1b / C1c, RANKING-DEFECT-HANDOFF Addendum 5).
 *
 * Replaces the old candidate-generation shape (concatenate prior turns into
 * one query, merge every leg through a seen-set, let mixed raw scores decide
 * survival) with explicit LANES: each retrieval leg contributes a ranked
 * list; lanes are fused with the shared weighted RRF (`weightBonuses` policy
 * — only this call site opts in, C1b); membership into the candidate pool is
 * then governed by two enforced invariants (C1c):
 *
 *   (i)  MASS CAP — the aggregate post-bonus weighted contribution of the
 *        discounted lanes (prior + expansion) is scaled down whenever it
 *        would reach the current-class lanes' aggregate, so recall hints can
 *        never outvote the user's actual question;
 *   (ii) PROTECTED SLOTS — a fixed floor of pool slots is reserved for
 *        candidates with current-class support, so discounted lanes cannot
 *        crowd them out of the finalist set.
 *
 * MEMBERSHIP and the FINAL ORDERING KEY both live here since BUILD-2, and
 * since BUILD-4 so does ADMISSION (`relevanceAdmission` — judged on the same
 * ordering key; the composite score retains tier sizing only). The final
 * injected ORDER is the fusion contribution itself (`finalOrderingKeys`),
 * with the deep profile's reranker rank-fused in as one more lane
 * (`fuseRerankLane`) — never a composite or mixed-raw-score sort. The full
 * membership arithmetic is recorded into the trace envelope so the
 * `expansion-mass-cap` and `single-ranking-key` invariants audit real
 * numbers.
 *
 * The one deliberate mass-cap edge: when the current-class lanes returned
 * NOTHING (currentMass = 0) and the anaphora gate certified that the prompt
 * delegates its meaning to prior turns, the PRIOR lanes pass uncapped — they
 * are the only signal there is. Expansion lanes never pass on a zero-signal
 * current query.
 */

import type { SearchResult } from "../store.ts";
import { docGateTokens, anyPrefixMatch } from "./gate-tokens.ts";
import { HYDRATED_GATE_TEXT_LEN } from "../vector-protocol.ts";
import { reciprocalRankFusion, toRanked } from "../search-utils.ts";
import type { SurfacingLeg, TraceFusion, TraceFusionCandidate } from "../eval/hook-trace.ts";

/** Lane weights for the hook's candidate fusion (eval-tunable constants). */
export const LANE_WEIGHTS: Record<SurfacingLeg, number> = {
  "vector": 1.0,
  "fts-fallback": 1.0,
  "fts-supplement": 1.0,
  "file-aware": 1.0,
  "secondary-vault": 1.0,
  "prior-vector": 0.5,
  "prior-fts": 0.5,
  "expansion-vec": 0.4,
  "expansion-lex": 0.4,
};

/** Lanes whose queries derive from the CURRENT prompt — the protected class. */
export const CURRENT_CLASS_LANES: ReadonlySet<SurfacingLeg> = new Set([
  "vector", "fts-fallback", "fts-supplement", "file-aware", "secondary-vault",
]);

/** Fraction of the pool bound reserved for current-supported candidates. */
export const PROTECTED_CURRENT_RATIO = 0.6;

/** Extra pool capacity beyond profile.maxResults (preserves the historical FTS-supplement headroom). */
export const POOL_HEADROOM = 5;

export interface LaneList {
  lane: SurfacingLeg;
  results: SearchResult[];
  /** Expansion / file-aware lanes: the variant or file query that produced the list. */
  variantQuery?: string;
}

export interface FusionMembership {
  /** The selected candidate pool, deduped by vault-qualified identity, fused order. */
  pool: SearchResult[];
  /** Full membership arithmetic for the trace envelope / invariant audit. */
  fusion: TraceFusion;
}

/** Which vault a result came from (`_fromVault` tag set at the secondary-vault leg). */
export function vaultOf(r: SearchResult): "general" | "skill" {
  return (r as { _fromVault?: string })._fromVault === "skill" ? "skill" : "general";
}

/**
 * Vault-qualified candidate identity (codex turn-7 SPEC-5): two DISTINCT
 * documents sharing one `collection/path` across the general and skill
 * vaults must never collapse into one candidate. General-vault docs keep the
 * bare filepath (byte-identical to the pre-fix identity in the common
 * single-vault case); skill-vault docs are qualified with the same `skill:`
 * prefix the eval's label convention uses. Used for aggregation, admission,
 * the failure guard, rerank ids, and the handler's dedupe — displayPath (the
 * user-facing output identity) is never qualified.
 */
export function candidateKey(r: SearchResult): string {
  return vaultOf(r) === "skill" ? `skill:${r.filepath}` : r.filepath;
}

interface CandidateAgg {
  /** Vault-qualified identity (candidateKey). */
  filepath: string;
  displayPath: string;
  vault: "general" | "skill";
  lanes: Set<SurfacingLeg>;
  /** Post-cap weighted RRF contribution, summed across lanes. */
  contribution: number;
  laneContributions: { lane: SurfacingLeg; contribution: number }[];
  currentSupported: boolean;
  currentQueryGatePassed: boolean;
  /**
   * Payload precedence is STRUCTURAL (codex turn-7 SPEC-6): the first
   * occurrence from a CURRENT-CLASS lane wins over any discounted-lane
   * occurrence regardless of leg execution order; within a class, the first
   * occurrence in lane order wins. Never a cross-channel score compare.
   */
  payload: SearchResult;
  payloadIsCurrentClass: boolean;
}

/**
 * CONTRACT-1(d) cheap per-candidate relevance gate: the candidate's
 * title+body must share at least one content token (prefix match, mirroring
 * FTS semantics) with the gate token set. The caller supplies the CURRENT
 * prompt's content tokens — or, when the prompt is pure anaphora with zero
 * content tokens, the PRIOR turns' content tokens, so ambiguous prompts
 * still gate every candidate against the context they delegate to (codex
 * turn-7 SPEC-3). An EMPTY gate token set fails closed: with nothing to
 * certify against, the gate certifies nothing — vacuous success is not a
 * relevance gate.
 *
 * Codex #28 t86 (projection-complete hydrated-v1): a daemon-projected
 * candidate carries no body — it carries `gateTokens`, precomputed by the
 * daemon with the SAME `docGateTokens` tokenizer this gate uses for a body
 * candidate, so both branches judge identically. Dedup on the projected set
 * is sound: the gate is an existential prefix match (set semantics).
 */
export function passesCurrentQueryGate(
  candidate: Pick<SearchResult, "title" | "body"> & { gateTokens?: readonly string[] },
  gateTokens: ReadonlySet<string>
): boolean {
  if (gateTokens.size === 0) return false;
  const docTokens = candidate.gateTokens ?? docGateTokens(candidate.title, candidate.body, HYDRATED_GATE_TEXT_LEN);
  return anyPrefixMatch(docTokens, gateTokens);
}

/**
 * Select the candidate pool from the collected lanes.
 *
 * @param lanes ranked lists per retrieval leg, in the order the legs ran
 * @param maxResults the active profile's maxResults (pool bound = maxResults + POOL_HEADROOM)
 * @param priorLegCertified true when the anaphora gate enabled the prior leg (the zero-current-mass edge)
 * @param gateTokens content tokens the per-candidate gate checks against — the
 *   CURRENT prompt's, or the PRIOR turns' on a pure-anaphora prompt (SPEC-3)
 * @param gateTokenSource provenance of gateTokens, recorded in the trace
 */
export function selectCandidatePool(
  lanes: LaneList[],
  maxResults: number,
  priorLegCertified: boolean,
  gateTokens: ReadonlySet<string> = new Set(),
  gateTokenSource: "current" | "prior" | "none" = "current"
): FusionMembership {
  const poolBound = Math.max(1, maxResults + POOL_HEADROOM);
  const protectedSlots = Math.ceil(poolBound * PROTECTED_CURRENT_RATIO);

  // Per-lane single-list RRF through the SHARED helper (C1b policy opt-in).
  // RRF is additive across lists, so summing per-lane scores reproduces the
  // multi-list fusion exactly while keeping per-lane contributions visible
  // for the mass cap — no arithmetic is duplicated outside search-utils.
  const perLane = lanes.map(l => ({
    lane: l.lane,
    weight: LANE_WEIGHTS[l.lane] ?? 1.0,
    fused: reciprocalRankFusion([l.results.map(toRanked)], [LANE_WEIGHTS[l.lane] ?? 1.0], 60, { weightBonuses: true }),
    results: l.results,
  }));

  let currentMass = 0;
  let preCapDiscountedMass = 0;
  for (const pl of perLane) {
    const mass = pl.fused.reduce((s, r) => s + r.score, 0);
    if (CURRENT_CLASS_LANES.has(pl.lane)) currentMass += mass;
    else preCapDiscountedMass += mass;
  }

  // MASS CAP (C1c-i): scale discounted-lane contributions so their aggregate
  // stays strictly below the current-class aggregate. Zero-current-mass edge:
  // prior lanes pass uncapped ONLY under gate certification; expansion lanes
  // are zeroed outright.
  let capApplied = false;
  let capFactor: number | null = null;
  let discountFactorPrior = 1;
  let discountFactorExpansion = 1;
  if (currentMass > 0) {
    if (preCapDiscountedMass >= currentMass) {
      capApplied = true;
      capFactor = (currentMass * 0.999) / preCapDiscountedMass;
      discountFactorPrior = capFactor;
      discountFactorExpansion = capFactor;
    }
  } else {
    discountFactorPrior = priorLegCertified ? 1 : 0;
    discountFactorExpansion = 0;
    capApplied = !priorLegCertified || perLane.some(pl => pl.lane === "expansion-lex" || pl.lane === "expansion-vec");
  }

  // Aggregate per candidate across lanes with the cap applied. Identity is
  // VAULT-QUALIFIED (candidateKey, SPEC-5) so cross-vault same-path documents
  // stay distinct candidates. The payload (which SearchResult represents the
  // doc downstream) follows STRUCTURAL class precedence (SPEC-6): the first
  // current-class occurrence wins over any discounted occurrence independent
  // of leg execution order; within a class the first occurrence in lane order
  // wins. Raw cosine and the BM25 transform are incomparable channels, so a
  // keep-max cross-channel compare is never performed anywhere in membership.
  const byKey = new Map<string, CandidateAgg>();
  let discountedMass = 0;
  for (const pl of perLane) {
    const isCurrent = CURRENT_CLASS_LANES.has(pl.lane);
    const isPrior = pl.lane === "prior-vector" || pl.lane === "prior-fts";
    const factor = isCurrent ? 1 : isPrior ? discountFactorPrior : discountFactorExpansion;
    const bySrc = new Map(pl.results.map(r => [r.filepath, r]));
    for (const fr of pl.fused) {
      const scaled = fr.score * factor;
      if (!isCurrent) discountedMass += scaled;
      const src = bySrc.get(fr.file);
      if (!src) continue;
      const key = candidateKey(src);
      let agg = byKey.get(key);
      if (!agg) {
        agg = {
          filepath: key,
          displayPath: src.displayPath,
          vault: vaultOf(src),
          lanes: new Set(),
          contribution: 0,
          laneContributions: [],
          currentSupported: false,
          currentQueryGatePassed: passesCurrentQueryGate(src, gateTokens),
          payload: src,
          payloadIsCurrentClass: isCurrent,
        };
        byKey.set(key, agg);
      } else if (isCurrent && !agg.payloadIsCurrentClass) {
        // Structural precedence: a current-class occurrence displaces a
        // discounted-lane payload (never by score — by class, then order).
        agg.payload = src;
        agg.payloadIsCurrentClass = true;
      }
      agg.lanes.add(pl.lane);
      agg.contribution += scaled;
      const lc = agg.laneContributions.find(l => l.lane === pl.lane);
      if (lc) lc.contribution += scaled;
      else agg.laneContributions.push({ lane: pl.lane, contribution: scaled });
      if (isCurrent) agg.currentSupported = true;
    }
  }

  // Membership walk (C1c-ii): fused order, but once the unreserved capacity
  // is spent, only current-supported candidates may take the reserved slots.
  const ordered = [...byKey.values()]
    .filter(a => a.contribution > 0)
    .sort((a, b) => b.contribution - a.contribution);
  const totalCurrentSupported = ordered.filter(a => a.currentSupported).length;
  const reserve = Math.min(protectedSlots, totalCurrentSupported);

  const admitted: CandidateAgg[] = [];
  let admittedCurrent = 0;
  for (const cand of ordered) {
    if (admitted.length >= poolBound) break;
    const remainingSlots = poolBound - admitted.length;
    const remainingReserve = Math.max(0, reserve - admittedCurrent);
    if (!cand.currentSupported && remainingSlots <= remainingReserve) continue;
    admitted.push(cand);
    if (cand.currentSupported) admittedCurrent++;
  }

  const admittedSet = new Set(admitted.map(a => a.filepath));
  const candidates: TraceFusionCandidate[] = ordered.map(a => ({
    filepath: a.filepath,
    displayPath: a.displayPath,
    vault: a.vault,
    lanes: [...a.lanes],
    contribution: a.contribution,
    laneContributions: a.laneContributions,
    currentSupported: a.currentSupported,
    currentQueryGatePassed: a.currentQueryGatePassed,
    admitted: admittedSet.has(a.filepath),
  }));

  return {
    pool: admitted.map(a => a.payload),
    fusion: {
      lanes: perLane.map(pl => ({ lane: pl.lane, weight: pl.weight, count: pl.results.length })),
      candidates,
      gateTokenSource,
      currentMass,
      discountedMass,
      preCapDiscountedMass,
      capApplied,
      capFactor,
      poolBound,
      protectedSlots: reserve,
      admittedCurrentSupported: admittedCurrent,
    },
  };
}

/**
 * BUILD-2 (C2): the FINAL ordering key — the pair (band, mass). Ordering is
 * band ASC then mass DESC.
 *
 * `mass` is the channel-aware weighted RRF contribution the membership
 * fusion already computed, keyed by the vault-qualified identity: one
 * rank-derived, scale-free scalar — raw cosine and the BM25 transform never
 * compare numerically, and the secondary vault's
 * corpus-statistics-incomparable FTS scores enter only as ranks of their own
 * lane list.
 *
 * `band` is the CURRENT-ANCHOR tier (codex turn-14 finding 4): the aggregate
 * mass cap alone does not stop a discounted-only candidate from out-massing
 * the best current hit (rank-0 in three expansion variants sums past a
 * current rank-0), so discounted-only candidates order in band 1 — strictly
 * BELOW every current-supported candidate ("fuse prior/expansion legs BELOW
 * current"). The band is UNCONDITIONAL on the current anchor (codex turn-15
 * finding): an APPLIED full-coverage rerank proves the reranker ANSWERED for
 * every candidate, not that it DISCRIMINATED — an inert reranker returning
 * all-equal scores covers the whole pool yet verifies nothing, and letting
 * coverage elevate bands would dissolve the anchor and readmit the
 * three-variant expansion attack. So the rerank contributes MASS ONLY
 * (fuseRerankLane, within the bands); it never lifts a discounted-only
 * candidate into the current-anchor band. BUILD-3 may elevate, but only
 * behind a rerank-discrimination probe (rerank-health prior art), never
 * coverage alone.
 */
export interface OrderingKey {
  band: 0 | 1;
  mass: number;
}

export function finalOrderingKeys(fusion: TraceFusion): Map<string, OrderingKey> {
  return new Map(fusion.candidates.map(c => [c.filepath, {
    band: (c.currentSupported ? 0 : 1) as 0 | 1,
    mass: c.contribution,
  }]));
}

/** Compare two ordering keys: band ASC, then mass DESC. Negative = a first. */
export function compareOrderingKeys(a: OrderingKey, b: OrderingKey): number {
  if (a.band !== b.band) return a.band - b.band;
  return b.mass - a.mass;
}

/**
 * Weight of the reranker's ranking when it is rank-fused into the final key
 * on the deep profile (BUILD-2; eval-tunable like LANE_WEIGHTS). BUILD-3
 * promotes the reranker to the ORDER over strictly-covered finalists — until
 * then it is the strongest single channel, not the arbiter.
 *
 * CLAWMEM_RERANK_LANE_WEIGHT overrides the default for eval ablations and
 * weight tuning. 0 is meaningful: the lane is skipped entirely (shared-RRF
 * fusion mass alone orders within bands), holding the pool and every other
 * pipeline stage constant — the RRF-only counterfactual. Non-finite or
 * negative values fall back to the default.
 */
export function resolveRerankLaneWeight(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") return 1.5;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : 1.5;
}

export const RERANK_LANE_WEIGHT = resolveRerankLaneWeight(process.env.CLAWMEM_RERANK_LANE_WEIGHT);

/**
 * True when the rerank lane can influence ordering at all: the shared RRF
 * skips zero-weight lists entirely, so at weight 0 a fully-covered rerank
 * applies no ordering AND does not arbitrate the failure guard — usable
 * arbitration requires the lane to ACT (coverage AND active), so rankingKey
 * stays "rrf", orderingApplied stays false, and dropUnarbitrated runs
 * (codex turn-17 finding 1; turn-18 finding 3).
 */
export const RERANK_LANE_ACTIVE = RERANK_LANE_WEIGHT > 0;

/**
 * Per-request degeneracy gate toggle (BUILD-3d). Default ON. The ONLY
 * disabling value is "off" (trimmed, exact) — any other value keeps the gate
 * active, so a typo can never silently disable a safety gate. The toggle
 * exists for the judged A/B (the control arm runs the identical binary with
 * the gate's ACTION disabled); the ASSESSMENT itself always runs and is
 * always traced, so both arms measure how often the gate would fire.
 * Recorded in eval run identity (ranking_policy.degeneracy_gate) — a toggle
 * difference is a treatment variable, same class as the lane weight.
 */
export function resolveRerankDegeneracyGate(raw: string | undefined): boolean {
  return !(raw !== undefined && raw.trim() === "off");
}

export const RERANK_DEGENERACY_GATE_ACTIVE = resolveRerankDegeneracyGate(process.env.CLAWMEM_RERANK_DEGENERACY_GATE);

/**
 * Monotonic revision of the final-ordering policy this module implements —
 * recorded in eval run identity (ranking_policy) so runs executed under
 * different ordering semantics can never silently advertise identical
 * identities (codex turn-17 finding 1). Bump when ordering semantics change:
 *   1 — BUILD-2: channel-aware weighted-RRF final key
 *   2 — turn-14: current-anchor banding {band, mass}
 *   3 — turn-16: band unconditional on current support; rerank adds mass only
 *   4 — turn-18: weight-aware lane application (weight 0 ⇒ lane inert,
 *       rankingKey "rrf", orderingApplied false)
 *   5 — turn-19: usable-arbitration guard — coverage alone no longer
 *       qualifies candidates when the lane is inert (weight 0 ⇒
 *       dropUnarbitrated runs; CONTRACT-1d, codex turn-18 finding 3)
 *   6 — BUILD-3d: per-request degeneracy gate — a fully-covered but
 *       degenerate score set (collapse/inert per the rerank-health-adapted
 *       floors) discards the lane: orderingApplied stays false and the
 *       failure guard arbitrates (turn-15 F3: trust only behind coverage
 *       AND discrimination)
 */
export const FUSION_POLICY_REV = 7; // rev 7 = BUILD-4: admission judged on the ordering key (identity gains admission_policy/admission_rev; ordering semantics unchanged from rev 6)

/**
 * Fuse the reranker's ranking into the final ordering keys as ONE MORE
 * channel-aware lane (BUILD-2, deep profile): the covered candidates'
 * rerank-descending order becomes a ranked list fed through the SAME shared
 * weighted-RRF arithmetic as every other lane — rank-derived and scale-free,
 * never a raw-score blend. The caller guarantees FULL coverage of the
 * candidate set before applying (a partially-covered pool must never be
 * partially reordered — CONTRACT-3). The rerank adds MASS ONLY: bands are the
 * current-anchor decision (finalOrderingKeys) and stay untouched here, so a
 * fully-covering but inert reranker can reorder WITHIN a band but never lift a
 * discounted-only candidate above the current anchor (codex turn-15 finding).
 *
 * @param keys base final-ordering keys (candidateKey → OrderingKey)
 * @param rerankedKeysDesc candidateKeys in reranker-score-descending order
 */
export function fuseRerankLane(keys: ReadonlyMap<string, OrderingKey>, rerankedKeysDesc: string[]): Map<string, OrderingKey> {
  const rankedList = rerankedKeysDesc.map(k => ({ file: k, displayPath: k, title: "", body: "", score: 0 }));
  const fused = reciprocalRankFusion([rankedList], [RERANK_LANE_WEIGHT], 60, { weightBonuses: true });
  const out = new Map<string, OrderingKey>();
  for (const [k, v] of keys) out.set(k, { ...v });
  for (const fr of fused) {
    const existing = out.get(fr.file);
    // Full coverage of the candidate set is the caller's contract, so every
    // reranked key already has a band here. Add its rank-fused mass in place
    // and NEVER fabricate a band-0 entry for an unlisted key — that would
    // smuggle an unanchored doc to the top on a coverage-contract breach.
    if (existing) existing.mass += fr.score;
  }
  return out;
}

/**
 * Failure guard (CONTRACT-1d): with no usable rerank arbitration, a candidate
 * may stay in the pool only with original-current support OR a passed
 * per-candidate current-query gate. Applies uniformly to prior-only and
 * expansion-only candidates — the anaphora gate enables the prior LANE but
 * cannot certify its individual documents. Matches on the vault-qualified
 * identity (candidateKey) so cross-vault same-path documents are never
 * dropped or kept for each other.
 */
export function dropUnarbitrated(pool: SearchResult[], fusion: TraceFusion): SearchResult[] {
  const drop = new Set(
    fusion.candidates
      .filter(c => c.admitted && !c.currentSupported && !c.currentQueryGatePassed)
      .map(c => c.filepath)
  );
  if (drop.size === 0) return pool;
  return pool.filter(r => !drop.has(candidateKey(r)));
}

// ---------------------------------------------------------------------------
// BUILD-4 (C4): relevance admission on the final ordering basis
// ---------------------------------------------------------------------------

/** The final-score basis admission judges on — the same key that orders. */
export type AdmissionBasis = "bm25-rrf" | "weighted-rrf" | "rerank-fused-rrf";

/**
 * Current-class lanes that constitute KEYWORD agreement: exact lexical
 * support for the current prompt. The vector lane is current-class but is
 * NOT keyword agreement — junk candidacy enters via the vector leg alone
 * (Addendum 2), and on a flat embedding band cosine cannot discriminate
 * (Addendum 6: embeddinggemma-300M band 0.66–0.69, spread 0.03 over 9
 * unrelated docs).
 */
export const KEYWORD_CLASS_LANES: ReadonlySet<SurfacingLeg> = new Set([
  "fts-fallback", "fts-supplement", "file-aware", "secondary-vault",
]);

export interface RelevanceAdmissionParams {
  /**
   * Per-document floor: admit mass >= floorRatio × the band's own top mass.
   * RELATIVE to the query's own top by design — never an absolute score
   * (Addendum 6: absolute per-document floors cannot separate signal from
   * noise on a flat embedding band). Multi-lane agreement roughly doubles a
   * candidate's mass, so at 0.5 a single-lane tail under a two-lane-agreed
   * top is cut while genuine single-lane leaders survive.
   */
  floorRatio: number;
  /** How many band-0 leaders the (diagnostic, non-decisional) spread stat is measured over. */
  spreadK: number;
}

/**
 * Per-basis parameter table (BUILD-4). Initial values are identical across
 * bases — the table exists so the judged A/B can calibrate each basis (and
 * each embedding model / topology, both recorded in the trace and the run
 * identity) independently without code archaeology. Not user-tunable.
 */
export const ADMISSION_PARAMS: Record<AdmissionBasis, RelevanceAdmissionParams> = {
  "bm25-rrf":         { floorRatio: 0.5, spreadK: 5 },
  "weighted-rrf":     { floorRatio: 0.5, spreadK: 5 },
  "rerank-fused-rrf": { floorRatio: 0.5, spreadK: 5 },
};

/** Lanes whose contribution makes the fused basis vector-bearing. */
const VECTOR_BEARING_LANES: ReadonlySet<SurfacingLeg> = new Set([
  "vector", "prior-vector", "expansion-vec",
]);

/**
 * The basis is derived from the vector contributions of the candidates
 * ACTUALLY JUDGED — the applicable band of the present set (band 0 when
 * nonempty, else the band-1 certified-prior surface) — never from configured
 * profile capability (codex turn-52 finding 3: a balanced run whose vector
 * leg timed out is a bm25-rrf basis) and never from lane counts alone
 * (codex turn-53 finding 1: a vector lane whose every candidate was removed
 * before admission — private/snoozed/noise/dedupe — leaves an FTS-only
 * judged set, which is a bm25-rrf basis; the label keys the calibration
 * table and the recorded evidence, so it must describe the surface the
 * decision was actually made on).
 */
export function resolveAdmissionBasis(
  fusion: TraceFusion,
  rerankOrderingApplied: boolean,
  present: readonly string[],
  keys: Map<string, OrderingKey>,
): AdmissionBasis {
  if (rerankOrderingApplied) return "rerank-fused-rrf";
  const byKey = new Map(fusion.candidates.map(c => [c.filepath, c]));
  const band0 = present.filter(k => (keys.get(k)?.band ?? 1) === 0);
  const judged = band0.length > 0 ? band0 : present;
  const vectorJudged = judged.some(k =>
    (byKey.get(k)?.laneContributions ?? [])
      .some(lc => VECTOR_BEARING_LANES.has(lc.lane) && lc.contribution > 0)
  );
  return vectorJudged ? "weighted-rrf" : "bm25-rrf";
}

export interface RelevanceAdmissionDecision {
  /** Vault-qualified candidate identities admitted into the injection set. */
  admitted: string[];
  rejected: { key: string; reason: "floor" | "band-floor" | "degenerate" }[];
  /** Query-level abstention (abstain > mislead): emit nothing, with cause. */
  abstain: "no-current-support" | "degenerate-basis" | null;
  stats: {
    basis: AdmissionBasis;
    band0Count: number;
    band1Count: number;
    topMass: number;
    /** Diagnostic only — rank bonuses make fused-mass spread non-flat by construction, so spread is RECORDED for calibration but never decides. */
    spreadRel: number | null;
    keywordAgreed: number;
  };
}

/**
 * BUILD-4 (C4) — the admission decision, judged on the FINAL ordering key
 * (band, mass) rather than the composite score (turn-17 finding 4: composite
 * admission rejected on-topic documents while admitting junk).
 *
 * - `present` = the candidates that survived enrichment + noise filters
 *   (vault-qualified identities) — admission judges what could actually be
 *   injected, not the raw pool.
 * - Band 0 empty: abstain ("no-current-support") unless the zero-current-mass
 *   certified-prior edge holds (see below), in which case band 1 is judged
 *   under its own relative floor — the prior lanes are the only signal there is.
 * - Band 0 with ZERO keyword-class agreement: the pool's current support is
 *   vector-alone — the Addendum-2/6 junk-candidacy signature (gibberish and
 *   abstract-register prompts produce exactly this shape: FTS finds nothing,
 *   the embedding band is flat) → abstain ("degenerate-basis"). A mass-spread
 *   test CANNOT stand in for this: the shared RRF's rank bonuses (+0.05/+0.02
 *   × lane weight) make fused-mass spread large even over a single
 *   non-discriminating lane, so spread is recorded as a diagnostic only.
 *   Known accepted risk (OG-2): a purely-semantic query with zero lexical
 *   overlap anywhere abstains — the held-out replay slice decides whether a
 *   cheap current-query verifier must be added; never a composite restore.
 * - Otherwise: relative per-doc floor within band 0 (mass >= floorRatio ×
 *   top). Multi-lane agreement doubles mass, so vector-only tails fall below
 *   a keyword-agreed top without any absolute threshold.
 * - Band 1 (discounted-only) is admitted ONLY on the certified-prior path
 *   (band 0 empty + zero current mass). When band 0 exists, every band-1
 *   candidate is REJECTED (reason "band"): the locked C4/OG-1 contract
 *   permits discounted-only candidates only when they are the only signal —
 *   a band-relative floor would guarantee at least one discounted-only
 *   admission whenever band 1 is nonempty (its own top always passes),
 *   converting discounted recall into an automatic exploration slot the
 *   design forbids (codex turn-52 finding, proven on the ctp trace). The
 *   anaphoric candidate-gen misses (turn-47 finding 5) are unaffected:
 *   those targets never reach the pool at all.
 */
export function relevanceAdmission(
  present: string[],
  keys: Map<string, OrderingKey>,
  fusion: TraceFusion,
  basis: AdmissionBasis,
  params: RelevanceAdmissionParams = ADMISSION_PARAMS[basis],
): RelevanceAdmissionDecision {
  const byKey = new Map(fusion.candidates.map(c => [c.filepath, c]));
  const FLOOR: OrderingKey = { band: 1, mass: 0 };
  const entries = present.map(key => {
    const k = keys.get(key) ?? FLOOR;
    return { key, band: k.band, mass: k.mass };
  });
  const band0 = entries.filter(e => e.band === 0).sort((a, b) => b.mass - a.mass);
  const band1 = entries.filter(e => e.band === 1).sort((a, b) => b.mass - a.mass);
  const kwAgreed = new Set(
    present.filter(key => (byKey.get(key)?.lanes ?? []).some(l => KEYWORD_CLASS_LANES.has(l)))
  );

  const spreadRel = (() => {
    if (band0.length === 0) return null;
    const top = band0[0]!.mass;
    if (top <= 0) return 0;
    const k = Math.min(params.spreadK, band0.length);
    return (top - band0[k - 1]!.mass) / top;
  })();

  const stats: RelevanceAdmissionDecision["stats"] = {
    basis,
    band0Count: band0.length,
    band1Count: band1.length,
    topMass: band0[0]?.mass ?? band1[0]?.mass ?? 0,
    spreadRel,
    keywordAgreed: kwAgreed.size,
  };

  const admitted: string[] = [];
  const rejected: RelevanceAdmissionDecision["rejected"] = [];
  const floorCut = (list: { key: string; mass: number }[], reason: "floor" | "band-floor") => {
    const top = list[0]?.mass ?? 0;
    for (const e of list) {
      if (top > 0 && e.mass >= params.floorRatio * top) admitted.push(e.key);
      else rejected.push({ key: e.key, reason });
    }
  };

  if (band0.length === 0) {
    // Zero-current-mass edge: when the current-class lanes returned NOTHING,
    // the mass cap already guaranteed that every surviving discounted
    // candidate is PRIOR-lane (expansion lanes never pass on a zero-signal
    // current query — selectCandidatePool's cap), and the prior lanes only
    // ran because the anaphora gate certified them. So band-1 survivors here
    // ARE the certified-prior signal; judge them under their own relative
    // floor. (gateTokenSource is NOT the test — "prior" marks only the
    // pure-anaphora token fallback, while an anaphoric prompt with content
    // tokens keeps source "current".)
    const certifiedPrior = fusion.currentMass === 0;
    if (certifiedPrior && band1.length > 0) {
      floorCut(band1, "band-floor");
      return { admitted, rejected, abstain: null, stats };
    }
    return {
      admitted: [],
      rejected: entries.map(e => ({ key: e.key, reason: "floor" as const })),
      abstain: "no-current-support",
      stats,
    };
  }

  const kwBand0 = band0.filter(e => kwAgreed.has(e.key));
  if (kwBand0.length === 0) {
    return {
      admitted: [],
      rejected: entries.map(e => ({ key: e.key, reason: "degenerate" as const })),
      abstain: "degenerate-basis",
      stats,
    };
  }

  floorCut(band0, "floor");
  // C4/OG-1: with band 0 present, discounted-only candidates never enter the
  // output (see the contract note in the doc comment above).
  for (const e of band1) rejected.push({ key: e.key, reason: "band-floor" });
  return { admitted, rejected, abstain: null, stats };
}

/**
 * BUILD-4: revision of the relevance-admission machinery — bump when the
 * parameter table or the decision shape changes. Recorded in the run
 * identity (informational note on mismatch, like FUSION_POLICY_REV).
 */
export const ADMISSION_POLICY_REV = 1;

/**
 * BUILD-4: which admission policy the hook executes. "relevance" (default)
 * = admission judged on the final ordering key. "composite" = the
 * pre-BUILD-4 composite gate, kept ONLY as the registered treatment's
 * control arm for the paired A/B (CLAWMEM_ADMISSION_POLICY=composite on the
 * control invocation) — never the production default. Unknown values fall
 * back to "relevance".
 */
export function resolveAdmissionPolicy(raw: string | undefined): "relevance" | "composite" {
  return raw === "composite" ? "composite" : "relevance";
}
export const ADMISSION_POLICY_ACTIVE: "relevance" | "composite" =
  resolveAdmissionPolicy(process.env.CLAWMEM_ADMISSION_POLICY);
