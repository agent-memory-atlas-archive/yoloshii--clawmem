/**
 * Collections configuration management
 *
 * This module manages the YAML-based collection configuration at ~/.config/clawmem/config.yaml.
 * Collections define which directories to index and their associated contexts.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { isDeepStrictEqual } from "util";
import YAML, {
  Alias,
  isAlias,
  isCollection,
  isMap,
  isNode,
  isPair,
  isScalar,
  Pair,
  Scalar,
  visit,
  YAMLMap,
  type Document,
  type YAMLSeq,
} from "yaml";

// ============================================================================
// Types
// ============================================================================

/**
 * Context definitions for a collection
 * Key is path prefix (e.g., "/", "/2024", "/Board of Directors")
 * Value is the context description
 */
export type ContextMap = Record<string, string>;

/**
 * A single collection configuration
 */
export interface Collection {
  path: string;           // Absolute path to index
  pattern: string;        // Glob pattern (e.g., "**/*.md")
  context?: ContextMap;   // Optional context definitions
  update?: string;        // Optional bash command to run during qmd update
}

/**
 * The complete configuration file structure
 */
export interface LifecyclePolicy {
  archive_after_days: number;
  type_overrides: Record<string, number | null>;
  purge_after_days: number | null;
  exempt_collections: string[];
  dry_run: boolean;
}

export interface CollectionConfig {
  global_context?: string;                    // Context applied to all collections
  collections: Record<string, Collection>;    // Collection name -> config
  directoryContext?: boolean;                 // Opt-in: auto-generate CLAUDE.md in directories
  lifecycle?: LifecyclePolicy;                // Lifecycle management policy
}

/**
 * Collection with its name (for return values)
 */
export interface NamedCollection extends Collection {
  name: string;
}

// ============================================================================
// Configuration paths
// ============================================================================

function getConfigDir(): string {
  // Allow override via CLAWMEM_CONFIG_DIR for testing
  if (process.env.CLAWMEM_CONFIG_DIR) {
    return process.env.CLAWMEM_CONFIG_DIR;
  }
  return join(homedir(), ".config", "clawmem");
}

function getConfigFilePath(): string {
  const dir = getConfigDir();
  const preferred = join(dir, "config.yaml");
  if (existsSync(preferred)) return preferred;
  return join(dir, "index.yml");
}

/**
 * Ensure config directory exists
 */
function ensureConfigDir(): void {
  const configDir = getConfigDir();
  if (!existsSync(configDir)) {
    mkdirSync(configDir, { recursive: true });
  }
}

// ============================================================================
// Core functions
// ============================================================================

/**
 * Load configuration from ~/.config/clawmem/config.yaml
 * Returns empty config if file doesn't exist
 */
export function loadConfig(): CollectionConfig {
  const configPath = getConfigFilePath();
  if (!existsSync(configPath)) {
    return { collections: {} };
  }
  return readConfigFile(configPath).config;
}

/**
 * Read and parse the config file. The text comes back with the effective config so a writer can
 * edit exactly the text these checks accepted (see readConfigForEdit).
 */
function readConfigFile(configPath: string): { content: string; config: CollectionConfig } {
  try {
    const content = readFileSync(configPath, "utf-8");
    return { content, config: parseConfigText(content, configPath) };
  } catch (error) {
    throw new Error(`Failed to parse ${configPath}: ${error}`);
  }
}

/**
 * The effective config for a config file's text. `quiet` drops the warnings:
 * a writer checking the text it is about to write (verifiedText) has already
 * warned once, when it read the file.
 */
function parseConfigText(content: string, configPath: string, quiet = false): CollectionConfig {
  const options = { logLevel: quiet ? "error" : "warn" } as const;
  const config = YAML.parse(content, options) as CollectionConfig;

  // Ensure collections object exists
  if (!config.collections) {
    config.collections = {};
  }

  // `clawmem collection add` enforces isValidCollectionName, but a hand-edited config.yaml
  // bypasses it entirely. A name containing '/' makes every virtual path for that collection
  // ambiguous — `clawmem://a/b/doc.md` parses as collection 'a', path 'b/doc.md' — so lookups
  // that round-trip through parseVirtualPath silently resolve to the wrong pair or to nothing.
  // Warn rather than throw: rejecting outright would lock an existing vault out of its own
  // config, and the damage is confined to virtual-path round-trips.
  for (const name of quiet ? [] : Object.keys(config.collections)) {
    if (!isValidCollectionName(name)) {
      console.warn(
        `[clawmem] collection name ${JSON.stringify(name)} in ${configPath} is not valid ` +
        `(expected only letters, digits, '_' and '-'). Virtual-path lookups for this ` +
        `collection may resolve incorrectly — rename it with 'clawmem collection add'.`,
      );
    }
  }

  // Parse lifecycle policy if present
  const raw = YAML.parse(content, options);
  if (raw?.lifecycle && typeof raw.lifecycle === "object") {
    const lc = raw.lifecycle;
    config.lifecycle = {
      archive_after_days: typeof lc.archive_after_days === "number" ? lc.archive_after_days : 90,
      type_overrides: typeof lc.type_overrides === "object" && lc.type_overrides !== null ? lc.type_overrides : {},
      // INERT since v0.30.0 (see src/config.ts for the same guard) — only a positive
      // finite value is accepted; a negative or infinite one previously yielded a future
      // cutoff that deleted every archived row.
      purge_after_days:
        typeof lc.purge_after_days === "number" &&
        Number.isFinite(lc.purge_after_days) &&
        lc.purge_after_days > 0
          ? lc.purge_after_days
          : null,
      exempt_collections: Array.isArray(lc.exempt_collections) ? lc.exempt_collections : [],
      dry_run: lc.dry_run !== false,
    };
  }

  return config;
}

