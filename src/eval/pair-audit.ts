/**
 * Paired-run validity audit (codex turn-19 finding 1; completed per turn-20
 * finding 1): a frozen-draw pair is evidence ONLY when every pre-treatment
 * surface matches per case — the freeze leak audit catches EXTRA llm_cache
 * consumption but not REDUCED consumption (a timing dropout consumes fewer
 * frozen rows and passes), so an arm that skipped expansion or lost vector
 * candidates can silently report trust PASS while ranking different inputs.
 *
 * Compared per case — the COMPLETE pre-treatment envelope (turn-20: a
 * projection that omitted raw candidates, the fusion envelope, and run
 * identity admitted false-valid pairs):
 *   - profileName, retrievalQuery, sessionTopic, isRecencyIntent, priorLeg
 *   - expansion state (attempted/failed/variants)
 *   - RAW retrieval candidates in full (leg, variantQuery, filepath,
 *     source, rawScore, rank, pooled) — rawScore feeds composite admission
 *     even when RRF membership and contribution are identical
 *   - the ENTIRE fusion envelope (lanes; per-candidate membership incl.
 *     laneContributions, currentSupported, currentQueryGatePassed, admitted;
 *     gateTokenSource; masses/caps/slots) — gate status determines the w=0
 *     guard's behavior
 *   - rerank: every field EXCEPT treatment-derived orderingApplied and
 *     degeneracy (BUILD-3d — the assessment is a pure function of the
 *     compared `scores`, so comparing it adds nothing, and its `gated` flag
 *     is the treatment's own state, which legitimately differs across a
 *     gate-on/gate-off pair)
 * Treatment-downstream surfaces are deliberately NOT compared: rankingKey,
 * finalOrder, composite, admission, injection, diversification, and the
 * filter lists (a guard-dropped doc never reaches the noise filter, so
 * filter contents legitimately differ under the weight). EXCEPTION (BUILD-4
 * turn-54/55, codex turn-53 finding 3 + turn-54 finding 3): for an
 * ADMISSION-ONLY experiment (admission_policy registered WITHOUT any
 * rerank-lane treatment) the ADMISSION-INPUT LEDGER (`admissionInput`,
 * recorded immediately BEFORE the policy branch — arm-symmetric by
 * construction) IS compared in full: entries carry the complete
 * per-candidate policy input of both arms ({band, mass} for the relevance
 * policy, compositeScore for the composite control — deterministic across
 * arms under the frozen evaluation clock, identity.eval_now), so two arms
 * pair only when the policies judged the SAME inputs, not merely the same
 * identities. A registration that combines admission_policy with a
 * rerank-lane treatment SKIPS the ledger comparison: the upstream treatment
 * legitimately changes the failure guard and therefore the admission input —
 * differing ledgers are part of the declared combined treatment, and the
 * combined design is already explicitly confounded by registration. A
 * malformed ledger (wrong shape, non-finite numbers, duplicate keys) is a
 * DIVERGENCE, never coerced — corrupt artifacts must refuse, not pair.
 *
 * Run identity: the audit additionally reads both runs' hook-run.json and
 * requires identity equality EXCEPT the DECLARED treatments —
 * ranking_policy.rerank_lane_weight and (BUILD-3d)
 * ranking_policy.degeneracy_gate — trace equality proves nothing if gold,
 * corpus, topology, frozen draw, or policy revisions differed. Both
 * treatments' values are surfaced in the verdict so a two-factor difference
 * is visible to the analyst, never silent.
 *
 * BUILD-3 wires this into the acceptance gate (reject + replace mismatched
 * cases until the pre-registered valid-replicate count is reached); at
 * BUILD-2 it runs post-hoc over recorded runs:
 *   bun src/eval/pair-audit.ts <runA-dir> <runB-dir>
 */
import { readFileSync } from "fs";
import { join } from "path";
import { validateIdentityShape, PAIR_TREATMENTS, type PairTreatment } from "./run-identity.ts";

interface TraceLine { id: string; trace: Record<string, any> }

