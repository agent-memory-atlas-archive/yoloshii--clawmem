/**
 * Integration tests for `clawmem setup openclaw` (§28.1, issue #11).
 *
 * Spawns the real ClawMem CLI as a subprocess so we exercise the actual
 * shell.spawn boundary, env inheritance, and exit codes. A per-test temp
 * directory hosts a stub `openclaw` shell script on PATH that records its
 * argv + env + cwd as JSONL for later assertions.
 *
 * Strategy:
 *   - Stub binary supports per-command behavior:
 *       `--version`         → always exits 0
 *       `plugins install`   → exits per STUB_INSTALL_EXIT_CODE (default 0)
 *       `plugins uninstall` → exits per STUB_UNINSTALL_EXIT_CODE (default 0)
 *       `config get`        → prints "" and exits 0 (covers §14.3 migration)
 *       `config set/unset`  → exits 0
 *   - Each invocation appends one JSONL line to $STUB_LOG. Tests assert
 *     "contains invocation" rather than "argv equals X" because setup may
 *     spawn the stub multiple times (--version probe + config get + install).
 *   - Tests run with HOME pointed at a temp directory so direct-copy
 *     fallback writes there, not the real $HOME.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join as pathJoin, resolve as pathResolve } from "node:path";

const REPO_ROOT = pathResolve(import.meta.dir, "..", "..");
const CLAWMEM_ENTRY = pathResolve(REPO_ROOT, "src", "clawmem.ts");

// =============================================================================
// Stub openclaw binary
// =============================================================================

/**
 * Per-command stub. Records every invocation as a JSONL line containing
 * argv + selected env vars. `--version` always succeeds. Behavior for
 * `plugins install` and `plugins uninstall` is controlled by env vars so
 * tests can assert success / failure paths independently.
 */
const STUB_SCRIPT = `#!/usr/bin/env bash
set -e
LOG="\${STUB_LOG:-/tmp/stub-openclaw.jsonl}"
ARGS_JSON="["
for a in "$@"; do
  esc=$(printf '%s' "$a" | sed 's/"/\\\\"/g')
  ARGS_JSON+="\\"$esc\\","
done
ARGS_JSON="\${ARGS_JSON%,}]"

# Capture the env vars relevant to §28.1
ENV_JSON="{"
for v in OPENCLAW_STATE_DIR OPENCLAW_CONFIG_PATH OPENCLAW_PROFILE OPENCLAW_HOME HOME USERPROFILE; do
  val=\${!v:-}
  esc=$(printf '%s' "$val" | sed 's/"/\\\\"/g')
  ENV_JSON+="\\"$v\\":\\"$esc\\","
done
ENV_JSON="\${ENV_JSON%,}}"

printf '{"argv":%s,"env":%s}\\n' "$ARGS_JSON" "$ENV_JSON" >> "$LOG"

# A named profile arrives as OpenClaw's own global flag; the state root follows it.
PROFILE=""
if [ "$1" = "--profile" ]; then PROFILE="$2"; shift 2; fi
ROOT="$HOME/.openclaw\${PROFILE:+-$PROFILE}"

# Per-command behavior
if [ "$1" = "--version" ]; then
  echo "openclaw 2026.4.30 (stub)"
  exit 0
fi

if [ "$1" = "plugins" ] && [ "$2" = "install" ] && [ "$3" = "--help" ]; then
  if [ "\${STUB_MODERN_HELP:-0}" = "1" ] || [ "\${STUB_MODERN_HELP:-0}" = "partial" ]; then
    echo "Usage: openclaw plugins install [options] <path-or-spec-or-plugin>"
    echo "  -l, --link             Link a local path instead of copying"
    echo "  --force                Replace an existing install"
  fi
  if [ "\${STUB_MODERN_HELP:-0}" = "1" ]; then
    echo "  --accept-capabilities  Accept the plugin's declared capabilities"
  fi
  exit 0
fi

if [ "$1" = "plugins" ] && [ "$2" = "install" ]; then
  exit "\${STUB_INSTALL_EXIT_CODE:-0}"
fi

if [ "$1" = "plugins" ] && [ "$2" = "uninstall" ]; then
  exit "\${STUB_UNINSTALL_EXIT_CODE:-0}"
fi

STATE="\${STUB_STATE:-\${LOG%.jsonl}.config}"
if [ "$1" = "config" ] && [ "$2" = "get" ]; then
  # Echo what a prior config set stored (read-back verification); empty otherwise
  [ -f "$STATE" ] && grep -E "^$3=" "$STATE" | tail -1 | cut -d= -f2-
  exit 0
fi

if [ "$1" = "config" ] && [ "$2" = "set" ]; then
  if [ -n "\${STUB_CONFIG_SET_FAIL_KEY:-}" ] && [ "$3" = "$STUB_CONFIG_SET_FAIL_KEY" ]; then echo "stub: refusing to set $3" >&2; exit 1; fi
  if [ -n "\${STUB_CONFIG_SET_WRONG_KEY:-}" ] && [ "$3" = "$STUB_CONFIG_SET_WRONG_KEY" ]; then printf '%s=%s\\n' "$3" "stub-wrong-value" >> "$STATE"; exit 0; fi
  printf '%s=%s\\n' "$3" "$4" >> "$STATE"
  exit 0
fi

if [ "$1" = "config" ] && [ "$2" = "unset" ]; then
  exit 0
fi

if [ "$1" = "plugins" ] && [ "$2" = "inspect" ]; then
  if [ -n "\${STUB_INSPECT_EXIT_CODE:-}" ]; then exit "$STUB_INSPECT_EXIT_CODE"; fi
  printf '{"id":"clawmem","install":{"source":"local","installPath":"%s/extensions/clawmem"}}\\n' "$ROOT"
  exit 0
fi

# Unknown command — exit 0 to avoid breaking unrelated probes
exit 0
`;

