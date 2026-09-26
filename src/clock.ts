/**
 * The ONLY module permitted to sample a platform clock.
 *
 * O1 (see O1-DESIGN-monotonic-deadlines.md). Every deadline in the surfacing
 * handler was an ABSOLUTE wall-clock instant compared against `Date.now()`, so
 * an NTP step moved every deadline at once and silently falsified the timing
 * evidence the trust gate scores. This module is the anchor of the fix.
 *
 * Two rules the static audits enforce, because the type system alone cannot:
 *
 *   1. `Date.now()` / `performance.now()` appear NOWHERE else (`o1-clock-audit`).
 *      Wall-clock SEMANTICS remain available everywhere via `epochNow()`; what
 *      is banned is raw SAMPLING, not wall time.
 *   2. Scoped code uses the branded OPERATIONS below, never operators on the
 *      branded values (`o1-seam-audit` C4: arithmetic AND comparison on a brand
 *      outside this module is a finding, and so is a brand flowing into any
 *      sink typed without it — a `number` parameter, `any`, a JSON encoder).
 *      A branded number is an intersection (`number & {...}`) and stays
 *      assignable to `number`, so `setTimeout(epochNow())` and `a - b` both
 *      type-check. The brands make the kinds of quantity non-interchangeable;
 *      only the operations make the unsafe forms unreachable.
 *
 * Consequently EVERY exit from the branded world is a NAMED function here —
 * `evidenceMs` (measured spans and signed deltas into traces, reports and
 * logs — including each quantity of a `spanEvidence`, which stays branded until
 * its recording site projects it), `epochMs`
 * (calendar values into identifiers, JSON and SQL), `wireBudget` (a remaining
 * window onto the daemon wire), `toDate` / `isoNow` (calendar APIs) — so a
 * reviewer can grep every place a brand leaves the type system, and the
 * audit can prove there is no other.
 *
 * The algebra is CLOSED OVER FINITE VALUES (codex migration r1 S3): every
 * constructor validates its input, and every operation that computes a new
 * branded value validates its result (`finiteResult`), so an overflow such as
 * `scaled(duration(Number.MAX_VALUE), 2)` is a RangeError at the operation —
 * never a branded `Infinity` that a timer or the wire would later misread.
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
 * A signed quantity: `over_ms`, `clock_skew_ms`, an epoch delta. May NEVER
 * construct a deadline, a duration or a timer — no operation here accepts one
 * as such an input. It leaves the type system only through `evidenceMs`, the
 * named serialization / diagnostic projection (O1 §1, codex rev-10 F2 as
 * resolved at the evidence migration).
 */
export type SignedDeltaMs = number & { readonly [SIGNED_DELTA_MS]: true };

// ─── Test seam: wall-clock STEP injection (O1 §5 test matrix) ───────

/**
 * TEST-ONLY: a synthetic realtime STEP applied to `epochNow()` from a given
 * monotonic instant on. Injected either by `setWallJumpForTest` (in-process)
 * or by `CLAWMEM_TEST_WALL_JUMP="<atProcessUptimeMs>:<deltaMs>"` in a child
 * process's environment (the eval vector-daemon child). Monotonic readings are
 * never touched — that is the property under test: a wall jump, forward or
 * backward, must change NO control decision and NO monotonic evidence. A
 * no-op unless armed; production never sets it.
 */
interface WallJump { at: MonoInstant; deltaMs: number }
let wallJump: WallJump | null | undefined; // undefined = environment not yet consulted

function wallJumpFromEnv(): WallJump | null {
  const raw = process.env.CLAWMEM_TEST_WALL_JUMP;
  if (!raw) return null;
  const m = /^(-?\d+(?:\.\d+)?):(-?\d+(?:\.\d+)?)$/.exec(raw.trim());
  if (!m) return null;
  const at = Number(m[1]);
  const deltaMs = Number(m[2]);
  // A digit string can still overflow to Infinity (codex migration r2 #4): an unusable step is ignored, never armed.
  return Number.isFinite(at) && Number.isFinite(deltaMs) ? { at: at as MonoInstant, deltaMs } : null;
}

/** TEST-ONLY: arm (or clear with `null`) a wall-clock step from `at` on. */
export function setWallJumpForTest(jump: { at: MonoInstant; deltaMs: number } | null): void {
  if (jump !== null && !(Number.isFinite(jump.at) && Number.isFinite(jump.deltaMs))) {
    throw new RangeError(`a wall step must be finite, got at=${jump.at} deltaMs=${jump.deltaMs}`);
  }
  wallJump = jump;
}

