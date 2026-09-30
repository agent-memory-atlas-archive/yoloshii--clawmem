/**
 * 62.1 D1: turn identity — the pairing rule, the identity every surfacing row carries, the transcript locator and the
 * OpenClaw host wiring (design tests 3, 4, 5, 44-49 at the identity layer; attribution through feedback-loop is D6).
 *
 * Baseline (8e2579a): a usage row records no prompt hash, transcript key or host, and feedback pairs rows with
 * transcript turns by POSITION, so one gated, heartbeat or duplicate prompt shifts every later attribution (CM-02).
 * context-surfacing registers no locator, so a session whose Stops all die is unreachable afterwards. OpenClaw returns
 * before invoking the hook for a short prompt and never passes its transcript, host or session key.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { createHash } from "crypto";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createStore, type Store } from "../../src/store.ts";
import { createTestStore } from "../helpers/test-store.ts";
import { contextSurfacing } from "../../src/hooks/context-surfacing.ts";
import { consumePendingSurfacingBookkeeping } from "../../src/hooks/surfacing-bookkeeping.ts";
import { MAX_QUERY_LENGTH } from "../../src/limits.ts";
import * as hooks from "../../src/hooks.ts";
import {
  handleAgentEnd,
  handleBeforePromptBuild,
  handleBeforeReset,
  handleSessionStart,
  setHookRunnerForTests,
  restoreHookRunnerForTests,
  setSessionFileResolverForTests,
  restoreSessionFileResolverForTests,
  type ExecHookFn,
  type ResolveSessionFileFn,
} from "../../src/openclaw/engine.ts";
import {
  _resetAllSessionStateForTests,
  setBootstrapContext,
  takeBootstrapContext,
  isSessionSurfaced,
} from "../../src/openclaw/session-state.ts";
import type { ShellResult } from "../../src/openclaw/shell.ts";

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const pairing = () => import("../../src/stop-pairing.ts");

// ─── Identity primitives ───────────────────────────────────────────────────────────────────────────────────────────
describe("D1 identity primitives", () => {
  it("normalizePromptForIdentity: NFC, whitespace collapsed, trimmed", async () => {
    const { normalizePromptForIdentity } = await pairing();
    expect(normalizePromptForIdentity("  Café  au\tlait\n\n now ")).toBe("Café au lait now");
  });

  it("promptSha is sha256 of the normalized prompt: equal across whitespace variants, distinct otherwise", async () => {
    const { promptSha } = await pairing();
    expect(promptSha("fix the  bug\n")).toBe(sha256("fix the bug"));
    expect(promptSha("  fix the bug")).toBe(promptSha("fix the bug"));
    expect(promptSha("fix the bug")).not.toBe(promptSha("fix the bugs"));
  });

  it("transcriptKey is sha256 of the absolute path", async () => {
    const { transcriptKey } = await pairing();
    expect(transcriptKey("/a/b/../b/s.jsonl")).toBe(sha256("/a/b/s.jsonl"));
    expect(transcriptKey("/a/b/s.jsonl")).toBe(sha256("/a/b/s.jsonl"));
  });

  it("parseEntryTime reads ISO strings and epoch milliseconds; anything else is unknown", async () => {
    const { parseEntryTime } = await pairing();
    expect(parseEntryTime("2026-09-30T10:00:00.000Z")).toBe(Date.parse("2026-09-30T10:00:00.000Z"));
    expect(parseEntryTime(1_790_000_000_000)).toBe(1_790_000_000_000);
    expect(parseEntryTime(undefined)).toBeNull();
    expect(parseEntryTime("not a date")).toBeNull();
  });
});

// ─── The pairing rule ──────────────────────────────────────────────────────────────────────────────────────────────
type E = { kind: "human" | "assistant" | "tool_result" | "meta"; text: string; ts: number | null };
const H = (text: string, ts: number | null): E => ({ kind: "human", text, ts });
const A = (ts: number | null): E => ({ kind: "assistant", text: "answer", ts });
const TR = (ts: number | null): E => ({ kind: "tool_result", text: "", ts });

describe("D1 pairTurns — Claude Code (H.ts <= U.ts < H_next.ts)", () => {
  it("a heartbeat turn with no row does not shift the next turn's pairing (test 4; positional pairing does)", async () => {
    const { pairTurns, promptSha } = await pairing();
    const entries = [H("first question please", 100), A(110), TR(115), A(120), H("keepalive", 200), A(210),
      H("third question please", 300), A(310)];
    const rows = [
      { id: 1, promptSha: promptSha("first question please"), ts: 101 },
      { id: 3, promptSha: promptSha("third question please"), ts: 301 },
    ];
    const pairs = pairTurns("claude-code", entries, rows);
    expect(pairs.get(1)).toBe(0);
    expect(pairs.get(3)).toBe(6);
  });

  it("a repeated prompt pairs by the ordering window, not by position (test 3)", async () => {
    const { pairTurns, promptSha } = await pairing();
    const entries = [H("same prompt text", 100), A(150), H("same prompt text", 200), A(250)];
    const pairs = pairTurns("claude-code", entries, [{ id: 7, promptSha: promptSha("same prompt text"), ts: 201 }]);
    expect(pairs.get(7)).toBe(2);
  });

  it("a row outside every window, or two rows in one window, is unattributed", async () => {
    const { pairTurns, promptSha } = await pairing();
    const entries = [H("a question here", 100), A(110)];
    expect(pairTurns("claude-code", entries, [{ id: 1, promptSha: promptSha("a question here"), ts: 50 }]).size).toBe(0);
    const two = pairTurns("claude-code", entries, [
      { id: 1, promptSha: promptSha("a question here"), ts: 101 },
      { id: 2, promptSha: promptSha("a question here"), ts: 102 },
    ]);
    expect(two.size).toBe(0);
  });

  it("without timestamps a hash pairs only when unique among the rows and the turns", async () => {
    const { pairTurns, promptSha } = await pairing();
    const rows = [{ id: 1, promptSha: promptSha("alpha question"), ts: null }];
    expect(pairTurns("claude-code", [H("alpha question", null), H("beta question", null)], rows).get(1)).toBe(0);
    expect(pairTurns("claude-code", [H("alpha question", null), H("alpha question", null)], rows).size).toBe(0);
  });

  it("a row without a prompt hash (legacy, pre-upgrade) never pairs", async () => {
    const { pairTurns } = await pairing();
    expect(pairTurns("claude-code", [H("anything at all", 100)], [{ id: 1, promptSha: null, ts: 101 }]).size).toBe(0);
  });
});

describe("D1 pairTurns — OpenClaw (E_prev.ts <= U.ts <= H.ts, cleaned text)", () => {
  it("the row written BEFORE its human entry pairs, on the cleaned prompt (test 5)", async () => {
    const { pairTurns, promptSha } = await pairing();
    const entries = [A(90), H("[Sat 2026-03-14 16:19 GMT+8] what is the plan", 100), A(130)];
    const row = { id: 4, promptSha: promptSha("what is the plan"), ts: 95 };
    expect(pairTurns("openclaw", entries, [row]).get(4)).toBe(1);
    // The same row under Claude Code's rule is out of window (it precedes its human entry).
    expect(pairTurns("claude-code", entries, [row]).size).toBe(0);
  });

  it("a row after its human entry, or before the previous entry, is unattributed; a first entry has no lower bound", async () => {
    const { pairTurns, promptSha } = await pairing();
    const sha = promptSha("what is the plan");
    const entries = [A(90), H("what is the plan", 100)];
    expect(pairTurns("openclaw", entries, [{ id: 1, promptSha: sha, ts: 101 }]).size).toBe(0);
    expect(pairTurns("openclaw", entries, [{ id: 1, promptSha: sha, ts: 80 }]).size).toBe(0);
    expect(pairTurns("openclaw", [H("what is the plan", 100)], [{ id: 1, promptSha: sha, ts: 10 }]).get(1)).toBe(0);
  });
});

// ─── Surfacing identity + the locator ──────────────────────────────────────────────────────────────────────────────
type UsageRow = { id: number; prompt_sha: string | null; transcript_key: string | null; host: string | null; session_key: string | null; query_text: string | null };
function usageRows(store: Store, sessionId: string): UsageRow[] {
  return store.db.prepare(
    `SELECT id, prompt_sha, transcript_key, host, session_key, query_text FROM context_usage WHERE session_id = ? ORDER BY id`
  ).all(sessionId) as UsageRow[];
}
function locators(store: Store, sessionId: string) {
  return store.db.prepare(
    `SELECT transcript_key, transcript_path, host, session_key FROM session_transcripts WHERE session_id = ?`
  ).all(sessionId) as { transcript_key: string; transcript_path: string; host: string | null; session_key: string | null }[];
}

describe("D1 context-surfacing records the turn's identity and registers the locator before every gate", () => {
  const KEYS = ["CLAWMEM_HOOK_DEDUP_WINDOW_SEC", "CLAWMEM_HEARTBEAT_PATTERNS", "CLAWMEM_HOOK_BUDGET_MS"];
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    for (const k of KEYS) saved[k] = process.env[k];
    process.env.CLAWMEM_HOOK_DEDUP_WINDOW_SEC = "0";
    process.env.CLAWMEM_HEARTBEAT_PATTERNS = "keepalive tick";
    process.env.CLAWMEM_HOOK_BUDGET_MS = "4000";
  });
  afterEach(() => { for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });

  it("a gated Claude Code turn writes its row with prompt_sha, transcript key and host, and registers the transcript", async () => {
    const { promptSha, transcriptKey } = await pairing();
    const store = createTestStore();
    const path = "/tmp/claude-code/projects/p/s-cc-1.jsonl";
    await contextSurfacing(store, { sessionId: "s-cc-1", prompt: "hi there", transcriptPath: path });
    const rows = usageRows(store, "s-cc-1");
    expect(rows.length).toBe(1);
    expect(rows[0]!.prompt_sha).toBe(promptSha("hi there"));
    expect(rows[0]!.transcript_key).toBe(transcriptKey(path));
    expect(rows[0]!.host).toBe("claude-code");
    expect(rows[0]!.session_key).toBeNull();
    expect(locators(store, "s-cc-1")).toEqual([{ transcript_key: transcriptKey(path), transcript_path: path, host: "claude-code", session_key: null }]);
  });

  it("a heartbeat or a recent duplicate writes no row but still registers the locator (test 44)", async () => {
    const { transcriptKey } = await pairing();
    const store = createTestStore();
    const path = "/tmp/claude-code/projects/p/s-hb.jsonl";
    await contextSurfacing(store, { sessionId: "s-hb", prompt: "scheduler keepalive tick for the agent loop", transcriptPath: path });
    expect(usageRows(store, "s-hb").length).toBe(0);
    expect(locators(store, "s-hb").map(l => l.transcript_key)).toEqual([transcriptKey(path)]);

    // A prompt another session sent moments ago is suppressed as a recent duplicate (no row) — the second session
    // must still get its locator. The first sighting is recorded directly, so no retrieval runs in this test.
    process.env.CLAWMEM_HOOK_DEDUP_WINDOW_SEC = "600";
    const dupPath = "/tmp/claude-code/projects/p/s-dup-2.jsonl";
    const dupPrompt = "please summarise the architecture decisions we took for the ingest pipeline";
    expect(hooks.wasPromptSeenRecently(store, "context-surfacing", dupPrompt)).toBe(false);
    await contextSurfacing(store, { sessionId: "s-dup-2", prompt: dupPrompt, transcriptPath: dupPath });
    expect(usageRows(store, "s-dup-2").length).toBe(0);
    expect(locators(store, "s-dup-2").map(l => l.transcript_key)).toEqual([transcriptKey(dupPath)]);
  });

  it("prompt_sha hashes the prompt as received, before the hook trims or truncates it", async () => {
    const { promptSha } = await pairing();
    const store = createTestStore();
    const long = "  /review " + "x".repeat(MAX_QUERY_LENGTH + 100) + "  ";
    await contextSurfacing(store, { sessionId: "s-long", prompt: long, transcriptPath: "/tmp/cc/s-long.jsonl" });
    const rows = usageRows(store, "s-long");
    expect(rows.length).toBe(1);
    expect(rows[0]!.prompt_sha).toBe(promptSha(long));
  });

  it("register_only registers the locator and returns: no row, no spool job (OpenClaw short prompt, test 47)", async () => {
    const { transcriptKey } = await pairing();
    const store = createTestStore();
    consumePendingSurfacingBookkeeping();
    const path = "/tmp/openclaw/agents/main/sessions/s-oc-ro.jsonl";
    const out = await contextSurfacing(store, {
      sessionId: "s-oc-ro", prompt: "ok", transcriptPath: path, host: "openclaw", sessionKey: "agent:main:main", registerOnly: true,
    });
    expect(out.hookSpecificOutput?.additionalContext ?? "").toBe("");
    expect(usageRows(store, "s-oc-ro").length).toBe(0);
    expect(consumePendingSurfacingBookkeeping()).toBeNull();
    expect(locators(store, "s-oc-ro")).toEqual([{ transcript_key: transcriptKey(path), transcript_path: path, host: "openclaw", session_key: "agent:main:main" }]);
  });

  it("a keyless OpenClaw row is bound by the next invocation of the same (session id, session key) that has a transcript (test 49)", async () => {
    const { transcriptKey } = await pairing();
    const store = createTestStore();
    await contextSurfacing(store, { sessionId: "s-bind", prompt: "hi there", host: "openclaw", sessionKey: "agent:main:topic-1" });
    await contextSurfacing(store, { sessionId: "s-bind", prompt: "yo there", host: "openclaw", sessionKey: "agent:main:topic-2" });
    let rows = usageRows(store, "s-bind");
    expect(rows.map(r => r.transcript_key)).toEqual([null, null]);
    expect(rows.map(r => r.session_key)).toEqual(["agent:main:topic-1", "agent:main:topic-2"]);

    const path = "/tmp/openclaw/agents/main/sessions/s-bind-topic-1.jsonl";
    await contextSurfacing(store, { sessionId: "s-bind", prompt: "hey again", transcriptPath: path, host: "openclaw", sessionKey: "agent:main:topic-1" });
    rows = usageRows(store, "s-bind");
    expect(rows.map(r => r.transcript_key)).toEqual([transcriptKey(path), null, transcriptKey(path)]);
  });

  it("on a vault whose migration is not verified, surfacing writes the legacy row and registers nothing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "clawmem-621-identity-"));
    try {
      const path = join(dir, "index.sqlite");
      const s0 = createStore(path);
      // Back to the pre-62.1 shape (fence, tables, columns, markers).
      for (const t of s0.db.prepare(`SELECT name FROM sqlite_master WHERE type = 'trigger' AND sql LIKE '%legacy_writer_log%'`).all() as { name: string }[]) {
        s0.db.exec(`DROP TRIGGER "${t.name}"`);
      }
      for (const ix of s0.db.prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'context_usage' AND sql LIKE '%transcript_key%'`).all() as { name: string }[]) {
        s0.db.exec(`DROP INDEX "${ix.name}"`);
      }
      for (const c of ["prompt_sha", "transcript_key", "host", "session_key", "writer_stamp", "source_usage_id"]) s0.db.exec(`ALTER TABLE context_usage DROP COLUMN ${c}`);
      for (const c of ["counter_stamp", "doc_stamp", "access_grace_until"]) s0.db.exec(`ALTER TABLE documents DROP COLUMN ${c}`);
      s0.db.exec(`DROP TABLE session_transcripts`);
      s0.db.exec(`DELETE FROM vault_flags WHERE flag LIKE 'stop-pipeline:%'`);
      s0.close();
      const holder = new Database(path);
      holder.exec("PRAGMA busy_timeout = 0");
      holder.exec("BEGIN IMMEDIATE");
      const origError = console.error;
      console.error = () => {};
      let s1: Store;
      try {
        s1 = createStore(path, { busyTimeout: 50 });
      } finally {
        console.error = origError;
        holder.exec("ROLLBACK");
        holder.close();
      }
      await contextSurfacing(s1!, { sessionId: "s-legacy", prompt: "hi there", transcriptPath: "/tmp/cc/s-legacy.jsonl" });
      const cols = new Set((s1!.db.prepare(`PRAGMA table_info(context_usage)`).all() as { name: string }[]).map(c => c.name));
      expect(cols.has("prompt_sha")).toBe(false);
      expect((s1!.db.prepare(`SELECT COUNT(*) AS n FROM context_usage WHERE session_id = 's-legacy'`).get() as { n: number }).n).toBe(1);
      s1!.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ─── OpenClaw host wiring ──────────────────────────────────────────────────────────────────────────────────────────
describe("D1 OpenClaw passes its transcript, host and session key; a short prompt registers only (tests 45-48)", () => {
  const calls: { name: string; input: Record<string, unknown> }[] = [];
  const stubExecHook: ExecHookFn = async (_cfg, hookName, input): Promise<ShellResult> => {
    calls.push({ name: hookName, input });
    return { stdout: "", stderr: "", exitCode: 0 };
  };
  const resolved: ResolveSessionFileFn = (p) => (p.sessionId ? `/tmp/oc/agents/${p.agentId ?? "main"}/sessions/${p.sessionId}.jsonl` : undefined);
  const unresolved: ResolveSessionFileFn = () => undefined;
  const cfg = { clawmemBin: "clawmem", tokenBudget: 800, profile: "balanced", enableTools: false, servePort: 7438, env: {} };
  const threshold = { contextWindowTokens: 112_000, reserveTokensFloor: 8_000, softThresholdTokens: 4_000, precompactProximityRatio: 0.85 };
  const logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

  beforeEach(() => {
    calls.length = 0;
    _resetAllSessionStateForTests();
    setHookRunnerForTests({ execHook: stubExecHook });
    setSessionFileResolverForTests(resolved);
  });
  afterEach(() => {
    restoreHookRunnerForTests();
    restoreSessionFileResolverForTests();
  });

  it("a short prompt with a resolvable transcript invokes context-surfacing register_only and leaves the bootstrap unconsumed", async () => {
    setBootstrapContext("s-short", "BOOTSTRAP");
    const out = await handleBeforePromptBuild(cfg as any, threshold, logger, { prompt: "ok" }, { sessionId: "s-short", sessionKey: "agent:main:main", agentId: "main" });
    expect(out).toBeUndefined();
    expect(calls.map(c => c.name)).toEqual(["context-surfacing"]);
    expect(calls[0]!.input).toMatchObject({
      session_id: "s-short", register_only: true, host: "openclaw", session_key: "agent:main:main",
      transcript_path: "/tmp/oc/agents/main/sessions/s-short.jsonl",
    });
    expect(isSessionSurfaced("s-short")).toBe(false);
    expect(takeBootstrapContext("s-short")).toBe("BOOTSTRAP");
  });

  it("a short prompt whose transcript cannot be resolved invokes nothing — no guessed path (test 48)", async () => {
    setSessionFileResolverForTests(unresolved);
    await handleBeforePromptBuild(cfg as any, threshold, logger, { prompt: "" }, { sessionId: "s-new", sessionKey: "agent:main:main" });
    await handleBeforePromptBuild(cfg as any, threshold, logger, { prompt: "ok" }, { sessionId: "s-new", sessionKey: "agent:main:main" });
    expect(calls.length).toBe(0);
  });

  it("a substantive prompt surfaces with transcript_path, host and session_key (path omitted when unresolvable)", async () => {
    await handleBeforePromptBuild(cfg as any, threshold, logger, { prompt: "which eviction policy should the cache layer use?" }, { sessionId: "s-sub", sessionKey: "agent:main:main", agentId: "main" });
    const surf = calls.find(c => c.name === "context-surfacing")!;
    expect(surf.input).toMatchObject({ session_id: "s-sub", host: "openclaw", session_key: "agent:main:main", transcript_path: "/tmp/oc/agents/main/sessions/s-sub.jsonl" });
    expect(surf.input.register_only).toBeUndefined();

    calls.length = 0;
    setSessionFileResolverForTests(unresolved);
    await handleBeforePromptBuild(cfg as any, threshold, logger, { prompt: "which eviction policy should the cache layer use?" }, { sessionId: "s-sub2", sessionKey: "agent:main:main" });
    const surf2 = calls.find(c => c.name === "context-surfacing")!;
    expect(surf2.input).toMatchObject({ session_id: "s-sub2", host: "openclaw", session_key: "agent:main:main" });
    expect("transcript_path" in surf2.input).toBe(false);
  });

  it("agent_end, before_reset and session_start set host (and the session key where the host has one)", async () => {
    await handleAgentEnd(cfg as any, logger, { messages: [{}, {}], success: true }, { sessionId: "s-end", sessionKey: "agent:main:main", agentId: "main" });
    for (const name of ["decision-extractor", "handoff-generator", "feedback-loop"]) {
      expect(calls.find(c => c.name === name)!.input).toMatchObject({ session_id: "s-end", host: "openclaw", session_key: "agent:main:main" });
    }
    calls.length = 0;
    await handleBeforeReset(cfg as any, logger, { sessionFile: "/tmp/oc/s-reset.jsonl" }, { sessionId: "s-reset", sessionKey: "agent:main:main" });
    for (const c of calls) expect(c.input).toMatchObject({ host: "openclaw", session_key: "agent:main:main" });
    calls.length = 0;
    await handleSessionStart(cfg as any, logger, { sessionId: "s-start", sessionKey: "agent:main:main" }, { sessionId: "s-start" });
    expect(calls.find(c => c.name === "session-bootstrap")!.input).toMatchObject({ host: "openclaw" });
  });

  it("the input survives the real serialization (execHook's JSON → stdin → parseHookInput, test 46)", async () => {
    await handleBeforePromptBuild(cfg as any, threshold, logger, { prompt: "ok" }, { sessionId: "s-wire", sessionKey: "agent:main:main", agentId: "main" });
    const parsed = (hooks as any).parseHookInput(JSON.stringify(calls[0]!.input)) as hooks.HookInput;
    expect(parsed.sessionId).toBe("s-wire");
    expect(parsed.host).toBe("openclaw");
    expect(parsed.sessionKey).toBe("agent:main:main");
    expect(parsed.registerOnly).toBe(true);
    expect(parsed.transcriptPath).toBe("/tmp/oc/agents/main/sessions/s-wire.jsonl");
  });
});
