/**
 * Hook replay-eval — hermetic invariant checkers (BUILD-0, CONTRACT-5a).
 *
 * Each invariant is a pure function over one SurfacingTrace. The registry
 * carries an `enforced` flag per invariant: enforced invariants FAIL the CI
 * suite and the replay run's gate; unenforced ones are still evaluated and
 * REPORTED (they measure the standing defect until the BUILD that fixes it
 * lands and flips the flag). Flipping `enforced` to true is an explicit part
 * of each BUILD-1..5 change set — the gate exists before the change, per the
 * cleared design.
 *
 * An invariant can also be not-evaluable on a given trace (the pipeline
 * fields it audits don't exist yet, or the stage didn't run). Not-evaluable
 * is reported as such — it is never a silent pass.
 */

import type { SurfacingTrace } from "./hook-trace.ts";
import { FINALIZATION_RESERVE_MS } from "../hooks/context-surfacing.ts";

export interface InvariantResult {
  id: string;
  evaluable: boolean;
  violations: string[];
}

export interface InvariantDef {
  id: string;
  /** Contract in the design-of-record this invariant enforces. */
  contract: string;
  description: string;
  /** Enforced = a violation fails the suite/run gate. Flipped per BUILD as the machinery lands. */
  enforced: boolean;
  check: (trace: SurfacingTrace) => InvariantResult;
}

/** Legs that constitute the deep-escalation expansion lanes. */
const EXPANSION_LEGS = new Set(["expansion-lex", "expansion-vec"]);

/** displayPaths of pooled candidates whose ONLY supporting legs are expansion legs. */
export function expansionOnlyPaths(trace: SurfacingTrace): Set<string> {
  const legsByPath = new Map<string, Set<string>>();
  for (const c of trace.candidates) {
    if (!c.pooled) continue;
    let legs = legsByPath.get(c.displayPath);
    if (!legs) { legs = new Set(); legsByPath.set(c.displayPath, legs); }
    legs.add(c.leg);
  }
  const out = new Set<string>();
  for (const [path, legs] of legsByPath) {
    if ([...legs].every(l => EXPANSION_LEGS.has(l))) out.add(path);
  }
  return out;
}

const traceComplete: InvariantDef = {
  id: "trace-complete",
  contract: "CONTRACT-5",
  description: "Every injected document is traceable to at least one pooled candidate with leg + raw channel score, a composite entry, and the trace's stage records are internally consistent.",
  enforced: true,
  check(trace) {
    const violations: string[] = [];
    if (trace.outcome === null) {
      return { id: this.id, evaluable: true, violations: ["trace has no recorded outcome — the handler did not finish through the trace path"] };
    }
    if (trace.outcome === "empty") {
      if (trace.emptyReason === null) violations.push("empty outcome without an emptyReason");
      if (trace.finalPaths.length > 0) violations.push("empty outcome with non-empty finalPaths");
      return { id: this.id, evaluable: true, violations };
    }
    // injected
    if (trace.finalPaths.length === 0) violations.push("injected outcome with zero finalPaths");
    const pooled = new Set(trace.candidates.filter(c => c.pooled).map(c => c.displayPath));
    const compositePaths = new Set(trace.composite.map(c => c.displayPath));
    for (const p of trace.finalPaths) {
      if (!pooled.has(p)) violations.push(`injected "${p}" has no pooled candidate provenance (no leg / raw score recorded)`);
      if (!compositePaths.has(p)) violations.push(`injected "${p}" has no composite-scoring record`);
    }
    if (trace.injection) {
      const entryPaths = trace.injection.entries.map(e => e.displayPath);
      if (entryPaths.length !== trace.finalPaths.length || entryPaths.some((p, i) => p !== trace.finalPaths[i])) {
        violations.push("injection entries do not match finalPaths order");
      }
    } else {
      violations.push("injected outcome without an injection record");
    }
    if (!trace.admission) violations.push("injected outcome without an admission record");
    return { id: this.id, evaluable: true, violations };
  },
};

const admissionHonored: InvariantDef = {
  id: "admission-honored",
  contract: "CONTRACT-4",
  description: "Every injected document passed the admission decision — post-admission stages may reorder or boost but never add a candidate that admission rejected. Matches on the vault-qualified candidate identity, never displayPath (cross-vault twins share one).",
  enforced: true,
  check(trace) {
    if (trace.outcome !== "injected" || !trace.admission || !trace.injection) {
      return { id: this.id, evaluable: false, violations: [] };
    }
    // Match on the vault-qualified candidate identity (candidateKey), not
    // displayPath: cross-vault twins share a displayPath, so a displayPath set
    // would let an injected skill-vault doc borrow the admission record of its
    // rejected general-vault twin, or vice versa (codex turn-15 finding). The
    // injection entries are the injected set at candidate granularity.
    const admitted = new Set(trace.admission.admitted.map(a => a.candidate));
    const violations = trace.injection.entries
      .filter(e => !admitted.has(e.candidate))
      .map(e => `injected "${e.displayPath}" (candidate ${e.candidate}) was not in the admitted set`);
    return { id: this.id, evaluable: true, violations };
  },
};

