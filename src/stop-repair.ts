/**
 * 62.1 D9: `clawmem repair counters` — the feedback counters recomputed from VERIFIED references only.
 *
 * Every step runs in chunks of at most 5,000 rows, one IMMEDIATE transaction per chunk that reads the ledger and writes
 * the counters together (so a concurrent attribution is either inside the read or after the write), resumes after a
 * crash from its per-step marker, and records each changed value's before-image in `counter_repair_log` under one op id:
 *  1. freeze — every context-surfacing row at or below the usage watermark → `feedback_turns` unattributable
 *     (`pre-upgrade`); no ledger entry is seeded from history;
 *  2. documents — `access_count` := verified references; `last_accessed_at` := the newest one, else `modified_at`;
 *     `access_grace_until` := now + 30 days + (id mod 60) days for a document whose OLD last access was inside its archive
 *     window (a staggered grace: expiries spread over 60 days, no single cliff);
 *  3. utility signals — surfaced from the `injected_paths` of history rows + the ledger's entries above the watermark;
 *     referenced from verified references;
 *  4. co-activations — every row deleted, then the verified same-turn co-references;
 *  5. usage relations — every row deleted, then the verified same-turn co-references (weight 1.0).
 * `stop-pipeline:recompute-v1` = the op id once every step completed. `--restore <op>` puts a value back only while it
 * still equals what the op wrote (re-inserts a deleted row only when its key is absent) and reports every conflict.
 */

import type { Database } from "bun:sqlite";
import { isoNow, epochNow, epochMs } from "./clock.ts";
import { freshStamp, lastChanges, stopPipelineReady, STOP_FENCE_TRIGGERS, STOP_USAGE_WATERMARK_FLAG } from "./stop-schema.ts";
import type { LifecyclePolicy } from "./collections.ts";

export const RECOMPUTE_MARKER = "stop-pipeline:recompute-v1";
const OP_FLAG = "stop-pipeline:recompute-op";
const stepFlag = (step: RecomputeStep) => `stop-pipeline:recompute-step:${step}`;
const CHUNK = 5_000;
const GRACE_BASE_DAYS = 30;
const GRACE_SPREAD_DAYS = 60;
const DAY_MS = 86_400_000;
const DEFAULT_ARCHIVE_DAYS = 90;

export const RECOMPUTE_STEPS = ["freeze", "documents", "utility", "co_activations", "usage_relations"] as const;
export type RecomputeStep = (typeof RECOMPUTE_STEPS)[number];

export type RecomputeReport = {
  opId: string | null;
  applied: boolean;
  alreadyDone: boolean;
  frozen: number;
  documents: number;
  graced: number;
  utility: number;
  coActivationsDeleted: number;
  coActivationsInserted: number;
  relationsDeleted: number;
  relationsInserted: number;
};

function flag(db: Database, name: string): string | null {
  return (db.prepare(`SELECT value FROM vault_flags WHERE flag = ?`).get(name) as { value: string } | null)?.value ?? null;
}
function setFlag(db: Database, name: string, value: string): void {
  db.prepare(`INSERT INTO vault_flags (flag, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(flag) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`)
    .run(name, value, isoNow());
}
function usageWatermark(db: Database): number {
  return Number(flag(db, STOP_USAGE_WATERMARK_FLAG) ?? 0);
}

/** Whether the one-time recompute has completed on this vault. */
export function recomputeDone(db: Database): boolean {
  return flag(db, RECOMPUTE_MARKER) !== null;
}

type Logger = (op: string, tbl: string, key: string, col: string, oldValue: unknown, newValue: unknown) => void;
function repairLogger(db: Database, apply: boolean): Logger {
  const ins = db.prepare(
    `INSERT INTO counter_repair_log (op_id, tbl, row_key, col, old_value, new_value, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`
  );
  return (op, tbl, key, col, oldValue, newValue) => {
    if (apply) ins.run(op, tbl, key, col, oldValue as any, newValue as any, isoNow());
  };
}

