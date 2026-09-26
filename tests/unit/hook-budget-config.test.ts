/**
 * O1 §2 (codex rev-6 F4 / rev-7 F4 / rev-8 F4): the hook-budget parse table.
 *
 * Normalize EXACTLY as before (fallback, clamp, floor) — the publicly
 * documented behaviors survive verbatim — THEN validate the effective integer
 * against the supported maximum. The accepted branch carries the branded
 * budget; the rejected branch carries diagnostics and NO usable budget.
 */
import { describe, it, expect, afterEach } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  contextSurfacing,
  readInstalledHookBudget,
  parseHookBudgetConfig,
  assertHookBudgetConfig,
  HookBudgetConfigError,
  DEFAULT_HOOK_BUDGET_MS,
  MIN_HOOK_BUDGET_MS,
  MAX_HOOK_BUDGET_MS,
} from "../../src/hooks/context-surfacing.ts";
import { MAX_LEG_BUDGET_MS } from "../../src/vector-protocol.ts";
import { evidenceMs } from "../../src/clock.ts";
import { newSurfacingTrace } from "../../src/eval/hook-trace.ts";
import { makeEmptyOutput } from "../../src/hooks.ts";
import { createTestStore } from "../helpers/test-store.ts";

const accepted = (raw: string | undefined): number => {
  const cfg = parseHookBudgetConfig(raw);
  if (!cfg.valid) throw new Error(`expected ${JSON.stringify(raw)} accepted, got: ${cfg.reason}`);
  expect(cfg.effectiveMs).toBe(cfg.budget);
  return cfg.effectiveMs;
};

describe("parseHookBudgetConfig — the O1 §2 table", () => {
  it("undefined / empty / whitespace → the default (UNCHANGED, documented)", () => {
    expect(accepted(undefined)).toBe(DEFAULT_HOOK_BUDGET_MS);
    expect(accepted("")).toBe(DEFAULT_HOOK_BUDGET_MS);
    expect(accepted("   ")).toBe(DEFAULT_HOOK_BUDGET_MS);
    expect(parseHookBudgetConfig(undefined)).toMatchObject({ valid: true, note: null });
  });

  it("NaN / ±Infinity / non-numeric / non-positive → the default with a NOTE, never a refusal (UNCHANGED, documented)", () => {
    for (const raw of ["NaN", "Infinity", "-Infinity", "abc", "0", "-5", "-0.1"]) {
      const cfg = parseHookBudgetConfig(raw);
      expect(cfg.valid).toBe(true);
      expect(accepted(raw)).toBe(DEFAULT_HOOK_BUDGET_MS);
      if (cfg.valid) expect(cfg.note).toContain("default");
    }
  });

  it("whitespace-padded numeric parses normally (UNCHANGED)", () => {
    expect(accepted(" 8000 ")).toBe(8000);
  });

  it("finite 0 < n < MIN clamps UP to the minimum (UNCHANGED, documented)", () => {
    expect(accepted("500")).toBe(MIN_HOOK_BUDGET_MS);
    expect(accepted("0.5")).toBe(MIN_HOOK_BUDGET_MS);
    expect(accepted("999.99")).toBe(MIN_HOOK_BUDGET_MS);
  });

  it("finite MIN ≤ n ≤ MAX floors and is accepted (UNCHANGED)", () => {
    expect(accepted("1000")).toBe(1000);
    expect(accepted("6000")).toBe(6000);
    expect(accepted("7500.7")).toBe(7500);
    expect(accepted(String(MAX_HOOK_BUDGET_MS))).toBe(MAX_HOOK_BUDGET_MS);
  });

  it("`25000.9` FLOORS to the supported 25000 and is accepted — rev 7 wrongly refused this (order: normalize, then validate)", () => {
    expect(accepted("25000.9")).toBe(25000);
    const cfg = parseHookBudgetConfig("25000.9");
    if (cfg.valid) expect(cfg.note).toContain("normalized to 25000ms");
  });

  it("`3e4` normalizes to 30000 and is REFUSED (NEW) — the rejected branch carries diagnostics and no budget", () => {
    const cfg = parseHookBudgetConfig("3e4");
    expect(cfg.valid).toBe(false);
    if (!cfg.valid) {
      expect(cfg.raw).toBe("3e4");
      expect(cfg.effectiveMs).toBe(30000);
      expect(cfg.reason).toContain("30000ms");
      expect(cfg.reason).toContain(`maximum ${MAX_HOOK_BUDGET_MS}ms`);
      expect(cfg.reason).toContain("27s");
      expect("budget" in cfg).toBe(false);
    }
  });

  it("an effective integer above MAX is REFUSED — the only breaking case (NEW); MAX + 1 is the boundary", () => {
    expect(parseHookBudgetConfig(String(MAX_HOOK_BUDGET_MS + 1)).valid).toBe(false);
    expect(parseHookBudgetConfig(String(MAX_HOOK_BUDGET_MS + 0.5)).valid).toBe(true); // floors to MAX
    expect(parseHookBudgetConfig("60000").valid).toBe(false);
  });

  it("the ceiling EQUALS the daemon wire's leg ceiling (a deep leg may inherit nearly the whole window)", () => {
    expect(MAX_HOOK_BUDGET_MS).toBe(MAX_LEG_BUDGET_MS);
    expect(MAX_HOOK_BUDGET_MS).toBe(25_000);
  });
});

