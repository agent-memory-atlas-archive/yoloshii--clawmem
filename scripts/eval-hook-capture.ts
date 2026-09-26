/**
 * Hook replay-eval — case capture tool (BUILD-0).
 *
 * Mines `context_usage` history from a vault snapshot into DRAFT hook replay
 * cases: for each qualifying context-surfacing turn it emits the current
 * prompt, the prior turns that were inside the multi-turn window at the time
 * (same session, ≤2 turns, ≤10 minutes), and empty label lists for the judge
 * to fill. Telemetry proposes candidates — it is NEVER truth: every emitted
 * case is a draft until hand-labeled and attested (--audited on the run).
 *
 * Usage:
 *   bun scripts/eval-hook-capture.ts --db <snapshot.sqlite> [--session <id>] \
 *     [--limit N] [--min-prompt-chars N] [--out cases-draft.jsonl]
 *
 * Snapshot the live vault first (never point this at a DB the watcher is
 * writing): sqlite3 ~/.cache/clawmem/index.sqlite "VACUUM INTO 'snap.sqlite'"
 */

import { Database } from "bun:sqlite";
import { parseArgs } from "util";
import { writeFileSync } from "fs";
import { resolve } from "path";

const MULTI_TURN_LOOKBACK = 2;
const MULTI_TURN_MAX_AGE_MINUTES = 10;

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    db: { type: "string" },
    session: { type: "string" },
    limit: { type: "string", default: "40" },
    "min-prompt-chars": { type: "string", default: "30" },
    out: { type: "string" },
  },
});

if (!values.db) {
  console.error("Usage: bun scripts/eval-hook-capture.ts --db <snapshot.sqlite> [--session <id>] [--limit N] [--min-prompt-chars N] [--out file.jsonl]");
  process.exit(1);
}

const limit = Number(values.limit);
const minChars = Number(values["min-prompt-chars"]);
const db = new Database(resolve(values.db), { readonly: true });

interface UsageRow {
  id: number;
  session_id: string;
  timestamp: string;
  turn_index: number;
  query_text: string;
  injected_paths: string;
}

const sessionFilter = values.session ? `AND session_id = '${values.session.replace(/'/g, "''")}'` : "";
const rows = db.prepare(
  `SELECT id, session_id, timestamp, turn_index, query_text, injected_paths
     FROM context_usage
    WHERE hook_name = 'context-surfacing'
      AND query_text IS NOT NULL
      AND length(query_text) >= ?
      ${sessionFilter}
    ORDER BY id DESC
    LIMIT ?`
).all(minChars, limit) as UsageRow[];

interface DraftCase {
  id: string;
  prompt: string;
  priors?: { text: string; age_minutes: number }[];
  profile: "speed" | "balanced" | "deep";
  prior_leg?: string;
  labels: { must_include: string[]; acceptable: string[]; must_not_include: string[] };
  split: string;
  tags: string[];
}

const drafts: DraftCase[] = [];
for (const row of rows) {
  // Reconstruct the priors that were in the lookback window AT THAT TURN —
  // same predicate shape as buildMultiTurnSurfacingQuery, anchored on the
  // turn's own timestamp instead of now.
  const turnMs = Date.parse(row.timestamp);
  const cutoffIso = new Date(turnMs - MULTI_TURN_MAX_AGE_MINUTES * 60_000).toISOString();
  const priorRows = db.prepare(
    `SELECT query_text, timestamp FROM context_usage
      WHERE session_id = ?
        AND hook_name = 'context-surfacing'
        AND id < ?
        AND timestamp > ?
        AND query_text IS NOT NULL
        AND query_text != ''
        AND query_text != ?
      ORDER BY id DESC
      LIMIT ?`
  ).all(row.session_id, row.id, cutoffIso, row.query_text, MULTI_TURN_LOOKBACK) as { query_text: string; timestamp: string }[];

  const priors = priorRows.map(p => ({
    text: p.query_text,
    age_minutes: Math.max(0, Math.round((turnMs - Date.parse(p.timestamp)) / 60_000)),
  }));

  // What the hook actually injected at that turn — seeded into `acceptable`
  // as CANDIDATES ONLY. The judge must re-triage every path: promote the
  // genuinely-required ones to must_include, demote noise to
  // must_not_include, and delete the rest.
  let injected: string[] = [];
  try { injected = JSON.parse(row.injected_paths) as string[]; } catch { /* keep empty */ }

  const draft: DraftCase = {
    id: `cap-${row.session_id.slice(0, 8)}-t${row.turn_index}`,
    prompt: row.query_text,
    ...(priors.length > 0 ? { priors, prior_leg: "TODO-required|harmless|forbidden" } : {}),
    profile: "balanced",
    labels: { must_include: [], acceptable: injected, must_not_include: [] },
    split: "TODO-tuning|holdout",
    tags: ["captured", `session:${row.session_id.slice(0, 8)}`],
  };
  drafts.push(draft);
}

const out = drafts.reverse().map(d => JSON.stringify(d)).join("\n") + "\n";
if (values.out) {
  writeFileSync(resolve(values.out), out);
  console.error(`wrote ${drafts.length} draft case(s) to ${resolve(values.out)}`);
  console.error(`DRAFTS ONLY: fill labels/split/prior_leg (TODO markers make the strict loader refuse the file until triaged), then run with --audited after a hand-audit.`);
} else {
  console.log(out);
}
