/**
 * 62.1 D9/D10: the stop-pipeline schema and the writer fence.
 *
 * One IMMEDIATE transaction, run at the end of every writable open's schema setup, creates the stop-pipeline tables
 * (`utility_signals` among them — it used to be created lazily by feedback-loop), adds the stamp and identity columns,
 * records the usage watermark (the highest `context_usage.id` before the fence) and installs the fence triggers. An
 * older ClawMem writes none of the stamp columns, so on a migrated vault its Stop-hook writes to the fenced rows are
 * logged to `legacy_writer_log` and skipped (`RAISE(IGNORE)`) — except its usage-row insert, which fails
 * (`RAISE(FAIL)`) so its surfacing hook fails closed on its own alignment check instead of injecting untracked (the
 * baseline reads the new row's id with `last_insert_rowid()`, which an ignored insert leaves at the `hook_dedupe` row it
 * had just written). This version fills a fresh stamp on every write of those rows (`stampAssign`, `stampInsert`).
 *
 * Read-guarded: a vault that already has everything takes no write lock. When the transaction cannot commit, nothing
 * of it remains; the store still opens (unlike v0.40's evolution-writer fence), `stopPipelineReady` reports false for
 * that connection — Stop hooks then skip counter and cursor work, surfacing writes legacy rows, doctor fails — and the
 * next writable open tries again.
 */

import type { Database } from "bun:sqlite";
import { randomUUID } from "crypto";
import { isoNow } from "./clock.ts";

/** vault_flags: set when the stop-pipeline schema and fence were installed (written once). */
export const STOP_SCHEMA_MARKER = "stop-pipeline:schema-v1";
/** vault_flags: the highest `context_usage.id` when the fence was installed — every row at or below it is pre-upgrade history (D6). */
export const STOP_USAGE_WATERMARK_FLAG = "stop-pipeline:usage-watermark";

/** `_clawmem` path prefixes of the Stop hooks' documents, fenced by path (not type, D9). */
export const STOP_DOC_PREFIXES = ["decisions/", "antipatterns/", "handoffs/", "observations/"] as const;

const NOW_SQL = `strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`;

