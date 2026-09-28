/**
 * The collection and context writers edit config.yaml in place.
 *
 * Through v0.39.0 each writer re-serialised the parsed plain object, so every
 * `clawmem collection add|remove|rename` (and the context writers) silently
 * dropped every comment in the file, exit 0. Those comments are often the only
 * record of why an entry looks the way it does — there is no exclude key, so a
 * narrow pattern is explained in a comment or not at all.
 *
 * Each test states the exact file an edit must produce: the edit's own lines
 * change, every other line (comments, blank lines, quoting) comes out as it
 * went in.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import YAML from "yaml";
import {
  addCollection,
  addContext,
  loadConfig,
  removeCollection,
  removeContext,
  renameCollection,
  setGlobalContext,
} from "../../src/collections.ts";

const ATLAS = `  # atlas lists its subtrees instead of **/*.md:
  # the tree holds vendored .md files in cloned repos,
  # and the config has no exclude key.
  atlas:
    path: /home/u/atlas
    pattern: "{*.md,research/*.md,research/**/*.md}"
`;

const PAPERS = `  # papers: pull before indexing
  papers:
    path: /home/u/papers
    pattern: "**/*.md" # every note
    update: git pull
    context:
      /: "Papers I am reading"
`;

const NOTES = `  notes:
    path: /home/u/notes
    pattern: '**/*.md'
`;

const CONFIG = `# ClawMem collections, edited by hand

global_context: "Personal notes" # applies to every collection
collections:
${ATLAS}
  # --- research ---

${PAPERS}${NOTES}# lifecycle is reviewed quarterly
lifecycle:
  archive_after_days: 60
