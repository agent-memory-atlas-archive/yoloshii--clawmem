/**
 * Compile-time contract: the PUBLIC `LLM` interface exposes the expansion
 * deadline option (codex turn-25 finding 1 — the concrete class carried
 * deadlineAt while the interface hid it from typed consumers). A typed
 * options object assigned through the interface's parameter type fails tsc
 * if the interface loses the field; the runtime assertion keeps the test
 * collected.
 */
import { describe, it, expect } from "bun:test";
import type { LLM } from "../../src/llm.ts";

type ExpandOptions = NonNullable<Parameters<LLM["expandQuery"]>[1]>;

describe("LLM interface — expansion deadline contract (codex turn-25 F1)", () => {
  it("expandQuery's options type accepts deadlineAt (compile-time; tsc fails if the interface drops it)", () => {
    const opts: ExpandOptions = { intent: "x", deadlineAt: Date.now() + 1000 };
    // deadlineAt must be a real member, not swallowed by an index signature.
    const deadline: number | undefined = opts.deadlineAt;
    expect(typeof deadline).toBe("number");
  });
});
