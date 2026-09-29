/**
 * v0.40.1 watcher regressions.
 *
 *   pre-check  `clawmem watch` skips a changed file unless it can match its collection's pattern. Until
 *              v0.40.1 the check read a pattern's directory part as a literal prefix and split braces by
 *              stripping one leading `{` and one trailing `}`, so it dropped EVERY event for a pattern
 *              with a wildcard directory (`*\/memory/**\/*.md`) or a brace list with a suffix
 *              (`{README,guide}.md`). Those collections re-indexed only on a manual `clawmem update`.
 *   routing    an event reached only the longest matching collection path (a string-prefix test), so an
 *              overlapping outer collection missed a file the inner one's pattern rejected, `notes-archive/`
 *              was routed to `notes`, and a "/" root lost a character of every path.
 *   cap        the per-collection-path cap on watched directories was a hardcoded 500, and nothing
 *              but a log line said so. `CLAWMEM_WATCH_MAX_DIRS` now sets it.
 *
 * Reintroducing the literal-prefix check makes the first two pre-check cases fail.
 *
 * v0.40.2:
 *   rescan     Bun before 1.4.0 folds the events that reach one watched directory together into one callback per
 *              event type, named after the first file. An atomic save (a temp file renamed over the target) came
 *              through under the temp file's name, a rename under the old name only, and the second of two files
 *              written back-to-back not at all, so those changes waited for a full index pass. Every event now
 *              schedules a rescan of its directory. The delivery cases below fail on v0.40.1 under Bun 1.3.14.
 *
 * v0.40.3:
 *   new dirs   the watcher walked each collection path once, at start, so a directory made later (a new Claude Code
 *              project and its `memory/` among them) went unwatched until a restart, and one deleted and made again
 *              kept a dead watch. A rescan now watches a new subdirectory and stops watching one that is gone or was
 *              replaced. The cases that make a directory after the start fail on v0.40.2 under Bun 1.3.14 and 1.4.2.
 */
import { describe, test, expect } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { matchesCollectionPattern, watchTargets } from "../../src/indexer.ts";
import { DEFAULT_MAX_WATCH_DIRS, listWatchedFiles, resolveMaxWatchDirs, startWatcher } from "../../src/watcher.ts";

describe("matchesCollectionPattern — the watcher's pre-check", () => {
  test("a wildcard directory part matches real paths", () => {
    expect(matchesCollectionPattern("*/memory/**/*.md", "project-a/memory/notes.md")).toBe(true);
    expect(matchesCollectionPattern("*/memory/**/*.md", "project-a/memory/topic/notes.md")).toBe(true);
  });

  test("a brace list followed by a suffix matches each name", () => {
    expect(matchesCollectionPattern("{README,guide}.md", "README.md")).toBe(true);
    expect(matchesCollectionPattern("{README,guide}.md", "guide.md")).toBe(true);
  });

  test("files the pattern cannot match are still skipped", () => {
    expect(matchesCollectionPattern("*/memory/**/*.md", "project-a/notes/x.md")).toBe(false);
    expect(matchesCollectionPattern("*/memory/**/*.md", "project-a/sub/memory/x.md")).toBe(false);
    expect(matchesCollectionPattern("{README,guide}.md", "other.md")).toBe(false);
    expect(matchesCollectionPattern("notes.md", "sub/other.md")).toBe(false);
    expect(matchesCollectionPattern("{docs/*.md,docs/**/*.md}", "src/readme.md")).toBe(false);
  });

  test("the shapes that already worked keep working", () => {
    expect(matchesCollectionPattern("notes.md", "notes.md")).toBe(true);
    expect(matchesCollectionPattern("{docs/*.md,docs/**/*.md}", "docs/guide.md")).toBe(true);
    expect(matchesCollectionPattern("{docs/*.md,docs/**/*.md}", "docs/a/b.md")).toBe(true);
    expect(matchesCollectionPattern("{*.md,research/**/*.md}", "top.md")).toBe(true);
    expect(matchesCollectionPattern("**/*.md", "any/depth/file.md")).toBe(true);
  });

  test("an unnormalised pattern matches like its normal form", () => {
    expect(matchesCollectionPattern("./README.md", "README.md")).toBe(true);
    expect(matchesCollectionPattern("{./docs/**/*.md,x.md}", "docs/a.md")).toBe(true);
    expect(matchesCollectionPattern("docs/./reference/*.md", "docs/reference/configuration.md")).toBe(true);
    expect(matchesCollectionPattern("docs//reference/*.md", "docs/reference/configuration.md")).toBe(true);
    expect(matchesCollectionPattern("**/*.md/", "docs/reference/configuration.md")).toBe(true);
  });

  test("a pattern outside the collection root defers to the index pass", () => {
    expect(matchesCollectionPattern("../shared/*.md", "anything.md")).toBe(true);
    expect(matchesCollectionPattern("/abs/*.md", "anything.md")).toBe(true);
  });
});