`;

let dir = "";
let savedConfigDir: string | undefined;

beforeEach(() => {
  savedConfigDir = process.env.CLAWMEM_CONFIG_DIR;
  dir = mkdtempSync(join(tmpdir(), "clawmem-config-comments-"));
  process.env.CLAWMEM_CONFIG_DIR = dir;
});

afterEach(() => {
  if (savedConfigDir === undefined) delete process.env.CLAWMEM_CONFIG_DIR;
  else process.env.CLAWMEM_CONFIG_DIR = savedConfigDir;
  rmSync(dir, { recursive: true, force: true });
});

const write = (text: string) => writeFileSync(join(dir, "config.yaml"), text);
const read = () => readFileSync(join(dir, "config.yaml"), "utf-8");

/** Replace exactly one occurrence, so a fixture drift fails loudly instead of matching nothing. */
function edit(text: string, from: string, to: string): string {
  expect(text.split(from).length - 1).toBe(1);
  return text.replace(from, to);
}

describe("collection writers keep config.yaml comments", () => {
  it("add keeps every comment, including the reason for a narrow pattern, and adds only the entry's lines", () => {
    write(CONFIG);
    addCollection("shelf", "/home/u/shelf", "{*.md,research/*.md}");
    expect(read()).toBe(
      edit(CONFIG, "# lifecycle is reviewed quarterly",
        `  shelf:\n    path: /home/u/shelf\n    pattern: "{*.md,research/*.md}"\n# lifecycle is reviewed quarterly`),
    );
    expect(loadConfig().collections.shelf).toEqual({ path: "/home/u/shelf", pattern: "{*.md,research/*.md}" });
  });

  it("re-adding a collection changes path and pattern in place and keeps its context, update command and comments", () => {
    write(CONFIG);
    addCollection("papers", "/home/u/reading", "*.md");
    const expected = edit(
      edit(CONFIG, "path: /home/u/papers\n", "path: /home/u/reading\n"),
      `pattern: "**/*.md" # every note`, `pattern: "*.md" # every note`,
    );
    expect(read()).toBe(expected);
    expect(loadConfig().collections.papers).toEqual({
      path: "/home/u/reading",
      pattern: "*.md",
      update: "git pull",
      context: { "/": "Papers I am reading" },
    });
  });

  it("remove takes the entry and the comment directly above it; a header set off by a blank line stays", () => {
    write(CONFIG);
    expect(removeCollection("papers")).toBe(true);
    expect(read()).toBe(edit(CONFIG, PAPERS, ""));
    expect(read()).toContain("# --- research ---");
    expect(loadConfig().collections.papers).toBeUndefined();
  });

  it("removing the first entry does not leave its comment on the entry that moves up", () => {
    write(CONFIG);
    expect(removeCollection("atlas")).toBe(true);
    const out = read();
    expect(out).toBe(edit(CONFIG, ATLAS, ""));
    expect(out).not.toContain("# atlas lists");
    expect(YAML.parse(out).collections).toEqual(YAML.parse(edit(CONFIG, ATLAS, "")).collections);
  });

  it("removing the last entry leaves the next top-level key's comment alone", () => {
    write(CONFIG);
    expect(removeCollection("notes")).toBe(true);
    expect(read()).toBe(edit(CONFIG, NOTES, ""));
  });

  it("removing an entry whose own comment block is set off by a blank line keeps the whole block", () => {
    const text = `collections:
  a:
    path: /a
    pattern: "*.md"

  # b and c are archives

  b:
    path: /b
    pattern: "*.md"
  c:
    path: /c
    pattern: "*.md"
`;
    write(text);
    expect(removeCollection("b")).toBe(true);
    expect(read()).toBe(edit(text, `  b:\n    path: /b\n    pattern: "*.md"\n`, ""));
  });

  it("a kept header takes the blank line of the entry it outlived, not the next entry's", () => {
    const text = `collections:
  a:
    path: /a
    pattern: "*.md"
  # archives

  # b is frozen
  b:
    path: /b
    pattern: "*.md"

  c:
    path: /c
    pattern: "*.md"
`;
    write(text);
    expect(removeCollection("b")).toBe(true);
    expect(read()).toBe(edit(text, `  # b is frozen\n  b:\n    path: /b\n    pattern: "*.md"\n\n`, ""));
  });

  it("removing the only entry keeps a header set off by a blank line", () => {
    write(`collections:\n  # indexed nightly\n\n  # notes: the vault\n${NOTES}lifecycle:\n  archive_after_days: 60\n`);
    expect(removeCollection("notes")).toBe(true);
    const out = read();
    expect(out).toContain("# indexed nightly");
    expect(out).not.toContain("# notes: the vault");
    expect(YAML.parse(out)).toEqual({ collections: {}, lifecycle: { archive_after_days: 60 } });
  });

  it("rename changes only the key line", () => {
    write(CONFIG);
    expect(renameCollection("papers", "reading")).toBe(true);
    expect(read()).toBe(edit(CONFIG, "  papers:\n", "  reading:\n"));
    expect(loadConfig().collections.reading?.update).toBe("git pull");
  });

  it("rename still refuses a name that is taken, and writes nothing", () => {
    write(CONFIG);
    expect(() => renameCollection("papers", "notes")).toThrow("Collection 'notes' already exists");
    expect(read()).toBe(CONFIG);
  });

  it("handles a key that YAML reads as a number, such as 2024", () => {
    const text = `collections:
  # the 2024 archive
  2024:
    path: /home/u/2024
    pattern: "**/*.md"
${NOTES}`;
    write(text);
    addCollection("2024", "/home/u/archive", "*.md");
    const updated = read();
    expect(updated).toBe(edit(text, "path: /home/u/2024\n", "path: /home/u/archive\n").replace(`pattern: "**/*.md"`, `pattern: "*.md"`));
    expect(Object.keys(YAML.parse(updated).collections)).toEqual(["2024", "notes"]);

    expect(renameCollection("2024", "archive")).toBe(true);
    expect(read()).toContain("  # the 2024 archive\n  archive:\n");

    write(text);
    expect(removeCollection("2024")).toBe(true);
    expect(read()).toBe(`collections:\n${NOTES}`);
  });

  it("an empty flow mapping becomes block style when the first entry is added", () => {
    write("collections: {}\n");
    addCollection("notes", "/home/u/notes");
    expect(read()).toBe(`collections:\n  notes:\n    path: /home/u/notes\n    pattern: "**/*.md"\n`);
  });

  it("creates the file when there is none", () => {
    addCollection("notes", "/home/u/notes");
    expect(loadConfig().collections.notes).toEqual({ path: "/home/u/notes", pattern: "**/*.md" });
  });

  it("a comment at the end of the file survives, and a second write changes nothing", () => {
    write(`collections:\n${NOTES}# end of file\n`);
    addCollection("notes", "/home/u/notes", "**/*.md");
    const once = read();
    expect(once).toContain("# end of file");
    addCollection("notes", "/home/u/notes", "**/*.md");
    expect(read()).toBe(once);
  });

  it("an unparseable file throws and is left untouched", () => {
    const broken = "collections: [\n  # half an edit\n";
    write(broken);
    expect(() => addCollection("notes", "/home/u/notes")).toThrow("Failed to parse");
    expect(read()).toBe(broken);
  });
});

