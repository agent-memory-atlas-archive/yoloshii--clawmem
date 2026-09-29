/**
 * v0.40.1 — cmdWatch's routing and pre-check, through the real watcher.
 *
 * The unit tests pin `watchTargets` and `matchesCollectionPattern`; this test pins that `clawmem watch` itself
 * acts on them. It spawns `bun src/clawmem.ts watch` against a temp vault and a temp config with three
 * collection shapes the v0.40.0 watcher dropped every event for, writes one file into each, and checks both
 * the watcher's `[event] collection/path` log line and the indexed row:
 *
 *   mem     `*\/memory/**\/*.md`      — a wildcard directory (the Claude Code auto-memory shape)
 *   picked  `{README,guide}.md`       — a brace list followed by a suffix
 *   outer   `**\/*.md` around `inner` (`notes.md`) — a file the inner pattern rejects belongs to the outer one
 *
 * `picked` is configured with an unnormalised path (`<root>/./picked`): v0.40.0 gated every event on a raw
 * string prefix of the configured path, which a normalised event path never has.
 *
 * Against the v0.40.0 `cmdWatch` all three files stay unindexed.
 */
import { describe, it, expect, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";

const REPO_ROOT = join(import.meta.dir, "..", "..");
const CLAWMEM_ENTRY = join(REPO_ROOT, "src", "clawmem.ts");
const BUN_BIN = process.execPath;
const escapeRegExp = (s: string) => s.replace(/[.*+?^$()|[\]\\/{}]/g, "\\$&");

// Same isolation as cmdwatch-workers: no inherited CLAWMEM_* / INDEX_PATH, cwd outside the repo (Bun loads .env).
function cleanInheritedEnv(): Record<string, string> {
  const cleaned: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined || k.startsWith("CLAWMEM_") || k === "INDEX_PATH") continue;
    cleaned[k] = v;
  }
  return cleaned;
}

let tmpRoot: string | null = null;
afterEach(() => {
  if (tmpRoot) {
    try { rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* swallow */ }
    tmpRoot = null;
  }
});

describe("cmdWatch re-indexes the collections an event belongs to (v0.40.1)", () => {
  it("indexes wildcard-directory, brace-suffix and overlapping-outer collections on change", async () => {
    tmpRoot = mkdtempSync(join(tmpdir(), "clawmem-watch-precheck-"));
    const configDir = join(tmpRoot, "config");
    const vaultPath = join(tmpRoot, "index.sqlite");
    for (const d of [configDir, join(tmpRoot, "projects", "p1", "memory"), join(tmpRoot, "picked"), join(tmpRoot, "outer", "inner")]) {
      mkdirSync(d, { recursive: true });
    }
    writeFileSync(join(configDir, "config.yaml"), [
      "collections:",
      "  mem:",
      `    path: ${join(tmpRoot, "projects")}`,
      "    pattern: '*/memory/**/*.md'",
      "  picked:",
      `    path: ${tmpRoot}/./picked`,
      "    pattern: '{README,guide}.md'",
      "  outer:",
      `    path: ${join(tmpRoot, "outer")}`,
      "    pattern: '**/*.md'",
      "  inner:",
      `    path: ${join(tmpRoot, "outer", "inner")}`,
      "    pattern: 'notes.md'",
      "",
    ].join("\n"));

    const proc = Bun.spawn([BUN_BIN, CLAWMEM_ENTRY, "watch"], {
      cwd: tmpRoot,
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...cleanInheritedEnv(),
        INDEX_PATH: vaultPath,
        CLAWMEM_CONFIG_DIR: configDir,
        CLAWMEM_NO_LOCAL_MODELS: "true",
        CLAWMEM_EMBED_URL: "http://127.0.0.1:1",
        CLAWMEM_LLM_URL: "http://127.0.0.1:1",
        CLAWMEM_RERANK_URL: "http://127.0.0.1:1",
        NO_COLOR: "1",
      },
    });
    let stdout = "";
    const drain = (async () => {
      const decoder = new TextDecoder();
      for await (const chunk of proc.stdout) stdout += decoder.decode(chunk, { stream: true });
    })();
    const stderrDrain = new Response(proc.stderr).text();
    const waitFor = async (pred: () => boolean, ms: number) => {
      const start = Date.now();
      while (!pred() && Date.now() - start < ms) await Bun.sleep(50);
      return pred();
    };

    try {
      // All four collection paths are watched once each prints its [watcher] line.
      expect(await waitFor(() => (stdout.match(/\[watcher\] /g) ?? []).length >= 4, 15000)).toBe(true);

      writeFileSync(join(tmpRoot, "projects", "p1", "memory", "note.md"), "# Note\n\nremember this\n");
      writeFileSync(join(tmpRoot, "picked", "guide.md"), "# Guide\n\nhow to\n");
      writeFileSync(join(tmpRoot, "outer", "inner", "other.md"), "# Other\n\nnot notes.md\n");

      // "[rename] mem/p1/memory/note.md" — colour codes stripped, the collection name right after the event
      const logged = (p: string) => new RegExp(`\\] ${escapeRegExp(p)}\\b`).test(stdout.replace(/\x1b\[[0-9;]*m/g, ""));
      const all = ["mem/p1/memory/note.md", "picked/guide.md", "outer/inner/other.md"];
      await waitFor(() => all.every(logged), 20000);
      for (const p of all) expect(logged(p)).toBe(true);
      expect(logged("inner/other.md")).toBe(false);          // the inner pattern rejects it
    } finally {
      proc.kill("SIGTERM");
      const exited = await Promise.race([proc.exited, Bun.sleep(5000).then(() => null)]);
      if (exited === null) { try { proc.kill("SIGKILL"); } catch { /* already gone */ } }
      await drain;
      await stderrDrain;
    }

    const db = new Database(vaultPath, { readonly: true });
    try {
      const rows = db.query("SELECT collection, path FROM documents WHERE active = 1 ORDER BY collection, path").all() as
        { collection: string; path: string }[];
      expect(rows.map((r) => `${r.collection}:${r.path}`)).toEqual([
        "mem:p1/memory/note.md",
        "outer:inner/other.md",
        "picked:guide.md",
      ]);
    } finally {
      db.close();
    }
  }, 60000);
});