describe("watchTargets — which collections a changed file re-indexes", () => {
  const cols = [
    { name: "inner", path: "/v/outer/inner", pattern: "notes.md" },
    { name: "outer", path: "/v/outer", pattern: "**/*.md" },
    { name: "notes", path: "/v/notes", pattern: "**/*.md" },
    { name: "mem", path: "/v/projects", pattern: "*/memory/**/*.md" },
  ];
  const names = (fullPath: string) => watchTargets(cols, fullPath).map((t) => `${t.col.name}:${t.relativePath}`);

  test("every collection whose pattern matches, not only the longest path", () => {
    expect(names("/v/outer/inner/other.md")).toEqual(["outer:inner/other.md"]);
    expect(names("/v/outer/inner/notes.md")).toEqual(["inner:notes.md", "outer:inner/notes.md"]);
  });

  test("a sibling that shares a name prefix is not inside the collection", () => {
    expect(names("/v/notes-archive/a.md")).toEqual([]);
    expect(names("/v/notes/a.md")).toEqual(["notes:a.md"]);
  });

  test("the auto-memory pattern routes memory files and skips the rest", () => {
    expect(names("/v/projects/p1/memory/n.md")).toEqual(["mem:p1/memory/n.md"]);
    expect(names("/v/projects/p1/notes/n.md")).toEqual([]);
  });

  test("a collection rooted at / keeps the whole relative path", () => {
    expect(watchTargets([{ name: "root", path: "/", pattern: "README.md" }], "/README.md")
      .map((t) => t.relativePath)).toEqual(["README.md"]);
  });

  test("an unnormalised collection path still contains its files", () => {
    for (const path of ["/v/./notes", "/v//notes", "/v/notes/"]) {
      expect(watchTargets([{ name: "n", path, pattern: "**/*.md" }], "/v/notes/x.md").map((t) => t.relativePath)).toEqual(["x.md"]);
    }
  });

  test("a collection without a pattern takes every file under it", () => {
    expect(watchTargets([{ name: "any", path: "/v/any" }], "/v/any/x/y.md").map((t) => t.relativePath)).toEqual(["x/y.md"]);
  });
});

describe("the per-collection watch cap — CLAWMEM_WATCH_MAX_DIRS", () => {
  test("defaults to 500", () => {
    expect(DEFAULT_MAX_WATCH_DIRS).toBe(500);
    expect(resolveMaxWatchDirs({})).toBe(500);
    for (const blank of ["", "   "]) {
      const reported: string[] = [];
      expect(resolveMaxWatchDirs({ CLAWMEM_WATCH_MAX_DIRS: blank }, (r) => reported.push(r))).toBe(500);
      expect(reported).toEqual([]);                       // unset or empty is not a mistake
    }
  });

  test("a positive integer sets it", () => {
    expect(resolveMaxWatchDirs({ CLAWMEM_WATCH_MAX_DIRS: "4000" })).toBe(4000);
    expect(resolveMaxWatchDirs({ CLAWMEM_WATCH_MAX_DIRS: " 20 " })).toBe(20);
  });

  test("any other value falls back to the default and is reported", () => {
    for (const raw of ["0", "-5", "1.5", "abc", "1e3", "12abc"]) {
      const reported: string[] = [];
      expect(resolveMaxWatchDirs({ CLAWMEM_WATCH_MAX_DIRS: raw }, (r) => reported.push(r))).toBe(500);
      expect(reported).toEqual([raw]);
    }
  });

  test("startWatcher watches at most the cap and names the setting when it caps", () => {
    const root = mkdtempSync(join(tmpdir(), "clawmem-watch-cap-"));
    for (let i = 0; i < 5; i++) mkdirSync(join(root, `d${i}`));
    const logs: string[] = [];
    const log = console.log;
    const prev = process.env.CLAWMEM_WATCH_MAX_DIRS;
    process.env.CLAWMEM_WATCH_MAX_DIRS = "3";
    console.log = (...args: unknown[]) => { logs.push(args.join(" ")); };
    try {
      startWatcher([root], { onChanged: async () => {} }).close();
    } finally {
      console.log = log;
      if (prev === undefined) delete process.env.CLAWMEM_WATCH_MAX_DIRS;
      else process.env.CLAWMEM_WATCH_MAX_DIRS = prev;
      rmSync(root, { recursive: true, force: true });
    }
    const line = logs.find((l) => l.includes(root)) ?? "";
    expect(line).toContain("has 6 dirs");
    expect(line).toContain("watching the first 3");
    expect(line).toContain("CLAWMEM_WATCH_MAX_DIRS");
  });
});

