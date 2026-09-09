/**
 * OpenClaw path-resolution helpers + setup help text for `clawmem setup openclaw`.
 *
 * §28.1 (issue #11): historically `cmdSetupOpenClaw` hardcoded
 * `~/.openclaw/extensions/clawmem` and ignored `OPENCLAW_STATE_DIR`. v0.10.4
 * delegates to `openclaw plugins install` when the CLI is on PATH (which
 * inherits OpenClaw's own `resolveConfigDir(env)` semantics) and falls back
 * to a direct-copy install otherwise. The fallback path needs to mirror
 * OpenClaw's `resolveConfigDir` precisely for env-var-honoring custom
 * profile installs to land in the expected directory.
 *
 * Mirrors: openclaw/src/utils.ts:119 (resolveConfigDir) and
 *          openclaw/src/infra/home-dir.ts (home resolution).
 *
 * Helpers take injected `env` + `homedir` so they are testable in isolation
 * without needing to touch process.env or the real os.homedir.
 */

import { homedir as defaultHomedir } from "node:os";
import { dirname, resolve as pathResolve } from "node:path";

// =============================================================================
// Types
// =============================================================================

import * as fs from "fs";

export type EnvLike = Record<string, string | undefined>;
export type HomedirFn = () => string;

export interface PathResolverOpts {
  env?: EnvLike;
  homedir?: HomedirFn;
}

/** The message of an Error, or the String form of anything else thrown. */
function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// =============================================================================
// Trim / normalize
// =============================================================================

/**
 * Plain trim — used for OPENCLAW_STATE_DIR and OPENCLAW_CONFIG_PATH so the
 * fallback resolver mirrors OpenClaw's `resolveConfigDir` (utils.ts:119)
 * EXACTLY. OpenClaw applies only `.trim()` to those env vars, so a value
 * of `"undefined"` or `"null"` is treated as a literal directory name (the
 * user shot themselves in the foot, but ClawMem must agree with OpenClaw
 * about WHERE the foot is shot — diverging here would mean Path 1 and
 * Path 3 install into different locations for the same env, which is
 * exactly the bug class §28.1 set out to fix).
 */
export function plainTrim(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const t = value.trim();
  return t || undefined;
}

/**
 * Mirrors OpenClaw's `home-dir.ts:normalize`. Treats empty strings,
 * whitespace-only strings, and the literal strings "undefined" / "null" as
 * unset. Used ONLY for home-resolution env vars (OPENCLAW_HOME, HOME,
 * USERPROFILE) to match OpenClaw's home-dir helper; do NOT use this for
 * OPENCLAW_STATE_DIR or OPENCLAW_CONFIG_PATH (see plainTrim).
 */
export function trim(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const t = value.trim();
  if (!t || t === "undefined" || t === "null") return undefined;
  return t;
}

// =============================================================================
// Home resolution
// =============================================================================

/**
 * Mirrors `openclaw/src/infra/home-dir.ts` resolution priority:
 *   OPENCLAW_HOME → HOME → USERPROFILE → os.homedir() → path.resolve(cwd())
 *
 * `OPENCLAW_HOME` itself can begin with a tilde, in which case we expand it
 * against the *next* fallback (HOME / USERPROFILE / os.homedir).
 */
export function resolveHomeForOpenClaw(opts: PathResolverOpts = {}): string {
  const env = opts.env ?? process.env;
  const homedir = opts.homedir ?? defaultHomedir;

  const explicitHome = trim(env.OPENCLAW_HOME);
  if (explicitHome) {
    if (
      explicitHome === "~" ||
      explicitHome.startsWith("~/") ||
      explicitHome.startsWith("~\\")
    ) {
      const fallback = resolveOsHome(env, homedir);
      if (fallback) {
        return pathResolve(explicitHome.replace(/^~(?=$|[\\/])/, fallback));
      }
      // No fallback available; fall through to other priorities below.
    } else {
      return pathResolve(explicitHome);
    }
  }

  const osHome = resolveOsHome(env, homedir);
  if (osHome) return pathResolve(osHome);

  // Last-resort: cwd. Matches `resolveRequiredHomeDir` in OpenClaw.
  return pathResolve(process.cwd());
}