const singleRankingKey: InvariantDef = {
  id: "single-ranking-key",
  contract: "CONTRACT-2",
  description: "Final ordering is produced by one channel-aware relevance key — the pair (current-anchor band, weighted RRF mass; rerank rank-fused when applied) — never a numeric sort over mixed raw cosine/BM25 scores or the composite. ENFORCED since BUILD-2.",
  enforced: true,
  check(trace) {
    if (trace.outcome !== "injected") {
      // Empty outcomes never reach the ordering step (rankingKey stays the
      // pre-ordering default) — nothing to audit.
      return { id: this.id, evaluable: false, violations: [] };
    }
    const violations: string[] = [];
    if (trace.rankingKey === "composite") {
      violations.push("injected output was ordered by the composite key — BUILD-2 requires the channel-aware relevance key (rrf/rerank)");
    }
    const fo = trace.finalOrder;
    if (!fo) {
      violations.push("injected outcome without a finalOrder record — the ordering key values are unauditable");
      return { id: this.id, evaluable: true, violations };
    }
    if (!trace.injection) {
      violations.push("injected outcome without an injection record — the injected candidates cannot be matched to the ordering keys at candidate identity");
      return { id: this.id, evaluable: true, violations };
    }
    // Walk the INJECTED candidates (injection entries, candidate granularity)
    // as a SUBSEQUENCE of finalOrder, matching on the vault-qualified
    // candidate identity — never displayPath, since cross-vault twins share a
    // displayPath and a match-by-displayPath would collapse distinct ordering
    // candidates (codex turn-14 finding 3 / turn-15 candidate-identity).
    // finalOrder is the full scored order; buildContext may SKIP entries
    // (sanitizer/budget), so the pointer walk tolerates gaps in finalOrder
    // while any out-of-order or unrecorded candidate fails to match.
    let cursor = 0;
    let prev: { candidate: string; displayPath: string; band: 0 | 1; keyValue: number } | null = null;
    for (const entry of trace.injection.entries) {
      let matched: (typeof fo)[number] | null = null;
      while (cursor < fo.length) {
        const e = fo[cursor++]!;
        if (e.candidate === entry.candidate) { matched = e; break; }
      }
      if (!matched) {
        violations.push(`injected "${entry.displayPath}" (candidate ${entry.candidate}) has no final-ordering key record (or appears out of the recorded final order)`);
        continue;
      }
      // The matched subsequence must be non-increasing in (band ASC, mass
      // DESC) — a band-1 (discounted-only) entry may never precede a band-0
      // (current-anchored) one, and within a band the mass may not rise.
      if (prev) {
        if (matched.band < prev.band) {
          violations.push(`injected order places band-${prev.band} "${prev.displayPath}" above band-${matched.band} "${entry.displayPath}" — discounted-only candidates must order below current-anchored ones`);
        } else if (matched.band === prev.band && matched.keyValue > prev.keyValue) {
          violations.push(`injected order inverts the relevance key at "${entry.displayPath}" (${matched.keyValue.toFixed(6)} > ${prev.keyValue.toFixed(6)} within band ${matched.band})`);
        }
      }
      prev = { candidate: entry.candidate, displayPath: entry.displayPath, band: matched.band, keyValue: matched.keyValue };
    }
    return { id: this.id, evaluable: true, violations };
  },
};

