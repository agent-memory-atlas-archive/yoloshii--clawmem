/**
 * The ONLY module permitted to sample a platform clock.
 *
 * O1 (see O1-DESIGN-monotonic-deadlines.md). Every deadline in the surfacing
 * handler was an ABSOLUTE wall-clock instant compared against `Date.now()`, so
 * an NTP step moved every deadline at once and silently falsified the timing
 * evidence the trust gate scores. This module is the anchor of the fix.
 *
 * Two rules the static audit enforces, because the type system alone cannot:
 *
 *   1. `Date.now()` / `performance.now()` appear NOWHERE else. Wall-clock
 *      SEMANTICS remain available everywhere via `epochNow()`; what is banned
 *      is raw SAMPLING, not wall time.
 *   2. Scoped code uses the branded OPERATIONS below, never arithmetic on the
 *      branded values. A branded number is an intersection (`number & {...}`)
 *      and stays assignable to `number`, so `setTimeout(epochNow())` and
 *      `a - b` both type-check. The brands make the three kinds of quantity
 *      non-interchangeable; only the operations make the unsafe forms
 *      unreachable.
 */

// ─── Brands ─────────────────────────────────────────────────────────

declare const EPOCH_MS: unique symbol;
declare const MONO_INSTANT: unique symbol;
declare const DURATION_MS: unique symbol;
declare const MONO_DEADLINE: unique symbol;
declare const SIGNED_DELTA_MS: unique symbol;

/** Absolute wall-clock instant, `Date.now()` epoch ms. Calendar and diagnostics only. */
export type EpochMs = number & { readonly [EPOCH_MS]: true };

/** A `performance.now()` reading. Origin is PER-PROCESS: never send one over the wire. */
export type MonoInstant = number & { readonly [MONO_INSTANT]: true };

/** A span of time. NONNEGATIVE by construction — see `duration()`. */
export type DurationMs = number & { readonly [DURATION_MS]: true };

/** A monotonic instant by which work must finish. Compared only via `isExpired`/`remainingForTimeout`. */
export type MonoDeadline = number & { readonly [MONO_DEADLINE]: true };

/**
 * A signed quantity: `over_ms`, `clock_skew_ms`. May NEVER construct a deadline,
 * a duration or a timer. Feeds exactly one control predicate (the trust gate's
 * tolerance check) plus named serialization/diagnostic projection.
 */
export type SignedDeltaMs = number & { readonly [SIGNED_DELTA_MS]: true };

// ─── Sampling (the only platform-clock calls in the codebase) ────────

/** Wall-clock now. For calendar, persistence, diagnostics and the deferred provider-cooldown
 * policy (category E) — NEVER for budget or deadline control. */
export function epochNow(): EpochMs {
  return Date.now() as EpochMs;
}

/** Monotonic now. The control-flow clock: unaffected by NTP steps and slews. */
export function monoNow(): MonoInstant {
  return performance.now() as MonoInstant;
}

// ─── Calendar conversions (category D lives here) ────────────────────

/**
 * An `EpochMs` as a `Date`. The ONLY sanctioned way to hand an epoch to a
 * calendar API: `new Date(e)` outside this module erases the brand into a bare
 * `number` parameter, and the audit cannot tell that from `setTimeout(e)`.
 */
export function toDate(e: EpochMs): Date {
  return new Date(e);
}

/** The wall-clock now as an ISO-8601 string — the persistence/log-stamp form. */
export function isoNow(): string {
  return toDate(epochNow()).toISOString();
}

// ─── Construction ───────────────────────────────────────────────────

/**
 * Build a `DurationMs`. Negative input is a caller bug, not a representable
 * value: durations are nonnegative so that "subtract a reserve" cannot be
 * spelled as "add a negative duration".
 */
export function duration(ms: number): DurationMs {
  if (!Number.isFinite(ms) || ms < 0) {
    throw new RangeError(`DurationMs must be finite and >= 0, got ${ms}`);
  }
  return ms as DurationMs;
}

/** Build a `SignedDeltaMs`. Signed by contract; only finiteness is required. */
export function signedDelta(ms: number): SignedDeltaMs {
  if (!Number.isFinite(ms)) {
    throw new RangeError(`SignedDeltaMs must be finite, got ${ms}`);
  }
  return ms as SignedDeltaMs;
}

// ─── Deadline algebra ───────────────────────────────────────────────

/** A deadline `budget` after `instant`. */
export function deadlineAfter(instant: MonoInstant | MonoDeadline, budget: DurationMs): MonoDeadline {
  return (instant + budget) as MonoDeadline;
}

/**
 * A deadline `reserve` BEFORE `deadline` — the named form of subtracting a tail.
 * Passing a negative duration to `deadlineAfter` is unrepresentable, so this is
 * the only way to reserve.
 */
export function deadlineBefore(deadline: MonoDeadline, reserve: DurationMs): MonoDeadline {
  return (deadline - reserve) as MonoDeadline;
}

/** Has `deadline` passed? THE operation for deadline control flow. */
export function isExpired(deadline: MonoDeadline, now: MonoInstant = monoNow()): boolean {
  return now >= deadline;
}

/**
 * Remaining window, for TIMER and WIRE preparation.
 *
 * `null` IS the expired case (`remaining <= 0`). Under `strictNullChecks` a
 * caller cannot hand the union to a `DurationMs`-accepting timer without
 * handling `null`, so the negative-remainder class cannot be spelled — provided
 * the audit rejects assertions and `any`, which is what makes the two mechanisms
 * load-bearing together rather than separately.
 */
export function remainingForTimeout(
  deadline: MonoDeadline,
  now: MonoInstant = monoNow(),
): DurationMs | null {
  const left = deadline - now;
  return left > 0 ? (left as DurationMs) : null;
}

/** Time from `start` to `end`. Clamped at 0: a monotonic clock cannot run backwards. */
export function elapsed(start: MonoInstant, end: MonoInstant = monoNow()): DurationMs {
  const d = end - start;
  return (d > 0 ? d : 0) as DurationMs;
}

/**
 * How far past `deadline` the work actually finished. SIGNED: negative means
 * early. This is the `over_ms` evidence the trust gate scores — it is
 * deliberately not a `DurationMs`, so it can never construct a deadline.
 */
export function overshoot(deadline: MonoDeadline, finish: MonoInstant = monoNow()): SignedDeltaMs {
  return (finish - deadline) as SignedDeltaMs;
}

// ─── Timers ─────────────────────────────────────────────────────────

/**
 * An `AbortSignal` bounded by `deadline`, or `null` if it has already passed.
 * Callers take the `null` branch locally rather than dispatching work that a
 * transport would immediately abort.
 */
export function timeoutSignal(
  deadline: MonoDeadline,
  now: MonoInstant = monoNow(),
): AbortSignal | null {
  const left = remainingForTimeout(deadline, now);
  return left === null ? null : AbortSignal.timeout(left);
}

/** Sleep for a nonnegative duration. */
export function sleep(ms: DurationMs): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