/**
 * TEST-ONLY: `CLAWMEM_TEST_WALL_JUMP_AT_SCAN=<deltaMs>` steps the wall clock by
 * `deltaMs` at THIS instant, cumulatively (every call adds one more step). The
 * eval vector-daemon child calls it at the start of every scan, so the step
 * lands deterministically BETWEEN a request's receipt (where its advisory
 * deadline is anchored) and the daemon's check-after-scan, in a process whose
 * clock is independent of the client's — the child-process half of the O1 §5
 * matrix (codex migration r1 S4). A no-op unless set; production never sets it.
 */
export function testWallJumpAtScanStart(): void {
  const raw = process.env.CLAWMEM_TEST_WALL_JUMP_AT_SCAN;
  if (!raw) return;
  const step = Number(raw);
  if (!Number.isFinite(step)) return;
  if (wallJump === undefined) wallJump = wallJumpFromEnv();
  wallJump = { at: monoNow(), deltaMs: finiteResult<number>((wallJump?.deltaMs ?? 0) + step, "testWallJumpAtScanStart") };
}

// ─── Sampling (the only platform-clock calls in the codebase) ────────

/** Wall-clock now. For calendar, persistence, diagnostics and the deferred provider-cooldown
 * policy (category E) — NEVER for budget or deadline control. */