describe("context writers keep config.yaml comments", () => {
  it("setGlobalContext replaces the value and keeps the comment on its line", () => {
    write(CONFIG);
    setGlobalContext("Work notes");
    expect(read()).toBe(edit(CONFIG, `"Personal notes"`, `"Work notes"`));
  });

  it("clearing the global context removes only that line", () => {
    write(CONFIG);
    setGlobalContext(undefined);
    expect(read()).toBe(edit(CONFIG, `global_context: "Personal notes" # applies to every collection\n`, ""));
    expect(read()).toContain("# ClawMem collections, edited by hand");
  });

  it("addContext creates a block-style context under an entry that had none", () => {
    write(CONFIG);
    expect(addContext("notes", "/daily", "Daily notes")).toBe(true);
    expect(read()).toBe(edit(CONFIG, NOTES, `${NOTES}    context:\n      /daily: Daily notes\n`));
  });

  it("removeContext of the last prefix removes the context mapping and nothing else", () => {
    write(CONFIG);
    expect(removeContext("papers", "/")).toBe(true);
    expect(read()).toBe(edit(CONFIG, `    context:\n      /: "Papers I am reading"\n`, ""));
    expect(loadConfig().collections.papers?.context).toBeUndefined();
  });

  it("a comment inside a context mapping outlives the mapping when its last prefix is removed", () => {
    const text = `collections:
  papers:
    path: /home/u/papers
    pattern: "**/*.md"
    context:
      # contexts follow the folder layout

      /: "Papers I am reading"
${NOTES}`;
    write(text);
    expect(removeContext("papers", "/")).toBe(true);
    const out = read();
    expect(out).toContain("# contexts follow the folder layout");
    expect(YAML.parse(out).collections.papers).toEqual({ path: "/home/u/papers", pattern: "**/*.md" });
  });
});

