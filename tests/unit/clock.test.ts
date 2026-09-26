import { describe, it, expect } from "bun:test";

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