function resolveOsHome(env: EnvLike, homedir: HomedirFn): string | undefined {
  const homeEnv = trim(env.HOME);
  if (homeEnv) return homeEnv;
  const userProfile = trim(env.USERPROFILE);
  if (userProfile) return userProfile;
  try {
    const safe = trim(homedir());
    if (safe) return safe;
  } catch {
    // os.homedir() can throw on misconfigured systems
  }
  return undefined;
}

// =============================================================================
// Tilde expansion
// =============================================================================

/**
 * Expands a leading `~`, `~/`, or `~\` against the OpenClaw home resolver.
 * Does NOT support `~user/...` (other-user expansion) — neither does
 * OpenClaw's `expandHomePrefix`.
 */
export function expandHome(input: string, opts: PathResolverOpts = {}): string {
  if (!input.startsWith("~")) return input;
  if (
    input !== "~" &&
    !input.startsWith("~/") &&
    !input.startsWith("~\\")
  ) {
    // Looks like `~user` or some other non-home tilde form; leave untouched.
    return input;
  }
  const home = resolveHomeForOpenClaw(opts);
  return input.replace(/^~(?=$|[\\/])/, home);
}

// =============================================================================
// OpenClaw profile name
// =============================================================================

/**
 * OpenClaw's own profile-name grammar (openclaw src/cli/profile-utils.ts
 * PROFILE_NAME_RE): one letter or digit, then up to 63 letters, digits, "-"
 * or "_". No separators and no dots, so a name is always a single path
 * segment and can never leave `~/.openclaw-<profile>`.
 */
export const OPENCLAW_PROFILE_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/i;

/**
 * The named profile selected by OPENCLAW_PROFILE, or undefined for the
 * default profile (unset, blank or "default"). Throws on a name outside the
 * grammar. This is the ONE place the variable is read, so the same check
 * gates the delegated `--profile` flag and the CLI-absent
 * `.openclaw-<profile>` directory alike; setup calls it before any path is
 * derived from the variable, on every path including --remove.
 */
export function resolveOpenClawProfile(env: EnvLike = process.env): string | undefined {
  const raw = (plainTrim(env.OPENCLAW_PROFILE) ?? "").trim();
  if (!raw || raw.toLowerCase() === "default") return undefined;
  if (!OPENCLAW_PROFILE_NAME_RE.test(raw)) {
    throw new Error(
      `OPENCLAW_PROFILE="${raw}" is not a valid OpenClaw profile name (letters, digits, "-" and "_", at most 64 characters)`,
    );
  }
  return raw;
}

// =============================================================================
// Extensions directory resolver (CLI-absent fallback)
// =============================================================================

/**
 * Resolves the `extensions/` directory we should write into when `openclaw`
 * CLI is not on PATH. Mirrors `openclaw/src/utils.ts:119 resolveConfigDir`:
 *   1. OPENCLAW_STATE_DIR overrides everything
 *   2. OPENCLAW_CONFIG_PATH → config root = dirname(file)
 *   3. <home>/.openclaw, or <home>/.openclaw-<profile> for a named
 *      OPENCLAW_PROFILE (validated first, whatever else is set — see
 *      resolveOpenClawProfile)
 *
 * The result is `pathResolve`d so callers can compare against equally
 * normalized paths.
 */