describe("writers respect aliases, tags and key-line comments", () => {
  const ANCHORED = `collections:
  a: &base
    path: /old
    pattern: "*.md"
    context:
      /: shared context
  b: *base
`;

  it("editing an anchored collection does not change the collection that aliases it", () => {
    write(ANCHORED);
    addCollection("a", "/new", "*.md");
    const c = loadConfig().collections;
    expect(c.a).toEqual({ path: "/new", pattern: "*.md", context: { "/": "shared context" } });
    expect(c.b).toEqual({ path: "/old", pattern: "*.md", context: { "/": "shared context" } });
  });

  it("an alias-valued collection keeps its context when re-added, and takes a new context alone", () => {
    write(ANCHORED);
    addCollection("b", "/nb", "*.md");
    let c = loadConfig().collections;
    expect(c.b).toEqual({ path: "/nb", pattern: "*.md", context: { "/": "shared context" } });
    expect(c.a!.path).toBe("/old");

    write(ANCHORED);
    expect(addContext("b", "/x", "x context")).toBe(true);
    c = loadConfig().collections;
    expect(c.b!.context).toEqual({ "/": "shared context", "/x": "x context" });
    expect(c.a!.context).toEqual({ "/": "shared context" });
  });

  it("removing an anchored collection that an alias still names works, and the alias keeps its data", () => {
    write(ANCHORED);
    expect(removeCollection("a")).toBe(true);
    expect(loadConfig().collections).toEqual({
      b: { path: "/old", pattern: "*.md", context: { "/": "shared context" } },
    });
  });

  it("finds a collection whose key is an alias", () => {
    const text = `names:
  first: &n archive
collections:
  ? *n
  :
    path: /home/u/archive
    pattern: "*.md"
${NOTES}`;
    write(text);
    expect(loadConfig().collections.archive).toBeDefined();
    expect(renameCollection("archive", "old-archive")).toBe(true);
    expect(Object.keys(loadConfig().collections)).toEqual(["old-archive", "notes"]);
    write(text);
    expect(removeCollection("archive")).toBe(true);
    expect(Object.keys(loadConfig().collections)).toEqual(["notes"]);
  });

  it("an explicit tag on an old value does not survive a new value", () => {
    write(`collections:\n  x:\n    path: !!int 3\n    pattern: "*.md"\n`);
    addCollection("x", "/new", "*.md");
    expect(loadConfig().collections.x!.path).toBe("/new");
    expect(read()).not.toContain("!!int");
  });

  const KEYLINE = `collections: # why this exists
  # a: the vault
  a:
    path: /a
    pattern: "*.md"
  b:
    path: /b
    pattern: "*.md"
`;

  it("a comment on the collections: line stays on that line through an unrelated edit", () => {
    write(KEYLINE);
    addCollection("c", "/c", "*.md");
    expect(read()).toBe(`${KEYLINE}  c:\n    path: /c\n    pattern: "*.md"\n`);
  });

  it("removing the first collection keeps the comment on the collections: line", () => {
    write(KEYLINE);
    expect(removeCollection("a")).toBe(true);
    expect(read()).toBe(`collections: # why this exists\n  b:\n    path: /b\n    pattern: "*.md"\n`);
  });

  it("a key-line comment followed by a blank line round-trips", () => {
    const text = `collections: # why this exists\n\n  a:\n    path: /a\n    pattern: "*.md"\n`;
    write(text);
    addCollection("a", "/a", "*.md");
    expect(read()).toBe(text);
  });

  it("the comment on a context: line outlives the context mapping", () => {
    write(`collections:\n  papers:\n    path: /p\n    pattern: "*.md"\n    context: # contexts follow the folder layout\n      /: Papers\n`);
    expect(removeContext("papers", "/")).toBe(true);
    const out = read();
    expect(out).toContain("# contexts follow the folder layout");
    expect(YAML.parse(out).collections.papers).toEqual({ path: "/p", pattern: "*.md" });
  });

  it("filling an empty collection keeps the comment on its line", () => {
    write(`collections:\n  a: # reason for this placeholder\n${NOTES}`);
    addCollection("a", "/a", "*.md");
    expect(read()).toBe(`collections:\n  a: # reason for this placeholder\n    path: /a\n    pattern: "*.md"\n${NOTES}`);
  });

  it("filling an empty context keeps the comment on its line", () => {
    const head = `collections:\n  notes:\n    path: /n\n    pattern: "*.md"\n    context: # none yet\n`;
    write(head);
    expect(addContext("notes", "/daily", "Daily")).toBe(true);
    expect(read()).toBe(`${head}      /daily: Daily\n`);
  });
});

describe("aliases change only when an edit reaches what they name", () => {
  const SHARED = `collections:
  a: &base
    # path must avoid vendors
    path: /old
    pattern: "*.md"
  b: *base
`;
  const count = (text: string, needle: string) => text.split(needle).length - 1;

  it("an unrelated write leaves an alias, and the comments inside what it names, as they were", () => {
    write(SHARED);
    setGlobalContext("notes");
    expect(read()).toBe(`${SHARED}global_context: notes\n`);
    write(SHARED);
    addCollection("c", "/c", "*.md");
    expect(read()).toBe(`${SHARED}  c:\n    path: /c\n    pattern: "*.md"\n`);
  });

  it("editing the anchored node copies it to the alias without copying its comments", () => {
    write(SHARED);
    addCollection("a", "/new", "*.md");
    const out = read();
    expect(count(out, "# path must avoid vendors")).toBe(1);
    expect(loadConfig().collections.b).toEqual({ path: "/old", pattern: "*.md" });
  });

  it("removing the anchored node moves its comments to the alias that keeps its data", () => {
    write(SHARED);
    expect(removeCollection("a")).toBe(true);
    const out = read();
    expect(count(out, "# path must avoid vendors")).toBe(1);
    expect(loadConfig().collections).toEqual({ b: { path: "/old", pattern: "*.md" } });
  });

  it("a key that is an alias to a list comes through an unrelated write unchanged", () => {
    const text = `names:
  pair: &n [archive, old]
collections:
  ? *n
  :
    path: /home/u/x
    pattern: "*.md"
${NOTES}`;
    write(text);
    const before = YAML.parse(text);
    addCollection("c", "/c", "*.md");
    const out = read();
    const after = YAML.parse(out);
    delete after.collections.c;
    expect(after).toEqual(before);
    expect(out).toContain("? *n");
  });

  it("a comment after an anchor on the collections: line survives removing the first collection", () => {
    write(`collections: &c # why this exists\n  # a: the vault\n  a:\n    path: /a\n    pattern: "*.md"\n  b:\n    path: /b\n    pattern: "*.md"\n`);
    expect(removeCollection("a")).toBe(true);
    const out = read();
    expect(out).toContain("# why this exists");
    expect(out).not.toContain("# a: the vault");
    expect(Object.keys(YAML.parse(out).collections)).toEqual(["b"]);
  });
});

