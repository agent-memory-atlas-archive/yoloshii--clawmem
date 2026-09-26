/**
 * ClawMem OpenClaw Plugin — Shell-out utilities
 *
 * Phase 1 transport: spawn `clawmem hook <name>` as a Bun subprocess.
 * All hook handlers accept JSON on stdin and return JSON on stdout.
 */

import { execFile, spawn, type ChildProcess } from "node:child_process";
import { accessSync, constants as fsConstants, existsSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// ESM equivalent of CommonJS __dirname. This package declares
// "type": "module", so __dirname is not defined when loaded by a plain
// Node.js ESM loader (e.g. OpenClaw's plugin host). Bun shims __dirname
// in ESM, which is why this regression is invisible under `bun test`.
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// =============================================================================
// Types
// =============================================================================

export type ClawMemConfig = {
  clawmemBin: string;
  tokenBudget: number;
  profile: string;
  enableTools: boolean;
  servePort: number;
  /**
   * The context-surfacing hook's authoritative wall-clock budget in ms. It is
   * handed to the child as CLAWMEM_HOOK_BUDGET_MS (honored from ClawMem v0.38;
   * older hooks ignore it), and every outer timeout derives from it — see
   * contextSurfacingKillTimeoutMs / hostHookTimeoutMs.
   */
  hookBudgetMs?: number;
  env: Record<string, string>;
};

// =============================================================================
// Hook budget contract
// =============================================================================
//
// One number, three layers, always ordered inner < middle < outer:
//   hookBudgetMs                 the hook schedules its own legs against this
//   + HOOK_KILL_MARGIN_MS        process start-up and JSON finalization
//   = child kill timeout         execFile kills the child here
//   + HOST_TIMEOUT_MARGIN_MS     the host's own timer must fire AFTER our kill
//   = before_prompt_build timeoutMs passed to the OpenClaw registration
// Raising hookBudgetMs alone is pointless when the operator's OpenClaw hook
// policy (plugins.entries.clawmem.hooks.timeouts) is lower than the outer value.

export const DEFAULT_HOOK_BUDGET_MS = 6000;
export const MIN_HOOK_BUDGET_MS = 1000;
/**
 * The hook's own ceiling. From v0.38 the context-surfacing hook refuses to run
 * when CLAWMEM_HOOK_BUDGET_MS is above MAX_LEG_BUDGET_MS (src/vector-protocol.ts,
 * 25 s), so the plugin clamps to the same number and never hands it a value it
 * refuses. Mirrored rather than imported to keep this directory self-contained
 * (link mode loads it as source); tests/unit/openclaw-hook-budget.test.ts pins
 * the two equal. OpenClaw's own hook-timeout policy tops out at
 * OPENCLAW_HOOK_TIMEOUT_POLICY_MAX_MS, and the outer host timeout (budget + both
 * margins) must stay below it so the manifest's advice to set a matching policy
 * is always satisfiable.
 */
export const MAX_HOOK_BUDGET_MS = 25_000;
export const HOOK_KILL_MARGIN_MS = 2000;
export const HOST_TIMEOUT_MARGIN_MS = 2000;
export const OPENCLAW_HOOK_TIMEOUT_POLICY_MAX_MS = 600_000;
if (MAX_HOOK_BUDGET_MS + HOOK_KILL_MARGIN_MS + HOST_TIMEOUT_MARGIN_MS > OPENCLAW_HOOK_TIMEOUT_POLICY_MAX_MS) {
  throw new Error("hook budget contract: host timeout at MAX budget exceeds OpenClaw's policy maximum");
}

/** Coerce a configured budget: non-numeric or non-positive → default; clamp to [MIN, MAX]. */
export function resolveHookBudgetMs(raw: unknown): number {
  const n = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_HOOK_BUDGET_MS;
  return Math.min(MAX_HOOK_BUDGET_MS, Math.max(MIN_HOOK_BUDGET_MS, Math.floor(n)));
}

/** When execFile kills the context-surfacing child. */
export function contextSurfacingKillTimeoutMs(cfg: Pick<ClawMemConfig, "hookBudgetMs">): number {
  return resolveHookBudgetMs(cfg.hookBudgetMs) + HOOK_KILL_MARGIN_MS;
}

/** The timeoutMs handed to OpenClaw for the before_prompt_build registration. */
export function hostHookTimeoutMs(cfg: Pick<ClawMemConfig, "hookBudgetMs">): number {
  return contextSurfacingKillTimeoutMs(cfg) + HOST_TIMEOUT_MARGIN_MS;
}

export type ShellResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
};

// =============================================================================
// Binary Resolution
// =============================================================================

const SEARCH_PATHS = [
  // Relative to this plugin (ClawMem repo layout)
  resolve(__dirname, "../../bin/clawmem"),
  // Common install locations
  "/usr/local/bin/clawmem",
  resolve(process.env.HOME || "/tmp", "Projects/forge-stack/skill-forge/clawmem/bin/clawmem"),
  resolve(process.env.HOME || "/tmp", "clawmem/bin/clawmem"),
];