export interface PairCaseVerdict {
  id: string;
  valid: boolean;
  divergences: string[];
}

export interface PairIdentityVerdict {
  comparable: boolean;
  /** ranking_policy.rerank_lane_weight seen on each side (a declared treatment). */
  weights: [unknown, unknown];
  /** ranking_policy.degeneracy_gate seen on each side (a declared treatment — BUILD-3d). */
  gates: [unknown, unknown];
  /** Dotted identity paths that differ OUTSIDE the declared treatments. */
  mismatches: string[];
}

export interface PairAuditResult {
  identity: PairIdentityVerdict;
  verdicts: PairCaseVerdict[];
  validIds: string[];
  invalidIds: string[];
}

/** Collect dotted paths where two JSON values differ. */
function deepDiff(a: unknown, b: unknown, path: string, out: string[]): void {
  if (JSON.stringify(a) === JSON.stringify(b)) return;
  if (a && b && typeof a === "object" && typeof b === "object" && !Array.isArray(a) && !Array.isArray(b)) {
    for (const k of new Set([...Object.keys(a as object), ...Object.keys(b as object)])) {
      deepDiff((a as any)[k], (b as any)[k], path ? `${path}.${k}` : k, out);
    }
    return;
  }
  out.push(path || "<root>");
}

const sortByJson = <T,>(xs: T[]): T[] => [...xs].sort((x, y) => {
  const sx = JSON.stringify(x); const sy = JSON.stringify(y);
  return sx < sy ? -1 : sx > sy ? 1 : 0;
});

/** Project the pre-treatment surfaces of a trace into canonical form. */
function preTreatment(t: Record<string, any>): Record<string, unknown> {
  const fusion = t.fusion as Record<string, any> | null | undefined;
  const rerank = t.rerank as Record<string, any> | null | undefined;
  return {
    profileName: t.profileName ?? null,
    retrievalQuery: t.retrievalQuery ?? null,
    sessionTopic: t.sessionTopic ?? null,
    isRecencyIntent: t.isRecencyIntent ?? null,
    priorLeg: t.priorLeg ?? null,
    expansion: t.expansion
      ? { attempted: t.expansion.attempted, failed: t.expansion.failed, variants: t.expansion.variants }
      : null,
    candidates: Array.isArray(t.candidates)
      ? sortByJson((t.candidates as any[]).map(c => ({
          leg: c.leg, variantQuery: c.variantQuery ?? null, filepath: c.filepath, displayPath: c.displayPath,
          source: c.source, rawScore: c.rawScore, rank: c.rank, pooled: c.pooled,
        })))
      : null,
    fusion: fusion
      ? {
          lanes: fusion.lanes,
          candidates: [...(fusion.candidates ?? [])]
            .sort((x: any, y: any) => (x.filepath < y.filepath ? -1 : x.filepath > y.filepath ? 1 : 0)),
          gateTokenSource: fusion.gateTokenSource ?? null,
          currentMass: fusion.currentMass ?? null,
          discountedMass: fusion.discountedMass ?? null,
          preCapDiscountedMass: fusion.preCapDiscountedMass ?? null,
          capApplied: fusion.capApplied ?? null,
          capFactor: fusion.capFactor ?? null,
          poolBound: fusion.poolBound ?? null,
          protectedSlots: fusion.protectedSlots ?? null,
          admittedCurrentSupported: fusion.admittedCurrentSupported ?? null,
        }
      : null,
    rerank: rerank
      ? {
          attempted: rerank.attempted,
          failed: rerank.failed,
          coverageComplete: rerank.coverageComplete ?? null,
          sentPaths: rerank.sentPaths ?? null,
          // BUILD-3b: the same paths can carry DIFFERENT TEXT across arms (the
          // stale-content hazard at pair scope) — identical sentPaths prove
          // nothing about what the reranker actually read. Compared in
          // transmission order, aligned with sentPaths. Null on pre-BUILD-3b
          // traces, which compare equal to each other and differ from a
          // recorded list — a cross-era pair is not a pair.
          sentTextHashes: rerank.sentTextHashes ?? null,
          coveredPaths: [...(rerank.coveredPaths ?? [])].sort(),
          scores: [...(rerank.scores ?? [])]
            .sort((x: any, y: any) => (x.filepath < y.filepath ? -1 : x.filepath > y.filepath ? 1 : 0)),
        }
      : null,
  };
}