export function epochNow(): EpochMs {
  const raw = Date.now();
  if (wallJump === undefined) wallJump = wallJumpFromEnv();
  if (wallJump !== null && performance.now() >= wallJump.at) return finiteResult<EpochMs>(raw + wallJump.deltaMs, "epochNow (test wall step)");
  return raw as EpochMs;
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

/** A persisted / parsed epoch back into the type system. Validated: finite. */
export function epochAt(ms: number): EpochMs {
  if (!Number.isFinite(ms)) throw new RangeError(`EpochMs must be finite, got ${ms}`);
  return ms as EpochMs;
}

/** A `Date` (already held, e.g. parsed from a row) as an epoch. Validated: not an Invalid Date. */
export function epochOf(d: Date): EpochMs {
  return epochAt(d.getTime());
}

// ─── Closure over finite values (codex migration r1 S3) ─────────────

/** Every branded arithmetic RESULT passes through here: finite inputs can still overflow (a sum or
 * product past `Number.MAX_VALUE`, a difference of opposite-signed extremes), and an infinite
 * brand is never representable. */
function finiteResult<T extends number>(x: number, op: string): T {
  if (!Number.isFinite(x)) throw new RangeError(`${op} overflowed the finite range (got ${x})`);
  return x as T;
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
  return finiteResult<MonoDeadline>(instant + budget, "deadlineAfter");
}

/**
 * A deadline `reserve` BEFORE `deadline` — the named form of subtracting a tail.
 * Passing a negative duration to `deadlineAfter` is unrepresentable, so this is
 * the only way to reserve.
 */
export function deadlineBefore(deadline: MonoDeadline, reserve: DurationMs): MonoDeadline {
  return finiteResult<MonoDeadline>(deadline - reserve, "deadlineBefore");
}

/** The earlier of two deadlines — the named form of `Math.min` over deadlines. */
export function earliest(a: MonoDeadline, b: MonoDeadline): MonoDeadline {
  return (a <= b ? a : b) as MonoDeadline;
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
  const left = finiteResult<number>(deadline - now, "remainingForTimeout");
  return left > 0 ? (left as DurationMs) : null;
}

/** Time from `start` to `end`. Clamped at 0: a monotonic clock cannot run backwards. */
export function elapsed(start: MonoInstant, end: MonoInstant = monoNow()): DurationMs {
  const d = finiteResult<number>(end - start, "elapsed");
  return (d > 0 ? d : 0) as DurationMs;
}

/** The window `deadline` allotted to work started at `start` (clamped at 0) — a leg's `budget_ms` evidence. */
export function allotted(start: MonoInstant, deadline: MonoDeadline): DurationMs {
  const d = finiteResult<number>(deadline - start, "allotted");
  return (d > 0 ? d : 0) as DurationMs;
}

/**
 * How far past `deadline` the work actually finished. SIGNED: negative means
 * early. This is the `over_ms` evidence the trust gate scores — it is
 * deliberately not a `DurationMs`, so it can never construct a deadline.
 */
export function overshoot(deadline: MonoDeadline, finish: MonoInstant = monoNow()): SignedDeltaMs {
  return finiteResult<SignedDeltaMs>(finish - deadline, "overshoot");
}

// ─── Duration algebra ───────────────────────────────────────────────

/** The shorter of two durations — the named form of `Math.min` over durations. */
export function shorter(a: DurationMs, b: DurationMs): DurationMs {
  return (a <= b ? a : b) as DurationMs;
}

/** `a < b` over durations — the named comparison (a bare `<` on a brand is a C4 finding). */
export function shorterThan(a: DurationMs, b: DurationMs): boolean {
  return a < b;
}

/** `d × factor` for a finite nonnegative factor (pacing jitter, backoff growth). */
export function scaled(d: DurationMs, factor: number): DurationMs {
  if (!Number.isFinite(factor) || factor < 0) throw new RangeError(`scale factor must be finite and >= 0, got ${factor}`);
  return finiteResult<DurationMs>(d * factor, "scaled");
}

// ─── Epoch algebra (categories D and E — wall-clock SEMANTICS, sampled here) ──

/** The wall instant `d` after `e` (a cooldown end, a lease expiry, a dedup window). */
export function epochAfter(e: EpochMs, d: DurationMs): EpochMs {
  return finiteResult<EpochMs>(e + d, "epochAfter");
}

/** The wall instant `d` before `e` (a lookback cutoff). */
export function epochBefore(e: EpochMs, d: DurationMs): EpochMs {
  return finiteResult<EpochMs>(e - d, "epochBefore");
}

/** Has the wall clock reached `e`? Category-E control ONLY (never a budget). */
export function epochReached(e: EpochMs, now: EpochMs = epochNow()): boolean {
  return now >= e;
}

/** `later − earlier` on the wall clock. SIGNED: a realtime step can make it negative. */
export function epochDelta(later: EpochMs, earlier: EpochMs): SignedDeltaMs {
  return finiteResult<SignedDeltaMs>(later - earlier, "epochDelta");
}

/** How long until wall instant `e` (clamped at 0) — a server-dictated `Retry-After` date. */
export function untilEpoch(e: EpochMs, now: EpochMs = epochNow()): DurationMs {
  const d = finiteResult<number>(e - now, "untilEpoch");
  return (d > 0 ? d : 0) as DurationMs;
}

// ─── Spans (O1 §3 evidence contract) ────────────────────────────────

/** A start instant on BOTH clocks, so a leg can report its skew. Never serialized as-is. */
export interface Span { readonly mono: MonoInstant; readonly wall: EpochMs }

export function spanStart(): Span {
  return { mono: monoNow(), wall: epochNow() };
}

/**
 * A leg's span on BOTH clocks, still BRANDED (codex migration r1 S2): the authoritative monotonic
 * elapsed, the same span on the wall clock (signed — a realtime step can make it negative), and
 * their difference — a realtime STEP visible from the artifact. Nothing here is a number yet: the
 * recording site projects each quantity through `evidenceMs`, so every exit from the branded world
 * stays a named projection.
 */
export interface SpanEvidence { readonly mono: DurationMs; readonly wall: SignedDeltaMs; readonly skew: SignedDeltaMs }

/**
 * The span from `start` to `end`. Pass the leg's ONE terminal sample as `end` (and derive every other
 * finish-time quantity — `overshoot`, a timing — from that same sample) so the record is internally
 * consistent: `mono − allotted budget = overshoot` exactly whenever the leg started before its
 * deadline.
 */
export function spanEvidence(start: Span, end: Span = spanStart()): SpanEvidence {
  const mono = elapsed(start.mono, end.mono);
  const wall = epochDelta(end.wall, start.wall);
  return { mono, wall, skew: finiteResult<SignedDeltaMs>(wall - mono, "spanEvidence") };
}

// ─── Projections — the ONLY exits from the branded world ────────────

/**
 * A measured span or signed delta into a trace, report or log line — the serialization projection.
 * It never feeds the HOOK's deadline or budget control flow. Its values are EVIDENCE: the replay
 * harness scores them after the fact (a projected `over_ms` decides a run's timing verdict and
 * trust — hook-run's gate), which is the purpose of recording them, not control of the leg that
 * produced them.
 */
export function evidenceMs(x: DurationMs | SignedDeltaMs): number {
  return x;
}

/** A calendar value into an identifier, a JSON field or a SQL parameter. */
export function epochMs(e: EpochMs): number {
  return e;
}

/**
 * A remaining window as the daemon wire carries it: a whole millisecond count.
 * `null` = below one transmissible millisecond — the client takes its fallback
 * LOCALLY rather than dispatching a request the daemon must reject (O1 §2).
 * Distinct from expiry, which `remainingForTimeout` reports as `null` earlier.
 */
export function wireBudget(d: DurationMs): number | null {
  const n = Math.floor(d);
  return n >= 1 ? n : null;
}

// ─── Timers (direct timer construction is prohibited in scoped modules) ──

/**
 * The platform timer ceiling. A `setTimeout` delay above 2^31−1 ms does NOT wait: Bun (like Node)
 * clamps it to ~1 ms — probed on Bun 1.3.14 — so a far-future deadline would fire at once.
 * `deadlineTimer` (and `sleep`, through it) therefore arms hops of at most this length, re-deriving
 * the remainder from the monotonic deadline at every hop.
 */
const TIMER_MAX_MS = 2_147_483_647;

/** `AbortSignal.timeout` honors delays up to 2^53−1 ms and THROWS above it; a larger finite duration is clamped (≈ 285,000 years). */
const SIGNAL_MAX_MS = Number.MAX_SAFE_INTEGER;

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
  return left === null ? null : AbortSignal.timeout(Math.min(left, SIGNAL_MAX_MS));
}