describe("copies made for aliases keep their own references", () => {
  const LOOP = `collections:
  a: &base
    path: /a
    pattern: "*.md"
    loop: *base
  b: *base
`;

  it("a collection that aliases itself can be removed, and the alias keeps its value", () => {
    write(LOOP);
    expect(removeCollection("a")).toBe(true);
    const b = YAML.parse(read()).collections.b;
    expect(b.path).toBe("/a");
    expect(b.loop).toBe(b);
  });

  it("a collection that aliases itself can be edited, and the alias keeps its old value", () => {
    write(LOOP);
    addCollection("a", "/new", "*.md");
    const c = YAML.parse(read()).collections;
    expect(c.a.path).toBe("/new");
    expect(c.a.loop).toBe(c.a);
    expect(c.b.path).toBe("/a");
    expect(c.b.loop).toBe(c.b);
  });

  it("anchors inside a copied collection stay shared inside the copy, so no comment doubles", () => {
    write(`collections:
  a: &base
    path: /a
    pattern: "*.md"
    context:
      /: &inner hello # inner note
      /other: *inner
  b: *base
`);
    expect(removeCollection("a")).toBe(true);
    const out = read();
    expect(out.split("# inner note").length - 1).toBe(1);
    expect(loadConfig().collections.b!.context).toEqual({ "/": "hello", "/other": "hello" });
  });

  it("replacing an alias value keeps the alias's own comment", () => {
    write(`defaults:
  root: &p /home/u/shared
  note: &ctx Shared notes
global_context: *ctx # set once for every vault
collections:
  a:
    path: *p # local reason
    pattern: "*.md"
`);
    addCollection("a", "/home/u/a", "*.md");
    expect(read()).toContain("    path: /home/u/a # local reason\n");
    setGlobalContext("Mine");
    expect(read()).toContain("global_context: Mine # set once for every vault\n");
  });
});

describe("a copy keeps what its aliases named where they stood", () => {
  it("an alias inside a copy keeps its value when the anchor it names is redefined later", () => {
    write(`first: &ctx old
template: &t
  path: /t
  pattern: "*.md"
  context:
    /: *ctx
second: &ctx new
collections:
  a: *t
`);
    addCollection("a", "/a", "*.md");
    expect(loadConfig().collections.a).toEqual({ path: "/a", pattern: "*.md", context: { "/": "old" } });
    expect(YAML.parse(read()).template.context["/"]).toBe("old");
  });
});

describe("keys and flow collections come through as the plain config reads them", () => {
  it("a list-valued alias used as a key inside a copied collection keeps its name", () => {
    write(`names:
  pair: &n [archive, old]
template: &t
  path: /t
  pattern: "*.md"
  context:
    ? *n
    : both archives
collections:
  a: *t
`);
    const before = YAML.parse(read()).collections.a.context;
    addCollection("a", "/a", "*.md");
    expect(YAML.parse(read()).collections.a.context).toEqual(before);
  });

  it("a list-valued alias key elsewhere keeps its name when the list it names is removed", () => {
    write(`collections:
  a:
    path: /a
    pattern: "*.md"
    tags: &n [archive, old]
  b:
    path: /b
    pattern: "*.md"
    context:
      ? *n
      : tagged
`);
    const before = YAML.parse(read()).collections.b;
    expect(removeCollection("a")).toBe(true);
    expect(YAML.parse(read()).collections).toEqual({ b: before });
  });

  it("flow lists keep the file's own spacing", () => {
    const tight = `collections:\n${NOTES}lifecycle:\n  exempt_collections: [notes, work]\n`;
    write(tight);
    addCollection("c", "/c", "*.md");
    expect(read()).toBe(edit(tight, "lifecycle:", `  c:\n    path: /c\n    pattern: "*.md"\nlifecycle:`));
    const padded = edit(tight, "[notes, work]", "[ notes, work ]");
    write(padded);
    addCollection("c", "/c", "*.md");
    expect(read()).toBe(edit(padded, "lifecycle:", `  c:\n    path: /c\n    pattern: "*.md"\nlifecycle:`));
  });
});