const TABLES_DDL: Record<string, string> = {
  utility_signals: `CREATE TABLE IF NOT EXISTS utility_signals (
      path TEXT NOT NULL,
      surfaced_count INTEGER NOT NULL DEFAULT 0,
      referenced_count INTEGER NOT NULL DEFAULT 0,
      last_surfaced TEXT,
      last_referenced TEXT,
      stamp TEXT,
      PRIMARY KEY (path)
    )`,
  // D6: the turn's injection manifest. In the general vault: one entry per injected document of EVERY vault (vault ''
  // = the general vault), the reference test's input. In a named vault: that vault's own entries for its mirror row
  // (vault ''), each with its document id pinned when the job was drained. A display path is unique within a vault.
  feedback_ledger: `CREATE TABLE IF NOT EXISTS feedback_ledger (
      usage_id INTEGER NOT NULL,
      vault TEXT NOT NULL DEFAULT '',
      display_path TEXT NOT NULL,
      vault_doc_id INTEGER,
      displayed_title TEXT,
      referenced_at TEXT,
      created_at TEXT NOT NULL,
      PRIMARY KEY (usage_id, vault, display_path)
    )`,
  feedback_turns: `CREATE TABLE IF NOT EXISTS feedback_turns (
      usage_id INTEGER PRIMARY KEY,
      state TEXT NOT NULL,
      reason TEXT,
      attempts INTEGER NOT NULL DEFAULT 0,
      next_retry_at TEXT,
      updated_at TEXT NOT NULL,
      revision INTEGER NOT NULL DEFAULT 0,
      source_revision INTEGER
    )`,
  // D2: the per-transcript cursor of each Stop hook.
  stop_cursors: `CREATE TABLE IF NOT EXISTS stop_cursors (
      session_id TEXT NOT NULL,
      hook TEXT NOT NULL,
      transcript_key TEXT NOT NULL,
      transcript_path TEXT NOT NULL,
      file_dev INTEGER,
      file_ino INTEGER,
      first_line_sha TEXT NOT NULL,
      anchor_epoch INTEGER NOT NULL DEFAULT 0,
      next_digest_seq INTEGER NOT NULL DEFAULT 1,
      byte_offset INTEGER NOT NULL,
      tail_sha TEXT NOT NULL,
      turn_start_offset INTEGER,
      human_turns INTEGER NOT NULL,
      summary_through INTEGER,
      last_output_at TEXT,
      retry_count INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      first_failed_at TEXT,
      PRIMARY KEY (session_id, hook, transcript_key)
    )`,
  // D3: quarantined ranges, leased by their retry.
  stop_retries: `CREATE TABLE IF NOT EXISTS stop_retries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      transcript_key TEXT NOT NULL,
      hook TEXT NOT NULL,
      transcript_path TEXT NOT NULL,
      file_dev INTEGER,
      file_ino INTEGER,
      first_line_sha TEXT,
      anchor_epoch INTEGER NOT NULL DEFAULT 0,
      from_offset INTEGER NOT NULL,
      to_offset INTEGER NOT NULL,
      range_key TEXT NOT NULL,
      range_sha TEXT NOT NULL,
      source_time TEXT,
      attempts INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      first_failed_at TEXT NOT NULL,
      next_retry_at TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'queued',
      claim_token TEXT,
      lease_expires_at TEXT,
      UNIQUE (session_id, transcript_key, hook, range_key)
    )`,
  // D4/D5: per-transcript item fingerprints (decisions, antipatterns, turn digests, the handoff summary).
  stop_items: `CREATE TABLE IF NOT EXISTS stop_items (
      session_id TEXT NOT NULL,
      transcript_key TEXT NOT NULL,
      kind TEXT NOT NULL,
      fp TEXT NOT NULL,
      anchor_epoch INTEGER NOT NULL DEFAULT 0,
      range_from INTEGER,
      range_to INTEGER,
      range_sha TEXT,
      seq INTEGER,
      payload TEXT NOT NULL,
      doc_id INTEGER,
      created_at TEXT NOT NULL,
      PRIMARY KEY (session_id, transcript_key, kind, fp)
    )`,
  session_docs: `CREATE TABLE IF NOT EXISTS session_docs (
      session_id TEXT NOT NULL,
      transcript_key TEXT NOT NULL,
      kind TEXT NOT NULL,
      path TEXT NOT NULL,
      doc_id INTEGER,
      rendered_fp TEXT,
      render_needed INTEGER NOT NULL DEFAULT 0,
      ended_at TEXT,
      created_at TEXT NOT NULL,
      PRIMARY KEY (session_id, transcript_key, kind)
    )`,
  // D11: the transcript locator.
  session_transcripts: `CREATE TABLE IF NOT EXISTS session_transcripts (
      session_id TEXT NOT NULL,
      transcript_key TEXT NOT NULL,
      transcript_path TEXT NOT NULL,
      host TEXT,
      session_key TEXT,
      updated_at TEXT NOT NULL,
      ended_at TEXT,
      PRIMARY KEY (session_id, transcript_key)
    )`,
  // T32 #3: the feedback step's durable read of a Hermes transcript (stop-hermes-scan.ts) — where it resumes, checked
  // against the file as a stop cursor is, and what it read: each row's recipient line and turn end, each closed row.
  hermes_scan: `CREATE TABLE IF NOT EXISTS hermes_scan (
      session_id TEXT NOT NULL,
      transcript_key TEXT NOT NULL,
      file_dev INTEGER,
      file_ino INTEGER,
      first_line_sha TEXT NOT NULL,
      byte_offset INTEGER NOT NULL,
      tail_sha TEXT NOT NULL,
      generation INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (session_id, transcript_key)
    )`,
  hermes_marks: `CREATE TABLE IF NOT EXISTS hermes_marks (
      session_id TEXT NOT NULL,
      transcript_key TEXT NOT NULL,
      usage_id INTEGER NOT NULL,
      kind TEXT NOT NULL,
      line_start INTEGER,
      line_end INTEGER,
      next_human INTEGER,
      PRIMARY KEY (session_id, transcript_key, usage_id, kind)
    )`,
  // D3: causal runs owed by committed ranges, leased by their consumer.
  causal_due: `CREATE TABLE IF NOT EXISTS causal_due (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      transcript_key TEXT NOT NULL,
      range_key TEXT NOT NULL,
      run_key TEXT NOT NULL,
      obs_doc_ids TEXT NOT NULL,
      source_time TEXT,
      window_at TEXT NOT NULL,
      mode TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'queued',
      claim_token TEXT,
      lease_expires_at TEXT,
      attempts INTEGER NOT NULL DEFAULT 0,
      next_retry_at TEXT,
      created_at TEXT NOT NULL,
      UNIQUE (session_id, transcript_key, range_key)
    )`,
  judge_deferred: `CREATE TABLE IF NOT EXISTS judge_deferred (
      fact_fp TEXT NOT NULL,
      old_doc_id INTEGER NOT NULL,
      fact_payload TEXT NOT NULL,
      session_id TEXT,
      queued_at TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      next_retry_at TEXT,
      state TEXT NOT NULL DEFAULT 'queued',
      PRIMARY KEY (fact_fp, old_doc_id)
    )`,
  // D8: the judge's pair memory.
  judge_pair_verdicts: `CREATE TABLE IF NOT EXISTS judge_pair_verdicts (
      fact_fp TEXT NOT NULL,
      old_doc_id INTEGER NOT NULL,
      old_doc_hash TEXT NOT NULL,
      contract_version TEXT NOT NULL,
      verdict TEXT NOT NULL,
      decided_at TEXT NOT NULL,
      PRIMARY KEY (fact_fp, old_doc_id, old_doc_hash, contract_version)
    )`,
  // D9: every write the fence stopped, by surface.
  legacy_writer_log: `CREATE TABLE IF NOT EXISTS legacy_writer_log (
      surface TEXT PRIMARY KEY,
      first_at TEXT NOT NULL,
      last_at TEXT NOT NULL,
      count INTEGER NOT NULL DEFAULT 0
    )`,
  // D9: the recompute's before-images (values keep their type: no declared column type).
  counter_repair_log: `CREATE TABLE IF NOT EXISTS counter_repair_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      op_id TEXT NOT NULL,
      tbl TEXT NOT NULL,
      row_key TEXT NOT NULL,
      col TEXT NOT NULL,
      old_value,
      new_value,
      created_at TEXT NOT NULL
    )`,
  recovered_antipattern_bodies: `CREATE TABLE IF NOT EXISTS recovered_antipattern_bodies (
      hash TEXT PRIMARY KEY,
      body TEXT NOT NULL,
      created_at TEXT NOT NULL
    )`,
};