describe("assertHookBudgetConfig — the startup gate", () => {
  it("returns the accepted budget and throws a HookBudgetConfigError for an unsupported one", () => {
    expect(evidenceMs(assertHookBudgetConfig("8000"))).toBe(8000);
    expect(evidenceMs(assertHookBudgetConfig(undefined))).toBe(DEFAULT_HOOK_BUDGET_MS);
    expect(() => assertHookBudgetConfig("30000")).toThrow(HookBudgetConfigError);
    expect(() => assertHookBudgetConfig("3e4")).toThrow(/above the supported maximum/);
  });

  it("reads the process environment by default — no module-level constant can hand out a budget under an invalid config", () => {
    const prev = process.env.CLAWMEM_HOOK_BUDGET_MS;
    try {
      process.env.CLAWMEM_HOOK_BUDGET_MS = "9000";
      expect(evidenceMs(assertHookBudgetConfig())).toBe(9000);
      process.env.CLAWMEM_HOOK_BUDGET_MS = "40000";
      expect(() => assertHookBudgetConfig()).toThrow(HookBudgetConfigError);
    } finally {
      if (prev === undefined) delete process.env.CLAWMEM_HOOK_BUDGET_MS; else process.env.CLAWMEM_HOOK_BUDGET_MS = prev;
    }
  });
});

describe("codex migration r1 P1: an unsupported budget is refused at TRUE handler entry — before the turn-index read, the gates, or any early return", () => {
  const KEYS = ["CLAWMEM_HOOK_BUDGET_MS", "CLAWMEM_HOOK_DEDUP_WINDOW_SEC", "CLAWMEM_HEARTBEAT_PATTERNS"];
  const saved: Record<string, string | undefined> = {};
  for (const k of KEYS) saved[k] = process.env[k];
  afterEach(() => { for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });

  // Each prompt is first proven (under a VALID budget) to take exactly the early return named, so
  // the refusal below is a refusal of THAT path — not of some later one.
  const cases = [
    { name: "empty prompt", prompt: "", reason: "gate:empty-prompt" },
    { name: "short prompt", prompt: "hi there", reason: "gate:short-prompt" },
    { name: "slash command", prompt: "/compact the whole session context please", reason: "gate:slash-command" },
    { name: "heartbeat", prompt: "scheduler keepalive tick for the agent loop", reason: "gate:heartbeat" },
  ] as const;
  for (const c of cases) {
    it(`${c.name}: refused (HookBudgetConfigError) with ZERO context_usage rows — pre-fix it returned empty and logged the turn`, async () => {
      process.env.CLAWMEM_HOOK_DEDUP_WINDOW_SEC = "0";
      process.env.CLAWMEM_HEARTBEAT_PATTERNS = "keepalive tick";
      const store = createTestStore();
      const rows = (sid: string) => (store.db.prepare(`SELECT COUNT(*) AS n FROM context_usage WHERE session_id = ?`).get(sid) as { n: number }).n;
      process.env.CLAWMEM_HOOK_BUDGET_MS = "4000";
      const trace = newSurfacingTrace();
      await contextSurfacing(store, { prompt: c.prompt, sessionId: `p1-ok-${c.name}` }, { trace });
      expect(trace.emptyReason).toBe(c.reason);
      process.env.CLAWMEM_HOOK_BUDGET_MS = "30000"; // above MAX_HOOK_BUDGET_MS
      await expect(contextSurfacing(store, { prompt: c.prompt, sessionId: `p1-bad-${c.name}` })).rejects.toThrow(HookBudgetConfigError);
      expect(rows(`p1-bad-${c.name}`)).toBe(0);
      store.close();
    });
  }
});