export function resolveExtensionsDirNoOpenClaw(
  opts: PathResolverOpts = {},
): string {
  const env = opts.env ?? process.env;

  // Reject an invalid OPENCLAW_PROFILE before anything else is consulted:
  // even when OPENCLAW_STATE_DIR or OPENCLAW_CONFIG_PATH decides the
  // directory, the same name would reach OpenClaw as `--profile` and be
  // refused there, so setup must not proceed with it on any path.
  const profile = resolveOpenClawProfile(env);

  // OPENCLAW_STATE_DIR + OPENCLAW_CONFIG_PATH use plainTrim (no
  // "undefined"/"null" filtering) to match OpenClaw's resolveConfigDir
  // exactly. See plainTrim docstring.
  const stateDir = plainTrim(env.OPENCLAW_STATE_DIR);
  if (stateDir) {
    return pathResolve(expandHome(stateDir, opts), "extensions");
  }

  const configPath = plainTrim(env.OPENCLAW_CONFIG_PATH);
  if (configPath) {
    return pathResolve(dirname(expandHome(configPath, opts)), "extensions");
  }

  // OPENCLAW_PROFILE mirrors OpenClaw's resolveProfileStateDir: a named
  // profile lives at ~/.openclaw-<profile>; "default" (or empty) is
  // ~/.openclaw. The name passed the grammar above, so it is one segment.
  const suffix = profile ? `-${profile}` : "";
  return pathResolve(resolveHomeForOpenClaw(opts), `.openclaw${suffix}`, "extensions");
}

/**
 * Can `uid` (member of `gids`) traverse every ancestor of `path` and execute
 * `path` itself, judged from mode bits and ownership the way the kernel does
 * for a non-root user? Root (uid 0) skips the traversal checks but still
 * needs an execute bit on the file itself, as execve does. The final target
 * must be a regular file (statSync follows symlinks): a 0755 directory named
 * clawmem passes every mode test and still cannot be executed. Used to
 * verify the gateway's runtime user can run the configured clawmem binary
 * without switching users.
 */
export function canExecuteAs(
  path: string,
  uid: number,
  gids: readonly number[],
  fsModule: { statSync: (p: string) => { uid: number; gid: number; mode: number } } = fs,
): boolean {
  const abs = pathResolve(path);
  if (uid === 0) {
    // Root bypasses directory permissions, but execve still requires a
    // regular file with at least one x bit: a 0644 wrapper, or a 0755
    // directory, fails for root too.
    let st;
    try { st = fsModule.statSync(abs); } catch { return false; }
    return isRegularFileMode(st.mode) && (st.mode & 0o111) !== 0;
  }
  const parts = abs.split("/").filter(Boolean);
  const chain: string[] = ["/"];
  for (let i = 0; i < parts.length; i++) chain.push("/" + parts.slice(0, i + 1).join("/"));
  const gidSet = new Set(gids);
  for (let i = 0; i < chain.length; i++) {
    const p = chain[i]!;
    let st;
    try { st = fsModule.statSync(p); } catch { return false; }
    const cls = st.uid === uid ? 0o100 : gidSet.has(st.gid) ? 0o010 : 0o001; // x bit for owner/group/other
    if ((st.mode & cls) === 0) return false; // traverse (dir) or execute (final file)
    if (i === chain.length - 1 && !isRegularFileMode(st.mode)) return false; // execve needs a regular file
  }
  return true;
}

/** S_IFMT test on a stat mode: true for a regular file. */
function isRegularFileMode(mode: number): boolean {
  return (mode & 0o170000) === 0o100000;
}

/**
 * Replace `target` with the directory at `newDir` while keeping whatever was
 * there recoverable throughout: a previous directory OR stale symlink is
 * parked at `<target>.old-<pid>` (moveTargetAside), the new tree renamed in,
 * and if that rename fails the parked entry is put back. Two sequential
 * renames necessarily leave `target` absent for the instant between them;
 * what the sequence guarantees is that no failure destroys the previous
 * install. The backup is removed only after the new tree is in place. A
 * regular file at `target` is refused before anything moves.
 *
 * Throws the rename-in error when the previous entry was put back, and an
 * AggregateError carrying both errors and naming the backup path when the
 * restore failed too, so the operator learns that `target` is now empty and
 * where the previous entry still is.
 */