describe("startWatcher rescans a directory after any event (v0.40.2)", () => {
  const DEBOUNCE_MS = 100;
  const SETTLE_MS = 700;                                  // well past the rescan plus the per-file debounce

  async function watching(files: Record<string, string>) {
    const dir = mkdtempSync(join(tmpdir(), "clawmem-watch-rescan-"));
    for (const [name, body] of Object.entries(files)) {
      mkdirSync(join(dir, name, ".."), { recursive: true });
      writeFileSync(join(dir, name), body);
    }
    const calls: string[] = [];
    const log = console.log;
    console.log = () => {};                               // startWatcher reports each path it watches
    let handle: { close: () => void };
    try {
      handle = startWatcher([dir], { debounceMs: DEBOUNCE_MS, onChanged: async (p) => { calls.push(p); } });
    } finally {
      console.log = log;
    }
    await Bun.sleep(150);                                 // let the watches settle before the first write
    const delivered = (name: string) => calls.filter((p) => p === join(dir, name)).length;
    const waitFor = async (names: string[]) => {       // up to 120 × 25 ms, no clock read
      for (let i = 0; i < 120 && !names.every((n) => delivered(n) > 0); i++) await Bun.sleep(25);
    };
    const stop = () => { handle.close(); rmSync(dir, { recursive: true, force: true }); };
    return { dir, calls, delivered, waitFor, stop };
  }

  test("an atomic save is delivered under the target's name, once", async () => {
    const w = await watching({ "a.md": "one" });
    try {
      writeFileSync(join(w.dir, "a.md.tmp.4242.9f3c"), "two");
      renameSync(join(w.dir, "a.md.tmp.4242.9f3c"), join(w.dir, "a.md"));
      await w.waitFor(["a.md"]);
      await Bun.sleep(SETTLE_MS);
      expect(w.delivered("a.md")).toBe(1);
      expect(w.calls.filter((p) => p.includes(".tmp."))).toEqual([]);
    } finally { w.stop(); }
  }, 10_000);

  test("an atomic save that creates a file is delivered", async () => {
    const w = await watching({});
    try {
      writeFileSync(join(w.dir, "n.md.tmp.4242.9f3c"), "new");
      renameSync(join(w.dir, "n.md.tmp.4242.9f3c"), join(w.dir, "n.md"));
      await w.waitFor(["n.md"]);
      expect(w.delivered("n.md")).toBe(1);
    } finally { w.stop(); }
  }, 10_000);

  test("a rename inside the directory delivers the old name and the new one", async () => {
    const w = await watching({ "b.md": "b" });
    try {
      renameSync(join(w.dir, "b.md"), join(w.dir, "c.md"));
      await w.waitFor(["b.md", "c.md"]);
      expect([w.delivered("b.md"), w.delivered("c.md")]).toEqual([1, 1]);
    } finally { w.stop(); }
  }, 10_000);

  test("two files written back-to-back are both delivered", async () => {
    const w = await watching({ "f.md": "f", "g.md": "g" });
    try {
      writeFileSync(join(w.dir, "f.md"), "f2");
      writeFileSync(join(w.dir, "g.md"), "g2");
      await w.waitFor(["f.md", "g.md"]);
      expect([w.delivered("f.md"), w.delivered("g.md")]).toEqual([1, 1]);
    } finally { w.stop(); }
  }, 10_000);

  test("two files deleted together are both delivered", async () => {
    const w = await watching({ "d1.md": "1", "d2.md": "2" });
    try {
      unlinkSync(join(w.dir, "d1.md"));
      unlinkSync(join(w.dir, "d2.md"));
      await w.waitFor(["d1.md", "d2.md"]);
      expect([w.delivered("d1.md"), w.delivered("d2.md")]).toEqual([1, 1]);
    } finally { w.stop(); }
  }, 10_000);

  test("an atomic save in a subdirectory is delivered with its full path", async () => {
    const w = await watching({ "sub/s.md": "s" });
    try {
      writeFileSync(join(w.dir, "sub", "s.md.tmp.4242.9f3c"), "s2");
      renameSync(join(w.dir, "sub", "s.md.tmp.4242.9f3c"), join(w.dir, "sub", "s.md"));
      await w.waitFor(["sub/s.md"]);
      expect(w.delivered("sub/s.md")).toBe(1);
    } finally { w.stop(); }
  }, 10_000);

  test("a change the event stream reports by name is delivered once", async () => {
    const w = await watching({ "a.md": "one" });
    try {
      writeFileSync(join(w.dir, "a.md"), "two");
      await w.waitFor(["a.md"]);
      await Bun.sleep(SETTLE_MS);
      expect(w.calls).toEqual([join(w.dir, "a.md")]);
    } finally { w.stop(); }
  }, 10_000);

  test("files the watcher ignores, hidden files and untouched files are not delivered", async () => {
    const w = await watching({ "a.md": "untouched", "x.ts": "code" });
    try {
      writeFileSync(join(w.dir, "x.ts.tmp.4242.9f3c"), "code2");
      renameSync(join(w.dir, "x.ts.tmp.4242.9f3c"), join(w.dir, "x.ts"));
      writeFileSync(join(w.dir, ".draft.md.tmp.4242.9f3c"), "hidden");
      renameSync(join(w.dir, ".draft.md.tmp.4242.9f3c"), join(w.dir, ".draft.md"));
      await Bun.sleep(SETTLE_MS);
      expect(w.calls).toEqual([]);
    } finally { w.stop(); }
  }, 10_000);

  test("close() cancels a pending rescan", async () => {
    const w = await watching({ "a.md": "one" });
    writeFileSync(join(w.dir, "a.md.tmp.4242.9f3c"), "two");
    renameSync(join(w.dir, "a.md.tmp.4242.9f3c"), join(w.dir, "a.md"));
    await Bun.sleep(20);                                  // the event is in; its rescan is pending
    w.stop();
    await Bun.sleep(SETTLE_MS);
    expect(w.calls).toEqual([]);
  }, 10_000);
});