const DIMENSIONS = ["profileName", "retrievalQuery", "sessionTopic", "isRecencyIntent", "priorLeg", "expansion", "candidates", "fusion", "rerank"] as const;

/** Human-bounded detail for one diverging dimension. */
function describeDivergence(dim: string, a: unknown, b: unknown): string {
  const membershipSummary = (label: string, xa: any[], xb: any[], key: (c: any) => string): string => {
    const pa = new Map(xa.map(c => [key(c), c]));
    const pb = new Map(xb.map(c => [key(c), c]));
    const onlyA = [...pa.keys()].filter(k => !pb.has(k));
    const onlyB = [...pb.keys()].filter(k => !pa.has(k));
    const changed = [...pa.keys()].filter(k => pb.has(k) && JSON.stringify(pa.get(k)) !== JSON.stringify(pb.get(k)));
    return `${label}: ${onlyA.length} only-A, ${onlyB.length} only-B, ${changed.length} changed (A=${xa.length}, B=${xb.length})`
      + (onlyA.length ? `; only-A e.g. ${onlyA.slice(0, 3).join(", ")}` : "")
      + (onlyB.length ? `; only-B e.g. ${onlyB.slice(0, 3).join(", ")}` : "")
      + (changed.length ? `; changed e.g. ${changed.slice(0, 3).join(", ")}` : "");
  };
  if (dim === "candidates" && Array.isArray(a) && Array.isArray(b)) {
    return membershipSummary("candidates", a as any[], b as any[], c => `${c.leg}|${c.variantQuery ?? ""}|${c.filepath}|${c.rank}`);
  }
  if (dim === "fusion" && a && b && typeof a === "object" && typeof b === "object") {
    const fa = a as any; const fb = b as any;
    const parts: string[] = [];
    if (JSON.stringify(fa.candidates) !== JSON.stringify(fb.candidates)) {
      parts.push(membershipSummary("fusion.candidates", fa.candidates ?? [], fb.candidates ?? [], (c: any) => c.filepath));
    }
    const fieldDiffs: string[] = [];
    deepDiff({ ...fa, candidates: null }, { ...fb, candidates: null }, "fusion", fieldDiffs);
    if (fieldDiffs.length) parts.push(`fields: ${fieldDiffs.slice(0, 6).join(", ")}`);
    return parts.join("; ") || "fusion: differs";
  }
  if (dim === "rerank" && a && b && typeof a === "object" && typeof b === "object") {
    const ra = a as any; const rb = b as any;
    if (Array.isArray(ra.sentPaths) && Array.isArray(rb.sentPaths) && JSON.stringify(ra.sentPaths) !== JSON.stringify(rb.sentPaths)) {
      const ax = ra.sentPaths as string[]; const bx = rb.sentPaths as string[];
      let i = 0; while (i < Math.min(ax.length, bx.length) && ax[i] === bx[i]) i++;
      return `rerank.sentPaths: lengths ${ax.length}/${bx.length}, first divergence at [${i}] (A=${ax[i] ?? "<end>"}, B=${bx[i] ?? "<end>"})`;
    }
    const diffs: string[] = [];
    deepDiff(ra, rb, "rerank", diffs);
    return `rerank: ${diffs.slice(0, 6).join(", ")}`;
  }
  const diffs: string[] = [];
  deepDiff(a, b, dim, diffs);
  if (diffs.length && !(diffs.length === 1 && diffs[0] === dim)) return `${dim}: ${diffs.slice(0, 8).join(", ")}`;
  // Root-level difference (e.g. null vs object): show both values instead.
  const short = (v: unknown): string => { const s = JSON.stringify(v) ?? "null"; return s.length > 160 ? s.slice(0, 160) + "…" : s; };
  return `${dim}: A=${short(a)} B=${short(b)}`;
}

