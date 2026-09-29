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
 */
import { describe, test, expect } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { matchesCollectionPattern, watchTargets } from "../../src/indexer.ts";
import { DEFAULT_MAX_WATCH_DIRS, resolveMaxWatchDirs, startWatcher } from "../../src/watcher.ts";

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