describe("listWatchedFiles — the startup listing a rescan compares against (v0.40.2)", () => {
  function fixture(files: Record<string, string>) {
    const dir = mkdtempSync(join(tmpdir(), "clawmem-watch-list-"));
    for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body);
    return dir;
  }

  test("lists only the files the watcher acts on", () => {
    const dir = fixture({ "a.md": "a", "x.ts": "code", ".hidden.md": "h" });
    mkdirSync(join(dir, "folder.md"));                    // a directory with a watched-looking name
    try {
      const listing = listWatchedFiles(dir, dir, null)!;
      expect([...listing.files.keys()]).toEqual(["a.md"]);
      expect(listing.changes).toEqual([]);                // nothing to compare with
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test("appeared, changed and disappeared files are listed as changes; untouched ones are not", () => {
    const dir = fixture({ "keep.md": "k", "edit.md": "e", "gone.md": "g" });
    try {
      const first = listWatchedFiles(dir, dir, null)!;
      writeFileSync(join(dir, "edit.md"), "edited, and longer");
      unlinkSync(join(dir, "gone.md"));
      writeFileSync(join(dir, "new.md"), "n");
      const next = listWatchedFiles(dir, dir, first.files)!;
      expect(next.changes.sort()).toEqual([["edit.md", "change"], ["gone.md", "rename"], ["new.md", "rename"]]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test("a directory that is gone lists as empty, so every file it held is a change", () => {
    const dir = fixture({ "a.md": "a" });
    const first = listWatchedFiles(dir, dir, null)!;
    rmSync(dir, { recursive: true, force: true });
    expect(listWatchedFiles(dir, dir, first.files)!.changes).toEqual([["a.md", "rename"]]);
  });
});

describe("overlapping collection paths share a directory's rescan (v0.40.2)", () => {
  test("an atomic save in a directory both paths watch is delivered once", async () => {
    const root = mkdtempSync(join(tmpdir(), "clawmem-watch-overlap-"));
    mkdirSync(join(root, "inner"));
    writeFileSync(join(root, "inner", "a.md"), "one");
    const calls: string[] = [];
    const log = console.log;
    console.log = () => {};
    let handle: { close: () => void };
    try {
      handle = startWatcher([root, join(root, "inner")], { debounceMs: 100, onChanged: async (p) => { calls.push(p); } });
    } finally {
      console.log = log;
    }
    try {
      await Bun.sleep(150);
      writeFileSync(join(root, "inner", "a.md.tmp.4242.9f3c"), "two");
      renameSync(join(root, "inner", "a.md.tmp.4242.9f3c"), join(root, "inner", "a.md"));
      for (let i = 0; i < 120 && calls.length === 0; i++) await Bun.sleep(25);
      await Bun.sleep(700);
      expect(calls).toEqual([join(root, "inner", "a.md")]);
    } finally {
      handle.close();
      rmSync(root, { recursive: true, force: true });
    }
  }, 10_000);

  test("an unnormalised collection path shares the directory it names", async () => {
    const root = mkdtempSync(join(tmpdir(), "clawmem-watch-overlap-"));
    mkdirSync(join(root, "inner"));
    writeFileSync(join(root, "inner", "a.md"), "one");
    const calls: string[] = [];
    const log = console.log;
    console.log = () => {};
    let handle: { close: () => void };
    try {
      handle = startWatcher([`${root}/./inner`, root], { debounceMs: 100, onChanged: async (p) => { calls.push(p); } });
    } finally {
      console.log = log;
    }
    try {
      await Bun.sleep(150);
      writeFileSync(join(root, "inner", "a.md.tmp.4242.9f3c"), "two");
      renameSync(join(root, "inner", "a.md.tmp.4242.9f3c"), join(root, "inner", "a.md"));
      for (let i = 0; i < 120 && calls.length === 0; i++) await Bun.sleep(25);
      await Bun.sleep(700);
      expect(calls).toEqual([join(root, "inner", "a.md")]);
    } finally {
      handle.close();
      rmSync(root, { recursive: true, force: true });
    }
  }, 10_000);
});

describe("startWatcher watches directories made after it starts (v0.40.3)", () => {
  const DEBOUNCE_MS = 100;
  const SETTLE_MS = 700;                                  // well past the rescan plus the per-file debounce

  type Setup = {
    files?: Record<string, string>;
    dirs?: string[];
    links?: Record<string, string>;                       // name → target, made before the start
    paths?: (root: string) => string[];
    cap?: string;
  };

  async function watching(setup: Setup = {}) {
    const root = mkdtempSync(join(tmpdir(), "clawmem-watch-newdir-"));
    for (const d of setup.dirs ?? []) mkdirSync(join(root, d), { recursive: true });
    for (const [name, body] of Object.entries(setup.files ?? {})) {
      mkdirSync(join(root, name, ".."), { recursive: true });
      writeFileSync(join(root, name), body);
    }
    for (const [name, target] of Object.entries(setup.links ?? {})) symlinkSync(target, join(root, name));
    const calls: string[] = [];
    const logs: string[] = [];
    const errors: string[] = [];
    const log = console.log;
    const prev = process.env.CLAWMEM_WATCH_MAX_DIRS;
    if (setup.cap !== undefined) process.env.CLAWMEM_WATCH_MAX_DIRS = setup.cap;
    console.log = (...args: unknown[]) => { logs.push(args.join(" ")); };   // restored by stop()
    let handle: { close: () => void };
    try {
      handle = startWatcher(setup.paths ? setup.paths(root) : [root], {
        debounceMs: DEBOUNCE_MS,
        onChanged: async (p) => { calls.push(p); },
        onError: (e) => { errors.push(e.message); },
      });
    } finally {
      if (setup.cap !== undefined) {
        if (prev === undefined) delete process.env.CLAWMEM_WATCH_MAX_DIRS;
        else process.env.CLAWMEM_WATCH_MAX_DIRS = prev;
      }
    }
    await Bun.sleep(150);                                 // let the watches settle before the first change
    const delivered = (name: string) => calls.filter((p) => p === join(root, name)).length;
    const waitFor = async (done: () => boolean) => {     // up to 120 × 25 ms, no clock read
      for (let i = 0; i < 120 && !done(); i++) await Bun.sleep(25);
    };
    const waitDelivered = (names: string[]) => waitFor(() => names.every((n) => delivered(n) > 0));
    const waitLogged = (text: string) => waitFor(() => logs.some((l) => l.includes(text)));
    const close = () => handle.close();
    const stop = () => { handle.close(); console.log = log; rmSync(root, { recursive: true, force: true }); };
    return { root, calls, logs, errors, delivered, waitFor, waitDelivered, waitLogged, close, stop };
  }

  test("a directory made after the start is watched: a file written in it later is delivered", async () => {
    const w = await watching();
    try {
      mkdirSync(join(w.root, "new"));
      await w.waitLogged(`new directory ${join(w.root, "new")}`);
      writeFileSync(join(w.root, "new", "a.md"), "a");
      await w.waitDelivered(["new/a.md"]);
      await Bun.sleep(SETTLE_MS);
      expect(w.delivered("new/a.md")).toBe(1);
    } finally { w.stop(); }
  }, 10_000);

  test("the files a new directory already holds are delivered, once each", async () => {
    const w = await watching();
    try {
      mkdirSync(join(w.root, "new"));
      writeFileSync(join(w.root, "new", "a.md"), "a");
      writeFileSync(join(w.root, "new", "b.md"), "b");
      writeFileSync(join(w.root, "new", "c.txt"), "not watched");
      await w.waitDelivered(["new/a.md", "new/b.md"]);
      await Bun.sleep(SETTLE_MS);
      expect(w.delivered("new/a.md")).toBe(1);
      expect(w.delivered("new/b.md")).toBe(1);
      expect(w.calls.filter((p) => p.endsWith(".txt"))).toEqual([]);
    } finally { w.stop(); }
  }, 10_000);

  test("a tree made in one go (mkdir -p) is watched to its depth", async () => {
    const w = await watching();
    try {
      mkdirSync(join(w.root, "x", "y", "z"), { recursive: true });
      writeFileSync(join(w.root, "x", "y", "z", "deep.md"), "deep");
      await w.waitDelivered(["x/y/z/deep.md"]);
      writeFileSync(join(w.root, "x", "y", "later.md"), "later");
      writeFileSync(join(w.root, "x", "y", "z", "deeper.md"), "deeper");
      await w.waitDelivered(["x/y/later.md", "x/y/z/deeper.md"]);
      await Bun.sleep(SETTLE_MS);
      expect(w.delivered("x/y/z/deep.md")).toBe(1);
      expect(w.delivered("x/y/later.md")).toBe(1);
      expect(w.delivered("x/y/z/deeper.md")).toBe(1);
    } finally { w.stop(); }
  }, 10_000);

  test("a new directory whose event is folded into a file's is still watched", async () => {
    const w = await watching();
    try {
      writeFileSync(join(w.root, "x.md"), "x");           // Bun < 1.4.0 names both events after this file
      mkdirSync(join(w.root, "new"));
      await w.waitLogged(`new directory ${join(w.root, "new")}`);
      writeFileSync(join(w.root, "new", "a.md"), "a");
      await w.waitDelivered(["x.md", "new/a.md"]);
      await Bun.sleep(SETTLE_MS);
      expect(w.delivered("x.md")).toBe(1);
      expect(w.delivered("new/a.md")).toBe(1);
    } finally { w.stop(); }
  }, 10_000);

  test("excluded and hidden directories made after the start stay unwatched", async () => {
    const w = await watching();
    try {
      mkdirSync(join(w.root, "node_modules", "pkg"), { recursive: true });
      mkdirSync(join(w.root, ".cache"));
      writeFileSync(join(w.root, "node_modules", "pkg", "a.md"), "a");
      writeFileSync(join(w.root, ".cache", "b.md"), "b");
      mkdirSync(join(w.root, "kept"));
      await w.waitLogged(`new directory ${join(w.root, "kept")}`);
      writeFileSync(join(w.root, "node_modules", "pkg", "c.md"), "c");
      writeFileSync(join(w.root, ".cache", "d.md"), "d");
      await Bun.sleep(SETTLE_MS);
      expect(w.calls).toEqual([]);
      expect(w.logs.filter((l) => l.includes("new directory"))).toEqual([`[watcher] new directory ${join(w.root, "kept")}: watching 1 dir`]);
    } finally { w.stop(); }
  }, 10_000);

  test("a symlink to a directory made after the start is not taken on: the index pass does not follow it", async () => {
    const outside = mkdtempSync(join(tmpdir(), "clawmem-watch-newdir-out-"));
    const w = await watching();
    try {
      symlinkSync(outside, join(w.root, "link"));
      mkdirSync(join(w.root, "kept"));                    // taken on by the same rescan
      await w.waitLogged(`new directory ${join(w.root, "kept")}`);
      writeFileSync(join(outside, "a.md"), "a");
      await Bun.sleep(SETTLE_MS);
      expect(w.calls).toEqual([]);
      expect(w.logs.some((l) => l.includes(`new directory ${join(w.root, "link")}`))).toBe(false);
    } finally {
      w.stop();
      rmSync(outside, { recursive: true, force: true });
    }
  }, 10_000);

  test("a symlinked directory the startup walk watched keeps its watch through its parent's rescans", async () => {
    const outside = mkdtempSync(join(tmpdir(), "clawmem-watch-newdir-out-"));
    const w = await watching({ links: { link: outside } });   // there at the start: the walk follows it
    try {
      writeFileSync(join(w.root, "x.md"), "x");           // a rescan of the root, which reads `link`
      await w.waitDelivered(["x.md"]);
      await Bun.sleep(SETTLE_MS);
      writeFileSync(join(outside, "a.md"), "a");
      await w.waitDelivered(["link/a.md"]);
      expect(w.delivered("link/a.md")).toBe(1);
    } finally {
      w.stop();
      rmSync(outside, { recursive: true, force: true });
    }
  }, 10_000);

  test("a directory made inside a symlinked directory the startup walk watched is not taken on", async () => {
    const outside = mkdtempSync(join(tmpdir(), "clawmem-watch-newdir-out-"));
    const w = await watching({ links: { link: outside } });   // watched through the link since the start
    try {
      mkdirSync(join(outside, "sub"));                    // a real directory, reached here only through `link`
      writeFileSync(join(outside, "sub", "a.md"), "a");
      mkdirSync(join(w.root, "kept"));                    // a rescan of the root, to know rescans have run
      await w.waitLogged(`new directory ${join(w.root, "kept")}`);
      await Bun.sleep(SETTLE_MS);
      writeFileSync(join(outside, "sub", "b.md"), "b");
      await Bun.sleep(SETTLE_MS);
      expect(w.calls.filter((p) => p.startsWith(join(w.root, "link", "sub")))).toEqual([]);
      expect(w.logs.some((l) => l.includes(join(w.root, "link", "sub")))).toBe(false);
    } finally {
      w.stop();
      rmSync(outside, { recursive: true, force: true });
    }
  }, 10_000);

  test("a symlinked directory the startup walk watched, replaced by a real directory, is watched as one", async () => {
    const outside = mkdtempSync(join(tmpdir(), "clawmem-watch-newdir-out-"));
    const w = await watching({ links: { link: outside } });
    try {
      unlinkSync(join(w.root, "link"));
      mkdirSync(join(w.root, "link"));                    // a real directory at the symlink's path
      writeFileSync(join(w.root, "link", "a.md"), "a");
      await w.waitDelivered(["link/a.md"]);
      await w.waitLogged(`replaced directory ${join(w.root, "link")}`);
      writeFileSync(join(w.root, "link", "b.md"), "b");
      writeFileSync(join(outside, "c.md"), "c");          // the old target: no longer watched through `link`
      await w.waitDelivered(["link/b.md"]);
      await Bun.sleep(SETTLE_MS);
      expect(w.delivered("link/a.md")).toBe(1);
      expect(w.delivered("link/b.md")).toBe(1);
      expect(w.delivered("link/c.md")).toBe(0);
    } finally {
      w.stop();
      rmSync(outside, { recursive: true, force: true });
    }
  }, 10_000);

  test("a collection path made after the start as a symlink is watched, through a parent another path watches", async () => {
    const outside = mkdtempSync(join(tmpdir(), "clawmem-watch-newdir-out-"));
    const w = await watching({ paths: (root) => [root, join(root, "coll")] });   // `coll` does not exist yet
    try {
      symlinkSync(outside, join(w.root, "coll"));
      await w.waitLogged(`new directory ${join(w.root, "coll")}`);
      writeFileSync(join(outside, "a.md"), "a");
      await w.waitDelivered(["coll/a.md"]);
      await Bun.sleep(SETTLE_MS);
      expect(w.delivered("coll/a.md")).toBe(1);
    } finally {
      w.stop();
      rmSync(outside, { recursive: true, force: true });
    }
  }, 10_000);

  test("a collection path nested in a new tree is taken on for its own collection when the outer one is at its cap", async () => {
    // The root and d0: the outer path watches 2 of 3. `new/inner` is a collection path of its own, not there yet.
    const w = await watching({ dirs: ["d0"], cap: "3", paths: (root) => [root, join(root, "new", "inner")] });
    try {
      mkdirSync(join(w.root, "new", "inner", "deep"), { recursive: true });
      writeFileSync(join(w.root, "new", "inner", "a.md"), "a");
      writeFileSync(join(w.root, "new", "inner", "deep", "b.md"), "b");
      await w.waitDelivered(["new/inner/a.md", "new/inner/deep/b.md"]);
      writeFileSync(join(w.root, "new", "inner", "deep", "c.md"), "c");
      await w.waitDelivered(["new/inner/deep/c.md"]);
      await Bun.sleep(SETTLE_MS);
      expect(w.delivered("new/inner/a.md")).toBe(1);
      expect(w.delivered("new/inner/deep/b.md")).toBe(1);
      expect(w.delivered("new/inner/deep/c.md")).toBe(1);
    } finally { w.stop(); }
  }, 10_000);

  test("a symlinked collection path nested in a new tree is taken on for its own collection", async () => {
    const outside = mkdtempSync(join(tmpdir(), "clawmem-watch-newdir-out-"));
    const w = await watching({ paths: (root) => [root, join(root, "new", "coll")] });
    try {
      mkdirSync(join(w.root, "new"));
      symlinkSync(outside, join(w.root, "new", "coll"));
      await w.waitLogged(`new directory ${join(w.root, "new")}`);
      writeFileSync(join(outside, "a.md"), "a");
      await w.waitDelivered(["new/coll/a.md"]);
      await Bun.sleep(SETTLE_MS);
      expect(w.delivered("new/coll/a.md")).toBe(1);
    } finally {
      w.stop();
      rmSync(outside, { recursive: true, force: true });
    }
  }, 10_000);

  test("a replaced directory re-watches a collection path under it, even one over the cap at the start", async () => {
    // Cap 2: the outer path walks root, sub, sub/inner, d1, d2 and watches root + sub; the inner collection path
    // walks inner, d1, d2 (over the cap, so it adopts nothing new) and watches inner + d1.
    const w = await watching({ dirs: ["sub/inner/d1", "sub/inner/d2"], cap: "2", paths: (root) => [root, join(root, "sub", "inner")] });
    try {
      rmSync(join(w.root, "sub"), { recursive: true });
      mkdirSync(join(w.root, "sub", "inner"), { recursive: true });
      writeFileSync(join(w.root, "sub", "inner", "a.md"), "a");
      await w.waitDelivered(["sub/inner/a.md"]);
      writeFileSync(join(w.root, "sub", "inner", "b.md"), "b");
      await w.waitDelivered(["sub/inner/b.md"]);
      await Bun.sleep(SETTLE_MS);
      expect(w.delivered("sub/inner/a.md")).toBe(1);
      expect(w.delivered("sub/inner/b.md")).toBe(1);
    } finally { w.stop(); }
  }, 10_000);

  test("a replaced directory never lets a path over the cap at the start watch what its startup walk left out", async () => {
    // Cap 2: the inner collection path walks inner, a, b (over the cap) and watches inner and one of a, b.
    const w = await watching({ dirs: ["sub/inner/a", "sub/inner/b"], cap: "2", paths: (root) => [root, join(root, "sub", "inner")] });
    try {
      writeFileSync(join(w.root, "sub", "inner", "a", "probe.md"), "a");
      writeFileSync(join(w.root, "sub", "inner", "b", "probe.md"), "b");
      await w.waitFor(() => w.delivered("sub/inner/a/probe.md") + w.delivered("sub/inner/b/probe.md") > 0);
      await Bun.sleep(SETTLE_MS);
      const skipped = w.delivered("sub/inner/a/probe.md") > 0 ? "b" : "a";   // the one the startup cap left out
      expect(w.delivered(`sub/inner/${skipped}/probe.md`)).toBe(0);
      rmSync(join(w.root, "sub"), { recursive: true });
      mkdirSync(join(w.root, "sub", "inner", skipped), { recursive: true });  // the new tree holds only that one
      writeFileSync(join(w.root, "sub", "inner", "x.md"), "x");
      await w.waitDelivered(["sub/inner/x.md"]);           // inner is watched again, for its own collection
      writeFileSync(join(w.root, "sub", "inner", skipped, "later.md"), "later");
      await Bun.sleep(SETTLE_MS);
      expect(w.delivered("sub/inner/x.md")).toBe(1);
      expect(w.delivered(`sub/inner/${skipped}/later.md`)).toBe(0);
    } finally { w.stop(); }
  }, 15_000);

  test("a new directory that cannot be watched yet is reported once, and watched once it can be", async () => {
    const w = await watching();
    try {
      mkdirSync(join(w.root, "locked"));
      chmodSync(join(w.root, "locked"), 0o000);
      await w.waitFor(() => w.errors.length > 0);
      writeFileSync(join(w.root, "x.md"), "x");           // another rescan of the root: not reported again
      await w.waitDelivered(["x.md"]);
      await Bun.sleep(SETTLE_MS);
      expect(w.errors.length).toBe(1);
      expect(w.errors[0]).toContain(join(w.root, "locked"));
      chmodSync(join(w.root, "locked"), 0o755);
      writeFileSync(join(w.root, "y.md"), "y");           // the next rescan watches it
      await w.waitLogged(`new directory ${join(w.root, "locked")}`);
      writeFileSync(join(w.root, "locked", "a.md"), "a");
      await w.waitDelivered(["locked/a.md"]);
      expect(w.delivered("locked/a.md")).toBe(1);
      expect(w.errors.length).toBe(1);
    } finally {
      try { chmodSync(join(w.root, "locked"), 0o755); } catch { /* already */ }
      w.stop();
    }
  }, 15_000);

  test("a new directory holding more files than one batch delivers each once", async () => {
    const w = await watching();
    try {
      mkdirSync(join(w.root, "big"));
      const names = Array.from({ length: 300 }, (_, i) => `n${String(i).padStart(3, "0")}.md`);
      for (const n of names) writeFileSync(join(w.root, "big", n), n);
      await w.waitDelivered(names.map((n) => `big/${n}`));
      await Bun.sleep(SETTLE_MS);
      expect(names.filter((n) => w.delivered(`big/${n}`) !== 1)).toEqual([]);
    } finally { w.stop(); }
  }, 15_000);

  test("a watched directory deleted and made again (the same inode, on ext4) is watched again", async () => {
    const w = await watching({ files: { "sub/a.md": "a" } });
    try {
      rmSync(join(w.root, "sub"), { recursive: true });
      mkdirSync(join(w.root, "sub"));
      await w.waitDelivered(["sub/a.md"]);                // its removal
      await w.waitLogged(`replaced directory ${join(w.root, "sub")}`);
      writeFileSync(join(w.root, "sub", "b.md"), "b");
      await w.waitDelivered(["sub/b.md"]);
      await Bun.sleep(SETTLE_MS);
      expect(w.delivered("sub/a.md")).toBe(1);
      expect(w.delivered("sub/b.md")).toBe(1);
    } finally { w.stop(); }
  }, 10_000);

  test("a directory another one is renamed over is watched anew, with the files it brought", async () => {
    const outside = mkdtempSync(join(tmpdir(), "clawmem-watch-newdir-out-"));
    const w = await watching({ dirs: ["sub"] });
    try {
      mkdirSync(join(outside, "staging"));
      writeFileSync(join(outside, "staging", "b.md"), "b");
      renameSync(join(outside, "staging"), join(w.root, "sub"));   // replaces the empty `sub`
      await w.waitDelivered(["sub/b.md"]);
      await w.waitLogged(`replaced directory ${join(w.root, "sub")}`);
      writeFileSync(join(w.root, "sub", "c.md"), "c");
      await w.waitDelivered(["sub/c.md"]);
      await Bun.sleep(SETTLE_MS);
      expect(w.delivered("sub/b.md")).toBe(1);
      expect(w.delivered("sub/c.md")).toBe(1);
    } finally {
      w.stop();
      rmSync(outside, { recursive: true, force: true });
    }
  }, 10_000);

  test("a watched directory removed with its files delivers each file once", async () => {
    const w = await watching({ files: { "sub/a.md": "a", "sub/b.md": "b", "sub/deeper/c.md": "c" } });
    try {
      rmSync(join(w.root, "sub"), { recursive: true });
      await w.waitDelivered(["sub/a.md", "sub/b.md", "sub/deeper/c.md"]);
      await Bun.sleep(SETTLE_MS);
      expect(w.delivered("sub/a.md")).toBe(1);
      expect(w.delivered("sub/b.md")).toBe(1);
      expect(w.delivered("sub/deeper/c.md")).toBe(1);
      mkdirSync(join(w.root, "sub"));                     // and the path, made again, is a new directory
      await w.waitLogged(`new directory ${join(w.root, "sub")}`);
      writeFileSync(join(w.root, "sub", "d.md"), "d");
      await w.waitDelivered(["sub/d.md"]);
      expect(w.delivered("sub/d.md")).toBe(1);
    } finally { w.stop(); }
  }, 15_000);

  test("new directories count against the cap: past it they stay unwatched, with one warning", async () => {
    const w = await watching({ dirs: ["d0"], cap: "3" }); // the root and d0: 2 of 3
    try {
      mkdirSync(join(w.root, "n1"));
      await w.waitLogged(`new directory ${join(w.root, "n1")}`);
      mkdirSync(join(w.root, "n2"));
      await w.waitLogged("is at its cap of 3 watched dirs");
      mkdirSync(join(w.root, "n3"));
      await Bun.sleep(SETTLE_MS);
      writeFileSync(join(w.root, "n1", "a.md"), "a");
      writeFileSync(join(w.root, "n2", "b.md"), "b");
      writeFileSync(join(w.root, "n3", "c.md"), "c");
      await w.waitDelivered(["n1/a.md"]);
      await Bun.sleep(SETTLE_MS);
      expect(w.delivered("n1/a.md")).toBe(1);
      expect(w.delivered("n2/b.md")).toBe(0);
      expect(w.delivered("n3/c.md")).toBe(0);
      const warnings = w.logs.filter((l) => l.includes("is at its cap"));
      expect(warnings.length).toBe(1);
      expect(warnings[0]).toContain(join(w.root, "n2"));
      expect(warnings[0]).toContain("CLAWMEM_WATCH_MAX_DIRS");
    } finally { w.stop(); }
  }, 15_000);

  test("a collection path over the cap at the start watches no new directory", async () => {
    const w = await watching({ dirs: ["d0", "d1"], cap: "2" });   // the root and two dirs: 3 > 2
    try {
      mkdirSync(join(w.root, "n1"));
      writeFileSync(join(w.root, "n1", "a.md"), "a");
      await Bun.sleep(SETTLE_MS);
      writeFileSync(join(w.root, "n1", "b.md"), "b");
      await Bun.sleep(SETTLE_MS);
      expect(w.calls).toEqual([]);
      expect(w.logs.some((l) => l.includes("new directory"))).toBe(false);
    } finally { w.stop(); }
  }, 10_000);

  test("a new directory under overlapping collection paths is watched once", async () => {
    const w = await watching({ dirs: ["inner"], paths: (root) => [root, join(root, "inner")] });
    try {
      mkdirSync(join(w.root, "inner", "new"));
      await w.waitLogged(`new directory ${join(w.root, "inner", "new")}`);
      writeFileSync(join(w.root, "inner", "new", "a.md"), "a");
      await w.waitDelivered(["inner/new/a.md"]);
      await Bun.sleep(SETTLE_MS);
      expect(w.delivered("inner/new/a.md")).toBe(1);
      expect(w.logs.filter((l) => l.includes("new directory")).length).toBe(1);
    } finally { w.stop(); }
  }, 10_000);

  test("close() stops the watches on the directories it took on", async () => {
    const w = await watching();
    try {
      mkdirSync(join(w.root, "new"));
      await w.waitLogged(`new directory ${join(w.root, "new")}`);
      w.close();
      writeFileSync(join(w.root, "new", "a.md"), "a");
      mkdirSync(join(w.root, "later"));
      await Bun.sleep(SETTLE_MS);
      expect(w.calls).toEqual([]);
      expect(w.logs.some((l) => l.includes(`new directory ${join(w.root, "later")}`))).toBe(false);
    } finally { w.stop(); }
  }, 10_000);
});