/** An `AbortSignal` that fires after `d`. */
export function signalAfter(d: DurationMs): AbortSignal {
  return AbortSignal.timeout(Math.min(d, SIGNAL_MAX_MS));
}

/**
 * Run `onExpiry` once `deadline` has passed ON THE MONOTONIC CLOCK (on the next
 * macrotask if it already has). Returns the cancel function; cancel it when the
 * work it bounds wins, so a pending ref'd timer never keeps a hook process alive.
 *
 * The platform timer is only a wake-up: its delay is rounded to whole ms and it
 * can fire up to ~1 ms SHORT, and a delay past `TIMER_MAX_MS` fires at once. Each
 * wake-up re-checks the deadline and re-arms for the true remainder (a ceiling
 * hop included), so `onExpiry` never runs while `isExpired(deadline)` is false —
 * a caller that re-checks `isExpired` right after the timer can never find the
 * deadline still open and start work past it.
 */
export function deadlineTimer(deadline: MonoDeadline, onExpiry: () => void): () => void {
  const wakeAfter = (left: DurationMs | null): number => (left === null ? 0 : Math.min(Math.ceil(left), TIMER_MAX_MS));
  let t: ReturnType<typeof setTimeout>;
  const wake = (): void => {
    const left = remainingForTimeout(deadline);
    if (left === null) { onExpiry(); return; }
    t = setTimeout(wake, wakeAfter(left)); // an early platform fire, or a ceiling hop
  };
  t = setTimeout(wake, wakeAfter(remainingForTimeout(deadline)));
  return () => clearTimeout(t);
}

/**
 * `work`, or a rejection with `expired()` at `deadline` — the leg-race shape.
 * The timer is cleared whichever side settles first. The abandoned `work` is
 * NOT cancelled (it never was); transports are cut by their own signals.
 */
export function raceDeadline<T>(work: Promise<T>, deadline: MonoDeadline, expired: () => Error): Promise<T> {
  let cancel: () => void = () => {};
  const timeout = new Promise<never>((_, reject) => { cancel = deadlineTimer(deadline, () => reject(expired())); });
  return Promise.race([work, timeout]).finally(cancel);
}

/** `work` settled before `deadline`, or `{ timedOut: true }` at it — the bounded-wait shape (no rejection). */
export function untilDeadline<T>(work: Promise<T>, deadline: MonoDeadline): Promise<{ timedOut: false; value: T } | { timedOut: true }> {
  let cancel: () => void = () => {};
  const timeout = new Promise<{ timedOut: true }>((resolve) => { cancel = deadlineTimer(deadline, () => resolve({ timedOut: true })); });
  return Promise.race([work.then((value) => ({ timedOut: false as const, value })), timeout]).finally(cancel);
}

/** Sleep for a nonnegative duration — on a monotonic deadline, so a duration past the platform timer ceiling still waits in full. */
export function sleep(ms: DurationMs): Promise<void> {
  const until = deadlineAfter(monoNow(), ms);
  return new Promise((resolve) => { deadlineTimer(until, resolve); });
}
