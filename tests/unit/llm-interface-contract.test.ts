/**
 * Compile-time contract: the PUBLIC `LLM` interface exposes the expansion
 * deadline option (codex turn-25 finding 1 — the concrete class carried the
 * option while the interface hid it from typed consumers). O1: the option is
 * `deadline`, a MONOTONIC `MonoDeadline` — a bare epoch number must NOT be
 * accepted (the @ts-expect-error inverts that assertion: if the interface ever
 * widens the field back to `number`, tsc reports an unused directive). A typed
 * options object assigned through the interface's parameter type fails tsc if
 * the interface loses the field; the runtime assertion keeps the test collected.
 */
import { describe, it, expect } from "bun:test";
import type { LLM } from "../../src/llm.ts";
import { monoNow, deadlineAfter, duration, type MonoDeadline } from "../../src/clock.ts";

type ExpandOptions = NonNullable<Parameters<LLM["expandQuery"]>[1]>;

describe("LLM interface — expansion deadline contract (codex turn-25 F1, O1)", () => {
  it("expandQuery's options type accepts a MonoDeadline `deadline` (compile-time; tsc fails if the interface drops it)", () => {
    const opts: ExpandOptions = { intent: "x", deadline: deadlineAfter(monoNow(), duration(1000)) };
    // `deadline` must be a real member, not swallowed by an index signature.
    const deadline: MonoDeadline | undefined = opts.deadline;
    expect(typeof deadline).toBe("number");
  });

  it("a bare epoch number is NOT an acceptable deadline (the pre-O1 seam is unreachable through the interface)", () => {
    // @ts-expect-error — number is not MonoDeadline
    const bad: ExpandOptions = { deadline: Date.now() + 1000 };
    expect(bad).toBeDefined();
  });
});
