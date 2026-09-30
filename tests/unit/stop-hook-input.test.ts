/**
 * 62.1 D1 (rev 11): the hook input carries OpenClaw's host identity to the hook process.
 *
 * Baseline (8e2579a): `readHookInput` keeps only the fields it names, so `host`, `session_key` and
 * `register_only` sent by OpenClaw's `execHook` never reach a hook — the host-specific pairing rule and the
 * register-only surfacing call cannot run through the real process boundary.
 */
import { describe, it, expect } from "bun:test";
import * as hooks from "../../src/hooks.ts";

const parse = (raw: string) => {
  const fn = (hooks as Record<string, unknown>).parseHookInput as ((raw: string) => hooks.HookInput) | undefined;
  if (typeof fn !== "function") throw new Error("parseHookInput is not exported by src/hooks.ts");
  return fn(raw);
};

describe("D1 hook input decoding", () => {
  it("decodes OpenClaw's host, session key and register-only flag (snake_case, as execHook sends them)", () => {
    const input = parse(JSON.stringify({
      session_id: "s-1",
      prompt: "ok",
      transcript_path: "/tmp/agents/main/sessions/s-1.jsonl",
      host: "openclaw",
      session_key: "agent:main:telegram:42",
      register_only: true,
    }));
    expect(input.sessionId).toBe("s-1");
    expect(input.transcriptPath).toBe("/tmp/agents/main/sessions/s-1.jsonl");
    expect(input.host).toBe("openclaw");
    expect(input.sessionKey).toBe("agent:main:telegram:42");
    expect(input.registerOnly).toBe(true);
  });

  it("accepts the camelCase spellings too", () => {
    const input = parse(JSON.stringify({ sessionId: "s-2", host: "openclaw", sessionKey: "k", registerOnly: true }));
    expect(input.sessionKey).toBe("k");
    expect(input.registerOnly).toBe(true);
  });

  it("leaves host absent for Claude Code (absent = Claude Code) and registerOnly false unless it is exactly true", () => {
    const input = parse(JSON.stringify({ session_id: "s-3", prompt: "hello", register_only: "yes" }));
    expect(input.host).toBeUndefined();
    expect(input.registerOnly).toBe(false);
  });

  it("ignores non-string host and session key values", () => {
    const input = parse(JSON.stringify({ session_id: "s-4", host: 7, session_key: { a: 1 } }));
    expect(input.host).toBeUndefined();
    expect(input.sessionKey).toBeUndefined();
  });

  it("returns an empty input for empty or malformed stdin, as before", () => {
    expect(parse("")).toEqual({});
    expect(parse("{not json")).toEqual({});
  });
});
