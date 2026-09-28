/**
 * 62.2 (codex T1 #10) — OpenClaw's before_compaction fallback keys the pre-compaction state by the
 * REAL session id (the `<sessionId>.jsonl` stem), never by the shared literal "compaction-fallback"
 * that made every key-less session overwrite one state file. No valid id → no extraction.
 */
import { describe, it, expect, afterEach } from "bun:test";
import {
  handleBeforeCompaction,
  restoreHookRunnerForTests,
  setHookRunnerForTests,
} from "../../src/openclaw/engine.ts";

const calls: { hook: string; input: Record<string, unknown> }[] = [];
const logger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as any;
const cfg = { clawmemBin: "/nonexistent/clawmem", tokenBudget: 800, profile: "balanced", enableTools: false, servePort: 7438 } as any;

function capture() {
  calls.length = 0;
  setHookRunnerForTests({
    execHook: async (_cfg, hook, input) => {
      calls.push({ hook, input });
      return { exitCode: 0, stdout: "{}", stderr: "" } as any;
    },
  });
}

afterEach(() => restoreHookRunnerForTests());

describe("62.2 — OpenClaw before_compaction fallback session id", () => {
  it("uses the session file's stem as the session id, even when a sessionKey is present", async () => {
    capture();
    await handleBeforeCompaction(cfg, {}, logger,
      { messageCount: 10, sessionFile: "/state/agents/main/sessions/8f2c1a90-aaaa-4bbb-8ccc-0123456789ab.jsonl" },
      { sessionKey: "agent:main:main" });
    expect(calls).toEqual([{
      hook: "precompact-extract",
      input: {
        session_id: "8f2c1a90-aaaa-4bbb-8ccc-0123456789ab",
        transcript_path: "/state/agents/main/sessions/8f2c1a90-aaaa-4bbb-8ccc-0123456789ab.jsonl",
      },
    }]);
  });

  it("codex T2 #7 / T3 #8: a stem containing -topic- cannot be split with certainty, so the fallback skips it", async () => {
    for (const f of [
      "/state/agents/main/sessions/8f2c1a90-aaaa-4bbb-8ccc-0123456789ab-topic-general%20chat.jsonl", // a topic session
      "/state/agents/main/sessions/alpha-topic-beta.jsonl",                                         // a valid id containing -topic-
    ]) {
      capture();
      await handleBeforeCompaction(cfg, {}, logger, { messageCount: 10, sessionFile: f }, { sessionKey: "agent:main:main" });
      expect(calls).toEqual([]);
    }
  });

  it("skips the extraction when there is no session file", async () => {
    capture();
    await handleBeforeCompaction(cfg, {}, logger, { messageCount: 10 }, { sessionKey: "agent:main:main" });
    expect(calls).toEqual([]);
  });

  it("skips the extraction when the file stem is not a valid session id", async () => {
    capture();
    await handleBeforeCompaction(cfg, {}, logger, { messageCount: 10, sessionFile: "/state/sessions/../evil name.jsonl" }, {});
    expect(calls).toEqual([]);
  });
});