/** Compare one case's pre-treatment surfaces across two arms. */
export function comparePairedCase(
  id: string,
  a: Record<string, any>,
  b: Record<string, any>,
  treatments?: readonly PairTreatment[],
): PairCaseVerdict {
  const pa = preTreatment(a);
  const pb = preTreatment(b);
  const divergences: string[] = [];
  for (const dim of DIMENSIONS) {
    if (JSON.stringify(pa[dim]) !== JSON.stringify(pb[dim])) {
      divergences.push(describeDivergence(dim, pa[dim], pb[dim]));
    }
  }
  // BUILD-4 turn-54/55 (codex turn-53 finding 3 + turn-54 finding 3): the
  // admission-input ledger is part of the pre-treatment envelope for
  // ADMISSION-ONLY experiments — see the header comment for the conditional
  // rule and the combined-registration exemption. Semantics:
  //  - key ABSENT on either trace → pre-turn-54 recording; the pair cannot
  //    prove the same inputs reached the policy → fail closed.
  //  - MALFORMED ledger (not null / not {candidates: entries}, an entry
  //    missing key/band/mass/compositeScore, non-finite numbers, duplicate
  //    keys) → fail closed — corrupt artifacts refuse, never coerce.
  //  - null on BOTH → neither arm reached the admission step (gate/empty
  //    return) — symmetric evidence, a valid pair (exposure will be false).
  //  - null vs entries, or differing entries → not a pair.
  const admissionOnly = treatments?.includes("admission_policy")
    && !treatments.includes("rerank_lane_weight")
    && !treatments.includes("degeneracy_gate");
  if (admissionOnly) {
    type LedgerEntry = { key: string; band: 0 | 1; mass: number; compositeScore: number };
    // Structural validation (codex turn-54 finding 2 — a coercing reader
    // fails OPEN): returns the canonical entry list, null for a legitimate
    // never-reached-admission record, or "malformed".
    const canon = (t: Record<string, any>): LedgerEntry[] | null | "malformed" => {
      const ai = t.admissionInput;
      if (ai === null) return null;
      if (!ai || typeof ai !== "object" || Array.isArray(ai)) return "malformed";
      const c = (ai as Record<string, unknown>).candidates;
      if (!Array.isArray(c)) return "malformed";
      const entries: LedgerEntry[] = [];
      for (const e of c) {
        if (!e || typeof e !== "object" || Array.isArray(e)) return "malformed";
        const { key, band, mass, compositeScore } = e as Record<string, unknown>;
        if (typeof key !== "string" || key.length === 0) return "malformed";
        if (band !== 0 && band !== 1) return "malformed";
        if (typeof mass !== "number" || !Number.isFinite(mass)) return "malformed";
        if (typeof compositeScore !== "number" || !Number.isFinite(compositeScore)) return "malformed";
        entries.push({ key, band, mass, compositeScore });
      }
      if (new Set(entries.map(e => e.key)).size !== entries.length) return "malformed";
      return entries.sort((x, y) => (x.key < y.key ? -1 : x.key > y.key ? 1 : 0));
    };
    if (!("admissionInput" in a) || !("admissionInput" in b)) {
      const where = !("admissionInput" in a) && !("admissionInput" in b) ? "both arms" : !("admissionInput" in a) ? "A" : "B";
      divergences.push(`admissionInput: ledger UNRECORDED on ${where} — an admission_policy pair requires the admission-input ledger recorded before the policy branch (pre-turn-54 traces cannot be paired for this treatment)`);
    } else {
      const la = canon(a);
      const lb = canon(b);
      if (la === "malformed" || lb === "malformed") {
        const where = la === "malformed" && lb === "malformed" ? "both arms" : la === "malformed" ? "A" : "B";
        divergences.push(`admissionInput: MALFORMED ledger on ${where} — expected null or {candidates: [{key, band, mass, compositeScore}]} with unique keys and finite numbers; a corrupt artifact refuses, never pairs`);
      } else if (JSON.stringify(la) !== JSON.stringify(lb)) {
        if (la === null || lb === null) {
          divergences.push(`admissionInput: ${la === null ? "A" : "B"} never reached admission while ${la === null ? "B" : "A"} recorded ${(la ?? lb)!.length} candidate(s) — the arms did not judge the same input`);
        } else {
          const ka = new Map(la.map(e => [e.key, e]));
          const kb = new Map(lb.map(e => [e.key, e]));
          const onlyA = [...ka.keys()].filter(k => !kb.has(k));
          const onlyB = [...kb.keys()].filter(k => !ka.has(k));
          const changed = [...ka.keys()].filter(k => kb.has(k) && JSON.stringify(ka.get(k)) !== JSON.stringify(kb.get(k)));
          divergences.push(`admissionInput: ledgers differ (A=${la.length}, B=${lb.length})`
            + (onlyA.length ? `; only-A e.g. ${onlyA.slice(0, 3).join(", ")}` : "")
            + (onlyB.length ? `; only-B e.g. ${onlyB.slice(0, 3).join(", ")}` : "")
            + (changed.length ? `; changed policy inputs e.g. ${changed.slice(0, 3).join(", ")}` : ""));
        }
      }
    }
  }
  return { id, valid: divergences.length === 0, divergences };
}

