/**
 * v0.41.1: the test suite never reads the user's ClawMem configuration or opens the user's vaults.
 *
 * Baseline (v0.41.0): nothing isolated the suite. `loadVaultConfig()` falls back to `~/.config/clawmem/config.yaml`
 * when `CLAWMEM_CONFIG_DIR` is unset, and `resolveStore(name)` opens a configured named vault writable — the
 * test-mode guard in `getDefaultDbPath` covers only the general vault. So a test that called `feedbackLoop` without
 * explicit vaults opened the developer's real skill vault and migrated it (the v0.41 stop schema and its triggers
 * installed on a live vault by `bun test tests/unit/stop-feedback.test.ts`). And since every file runs in one process,
 * one test deleting `CLAWMEM_CONFIG_DIR` after each of its tests (indexer-boundary.test.ts) re-exposed the real
 * configuration to every test after it. `tests/preload.ts` (bunfig.toml) now points the suite at an empty scratch
 * config directory before any test loads, and back at it whenever a test leaves it unset.
 */
import { describe, it, expect } from "bun:test";
import { homedir, tmpdir } from "os";
import { join, resolve, sep } from "path";
import { clearConfigCache, loadVaultConfig } from "../../src/config.ts";

const scratch = (globalThis as { __clawmemTestConfigDir?: string }).__clawmemTestConfigDir;
/** Where the suite's own vaults live: mkdtemp under tmpdir(), or a fixed /tmp path. Never a user's vault. */
const inScratch = (p: string) => [tmpdir(), "/tmp"].some(root => resolve(p).startsWith(resolve(root) + sep));

describe("the suite is isolated from the user's ClawMem state (v0.41.1)", () => {
  it("the preload points the suite's config directory at a scratch directory, never ~/.config/clawmem", () => {
    expect(scratch).toBeTruthy();
    expect(resolve(scratch!)).not.toBe(resolve(join(homedir(), ".config", "clawmem")));
    expect(resolve(scratch!).startsWith(resolve(tmpdir()) + sep)).toBe(true);
  });

  it("a test that deletes CLAWMEM_CONFIG_DIR …", () => {
    delete process.env.CLAWMEM_CONFIG_DIR;
  });

  it("… leaves the next test on the scratch directory, and every vault it can see is a scratch vault", () => {
    expect(scratch).toBeTruthy();
    expect(process.env.CLAWMEM_CONFIG_DIR).toBe(scratch!);
    clearConfigCache();
    try {
      for (const p of Object.values(loadVaultConfig().vaults)) expect(inScratch(p)).toBe(true);
    } finally {
      clearConfigCache();
    }
  });

  it("a child process started with the suite's environment reads the same scratch configuration", () => {
    expect(scratch).toBeTruthy();
    const config = join(import.meta.dir, "../../src/config.ts");
    const script = `const { loadVaultConfig } = await import(${JSON.stringify(config)}); ` +
      `console.log(JSON.stringify({ dir: process.env.CLAWMEM_CONFIG_DIR ?? null, vaults: loadVaultConfig().vaults }));`;
    const r = Bun.spawnSync([process.execPath, "-e", script], { env: { ...process.env } as Record<string, string> });
    expect(r.exitCode).toBe(0);
    const child = JSON.parse(r.stdout.toString().trim().split("\n").at(-1)!) as { dir: string | null; vaults: Record<string, string> };
    expect(child.dir).toBe(scratch!);
    for (const p of Object.values(child.vaults)) expect(inScratch(p)).toBe(true);
  });
});
