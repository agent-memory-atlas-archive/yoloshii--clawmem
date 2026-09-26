/**
 * LEGACY — the one O1 debt type. This file MUST DISAPPEAR BEFORE ACTIVATION.
 *
 * O1 (see O1-DESIGN-monotonic-deadlines.md §6 step 1). Every deadline seam in
 * the handler, store, daemon and LLM transport currently carries an ABSOLUTE
 * WALL-CLOCK EPOCH in a parameter NAMED like a duration (`deadlineMs`,
 * `deadlineAt`). The first inert commit brands those seams by the semantics
 * they ALREADY have — never by the semantics they will have after migration.
 * Branding an epoch seam as `DurationMs` in a commit that changes no runtime
 * behavior would let a new caller pass a genuine duration with no debt entry,
 * after which `Date.now() >= 5000` is always true and every request drops as
 * `expired`. Silent, total, and introduced by the "inert" commit.
 *
 * Rules (codex rev-11/rev-12, load-bearing):
 *
 *   - Keyed on a NON-EXPORTED `unique symbol`: opacity blocks ordinary
 *     structural construction, and ONLY that. Assertions, `any`, and external
 *     declarations are stopped by the seam audit, not by this type. The type
 *     does not carry credit it cannot hold.
 *   - Constructing one is ALWAYS debt, with no exception for a validated JSON
 *     decoder. Every construction is an erased assertion carrying a unique
 *     `O1-DEBT-NNNN` marker with exactly one ratchet entry (bijection). The
 *     vector wire's decoder is itself such a site: if it could construct this
 *     brand debt-free, the ratchet could reach zero while the legacy
 *     absolute-deadline ingress was still live, and activation would certify
 *     the exact state it exists to forbid.
 *   - It stays assignable to `number` (an intersection), so the existing
 *     `Date.now() >= deadlineMs` comparisons inside the legacy paths compile
 *     unchanged. That arithmetic is not new debt — the raw-clock ratchet
 *     already holds it — and it disappears with the seam when the seam
 *     migrates to `MonoDeadline`.
 *   - Zero-debt activation needs no compatibility window: after activation an
 *     old client's `deadlineMs` is detected by FIELD PRESENCE and rejected as
 *     version skew without constructing this brand at all.
 *
 * This module has no runtime content. Import it with `import type` only.
 */

declare const LEGACY_WALL_DEADLINE: unique symbol;

/**
 * An absolute wall-clock deadline (`Date.now()` epoch ms) at a seam that has
 * not yet migrated to `MonoDeadline`. A caller can obtain one only through a
 * debt-marked assertion — there is no constructor, by design.
 */
export type LegacyWallDeadline = number & { readonly [LEGACY_WALL_DEADLINE]: true };
