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

  it("an adequate installed pair passes the budget check (control — the red line is this check's doing)", () => {
    const out = runDoctor(hookSettings(12, 10000));
    expect(out).toContain("✓ Hook timeout budget");
    expect(out).not.toContain("✗ Hook timeout budget");
  }, 90_000);
});