// ============================================================================
// Editing the config file
// ============================================================================
//
// The config is edited by hand, and its comments are often the only record of
// why an entry looks the way it does: there is no exclude key, so a narrow
// pattern is explained in a comment or not at all. Writing the parsed plain
// object back drops every comment, blank line and quoting choice in the file,
// so each writer below edits the parsed YAML document in place and writes that
// back. Whatever an edit does not touch comes out as it went in.

/**
 * Read the config for an edit: the effective config (the same checks and
 * warnings as loadConfig) and the YAML document parsed from the same text.
 */
function readConfigForEdit(): { config: CollectionConfig; doc: Document; root: YAMLMap } {
  const configPath = getConfigFilePath();
  if (!existsSync(configPath)) {
    const doc = new YAML.Document({ collections: {} });
    return { config: { collections: {} }, doc, root: doc.contents as YAMLMap };
  }
  const { content, config } = readConfigFile(configPath);
  // YAML.parse accepted this text in readConfigFile, so the document has no errors.
  const doc = YAML.parseDocument(content);
  if (!isMap(doc.contents)) {
    throw new Error(`Failed to parse ${configPath}: the top level is not a mapping`);
  }
  keepKeyLineComments(doc, content);
  keepPropertyComments(doc);
  flowPadding.set(doc, usesFlowPadding(doc, content));
  return { config, doc, root: doc.contents };
}

/** Whether a document's flow collections are written `[ a, b ]` (padded) or `[a, b]`. */
const flowPadding = new WeakMap<Document, boolean>();

/**
 * yaml writes every flow collection one way, padded unless told otherwise, so
 * follow the file: the style most of its non-empty flow collections use.
 */
function usesFlowPadding(doc: Document, content: string): boolean {
  let padded = 0;
  let tight = 0;
  visit(doc, {
    Collection(_, node) {
      if (!node.flow || node.items.length === 0 || !node.range) return;
      if (content[node.range[0] + 1] === " ") padded++;
      else tight++;
    },
  });
  return padded > tight;
}

/**
 * yaml prints a block collection's own comment above the collection's anchor
 * or tag, which moves `a: &base` off its line on any write. Hung on the first
 * entry instead, the comment prints as written. With a blank line before the
 * comment no form prints as written, so that shape stays as yaml has it.
 */
function keepPropertyComments(doc: Document): void {
  visit(doc, {
    Collection(_, block) {
      if (block.flow || !(block.anchor || block.tag) || !block.commentBefore || block.spaceBefore) return;
      const first = block.items[0];
      const holder = isMap(block) ? (isPair(first) ? first.key : undefined) : first;
      if (!isNode(holder) || holder.commentBefore) return;
      holder.commentBefore = block.commentBefore;
      block.commentBefore = undefined;
    },
  });
}

/**
 * yaml files an end-of-line comment after a key that opens a block
 * (`collections: # why`) as the first line of the block's commentBefore. There
 * it reads as the first entry's own comment, and any write prints it on the
 * next line. In the plain `key: # comment` form it moves onto the key, where
 * yaml prints it back on the key's line. With an anchor or tag on that line,
 * or a `? key` form, yaml can only print it under the key, so a blank line
 * after it marks it as the block's comment rather than the first entry's.
 */
function keepKeyLineComments(doc: Document, content: string): void {
  visit(doc, {
    Pair(_, pair) {
      const key = pair.key;
      const block = pair.value;
      if (!isNode(key) || !key.range || key.comment) return;
      if (!isCollection(block) || block.flow || !block.commentBefore || !block.range) return;
      // The first comment between the key and the block's first entry.
      const region = content.slice(key.range[1], block.range[0]);
      const match = /(^|[ \t])#([^\n]*)/m.exec(region);
      if (!match) return;
      const hashAt = match.index + match[1]!.length;
      const lineStart = region.lastIndexOf("\n", hashAt) + 1;
      const before = region.slice(lineStart, hashAt).trim();
      const [first, ...rest] = block.commentBefore.split("\n");
      // A comment alone on its line belongs to the first entry.
      if (before === "" || match[2]!.trimEnd() !== first!.trimEnd()) return;
      let blank = false;
      while (rest[0] === "") {
        rest.shift();
        blank = true;
      }
      if (lineStart === 0 && before === ":") {
        key.comment = first;
        if (blank) block.spaceBefore = true;
        block.commentBefore = rest.length > 0 ? rest.join("\n") : undefined;
      } else {
        block.commentBefore = rest.length > 0 ? `${first}\n\n${rest.join("\n")}` : `${first}\n`;
      }
    },
  });
}