export function swapDirIntoPlace(
  newDir: string,
  target: string,
  fsModule: {
    lstatSync: (p: string) => { isSymbolicLink(): boolean; isDirectory(): boolean };
    renameSync: (from: string, to: string) => void;
    rmSync: (p: string, opts: { recursive: boolean; force: boolean }) => void;
  } = fs,
): { replaced: boolean; previous: "none" | "symlink" | "directory" } {
  const aside = moveTargetAside(target, fsModule);
  const previous = aside.kind;
  if (previous === "other") throw new Error(`${target} exists but is neither a symlink nor a directory`);
  try {
    fsModule.renameSync(newDir, target);
  } catch (e) {
    try {
      aside.restore();
    } catch (restoreError) {
      throw new AggregateError(
        [e, restoreError],
        `Could not move ${newDir} into place at ${target} (${errorText(e)}), and the previous ${previous} could not be put back either (${errorText(restoreError)}). ` +
          `It remains at ${aside.backup}; restore it with: mv ${aside.backup} ${target}`,
      );
    }
    throw e;
  }
  aside.discard();
  return { replaced: previous !== "none", previous };
}

/** What `moveTargetAside` found at the target, and how to finish with it. */
export type AsideResult = {
  kind: "none" | "symlink" | "directory" | "other";
  /** `<target>.old-<pid>`, where a parked symlink or directory sits. */
  backup: string;
  /** Rename the parked entry back after a failed attempt (throws, naming `backup`, if that fails). */
  restore(): void;
  /** Delete the parked entry after a successful attempt. */
  discard(): void;
};

/**
 * Moves the symlink or directory at `target` aside to `<target>.old-<pid>`
 * so a replacement can be attempted without destroying it. The result says
 * what was there and offers `restore()` (after a failed attempt) and
 * `discard()` (after a successful one). An absent `target` makes both
 * no-ops; anything else (a regular file) is left untouched and reported as
 * "other" for the caller to refuse. rename(2) moves a symlink itself, never
 * what it points at, so a parked link comes back as the same link.
 */
export function moveTargetAside(
  target: string,
  fsModule: {
    lstatSync: (p: string) => { isSymbolicLink(): boolean; isDirectory(): boolean };
    renameSync: (from: string, to: string) => void;
    rmSync: (p: string, opts: { recursive: boolean; force: boolean }) => void;
  } = fs,
): AsideResult {
  const backup = `${target}.old-${process.pid}`;
  let kind: AsideResult["kind"] = "none";
  try {
    const st = fsModule.lstatSync(target);
    kind = st.isSymbolicLink() ? "symlink" : st.isDirectory() ? "directory" : "other";
  } catch (e: any) {
    if (e?.code !== "ENOENT") throw e;
  }
  const parked = kind === "symlink" || kind === "directory";
  if (parked) {
    fsModule.rmSync(backup, { recursive: true, force: true }); // a leftover from an interrupted run
    fsModule.renameSync(target, backup);
  }
  return {
    kind,
    backup,
    restore() {
      if (!parked) return;
      try {
        fsModule.renameSync(backup, target);
      } catch (e) {
        throw new Error(
          `the previous ${kind} could not be put back at ${target} (${errorText(e)}); it remains at ${backup} — restore it with: mv ${backup} ${target}`,
          { cause: e },
        );
      }
    },
    discard() {
      if (parked) fsModule.rmSync(backup, { recursive: true, force: true });
    },
  };
}

// =============================================================================
// `clawmem setup openclaw --help` text
// =============================================================================

/**
 * Prints help for `clawmem setup openclaw`. Documents flags, env vars
 * consulted, and the CLI-delegation behavior introduced in v0.10.4 (§28.1).
 */