const massCap: InvariantDef = {
  id: "expansion-mass-cap",
  contract: "CONTRACT-1c",
  description: "Aggregate post-bonus weighted mass of prior+expansion lanes stays below the original-current-leg mass, and the protected original-current finalist slots are honored (BUILD-1).",
  enforced: true,
  check(trace) {
    const f = trace.fusion;
    if (!f) return { id: this.id, evaluable: false, violations: [] };
    const violations: string[] = [];

    if (f.currentMass > 0) {
      if (f.discountedMass >= f.currentMass) {
        violations.push(`post-cap discounted mass ${f.discountedMass.toFixed(6)} >= current mass ${f.currentMass.toFixed(6)}`);
      }
    } else {
      // Zero-current-mass edge: prior lanes may pass uncapped ONLY under the
      // anaphora gate's certification; expansion contributions must be zero.
      const priorCertified = trace.priorLeg?.enabled === true;
      if (f.discountedMass > 0 && !priorCertified) {
        violations.push(`discounted mass ${f.discountedMass.toFixed(6)} with zero current mass and no certified prior leg`);
      }
      // Per-lane split (not lane-exclusive filtering): a candidate supported
      // by BOTH a prior lane and an expansion lane still must contribute
      // zero expansion mass here (codex turn-6 SPEC-5).
      const expansionContrib = f.candidates.reduce(
        (s, c) => s + (c.laneContributions ?? [])
          .filter(l => l.lane === "expansion-lex" || l.lane === "expansion-vec")
          .reduce((a, l) => a + l.contribution, 0),
        0
      );
      if (expansionContrib > 0) {
        violations.push(`expansion contribution ${expansionContrib.toFixed(6)} survived a zero-current-mass fusion`);
      }
    }

    // Protected slots (C1c-ii): the admitted pool must carry at least the
    // reserved number of current-supported candidates (the recorded
    // protectedSlots is already min'd against availability).
    if (f.admittedCurrentSupported < f.protectedSlots) {
      violations.push(`admitted current-supported ${f.admittedCurrentSupported} < protected slots ${f.protectedSlots}`);
    }

    return { id: this.id, evaluable: true, violations };
  },
};

const rerankCoverageOrFallback: InvariantDef = {
  id: "rerank-coverage-or-fallback",
  contract: "CONTRACT-3",
  description: "When a rerank ran, every injected document was covered by it — or the whole set fell back to the pre-rerank order. A partially-reranked pool must never be partially reordered.",
  enforced: false,
  check(trace) {
    if (trace.outcome !== "injected" || !trace.rerank || !trace.rerank.attempted || trace.rerank.failed) {
      return { id: this.id, evaluable: false, violations: [] };
    }
    if (!trace.rerank.orderingApplied) return { id: this.id, evaluable: true, violations: [] };
    const covered = new Set(trace.rerank.coveredPaths);
    // coveredPaths are filepaths; candidates map filepath → displayPath.
    const coveredDisplay = new Set(
      trace.candidates.filter(c => covered.has(c.filepath)).map(c => c.displayPath)
    );
    const violations = trace.finalPaths
      .filter(p => !coveredDisplay.has(p))
      .map(p => `injected "${p}" reached output without reranker coverage while a rerank reordered the pool`);
    return { id: this.id, evaluable: true, violations };
  },
};

const noExpansionLeakOnFailedRerank: InvariantDef = {
  id: "no-expansion-leak-on-failed-rerank",
  contract: "CONTRACT-1c/1d",
  description: "An expansion-only candidate never reaches output without arbitration when the rerank lane did not ACT — arbitration is EITHER usable rerank ordering (orderingApplied: coverage AND an active lane) OR the per-candidate query gate (mirrors dropUnarbitrated; codex turn-7 finding 7; turn-18 finding 3: coverage alone is transport completeness and qualifies nothing). Enforced in-handler since BUILD-1.",
  enforced: true,
  check(trace) {
    if (trace.outcome !== "injected") return { id: this.id, evaluable: false, violations: [] };
    const expOnly = expansionOnlyPaths(trace);
    if (expOnly.size === 0) return { id: this.id, evaluable: true, violations: [] };
    // Arbitration = the rerank lane ACTED on ordering (orderingApplied),
    // mirroring the handler's guard. Coverage alone is transport
    // completeness — a fully-covering rerank whose scores influence nothing
    // (weight 0) does not qualify candidates, so the turn-17 fallback that
    // accepted coverageComplete alone encoded the same CONTRACT-1d leak the
    // handler had (codex turn-18 finding 3). orderingApplied is also exact
    // for pre-turn-18 traces, where it was set only under an active lane
    // with full coverage.
    const rerankOk = !!trace.rerank && trace.rerank.attempted && !trace.rerank.failed
      && trace.rerank.orderingApplied;
    if (rerankOk) return { id: this.id, evaluable: true, violations: [] };
    // The implemented contract (dropUnarbitrated) keeps a candidate without
    // rerank arbitration when currentSupported OR currentQueryGatePassed —
    // the invariant must accept the same, or contract-compliant output fails
    // the replay gate. Expansion lanes are general-vault only, so on a
    // displayPath carried by candidates in both vaults the general one is
    // the expansion-only candidate under audit.
    const gatePassedByDisplay = new Set(
      (trace.fusion?.candidates ?? [])
        .filter(c => c.vault !== "skill" && (c.currentSupported || c.currentQueryGatePassed))
        .map(c => c.displayPath)
    );
    const violations = trace.finalPaths
      .filter(p => expOnly.has(p) && !gatePassedByDisplay.has(p))
      .map(p => `expansion-only candidate "${p}" was injected without reranker arbitration or a passed per-candidate query gate`);
    return { id: this.id, evaluable: true, violations };
  },
};