const COLUMNS: Record<string, [string, string][]> = {
  context_usage: [
    ["prompt_sha", "TEXT"], ["transcript_key", "TEXT"], ["host", "TEXT"], ["session_key", "TEXT"],
    ["writer_stamp", "TEXT"], ["source_usage_id", "INTEGER"],
  ],
  documents: [["counter_stamp", "TEXT"], ["doc_stamp", "TEXT"], ["access_grace_until", "TEXT"]],
  memory_relations: [["stamp", "TEXT"]],
  co_activations: [["stamp", "TEXT"]],
  utility_signals: [["stamp", "TEXT"]],
  // T23 #1: the session end a host reported (SessionEnd / session_end), so the worker can make a verdict final.
  session_transcripts: [["ended_at", "TEXT"]],
  // T25 #6: a verdict's monotonic revision, and the general revision a named vault's mirror last applied.
  feedback_turns: [["revision", "INTEGER NOT NULL DEFAULT 0"], ["source_revision", "INTEGER"]],
};

const INDEXES = [
  `CREATE INDEX IF NOT EXISTS idx_context_usage_transcript ON context_usage(session_id, transcript_key)`,
  `CREATE INDEX IF NOT EXISTS idx_feedback_ledger_doc ON feedback_ledger(vault, vault_doc_id)`,
  `CREATE INDEX IF NOT EXISTS idx_feedback_turns_state ON feedback_turns(state, next_retry_at)`,
  `CREATE INDEX IF NOT EXISTS idx_stop_retries_due ON stop_retries(state, next_retry_at)`,
  `CREATE INDEX IF NOT EXISTS idx_stop_items_seq ON stop_items(session_id, transcript_key, kind, seq)`,
  `CREATE INDEX IF NOT EXISTS idx_causal_due_state ON causal_due(state, next_retry_at)`,
  `CREATE INDEX IF NOT EXISTS idx_judge_deferred_due ON judge_deferred(state, next_retry_at)`,
  `CREATE INDEX IF NOT EXISTS idx_counter_repair_log_op ON counter_repair_log(op_id)`,
];