export function printSetupOpenClawHelp(): void {
  const lines = [
    "",
    "clawmem setup openclaw [--link] [--accept-capabilities] [--gateway-user <name>] [--remove] [--help|-h]",
    "",
    "  Install ClawMem as an OpenClaw memory plugin.",
    "",
    "  When the openclaw CLI is on PATH, this command stages a copy of the",
    "  plugin with a bundled Node runtime entry (dist/index.js), delegates to",
    "  `openclaw plugins install <stage> --force`, then sets the config a",
    "  working install needs on OpenClaw >= 2026.5: the exact clawmem binary,",
    "  plugins.entries.clawmem.hooks.allowConversationAccess=true, and",
    "  plugins.slots.memory=clawmem. Otherwise it falls back to a direct-copy",
    "  install honoring OPENCLAW_STATE_DIR.",
    "",
    "Flags:",
    "  --link        Install in load-path mode instead of copying files.",
    "                When openclaw is on PATH, delegates to `openclaw plugins",
    "                install -l <path>` which records the source in",
    "                plugins.load.paths (NOT a filesystem symlink). When",
    "                openclaw is absent, falls back to a real symlink at",
    "                <extensions>/clawmem (note: OpenClaw v2026.4.11+",
    "                discovery silently skips symlinked plugins in the",
    "                fallback path, so prefer the delegated path).",
    "  --accept-capabilities",
    "                OpenClaw >= 2026.5 asks for consent to a plugin's declared",
    "                capabilities on every local install. Setup prints the list",
    "                (five tools, conversation access, the memory slot, the REST",
    "                service) and passes the flag on only with this option or an",
    "                interactive yes. Alias: --yes / -y.",
    "  --gateway-user <name>",
    "                The user the OpenClaw gateway runs as (system-service",
    "                installs). Setup verifies the installed plugin files are",
    "                owned by that user or root and not world-writable — OpenClaw",
    "                refuses to load them otherwise — and exits non-zero when they",
    "                are not, printing the chown to run.",
    "  --remove      Uninstall ClawMem from the OpenClaw extensions dir.",
    "                Tries `openclaw plugins uninstall clawmem --force` first;",
    "                falls back to manual cleanup at the resolved extensions",
    "                path for legacy unmanaged installs.",
    "  --help, -h    Print this message and exit.",
    "",
    "Environment variables (consulted by the CLI-absent fallback path and",
    "inherited by the openclaw subprocess in the delegation path):",
    "  OPENCLAW_STATE_DIR      Override the OpenClaw config root. Plugin",
    "                          installs into <OPENCLAW_STATE_DIR>/extensions/",
    "                          clawmem.",
    "  OPENCLAW_CONFIG_PATH    Override the OpenClaw config file path; root",
    "                          becomes dirname(OPENCLAW_CONFIG_PATH).",
    "  OPENCLAW_PROFILE        Named OpenClaw profile. Passed to every openclaw",
    "                          command setup runs as `--profile <name>` (the",
    "                          variable alone selects nothing in OpenClaw);",
    "                          the fallback path resolves ~/.openclaw-<name>.",
    "                          Checked against OpenClaw's name grammar on",
    "                          every path (--remove too) before anything is",
    "                          touched.",
    "  OPENCLAW_HOME           Override the home directory used to resolve",
    "                          the default ~/.openclaw root.",
    "  HOME / USERPROFILE      Standard home-dir env vars; consulted in that",
    "                          order when OPENCLAW_HOME is unset.",
    "",
    "Examples:",
    "  clawmem setup openclaw",
    "      Install with default profile.",
    "",
    "  OPENCLAW_STATE_DIR=~/.openclaw-dev clawmem setup openclaw",
    "      Install into the `dev` profile (~/.openclaw-dev/extensions/clawmem).",
    "",
    "  OPENCLAW_PROFILE=dev clawmem setup openclaw --link",
    "      Same profile by name; every openclaw call gets --profile dev.",
    "",
    "  clawmem setup openclaw --link",
    "      Load-path mode (delegated install) or symlink (fallback) — local",
    "      development workflow where edits to the source dir take effect.",
    "",
    "  clawmem setup openclaw --remove",
    "      Uninstall ClawMem and reset OpenClaw memory slot.",
    "",
  ];
  for (const line of lines) {
    console.log(line);
  }
}
