/**
 * 62.1 (T32 #3): the feedback step's durable read of a Hermes transcript.
 *
 * The Hermes plugin settles every prefetch by its row's id: a delivery record on the user line of the turn that
 * received it, or an outcome line (dropped / unresolved). This scan reads each transcript once, from its first line,
 * resuming where the last pass stopped — so a pass costs what was appended since, never the whole transcript, and no
 * clock chooses where to read. What it read is kept (`hermes_marks`): the user line that carries each row's id, the
 * next user line's start once read (where that turn ends), and each row the plugin closed. A transcript replaced under
 * the same key (another file, another first line, or no longer the line the scan stopped after) is read again from its
 * start, and its old marks are dropped.
 */

import type { Database } from "bun:sqlite";
import { isoNow, type MonoDeadline } from "./clock.ts";
import { lineShaEndingAt, streamLines, transcriptFileIdentity, type FileIdentity } from "./stop-cursor.ts";

/** What the scan has read about one row: the turn that received it, and whether the plugin closed it. */
export type HermesMark = { delivered: { start: number; end: number; next: number | null } | null; settled: boolean };

type ScanRow = { file_dev: number | null; file_ino: number | null; first_line_sha: string; byte_offset: number; tail_sha: string; generation: number };

/** A scan's outcome: `eof` — it committed and read to the end of the complete lines; `file` — the file it read. */
export type HermesScan = { eof: boolean; committed: boolean; file: FileIdentity | null };

const sameFile = (a: FileIdentity, b: FileIdentity | null) =>
  !!b && a.dev === b.dev && a.ino === b.ino && a.firstLineSha === b.firstLineSha;

/**
 * Read what this transcript gained since the last pass, and record it. Progress is kept even when `deadline` cuts the
 * read short (every line before the returned position was read), so a long transcript is read across passes, never
 * restarted. The commit is a compare-and-set (T33 #2): it applies only if no other pass committed, reset or pruned
 * since this one read the scan state (its generation), and the file is still the one read — otherwise nothing is
 * recorded and the next pass reads again. `beforeCommit` is for tests (another pass acting meanwhile).
 */
