import { describe, it, expect, afterEach } from "bun:test";

import {
  deadlineAfter,
  deadlineBefore,
  duration,
  elapsed,
  epochNow,
  isExpired,
  monoNow,
  overshoot,
  remainingForTimeout,
  signedDelta,
  sleep,
  timeoutSignal,
  type MonoInstant,
} from "../../src/clock.ts";

// A fixed synthetic origin. Every test drives `now` explicitly so nothing here
// depends on real elapsed time — the point of the module is that control flow
// stops depending on a clock nobody controls.
const T0 = 1000 as MonoInstant;
const at = (ms: number) => (T0 + ms) as MonoInstant;

// ─── sampling ───────────────────────────────────────────────────────

describe("sampling", () => {
  it("epochNow returns a wall-clock instant in epoch range", () => {
    // Sanity: an epoch is ~1.8e12 today. A monotonic reading is ~1e4.
    expect(epochNow()).toBeGreaterThan(1_600_000_000_000);
  });

  it("monoNow advances monotonically", async () => {
    const a = monoNow();
    await sleep(duration(5));
    expect(monoNow()).toBeGreaterThanOrEqual(a);
  });
});

// ─── construction ───────────────────────────────────────────────────

describe("duration", () => {
  it("accepts zero and positive values", () => {
    expect(duration(0)).toBe(0 as never);
    expect(duration(5000)).toBe(5000 as never);
  });

  it("REFUSES a negative value — a reserve is deadlineBefore, not a negative duration", () => {
    expect(() => duration(-1)).toThrow(RangeError);
    expect(() => duration(-5000)).toThrow(RangeError);
  });

  it("REFUSES non-finite values", () => {
    expect(() => duration(NaN)).toThrow(RangeError);
    expect(() => duration(Infinity)).toThrow(RangeError);
    expect(() => duration(-Infinity)).toThrow(RangeError);
  });
});

describe("signedDelta", () => {
  it("accepts negative values — signed by contract", () => {
    expect(signedDelta(-42)).toBe(-42 as never);
  });

  it("REFUSES non-finite values", () => {
    expect(() => signedDelta(NaN)).toThrow(RangeError);
    expect(() => signedDelta(Infinity)).toThrow(RangeError);
  });
});

// ─── deadline algebra ───────────────────────────────────────────────

describe("deadlineAfter / deadlineBefore", () => {
  it("deadlineAfter adds a budget to an instant", () => {
    expect(deadlineAfter(T0, duration(8000))).toBe(9000 as never);
  });

  it("deadlineBefore reserves a tail from a deadline", () => {
    const internal = deadlineAfter(T0, duration(8000));
    expect(deadlineBefore(internal, duration(1500))).toBe(7500 as never);
  });

  it("chains as the handler does: entry -> internal -> work", () => {
    const internal = deadlineAfter(T0, duration(6000));
    const work = deadlineBefore(internal, duration(1200));
    expect(work).toBe(5800 as never);
  });
});

describe("isExpired", () => {
  const d = deadlineAfter(T0, duration(100));

  it("false before the deadline", () => {
    expect(isExpired(d, at(50))).toBe(false);
  });

  it("true AT the deadline — the boundary is expired, matching >= semantics", () => {
    expect(isExpired(d, at(100))).toBe(true);
  });

  it("true after the deadline", () => {
    expect(isExpired(d, at(101))).toBe(true);
  });
});

describe("remainingForTimeout", () => {
  const d = deadlineAfter(T0, duration(100));

  it("returns the remaining window while live", () => {
    expect(remainingForTimeout(d, at(30))).toBe(70 as never);
  });

  it("returns null AT the deadline — null IS the expired case", () => {
    expect(remainingForTimeout(d, at(100))).toBeNull();
  });

  it("returns null past the deadline, NEVER a negative remainder", () => {
    expect(remainingForTimeout(d, at(500))).toBeNull();
  });

  it("agrees with isExpired at every boundary", () => {
    for (const t of [0, 99, 100, 101]) {
      const expired = isExpired(d, at(t));
      const left = remainingForTimeout(d, at(t));
      expect(expired).toBe(left === null);
    }
  });
});

describe("elapsed", () => {
  it("measures forward time", () => {
    expect(elapsed(T0, at(250))).toBe(250 as never);
  });

  it("clamps to 0 rather than returning a negative duration", () => {
    expect(elapsed(at(250), T0)).toBe(0 as never);
  });
});