// ── The steps ───────────────────────────────────────────────────────────────────────────────────────────────────

type Pause = () => Promise<void>;
const noPause: Pause = async () => {};

async function stepFreeze(db: Database, apply: boolean, now: string, pause: Pause): Promise<number> {
  const wm = usageWatermark(db);
  if (!apply) {
    return (db.prepare(
      `SELECT COUNT(*) AS n FROM context_usage u WHERE u.hook_name = 'context-surfacing' AND u.id <= ?
         AND NOT EXISTS (SELECT 1 FROM feedback_turns f WHERE f.usage_id = u.id)`
    ).get(wm) as { n: number }).n;
  }
  let frozen = 0;
  for (let lo = 0; lo < wm; lo += CHUNK) {
    db.transaction(() => {
      db.prepare(
        `INSERT OR IGNORE INTO feedback_turns (usage_id, state, reason, attempts, updated_at)
         SELECT id, 'unattributable', 'pre-upgrade', 0, ? FROM context_usage
         WHERE hook_name = 'context-surfacing' AND id > ? AND id <= ?`
      ).run(now, lo, Math.min(lo + CHUNK, wm));
      frozen += lastChanges(db);
    }).immediate();
    await pause();
  }
  return frozen;
}

function graceWindowDays(policy: LifecyclePolicy | undefined, collection: string, contentType: string | null): number | null {
  if (policy?.exempt_collections.includes(collection)) return null;
  const override = contentType ? policy?.type_overrides[contentType] : undefined;
  if (override === null) return null;   // this type is never archived
  return override ?? policy?.archive_after_days ?? DEFAULT_ARCHIVE_DAYS;
}

type DocRow = {
  id: number; collection: string; content_type: string | null; access_count: number; last_accessed_at: string | null;
  modified_at: string; access_grace_until: string | null; refs: number; newest: string | null;
};

async function stepDocuments(db: Database, op: string, apply: boolean, policy: LifecyclePolicy | undefined, nowMs: number, log: Logger, pause: Pause): Promise<{ changed: number; graced: number }> {
  const out = { changed: 0, graced: 0 };
  const read = db.prepare(
    `SELECT d.id, d.collection, d.content_type, d.access_count, d.last_accessed_at, d.modified_at, d.access_grace_until,
       (SELECT COUNT(*) FROM feedback_ledger l WHERE l.vault = '' AND l.vault_doc_id = d.id AND l.referenced_at IS NOT NULL) AS refs,
       (SELECT MAX(l.referenced_at) FROM feedback_ledger l WHERE l.vault = '' AND l.vault_doc_id = d.id AND l.referenced_at IS NOT NULL) AS newest
     FROM documents d WHERE d.id > ? ORDER BY d.id LIMIT ?`
  );
  const write = db.prepare(`UPDATE documents SET access_count = ?, last_accessed_at = ?, access_grace_until = ?, counter_stamp = ? WHERE id = ?`);
  const progressFlag = `${stepFlag("documents")}:after`;
  let after = apply ? Number(flag(db, progressFlag) ?? 0) : 0;
  for (;;) {
    let rows: DocRow[] = [];
    const chunk = () => {
      rows = read.all(after, CHUNK) as DocRow[];
      for (const r of rows) {
        const access = r.refs;
        const last = r.newest ?? r.modified_at;
        let grace = r.access_grace_until;
        const window = graceWindowDays(policy, r.collection, r.content_type);
        if (window !== null && r.last_accessed_at && Date.parse(r.last_accessed_at) > nowMs - window * DAY_MS) {
          grace = new Date(nowMs + (GRACE_BASE_DAYS + (r.id % GRACE_SPREAD_DAYS)) * DAY_MS).toISOString();
        }
        if (access === r.access_count && last === r.last_accessed_at && grace === r.access_grace_until) continue;
        out.changed++;
        if (grace !== r.access_grace_until) out.graced++;
        if (!apply) continue;
        write.run(access, last, grace, freshStamp(), r.id);
        const key = String(r.id);
        if (access !== r.access_count) log(op, "documents", key, "access_count", r.access_count, access);
        if (last !== r.last_accessed_at) log(op, "documents", key, "last_accessed_at", r.last_accessed_at, last);
        if (grace !== r.access_grace_until) log(op, "documents", key, "access_grace_until", r.access_grace_until, grace);
      }
      if (rows.length > 0) {
        after = rows.at(-1)!.id;
        if (apply) setFlag(db, progressFlag, String(after));
      }
    };
    if (apply) db.transaction(chunk).immediate(); else chunk();
    if (rows.length < CHUNK) break;
    await pause();
  }
  return out;
}