/** The trigger body's log write: one row per fenced surface, counting every stopped row. */
function logWrite(surface: string): string {
  return `INSERT OR IGNORE INTO legacy_writer_log (surface, first_at, last_at, count) VALUES ('${surface}', ${NOW_SQL}, ${NOW_SQL}, 0);
      UPDATE legacy_writer_log SET last_at = ${NOW_SQL}, count = count + 1 WHERE surface = '${surface}';`;
}

function stopDocPath(row: "NEW" | "OLD"): string {
  const prefixes = STOP_DOC_PREFIXES.map(p => `substr(${row}.path, 1, ${p.length}) = '${p}'`).join(" OR ");
  return `${row}.collection = '_clawmem' AND (${prefixes})`;
}

const FENCE_TRIGGERS: Record<string, string> = {
  // Counters: an UPDATE of access_count / last_accessed_at that does not change counter_stamp.
  stop_fence_doc_counters: `CREATE TRIGGER IF NOT EXISTS stop_fence_doc_counters
    BEFORE UPDATE OF access_count, last_accessed_at ON documents
    FOR EACH ROW WHEN NEW.counter_stamp IS OLD.counter_stamp
    BEGIN
      ${logWrite("documents.counters")}
      SELECT RAISE(IGNORE);
    END`,
  // Stop-hook documents, by protected path: an unstamped insert, or a hash change that keeps the old stamp.
  stop_fence_doc_insert: `CREATE TRIGGER IF NOT EXISTS stop_fence_doc_insert
    BEFORE INSERT ON documents
    FOR EACH ROW WHEN ${stopDocPath("NEW")} AND NEW.doc_stamp IS NULL
    BEGIN
      ${logWrite("documents.stop-doc-insert")}
      SELECT RAISE(IGNORE);
    END`,
  stop_fence_doc_update: `CREATE TRIGGER IF NOT EXISTS stop_fence_doc_update
    BEFORE UPDATE OF hash ON documents
    FOR EACH ROW WHEN ${stopDocPath("OLD")} AND NEW.doc_stamp IS OLD.doc_stamp
    BEGIN
      ${logWrite("documents.stop-doc-update")}
      SELECT RAISE(IGNORE);
    END`,
  stop_fence_usage_rel_insert: `CREATE TRIGGER IF NOT EXISTS stop_fence_usage_rel_insert
    BEFORE INSERT ON memory_relations
    FOR EACH ROW WHEN NEW.relation_type = 'usage' AND NEW.stamp IS NULL
    BEGIN
      ${logWrite("memory_relations.usage-insert")}
      SELECT RAISE(IGNORE);
    END`,
  stop_fence_usage_rel_update: `CREATE TRIGGER IF NOT EXISTS stop_fence_usage_rel_update
    BEFORE UPDATE OF weight ON memory_relations
    FOR EACH ROW WHEN OLD.relation_type = 'usage' AND NEW.stamp IS OLD.stamp
    BEGIN
      ${logWrite("memory_relations.usage-update")}
      SELECT RAISE(IGNORE);
    END`,
  stop_fence_coact_insert: `CREATE TRIGGER IF NOT EXISTS stop_fence_coact_insert
    BEFORE INSERT ON co_activations
    FOR EACH ROW WHEN NEW.stamp IS NULL
    BEGIN
      ${logWrite("co_activations.insert")}
      SELECT RAISE(IGNORE);
    END`,
  stop_fence_coact_update: `CREATE TRIGGER IF NOT EXISTS stop_fence_coact_update
    BEFORE UPDATE OF count ON co_activations
    FOR EACH ROW WHEN NEW.stamp IS OLD.stamp
    BEGIN
      ${logWrite("co_activations.update")}
      SELECT RAISE(IGNORE);
    END`,
  stop_fence_utility_insert: `CREATE TRIGGER IF NOT EXISTS stop_fence_utility_insert
    BEFORE INSERT ON utility_signals
    FOR EACH ROW WHEN NEW.stamp IS NULL
    BEGIN
      ${logWrite("utility_signals.insert")}
      SELECT RAISE(IGNORE);
    END`,
  stop_fence_utility_update: `CREATE TRIGGER IF NOT EXISTS stop_fence_utility_update
    BEFORE UPDATE OF surfaced_count, referenced_count ON utility_signals
    FOR EACH ROW WHEN NEW.stamp IS OLD.stamp
    BEGIN
      ${logWrite("utility_signals.update")}
      SELECT RAISE(IGNORE);
    END`,
  // The only fence trigger that errors: an older surfacing hook's insertUsage throws, so its logInjection returns -1
  // and the hook fails closed (rev 22). FAIL keeps the log write made before it.
  stop_fence_usage_row: `CREATE TRIGGER IF NOT EXISTS stop_fence_usage_row
    BEFORE INSERT ON context_usage
    FOR EACH ROW WHEN NEW.writer_stamp IS NULL
    BEGIN
      ${logWrite("context_usage.insert")}
      SELECT RAISE(FAIL, 'clawmem: an older ClawMem wrote an unstamped context_usage row; upgrade every ClawMem process that shares this vault');
    END`,
};

