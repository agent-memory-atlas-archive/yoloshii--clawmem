/**
 * Hook budget contract (issue #28 follow-up): one configured number drives the
 * child env (CLAWMEM_HOOK_BUDGET_MS), the execFile kill timeout, and the
 * timeoutMs handed to OpenClaw for before_prompt_build — always inner < outer.
 * Also pins the manifest tool contract (PR #27): the names registered at
 * runtime must equal the names declared under contracts.tools, or OpenClaw
 * >= 2026.5.2 rejects every registerTool call.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  resolveHookBudgetMs,
  contextSurfacingKillTimeoutMs,
  hostHookTimeoutMs,
  execHook,
  DEFAULT_HOOK_BUDGET_MS,
  MIN_HOOK_BUDGET_MS,
  MAX_HOOK_BUDGET_MS,
  HOOK_KILL_MARGIN_MS,
  HOST_TIMEOUT_MARGIN_MS,
  OPENCLAW_HOOK_TIMEOUT_POLICY_MAX_MS,
  type ClawMemConfig,
} from "../../src/openclaw/shell.ts";
import {
  parseHookBudgetConfig,
  DEFAULT_HOOK_BUDGET_MS as HOOK_DEFAULT_BUDGET_MS,
  MIN_HOOK_BUDGET_MS as HOOK_MIN_BUDGET_MS,
  MAX_HOOK_BUDGET_MS as HOOK_MAX_BUDGET_MS,
} from "../../src/hooks/context-surfacing.ts";
import { MAX_LEG_BUDGET_MS } from "../../src/vector-protocol.ts";
import {
  handleBeforePromptBuild,
  setHookRunnerForTests,
  restoreHookRunnerForTests,
  setSessionFileResolverForTests,
  restoreSessionFileResolverForTests,
  type ExecHookFn,
} from "../../src/openclaw/engine.ts";
import { _resetAllSessionStateForTests } from "../../src/openclaw/session-state.ts";
import clawmemPlugin from "../../src/openclaw/index.ts";
import { createTools } from "../../src/openclaw/tools.ts";

const MANIFEST_PATH = new URL("../../src/openclaw/openclaw.plugin.json", import.meta.url).pathname;

type OnCall = { name: string; opts?: Record<string, unknown> };
function fakeApi(pluginConfig: Record<string, unknown>) {
  const ons: OnCall[] = [];
  const tools: string[] = [];
  const warns: string[] = [];
  const infos: string[] = [];
  const api = {
    pluginConfig,
    logger: {
      debug() {},
      info: (m: string) => { infos.push(m); },
      warn: (m: string) => { warns.push(m); },
      error() {},
    },
    on(name: string, _handler: unknown, opts?: Record<string, unknown>) { ons.push({ name, opts }); },
    registerMemoryCapability() {},
    registerTool(def: { name: string }) { tools.push(def.name); },
    registerService() {},
  };
  return { api, ons, tools, warns, infos };
}

const quietLogger = { debug() {}, info() {}, warn() {}, error() {} };
const ENV_KEYS = ["CLAWMEM_RERANK_URL", "CLAWMEM_LLM_URL"] as const;
let savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  savedEnv = {};
  for (const k of ENV_KEYS) { savedEnv[k] = process.env[k]; delete process.env[k]; }
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k]; else process.env[k] = savedEnv[k];
  }
});

describe("resolveHookBudgetMs", () => {
  test("defaults when unset, non-numeric, or non-positive", () => {
    expect(resolveHookBudgetMs(undefined)).toBe(DEFAULT_HOOK_BUDGET_MS);
    expect(resolveHookBudgetMs("abc")).toBe(DEFAULT_HOOK_BUDGET_MS);
    expect(resolveHookBudgetMs(0)).toBe(DEFAULT_HOOK_BUDGET_MS);
    expect(resolveHookBudgetMs(-5)).toBe(DEFAULT_HOOK_BUDGET_MS);
    expect(resolveHookBudgetMs(Number.NaN)).toBe(DEFAULT_HOOK_BUDGET_MS);
  });
  test("clamps into [MIN, MAX] and floors fractions; MAX keeps the host timeout under OpenClaw's policy ceiling", () => {
    expect(resolveHookBudgetMs(500)).toBe(MIN_HOOK_BUDGET_MS);
    expect(resolveHookBudgetMs(10_000_000)).toBe(MAX_HOOK_BUDGET_MS);
    expect(MAX_HOOK_BUDGET_MS).toBe(MAX_LEG_BUDGET_MS);
    expect(hostHookTimeoutMs({ hookBudgetMs: MAX_HOOK_BUDGET_MS })).toBeLessThanOrEqual(OPENCLAW_HOOK_TIMEOUT_POLICY_MAX_MS);
    expect(resolveHookBudgetMs(6500.9)).toBe(6500);
    expect(resolveHookBudgetMs("8000")).toBe(8000);
  });
});

describe("the plugin's clamp and the hook's budget parser agree (v0.38+)", () => {
  test("DEFAULT, MIN and MAX equal the hook's own; MAX is the wire ceiling", () => {
    expect(DEFAULT_HOOK_BUDGET_MS).toBe(HOOK_DEFAULT_BUDGET_MS);
    expect(MIN_HOOK_BUDGET_MS).toBe(HOOK_MIN_BUDGET_MS);
    expect(MAX_HOOK_BUDGET_MS).toBe(HOOK_MAX_BUDGET_MS);
    expect(MAX_HOOK_BUDGET_MS).toBe(MAX_LEG_BUDGET_MS);
  });
  test("every value the plugin can hand the hook is accepted unchanged; one past MAX is refused", () => {
    for (const raw of [undefined, "abc", 0, -5, 500, 6500.9, "8000", DEFAULT_HOOK_BUDGET_MS, MAX_HOOK_BUDGET_MS, MAX_HOOK_BUDGET_MS + 1, 60_000, 10_000_000]) {
      const passed = resolveHookBudgetMs(raw);
      const parsed = parseHookBudgetConfig(String(passed));
      expect(parsed.valid).toBe(true);
      expect(parsed.effectiveMs).toBe(passed);
    }
    expect(parseHookBudgetConfig(String(MAX_HOOK_BUDGET_MS + 1)).valid).toBe(false);
  });
  test("the manifest's schema bounds and help text carry the same range", async () => {
    const manifest = await Bun.file(MANIFEST_PATH).json();
    expect(manifest.configSchema.properties.hookBudgetMs.minimum).toBe(MIN_HOOK_BUDGET_MS);
    expect(manifest.configSchema.properties.hookBudgetMs.maximum).toBe(MAX_HOOK_BUDGET_MS);
    expect(manifest.uiHints.hookBudgetMs.help).toContain(`${MIN_HOOK_BUDGET_MS}-${MAX_HOOK_BUDGET_MS}`);
  });
});

describe("derived timeouts stay ordered inner < kill < host", () => {
  test("default budget", () => {
    const cfg = { hookBudgetMs: DEFAULT_HOOK_BUDGET_MS };
    expect(contextSurfacingKillTimeoutMs(cfg)).toBe(DEFAULT_HOOK_BUDGET_MS + HOOK_KILL_MARGIN_MS);
    expect(hostHookTimeoutMs(cfg)).toBe(DEFAULT_HOOK_BUDGET_MS + HOOK_KILL_MARGIN_MS + HOST_TIMEOUT_MARGIN_MS);
  });
  test("a legacy config object without hookBudgetMs still yields finite defaults", () => {
    const legacy = {} as unknown as Pick<ClawMemConfig, "hookBudgetMs">;
    expect(contextSurfacingKillTimeoutMs(legacy)).toBe(DEFAULT_HOOK_BUDGET_MS + HOOK_KILL_MARGIN_MS);
    expect(Number.isFinite(hostHookTimeoutMs(legacy))).toBe(true);
  });
});

describe("plugin registration wires the budget and the tool contract", () => {
  test("default config: before_prompt_build gets timeoutMs = host timeout; tools match contracts.tools", async () => {
    const { api, ons, tools } = fakeApi({});
    clawmemPlugin.register(api as any);
    const bpb = ons.find((o) => o.name === "before_prompt_build");
    expect(bpb?.opts?.timeoutMs).toBe(hostHookTimeoutMs({ hookBudgetMs: DEFAULT_HOOK_BUDGET_MS }));
    const manifest = await Bun.file(MANIFEST_PATH).json();
    const declared = [...(manifest.contracts?.tools ?? [])].sort();
    expect(declared.length).toBeGreaterThan(0);
    expect([...tools].sort()).toEqual(declared);
    const fromFactory = createTools({ clawmemBin: "clawmem", tokenBudget: 800, profile: "balanced", enableTools: true, servePort: 7438, hookBudgetMs: 6000, env: {} }, quietLogger).map((t) => t.name).sort();
    expect(fromFactory).toEqual(declared);
  });

  test("configured hookBudgetMs flows into the host timeout and the registration log line", () => {
    const { api, ons, infos } = fakeApi({ hookBudgetMs: 12_000 });
    clawmemPlugin.register(api as any);
    const bpb = ons.find((o) => o.name === "before_prompt_build");
    expect(bpb?.opts?.timeoutMs).toBe(12_000 + HOOK_KILL_MARGIN_MS + HOST_TIMEOUT_MARGIN_MS);
    expect(infos.some((m) => m.includes("hookBudgetMs=12000"))).toBe(true);
  });

  test("profile=deep without rerank/LLM endpoints warns once; endpoints or another profile do not", () => {
    const bare = fakeApi({ profile: "deep" });
    clawmemPlugin.register(bare.api as any);
    expect(bare.warns.filter((m) => m.includes("profile=deep")).length).toBe(1);
    expect(bare.warns[0]).toContain("expansion and rerank degrade to fused order");

    const llmOnly = fakeApi({ profile: "deep", gpuLlm: "http://gpu:8089" });
    clawmemPlugin.register(llmOnly.api as any);
    expect(llmOnly.warns[0]).toContain("rerank degrades to fused order");
    expect(llmOnly.warns[0]).not.toContain("expansion");

    const rerankOnly = fakeApi({ profile: "deep", gpuRerank: "http://gpu:8090" });
    clawmemPlugin.register(rerankOnly.api as any);
    expect(rerankOnly.warns[0]).toContain("expansion degrades to fused order");

    const wired = fakeApi({ profile: "deep", gpuRerank: "http://gpu:8090", gpuLlm: "http://gpu:8089" });
    clawmemPlugin.register(wired.api as any);
    expect(wired.warns.some((m) => m.includes("profile=deep"))).toBe(false);

    process.env.CLAWMEM_RERANK_URL = "http://gpu:8090";
    process.env.CLAWMEM_LLM_URL = "http://gpu:8089";
    const inherited = fakeApi({ profile: "deep" });
    clawmemPlugin.register(inherited.api as any);
    expect(inherited.warns.some((m) => m.includes("profile=deep"))).toBe(false);

    const balanced = fakeApi({ profile: "balanced" });
    clawmemPlugin.register(balanced.api as any);
    expect(balanced.warns.some((m) => m.includes("profile=deep"))).toBe(false);
  });
});

describe("before_prompt_build passes the kill timeout to the context-surfacing child", () => {
  const seen: { name: string; timeout?: number; env: Record<string, string> }[] = [];
  const captureExecHook: ExecHookFn = async (cfg, hookName, _input, timeout) => {
    seen.push({ name: hookName, timeout, env: cfg.env });
    return { stdout: "", stderr: "", exitCode: 0 };
  };
  beforeEach(() => {
    seen.length = 0;
    _resetAllSessionStateForTests();
    setHookRunnerForTests({ execHook: captureExecHook });
    setSessionFileResolverForTests(() => undefined);
  });
  afterEach(() => {
    restoreHookRunnerForTests();
    restoreSessionFileResolverForTests();
  });
  test("timeout = hookBudgetMs + kill margin; env carries CLAWMEM_HOOK_BUDGET_MS", async () => {
    const cfg: ClawMemConfig = {
      clawmemBin: "clawmem", tokenBudget: 800, profile: "balanced", enableTools: false, servePort: 7438,
      hookBudgetMs: 5000, env: { CLAWMEM_HOOK_BUDGET_MS: "5000" },
    };
    await handleBeforePromptBuild(
      cfg,
      { contextWindowTokens: 112_000, reserveTokensFloor: 8_000, softThresholdTokens: 4_000, precompactProximityRatio: 0.85 },
      quietLogger,
      { prompt: "a prompt long enough to surface", messages: [] },
      { sessionId: "budget-session", agentId: "main" },
    );
    const surf = seen.find((s) => s.name === "context-surfacing");
    expect(surf?.timeout).toBe(5000 + HOOK_KILL_MARGIN_MS);
    expect(surf?.env.CLAWMEM_HOOK_BUDGET_MS).toBe("5000");
  });
});

describe("execHook timeout message names the hook, the profile, and the budget", () => {
  test("a child that outlives its kill timeout fails open with a diagnosable message", async () => {
    const dir = mkdtempSync(join(tmpdir(), "clawmem-hook-budget-"));
    const bin = join(dir, "slow-clawmem");
    writeFileSync(bin, "#!/bin/sh\nsleep 3\n", { mode: 0o755 });
    chmodSync(bin, 0o755);
    try {
      const cfg: ClawMemConfig = { clawmemBin: bin, tokenBudget: 800, profile: "deep", enableTools: false, servePort: 7438, hookBudgetMs: 6000, env: {} };
      const r = await execHook(cfg, "context-surfacing", {}, 300);
      expect(r.exitCode).not.toBe(0);
      expect(r.stderr).toContain("timeout after 300ms (hook=context-surfacing, profile=deep, hookBudgetMs=6000)");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
