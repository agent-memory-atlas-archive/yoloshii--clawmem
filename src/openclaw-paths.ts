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
import { dirname, isAbsolute, resolve as pathResolve } from "node:path";

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

/** The stat fields the access checks read; lstat + readlink let them follow symlinks as the kernel does. */
export type AccessFs = {
  statSync: (p: string) => { uid: number; gid: number; mode: number };
  lstatSync: (p: string) => { uid: number; gid: number; mode: number };
  readlinkSync: (p: string) => string;
};

const REAL_ACCESS_FS: AccessFs = {
  statSync: (p) => fs.statSync(p),
  lstatSync: (p) => fs.lstatSync(p),
  readlinkSync: (p) => fs.readlinkSync(p, "utf8"),
};

type StatBits = { uid: number; gid: number; mode: number };

/** Absolute WITHOUT lexical normalization: ".." must be resolved by the walk, after symlinks (codex v0.39 turn 10). */
function absoluteNoNormalize(p: string): string {
  return p.startsWith("/") ? p : `${process.cwd()}/${p}`;
}

/**
 * Resolve `path` component by component the way the kernel does, expanding
 * each symlink where it occurs, and return every directory searched on the way
 * (each needs the caller's x bit) plus the final non-symlink target. A
 * symlink's own mode never matters on Linux; the directories on the way to its
 * target do, which is why walking the literal path, or only its realpath, is
 * not enough (codex v0.39 turn 9). Nothing is normalized lexically first: ".."
 * is the physical parent of wherever the walk stands, and a trailing slash, on
 * the input or on a link target, demands a directory (codex v0.39 turn 10).
 * null when a component is missing, a non-directory has components after it,
 * or more than 40 symlinks are followed (ELOOP).
 */
function kernelWalk(path: string, fsm: AccessFs): { searched: StatBits[]; target: StatBits } | null {
  const abs = absoluteNoNormalize(path);
  const pending = abs.split("/").filter(Boolean);
  if (abs.endsWith("/") && pending.length > 0) pending.push("."); // a trailing slash demands a directory
  let cur = "/";
  let curSt: StatBits;
  try { curSt = fsm.lstatSync("/"); } catch { return null; }
  const searched: StatBits[] = [];
  let hops = 0;
  while (pending.length > 0) {
    const name = pending.shift()!;
    searched.push(curSt); // looking `name` up in `cur` needs x on `cur`, "." and ".." included
    if (name === ".") continue;
    if (name === "..") {
      cur = dirname(cur);
      try { curSt = fsm.lstatSync(cur); } catch { return null; }
      continue;
    }
    const next = cur === "/" ? `/${name}` : `${cur}/${name}`;
    let st: StatBits;
    try { st = fsm.lstatSync(next); } catch { return null; }
    if ((st.mode & 0o170000) === 0o120000) {
      if (++hops > 40) return null;
      let link: string;
      try { link = fsm.readlinkSync(next); } catch { return null; }
      if (link.startsWith("/")) {
        cur = "/";
        try { curSt = fsm.lstatSync("/"); } catch { return null; }
      }
      if (link === "") return null; // an empty link target is ENOENT
      const parts = link.split("/").filter(Boolean);
      if (link.endsWith("/") && parts.length > 0) parts.push("."); // a trailing slash demands a directory
      pending.unshift(...parts);
      continue;
    }
    if (pending.length === 0) return { searched, target: st };
    if ((st.mode & 0o170000) !== 0o040000) return null; // ENOTDIR
    cur = next;
    curSt = st;
  }
  return { searched, target: curSt };
}

/** The permission triple that applies to `uid`: owner, else group, else other (the first class that matches decides). */
function permBits(st: StatBits, uid: number, gidSet: ReadonlySet<number>): number {
  const shift = st.uid === uid ? 6 : gidSet.has(st.gid) ? 3 : 0;
  return (st.mode >> shift) & 0o7;
}

/**
 * Can `uid` (member of `gids`) reach and execute `path`, judged from mode bits
 * and ownership the way the kernel does for a non-root user? Every directory
 * searched while resolving it, symlink targets included, needs the x bit for
 * the caller's class, and the target must be a regular file with that x bit.
 * Root (uid 0) skips the searches but still needs an execute bit on the file
 * itself, as execve does. A 0755 directory named clawmem passes every mode
 * test and still cannot be executed. Used to verify the gateway's runtime user
 * can run the configured clawmem binary without switching users.
 */