describe("overshoot", () => {
  const d = deadlineAfter(T0, duration(100));

  it("is positive when work finishes late", () => {
    expect(overshoot(d, at(150))).toBe(50 as never);
  });

  it("is NEGATIVE when work finishes early — this is why it is not a DurationMs", () => {
    expect(overshoot(d, at(80))).toBe(-20 as never);
  });

  it("is 0 exactly at the deadline", () => {
    expect(overshoot(d, at(100))).toBe(0 as never);
  });
});

// ─── timers ─────────────────────────────────────────────────────────

describe("timeoutSignal", () => {
  it("returns a live signal while the deadline is in the future", () => {
    const sig = timeoutSignal(deadlineAfter(T0, duration(10_000)), at(0));
    expect(sig).not.toBeNull();
    expect(sig?.aborted).toBe(false);
  });

  it("returns null when already expired — the caller falls back LOCALLY", () => {
    expect(timeoutSignal(deadlineAfter(T0, duration(100)), at(100))).toBeNull();
    expect(timeoutSignal(deadlineAfter(T0, duration(100)), at(900))).toBeNull();
  });

  it("aborts once the window passes", async () => {
    const sig = timeoutSignal(deadlineAfter(monoNow(), duration(10)));
    expect(sig).not.toBeNull();
    await sleep(duration(40));
    expect(sig?.aborted).toBe(true);
  });
});

// ─── the defect this module exists to prevent ───────────────────────

describe("wall-clock independence", () => {
  it("a deadline is unaffected by an epoch jump between sampling and checking", () => {
    // The clock incident: two NTP daemons stepping CLOCK_REALTIME +3.61s every
    // ~36s. Wall-clock deadlines moved with it; monotonic ones cannot, because
    // no epoch value participates in the comparison at all.
    const d = deadlineAfter(T0, duration(8000));
    const beforeJump = remainingForTimeout(d, at(1000));
    const afterJump = remainingForTimeout(d, at(1000)); // same monotonic reading
    expect(beforeJump).toBe(afterJump);
    expect(beforeJump).toBe(7000 as never);
  });

  it("monotonic readings and epoch readings are different magnitudes", () => {
    // Guards the confusion class directly: passing a MonoInstant (~1e4) where an
    // EpochMs (~1.8e12) is expected, or the reverse, is off by ~8 orders.
    expect(epochNow() / monoNow()).toBeGreaterThan(1_000_000);
  });
});

// ─── O1 step 2: the complete algebra (duration / epoch / spans / projections / timers) ──

import {
  allotted,
  deadlineTimer,
  earliest,
  epochAfter,
  epochAt,
  epochBefore,
  epochDelta,
  epochMs,
  epochOf,
  epochReached,
  evidenceMs,
  raceDeadline,
  scaled,
  setWallJumpForTest,
  shorter,
  shorterThan,
  signalAfter,
  spanEvidence,
  spanStart,
  testWallJumpAtScanStart,
  untilDeadline,
  untilEpoch,
  wireBudget,
  type EpochMs,
} from "../../src/clock.ts";

describe("deadline selection and duration algebra (the named forms of min / < / ×)", () => {
  it("earliest picks the earlier deadline; shorter the shorter duration; shorterThan is strict", () => {
    const a = deadlineAfter(T0, duration(100));
    const b = deadlineAfter(T0, duration(200));
    expect(earliest(a, b)).toBe(a);
    expect(earliest(b, a)).toBe(a);
    expect(shorter(duration(3), duration(2))).toBe(2 as never);
    expect(shorterThan(duration(2), duration(3))).toBe(true);
    expect(shorterThan(duration(3), duration(3))).toBe(false);
  });

  it("scaled multiplies by a finite nonnegative factor and refuses a negative one", () => {
    expect(scaled(duration(100), 0.85)).toBe(85 as never);
    expect(scaled(duration(100), 0)).toBe(0 as never);
    expect(() => scaled(duration(100), -1)).toThrow(RangeError);
    expect(() => scaled(duration(100), NaN)).toThrow(RangeError);
  });

  it("allotted is the window a deadline grants from a start — clamped at 0 when the start is already past it", () => {
    const d = deadlineAfter(T0, duration(400));
    expect(allotted(T0, d)).toBe(400 as never);
    expect(allotted(at(150), d)).toBe(250 as never);
    expect(allotted(at(500), d)).toBe(0 as never);
  });
});