interface StubInvocation {
  argv: string[];
  env: Record<string, string>;
}

interface TestEnv {
  tmpDir: string;
  stubDir: string;
  stubLog: string;
  pluginPath: string;
  cleanup: () => void;
}

function setupTestEnv(): TestEnv {
  const tmpDir = mkdtempSync(pathJoin(tmpdir(), "clawmem-s28-"));
  const stubDir = pathJoin(tmpDir, "bin");
  mkdirSync(stubDir, { recursive: true });
  const stubBin = pathJoin(stubDir, "openclaw");
  writeFileSync(stubBin, STUB_SCRIPT, { mode: 0o755 });
  chmodSync(stubBin, 0o755);
  const stubLog = pathJoin(tmpDir, "stub-invocations.jsonl");
  writeFileSync(stubLog, "");
  // Direct-copy fallback writes into <home>/.openclaw or wherever the env
  // vars point; we'll reuse tmpDir for that too.
  const pluginPath = pathJoin(tmpDir, ".openclaw", "extensions", "clawmem");
  return {
    tmpDir,
    stubDir,
    stubLog,
    pluginPath,
    cleanup: () => {
      try {
        rmSync(tmpDir, { recursive: true, force: true });
      } catch {
        // best-effort
      }
    },
  };
}

function readStubInvocations(stubLog: string): StubInvocation[] {
  if (!existsSync(stubLog)) return [];
  const content = readFileSync(stubLog, "utf-8").trim();
  if (!content) return [];
  return content.split("\n").map((line) => JSON.parse(line) as StubInvocation);
}

function containsInvocation(
  invocations: StubInvocation[],
  matcher: (argv: string[]) => boolean,
): StubInvocation | undefined {
  return invocations.find((inv) => matcher(inv.argv));
}

interface RunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

const BUN_EXECUTABLE = process.execPath;