const metadataBandOnly: InvariantDef = {
  id: "metadata-band-only",
  contract: "CONTRACT-2/C5",
  description: "BUILD-5: the calibrated metadata tie band is ZERO-WIDTH — the reorder machinery (topic boost, spreading activation, diversification) is deleted, so the final order must equal the ordering-key order with the candidateKey lexicographic tie-break EXACTLY. Equal-key neighbors out of candidate order are the one place metadata could still hide; this forbids it.",
  enforced: true,
  check(trace) {
    if (trace.outcome !== "injected" || !trace.finalOrder) {
      return { id: this.id, evaluable: false, violations: [] };
    }
    const violations: string[] = [];
    for (let i = 1; i < trace.finalOrder.length; i++) {
      const a = trace.finalOrder[i - 1]!;
      const b = trace.finalOrder[i]!;
      if (a.band === b.band && a.keyValue === b.keyValue && !(a.candidate < b.candidate)) {
        violations.push(`equal-key neighbors out of deterministic tie order: "${a.candidate}" before "${b.candidate}" (band ${a.band}, key ${a.keyValue}) — the BUILD-5 zero-width band permits only the candidateKey lexicographic tie-break`);
      }
    }
    return { id: this.id, evaluable: true, violations };
  },
};

const finalizationFitsReserve: InvariantDef = {
  id: "finalization-fits-reserve",
  contract: "C2c/C3 (BUILD-3a)",
  description: "Post-escalation finalization (guard/filters/composite/admission/ordering/payload assembly — the reserve window ends at the payload boundary since BUILD-5) fits inside FINALIZATION_RESERVE_MS — the reserve the rerank deadline subtracts from the internal budget. A violation means the reserve constant is undersized on this host; recalibrate it from the measured distribution. Observed, never enforced (a timing property of the host, not a correctness property of the change).",
  enforced: false,
  check(trace) {
    const f = trace.timings?.finalizationMs;
    if (f === null || f === undefined) return { id: this.id, evaluable: false, violations: [] };
    return {
      id: this.id,
      evaluable: true,
      violations: f > FINALIZATION_RESERVE_MS
        ? [`finalization took ${f}ms > FINALIZATION_RESERVE_MS ${FINALIZATION_RESERVE_MS}ms — the rerank-deadline reserve is undersized on this host`]
        : [],
    };
  },
};

const degeneracyGateHonored: InvariantDef = {
  id: "degeneracy-gate-honored",
  contract: "C3 (BUILD-3d)",
  description: "When the per-request degeneracy gate is ARMED (degeneracy.gated) and the fully-covered score set was judged degenerate, the rerank lane was DISCARDED — orderingApplied must be false (turn-15 F3: ordering trust only behind coverage AND discrimination). Evaluable only on traces that carry an assessment (full coverage reached, post-BUILD-3d); the un-gated shadow assessment constrains nothing.",
  enforced: true,
  check(trace) {
    const d = trace.rerank?.degeneracy;
    if (!d) return { id: this.id, evaluable: false, violations: [] };
    const violations = d.gated && d.degenerate && trace.rerank!.orderingApplied
      ? [`degenerate score set (${d.reason}: max ${d.maxScore}, spread ${d.spread}) was applied to ordering with the gate armed`]
      : [];
    return { id: this.id, evaluable: true, violations };
  },
};

/** The registry, in audit order. */
export const HOOK_INVARIANTS: InvariantDef[] = [
  traceComplete,
  admissionHonored,
  singleRankingKey,
  massCap,
  rerankCoverageOrFallback,
  noExpansionLeakOnFailedRerank,
  degeneracyGateHonored,
  metadataBandOnly,
  finalizationFitsReserve,
];

export interface InvariantAudit {
  /** Violations of ENFORCED invariants — these fail the suite / run gate. */
  enforcedViolations: { id: string; violations: string[] }[];
  /** Violations of unenforced invariants — reported as observed defects. */
  observedViolations: { id: string; violations: string[] }[];
  /** Invariants that could not be evaluated on this trace. */
  notEvaluable: string[];
}

/** Run every registered invariant over one trace. */
export function auditTrace(trace: SurfacingTrace): InvariantAudit {
  const enforcedViolations: InvariantAudit["enforcedViolations"] = [];
  const observedViolations: InvariantAudit["observedViolations"] = [];
  const notEvaluable: string[] = [];
  for (const inv of HOOK_INVARIANTS) {
    const res = inv.check(trace);
    if (!res.evaluable) { notEvaluable.push(inv.id); continue; }
    if (res.violations.length === 0) continue;
    if (inv.enforced) enforcedViolations.push({ id: inv.id, violations: res.violations });
    else observedViolations.push({ id: inv.id, violations: res.violations });
  }
  return { enforcedViolations, observedViolations, notEvaluable };
}