async function stepUtility(db: Database, op: string, apply: boolean, log: Logger, pause: Pause): Promise<number> {
  // History (read-only, frozen): the surfaced paths of every context-surfacing row at or below the watermark.
  const wm = usageWatermark(db);
  const hist = new Map<string, { n: number; last: string }>();
  const readUsage = db.prepare(
    `SELECT id, timestamp, injected_paths FROM context_usage WHERE hook_name = 'context-surfacing' AND id > ? AND id <= ? ORDER BY id`
  );
  for (let lo = 0; lo < wm; lo += CHUNK) {
    for (const r of readUsage.all(lo, Math.min(lo + CHUNK, wm)) as { id: number; timestamp: string; injected_paths: string }[]) {
      let paths: unknown;
      try { paths = JSON.parse(r.injected_paths); } catch { continue; }
      if (!Array.isArray(paths)) continue;
      for (const p of new Set(paths.filter((x): x is string => typeof x === "string"))) {
        const h = hist.get(p);
        if (!h) hist.set(p, { n: 1, last: r.timestamp });
        else { h.n++; if (r.timestamp > h.last) h.last = r.timestamp; }
      }
    }
    await pause();
  }
  const ledgerPaths = (db.prepare(`SELECT DISTINCT display_path AS p FROM feedback_ledger WHERE vault = '' AND vault_doc_id IS NOT NULL`).all() as { p: string }[]).map(r => r.p);
  const existing = (db.prepare(`SELECT path AS p FROM utility_signals`).all() as { p: string }[]).map(r => r.p);
  const all = [...new Set([...hist.keys(), ...ledgerPaths, ...existing])].sort();
  // The ledger's per-path aggregate, read inside each chunk's transaction (one scan per chunk, coherent with its writes).
  const readLedger = db.prepare(
    `SELECT display_path AS p, COUNT(*) AS surfaced, MAX(created_at) AS last_surfaced,
       SUM(CASE WHEN referenced_at IS NOT NULL THEN 1 ELSE 0 END) AS referenced, MAX(referenced_at) AS last_referenced
     FROM feedback_ledger WHERE vault = '' AND vault_doc_id IS NOT NULL GROUP BY display_path`
  );
  type LedgerAgg = { p: string; surfaced: number; last_surfaced: string | null; referenced: number | null; last_referenced: string | null };
  const noLedger: LedgerAgg = { p: "", surfaced: 0, last_surfaced: null, referenced: 0, last_referenced: null };
  const readSignal = db.prepare(`SELECT surfaced_count, referenced_count, last_surfaced, last_referenced FROM utility_signals WHERE path = ?`);
  const upsert = db.prepare(
    `INSERT INTO utility_signals (path, surfaced_count, referenced_count, last_surfaced, last_referenced, stamp) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(path) DO UPDATE SET surfaced_count = excluded.surfaced_count, referenced_count = excluded.referenced_count,
       last_surfaced = excluded.last_surfaced, last_referenced = excluded.last_referenced, stamp = excluded.stamp`
  );
  let changed = 0;
  for (let i = 0; i < all.length; i += CHUNK) {
    const chunk = () => {
      const ledgerOf = new Map((readLedger.all() as LedgerAgg[]).map(r => [r.p, r] as const));
      for (const path of all.slice(i, i + CHUNK)) {
        const l = ledgerOf.get(path) ?? noLedger;
        const h = hist.get(path);
        const surfaced = (h?.n ?? 0) + l.surfaced;
        const lastSurfaced = [h?.last ?? null, l.last_surfaced].filter((x): x is string => !!x).sort().at(-1) ?? null;
        const referenced = l.referenced ?? 0;
        const cur = readSignal.get(path) as { surfaced_count: number; referenced_count: number; last_surfaced: string | null; last_referenced: string | null } | null;
        if (cur && cur.surfaced_count === surfaced && cur.referenced_count === referenced
          && cur.last_surfaced === lastSurfaced && cur.last_referenced === l.last_referenced) continue;
        changed++;
        if (!apply) continue;
        upsert.run(path, surfaced, referenced, lastSurfaced, l.last_referenced, freshStamp());
        log(op, "utility_signals", path, "*row", cur ? JSON.stringify(cur) : null,
          JSON.stringify({ surfaced_count: surfaced, referenced_count: referenced, last_surfaced: lastSurfaced, last_referenced: l.last_referenced }));
      }
    };
    if (apply) db.transaction(chunk).immediate(); else chunk();
    await pause();
  }
  return changed;
}