describe("epoch algebra (categories D/E keep wall-clock SEMANTICS, sampled only here)", () => {
  const e0 = epochAt(1_800_000_000_000);

  it("epochAt / epochOf validate; epochAfter / epochBefore shift; epochReached compares; epochDelta is signed; untilEpoch clamps", () => {
    expect(epochOf(new Date(1_800_000_000_000))).toBe(e0);
    expect(() => epochAt(NaN)).toThrow(RangeError);
    expect(() => epochOf(new Date("garbage"))).toThrow(RangeError);
    const later = epochAfter(e0, duration(60_000));
    expect(later).toBe((1_800_000_000_000 + 60_000) as never);
    expect(epochBefore(later, duration(60_000))).toBe(e0);
    expect(epochReached(later, e0)).toBe(false);
    expect(epochReached(later, later)).toBe(true);
    expect(epochDelta(later, e0)).toBe(60_000 as never);
    expect(epochDelta(e0, later)).toBe(-60_000 as never); // a realtime step can make it negative
    expect(untilEpoch(later, e0)).toBe(60_000 as never);
    expect(untilEpoch(e0, later)).toBe(0 as never);
  });
});

describe("closure over finite values (codex migration r1 S3): an overflowing operation throws, never returns a branded Infinity", () => {
  const MAX = Number.MAX_VALUE;
  it("scaled refuses a product past the finite range", () => {
    expect(() => scaled(duration(MAX), 2)).toThrow(RangeError);
    expect(scaled(duration(MAX), 1)).toBe(MAX as never); // the boundary itself is representable
  });
  it("deadlineAfter / deadlineBefore refuse a sum or difference past the finite range", () => {
    const far = deadlineAfter(T0, duration(MAX)); // MAX + 1000 rounds to MAX: still finite
    expect(() => deadlineAfter(far, duration(MAX))).toThrow(RangeError);
    const farBack = deadlineBefore(deadlineAfter(T0, duration(0)), duration(MAX));
    expect(() => deadlineBefore(farBack, duration(MAX))).toThrow(RangeError);
  });
  it("the epoch shifts and differences refuse overflow too", () => {
    expect(() => epochAfter(epochAt(MAX), duration(MAX))).toThrow(RangeError);
    expect(() => epochBefore(epochAt(-MAX), duration(MAX))).toThrow(RangeError);
    expect(() => epochDelta(epochAt(MAX), epochAt(-MAX))).toThrow(RangeError);
    expect(() => untilEpoch(epochAt(MAX), epochAt(-MAX))).toThrow(RangeError);
  });
  it("a far-but-finite deadline still yields a finite remaining window (no silent Infinity reaches a timer)", () => {
    const left = remainingForTimeout(deadlineAfter(T0, duration(MAX)), at(0));
    expect(left).not.toBeNull();
    expect(Number.isFinite(evidenceMs(left!))).toBe(true);
  });
});

describe("projections — the ONLY exits from the branded world", () => {
  it("evidenceMs / epochMs are identity on the number; wireBudget floors to whole ms and is null below 1 ms", () => {
    expect(evidenceMs(duration(12.5))).toBe(12.5);
    expect(evidenceMs(signedDelta(-3))).toBe(-3);
    expect(epochMs(epochAt(7))).toBe(7);
    expect(wireBudget(duration(1234.9))).toBe(1234);
    expect(wireBudget(duration(1))).toBe(1);
    expect(wireBudget(duration(0.999))).toBeNull();
    expect(wireBudget(duration(0))).toBeNull();
  });
});

