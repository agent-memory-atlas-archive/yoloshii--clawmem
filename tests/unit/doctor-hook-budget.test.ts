/**
 * BUILD-3a (codex turn-24 finding 2): the doctor hook-timeout-budget check
 * at its production boundary — the REAL CLI with an isolated HOME
 * (CLAWMEM_NO_LOCAL_MODELS + unreachable loopback endpoints keep the other
 * doctor sections fail-fast). The undersized installed pair must produce
 * the red line AND a non-success summary (the issues counter, codex
 * turn-23 finding 2's fix).
 */
import { describe, it, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const ROOT = join(import.meta.dir, "../..");

function runDoctor(settings: unknown): string {
  const home = mkdtempSync(join(tmpdir(), "clawmem-doctor-"));
  try {
    mkdirSync(join(home, ".claude"), { recursive: true });
    writeFileSync(join(home, ".claude", "settings.json"), JSON.stringify(settings));
    const env = { ...process.env } as Record<string, string>;
    env.HOME = home;
    env.CLAWMEM_NO_LOCAL_MODELS = "true";
    env.CLAWMEM_EMBED_URL = "http://127.0.0.1:1";
    env.CLAWMEM_LLM_URL = "http://127.0.0.1:1";
    env.CLAWMEM_RERANK_URL = "http://127.0.0.1:1";
    delete env.CLAWMEM_HOOK_BUDGET_MS; // the INSTALLED budget must drive the check, not ambient env
    const proc = Bun.spawnSync([process.execPath, "src/clawmem.ts", "doctor"], { env, cwd: ROOT });
    return proc.stdout.toString() + proc.stderr.toString();
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

function rawHookSettings(entries: { command: string; timeout: number }[]): unknown {
  return { hooks: { UserPromptSubmit: [{ matcher: "", hooks: entries.map(e => ({ type: "command", ...e })) }] } };
}

function hookSettings(timeoutSec: number, budgetMs: number): unknown {
  return {
    hooks: {
      UserPromptSubmit: [{
        matcher: "",
        hooks: [{ type: "command", command: `CLAWMEM_HOOK_BUDGET_MS=${budgetMs} /fake/clawmem hook context-surfacing`, timeout: timeoutSec }],
      }],
    },
  };
}

describe("doctor — hook timeout budget at the production boundary (codex turn-24 F2)", () => {
  it("an undersized installed pair produces the red line, uses the INSTALLED budget, and the summary is NOT success", () => {
    const out = runDoctor(hookSettings(3, 10000));
    expect(out).toContain("✗ Hook timeout budget");
    expect(out).toContain("internal budget 10000ms (installed)");
    expect(out).toContain("issue(s) found.");
    expect(out).not.toContain("All checks passed.");
  }, 90_000);

  it("O1 §2: an UNSUPPORTED installed budget is REPORTED (red line, issue counted) — the doctor never crashes on it", () => {
    const out = runDoctor(hookSettings(31, 30000));
    expect(out).toContain("✗ Hook budget");
    expect(out).toContain("30000ms");
    expect(out).toContain("(installed)");
    expect(out).toContain("issue(s) found.");
    expect(out).not.toContain("All checks passed.");
  }, 90_000);

  it("an adequate installed pair passes the budget check (control — the red line is this check's doing)", () => {
    const out = runDoctor(hookSettings(12, 10000));
    expect(out).toContain("✓ Hook timeout budget");
    expect(out).not.toContain("✗ Hook timeout budget");
  }, 90_000);

  it("codex migration r1 P5: a QUOTED installed budget is reported UNVERIFIED (red, issue counted) — pre-fix `\\S+` kept the quotes, parsed a non-number as the default, and passed", () => {
    for (const quoted of [`"30000"`, `"3e4"`]) {
      const out = runDoctor(rawHookSettings([{ command: `CLAWMEM_HOOK_BUDGET_MS=${quoted} /fake/clawmem hook context-surfacing`, timeout: 40 }]));
      expect(out).toContain("✗ Hook budget");
      expect(out).toContain("UNVERIFIED");
      expect(out).not.toContain("✓ Hook timeout budget");
      expect(out).toContain("issue(s) found.");
    }
  }, 180_000);

  it("codex migration r1 P5: EVERY entry is validated — an undersized FIRST entry is red even when the last one is adequate (pre-fix: last-entry-wins → green)", () => {
    const out = runDoctor(rawHookSettings([
      { command: "CLAWMEM_HOOK_BUDGET_MS=10000 /fake/clawmem hook context-surfacing", timeout: 3 },
      { command: "CLAWMEM_HOOK_BUDGET_MS=10000 /fake/clawmem hook context-surfacing", timeout: 12 },
    ]));
    expect(out).toContain("✗ Hook timeout budget [entry 1/2]");
    expect(out).toContain("✓ Hook timeout budget [entry 2/2]");
    expect(out).toContain("issue(s) found.");
  }, 90_000);

  it("codex migration r1 P5: entries with CONFLICTING budgets are red — the hook would execute under more than one budget", () => {
    const out = runDoctor(rawHookSettings([
      { command: "CLAWMEM_HOOK_BUDGET_MS=8000 /fake/clawmem hook context-surfacing", timeout: 20 },
      { command: "CLAWMEM_HOOK_BUDGET_MS=12000 /fake/clawmem hook context-surfacing", timeout: 20 },
    ]));
    expect(out).toContain("CONFLICT (8000ms vs 12000ms)");
    expect(out).toContain("issue(s) found.");
    expect(out).not.toContain("All checks passed.");
  }, 90_000);
});