/** Every node and pair in a subtree, the root included. */
function subtree(...roots: unknown[]): Set<unknown> {
  const found = new Set<unknown>();
  for (const root of roots) {
    if (isPair(root)) {
      found.add(root);
      for (const node of subtree(root.key, root.value)) found.add(node);
    } else if (isNode(root)) {
      visit(root, (_key, node) => {
        found.add(node);
      });
    }
  }
  return found;
}

function anchorNames(doc: Document): Set<string> {
  const names = new Set<string>();
  visit(doc, (_key, node) => {
    if ((isScalar(node) || isCollection(node)) && node.anchor) names.add(node.anchor);
  });
  return names;
}

type Target = Scalar | YAMLMap | YAMLSeq;

/**
 * A self-contained copy of `target`, valid wherever it is placed later in the
 * document. An alias inside it that names a node inside it goes on naming the
 * copy's node: that anchor gets a fresh name. An alias inside it that names a
 * node outside it becomes a copy of that node as well, since the same name can
 * mean another node where the copy lands (an anchor may be redefined in
 * between). Every other anchor is dropped, so no name is defined twice;
 * `taken` holds the names in use, shared by nested copies. The comments inside
 * come along only with `keepComments`.
 */
function copyOf(doc: Document, target: Target, keepComments: boolean, taken = anchorNames(doc)): Target {
  const originals: Alias[] = [];
  visit(target, {
    Alias(_, alias) {
      originals.push(alias);
    },
  });
  const copy = target.clone() as Target;
  const renamed = new Map<string, string>();
  const used = new Set<string>();
  const outside = new Map<Alias, Target>();
  const keys = new Set<Alias>();
  let index = 0;
  // Pre-order is document order, and YAML defines an anchor before any alias to it.
  visit(copy, (position, node, path) => {
    if (isAlias(node)) {
      const named = originals[index++]!.resolve(doc);
      if (!named) {
        throw new Error(`Failed to edit ${getConfigFilePath()}: the alias *${node.source} names nothing`);
      }
      if (position === "key" && !isScalar(named) && printsKey(path)) {
        keys.add(node); // see plainKey
        return;
      }
      const fresh = renamed.get(node.source);
      if (fresh) {
        node.source = fresh;
        used.add(fresh);
        return;
      }
      outside.set(node, named);
      return;
    }
    if (!isScalar(node) && !isCollection(node)) return;
    if (node.anchor) {
      const fresh = freshAnchor(node.anchor, taken);
      renamed.set(node.anchor, fresh);
      node.anchor = fresh;
    }
    if (!keepComments) {
      node.comment = undefined;
      node.commentBefore = undefined;
    }
  });
  visit(copy, (_key, node) => {
    if ((isScalar(node) || isCollection(node)) && node.anchor && !used.has(node.anchor)) node.anchor = undefined;
  });
  // Last, once this copy's own anchors are settled: each outside alias becomes a
  // copy of what it named where it stood. That node comes earlier in the
  // document, so the recursion ends.
  if (outside.size > 0 || keys.size > 0) {
    const copies = new Map<Target, Target>();
    visit(copy, {
      Alias(_, alias, path) {
        if (keys.has(alias)) return plainKey(alias);
        const named = outside.get(alias);
        if (!named) return;
        const first = copies.get(named);
        if (first) return aliasTo(first, alias, taken);
        const made = withAliasComments(alias, copyOf(doc, named, false, taken), path[path.length - 1]);
        if (sharesIdentity(named)) copies.set(named, made);
        return made;
      },
    });
  }
  return copy;
}

/** `${base}-copy`, or that with a number after it, whichever `taken` lacks; it is taken then. */
function freshAnchor(base: string, taken: Set<string>): string {
  let fresh = `${base}-copy`;
  for (let i = 2; taken.has(fresh); i++) fresh = `${base}-copy${i}`;
  taken.add(fresh);
  return fresh;
}

/**
 * Whether the plain config reads `node` as an object, which has an identity:
 * a collection, or a scalar such as a !!timestamp (a Date). Aliases that name
 * one node read as one object, so they share one copy of it (a !!set holding
 * two such aliases has one element, and must keep one); a plain scalar is a
 * value, and each alias gets its own copy.
 */
function sharesIdentity(node: unknown): boolean {
  return isCollection(node) || (isScalar(node) && typeof node.value === "object" && node.value !== null);
}

/** An alias to `copy` standing where `alias` stood, with its comments; `copy` takes an anchor if it has none. */
function aliasTo(copy: Target, alias: Alias, taken: Set<string>): Alias {
  copy.anchor ??= freshAnchor(alias.source, taken);
  const next = new Alias(copy.anchor);
  next.commentBefore = alias.commentBefore;
  next.comment = alias.comment;
  next.spaceBefore = alias.spaceBefore;
  return next;
}

/**
 * The plain config names a `? *n` key `*n` when n is a collection (an object
 * key cannot be one). A copy of n there would rename the key, so the alias
 * becomes that name as a string key, which is what the plain-object writer
 * wrote for it.
 */
function plainKey(alias: Alias): Scalar {
  const key = new Scalar(`*${alias.source}`);
  key.commentBefore = alias.commentBefore;
  key.comment = alias.comment;
  key.spaceBefore = alias.spaceBefore;
  return key;
}