/** Delete every row of a table present at the start (rowid ≤ the start's max), in chunks, each deleted row logged. */
async function deleteAll(db: Database, op: string, apply: boolean, tbl: "co_activations" | "memory_relations", where: string, log: Logger, pause: Pause): Promise<number> {
  const max = (db.prepare(`SELECT COALESCE(MAX(rowid), 0) AS m FROM ${tbl} WHERE ${where}`).get() as { m: number }).m;
  if (!apply) return (db.prepare(`SELECT COUNT(*) AS n FROM ${tbl} WHERE ${where}`).get() as { n: number }).n;
  let deleted = 0;
  for (;;) {
    let n = 0;
    db.transaction(() => {
      const rows = db.prepare(`SELECT rowid AS rid, * FROM ${tbl} WHERE ${where} AND rowid <= ? ORDER BY rowid LIMIT ?`).all(max, CHUNK) as Record<string, unknown>[];
      n = rows.length;
      for (const r of rows) {
        const { rid, ...row } = r;
        log(op, tbl, String(rid), "*delete", JSON.stringify(row), null);
      }
      if (n > 0) db.prepare(`DELETE FROM ${tbl} WHERE ${where} AND rowid IN (${rows.map(() => "?").join(",")})`).run(...rows.map(r => r.rid as number));
      deleted += n;
    }).immediate();
    if (n < CHUNK) break;
    await pause();
  }
  return deleted;
}

const VERIFIED_PAIRS = `
  SELECT a.display_path AS pa, b.display_path AS pb, a.vault_doc_id AS da, b.vault_doc_id AS db_,
         MIN(a.rowid) AS ra, MIN(b.rowid) AS rb, COUNT(*) AS n,
         MAX(MAX(a.referenced_at), MAX(b.referenced_at)) AS last
  FROM feedback_ledger a JOIN feedback_ledger b ON b.usage_id = a.usage_id AND b.vault = '' AND b.display_path > a.display_path
  WHERE a.vault = '' AND a.referenced_at IS NOT NULL AND b.referenced_at IS NOT NULL
    AND a.vault_doc_id IS NOT NULL AND b.vault_doc_id IS NOT NULL
  GROUP BY a.display_path, b.display_path`;