export function scanHermesTranscript(
  db: Database, sessionId: string, key: string, path: string,
  opts?: { maxBytes?: number; deadline?: MonoDeadline; beforeCommit?: () => void },
): HermesScan {
  const file = transcriptFileIdentity(path);
  if (!file) return { eof: false, committed: false, file: null };
  const st = db.prepare(
    `SELECT file_dev, file_ino, first_line_sha, byte_offset, tail_sha, generation FROM hermes_scan
     WHERE session_id = ? AND transcript_key = ?`
  ).get(sessionId, key) as ScanRow | null;
  const same = !!st && st.file_dev === file.dev && st.file_ino === file.ino && st.first_line_sha === file.firstLineSha
    && st.byte_offset <= file.size && lineShaEndingAt(path, st.byte_offset) === st.tail_sha;
  const from = same ? st!.byte_offset : 0;

  let firstHuman: number | null = null;   // where this read's first user line starts: the end of a stored open turn
  const delivered: { id: number; start: number; end: number; next: number | null }[] = [];
  const settled: number[] = [];
  const s = streamLines(path, from, l => {
    if (l.kind === "human") {
      if (firstHuman === null) firstHuman = l.start;
      const last = delivered[delivered.length - 1];
      if (last && last.next === null) last.next = l.start;   // only the latest recipient can still be open
      if (l.delivery?.usageId != null) delivered.push({ id: l.delivery.usageId, start: l.start, end: l.end, next: null });
    } else if (l.prefetchOutcome) {
      settled.push(l.prefetchOutcome.usageId);
    }
  }, { maxBytes: opts?.maxBytes, deadline: opts?.deadline });
  // Nothing complete appended since the last pass to the same (checked) file: nothing to record (T34 #5).
  if (same && s.next === from) return { eof: s.eof, committed: true, file };
  const tail = lineShaEndingAt(path, s.next) ?? "";
  opts?.beforeCommit?.();

  let committed = false;
  db.transaction(() => {
    const now = db.prepare(`SELECT generation FROM hermes_scan WHERE session_id = ? AND transcript_key = ?`)
      .get(sessionId, key) as { generation: number } | null;
    if ((now?.generation ?? null) !== (st?.generation ?? null) || !sameFile(file, transcriptFileIdentity(path))) return;
    if (!same) db.prepare(`DELETE FROM hermes_marks WHERE session_id = ? AND transcript_key = ?`).run(sessionId, key);
    if (firstHuman !== null) {
      db.prepare(
        `UPDATE hermes_marks SET next_human = ? WHERE session_id = ? AND transcript_key = ? AND kind = 'delivered'
         AND next_human IS NULL AND line_start < ?`
      ).run(firstHuman, sessionId, key, firstHuman);
    }
    // Idempotent: a pass that read the same lines (a concurrent one) records the same facts; a turn end found by
    // either is kept.
    const mark = db.prepare(
      `INSERT INTO hermes_marks (session_id, transcript_key, usage_id, kind, line_start, line_end, next_human)
       VALUES (?, ?, ?, 'delivered', ?, ?, ?)
       ON CONFLICT (session_id, transcript_key, usage_id, kind) DO UPDATE SET next_human = COALESCE(next_human, excluded.next_human)`
    );
    for (const d of delivered) mark.run(sessionId, key, d.id, d.start, d.end, d.next);
    const close = db.prepare(
      `INSERT OR IGNORE INTO hermes_marks (session_id, transcript_key, usage_id, kind) VALUES (?, ?, ?, 'settled')`
    );
    for (const id of settled) close.run(sessionId, key, id);
    db.prepare(
      `INSERT INTO hermes_scan (session_id, transcript_key, file_dev, file_ino, first_line_sha, byte_offset, tail_sha, generation, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (session_id, transcript_key) DO UPDATE SET file_dev = excluded.file_dev, file_ino = excluded.file_ino,
         first_line_sha = excluded.first_line_sha, byte_offset = excluded.byte_offset, tail_sha = excluded.tail_sha,
         generation = excluded.generation, updated_at = excluded.updated_at`
    ).run(sessionId, key, file.dev, file.ino, file.firstLineSha, s.next, tail, (st?.generation ?? 0) + 1, isoNow());
    committed = true;
  }).immediate();
  return { eof: committed && s.eof, committed, file };
}

/** The scan state's generation (null before the first scan): verdicts made from marks apply only while it holds. */
export function hermesGeneration(db: Database, sessionId: string, key: string): number | null {
  const r = db.prepare(`SELECT generation FROM hermes_scan WHERE session_id = ? AND transcript_key = ?`).get(sessionId, key) as
    { generation: number } | null;
  return r?.generation ?? null;
}

/** The file a scan read is still the transcript at `path` (stream 2 reads it at the scan's offsets). */
export function stillHermesFile(scan: HermesScan, path: string): boolean {
  return !!scan.file && sameFile(scan.file, transcriptFileIdentity(path));
}

/** What the scan has recorded for one row. */
export function hermesMark(db: Database, sessionId: string, key: string, usageId: number): HermesMark {
  const rows = db.prepare(
    `SELECT kind, line_start, line_end, next_human FROM hermes_marks WHERE session_id = ? AND transcript_key = ? AND usage_id = ?`
  ).all(sessionId, key, usageId) as { kind: string; line_start: number | null; line_end: number | null; next_human: number | null }[];
  const d = rows.find(r => r.kind === "delivered");
  return {
    delivered: d && d.line_start !== null && d.line_end !== null ? { start: d.line_start, end: d.line_end, next: d.next_human } : null,
    settled: rows.some(r => r.kind === "settled"),
  };
}

/**
 * A row's marks are dropped with its final verdict: nothing reads them after. The scan state's generation moves with
 * them, so a scan that read before the drop cannot put them back (its compare-and-set fails).
 */
export function dropHermesMarks(db: Database, sessionId: string, key: string, usageIds: number[]): void {
  if (usageIds.length === 0) return;
  const drop = db.prepare(`DELETE FROM hermes_marks WHERE session_id = ? AND transcript_key = ? AND usage_id = ?`);
  for (const id of usageIds) drop.run(sessionId, key, id);
  db.prepare(`UPDATE hermes_scan SET generation = generation + 1 WHERE session_id = ? AND transcript_key = ?`).run(sessionId, key);
}