describe("spans (O1 §3): the same leg on both clocks, and the skew between them", () => {
  afterEach(() => setWallJumpForTest(null));

  it("without a step, wall and mono elapsed agree to within scheduler noise and the skew is ~0", async () => {
    const s = spanStart();
    await sleep(duration(20));
    const ev = spanEvidence(s);
    expect(evidenceMs(ev.mono)).toBeGreaterThanOrEqual(15);
    expect(Math.abs(evidenceMs(ev.skew))).toBeLessThan(15);
    expect(evidenceMs(ev.wall) - evidenceMs(ev.mono)).toBe(evidenceMs(ev.skew));
  });

  it("a FORWARD wall step during the span shows up as positive skew, the monotonic elapsed unmoved", async () => {
    const s = spanStart();
    setWallJumpForTest({ at: monoNow(), deltaMs: 5000 });
    await sleep(duration(10));
    const ev = spanEvidence(s);
    expect(evidenceMs(ev.mono)).toBeLessThan(500);
    expect(evidenceMs(ev.skew)).toBeGreaterThan(4500);
  });

  it("a BACKWARD wall step during the span shows up as negative skew — the artifact exposes the step (§3)", async () => {
    const s = spanStart();
    setWallJumpForTest({ at: monoNow(), deltaMs: -5000 });
    await sleep(duration(10));
    const ev = spanEvidence(s);
    expect(evidenceMs(ev.mono)).toBeLessThan(500);
    expect(evidenceMs(ev.skew)).toBeLessThan(-4500);
    expect(evidenceMs(ev.wall)).toBeLessThan(0);
  });

  it("codex migration r1 S2: ONE terminal sample makes the record internally consistent — mono − allotted = overshoot exactly when the leg started before its deadline; a late start is allotted 0 and overshoots by more than it ran", () => {
    const start = { mono: T0, wall: epochAt(1_800_000_000_000) };
    const deadline = deadlineAfter(T0, duration(400));
    const end = { mono: at(650), wall: epochAt(1_800_000_000_650) };
    const ev = spanEvidence(start, end);
    expect(evidenceMs(ev.mono) - evidenceMs(allotted(start.mono, deadline))).toBe(evidenceMs(overshoot(deadline, end.mono)));
    expect(evidenceMs(overshoot(deadline, end.mono))).toBe(250);
    // A leg that STARTED after its deadline: allotted clamps to 0, overshoot counts from the deadline.
    const lateStart = { mono: at(500), wall: epochAt(1_800_000_000_500) };
    const lateEv = spanEvidence(lateStart, end);
    expect(evidenceMs(allotted(lateStart.mono, deadline))).toBe(0);
    expect(evidenceMs(overshoot(deadline, end.mono))).toBeGreaterThan(evidenceMs(lateEv.mono));
  });

  it("codex migration r2 #4: the test wall-step seam refuses a non-finite step and cannot overflow epochNow", () => {
    expect(() => setWallJumpForTest({ at: monoNow(), deltaMs: Infinity })).toThrow(RangeError);
    expect(() => setWallJumpForTest({ at: NaN as unknown as ReturnType<typeof monoNow>, deltaMs: 5 })).toThrow(RangeError);
    setWallJumpForTest({ at: monoNow(), deltaMs: Number.MAX_VALUE });
    expect(() => epochNow()).not.toThrow(); // MAX + a real epoch rounds to MAX: still finite
    const prev = process.env.CLAWMEM_TEST_WALL_JUMP_AT_SCAN;
    try {
      process.env.CLAWMEM_TEST_WALL_JUMP_AT_SCAN = String(Number.MAX_VALUE);
      expect(() => testWallJumpAtScanStart()).toThrow(RangeError); // MAX + MAX overflows — refused, never armed
    } finally {
      if (prev === undefined) delete process.env.CLAWMEM_TEST_WALL_JUMP_AT_SCAN; else process.env.CLAWMEM_TEST_WALL_JUMP_AT_SCAN = prev;
      setWallJumpForTest(null);
    }
    // The env form: a digit string that overflows to Infinity is ignored (no jump armed).
    const script = `import { epochNow } from "${process.cwd()}/src/clock.ts"; console.log(JSON.stringify({ finite: Number.isFinite(epochNow()), delta: epochNow() - Date.now() }));`;
    const r = Bun.spawnSync([process.execPath, "-e", script], { env: { ...process.env, CLAWMEM_TEST_WALL_JUMP: `0:${"9".repeat(400)}` } });
    const out = JSON.parse(r.stdout.toString().trim()) as { finite: boolean; delta: number };
    expect(out.finite).toBe(true);
    expect(Math.abs(out.delta)).toBeLessThan(50);
  });

  it("codex migration r1 S4: CLAWMEM_TEST_WALL_JUMP_AT_SCAN steps the wall clock AT the call, cumulatively — the eval daemon child's in-window step; a no-op when unset", () => {
    const prev = process.env.CLAWMEM_TEST_WALL_JUMP_AT_SCAN;
    try {
      delete process.env.CLAWMEM_TEST_WALL_JUMP_AT_SCAN;
      testWallJumpAtScanStart();
      expect(Math.abs(epochNow() - Date.now())).toBeLessThan(50);
      process.env.CLAWMEM_TEST_WALL_JUMP_AT_SCAN = "5000";
      testWallJumpAtScanStart();
      const one = epochNow() - Date.now();
      expect(one).toBeGreaterThanOrEqual(4990);
      expect(one).toBeLessThanOrEqual(5010);
      testWallJumpAtScanStart(); // a second scan start adds a second step
      const two = epochNow() - Date.now();
      expect(two).toBeGreaterThanOrEqual(9990);
      expect(two).toBeLessThanOrEqual(10010);
    } finally {
      if (prev === undefined) delete process.env.CLAWMEM_TEST_WALL_JUMP_AT_SCAN; else process.env.CLAWMEM_TEST_WALL_JUMP_AT_SCAN = prev;
    }
  });

  it("the env form (CLAWMEM_TEST_WALL_JUMP=<atUptimeMs>:<deltaMs>) arms a child process — the eval daemon child's injection path", () => {
    const script = `import { epochNow, monoNow } from "${process.cwd()}/src/clock.ts"; const raw = Date.now(); console.log(JSON.stringify({ delta: epochNow() - raw, mono: monoNow() }));`;
    const r = Bun.spawnSync([process.execPath, "-e", script], { env: { ...process.env, CLAWMEM_TEST_WALL_JUMP: "0:-7000" } });
    const out = JSON.parse(r.stdout.toString().trim()) as { delta: number; mono: number };
    expect(out.delta).toBeLessThanOrEqual(-6990);
    expect(out.delta).toBeGreaterThanOrEqual(-7010);
    // and a jump scheduled in the far future is NOT applied yet
    const r2 = Bun.spawnSync([process.execPath, "-e", script], { env: { ...process.env, CLAWMEM_TEST_WALL_JUMP: "3600000:-7000" } });
    expect(Math.abs(JSON.parse(r2.stdout.toString().trim()).delta)).toBeLessThan(50);
  });
});