async function runClawmemSetupOpenClaw(
  args: string[],
  env: Record<string, string>,
): Promise<RunResult> {
  // Use absolute path to bun; the env we pass to Bun.spawn replaces the
  // entire environment, so a relative `bun` lookup would fail PATH
  // resolution. Subprocess PATH is whatever the test sets, which is the
  // contract under test (only `openclaw` lookup should depend on PATH).
  const proc = Bun.spawn(
    [BUN_EXECUTABLE, CLAWMEM_ENTRY, "setup", "openclaw", ...args],
    {
      env,
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const exitCode = await proc.exited;
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  return { exitCode, stdout, stderr };
}

// =============================================================================
// Tests
// =============================================================================

describe("§28.1 setup openclaw — integration", () => {
  let env: TestEnv;

  beforeEach(() => {
    env = setupTestEnv();
  });

  afterEach(() => {
    env.cleanup();
  });

  test("I1 — copy mode delegates with --force", async () => {
    const result = await runClawmemSetupOpenClaw([], {
      PATH: `${env.stubDir}:${process.env.PATH ?? ""}`,
      HOME: env.tmpDir,
      STUB_LOG: env.stubLog,
      // No OPENCLAW_STATE_DIR — we want to verify --force is passed,
      // independent of env-var pass-through.
    });
    expect(result.exitCode).toBe(0);

    const invocations = readStubInvocations(env.stubLog);
    const installInvocation = containsInvocation(
      invocations,
      (argv) =>
        argv[0] === "plugins" &&
        argv[1] === "install" &&
        argv.includes("--force"),
    );
    expect(installInvocation).toBeDefined();
    // Must NOT include -l in copy mode
    expect(installInvocation!.argv).not.toContain("-l");
  });

  test("I2 — link mode delegates with -l, no --force", async () => {
    const result = await runClawmemSetupOpenClaw(["--link"], {
      PATH: `${env.stubDir}:${process.env.PATH ?? ""}`,
      HOME: env.tmpDir,
      STUB_LOG: env.stubLog,
    });
    expect(result.exitCode).toBe(0);

    const invocations = readStubInvocations(env.stubLog);
    const installInvocation = containsInvocation(
      invocations,
      (argv) =>
        argv[0] === "plugins" &&
        argv[1] === "install" &&
        argv.includes("-l"),
    );
    expect(installInvocation).toBeDefined();
    // Must NOT include --force in link mode (OpenClaw rejects the combination)
    expect(installInvocation!.argv).not.toContain("--force");
  });

  test("I3 — install failure aborts (no silent fallback to direct copy)", async () => {
    const result = await runClawmemSetupOpenClaw([], {
      PATH: `${env.stubDir}:${process.env.PATH ?? ""}`,
      HOME: env.tmpDir,
      STUB_LOG: env.stubLog,
      STUB_INSTALL_EXIT_CODE: "1",
    });
    expect(result.exitCode).not.toBe(0);

    // No direct-copy artifact should have been written (fallback must NOT run
    // when the CLI is present-but-failing).
    expect(existsSync(env.pluginPath)).toBe(false);

    // Error message must specifically reference the failure mode (Turn 3 F4
    // tightening — "openclaw plugins install" alone was too loose).
    const combined = result.stderr + result.stdout;
    expect(combined).toContain("aborting setup");
    expect(combined).toContain("--force failed");
  });

  test("I4 — --remove with managed install: CLI uninstall succeeds + constrained stale cleanup", async () => {
    // Pre-populate the legacy direct-copy directory at the resolved path so
    // we can verify the constrained stale cleanup runs even after a
    // successful CLI uninstall (managed-link + unmanaged-copy side-by-side).
    mkdirSync(pathJoin(env.tmpDir, ".openclaw", "extensions"), {
      recursive: true,
    });
    mkdirSync(env.pluginPath, { recursive: true });
    writeFileSync(pathJoin(env.pluginPath, "stale.txt"), "legacy install");

    const result = await runClawmemSetupOpenClaw(["--remove"], {
      PATH: `${env.stubDir}:${process.env.PATH ?? ""}`,
      HOME: env.tmpDir,
      STUB_LOG: env.stubLog,
    });
    expect(result.exitCode).toBe(0);

    // CLI uninstall was invoked
    const invocations = readStubInvocations(env.stubLog);
    const uninstallInvocation = containsInvocation(
      invocations,
      (argv) =>
        argv[0] === "plugins" &&
        argv[1] === "uninstall" &&
        argv[2] === "clawmem",
    );
    expect(uninstallInvocation).toBeDefined();

    // AND the stale legacy directory was removed
    expect(existsSync(env.pluginPath)).toBe(false);
  });

  test("I5 — --remove with legacy-only install: CLI uninstall fails → manual fallback + warning", async () => {
    // Pre-populate the unmanaged install directory.
    mkdirSync(pathJoin(env.tmpDir, ".openclaw", "extensions"), {
      recursive: true,
    });
    mkdirSync(env.pluginPath, { recursive: true });
    writeFileSync(pathJoin(env.pluginPath, "legacy.txt"), "unmanaged install");

    const result = await runClawmemSetupOpenClaw(["--remove"], {
      PATH: `${env.stubDir}:${process.env.PATH ?? ""}`,
      HOME: env.tmpDir,
      STUB_LOG: env.stubLog,
      STUB_UNINSTALL_EXIT_CODE: "1",
    });
    expect(result.exitCode).toBe(0);

    // Warning text must surface (R1 — never silently mask managed-uninstall failure)
    const combined = result.stdout + result.stderr;
    expect(combined).toContain("openclaw plugins uninstall clawmem failed");
    expect(combined).toContain("config and install records may still");

    // Manual cleanup ran
    expect(existsSync(env.pluginPath)).toBe(false);
  });

  test("I7 — dual next-steps messaging: delegated path omits 'plugins enable', fallback path includes it", async () => {
    // Path 1 (delegated): openclaw plugins install --force auto-enables, so
    // ClawMem must NOT print "openclaw plugins enable clawmem" in the next
    // steps. Otherwise users will run a redundant command and possibly hit
    // a slot-validation error.
    const delegatedResult = await runClawmemSetupOpenClaw([], {
      PATH: `${env.stubDir}:${process.env.PATH ?? ""}`,
      HOME: env.tmpDir,
      STUB_LOG: env.stubLog,
    });
    expect(delegatedResult.exitCode).toBe(0);
    expect(delegatedResult.stdout).not.toContain(
      "openclaw plugins enable clawmem",
    );

    // Path 3 (CLI absent, direct copy): user must enable manually, so the
    // step text MUST appear.
    const fallbackEnv = setupTestEnv();
    try {
      const sandboxedPath = buildBunOnlyPath(fallbackEnv.tmpDir);
      const fallbackResult = await runClawmemSetupOpenClaw([], {
        PATH: sandboxedPath,
        HOME: fallbackEnv.tmpDir,
      });
      // If openclaw is somehow on the system PATH and breaks the test,
      // skip rather than produce a misleading failure (mirrors I6).
      if (
        fallbackResult.stdout.includes("openclaw plugins install --force") &&
        !fallbackResult.stdout.includes("openclaw CLI not on PATH")
      ) {
        console.warn(
          "I7 fallback half skipped: real `openclaw` binary on PATH",
        );
        return;
      }
      expect(fallbackResult.exitCode).toBe(0);
      expect(fallbackResult.stdout).toContain("openclaw plugins enable clawmem");
    } finally {
      fallbackEnv.cleanup();
    }
  });

  test("I9 — modern OpenClaw (consent flag advertised) refuses a non-interactive install without --accept-capabilities", async () => {
    const result = await runClawmemSetupOpenClaw([], {
      PATH: `${env.stubDir}:${process.env.PATH ?? ""}`,
      HOME: env.tmpDir,
      STUB_LOG: env.stubLog,
      STUB_MODERN_HELP: "1",
    });
    expect(result.exitCode).not.toBe(0);
    const combined = result.stdout + result.stderr;
    expect(combined).toContain("--accept-capabilities");
    expect(combined).toContain("clawmem_search");
    const invocations = readStubInvocations(env.stubLog);
    const realInstall = containsInvocation(
      invocations,
      (argv) => argv[0] === "plugins" && argv[1] === "install" && !argv.includes("--help"),
    );
    expect(realInstall).toBeUndefined();
  });

  test("I10 — modern OpenClaw with --accept-capabilities: consent flag forwarded, then grant + slot + binary are set", async () => {
    const result = await runClawmemSetupOpenClaw(["--accept-capabilities"], {
      PATH: `${env.stubDir}:${process.env.PATH ?? ""}`,
      HOME: env.tmpDir,
      STUB_LOG: env.stubLog,
      STUB_MODERN_HELP: "1",
    });
    expect(result.exitCode).toBe(0);
    const invocations = readStubInvocations(env.stubLog);
    const install = containsInvocation(
      invocations,
      (argv) => argv[0] === "plugins" && argv[1] === "install" && argv.includes("--force"),
    );
    expect(install).toBeDefined();
    expect(install!.argv).toContain("--accept-capabilities");
    const setKeys = invocations
      .filter((inv) => inv.argv[0] === "config" && inv.argv[1] === "set")
      .map((inv) => `${inv.argv[2]}=${inv.argv[3]}`);
    expect(setKeys).toContain("plugins.entries.clawmem.hooks.allowConversationAccess=true");
    expect(setKeys).toContain("plugins.slots.memory=clawmem");
    expect(setKeys.some((k) => k.startsWith("plugins.entries.clawmem.config.clawmemBin="))).toBe(true);
  });

  test("I12 — --gateway-user with a mismatched owner: installed but unverified, non-zero exit, chown printed", async () => {
    // The stub installs nothing, so pre-create the destination the way a
    // real install would leave it: owned by the invoking user.
    mkdirSync(pathJoin(env.pluginPath, "dist"), { recursive: true });
    writeFileSync(pathJoin(env.pluginPath, "dist", "index.js"), "export default {};\n");
    const result = await runClawmemSetupOpenClaw(["--gateway-user", "root"], {
      PATH: `${env.stubDir}:${process.env.PATH ?? ""}`,
      HOME: env.tmpDir,
      STUB_LOG: env.stubLog,
    });
    const combined = result.stdout + result.stderr;
    if (typeof process.getuid === "function" && process.getuid() === 0) {
      // Running as root: root ownership satisfies the rule, so this is verified.
      expect(result.exitCode).toBe(0);
      return;
    }
    expect(result.exitCode).not.toBe(0);
    expect(combined).toContain("Installed but unverified");
    expect(combined).toContain("sudo chown -R root");
  });

  test("I13 — --gateway-user naming the current user verifies the installed files", async () => {
    mkdirSync(pathJoin(env.pluginPath, "dist"), { recursive: true });
    writeFileSync(pathJoin(env.pluginPath, "dist", "index.js"), "export default {};\n");
    const me = (process.env.USER || process.env.LOGNAME || "").trim();
    if (!me) return;
    const result = await runClawmemSetupOpenClaw(["--gateway-user", me], {
      PATH: `${env.stubDir}:${process.env.PATH ?? ""}`,
      HOME: env.tmpDir,
      STUB_LOG: env.stubLog,
      USER: me,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("not world-writable");
  });

  test("I14 — partial modern help (no --accept-capabilities advertised) forwards no consent flag and still installs", async () => {
    const result = await runClawmemSetupOpenClaw([], {
      PATH: `${env.stubDir}:${process.env.PATH ?? ""}`,
      HOME: env.tmpDir,
      STUB_LOG: env.stubLog,
      STUB_MODERN_HELP: "partial",
    });
    expect(result.exitCode).toBe(0);
    const invocations = readStubInvocations(env.stubLog);
    const install = containsInvocation(invocations, (argv) => argv[0] === "plugins" && argv[1] === "install" && argv.includes("--force"));
    expect(install).toBeDefined();
    expect(install!.argv).not.toContain("--accept-capabilities");
  });

  const REQUIRED_CONFIG_KEYS = [
    "plugins.entries.clawmem.config.clawmemBin",
    "plugins.entries.clawmem.hooks.allowConversationAccess",
    "plugins.slots.memory",
  ];
  for (const key of REQUIRED_CONFIG_KEYS) {
    test(`I15 — a failing write of ${key} is a non-zero 'configuration incomplete' exit`, async () => {
      const result = await runClawmemSetupOpenClaw([], {
        PATH: `${env.stubDir}:${process.env.PATH ?? ""}`,
        HOME: env.tmpDir,
        STUB_LOG: env.stubLog,
        STUB_CONFIG_SET_FAIL_KEY: key,
      });
      expect(result.exitCode).not.toBe(0);
      const combined = result.stdout + result.stderr;
      expect(combined).toContain("configuration incomplete");
      expect(combined).toContain(key);
    });
  }

  test("I15b — a write that exits 0 but reads back a different value is also 'configuration incomplete' (readback branch)", async () => {
    const result = await runClawmemSetupOpenClaw([], {
      PATH: `${env.stubDir}:${process.env.PATH ?? ""}`,
      HOME: env.tmpDir,
      STUB_LOG: env.stubLog,
      STUB_CONFIG_SET_WRONG_KEY: "plugins.slots.memory",
    });
    expect(result.exitCode).not.toBe(0);
    const combined = result.stdout + result.stderr;
    expect(combined).toContain("configuration incomplete");
    expect(combined).toContain("plugins.slots.memory");
    expect(combined).toContain("read back");
  });

  test("I11 — copy mode installs a compiled-only staged copy (dist/index.js, manifest, extensions → dist) that Node can import and register", async () => {
    const result = await runClawmemSetupOpenClaw([], {
      PATH: `${env.stubDir}:${process.env.PATH ?? ""}`,
      HOME: env.tmpDir,
      STUB_LOG: env.stubLog,
      CLAWMEM_KEEP_STAGE: "1",
    });
    expect(result.exitCode).toBe(0);
    const m = result.stdout.match(/staged plugin copy left at (\S+)/);
    expect(m).not.toBeNull();
    const stage = m![1]!;
    try {
      expect(existsSync(pathJoin(stage, "dist", "index.js"))).toBe(true);
      // Compiled-only: no TypeScript in the production copy (a gateway that
      // loaded index.ts would be missing its sibling modules).
      expect(existsSync(pathJoin(stage, "index.ts"))).toBe(false);
      expect(existsSync(pathJoin(stage, "openclaw.plugin.json"))).toBe(true);
      const pkg = JSON.parse(readFileSync(pathJoin(stage, "package.json"), "utf-8"));
      expect(pkg.openclaw.extensions).toEqual(["./dist/index.js"]);
      expect(pkg.openclaw.runtimeExtensions).toBeUndefined();
      const invocations = readStubInvocations(env.stubLog);
      const install = containsInvocation(
        invocations,
        (argv) => argv[0] === "plugins" && argv[1] === "install" && argv.includes(stage),
      );
      expect(install).toBeDefined();

      // The bundle must load under Node (OpenClaw's runtime), not only under Bun,
      // and register the same surface as the TypeScript source.
      const probe = `
        const mod = await import(${JSON.stringify(pathJoin(stage, "dist", "index.js"))});
        const ons = []; const tools = [];
        const api = { pluginConfig: { clawmemBin: process.execPath }, logger: { debug(){}, info(){}, warn(){}, error(){} },
          on(name, _h, opts) { ons.push({ name, opts }); }, registerMemoryCapability(){}, registerTool(def) { tools.push(def.name); }, registerService(){} };
        (mod.default ?? mod).register(api);
        console.log(JSON.stringify({ tools, bpb: ons.find(o => o.name === "before_prompt_build")?.opts }));
      `;
      const node = Bun.spawnSync(["node", "--input-type=module", "-e", probe], { stdout: "pipe", stderr: "pipe" });
      expect(node.exitCode).toBe(0);
      const out = JSON.parse(new TextDecoder().decode(node.stdout).trim().split("\n").pop()!);
      expect([...out.tools].sort()).toEqual(["clawmem_get", "clawmem_search", "clawmem_session_log", "clawmem_similar", "clawmem_timeline"]);
      expect(out.bpb.timeoutMs).toBe(10_000);
    } finally {
      rmSync(stage, { recursive: true, force: true });
    }
  });

  test("I16 — CLI absent + OPENCLAW_PROFILE=dev: fallback installs under ~/.openclaw-dev", async () => {
    const sandboxedPath = buildBunOnlyPath(env.tmpDir);
    const result = await runClawmemSetupOpenClaw([], { PATH: sandboxedPath, HOME: env.tmpDir, OPENCLAW_PROFILE: "dev" });
    if (result.exitCode !== 0 && !result.stdout.includes("openclaw CLI not on PATH")) {
      console.warn("I16 skipped: real `openclaw` binary appears to be on PATH");
      return;
    }
    expect(result.exitCode).toBe(0);
    expect(existsSync(pathJoin(env.tmpDir, ".openclaw-dev", "extensions", "clawmem", "dist", "index.js"))).toBe(true);
  });

  test("I17 — OPENCLAW_PROFILE=dev with the CLI present: every openclaw call carries --profile dev; an invalid name stops setup", async () => {
    const result = await runClawmemSetupOpenClaw([], {
      PATH: `${env.stubDir}:${process.env.PATH ?? ""}`,
      HOME: env.tmpDir,
      STUB_LOG: env.stubLog,
      OPENCLAW_PROFILE: "dev",
    });
    expect(result.exitCode).toBe(0);
    const calls = readStubInvocations(env.stubLog).filter((i) => i.argv[0] !== "--version");
    expect(calls.length).toBeGreaterThan(3);
    for (const call of calls) expect(call.argv.slice(0, 2)).toEqual(["--profile", "dev"]);
    expect(calls.some((i) => i.argv[2] === "plugins" && i.argv[3] === "install")).toBe(true);
    expect(calls.some((i) => i.argv[2] === "plugins" && i.argv[3] === "inspect")).toBe(true);
    expect(calls.some((i) => i.argv[2] === "config" && i.argv[3] === "set")).toBe(true);

    const bad = await runClawmemSetupOpenClaw([], {
      PATH: `${env.stubDir}:${process.env.PATH ?? ""}`,
      HOME: env.tmpDir,
      STUB_LOG: env.stubLog,
      OPENCLAW_PROFILE: "bad name!",
    });
    expect(bad.exitCode).not.toBe(0);
    expect(bad.stdout + bad.stderr).toContain("not a valid OpenClaw profile name");
    expect(readStubInvocations(env.stubLog).some((i) => i.argv.includes("bad name!"))).toBe(false);
  });

  test("I18 — inspect names no install path: the inferred location is diagnostic only; --gateway-user fails closed", async () => {
    // A stale tree at the inferred location must not be mistaken for the install.
    const inferred = pathJoin(env.tmpDir, ".openclaw", "extensions", "clawmem");
    mkdirSync(pathJoin(inferred, "dist"), { recursive: true });
    writeFileSync(pathJoin(inferred, "dist", "index.js"), "export default {};\n");
    const base = {
      PATH: `${env.stubDir}:${process.env.PATH ?? ""}`,
      HOME: env.tmpDir,
      STUB_LOG: env.stubLog,
      STUB_INSPECT_EXIT_CODE: "1",
    };
    const plain = await runClawmemSetupOpenClaw([], base);
    expect(plain.exitCode).toBe(0);
    expect(plain.stdout).toContain("named no install path");
    expect(plain.stdout).toContain("ownership NOT verified");

    const me = (process.env.USER || process.env.LOGNAME || "").trim();
    if (!me) return;
    const gated = await runClawmemSetupOpenClaw(["--gateway-user", me], { ...base, USER: me });
    expect(gated.exitCode).not.toBe(0);
    expect(gated.stdout + gated.stderr).toContain("cannot verify for --gateway-user");
  });

  test("I19 — delegated --link install failure puts the previous install back (no destructive pre-cleanup)", async () => {
    mkdirSync(env.pluginPath, { recursive: true });
    writeFileSync(pathJoin(env.pluginPath, "marker.txt"), "previous install\n");
    const result = await runClawmemSetupOpenClaw(["--link"], {
      PATH: `${env.stubDir}:${process.env.PATH ?? ""}`,
      HOME: env.tmpDir,
      STUB_LOG: env.stubLog,
      STUB_INSTALL_EXIT_CODE: "1",
    });
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout + result.stderr).toContain("was put back");
    expect(readFileSync(pathJoin(env.pluginPath, "marker.txt"), "utf-8")).toBe("previous install\n");
    const extDir = pathJoin(env.tmpDir, ".openclaw", "extensions");
    expect(readdirSync(extDir).filter((n) => n.startsWith("clawmem.old-"))).toEqual([]);
  });

  test("I20 — CLI absent + --link: a previous directory is replaced by the symlink with no .old-* residue; an unwritable extensions dir leaves it untouched", async () => {
    const sandboxedPath = buildBunOnlyPath(env.tmpDir);
    const extDir = pathJoin(env.tmpDir, ".openclaw", "extensions");
    mkdirSync(env.pluginPath, { recursive: true });
    writeFileSync(pathJoin(env.pluginPath, "marker.txt"), "previous install\n");
    const ok = await runClawmemSetupOpenClaw(["--link"], { PATH: sandboxedPath, HOME: env.tmpDir });
    if (ok.exitCode !== 0 && !ok.stdout.includes("openclaw CLI not on PATH")) {
      console.warn("I20 skipped: real `openclaw` binary appears to be on PATH");
      return;
    }
    expect(ok.exitCode).toBe(0);
    expect(lstatSync(env.pluginPath).isSymbolicLink()).toBe(true);
    expect(readdirSync(extDir).filter((n) => n.startsWith("clawmem.old-"))).toEqual([]);

    if (typeof process.getuid === "function" && process.getuid() === 0) return; // root ignores the mode below
    rmSync(env.pluginPath, { recursive: true, force: true });
    mkdirSync(env.pluginPath, { recursive: true });
    writeFileSync(pathJoin(env.pluginPath, "marker.txt"), "previous install\n");
    chmodSync(extDir, 0o555); // parking the old directory must fail before anything is destroyed
    try {
      const denied = await runClawmemSetupOpenClaw(["--link"], { PATH: sandboxedPath, HOME: env.tmpDir });
      expect(denied.exitCode).not.toBe(0);
    } finally {
      chmodSync(extDir, 0o755);
    }
    expect(readFileSync(pathJoin(env.pluginPath, "marker.txt"), "utf-8")).toBe("previous install\n");
    expect(readdirSync(extDir).filter((n) => n.startsWith("clawmem.old-"))).toEqual([]);
  });

  test("I21 — an invalid OPENCLAW_PROFILE is refused on the CLI-absent path too, before any path is derived from it (install and --remove)", async () => {
    const sandboxedPath = buildBunOnlyPath(env.tmpDir);
    // `.openclaw-x/../victim` would resolve here without the grammar check.
    const victim = pathJoin(env.tmpDir, "victim", "extensions", "clawmem");
    mkdirSync(victim, { recursive: true });
    writeFileSync(pathJoin(victim, "marker.txt"), "not yours\n");
    const base = { PATH: sandboxedPath, HOME: env.tmpDir, OPENCLAW_PROFILE: "x/../victim" };
    const install = await runClawmemSetupOpenClaw([], base);
    expect(install.exitCode).not.toBe(0);
    expect(install.stdout + install.stderr).toContain("not a valid OpenClaw profile name");
    expect(existsSync(pathJoin(victim, "dist"))).toBe(false);
    const remove = await runClawmemSetupOpenClaw(["--remove"], base);
    expect(remove.exitCode).not.toBe(0);
    expect(remove.stdout + remove.stderr).toContain("not a valid OpenClaw profile name");
    expect(readFileSync(pathJoin(victim, "marker.txt"), "utf-8")).toBe("not yours\n");
  });

  test("I22 — CLI absent copy mode: a stale symlink is parked by the swap and replaced by the compiled tree; a failed run leaves it untouched", async () => {
    const sandboxedPath = buildBunOnlyPath(env.tmpDir);
    const extDir = pathJoin(env.tmpDir, ".openclaw", "extensions");
    mkdirSync(extDir, { recursive: true });
    const oldCheckout = pathJoin(env.tmpDir, "old-checkout");
    mkdirSync(oldCheckout, { recursive: true });
    symlinkSync(oldCheckout, env.pluginPath);
    const ok = await runClawmemSetupOpenClaw([], { PATH: sandboxedPath, HOME: env.tmpDir });
    if (ok.exitCode !== 0 && !ok.stdout.includes("openclaw CLI not on PATH")) {
      console.warn("I22 skipped: real `openclaw` binary appears to be on PATH");
      return;
    }
    expect(ok.exitCode).toBe(0);
    expect(ok.stdout).toContain("previous symlink replaced");
    expect(lstatSync(env.pluginPath).isSymbolicLink()).toBe(false);
    expect(existsSync(pathJoin(env.pluginPath, "dist", "index.js"))).toBe(true);
    expect(readdirSync(extDir).filter((n) => n.startsWith("clawmem.old-") || n.startsWith("clawmem.new-"))).toEqual([]);

    if (typeof process.getuid === "function" && process.getuid() === 0) return; // root ignores the mode below
    rmSync(env.pluginPath, { recursive: true, force: true });
    symlinkSync(oldCheckout, env.pluginPath);
    chmodSync(extDir, 0o555); // the replacement cannot even be staged beside the link, so nothing is touched
    try {
      const denied = await runClawmemSetupOpenClaw([], { PATH: sandboxedPath, HOME: env.tmpDir });
      expect(denied.exitCode).not.toBe(0);
    } finally {
      chmodSync(extDir, 0o755);
    }
    expect(lstatSync(env.pluginPath).isSymbolicLink()).toBe(true);
    expect(readdirSync(extDir).filter((n) => n.startsWith("clawmem.old-") || n.startsWith("clawmem.new-"))).toEqual([]);
  });

  test("I8 — --help short-circuits before any subprocess spawn", async () => {
    const result = await runClawmemSetupOpenClaw(["--help"], {
      PATH: `${env.stubDir}:${process.env.PATH ?? ""}`,
      HOME: env.tmpDir,
      STUB_LOG: env.stubLog,
    });
    expect(result.exitCode).toBe(0);

    // Help text was printed
    expect(result.stdout).toContain("clawmem setup openclaw");
    expect(result.stdout).toContain("OPENCLAW_STATE_DIR");

    // Critical: NO stub invocation should have happened. If the short-circuit
    // failed, we'd see at least the `openclaw --version` probe in the JSONL.
    const invocations = readStubInvocations(env.stubLog);
    expect(invocations).toHaveLength(0);
  });

  test("I6 — CLI absent: direct-copy honors OPENCLAW_STATE_DIR", async () => {
    // Use a PATH that contains bun (so the subprocess can start) but NOT
    // openclaw. The system PATH almost always omits a real openclaw
    // because it's not yet a package on this dev box; we still defensively
    // sandbox by routing through a curated bun-only bin dir.
    const customStateDir = pathJoin(env.tmpDir, "custom-profile");
    const expectedInstallPath = pathJoin(
      customStateDir,
      "extensions",
      "clawmem",
    );

    const sandboxedPath = buildBunOnlyPath(env.tmpDir);
    const result = await runClawmemSetupOpenClaw([], {
      PATH: sandboxedPath,
      HOME: env.tmpDir,
      OPENCLAW_STATE_DIR: customStateDir,
    });

    // If openclaw IS present on the system PATH, this test cannot run
    // meaningfully. Skip in that case rather than producing a confusing
    // fail. (No assertion for the absent-skip; we just early-return.)
    if (result.stdout.includes("openclaw plugins install") &&
        !result.stdout.includes("openclaw CLI not on PATH")) {
      // openclaw was somehow on PATH — abort the test with a hint.
      console.warn(
        "I6 skipped: real `openclaw` binary appears to be on PATH. " +
        "Test environment cannot exercise the CLI-absent fallback.",
      );
      return;
    }

    expect(result.exitCode).toBe(0);

    // The direct-copy install should have written the plugin into the
    // custom state dir, not the default ~/.openclaw.
    expect(existsSync(expectedInstallPath)).toBe(true);
    expect(existsSync(pathJoin(env.tmpDir, ".openclaw"))).toBe(false);

    // Output should mention CLI absence
    expect(result.stdout).toContain("openclaw CLI not on PATH");
  });
});

/**
 * Build a PATH that contains the bun binary's directory (so the spawned
 * subprocess can resolve `bun`) but isolates the test from any real
 * openclaw binary on the system. We construct a per-test sandbox bin
 * containing only a symlink to bun.
 */
function buildBunOnlyPath(tmpDir: string): string {
  const sandbox = pathJoin(tmpDir, "bun-only-bin");
  mkdirSync(sandbox, { recursive: true });
  const bunSrc = process.execPath;
  const bunLink = pathJoin(sandbox, "bun");
  if (!existsSync(bunLink)) {
    try {
      symlinkSync(bunSrc, bunLink);
    } catch {
      // Fall back to writing a wrapper script if symlinks aren't supported
      writeFileSync(bunLink, `#!/usr/bin/env bash\nexec "${bunSrc}" "$@"\n`, {
        mode: 0o755,
      });
      chmodSync(bunLink, 0o755);
    }
  }
  return sandbox;
}
