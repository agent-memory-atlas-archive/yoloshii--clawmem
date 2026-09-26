/**
 * Type-level guard for the O1 clock brands. NOT a runtime test — it is compiled,
 * never executed.
 *
 * Every misuse below carries `@ts-expect-error`, which INVERTS the assertion:
 * if the line stops being a type error, tsc reports "Unused '@ts-expect-error'
 * directive" and this file fails to compile. So the file type-checks clean IF
 * AND ONLY IF every confusion listed here is genuinely rejected.
 *
 * This is the executable form of the design's central claim. It exists because
 * branded TYPES alone were measured to be insufficient — `setTimeout(brand)`,
 * `const n: number = brand` and cross-brand `a - b` all compile — so what the
 * brands actually buy has to be pinned down rather than asserted.
 *
 * Run: ./node_modules/.bin/tsc --noEmit --strict <this file>
 * Or:  bun test tests/unit/clock-types.test.ts
 */

import {
  allotted,
  deadlineAfter,
  deadlineBefore,
  deadlineTimer,
  duration,
  earliest,
  elapsed,
  epochAfter,
  epochAt,
  epochDelta,
  epochMs,
  epochNow,
  epochOf,
  epochReached,
  evidenceMs,
  isExpired,
  monoNow,
  overshoot,
  raceDeadline,
  remainingForTimeout,
  scaled,
  shorter,
  shorterThan,
  signalAfter,
  signedDelta,
  sleep,
  spanEvidence,
  spanStart,
  timeoutSignal,
  untilDeadline,
  untilEpoch,
  wireBudget,
} from "../../src/clock.ts";
import type { DurationMs, EpochMs, MonoDeadline, MonoInstant } from "../../src/clock.ts";

// ─── the three quantities are not interchangeable ───────────────────

// An epoch is not a monotonic instant (the ~8-orders-of-magnitude confusion).
// @ts-expect-error
const _a: MonoInstant = epochNow();

// A monotonic instant is not an epoch.
// @ts-expect-error
const _b: EpochMs = monoNow();

// A deadline is not a duration.
// @ts-expect-error
const _c: DurationMs = deadlineAfter(monoNow(), duration(1000));

// A duration is not a deadline.
// @ts-expect-error
const _d: MonoDeadline = duration(1000);

// ─── raw numbers cannot enter the algebra ───────────────────────────

// A bare number is not a budget — `duration()` is the only constructor.
// @ts-expect-error
deadlineAfter(monoNow(), 8000);

// ...nor a reserve.
// @ts-expect-error
deadlineBefore(deadlineAfter(monoNow(), duration(8000)), 1500);

// ...nor a deadline to test.
// @ts-expect-error
isExpired(12345);

// ...nor a sleep interval.
// @ts-expect-error
sleep(50);

// ─── signed deltas cannot construct time ────────────────────────────
// This is the rule that keeps `over_ms` / `clock_skew_ms` out of control flow.

// `overshoot` is signed, so it can never be a budget.
// @ts-expect-error
deadlineAfter(monoNow(), overshoot(deadlineAfter(monoNow(), duration(10))));

// ...nor a reserve.
// @ts-expect-error
deadlineBefore(deadlineAfter(monoNow(), duration(10)), signedDelta(-5));

// ...nor a sleep interval.
// @ts-expect-error
sleep(signedDelta(100));

// ...and it is not assignable to a duration.
// @ts-expect-error
const _e: DurationMs = signedDelta(42);

// ─── an instant is not a deadline ───────────────────────────────────

// `isExpired` takes the thing work must finish BY, not an arbitrary reading.
// @ts-expect-error
isExpired(monoNow());

// @ts-expect-error
remainingForTimeout(monoNow());

// ─── the null convention cannot be bypassed ─────────────────────────
// `remainingForTimeout` returns `DurationMs | null`; strictNullChecks makes the
// expired branch impossible to forget.

const _deadline = deadlineAfter(monoNow(), duration(1000));

// @ts-expect-error
sleep(remainingForTimeout(_deadline));

// The AbortSignal path has the same shape.
// @ts-expect-error
const _aborted: boolean = timeoutSignal(_deadline).aborted;

// ─── elapsed takes instants, not deadlines ──────────────────────────

// @ts-expect-error
elapsed(_deadline);

// ─── O1 step 2: the widened algebra keeps the kinds apart ───────────

// A deadline is chosen among deadlines: an epoch is not one.
// @ts-expect-error
earliest(epochNow(), _deadline);

// A duration is compared with a duration, never with a bare number.
// @ts-expect-error
shorterThan(duration(1), 5);

// The wire takes a remaining WINDOW, never a signed delta (over_ms can never become a budget).
// @ts-expect-error
wireBudget(signedDelta(100));

// Epoch arithmetic is epoch arithmetic: a monotonic instant cannot be shifted on the wall clock.
// @ts-expect-error
epochAfter(monoNow(), duration(1));

// ...and the wall clock cannot be reached for a monotonic deadline.
// @ts-expect-error
epochReached(_deadline);

// A monotonic instant is never evidence (its origin is per-process) and never a calendar value.
// @ts-expect-error
evidenceMs(monoNow());
// @ts-expect-error
epochMs(duration(5));

// A scaled duration is still a duration, not a deadline.
// @ts-expect-error
const _f: MonoDeadline = scaled(duration(10), 2);

// A timer is bounded by a deadline, never by an epoch.
// @ts-expect-error
deadlineTimer(epochNow(), () => {});

// ─── what MUST still compile ────────────────────────────────────────
// If any of these break, the algebra has become unusable rather than safe.

const start = monoNow();
const internal = deadlineAfter(start, duration(6000));
const work = deadlineBefore(internal, duration(1200));

if (!isExpired(work)) {
  const left = remainingForTimeout(work);
  if (left !== null) {
    void sleep(left);
    void timeoutSignal(work);
  }
}

void elapsed(start);
void overshoot(work);
void epochNow(); // wall-clock SEMANTICS remain available — raw SAMPLING is what is banned
void allotted(start, work);
void earliest(work, internal);
void shorter(duration(1), duration(2));
void scaled(duration(10), 0.5);
void epochReached(epochAfter(epochNow(), duration(60_000)));
void epochDelta(epochNow(), epochOf(new Date()));
void untilEpoch(epochAt(0));
void evidenceMs(overshoot(work));
void epochMs(epochNow());
void wireBudget(duration(5));
void spanEvidence(spanStart());
void deadlineTimer(work, () => {});
void raceDeadline(Promise.resolve(1), work, () => new Error("x"));
void untilDeadline(Promise.resolve(1), work);
void signalAfter(duration(1));

// Keep the unused bindings referenced so `noUnusedLocals` stays irrelevant here.
void _a; void _b; void _c; void _d; void _e; void _f; void _aborted;
