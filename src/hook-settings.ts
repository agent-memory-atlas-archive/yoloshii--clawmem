/**
 * Claude Code `settings.json` hook entries that belong to ClawMem (62.2).
 *
 * One recogniser for `clawmem setup hooks`, `setup hooks --remove` and `clawmem doctor`, defined by the
 * ADMISSIBLE SHAPE of the commands ClawMem's installer has ever written, everything else rejected
 * (CR-6):
 *
 *   [NAME=value …] [timeout <seconds>] <clawmem> hook <ClawMem hook name>
 *
 * where `<clawmem>` is `clawmem` or a path whose last segment is `clawmem`. The three installer forms
 * were `<bin> hook <name>`, `timeout <n> <bin> hook <name>` (2026-03-15 → 2026-04-02) and the v0.38
 * `CLAWMEM_HOOK_BUDGET_MS=<ms> <bin> hook context-surfacing`. A foreign command with the same words
 * (`echo clawmem hook postcompact-inject`, `/bin/clawmem-backup.sh hook postcompact-inject`) is not one.
 *
 * Through v0.39.1 any group holding a command that CONTAINED "clawmem" was deleted whole, taking a
 * user's own hook in the same group with it.
 */

export const CLAWMEM_HOOK_NAMES = [
  "context-surfacing",
  "session-bootstrap",
  "decision-extractor",
  "handoff-generator",
  "feedback-loop",
  "staleness-check",
  "precompact-extract",
  "postcompact-inject",
  "pretool-inject",
  "curator-nudge",
] as const;

const CLAWMEM_HOOK_COMMAND_RE = new RegExp(
  "^\\s*(?:[A-Za-z_][A-Za-z0-9_]*=\\S*\\s+)*" +     // env assignments
  "(?:timeout\\s+\\d+\\s+)?" +                       // the 2026-03 installer's shell timeout
  "(?:\\S*/)?clawmem\\s+hook\\s+" +                   // the executable: `clawmem`, or a path ending in /clawmem
  `(${CLAWMEM_HOOK_NAMES.join("|")})\\s*$`,
);

/** The ClawMem hook a command runs, or null when the command is not one of ClawMem's. */
export function clawmemHookName(command: unknown): string | null {
  if (typeof command !== "string") return null;
  return CLAWMEM_HOOK_COMMAND_RE.exec(command)?.[1] ?? null;
}

type Handler = { command?: unknown; [k: string]: unknown };
type Group = { matcher?: unknown; hooks?: Handler[]; [k: string]: unknown };

/**
 * Remove ClawMem's own handlers from an event's groups. A group keeps its other handlers and its
 * matcher, and is dropped only when removing ClawMem's handlers empties it. Groups that hold none of
 * ClawMem's handlers pass through unchanged (a user's empty group included).
 */
export function stripClawmemHooks(groups: unknown): Group[] {
  if (!Array.isArray(groups)) return [];
  const kept: Group[] = [];
  for (const g of groups as Group[]) {
    const handlers = Array.isArray(g?.hooks) ? g.hooks : null;
    if (!handlers || !handlers.some(h => clawmemHookName(h?.command))) { kept.push(g); continue; }
    const rest = handlers.filter(h => !clawmemHookName(h?.command));
    if (rest.length > 0) kept.push({ ...g, hooks: rest });
  }
  return kept;
}

/**
 * The matchers of every SessionStart group that runs ClawMem's `postcompact-inject`, when any of them
 * is not "compact" (the v0.39.x installer wrote ""). Empty = correctly installed or not installed.
 */
export function postcompactMatcherIssues(settings: unknown): string[] {
  const groups = (settings as { hooks?: { SessionStart?: Group[] } } | null)?.hooks?.SessionStart;
  if (!Array.isArray(groups)) return [];
  const bad: string[] = [];
  for (const g of groups) {
    const runsIt = Array.isArray(g?.hooks) && g.hooks.some(h => clawmemHookName(h?.command) === "postcompact-inject");
    if (runsIt && g.matcher !== "compact") bad.push(typeof g.matcher === "string" ? g.matcher : String(g.matcher));
  }
  return bad;
}
