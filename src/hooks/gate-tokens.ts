/**
 * Shared gate tokenizer (codex #28 t86): the ONE implementation of the
 * per-candidate relevance-gate token derivation, used by BOTH
 * `passesCurrentQueryGate` (surfacing-fusion, body-carrying candidates) and
 * the daemon's projection scan (store.projectVecResults) — so a projected
 * candidate's precomputed `gateTokens` are derived by exactly the code the
 * body path runs, never a fork.
 *
 * Zero imports on purpose — importable from store, fusion, and the daemon
 * without cycles.
 */

/**
 * Tokens of `${title} ${body.slice(0, gateTextLen)}`.toLowerCase(), split on
 * non-letter/digit runs, length > 1 — DEDUPED. Dedup is sound because the
 * gate is an existential prefix match (set semantics): repeated tokens add
 * nothing (t86 ruling).
 */
export function docGateTokens(title: string | undefined, body: string | undefined, gateTextLen: number): string[] {
  const docText = `${title ?? ""} ${(body ?? "").slice(0, gateTextLen)}`.toLowerCase();
  const seen = new Set<string>();
  for (const t of docText.split(/[^\p{L}\p{N}]+/u)) {
    if (t.length > 1) seen.add(t);
  }
  return [...seen];
}

/**
 * The gate predicate itself: does any doc token prefix-match any gate token?
 * Shared so the projected branch and the body branch judge identically.
 */
export function anyPrefixMatch(docTokens: readonly string[], gateTokens: ReadonlySet<string>): boolean {
  for (const dt of docTokens) {
    for (const qt of gateTokens) {
      if (dt.startsWith(qt)) return true;
    }
  }
  return false;
}