async function stepCoActivations(db: Database, op: string, apply: boolean, log: Logger, pause: Pause): Promise<{ deleted: number; inserted: number }> {
  const deleted = await deleteAll(db, op, apply, "co_activations", "1 = 1", log, pause);
  const page = db.prepare(`WITH pairs AS (${VERIFIED_PAIRS}) SELECT pa, pb, n, last FROM pairs WHERE pa > ? OR (pa = ? AND pb > ?) ORDER BY pa, pb LIMIT ?`);
  const upsert = db.prepare(
    `INSERT INTO co_activations (doc_a, doc_b, count, last_seen, stamp) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(doc_a, doc_b) DO UPDATE SET count = excluded.count, last_seen = excluded.last_seen, stamp = excluded.stamp`
  );
  let inserted = 0;
  let a = "";
  let b = "";
  for (;;) {
    let rows: { pa: string; pb: string; n: number; last: string }[] = [];
    const chunk = () => {
      rows = page.all(a, a, b, CHUNK) as typeof rows;
      for (const r of rows) {
        inserted++;
        if (!apply) continue;
        upsert.run(r.pa, r.pb, r.n, r.last, freshStamp());
        log(op, "co_activations", `${r.pa}\u0000${r.pb}`, "*insert", null, JSON.stringify({ doc_a: r.pa, doc_b: r.pb, count: r.n, last_seen: r.last }));
      }
    };
    if (apply) db.transaction(chunk).immediate(); else chunk();
    if (rows.length < CHUNK) break;
    a = rows.at(-1)!.pa;
    b = rows.at(-1)!.pb;
    await pause();
  }
  return { deleted, inserted };
}

async function stepUsageRelations(db: Database, op: string, apply: boolean, log: Logger, pause: Pause): Promise<{ deleted: number; inserted: number }> {
  const deleted = await deleteAll(db, op, apply, "memory_relations", "relation_type = 'usage'", log, pause);
  const page = db.prepare(`WITH pairs AS (${VERIFIED_PAIRS}) SELECT pa, pb, da, db_, ra, rb FROM pairs WHERE pa > ? OR (pa = ? AND pb > ?) ORDER BY pa, pb LIMIT ?`);
  const upsert = db.prepare(
    `INSERT INTO memory_relations (source_id, target_id, relation_type, weight, created_at, stamp) VALUES (?, ?, 'usage', 1.0, ?, ?)
     ON CONFLICT(source_id, target_id, relation_type) DO UPDATE SET weight = 1.0, stamp = excluded.stamp`
  );
  let inserted = 0;
  let a = "";
  let b = "";
  for (;;) {
    let rows: { pa: string; pb: string; da: number; db_: number; ra: number; rb: number }[] = [];
    const chunk = () => {
      rows = page.all(a, a, b, CHUNK) as typeof rows;
      for (const r of rows) {
        if (r.da === r.db_) continue;
        // The manifest order (ledger rowid) gives the direction, as the attribution records it.
        const [src, tgt] = r.ra <= r.rb ? [r.da, r.db_] : [r.db_, r.da];
        inserted++;
        if (!apply) continue;
        const now = isoNow();
        upsert.run(src, tgt, now, freshStamp());
        log(op, "memory_relations", `${src}\u0000${tgt}\u0000usage`, "*insert", null, JSON.stringify({ source_id: src, target_id: tgt, relation_type: "usage", weight: 1.0 }));
      }
    };
    if (apply) db.transaction(chunk).immediate(); else chunk();
    if (rows.length < CHUNK) break;
    a = rows.at(-1)!.pa;
    b = rows.at(-1)!.pb;
    await pause();
  }
  return { deleted, inserted };
}

// ── Entry points ────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Plan (`apply: false`, no writes) or run the recompute. A run resumes the recorded op at its first unfinished step and
 * marks the vault done at the end. Requires the stop-pipeline schema and fence (the ledger exists first).
 */
