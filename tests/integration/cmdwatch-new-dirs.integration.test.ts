/**
 * v0.40.3 — files in directories made after the watcher starts reach the index, through the real watcher.
 *
 * The watcher walked each collection path once, at start, so a directory made later went unwatched until a restart:
 * on a Claude Code host a new project (and later its `memory/` directory) appears several times a day, and its
 * memory files reached the vault only on a full index pass. A rescan now watches a new subdirectory. This test spawns
 * `bun src/clawmem.ts watch` against a temp vault and a temp config with the Claude Code auto-memory shape
 * (`*\/memory/**\/*.md`) and checks the indexed rows after:
 *
 *   1. a project and its memory directory made in one go, with a file in it
 *   2. a file written later in that new memory directory
 *   3. a project made first and its memory directory later (Claude Code's order), then an atomic save in it
 *
 * Against the v0.40.2 watcher, step 1 never indexes the file.
 */
import { describe, it, expect, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";

const REPO_ROOT = join(import.meta.dir, "..", "..");
const CLAWMEM_ENTRY = join(REPO_ROOT, "src", "clawmem.ts");
const BUN_BIN = process.execPath;

// Same isolation as cmdwatch-precheck: no inherited CLAWMEM_* / INDEX_PATH, cwd outside the repo (Bun loads .env).
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

describe("cmdWatch indexes files in directories made after it starts (v0.40.3)", () => {
  it("indexes a new project's memory, made in one go or a directory at a time", async () => {
    tmpRoot = mkdtempSync(join(tmpdir(), "clawmem-watch-newdirs-"));
    const configDir = join(tmpRoot, "config");
    const vaultPath = join(tmpRoot, "index.sqlite");
    const projects = join(tmpRoot, "projects");
    for (const d of [configDir, join(projects, "p1", "memory")]) mkdirSync(d, { recursive: true });
    writeFileSync(join(configDir, "config.yaml"), [
      "collections:",
      "  mem:",
      `    path: ${projects}`,
      "    pattern: '*/memory/**/*.md'",
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
    const waitFor = async (pred: () => boolean, ms: number) => {   // polls every 100 ms, no clock read
      for (let waited = 0; !pred() && waited < ms; waited += 100) await Bun.sleep(100);
      return pred();
    };
    // The indexed title of each active document under mem, read through a fresh read-only connection.
    const titles = (): Record<string, string> => {
      let db: Database | null = null;
      try {
        db = new Database(vaultPath, { readonly: true });
        const rows = db.query("SELECT path, title FROM documents WHERE collection = 'mem' AND active = 1").all() as
          { path: string; title: string }[];
        return Object.fromEntries(rows.map((r) => [r.path, r.title]));
      } catch {
        return {};                                          // the vault is not created yet
      } finally {
        db?.close();
      }
    };

    try {
      expect(await waitFor(() => /\[watcher\] /.test(stdout), 15000)).toBe(true);

      // 1. a project and its memory directory in one go, with a file in it
      mkdirSync(join(projects, "p2", "memory"), { recursive: true });
      writeFileSync(join(projects, "p2", "memory", "MEMORY.md"), "# P2 index\n");
      expect(await waitFor(() => titles()["p2/memory/MEMORY.md"] === "P2 index", 20000)).toBe(true);

      // 2. a file written later in the new memory directory
      writeFileSync(join(projects, "p2", "memory", "later.md"), "# Later\n");
      expect(await waitFor(() => titles()["p2/memory/later.md"] === "Later", 20000)).toBe(true);

      // 3. the project first, its memory directory later, then an atomic save there
      mkdirSync(join(projects, "p3"));
      expect(await waitFor(() => stdout.includes(`new directory ${join(projects, "p3")}`), 20000)).toBe(true);
      mkdirSync(join(projects, "p3", "memory"));
      expect(await waitFor(() => stdout.includes(`new directory ${join(projects, "p3", "memory")}`), 20000)).toBe(true);
      writeFileSync(join(projects, "p3", "memory", "note.md.tmp.4242.9f3c"), "# P3 note\n");
      renameSync(join(projects, "p3", "memory", "note.md.tmp.4242.9f3c"), join(projects, "p3", "memory", "note.md"));
      expect(await waitFor(() => titles()["p3/memory/note.md"] === "P3 note", 20000)).toBe(true);
    } finally {
      proc.kill("SIGTERM");
      const exited = await Promise.race([proc.exited, Bun.sleep(5000).then(() => null)]);
      if (exited === null) { try { proc.kill("SIGKILL"); } catch { /* already gone */ } }
      await drain;
      await stderrDrain;
    }

    expect(titles()).toEqual({ "p2/memory/MEMORY.md": "P2 index", "p2/memory/later.md": "Later", "p3/memory/note.md": "P3 note" });
  }, 120000);
});
