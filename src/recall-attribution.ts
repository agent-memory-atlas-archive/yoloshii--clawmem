/**
 * Recall Attribution — the reference test that decides which injected documents a turn's assistant text actually
 * cites (62.1 D6). Pairing a turn with its usage row is D1's (`stop-pairing.ts`); the counters it credits are applied
 * once by `stop-feedback.ts`. (Through v0.40 this module zipped usage rows with transcript turns by POSITION, so one
 * gated or heartbeat turn shifted every later attribution; that path is gone.)
 */

// =============================================================================
// 62.1 D6: the manifest reference test (segment-anchored)
// =============================================================================

/** One injected document as the turn's manifest records it (`feedback_ledger`), keyed uniquely across vaults. */
export type ReferenceEntry = {
  key: string;
  /** '' = the general vault. */
  vault: string;
  /** collection/path — unique within its vault. */
  displayPath: string;
  /** The title exactly as rendered into the injected context (never the document's current title). */
  displayedTitle: string | null;
};

/** Boilerplate file names that identify nothing on their own: credited only with their parent segment. */
const GENERIC_BASENAMES = new Set([
  "readme.md", "skill.md", "agents.md", "claude.md", "memory.md", "index.md", "notes.md", "todo.md", "changelog.md",
  "progress.md", "status.md", "current_status.md", "key_learnings.md", "design.md", "backlog.md", "summary.md",
  "overview.md", "contributing.md", "license.md",
]);
const TITLE_MIN_CHARS = 12;
const DATE_STAMP_RE = /\b\d{4}-\d{2}-\d{2}\b/;

function isPathWordChar(c: string | undefined): boolean {
  return c !== undefined && /[A-Za-z0-9_-]/.test(c);
}

/** `needle` occurs in `text` as a bounded path token; `strictLeft` also refuses '/' and '.' before it (a whole token). */
function hasBoundedPath(text: string, needle: string, strictLeft: boolean): boolean {
  for (let i = text.indexOf(needle); i >= 0; i = text.indexOf(needle, i + 1)) {
    const before = i > 0 ? text[i - 1] : undefined;
    if (isPathWordChar(before) || (strictLeft && (before === "/" || before === "."))) continue;
    const after = text[i + needle.length];
    if (isPathWordChar(after) || after === "/") continue;
    if (after === "." && /[A-Za-z0-9]/.test(text[i + needle.length + 1] ?? "")) continue;   // plan.md.bak
    return true;
  }
  return false;
}

function normalizePhrase(s: string): string {
  return s.normalize("NFC").replace(/\s+/g, " ").trim().toLowerCase();
}

function hasBoundedPhrase(text: string, phrase: string): boolean {
  for (let i = text.indexOf(phrase); i >= 0; i = text.indexOf(phrase, i + 1)) {
    const before = i > 0 ? text[i - 1]! : "";
    const after = text[i + phrase.length] ?? "";
    if (/[\p{L}\p{N}_]/u.test(before) || /[\p{L}\p{N}_]/u.test(after)) continue;
    return true;
  }
  return false;
}

function titleUsable(title: string | null): title is string {
  if (!title) return false;
  const t = title.trim();
  return t.length >= TITLE_MIN_CHARS && t.split(/\s+/).length >= 2 && !DATE_STAMP_RE.test(t);
}

/**
 * The entries a turn's assistant text verifiably references (62.1 D6), run ONCE over the turn's whole manifest:
 *  (1) a display path, or a path suffix of at least two segments, as a bounded token;
 *  (2) a basename with its extension as a whole token — never a generic basename (README.md, SKILL.md, …) alone;
 *  (3) a displayed title of at least 12 characters and two words, not date-stamped, as a word-bounded phrase.
 * A string credits only when it identifies EXACTLY ONE entry across all vaults; a path, basename or title two
 * entries share is ambiguous and credits neither. `assistantText` = the turn's assistant text blocks only.
 */
export function verifiedReferences(assistantText: string, manifest: readonly ReferenceEntry[]): Set<string> {
  const credited = new Set<string>();
  if (!assistantText || manifest.length === 0) return credited;
  const paths = new Map<string, Set<string>>();
  const basenames = new Map<string, Set<string>>();
  const titles = new Map<string, Set<string>>();
  const add = (m: Map<string, Set<string>>, k: string, key: string) => { if (!m.has(k)) m.set(k, new Set()); m.get(k)!.add(key); };
  for (const e of manifest) {
    const segs = e.displayPath.split("/").filter(Boolean);
    for (let i = 0; i + 2 <= segs.length; i++) add(paths, segs.slice(i).join("/"), e.key);
    const base = segs.at(-1);
    if (base && base.includes(".") && !GENERIC_BASENAMES.has(base.toLowerCase())) add(basenames, base, e.key);
    if (titleUsable(e.displayedTitle)) add(titles, normalizePhrase(e.displayedTitle), e.key);
  }
  for (const [p, keys] of paths) if (keys.size === 1 && hasBoundedPath(assistantText, p, false)) credited.add([...keys][0]!);
  for (const [b, keys] of basenames) if (keys.size === 1 && hasBoundedPath(assistantText, b, true)) credited.add([...keys][0]!);
  const lowered = normalizePhrase(assistantText);
  for (const [t, keys] of titles) if (keys.size === 1 && hasBoundedPhrase(lowered, t)) credited.add([...keys][0]!);
  return credited;
}