export async function recomputeCounters(
  db: Database,
  opts: { apply: boolean; policy?: LifecyclePolicy; force?: boolean; pause?: Pause },
): Promise<RecomputeReport> {
  if (!stopPipelineReady(db)) throw new Error("the stop-pipeline schema is not verified on this vault — run `clawmem doctor`");
  const report: RecomputeReport = {
    opId: null, applied: opts.apply, alreadyDone: recomputeDone(db), frozen: 0, documents: 0, graced: 0, utility: 0,
    coActivationsDeleted: 0, coActivationsInserted: 0, relationsDeleted: 0, relationsInserted: 0,
  };
  if (opts.apply && report.alreadyDone && !opts.force) return report;
  const op = opts.apply ? (report.alreadyDone ? null : flag(db, OP_FLAG)) ?? `rc-${isoNow()}` : "plan";
  report.opId = opts.apply ? op : null;
  if (opts.apply) setFlag(db, OP_FLAG, op);
  const log = repairLogger(db, opts.apply);
  const nowMs = epochMs(epochNow());
  const now = isoNow();
  const pending = (s: RecomputeStep) => !opts.apply || flag(db, stepFlag(s)) !== op;
  const done = (s: RecomputeStep) => { if (opts.apply) setFlag(db, stepFlag(s), op); };
  const pause = opts.pause ?? noPause;
  if (pending("freeze")) { report.frozen = await stepFreeze(db, opts.apply, now, pause); done("freeze"); }
  if (pending("documents")) {
    const d = await stepDocuments(db, op, opts.apply, opts.policy, nowMs, log, pause);
    report.documents = d.changed;
    report.graced = d.graced;
    done("documents");
  }
  if (pending("utility")) { report.utility = await stepUtility(db, op, opts.apply, log, pause); done("utility"); }
  if (pending("co_activations")) {
    const c = await stepCoActivations(db, op, opts.apply, log, pause);
    report.coActivationsDeleted = c.deleted;
    report.coActivationsInserted = c.inserted;
    done("co_activations");
  }
  if (pending("usage_relations")) {
    const r = await stepUsageRelations(db, op, opts.apply, log, pause);
    report.relationsDeleted = r.deleted;
    report.relationsInserted = r.inserted;
    done("usage_relations");
  }
  if (opts.apply) {
    setFlag(db, RECOMPUTE_MARKER, op);
    db.prepare(`DELETE FROM vault_flags WHERE flag = ?`).run(`${stepFlag("documents")}:after`);
  }
  return report;
}

export type RestoreReport = { opId: string; restored: number; conflicts: string[] };

const KEY_COLS: Record<string, string[]> = {
  documents: ["id"],
  utility_signals: ["path"],
  co_activations: ["doc_a", "doc_b"],
  memory_relations: ["source_id", "target_id", "relation_type"],
};