/** Every fence trigger's name (doctor, `repair counters --remove-fence`). */
export const STOP_FENCE_TRIGGERS: readonly string[] = Object.keys(FENCE_TRIGGERS);

const readiness = new WeakMap<Database, boolean>();
const stampColumns = new WeakMap<Database, boolean>();

/** True when this connection verified the stop-pipeline schema and fence at open. False on read-only or ad-hoc handles. */
export function stopPipelineReady(db: Database): boolean {
  return readiness.get(db) === true;
}

/**
 * Rows the last INSERT/UPDATE/DELETE on this connection changed directly — SQLite's own `changes()`. Bun's
 * `run().changes` also counts rows its triggers wrote (a one-row documents UPDATE reports 10: the FTS sync), so every
 * compare-and-swap in the stop pipeline reads this instead.
 */
export function lastChanges(db: Database): number {
  return (db.prepare("SELECT changes() AS c").get() as { c: number }).c;
}

/** Retry backoff for the stop pipeline's queues (D3): 1 min, 5 min, 30 min, 2 h, then every 12 h. */
export const RETRY_BACKOFF_MS = [60_000, 300_000, 1_800_000, 7_200_000, 43_200_000] as const;

/** The next retry time after `attempts` failures (attempts ≥ 1). */
export function nextRetryAt(now: string, attempts: number): string {
  const step = RETRY_BACKOFF_MS[Math.min(Math.max(attempts, 1), RETRY_BACKOFF_MS.length) - 1]!;
  return new Date(Date.parse(now) + step).toISOString();
}

/** A fresh random stamp: every fenced write by this version carries a new one. */
export function freshStamp(): string {
  return randomUUID();
}

