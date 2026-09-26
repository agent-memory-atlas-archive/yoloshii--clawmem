/**
 * BUILD-3a (C2c/C3): `clawmem setup hooks` derives the UserPromptSubmit HOST
 * timeout from the hook's INTERNAL budget — host ≥ startup allowance +
 * budget — and never reduces an already-installed larger timeout. Runs the
 * real CLI in a subprocess with an isolated HOME.
 */
import { describe, it, expect } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { STARTUP_ALLOWANCE_MS, DEFAULT_HOOK_BUDGET_MS } from "../../src/hooks/context-surfacing.ts";

const ROOT = join(import.meta.dir, "../..");

function runSetupHooks(home: string, budgetEnv?: string): { exitCode: number; stderr: string } {
  const env = { ...process.env } as Record<string, string>;
  env.HOME = home;
  delete env.CLAWMEM_HOOK_BUDGET_MS;
  if (budgetEnv !== undefined) env.CLAWMEM_HOOK_BUDGET_MS = budgetEnv;
  const proc = Bun.spawnSync([process.execPath, "src/clawmem.ts", "setup", "hooks"], { env, cwd: ROOT });
  return { exitCode: proc.exitCode, stderr: proc.stderr.toString() };
}

function readUserPromptEntry(home: string): { timeout?: number; command?: string } {
  const settings = JSON.parse(readFileSync(join(home, ".claude", "settings.json"), "utf-8"));
  for (const entry of settings.hooks?.["UserPromptSubmit"] ?? []) {
    for (const h of entry.hooks ?? []) {
      if (h.command?.includes("context-surfacing")) return { timeout: h.timeout, command: h.command };
    }
  }
  return {};
}
const readUserPromptTimeout = (home: string): number | undefined => readUserPromptEntry(home).timeout;

describe("setup hooks — host timeout derived from the internal budget (BUILD-3a)", () => {
  it("default budget: writes the 8s floor (= ceil((startup + 6000)/1000) with the default constants)", () => {
    const home = mkdtempSync(join(tmpdir(), "clawmem-sethooks-def-"));
    try {
      mkdirSync(join(home, ".claude"), { recursive: true });
      const r = runSetupHooks(home);
      expect(r.exitCode).toBe(0);
      const expected = Math.max(8, Math.ceil((STARTUP_ALLOWANCE_MS + DEFAULT_HOOK_BUDGET_MS) / 1000));
      const entry = readUserPromptEntry(home);
      expect(entry.timeout).toBe(expected);
      // Codex turn-23 F4: the budget the timeout was derived from is
      // PERSISTED in the installed command — the pair lives in one entry.
      expect(entry.command).toContain(`CLAWMEM_HOOK_BUDGET_MS=${DEFAULT_HOOK_BUDGET_MS} `);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("a larger internal budget RAISES the host timeout: budget 10000 ⇒ ceil((1500+10000)/1000) = 12s", () => {
    const home = mkdtempSync(join(tmpdir(), "clawmem-sethooks-big-"));
    try {
      mkdirSync(join(home, ".claude"), { recursive: true });
      const r = runSetupHooks(home, "10000");
      expect(r.exitCode).toBe(0);
      const entry = readUserPromptEntry(home);
      expect(entry.timeout).toBe(Math.ceil((STARTUP_ALLOWANCE_MS + 10000) / 1000));
      expect(entry.command).toContain("CLAWMEM_HOOK_BUDGET_MS=10000 ");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("O1 §2: an UNSUPPORTED budget (above the maximum) is REFUSED at install — nothing is written, the reason names the value", () => {
    const home = mkdtempSync(join(tmpdir(), "clawmem-sethooks-max-"));
    try {
      mkdirSync(join(home, ".claude"), { recursive: true });
      const r = runSetupHooks(home, "3e4");
      expect(r.exitCode).not.toBe(0);
      expect(r.stderr).toContain("Refusing to install hooks");
      expect(r.stderr).toContain("30000ms");
      expect(existsSync(join(home, ".claude", "settings.json"))).toBe(false);
      // Control: the boundary value itself installs and pins the floored budget.
      const ok = runSetupHooks(home, "25000.9");
      expect(ok.exitCode).toBe(0);
      expect(readUserPromptEntry(home).command).toContain("CLAWMEM_HOOK_BUDGET_MS=25000 ");
      expect(readUserPromptTimeout(home)).toBe(Math.ceil((STARTUP_ALLOWANCE_MS + 25000) / 1000));
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("never reduces: an installed 30s clawmem timeout survives a re-install under the default budget", () => {
    const home = mkdtempSync(join(tmpdir(), "clawmem-sethooks-keep-"));
    try {
      mkdirSync(join(home, ".claude"), { recursive: true });
      writeFileSync(join(home, ".claude", "settings.json"), JSON.stringify({
        hooks: {
          UserPromptSubmit: [{
            matcher: "",
            hooks: [{ type: "command", command: "/some/path/clawmem hook context-surfacing", timeout: 30 }],
          }],
        },
      }));
      const r = runSetupHooks(home);
      expect(r.exitCode).toBe(0);
      expect(readUserPromptTimeout(home)).toBe(30);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