/** Reverse an op: a value only while it still equals what the op wrote; a deleted row only while its key is absent. */
export function restoreCounterRepair(db: Database, opId: string): RestoreReport {
  const out: RestoreReport = { opId, restored: 0, conflicts: [] };
  const rows = db.prepare(`SELECT id, tbl, row_key, col, old_value, new_value FROM counter_repair_log WHERE op_id = ? ORDER BY id DESC`)
    .all(opId) as { id: number; tbl: string; row_key: string; col: string; old_value: unknown; new_value: unknown }[];
  if (rows.length === 0) throw new Error(`no repair op ${opId} in counter_repair_log`);
  for (let i = 0; i < rows.length; i += CHUNK) {
    db.transaction(() => {
      for (const r of rows.slice(i, i + CHUNK)) {
        const keyCols = KEY_COLS[r.tbl];
        if (!keyCols) { out.conflicts.push(`${r.tbl} ${r.row_key}: unknown table`); continue; }
        if (r.col === "*delete") {
          const row = JSON.parse(String(r.old_value)) as Record<string, unknown>;
          const keyWhere = keyCols.map(k => `${k} = ?`).join(" AND ");
          if (db.prepare(`SELECT 1 FROM ${r.tbl} WHERE ${keyWhere}`).get(...keyCols.map(k => row[k] as any))) {
            out.conflicts.push(`${r.tbl} ${r.row_key}: a row with its key exists again — not re-inserted`);
            continue;
          }
          const cols = Object.keys(row).filter(c => c !== "stamp");
          db.prepare(`INSERT INTO ${r.tbl} (${cols.join(", ")}, stamp) VALUES (${cols.map(() => "?").join(", ")}, ?)`)
            .run(...cols.map(c => row[c] as any), freshStamp());
          out.restored++;
          continue;
        }
        if (r.col === "*insert") {
          const row = JSON.parse(String(r.new_value)) as Record<string, unknown>;
          const keyWhere = keyCols.map(k => `${k} = ?`).join(" AND ");
          const cur = db.prepare(`SELECT * FROM ${r.tbl} WHERE ${keyWhere}`).get(...keyCols.map(k => row[k] as any)) as Record<string, unknown> | null;
          if (!cur || Object.keys(row).some(c => cur[c] !== row[c])) {
            out.conflicts.push(`${r.tbl} ${r.row_key}: changed since the op — kept`);
            continue;
          }
          db.prepare(`DELETE FROM ${r.tbl} WHERE ${keyWhere}`).run(...keyCols.map(k => row[k] as any));
          out.restored++;
          continue;
        }
        if (r.col === "*row") {
          const next = JSON.parse(String(r.new_value)) as Record<string, unknown>;
          const cur = db.prepare(`SELECT surfaced_count, referenced_count, last_surfaced, last_referenced FROM utility_signals WHERE path = ?`)
            .get(r.row_key) as Record<string, unknown> | null;
          if (!cur || Object.keys(next).some(c => cur[c] !== next[c])) {
            out.conflicts.push(`utility_signals ${r.row_key}: changed since the op — kept`);
            continue;
          }
          if (r.old_value === null) db.prepare(`DELETE FROM utility_signals WHERE path = ?`).run(r.row_key);
          else {
            const prev = JSON.parse(String(r.old_value)) as Record<string, unknown>;
            db.prepare(`UPDATE utility_signals SET surfaced_count = ?, referenced_count = ?, last_surfaced = ?, last_referenced = ?, stamp = ? WHERE path = ?`)
              .run(prev.surfaced_count as any, prev.referenced_count as any, prev.last_surfaced as any, prev.last_referenced as any, freshStamp(), r.row_key);
          }
          out.restored++;
          continue;
        }
        // A single column of documents.
        db.prepare(`UPDATE documents SET ${r.col} = ?, counter_stamp = ? WHERE id = ? AND ${r.col} IS ?`)
          .run(r.old_value as any, freshStamp(), Number(r.row_key), r.new_value as any);
        if (lastChanges(db) === 1) out.restored++;
        else out.conflicts.push(`documents ${r.row_key}.${r.col}: changed since the op — kept`);
      }
    }).immediate();
  }
  return out;
}

/** The downgrade path: drop the fence triggers (an upgraded process reinstalls them at its next writable open). */
export function removeStopFence(db: Database): number {
  let dropped = 0;
  db.transaction(() => {
    for (const t of STOP_FENCE_TRIGGERS) {
      const had = !!db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'trigger' AND name = ?`).get(t);
      db.exec(`DROP TRIGGER IF EXISTS ${t}`);
      if (had) dropped++;
    }
  }).immediate();
  return dropped;
}

/** Grace expiries per coming week (doctor's projection), the next `weeks` weeks. */
export function graceExpiryProjection(db: Database, weeks = 10): number[] {
  const nowMs = epochMs(epochNow());
  const out = new Array<number>(weeks).fill(0);
  const rows = db.prepare(`SELECT access_grace_until AS g FROM documents WHERE active = 1 AND access_grace_until > ?`)
    .all(new Date(nowMs).toISOString()) as { g: string }[];
  for (const r of rows) {
    const w = Math.floor((Date.parse(r.g) - nowMs) / (7 * DAY_MS));
    if (w >= 0 && w < weeks) out[w]!++;
  }
  return out;
}