describe("a collection keyed by a list", () => {
  const LISTKEY = `collections:\n  ? [archive, old]\n  :\n    path: /x\n    pattern: "*.md"\n${NOTES}`;

  it("can be updated in place and removed under the name the plain config gives it", () => {
    write(LISTKEY);
    const name = Object.keys(loadConfig().collections)[0]!;
    addCollection(name, "/y", "*.md");
    expect(Object.keys(loadConfig().collections)).toEqual([name, "notes"]);
    expect(loadConfig().collections[name]!.path).toBe("/y");
    expect(removeCollection(name)).toBe(true);
    expect(Object.keys(loadConfig().collections)).toEqual(["notes"]);
  });
});

describe("an edit that cannot be made in place stops with the file untouched", () => {
  const MERGED = `defaults: &d
  a:
    path: /a
    pattern: "*.md"
collections:
  !!merge <<: *d
`;

  it("editing a collection that only a merge key provides is refused, not half-made", () => {
    write(MERGED);
    expect(loadConfig().collections.a).toEqual({ path: "/a", pattern: "*.md" });
    expect(() => addContext("a", "/", "why")).toThrow("Cannot edit");
    expect(read()).toBe(MERGED);
    expect(() => removeCollection("a")).toThrow("Cannot edit");
    expect(() => renameCollection("a", "b")).toThrow("Cannot edit");
    expect(read()).toBe(MERGED);
  });

  it("an edit elsewhere in a file with a merge key still goes through", () => {
    write(MERGED);
    addCollection("notes", "/home/u/notes", "*.md");
    expect(loadConfig().collections).toEqual({
      a: { path: "/a", pattern: "*.md" },
      notes: { path: "/home/u/notes", pattern: "*.md" },
    });
    expect(read()).toContain("!!merge <<: *d");
  });
});

describe("an alias inside the map it names follows that map through an edit", () => {
  it("a top level that aliases itself can be edited, and the alias still names it", () => {
    write(`&root\ncollections: {}\nself: *root\n`);
    addCollection("a", "/a", "*.md");
    expect(read()).toBe(`&root\ncollections:\n  a:\n    path: /a\n    pattern: "*.md"\nself: *root\n`);
    setGlobalContext("Mine");
    expect(renameCollection("a", "b")).toBe(true);
    expect(removeCollection("b")).toBe(true);
    expect(read()).toBe(`&root\ncollections: {}\nself: *root\nglobal_context: Mine\n`);
    const config = loadConfig() as unknown as Record<string, unknown>;
    expect(config.self).toBe(config);
  });

  it("a collection that aliases the collections map still names it after another collection is added", () => {
    const text = `collections: &c\n  a:\n    path: /a\n    pattern: "*.md"\n    all: *c\n`;
    write(text);
    addCollection("b", "/b", "*.md");
    expect(read()).toBe(`${text}  b:\n    path: /b\n    pattern: "*.md"\n`);
    const { collections } = loadConfig();
    expect((collections.a as unknown as Record<string, unknown>).all).toBe(collections);
  });

  it("a collection that aliases the top level can be renamed and given a context", () => {
    const text = `&root\ncollections:\n  a:\n    path: /a\n    pattern: "*.md"\n    top: *root\n`;
    write(text);
    expect(renameCollection("a", "b")).toBe(true);
    expect(read()).toBe(edit(text, "  a:\n", "  b:\n"));
    expect(addContext("b", "/", "x")).toBe(true);
    const config = loadConfig();
    expect((config.collections.b as unknown as Record<string, unknown>).top).toBe(config);
  });

  it("a copy made for another alias keeps the old value of what such an alias names", () => {
    write(`collections: &c\n  a: &e\n    path: /a\n    pattern: "*.md"\n    all: *c\n  b: *e\n`);
    addCollection("a", "/new", "*.md");
    const { collections } = YAML.parse(read());
    expect(collections.a.path).toBe("/new");
    expect(collections.a.all).toBe(collections);
    expect(collections.b.path).toBe("/a");
    expect(collections.b.all.a.path).toBe("/a");
  });
});