export function canExecuteAs(
  path: string,
  uid: number,
  gids: readonly number[],
  fsModule: AccessFs = REAL_ACCESS_FS,
): boolean {
  const abs = absoluteNoNormalize(path);
  if (uid === 0) {
    // Root bypasses directory permissions, but execve still requires a
    // regular file with at least one x bit: a 0644 wrapper, or a 0755
    // directory, fails for root too.
    let st;
    try { st = fsModule.statSync(abs); } catch { return false; }
    return isRegularFileMode(st.mode) && (st.mode & 0o111) !== 0;
  }
  const walk = kernelWalk(abs, fsModule);
  if (!walk) return false;
  const gidSet = new Set(gids);
  if (walk.searched.some((d) => (permBits(d, uid, gidSet) & 0o1) === 0)) return false;
  return isRegularFileMode(walk.target.mode) && (permBits(walk.target, uid, gidSet) & 0o1) !== 0;
}

/**
 * Can `uid` (member of `gids`) reach and read `path` (a directory must also be
 * searchable), judged the same way as canExecuteAs: every directory searched
 * while resolving it, symlink targets included, needs the caller's x bit.
 * Root always can once the path exists. OpenClaw reads the plugin's root,
 * manifest, package.json and entry as the gateway's runtime user, and a 0750
 * home directory above the install, or above a symlink's target, is the usual
 * miss.
 */
export function canReadAs(
  path: string,
  uid: number,
  gids: readonly number[],
  fsModule: AccessFs = REAL_ACCESS_FS,
): boolean {
  const abs = absoluteNoNormalize(path);
  if (uid === 0) {
    try { fsModule.statSync(abs); return true; } catch { return false; }
  }
  const walk = kernelWalk(abs, fsModule);
  if (!walk) return false;
  const gidSet = new Set(gids);
  if (walk.searched.some((d) => (permBits(d, uid, gidSet) & 0o1) === 0)) return false;
  const bits = permBits(walk.target, uid, gidSet);
  if ((bits & 0o4) === 0) return false;
  if ((walk.target.mode & 0o170000) === 0o040000 && (bits & 0o1) === 0) return false;
  return true;
}

/** The installed plugin files OpenClaw reads as the gateway's runtime user. */
export function pluginFilesOpenClawReads(root: string, entry: string): string[] {
  return [root, entry, pathResolve(root, "openclaw.plugin.json"), pathResolve(root, "package.json")];
}

/** Of those, the ones `uid` cannot reach and read. A missing file counts: canReadAs rejects it. */
export function unreadablePluginFiles(
  root: string,
  entry: string,
  uid: number,
  gids: readonly number[],
  fsModule: AccessFs = REAL_ACCESS_FS,
): string[] {
  return pluginFilesOpenClawReads(root, entry).filter((p) => !canReadAs(p, uid, gids, fsModule));
}

/**
 * The binary `clawmem setup openclaw` may record as `clawmemBin`: an absolute
 * path to a regular file the current user can execute. A bare name is resolved
 * through PATH first (`which`); anything else is refused with the reason, so
 * setup never writes a search-path guess or a non-executable file into the
 * plugin config.
 */
export function resolveRecordableClawmemBin(
  found: string,
  which: (name: string) => string | null,
  fsModule: {
    statSync: (p: string) => { mode: number };
    accessSync: (p: string, mode?: number) => void;
  } = fs,
): { ok: true; path: string } | { ok: false; reason: string } {
  const abs = isAbsolute(found) ? found : which(found);
  if (!abs) return { ok: false, reason: `no ${found} executable on PATH` };
  let st;
  try { st = fsModule.statSync(abs); } catch { return { ok: false, reason: `${abs} does not exist` }; }
  if (!isRegularFileMode(st.mode)) return { ok: false, reason: `${abs} is not a regular file` };
  try { fsModule.accessSync(abs, fs.constants.X_OK); } catch { return { ok: false, reason: `${abs} is not executable by the current user` }; }
  return { ok: true, path: pathResolve(abs) };
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
    "                refuses to load them otherwise — that the user can read them",
    "                and traverse every parent directory, and that it can run the",
    "                clawmem binary; it exits non-zero when any check fails.",
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
