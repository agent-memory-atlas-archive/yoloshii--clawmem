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
 */
import { describe, test, expect } from "bun:test";
import { mkdirSync, mkdtempSync, renameSync, rmSync, unlinkSync, writeFileSync } from "fs";
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
