/**
 * 62.2 (codex T5 #1, CR-3) — the compaction hooks through the REAL `clawmem hook` dispatcher, as the
 * host runs them: one process per hook, on a shared file vault. A PreCompact that meets a busy vault
 * has already registered its attempt outside it, so the SessionStart(compact) that follows never
 * replays the session's previous snapshot. Inference endpoints point at a dead port.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { join, resolve } from "path";
import { tmpdir } from "os";
import { Database } from "bun:sqlite";
import { assistant, human, writeTranscript } from "./compaction-fixtures.ts";

const ROOT = join(import.meta.dir, "../..");
let home: string;
let vault: string;
let projectDir: string;
let deadPort: number;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "clawmem-622-cli-"));
  vault = resolve(home, "vault.sqlite");
  projectDir = join(home, ".claude", "projects", "-work-proj");
  const t = Bun.serve({ port: 0, fetch: () => new Response("x") });
  deadPort = t.port!;
  t.stop(true);
});

afterEach(() => rmSync(home, { recursive: true, force: true }));

async function hook(name: string, input: Record<string, unknown>): Promise<{ context: string; ms: number; code: number; out: string; err: string }> {
  const t0 = performance.now();
  const proc = Bun.spawn([process.execPath, "src/clawmem.ts", "hook", name], {
    cwd: ROOT,
    env: {
      ...process.env,
      HOME: home,
      CLAWMEM_CONFIG_DIR: join(home, ".config", "clawmem"),
      INDEX_PATH: vault,
      CLAWMEM_EMBED_URL: `http://127.0.0.1:${deadPort}`,
      CLAWMEM_LLM_URL: `http://127.0.0.1:${deadPort}`,
      CLAWMEM_RERANK_URL: `http://127.0.0.1:${deadPort}`,
      CLAWMEM_NO_LOCAL_MODELS: "true",
    },
    stdin: new Blob([JSON.stringify(input)]),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  const code = await proc.exited;
  let context = "";
  try { context = JSON.parse(out.trim().split("\n").pop() || "{}").hookSpecificOutput?.additionalContext ?? ""; } catch { /* empty output */ }
  return { context, ms: performance.now() - t0, code, out, err };
}

const transcript = (sessionId: string, canary: string) => writeTranscript(projectDir, sessionId, [
  human(`${canary} refactor the parser module please`),
  assistant(`We decided to split the tokenizer out of the parser module — ${canary}`),
]);
const preCompact = (sessionId: string, path: string) =>
  hook("precompact-extract", { session_id: sessionId, transcript_path: path, hook_event_name: "PreCompact", trigger: "auto" });
const compactStart = (sessionId: string, path: string) =>
  hook("postcompact-inject", { session_id: sessionId, transcript_path: path, hook_event_name: "SessionStart", source: "compact" });

describe("62.2 — the compaction hooks through the real dispatcher", () => {
  it("positive control: a compaction's SessionStart receives its own PreCompact's state, once", async () => {
    const t = transcript("sess-cli", "CANARY-OWN");
    await preCompact("sess-cli", t);
    expect((await compactStart("sess-cli", t)).context).toContain("CANARY-OWN");
    expect((await compactStart("sess-cli", t)).context).not.toContain("CANARY-OWN");
  }, 60_000);

  it("codex T5 #1: a PreCompact that meets a busy vault leaves the previous snapshot untakeable", async () => {
    // A compaction that never reached its SessionStart (cancelled) leaves a stored state behind.
    await preCompact("sess-busy", transcript("sess-busy", "CANARY-PREVIOUS"));

    // The next compaction's PreCompact runs while another process holds the vault's write lock.
    const t = transcript("sess-busy", "CANARY-CURRENT");
    const holder = new Database(vault);
    holder.exec("BEGIN IMMEDIATE");
    try {
      await preCompact("sess-busy", t);
    } finally {
      holder.exec("ROLLBACK");
      holder.close();
    }

    const out = (await compactStart("sess-busy", t)).context;
    expect(out).not.toContain("CANARY-PREVIOUS");
    expect(out).not.toContain("CANARY-CURRENT"); // it could not be stored, so nothing is injected
    const reg = new Database(`${vault}-compaction.sqlite`, { readonly: true });
    try {
      expect(reg.prepare("SELECT COUNT(*) AS c FROM registration WHERE consumed = 0").get()).toEqual({ c: 0 }); // the take consumed the registration
    } finally {
      reg.close();
    }
  }, 60_000);

  it("codex T12 #1: a first upgraded open that fails closed (an older writer holds the lock) fails the hook open", async () => {
    const { createStore } = await import("../../src/store.ts");
    const { EVOLUTION_WRITER_FLOOR_FLAG } = await import("../../src/compaction-state.ts");
    const old = createStore(vault);                          // a vault as v0.39.1 left it: no writer column, no floor
    old.db.exec("ALTER TABLE memory_evolution DROP COLUMN writer");
    old.db.prepare("DELETE FROM vault_flags WHERE flag = ?").run(EVOLUTION_WRITER_FLOOR_FLAG);
    old.close();
    const t = transcript("sess-fence", "CANARY-FENCE");
    const columns = (db: Database) => (db.prepare("PRAGMA table_info(memory_evolution)").all() as { name: string }[]).map(c => c.name);
    const older = new Database(vault);
    older.exec("BEGIN IMMEDIATE");                           // an older ClawMem mid-write as the upgraded hook starts
    let failed: Awaited<ReturnType<typeof hook>>;
    try {
      failed = await compactStart("sess-fence", t);
    } finally {
      older.exec("ROLLBACK");
    }
    expect(failed.code).toBe(0);
    expect(() => JSON.parse(failed.out.trim().split("\n").pop() || "")).not.toThrow(); // the hook's empty output
    expect(failed.context).toBe("");
    expect(failed.err).toContain("the vault could not be opened");
    expect(failed.err).toContain("evolution-writer floor");
    expect(columns(older)).not.toContain("writer");          // nothing of the fence remains
    const ok = await compactStart("sess-fence", t);          // the lock released: the next hook fences the vault
    expect(ok.code).toBe(0);
    expect(columns(older)).toContain("writer");
    older.close();
  }, 60_000);
});