export function resolveClawMemBin(configured?: string): string {
  if (configured) {
    // An explicit path is authoritative: a configured binary that has gone
    // missing is an error to surface, never a cue to run some other clawmem
    // found on a search path (the bundled plugin's source-relative fallback
    // does not even point at a checkout). A directory at that path is not a
    // binary either: execFile would fail on it at the first hook.
    if (!existsSync(configured)) throw new Error(`clawmem: configured clawmemBin does not exist: ${configured}`);
    if (!isRegularFile(configured)) throw new Error(`clawmem: configured clawmemBin is not a regular file: ${configured}`);
    if (!isExecutable(configured)) throw new Error(`clawmem: configured clawmemBin is not executable: ${configured}`);
    return configured;
  }

  for (const p of SEARCH_PATHS) {
    if (isRegularFile(p) && isExecutable(p)) return p;
  }

  // Fallback: assume it's on PATH
  return "clawmem";
}

/** access(2) X_OK for this process: false for a file without an execute bit this user can use. */
function isExecutable(p: string): boolean {
  try {
    accessSync(p, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Follows symlinks; false for a missing path or anything but a regular file. */
function isRegularFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

// =============================================================================
// Shell Execution
// =============================================================================

const DEFAULT_TIMEOUT = 10_000; // 10s for most hooks
const EXTRACTION_TIMEOUT = 30_000; // 30s for LLM-based extraction

/**
 * Execute a clawmem hook with JSON on stdin, capture JSON stdout.
 * Fail-open: returns empty result on timeout or error.
 */
export function execHook(
  cfg: ClawMemConfig,
  hookName: string,
  input: Record<string, unknown>,
  timeout?: number
): Promise<ShellResult> {
  const hookTimeout = timeout ?? (
    hookName === "decision-extractor" || hookName === "handoff-generator"
      ? EXTRACTION_TIMEOUT
      : DEFAULT_TIMEOUT
  );

  return new Promise((resolve) => {
    const child = execFile(
      cfg.clawmemBin,
      ["hook", hookName],
      {
        timeout: hookTimeout,
        env: { ...process.env, ...cfg.env },
        maxBuffer: 1024 * 1024, // 1MB
      },
      (error, stdout, stderr) => {
        if (error) {
          // Fail-open: log but don't throw
          const msg = (error as any).killed
            ? `timeout after ${hookTimeout}ms (hook=${hookName}, profile=${cfg.profile}, hookBudgetMs=${resolveHookBudgetMs(cfg.hookBudgetMs)})`
            : String(error.message || error);
          resolve({
            stdout: "",
            stderr: `[clawmem-plugin] hook ${hookName} failed: ${msg}\n${stderr}`,
            exitCode: (error as any).code ?? 1,
          });
          return;
        }
        resolve({ stdout: stdout || "", stderr: stderr || "", exitCode: 0 });
      }
    );

    // Send hook input on stdin
    if (child.stdin) {
      child.stdin.write(JSON.stringify(input));
      child.stdin.end();
    }
  });
}

/**
 * Execute a clawmem CLI command (non-hook).
 */
export function execCommand(
  cfg: ClawMemConfig,
  args: string[],
  timeout: number = DEFAULT_TIMEOUT
): Promise<ShellResult> {
  return new Promise((resolve) => {
    execFile(
      cfg.clawmemBin,
      args,
      {
        timeout,
        env: { ...process.env, ...cfg.env },
        maxBuffer: 1024 * 1024,
      },
      (error, stdout, stderr) => {
        if (error) {
          resolve({
            stdout: "",
            stderr: `[clawmem-plugin] command failed: ${String(error.message || error)}\n${stderr}`,
            exitCode: (error as any).code ?? 1,
          });
          return;
        }
        resolve({ stdout: stdout || "", stderr: stderr || "", exitCode: 0 });
      }
    );
  });
}

/**
 * Spawn a long-lived background process (e.g., `clawmem serve`).
 * Returns the child process handle for lifecycle management.
 * The child is detached from the parent's event loop via unref().
 */
export function spawnBackground(
  cfg: ClawMemConfig,
  args: string[],
  logger?: { info: (...args: any[]) => void; warn: (...args: any[]) => void }
): ChildProcess {
  const child = spawn(cfg.clawmemBin, args, {
    env: { ...process.env, ...cfg.env },
    stdio: ["ignore", "pipe", "pipe"],
    detached: false,
  });

  child.stdout?.on("data", (data: Buffer) => {
    logger?.info(`[clawmem-serve] ${data.toString().trim()}`);
  });

  child.stderr?.on("data", (data: Buffer) => {
    logger?.warn(`[clawmem-serve] ${data.toString().trim()}`);
  });

  child.on("exit", (code, signal) => {
    logger?.warn(`[clawmem-serve] exited (code=${code}, signal=${signal})`);
  });

  child.unref();
  return child;
}

/**
 * Parse hook output JSON. Returns null on parse failure.
 */
export function parseHookOutput(stdout: string): Record<string, unknown> | null {
  if (!stdout.trim()) return null;
  try {
    return JSON.parse(stdout.trim());
  } catch {
    // Hook output may have non-JSON preamble (stderr leak)
    // Try to find the last JSON object
    const lastBrace = stdout.lastIndexOf("}");
    const firstBrace = stdout.indexOf("{");
    if (firstBrace >= 0 && lastBrace > firstBrace) {
      try {
        return JSON.parse(stdout.slice(firstBrace, lastBrace + 1));
      } catch {
        return null;
      }
    }
    return null;
  }
}

/**
 * Extract additionalContext from hook output.
 * Hooks return: { hookSpecificOutput: { additionalContext: "..." } }
 */
export function extractContext(hookOutput: Record<string, unknown> | null): string {
  if (!hookOutput) return "";
  const hso = hookOutput.hookSpecificOutput as Record<string, unknown> | undefined;
  return (hso?.additionalContext as string) || "";
}