/**
 * Compare two run identities, allowing ONLY declared treatments —
 * ranking_policy.rerank_lane_weight and (BUILD-3d)
 * ranking_policy.degeneracy_gate — to differ. WITHOUT a registration, equal
 * values are always fine (a same-arm replicate audit is a legitimate use);
 * WITH a registration, every registered variable must actually DIFFER
 * (codex turn-41 finding 3 — a no-op treatment is not an experiment). Both
 * treatments' values are returned in the verdict.
 *
 * REGISTRATION (codex turn-40 finding 2 + ruling): when `registered` is
 * given, exactly that set may differ — a difference in an UNREGISTERED
 * treatment refuses comparison (an accidental policy delta is not the
 * registered experiment; an empty registration demands policy-identical
 * arms). When `registered` is ABSENT (post-hoc inspection), a SINGLE
 * treatment difference is tolerated and reported, but TWO differing
 * treatments refuse — a two-factor pair is confounded, and visibility alone
 * does not prevent confounded causal claims; register the multi-factor
 * experiment explicitly to compare it.
 *
 * FAIL-CLOSED (codex turn-21): each identity must pass the SHARED run-
 * identity validator (validateIdentityShape — the same shape check the
 * baseline parser enforces, which also proves the weight is a finite
 * non-negative number when the block is present) AND must carry a
 * ranking_policy block. The validator treats ranking_policy as optional
 * (legacy pre-turn-18 reports are valid reports); the pair audit cannot —
 * an unidentified treatment makes "equal except the treatment" meaningless.
 */
