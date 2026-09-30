/**
 * 62.1 D1/D11: the identity a context-surfacing row records, the transcript locator, and the binding of a keyless
 * OpenClaw row to its transcript.
 *
 * Every write here is best-effort for the hook that makes it: a failed registration is repeated by the transcript's
 * next prompt and by every Stop-family invocation, and a failed binding by the next invocation that resolves the file.
 */

import type { Database } from "bun:sqlite";
import { isAbsolute, resolve } from "path";
import { isoNow } from "./clock.ts";
import { lastChanges, stopPipelineReady, STOP_USAGE_WATERMARK_FLAG } from "./stop-schema.ts";
import { promptSha, stopHostOf, transcriptKey, type StopHost } from "./stop-pairing.ts";

/** The identity columns of a usage row (`context_usage.{prompt_sha, transcript_key, host, session_key}`). */
export type UsageIdentity = {
  promptSha: string | null;
  transcriptKey: string | null;
  host: StopHost;
  sessionKey: string | null;
};

/** A transcript path the locator accepts: absolute, `.jsonl` (the worker validates the file itself when it reads). */
export function locatorPath(transcriptPath: string | undefined): string | null {
  if (!transcriptPath || !isAbsolute(transcriptPath) || !transcriptPath.endsWith(".jsonl")) return null;
  return resolve(transcriptPath);
}

/**
 * The identity context-surfacing records on every row it writes, gated rows included. `null` on a vault whose
 * stop-pipeline migration is not verified for this connection: the hook then writes the legacy row (no hash, key or
 * locator), which stays unattributed.
 */
export function surfacingIdentity(
  db: Database,
  input: { prompt?: string; transcriptPath?: string; host?: string; sessionKey?: string },
): UsageIdentity | null {
  if (!stopPipelineReady(db)) return null;
  const path = locatorPath(input.transcriptPath);
  return {
    promptSha: promptSha(input.prompt ?? ""),
    transcriptKey: path ? transcriptKey(path) : null,
    host: stopHostOf(input.host),
    sessionKey: input.sessionKey ?? null,
  };
}

/**
 * Register (session id, transcript) in the locator. Reads first and inserts only when the row is absent, so a
 * registered transcript costs no write lock. A row is never replaced by another transcript's (the key is the path's).
 */
export function registerTranscript(
  db: Database,
  sessionId: string,
  transcriptPath: string,
  host: StopHost,
  sessionKey: string | null,
): void {
  const path = locatorPath(transcriptPath);
  if (!sessionId || !path || !stopPipelineReady(db)) return;
  try {
    const key = transcriptKey(path);
    if (db.prepare(`SELECT 1 FROM session_transcripts WHERE session_id = ? AND transcript_key = ?`).get(sessionId, key)) return;
    db.prepare(
      `INSERT OR IGNORE INTO session_transcripts (session_id, transcript_key, transcript_path, host, session_key, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(sessionId, key, path, host, sessionKey, isoNow());
  } catch { /* fail-open: the next prompt or Stop registers it */ }
}

/**
 * Bind the keyless surfacing rows of (session id, session key) to the transcript this invocation resolved (D1 rev
 * 14): OpenClaw's own resolver tells a session's base and topic transcripts apart by session key, so such a row
 * belongs to this transcript and to no other. Only rows above the usage watermark (pre-upgrade rows are frozen, D6),
 * each once. Returns the number of rows bound.
 */
export function bindKeylessUsageRows(db: Database, sessionId: string, sessionKey: string, key: string): number {
  if (!sessionId || !sessionKey || !stopPipelineReady(db)) return 0;
  try {
    const pending = db.prepare(
      `SELECT 1 FROM context_usage WHERE session_id = ? AND session_key = ? AND transcript_key IS NULL
         AND hook_name = 'context-surfacing' LIMIT 1`
    ).get(sessionId, sessionKey);
    if (!pending) return 0;
    db.prepare(
      `UPDATE context_usage SET transcript_key = ?
       WHERE session_id = ? AND session_key = ? AND transcript_key IS NULL AND hook_name = 'context-surfacing'
         AND id > COALESCE((SELECT CAST(value AS INTEGER) FROM vault_flags WHERE flag = ?), 0)`
    ).run(key, sessionId, sessionKey, STOP_USAGE_WATERMARK_FLAG);
    return lastChanges(db);
  } catch {
    return 0;   // fail-open: the next resolving invocation binds them
  }
}

/** context-surfacing's entry step: register the transcript, then bind this session key's keyless rows to it. */
export function registerSurfacingTranscript(
  db: Database,
  sessionId: string | undefined,
  transcriptPath: string | undefined,
  identity: UsageIdentity,
): void {
  if (!sessionId || !transcriptPath || identity.transcriptKey === null) return;
  registerTranscript(db, sessionId, transcriptPath, identity.host, identity.sessionKey);
  if (identity.sessionKey) bindKeylessUsageRows(db, sessionId, identity.sessionKey, identity.transcriptKey);
}