describe("codex migration r1 P1: the CLI refuses BEFORE stdin is read or the store is opened", () => {
  it("an unsupported budget → the stderr refusal line, the empty (fail-open) output, and NO index file created", () => {
    const dir = mkdtempSync(join(tmpdir(), "clawmem-p1-cli-"));
    try {
      const cfgDir = join(dir, "cfg");
      mkdirSync(cfgDir, { recursive: true });
      const indexPath = join(dir, "never-opened.sqlite");
      const env = { ...process.env, INDEX_PATH: indexPath, CLAWMEM_CONFIG_DIR: cfgDir, CLAWMEM_HOOK_BUDGET_MS: "30000" } as Record<string, string>;
      delete env.CLAWMEM_JUDGE_SPAWN;
      const cli = join(import.meta.dir, "../../src/clawmem.ts");
      const proc = Bun.spawnSync([process.execPath, cli, "hook", "context-surfacing"], {
        env,
        stdin: Buffer.from(JSON.stringify({ session_id: "p1-cli", prompt: "explain the release train cadence decision", hook_event_name: "UserPromptSubmit" })),
      });
      expect(proc.stderr.toString()).toContain("[clawmem] context-surfacing refused:");
      const jsonLine = proc.stdout.toString().trim().split("\n").reverse().find(l => l.startsWith("{"));
      expect(JSON.parse(jsonLine!)).toEqual(JSON.parse(JSON.stringify(makeEmptyOutput("context-surfacing"))));
      expect(existsSync(indexPath)).toBe(false); // pre-fix: the store was opened (and the file created) before the check
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("codex migration r1 P5: readInstalledHookBudget reads the installed assignment STRUCTURALLY", () => {
  const cmd = (prefix: string) => `${prefix} /opt/bin/clawmem hook context-surfacing`;
  it("the canonical form `setup hooks` writes is ASSIGNED and parsed exactly as the hook parses it", () => {
    const r = readInstalledHookBudget(cmd("CLAWMEM_HOOK_BUDGET_MS=8000"));
    expect(r.kind).toBe("assigned");
    if (r.kind === "assigned") { expect(r.raw).toBe("8000"); expect(r.config.valid).toBe(true); expect(r.config.effectiveMs).toBe(8000); }
    // Other plain prefix assignments may sit beside it.
    expect(readInstalledHookBudget(cmd("CLAWMEM_PROFILE=deep CLAWMEM_HOOK_BUDGET_MS=9000")).kind).toBe("assigned");
  });
  it("an unsupported PLAIN value is assigned and REFUSED by the parser — reported, never hidden", () => {
    for (const v of ["3e4", "30000", "25001"]) {
      const r = readInstalledHookBudget(cmd(`CLAWMEM_HOOK_BUDGET_MS=${v}`));
      expect(r.kind).toBe("assigned");
      if (r.kind === "assigned") expect(r.config.valid).toBe(false);
    }
  });
  it("no mention → absent (the ambient budget applies, as before)", () => {
    expect(readInstalledHookBudget("/opt/bin/clawmem hook context-surfacing")).toEqual({ kind: "absent" });
  });
  it("every form whose passed value cannot be verified is NONCANONICAL — pre-fix `\\S+` read `\"30000\"` as a non-number and reported the DEFAULT green", () => {
    for (const bad of [
      cmd(`CLAWMEM_HOOK_BUDGET_MS="30000"`),
      cmd(`CLAWMEM_HOOK_BUDGET_MS='3e4'`),
      cmd(`CLAWMEM_HOOK_BUDGET_MS=$BUDGET`),
      cmd(`env CLAWMEM_HOOK_BUDGET_MS=8000`),
      `export CLAWMEM_HOOK_BUDGET_MS=8000; /opt/bin/clawmem hook context-surfacing`,
      `/opt/bin/clawmem hook context-surfacing CLAWMEM_HOOK_BUDGET_MS=8000`,
      cmd(`CLAWMEM_HOOK_BUDGET_MS=8000 CLAWMEM_HOOK_BUDGET_MS=9000`),
      cmd(`FOO="a b" CLAWMEM_HOOK_BUDGET_MS=8000`),
    ]) {
      expect(readInstalledHookBudget(bad).kind).toBe("noncanonical");
    }
  });
});