export function compareIdentities(
  a: Record<string, any> | null,
  b: Record<string, any> | null,
  registered?: readonly PairTreatment[],
): PairIdentityVerdict {
  const weights: [unknown, unknown] = [a?.ranking_policy?.rerank_lane_weight, b?.ranking_policy?.rerank_lane_weight];
  const gates: [unknown, unknown] = [a?.ranking_policy?.degeneracy_gate, b?.ranking_policy?.degeneracy_gate];
  const mismatches: string[] = [];
  for (const [side, id] of [["A", a], ["B", b]] as const) {
    if (!id) {
      mismatches.push(`identity missing on ${side} — hook-run.json absent or identity-less`);
      continue;
    }
    try {
      validateIdentityShape(id, (msg: string): never => { throw new Error(msg); });
    } catch (e) {
      mismatches.push(`identity on ${side} invalid: ${(e as Error).message}`);
      continue;
    }
    if ((id as Record<string, unknown>).ranking_policy === undefined) {
      mismatches.push(`identity on ${side} has no ranking_policy — the treatment is unidentified (legacy pre-turn-18 report); re-run or re-stamp before pairing`);
    }
    // BUILD-4 turn-57 (codex t56 F2 / CR-5): the evaluation clock is identity
    // HERE too — deep equality would compare two ABSENT clocks as equal,
    // while absence means the clock the run computed its composite policy
    // inputs on is unidentifiable (turn-55+ code records wall clock
    // explicitly as null). Fail closed on either side.
    // Codex t76: the vector execution protocol is identity HERE too — two
    // ABSENT protocols would deep-compare as equal while absence means the
    // execution the vector legs ran under is unidentifiable (t76+ code
    // records it unconditionally). Fail closed on either side.
    if ((id as Record<string, unknown>).vector_exec === undefined) {
      mismatches.push(`identity on ${side} has no vector_exec — the vector execution protocol its legs ran under (daemon-required vs in-process) is unidentifiable (t76+ code records it unconditionally); re-run before pairing`);
    } else {
      // Codex t84 CR-5: the RESPONSE protocol is identity too — a pre-t84 daemon-required
      // report measured the raw-hit execution (synchronous client-side hydrate) and can never
      // pair with a hydrated-v1 rerun. Absence fails closed on either side.
      const ve = (id as Record<string, unknown>).vector_exec as Record<string, unknown>;
      // t89 P2: absence fails closed under EVERY protocol (in-process included) — two
      // absent/absent sides would deep-compare as equal while the executions they
      // measured are unidentifiable relative to t84+ semantics.
      if (ve && typeof ve === "object" && ve.response_protocol === undefined) {
        mismatches.push(`identity on ${side} records no vector_exec.response_protocol (protocol ${String(ve.protocol)}) — a pre-t84 report measured the raw-hit/client-hydration execution, a DIFFERENT contract from t84+ runs; re-run before pairing`);
      }
    }
    if ((id as Record<string, unknown>).eval_now === undefined) {
      mismatches.push(`identity on ${side} has no eval_now — the evaluation clock its composite policy inputs were computed on is unidentifiable (turn-55+ code records wall clock explicitly as null); re-run or re-stamp before pairing`);
    }
  }
  if (mismatches.length > 0) return { comparable: false, weights, gates, mismatches };
  const diffs: string[] = [];
  deepDiff(a, b, "", diffs);
  const treatmentPath = (t: PairTreatment): string => `ranking_policy.${t}`;
  const differing = PAIR_TREATMENTS.filter(t => diffs.includes(treatmentPath(t)));
  const rest = diffs.filter(p => !PAIR_TREATMENTS.some(t => treatmentPath(t) === p));
  if (registered !== undefined) {
    const unregistered = differing.filter(t => !registered.includes(t));
    for (const t of unregistered) {
      rest.push(`${treatmentPath(t)} differs but is NOT a registered treatment of this experiment (registered: ${registered.length ? registered.join(", ") : "none — arms must be policy-identical"}) — an unregistered policy delta is not the registered experiment`);
    }
    // A registered treatment must actually DIFFER (codex turn-41 finding 3):
    // a registration whose variable is equal on both arms would let the
    // artifact claim an experiment whose treatment never varied — a no-op
    // experiment is not the registered experiment. An empty registration
    // remains the same-arm replicate mode.
    for (const t of registered) {
      if (!differing.includes(t as PairTreatment)) {
        rest.push(`registered treatment ${treatmentPath(t)} does NOT differ between the arms — a no-op treatment is not an experiment; drop the registration for a replicate audit, or fix the arm configuration`);
      }
    }
  } else if (differing.length >= 2) {
    rest.push(`${differing.map(treatmentPath).join(" AND ")} BOTH differ — a two-factor pair is confounded; explicitly register a multi-factor experiment to compare it`);
  }
  return { comparable: rest.length === 0, weights, gates, mismatches: rest };
}

/** Read a run directory's traces.jsonl as a case-id → trace map. Exported for the in-run pair gate (BUILD-3c). THROWS on a missing/unreadable file — a partner without traces is not auditable. */
export function readRunTraces(dir: string): Map<string, Record<string, any>> {
  const out = new Map<string, Record<string, any>>();
  const raw = readFileSync(join(dir, "traces.jsonl"), "utf-8");
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    const e = JSON.parse(line) as TraceLine;
    out.set(e.id, e.trace);
  }
  return out;
}