function columnsOf(db: Database, table: string): Set<string> {
  return new Set((db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(c => c.name));
}

/**
 * Whether this vault carries the stamp columns, so every write of a fenced row must fill them. The columns and the
 * triggers arrive in one transaction, so their presence is the test (a vault whose fence was removed keeps the columns;
 * a stamp there is harmless). Cached per connection; the migration refreshes it.
 */
export function hasStopStamps(db: Database): boolean {
  let present = stampColumns.get(db);
  if (present === undefined) {
    present = columnsOf(db, "documents").has("doc_stamp");
    stampColumns.set(db, present);
  }
  return present;
}

/** `, <col> = ?` and its fresh stamp for an UPDATE, when the vault has the stamp columns; nothing otherwise. */
export function stampAssign(db: Database, col: string): { sql: string; args: string[] } {
  return hasStopStamps(db) ? { sql: `, ${col} = ?`, args: [freshStamp()] } : { sql: "", args: [] };
}

/** `, <col>` / `, ?` and its fresh stamp for an INSERT, when the vault has the stamp columns; nothing otherwise. */
export function stampInsert(db: Database, col: string): { cols: string; vals: string; args: string[] } {
  return hasStopStamps(db) ? { cols: `, ${col}`, vals: ", ?", args: [freshStamp()] } : { cols: "", vals: "", args: [] };
}

/** What the vault lacks of the stop-pipeline schema (empty = complete): tables, columns, triggers, markers. */
export function missingStopSchema(db: Database): string[] {
  const missing: string[] = [];
  const objects = new Set(
    (db.prepare(`SELECT type || ':' || name AS k FROM sqlite_master WHERE type IN ('table', 'trigger')`).all() as { k: string }[])
      .map(r => r.k)
  );
  for (const t of Object.keys(TABLES_DDL)) if (!objects.has(`table:${t}`)) missing.push(`table ${t}`);
  for (const [table, cols] of Object.entries(COLUMNS)) {
    if (!objects.has(`table:${table}`)) continue;   // reported above, or a base table missing entirely
    const present = columnsOf(db, table);
    for (const [c] of cols) if (!present.has(c)) missing.push(`column ${table}.${c}`);
  }
  for (const t of STOP_FENCE_TRIGGERS) if (!objects.has(`trigger:${t}`)) missing.push(`trigger ${t}`);
  for (const f of [STOP_SCHEMA_MARKER, STOP_USAGE_WATERMARK_FLAG]) {
    if (!db.prepare(`SELECT 1 FROM vault_flags WHERE flag = ?`).get(f)) missing.push(`flag ${f}`);
  }
  return missing;
}

/**
 * Install the stop-pipeline schema and fence (D10), or confirm it is there. Returns whether this connection is ready;
 * never throws — a failure is logged loudly and retried by the next writable open.
 */
export function installStopPipelineSchema(db: Database): boolean {
  let ready = false;
  try {
    if (missingStopSchema(db).length === 0) {
      ready = true;
    } else {
      db.transaction(() => {
        // Tables first (utility_signals included), then the columns — re-read inside the lock, another process may
        // have migrated meanwhile — then the watermark and the triggers, so no row lands between them.
        for (const ddl of Object.values(TABLES_DDL)) db.exec(ddl);
        for (const [table, cols] of Object.entries(COLUMNS)) {
          const present = columnsOf(db, table);
          for (const [c, type] of cols) if (!present.has(c)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${c} ${type}`);
        }
        for (const ddl of INDEXES) db.exec(ddl);
        const now = isoNow();
        db.prepare(
          `INSERT OR IGNORE INTO vault_flags (flag, value, updated_at) VALUES (?, (SELECT COALESCE(MAX(id), 0) FROM context_usage), ?)`
        ).run(STOP_USAGE_WATERMARK_FLAG, now);
        for (const ddl of Object.values(FENCE_TRIGGERS)) db.exec(ddl);
        db.prepare(`INSERT OR IGNORE INTO vault_flags (flag, value, updated_at) VALUES (?, '1', ?)`).run(STOP_SCHEMA_MARKER, now);
        const missing = missingStopSchema(db);   // the outcome, not the attempt
        if (missing.length > 0) throw new Error(`still missing after the migration: ${missing.join(", ")}`);
      }).immediate();
      ready = true;
    }
  } catch (err) {
    console.error(
      `[clawmem] the stop-pipeline migration did not complete on this open ` +
      `(${err instanceof Error ? err.message : String(err)}). Stop hooks skip counter and cursor work and ` +
      `\`clawmem doctor\` fails until it does; the next writable open retries.`
    );
  }
  stampColumns.set(db, columnsOf(db, "documents").has("doc_stamp"));
  readiness.set(db, ready);
  return ready;
}