/**
 * Whether the plain config names the key of the pair at the end of `path` by
 * printing it, as a mapping does (see plainKey). A !!set or !!omap keeps the
 * key's value instead, as a Set element or a Map key, so a key alias there is
 * copied like any other alias.
 */
function printsKey(path: readonly unknown[]): boolean {
  const owner = path[path.length - 2];
  return !isCollection(owner) || (owner.tag !== "tag:yaml.org,2002:set" && owner.tag !== "tag:yaml.org,2002:omap");
}

/** The copy standing where `alias` stood takes the alias's own comments. */
function withAliasComments(alias: Alias, copy: Target, parent: unknown): Target {
  copy.commentBefore = joinComments(alias.commentBefore, copy.commentBefore);
  copy.spaceBefore = alias.spaceBefore;
  if (alias.comment) {
    // `b: *base # note` over a block: the note goes back on the key's line.
    if (isCollection(copy) && isPair(parent) && parent.value === alias && isNode(parent.key) && !parent.key.comment) {
      parent.key.comment = alias.comment;
    } else if (isCollection(copy)) {
      copy.commentBefore = joinComments(copy.commentBefore, alias.comment);
    } else {
      copy.comment = joinComments(copy.comment, alias.comment);
    }
  }
  return copy;
}

/** A copy of what `alias` names, to stand where the alias stood (see copyOf). */
function aliasCopy(doc: Document, alias: Alias, parent: unknown, keepComments: boolean): Target {
  const target = alias.resolve(doc);
  if (!target) {
    throw new Error(`Failed to edit ${getConfigFilePath()}: the alias *${alias.source} names nothing`);
  }
  return withAliasComments(alias, copyOf(doc, target, keepComments), parent);
}

/** The pair's value; an alias there first becomes a copy, which the edit then changes. */
function ownValue(doc: Document, pair: Pair): unknown {
  if (isAlias(pair.value)) pair.value = aliasCopy(doc, pair.value, pair, false);
  return pair.value;
}

/**
 * Run before an edit changes nodes in place (`changing`: those nodes and the
 * maps above them, since an alias to an ancestor shares the change) or deletes
 * them (`removing`: every node of the deleted subtree). Each alias elsewhere
 * that names one of them becomes a copy of that node as it is now, so the edit
 * reaches only what it names and leaves no alias dangling. The plain config
 * already reads every alias as such a copy. Other aliases stay as written. A
 * copy of a changing node leaves the comments inside it at the anchor; the
 * first copy of a removed node takes them, since the anchor goes. Later aliases
 * to a node the plain config reads as an object name that first copy (see
 * sharesIdentity).
 */
function unshare(doc: Document, changing: unknown[], removing: Set<unknown> = new Set()): void {
  const changed = new Set(changing);
  const copies = new Map<unknown, Target | undefined>();
  visit(doc, {
    Alias(_, alias, path) {
      const target = alias.resolve(doc);
      if (!target || (!changed.has(target) && !removing.has(target))) return;
      if (path.some((node) => removing.has(node))) return; // deleted with the subtree
      if (path.includes(target)) return; // inside what it names, it follows that node through the edit
      const parent = path[path.length - 1];
      if (isPair(parent) && parent.key === alias && !isScalar(target) && printsKey(path)) return plainKey(alias);
      const first = copies.get(target);
      if (first) return aliasTo(first, alias, anchorNames(doc));
      const copy = aliasCopy(doc, alias, parent, removing.has(target) && !copies.has(target));
      copies.set(target, sharesIdentity(target) ? copy : undefined);
      return copy;
    },
  });
}