/** Read a run directory's hook-run.json header (run_id + identity). Exported for the in-run pair gate (BUILD-3c). Nulls on a missing/unreadable report — compareIdentities fails closed on a null identity. */
export function readRunHeader(dir: string): { run_id: string | null; identity: Record<string, any> | null } {
  try {
    const r = JSON.parse(readFileSync(join(dir, "hook-run.json"), "utf-8")) as Record<string, any>;
    return { run_id: typeof r.run_id === "string" ? r.run_id : null, identity: (r.identity as Record<string, any>) ?? null };
  } catch {
    return { run_id: null, identity: null };
  }
}

/** Audit two run directories (traces.jsonl + hook-run.json each), paired by case id. */
export function auditPairedRuns(dirA: string, dirB: string): PairAuditResult {
  const ha = readRunHeader(dirA);
  const hb = readRunHeader(dirB);
  const identity = compareIdentities(ha.identity, hb.identity);
  // Post-hoc CLI has no registration input: the per-case comparison honors
  // the treatment(s) the two identities ACTUALLY differ on, so a pair whose
  // identities differ on ranking_policy.admission_policy gets the
  // conditional admission-input ledger comparison (turn-54).
  const differingTreatments = PAIR_TREATMENTS.filter(t =>
    JSON.stringify((ha.identity?.ranking_policy as Record<string, unknown> | undefined)?.[t])
      !== JSON.stringify((hb.identity?.ranking_policy as Record<string, unknown> | undefined)?.[t]));
  const readTraces = readRunTraces;
  const ta = readTraces(dirA);
  const tb = readTraces(dirB);
  const ids = [...new Set([...ta.keys(), ...tb.keys()])].sort();
  const verdicts: PairCaseVerdict[] = [];
  for (const id of ids) {
    const a = ta.get(id);
    const b = tb.get(id);
    if (!a || !b) {
      verdicts.push({ id, valid: false, divergences: [`case present in ${a ? "A only" : "B only"}`] });
      continue;
    }
    verdicts.push(comparePairedCase(id, a, b, differingTreatments));
  }
  return {
    identity,
    verdicts,
    validIds: verdicts.filter(v => v.valid).map(v => v.id),
    invalidIds: verdicts.filter(v => !v.valid).map(v => v.id),
  };
}

if (import.meta.main) {
  const [dirA, dirB] = process.argv.slice(2);
  if (!dirA || !dirB) {
    console.error("usage: bun src/eval/pair-audit.ts <runA-dir> <runB-dir>   (each containing traces.jsonl + hook-run.json)");
    process.exit(2);
  }
  const res = auditPairedRuns(dirA, dirB);
  if (res.identity.comparable) {
    console.log(`IDENTITY comparable — rerank_lane_weight A=${JSON.stringify(res.identity.weights[0])} B=${JSON.stringify(res.identity.weights[1])}, degeneracy_gate A=${JSON.stringify(res.identity.gates[0])} B=${JSON.stringify(res.identity.gates[1])} (the declared treatments); all other identity fields equal`);
  } else {
    console.log(`IDENTITY NOT COMPARABLE — mismatches outside the declared treatments:`);
    for (const m of res.identity.mismatches) console.log(`        - ${m}`);
  }
  for (const v of res.verdicts) {
    if (v.valid) console.log(`VALID   ${v.id}`);
    else {
      console.log(`INVALID ${v.id}`);
      for (const d of v.divergences) console.log(`        - ${d}`);
    }
  }
  console.log(`\n${res.validIds.length} valid / ${res.invalidIds.length} invalid pair-case(s)${res.identity.comparable ? "" : " — IDENTITY NOT COMPARABLE: case verdicts prove nothing across these runs"}`);
  process.exit(res.invalidIds.length > 0 || !res.identity.comparable ? 1 : 0);
}