describe("a !!set or !!omap keeps its keys as values through an edit", () => {
  it("an alias to the top level inside a !!omap or !!set still names it after an edit", () => {
    const text = `&root\ncollections: {}\nordered: !!omap\n  - self: *root\nmembers: !!set\n  ? *root\n`;
    write(text);
    addCollection("a", "/a", "*.md");
    expect(read()).toBe(edit(text, "collections: {}\n", `collections:\n  a:\n    path: /a\n    pattern: "*.md"\n`));
    const config = YAML.parse(read());
    expect(config.ordered.get("self")).toBe(config);
    expect(config.members.has(config)).toBe(true);
  });

  it("a !!set or !!omap key that aliases an edited collection keeps the collection's old value", () => {
    write(`collections:\n  a: &e\n    path: /a\n    pattern: "*.md"\nmembers: !!set\n  ? *e\nordered: !!omap\n  - ? *e\n    : v\n`);
    expect(addContext("a", "/", "x")).toBe(true);
    const old = { path: "/a", pattern: "*.md" };
    const { members, ordered, collections } = YAML.parse(read());
    expect([...members]).toEqual([old]);
    expect([...ordered]).toEqual([[old, "v"]]);
    expect(collections.a).toEqual({ ...old, context: { "/": "x" } });
  });

  it("a !!set key that aliases a removed collection keeps its value", () => {
    write(`collections:\n  a: &e\n    path: /a\n    pattern: "*.md"\nmembers: !!set\n  ? *e\n`);
    expect(removeCollection("a")).toBe(true);
    expect(read()).toBe(`collections: {}\nmembers: !!set\n  ? path: /a\n    pattern: "*.md"\n`);
  });

  it("a copied collection keeps a !!set whose key is a list alias", () => {
    write(`names: &n [archive, old]\ntemplate: &t\n  path: /t\n  pattern: "*.md"\n  tags: !!set\n    ? *n\ncollections:\n  a: *t\n`);
    addCollection("a", "/a", "*.md");
    const { template, collections } = YAML.parse(read());
    expect([...collections.a.tags]).toEqual([["archive", "old"]]);
    expect([...template.tags]).toEqual([["archive", "old"]]);
  });
});

describe("aliases that named one node name one copy of it after an edit", () => {
  it("two aliases to an edited collection stay one object, so a !!set holding both keeps one element", () => {
    write(`collections:\n  a: &e\n    path: /a\n    pattern: "*.md"\nmembers: !!set\n  ? *e\n  ? *e\nboth: [*e, *e]\n`);
    expect(addContext("a", "/", "x")).toBe(true);
    const old = { path: "/a", pattern: "*.md" };
    const { members, both, collections } = YAML.parse(read());
    expect([...members]).toEqual([old]);
    expect(both).toEqual([old, old]);
    expect(both[0]).toBe(both[1]);
    expect(collections.a).toEqual({ ...old, context: { "/": "x" } });
  });

  it("a copied collection's !!set holding two aliases to one list keeps one element", () => {
    write(`names: &n [archive, old]\ntemplate: &t\n  path: /t\n  pattern: "*.md"\n  tags: !!set\n    ? *n\n    ? *n\ncollections:\n  a: *t\n`);
    addCollection("a", "/a", "*.md");
    const { template, collections } = YAML.parse(read());
    expect([...collections.a.tags]).toEqual([["archive", "old"]]);
    expect([...template.tags]).toEqual([["archive", "old"]]);
  });

  it("a !!timestamp aliased twice in a !!set keeps one element when its collection is removed", () => {
    write(`collections:\n  a:\n    path: /a\n    pattern: "*.md"\n    since: &d !!timestamp 2024-01-01\nseen: !!set\n  ? *d\n  ? *d\n`);
    expect(removeCollection("a")).toBe(true);
    const { seen } = YAML.parse(read());
    expect([...seen]).toEqual([new Date("2024-01-01")]);
  });

  it("a plain scalar aliased twice still becomes two plain copies", () => {
    write(`collections:\n  a:\n    path: /a\n    pattern: "*.md"\n    note: &s hello\nboth: [*s, *s]\n`);
    expect(removeCollection("a")).toBe(true);
    expect(read()).toBe(`collections: {}\nboth: [hello, hello]\n`);
  });
});