describe("timers (direct timer construction is prohibited in scoped modules)", () => {
  it("onExpiry runs only once isExpired(deadline) holds — a platform timer that fires up to ~1 ms short re-arms instead (40 fractional deadlines)", async () => {
    const seen: boolean[] = [];
    await Promise.all(Array.from({ length: 40 }, (_, i) => new Promise<void>((resolve) => {
      const deadline = deadlineAfter(monoNow(), duration(2.3 + (i % 7) * 0.37));
      deadlineTimer(deadline, () => { seen.push(isExpired(deadline)); resolve(); });
    })));
    expect(seen.length).toBe(40);
    expect(seen.every(Boolean)).toBe(true);
  });

  it("a deadline BEYOND the platform timer ceiling (2^31−1 ms) does not fire early — a raw setTimeout would fire in ~1 ms", async () => {
    let fired = 0;
    const cancel = deadlineTimer(deadlineAfter(monoNow(), duration(2 ** 31 + 5)), () => { fired++; });
    await new Promise(r => setTimeout(r, 60));
    expect(fired).toBe(0);
    cancel();
  });

  it("the signal builders clamp a finite duration past 2^53−1 ms instead of throwing", () => {
    expect(() => signalAfter(duration(Number.MAX_VALUE))).not.toThrow();
    expect(timeoutSignal(deadlineAfter(T0, duration(Number.MAX_VALUE)), at(0))).not.toBeNull();
  });

  it("deadlineTimer fires at the deadline and can be cancelled; an already-passed deadline fires on the next macrotask", async () => {
    let fired = 0;
    const cancel = deadlineTimer(deadlineAfter(monoNow(), duration(20)), () => { fired++; });
    await sleep(duration(60));
    expect(fired).toBe(1);
    cancel(); // cancelling after firing is harmless
    let fired2 = 0;
    const cancel2 = deadlineTimer(deadlineAfter(monoNow(), duration(50)), () => { fired2++; });
    cancel2();
    await sleep(duration(80));
    expect(fired2).toBe(0);
    let fired3 = 0;
    deadlineTimer(deadlineAfter(monoNow(), duration(0)), () => { fired3++; });
    await sleep(duration(5));
    expect(fired3).toBe(1);
  });

  it("raceDeadline resolves with the work when it wins and rejects with the caller's error at the deadline; the timer is cleared either way", async () => {
    const won = await raceDeadline(sleep(duration(5)).then(() => "done"), deadlineAfter(monoNow(), duration(500)), () => new Error("late"));
    expect(won).toBe("done");
    const t0 = monoNow();
    await expect(raceDeadline(sleep(duration(400)).then(() => "slow"), deadlineAfter(monoNow(), duration(30)), () => new Error("vector timeout"))).rejects.toThrow("vector timeout");
    expect(evidenceMs(elapsed(t0))).toBeLessThan(300);
  });

  it("untilDeadline reports timedOut instead of rejecting, and carries the value otherwise", async () => {
    const a = await untilDeadline(sleep(duration(5)).then(() => 42), deadlineAfter(monoNow(), duration(500)));
    expect(a).toEqual({ timedOut: false, value: 42 });
    const b = await untilDeadline(sleep(duration(400)), deadlineAfter(monoNow(), duration(20)));
    expect(b).toEqual({ timedOut: true });
  });

  it("signalAfter aborts after the duration", async () => {
    const s = signalAfter(duration(10));
    expect(s.aborted).toBe(false);
    await sleep(duration(40));
    expect(s.aborted).toBe(true);
  });
});

// keep the type import referenced under isolatedModules
void (null as unknown as EpochMs);