/** What an edit may change, and what must hold after it (see writeConfigDocument). */
interface EditScope {
  before: CollectionConfig;
  collections: string[];
  globalContext?: boolean;
  intended: (after: CollectionConfig) => boolean;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** A map as it was before the edit, and the same map read back after it. */
type Mapped = [before: unknown, after: unknown];

/** The maps above a collection's entry: the top level and `collections`. */
function aboveEntry(before: CollectionConfig, after: CollectionConfig): Mapped[] {
  return [[before, after], [before.collections, after.collections]];
}

/** An object or array as YAML.parse builds one for a mapping or sequence. */
function isPlain(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === Array.prototype || proto === null;
}

/**
 * Whether `after`, read back from the edited text, holds the value `before`
 * held. `above` pairs each map above the two values with itself after the edit.
 * An alias inside the map it names follows that map through the edit (see
 * unshare), so a reference back to one of those maps matches the same reference
 * after the edit; a copy of the map as it was matches as well, like any equal
 * value. A Map or Set (what a !!omap or !!set builds) compares entry by entry in
 * order, since no edit reorders one. Anything else compares as isDeepStrictEqual
 * compares it.
 */
function sameValue(before: unknown, after: unknown, above: Mapped[]): boolean {
  if (above.some(([was, now]) => was === before && now === after)) return true;
  const inner: Mapped[] = [...above, [before, after]];
  if ((before instanceof Map && after instanceof Map) || (before instanceof Set && after instanceof Set)) {
    const was = [...before];
    const now = [...after];
    return was.length === now.length && was.every((entry, i) => sameValue(entry, now[i], inner));
  }
  if (!isPlain(before) || !isPlain(after)) return isDeepStrictEqual(before, after);
  if (Object.getPrototypeOf(before) !== Object.getPrototypeOf(after)) return false;
  if (Array.isArray(before) && Array.isArray(after) && before.length !== after.length) return false;
  const keys = Object.keys(before);
  if (keys.length !== Object.keys(after).length || !keys.every((key) => Object.hasOwn(after, key))) return false;
  return keys.every((key) => sameValue(before[key], after[key], inner));
}

/**
 * `after` is `before` but at the keys in `except`: every other key is in both,
 * with the same value (see sameValue). A `before` that is not a mapping counts
 * as an empty one.
 */
function keeps(before: unknown, after: unknown, except: string[], above: Mapped[]): boolean {
  if (!isRecord(after)) return false;
  const was = isRecord(before) ? before : {};
  const inner: Mapped[] = [...above, [before, after]];
  return [...new Set([...Object.keys(was), ...Object.keys(after)])].every(
    (key) =>
      except.includes(key) ||
      (Object.hasOwn(was, key) && Object.hasOwn(after, key) && sameValue(was[key], after[key], inner)),
  );
}

/**
 * Write the edited document after one last check: parse the text about to be
 * written and confirm the effective config changed only where the edit names,
 * and as it intends. A YAML feature the in-place edit does not model (a merge
 * key, say) shows up as some other change, and the edit stops with the file
 * untouched instead of writing it.
 */
function writeConfigDocument(doc: Document, scope: EditScope): void {
  const configPath = getConfigFilePath();
  const text = doc.toString({ indent: 2, lineWidth: 0, flowCollectionPadding: flowPadding.get(doc) ?? false });
  const before = scope.before as unknown as Record<string, unknown>;
  const after = parseConfigText(text, configPath, true);
  const plain = after as unknown as Record<string, unknown>;
  const also: string[] = [];
  for (const key of new Set([...Object.keys(before), ...Object.keys(plain)])) {
    if (key === "collections" || (key === "global_context" && scope.globalContext)) continue;
    if (!sameValue(before[key], plain[key], [[before, plain]])) also.push(`'${key}'`);
  }
  const above = aboveEntry(scope.before, after);
  for (const name of new Set([...Object.keys(scope.before.collections), ...Object.keys(after.collections)])) {
    if (scope.collections.includes(name)) continue;
    if (!sameValue(scope.before.collections[name], after.collections[name], above)) also.push(`collection '${name}'`);
  }
  const hint = "The file likely uses a YAML merge key, anchor or alias this edit cannot keep; edit it by hand.";
  if (also.length > 0) {
    throw new Error(`Cannot edit ${configPath} in place: the edit would also change ${also.join(", ")}. ${hint}`);
  }
  if (!scope.intended(after)) {
    throw new Error(`Cannot edit ${configPath} in place: the edit would not come out as asked. ${hint}`);
  }

  ensureConfigDir();
  try {
    writeFileSync(configPath, text, "utf-8");
  } catch (error) {
    throw new Error(`Failed to write ${configPath}: ${error}`);
  }
}

/**
 * A key as the plain config spells it. Object keys are strings: `2024:` parses
 * as the number 2024, a `? *n` key is what n names, and a key that is itself a
 * collection is named by printing it (`[ archive, old ]`, or `*n` for an alias
 * to one). Rather than copy those rules, ask yaml: convert a one-pair map
 * holding this key and read the key back.
 */
function keyText(doc: Document, key: unknown): string {
  if (isScalar(key)) return key.value === null || key.value === undefined ? "" : String(key.value);
  const probe = new YAMLMap(doc.schema);
  probe.items.push(new Pair(key, null));
  // yaml warns on every conversion of a collection key; loadConfig already did once.
  const logLevel = doc.options.logLevel;
  doc.options.logLevel = "error";
  try {
    return Object.keys(probe.toJS(doc) as Record<string, unknown>)[0] ?? "";
  } finally {
    doc.options.logLevel = logLevel;
  }
}

function pairIndex(doc: Document, map: YAMLMap, key: string): number {
  return map.items.findIndex((pair) => keyText(doc, pair.key) === key);
}

function requirePair(doc: Document, map: YAMLMap, key: string): number {
  const index = pairIndex(doc, map, key);
  if (index === -1) {
    throw new Error(
      `Cannot edit ${getConfigFilePath()} in place: '${key}' is not a key of its own there ` +
        `(it may come from a YAML merge key); edit the file by hand.`,
    );
  }
  return index;
}

function joinComments(...parts: Array<string | null | undefined>): string | undefined {
  const present = parts.filter((part): part is string => !!part);
  return present.length > 0 ? present.join("\n") : undefined;
}

/**
 * The mapping stored under `key`, created when the key is absent or holds an
 * empty value (the plain config treats both as missing); an alias there first
 * becomes a copy. `above` lists the maps over `parent`, for unshare. An empty
 * flow map (`{}`) is switched to block style, or every entry added to it
 * would be written on that one line.
 */
function mapAt(doc: Document, parent: YAMLMap, key: string, above: YAMLMap[]): YAMLMap {
  const index = pairIndex(doc, parent, key);
  const pair = index === -1 ? undefined : parent.items[index]!;
  const node = pair ? ownValue(doc, pair) : null;
  if (isMap(node)) {
    if (node.items.length === 0) node.flow = false;
    return node;
  }
  if (node !== null && node !== undefined && !(isScalar(node) && !node.value)) {
    throw new Error(`Failed to edit ${getConfigFilePath()}: '${key}' is not a mapping`);
  }
  const map = doc.createNode({}) as YAMLMap;
  unshare(doc, [...above, parent], pair ? subtree(pair.value) : undefined);
  if (!pair) parent.add(doc.createPair(key, map));
  else replaceValue(pair, map);
  return map;
}

/**
 * Put a mapping in place of a pair's empty or scalar value. `key: # note`
 * keeps its note on the scalar; it moves to the key, so it stays on that line.
 */
function replaceValue(pair: Pair, map: YAMLMap): void {
  const old = pair.value;
  if (isScalar(old)) {
    map.commentBefore = joinComments(old.commentBefore, map.commentBefore);
    if (old.comment) {
      if (isNode(pair.key) && !pair.key.comment) pair.key.comment = old.comment;
      else map.commentBefore = joinComments(map.commentBefore, old.comment);
    }
  }
  pair.value = map;
}

/**
 * Give an existing scalar a new string value. Its quoting and comments stay;
 * an explicit tag or number format belonged to the old value (`!!int 3` would
 * print the new string as `!!int .nan`).
 */
function setScalar(node: Scalar, value: string): void {
  node.value = value;
  if (node.tag !== "tag:yaml.org,2002:str") node.tag = undefined;
  node.format = undefined;
}

/**
 * Set a string value, reusing an existing node so its quoting and line comment
 * survive. `above` lists the maps over `map`, for unshare.
 */
function setValue(doc: Document, map: YAMLMap, key: string, value: string, above: YAMLMap[]): void {
  const index = pairIndex(doc, map, key);
  const pair = index === -1 ? undefined : map.items[index]!;
  const old = pair?.value;
  if (isScalar(old)) {
    unshare(doc, [...above, map, old]);
    setScalar(old, value);
    return;
  }
  unshare(doc, [...above, map], isNode(old) && !isAlias(old) ? subtree(old) : undefined);
  if (pair) pair.value = inPlaceOf(old, doc.createNode(value) as Scalar);
  else map.add(doc.createPair(key, value));
}

/** A new scalar standing where an alias stood keeps the alias's own comments (`path: *p # why`). */
function inPlaceOf(old: unknown, node: Scalar): Scalar {
  if (isAlias(old)) {
    node.commentBefore = old.commentBefore;
    node.comment = old.comment;
    node.spaceBefore = old.spaceBefore;
  }
  return node;
}

/**
 * Comment blocks joined as one block that a blank line separates from whatever
 * follows it. yaml keeps a blank line inside a comment block as an empty line.
 */
function detachedBlock(...blocks: Array<string | null | undefined>): string | undefined {
  const present = blocks
    .map((block) => block?.replace(/\n+$/, ""))
    .filter((block): block is string => !!block && block.split("\n").some((line) => line !== ""));
  return present.length > 0 ? `${present.join("\n\n")}\n` : undefined;
}

/** The part of a comment block that a blank line separates from the item below it. */
function detachedPart(block: string | null | undefined): string | undefined {
  if (!block) return undefined;
  const lines = block.split("\n");
  return detachedBlock(lines.slice(0, Math.max(lines.lastIndexOf(""), 0)).join("\n"));
}

/**
 * Remove the item at `index`. The comment lines directly above an item are its
 * own and go with it. Anything a blank line separates from it (a section
 * header, say) is not the item's, so it stays where the item was, together
 * with `carried`: comments from inside the item that must outlive it. With
 * `keepOwn` (an item removed only because it became empty) its own comment
 * block stays as well. yaml hangs the comment above a map's first item on the
 * map itself, which is why index 0 reads and writes `map.commentBefore`.
 */
function removePair(
  map: YAMLMap,
  index: number,
  { keepOwn = false, carried }: { keepOwn?: boolean; carried?: string } = {},
): void {
  if (index < 0 || index >= map.items.length) {
    throw new Error(`Failed to edit ${getConfigFilePath()}: no item at index ${index}`);
  }
  const [pair] = map.items.splice(index, 1);
  const key = isNode(pair!.key) ? pair!.key : undefined;
  const above = index === 0 ? joinComments(map.commentBefore, key?.commentBefore) : key?.commentBefore;
  const kept = detachedBlock(keepOwn ? above : detachedPart(above), carried);

  const next = map.items[index];
  const nextKey = next && (isNode(next.key) ? next.key : (next.key = new Scalar(next.key)));

  if (index === 0) {
    // The parser keeps what sits above a map's first item on the map, and a
    // blank line held by the first key prints as a line of bare indentation,
    // so the item that moves up hands its blank line to the map. Its comment
    // goes to the map too, unless the map has an anchor or tag, which yaml
    // would print below that comment (see keepPropertyComments).
    const own = nextKey?.commentBefore;
    const block = kept && own ? `${kept}\n${own}` : kept ?? own ?? undefined;
    if (!kept && nextKey?.spaceBefore) map.spaceBefore = true;
    if (!nextKey) {
      map.commentBefore = kept?.replace(/\n+$/, "");
    } else if (map.anchor || map.tag) {
      map.commentBefore = undefined;
      nextKey.commentBefore = block;
      nextKey.spaceBefore = undefined;
    } else {
      map.commentBefore = block;
      nextKey.commentBefore = undefined;
      nextKey.spaceBefore = undefined;
    }
    return;
  }
  if (!kept) return;

  if (!nextKey) {
    map.comment = joinComments(kept.replace(/\n+$/, ""), map.comment);
    return;
  }
  nextKey.commentBefore = nextKey.commentBefore ? `${kept}\n${nextKey.commentBefore}` : kept;
  // The kept block now leads the next item, so it takes the removed item's blank line.
  nextKey.spaceBefore = key?.spaceBefore;
}

/**
 * Get a specific collection by name
 * Returns null if not found
 */
export function getCollection(name: string): NamedCollection | null {
  const config = loadConfig();
  const collection = config.collections[name];

  if (!collection) {
    return null;
  }

  return { name, ...collection };
}

/**
 * List all collections
 */
export function listCollections(): NamedCollection[] {
  const config = loadConfig();
  return Object.entries(config.collections).map(([name, collection]) => ({
    name,
    ...collection,
  }));
}

/**
 * Add or update a collection
 */
export function addCollection(
  name: string,
  path: string,
  pattern: string = "**/*.md"
): void {
  const { config, doc, root } = readConfigForEdit();
  const collections = mapAt(doc, root, "collections", []);
  const index = pairIndex(doc, collections, name);
  const pair = index === -1 ? undefined : collections.items[index]!;
  const entry = pair ? ownValue(doc, pair) : undefined;

  if (isMap(entry)) {
    // Update in place: path and pattern change; context, `update` and every
    // comment on the entry stay.
    setValue(doc, entry, "path", path, [collections]);
    setValue(doc, entry, "pattern", pattern, [collections]);
  } else if (!pair) {
    unshare(doc, [collections]);
    collections.add(doc.createPair(name, { path, pattern }));
  } else {
    unshare(doc, [collections], subtree(pair.value));
    replaceValue(pair, doc.createNode({ path, pattern }) as YAMLMap);
  }

  writeConfigDocument(doc, {
    before: config,
    collections: [name],
    intended: (after) => {
      const updated = after.collections[name];
      return isRecord(updated) && updated.path === path && updated.pattern === pattern &&
        keeps(config.collections[name], updated, ["path", "pattern"], aboveEntry(config, after));
    },
  });
}

/**
 * Remove a collection
 */
export function removeCollection(name: string): boolean {
  const { config, doc, root } = readConfigForEdit();

  if (!config.collections[name]) {
    return false;
  }

  const collections = mapAt(doc, root, "collections", []);
  const index = requirePair(doc, collections, name);
  unshare(doc, [collections], subtree(collections.items[index]));
  removePair(collections, index);
  writeConfigDocument(doc, {
    before: config,
    collections: [name],
    intended: (after) => !(name in after.collections),
  });
  return true;
}

/**
 * Rename a collection
 */
export function renameCollection(oldName: string, newName: string): boolean {
  const { config, doc, root } = readConfigForEdit();

  if (!config.collections[oldName]) {
    return false;
  }

  if (config.collections[newName]) {
    throw new Error(`Collection '${newName}' already exists`);
  }

  const collections = mapAt(doc, root, "collections", []);
  // An empty entry under the new name is overwritten, as it always was.
  const stale = pairIndex(doc, collections, newName);
  if (stale !== -1) {
    unshare(doc, [collections], subtree(collections.items[stale]));
    removePair(collections, stale);
  }
  // Rename the key in place, so the entry keeps its position and comments.
  const pair = collections.items[requirePair(doc, collections, oldName)]!;
  unshare(doc, [collections, pair.key]);
  if (isScalar(pair.key)) setScalar(pair.key, newName);
  else pair.key = inPlaceOf(pair.key, doc.createNode(newName) as Scalar);
  writeConfigDocument(doc, {
    before: config,
    collections: [oldName, newName],
    intended: (after) =>
      !(oldName in after.collections) &&
      sameValue(config.collections[oldName], after.collections[newName], aboveEntry(config, after)),
  });
  return true;
}

// ============================================================================
// Context management
// ============================================================================

/**
 * Get global context
 */
export function getGlobalContext(): string | undefined {
  const config = loadConfig();
  return config.global_context;
}

/**
 * Set global context
 */
export function setGlobalContext(context: string | undefined): void {
  const { config, doc, root } = readConfigForEdit();
  if (context === undefined) {
    const index = pairIndex(doc, root, "global_context");
    if (index !== -1) {
      unshare(doc, [], subtree(root.items[index]));
      removePair(root, index);
    }
  } else {
    setValue(doc, root, "global_context", context, []);
  }
  writeConfigDocument(doc, {
    before: config,
    collections: [],
    globalContext: true,
    intended: (after) => (context === undefined ? !("global_context" in after) : after.global_context === context),
  });
}

/**
 * Get all contexts for a collection
 */
export function getContexts(collectionName: string): ContextMap | undefined {
  const collection = getCollection(collectionName);
  return collection?.context;
}

/**
 * Add or update a context for a specific path in a collection
 */
export function addContext(
  collectionName: string,
  pathPrefix: string,
  contextText: string
): boolean {
  const { config, doc, root } = readConfigForEdit();

  if (!config.collections[collectionName]) {
    return false;
  }

  const collections = mapAt(doc, root, "collections", []);
  const entry = mapAt(doc, collections, collectionName, []);
  const context = mapAt(doc, entry, "context", [collections]);
  setValue(doc, context, pathPrefix, contextText, [collections, entry]);
  writeConfigDocument(doc, {
    before: config,
    collections: [collectionName],
    intended: (after) => {
      const was = config.collections[collectionName];
      const updated = after.collections[collectionName];
      const above = aboveEntry(config, after);
      return isRecord(updated) && isRecord(updated.context) && updated.context[pathPrefix] === contextText &&
        keeps(was, updated, ["context"], above) &&
        keeps(was?.context, updated.context, [pathPrefix], [...above, [was, updated]]);
    },
  });
  return true;
}

/**
 * Remove a context from a collection
 */
export function removeContext(
  collectionName: string,
  pathPrefix: string
): boolean {
  const { config, doc, root } = readConfigForEdit();
  const collection = config.collections[collectionName];

  if (!collection?.context?.[pathPrefix]) {
    return false;
  }

  const collections = mapAt(doc, root, "collections", []);
  const entry = mapAt(doc, collections, collectionName, []);
  const context = mapAt(doc, entry, "context", [collections]);
  const index = requirePair(doc, context, pathPrefix);
  unshare(doc, [collections, entry, context], subtree(context.items[index]));
  removePair(context, index);

  // Remove the empty context mapping. It goes because it is empty, not because
  // anyone asked, so every comment on it (above it, on its line, inside it) stays.
  if (context.items.length === 0) {
    const at = requirePair(doc, entry, "context");
    const contextKey = entry.items[at]!.key;
    unshare(doc, [collections, entry], subtree(entry.items[at]));
    removePair(entry, at, {
      keepOwn: true,
      carried: joinComments(isNode(contextKey) ? contextKey.comment : undefined, context.commentBefore, context.comment),
    });
  }

  writeConfigDocument(doc, {
    before: config,
    collections: [collectionName],
    intended: (after) => {
      const updated = after.collections[collectionName];
      const left = isRecord(updated) && isRecord(updated.context) ? updated.context : {};
      const above = aboveEntry(config, after);
      return isRecord(updated) && !(pathPrefix in left) &&
        keeps(collection, updated, ["context"], above) &&
        keeps(collection.context, left, [pathPrefix], [...above, [collection, updated]]);
    },
  });
  return true;
}

/**
 * List all contexts across all collections
 */
export function listAllContexts(): Array<{
  collection: string;
  path: string;
  context: string;
}> {
  const config = loadConfig();
  const results: Array<{ collection: string; path: string; context: string }> = [];

  // Add global context if present
  if (config.global_context) {
    results.push({
      collection: "*",
      path: "/",
      context: config.global_context,
    });
  }

  // Add collection contexts
  for (const [name, collection] of Object.entries(config.collections)) {
    if (collection.context) {
      for (const [path, context] of Object.entries(collection.context)) {
        results.push({
          collection: name,
          path,
          context,
        });
      }
    }
  }

  return results;
}

/**
 * Find best matching context for a given collection and path
 * Returns the most specific matching context (longest path prefix match)
 */
export function findContextForPath(
  collectionName: string,
  filePath: string
): string | undefined {
  const config = loadConfig();
  const collection = config.collections[collectionName];

  if (!collection?.context) {
    return config.global_context;
  }

  // Find all matching prefixes
  const matches: Array<{ prefix: string; context: string }> = [];

  for (const [prefix, context] of Object.entries(collection.context)) {
    // Normalize paths for comparison
    const normalizedPath = filePath.startsWith("/") ? filePath : `/${filePath}`;
    const normalizedPrefix = prefix.startsWith("/") ? prefix : `/${prefix}`;

    if (normalizedPath.startsWith(normalizedPrefix)) {
      matches.push({ prefix: normalizedPrefix, context });
    }
  }

  // Return most specific match (longest prefix)
  if (matches.length > 0) {
    matches.sort((a, b) => b.prefix.length - a.prefix.length);
    return matches[0]!.context;
  }

  // Fallback to global context
  return config.global_context;
}

// ============================================================================
// Utility functions
// ============================================================================

/**
 * Get the config file path (useful for error messages)
 */
export function getConfigPath(): string {
  return getConfigFilePath();
}

/**
 * Check if config file exists
 */
export function configExists(): boolean {
  return existsSync(getConfigFilePath());
}

/**
 * Validate a collection name
 * Collection names must be valid and not contain special characters
 */
export function isValidCollectionName(name: string): boolean {
  // Allow alphanumeric, hyphens, underscores
  return /^[a-zA-Z0-9_-]+$/.test(name);
}
