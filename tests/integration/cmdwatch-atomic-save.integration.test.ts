/**
 * v0.40.2 — atomic saves and back-to-back writes reach the index, through the real watcher.
 *
 * Bun before 1.4.0 folds the events that reach one watched directory together into one callback per event type,
 * named after the first file. An atomic save (write a temp file beside the target, rename it over the target —
 * how many editors and agent tools save) arrived under the temp file's name, and the second of two files written
 * back-to-back did not arrive at all, so `clawmem watch` never re-indexed them. The watcher now rescans a
 * directory after any event. This test spawns `bun src/clawmem.ts watch` against a temp vault and a temp config
 * with the Claude Code auto-memory shape (`*\/memory/**\/*.md`) and checks the indexed rows after:
 *
 *   1. an atomic save that creates `note.md`
 *   2. an atomic save that replaces it
 *   3. two existing files rewritten back-to-back
 *
 * Against the v0.40.1 watcher under Bun 1.3.14, step 1 never indexes `note.md`.
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

describe("cmdWatch re-indexes atomic saves and back-to-back writes (v0.40.2)", () => {
  it("indexes a file created and replaced by atomic saves, and both of two files written together", async () => {
    tmpRoot = mkdtempSync(join(tmpdir(), "clawmem-watch-atomic-"));
    const configDir = join(tmpRoot, "config");
    const vaultPath = join(tmpRoot, "index.sqlite");
    const memory = join(tmpRoot, "projects", "p1", "memory");
    for (const d of [configDir, memory]) mkdirSync(d, { recursive: true });
    writeFileSync(join(configDir, "config.yaml"), [
      "collections:",
      "  mem:",
      `    path: ${join(tmpRoot, "projects")}`,
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
    const atomicSave = (name: string, body: string) => {
      const temp = join(memory, `${name}.tmp.4242.9f3c`);
      writeFileSync(temp, body);
      renameSync(temp, join(memory, name));
    };

    try {
      expect(await waitFor(() => /\[watcher\] /.test(stdout), 15000)).toBe(true);

      atomicSave("note.md", "# Note v1\n\nfirst\n");
      expect(await waitFor(() => titles()["p1/memory/note.md"] === "Note v1", 20000)).toBe(true);

      atomicSave("note.md", "# Note v2\n\nsecond\n");
      expect(await waitFor(() => titles()["p1/memory/note.md"] === "Note v2", 20000)).toBe(true);

      writeFileSync(join(memory, "a.md"), "# A v1\n");
      writeFileSync(join(memory, "b.md"), "# B v1\n");
      expect(await waitFor(() => titles()["p1/memory/a.md"] === "A v1" && titles()["p1/memory/b.md"] === "B v1", 20000))
        .toBe(true);
      writeFileSync(join(memory, "a.md"), "# A v2\n");
      writeFileSync(join(memory, "b.md"), "# B v2\n");
      expect(await waitFor(() => titles()["p1/memory/a.md"] === "A v2" && titles()["p1/memory/b.md"] === "B v2", 20000))
        .toBe(true);
    } finally {
      proc.kill("SIGTERM");
      const exited = await Promise.race([proc.exited, Bun.sleep(5000).then(() => null)]);
      if (exited === null) { try { proc.kill("SIGKILL"); } catch { /* already gone */ } }
      await drain;
      await stderrDrain;
    }

    expect(titles()).toEqual({ "p1/memory/a.md": "A v2", "p1/memory/b.md": "B v2", "p1/memory/note.md": "Note v2" });
  }, 120000);
});
