/**
 * Retro-stamp a run identity into a PRE-IDENTITY hook-run.json baseline —
 * an explicit ATTESTATION operation (codex turn-8 finding 4: an unattested
 * baseline can never produce acceptance_pass: true; a baseline produced by
 * code that predates identity fingerprints cannot be re-run, so the operator
 * attests its identity through this tool instead).
 *
 * The stamp only writes what it can VERIFY or what the invoker explicitly
 * attests:
 *  - gold fingerprint: computed over the SAME gold objects a live run
 *    fingerprints — the label-resolved, CLEANED scored cases (unresolved
 *    acceptable labels removed; codex turn-9 finding 6). Resolution runs
 *    against mkdtemp WORKING COPIES of the attested snapshot(s) — the
 *    originals are never opened. The report's scored cases (ids + splits +
 *    profiles) must match the gold file exactly, and none may carry
 *    unresolved must/must-not labels (those cases were never scored);
 *  - corpus hash: length-framed content hash (hashCorpusFiles — identical
 *    helper to the eval CLI) of the snapshot(s) the invoker attests;
 *  - topology: the CLAWMEM_* env this invocation runs under (set them to
 *    the ORIGINAL run's values) + live served-model probes (/v1/models for
 *    embed/llm, behavioral score fingerprint for rerank) + the effective
 *    model ids and LLM options;
 *  - local-fallback policy: the TRUTHFUL policy the original run executed
 *    under (CLAWMEM_NO_LOCAL_MODELS of THIS invocation — set it to what the
 *    original run effectively had; the launcher defaults it "false" =
 *    allowed). Attesting "blocked" for a run that executed under "allowed"
 *    is attesting a policy the run did not execute — behavioral inertness
 *    is not policy (codex turn-11 finding 4). When the truthful policy is
 *    "allowed", --fallback-observed is REQUIRED: "none" only when route
 *    evidence proves no local model executed (e.g. the local-model cache
 *    held no loadable GGUF for any exercised service at run time — absence
 *    now of a model that a fallback would have downloaded); "unknown" when
 *    the route cannot be reconstructed — comparisons against such a
 *    baseline demote to INFORMATIONAL-only;
 *  - latency protocol: --reps (default 1 — pre-protocol baselines were
 *    single-run measurements; the acceptance gate downgrades latency axes
 *    to unmeasured against a different candidate protocol).
 *
 * The identity carries `attested: "retro-stamped <date>"` so a stamped
 * baseline is never mistaken for a run-time-recorded one. The original file
 * is backed up beside itself before writing; a report that already carries
 * an identity is refused.
 *
 * Usage:
 *   bun scripts/eval-hook-stamp-baseline.ts --run eval-runs/<dir>/hook-run.json \
 *     --gold eval-hook-cases-seed.local.jsonl --db <snapshot> [--skill-db <snapshot>] [--reps 1] \
 *     [--fallback-observed none|unknown]   # REQUIRED when attesting local_fallback=allowed
 */
import { parseArgs } from "util";
import { readFileSync, writeFileSync, copyFileSync, existsSync, mkdtempSync, cpSync, rmSync } from "fs";
import { resolve, join } from "path";
import { tmpdir } from "os";
import { Database } from "bun:sqlite";
import { parseHookGoldFile, resolveHookLabels } from "../src/eval/hook-gold.ts";
import {
  goldFingerprint, parseBaselineReport, hashCorpusFiles,
  probeServedModel, probeRerankFingerprint, type RunIdentity,
} from "../src/eval/hook-run.ts";

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    run: { type: "string" },
    gold: { type: "string" },
    db: { type: "string" },
    "skill-db": { type: "string" },
    reps: { type: "string", default: "1" },
    "fallback-observed": { type: "string" },
  },
});

function die(msg: string): never {
  console.error(`stamp-baseline: ${msg}`);
  process.exit(1);
}

if (!values.run || !values.gold || !values.db) {
  die("usage: --run <hook-run.json> --gold <gold.jsonl> --db <snapshot> [--skill-db <snapshot>] [--reps N] [--fallback-observed none|unknown]");
}
const runPath = resolve(values.run);
const goldPath = resolve(values.gold);
const dbPath = resolve(values.db);
const skillDbPath = values["skill-db"] ? resolve(values["skill-db"]) : undefined;
const reps = Number(values.reps);
if (!Number.isInteger(reps) || reps < 1) die("--reps must be a positive integer");

// The invoker ATTESTS the fallback policy of the original run via
// CLAWMEM_NO_LOCAL_MODELS. Under "allowed" the routing attestation is
// REQUIRED (codex turn-11 finding 4); under "blocked" it is meaningless —
// policy already excludes local execution — and refused.
const localFallback: "blocked" | "allowed" = process.env.CLAWMEM_NO_LOCAL_MODELS === "true" ? "blocked" : "allowed";
const fallbackObserved = values["fallback-observed"];
if (fallbackObserved !== undefined && fallbackObserved !== "none" && fallbackObserved !== "unknown") {
  die(`--fallback-observed must be "none" or "unknown"`);
}
if (localFallback === "allowed" && fallbackObserved === undefined) {
  die(`attesting local_fallback=allowed REQUIRES --fallback-observed: "none" only when route evidence proves no local model executed during the original run; "unknown" otherwise (the comparison demotes to informational-only)`);
}
if (localFallback === "blocked" && fallbackObserved !== undefined) {
  die(`--fallback-observed is only meaningful when attesting local_fallback=allowed — "blocked" already excludes local execution by policy`);
}

// parseBaselineReport validates the report shape; a report that ALREADY
// carries an identity is refused — stamping over a run-time identity would
// erase evidence.
const report = parseBaselineReport(runPath);
if (report.identity) die(`${runPath} already carries a run identity (${report.identity.attested ?? "run-time-recorded"}) — refusing to overwrite`);

// Verify the report's scored cases match the CURRENT gold file exactly.
const gold = parseHookGoldFile(goldPath);
const goldById = new Map(gold.map(e => [e.id, e]));
const rawScored = report.cases.map(c => {
  const e = goldById.get(c.id);
  if (!e) die(`report case "${c.id}" is not in ${goldPath} — the gold set changed; cannot attest`);
  if (e!.split !== c.split) die(`case "${c.id}" split mismatch (gold ${e!.split} vs report ${c.split})`);
  if (e!.profile !== c.profile) die(`case "${c.id}" profile mismatch (gold ${e!.profile} vs report ${c.profile})`);
  return e!;
});
if (rawScored.length !== report.cases.length) die("scored-case reconciliation failed");

// Resolve + clean the labels EXACTLY as a live run does, against mkdtemp
// working copies of the attested snapshot(s) — the fingerprint must cover
// the same gold objects a live candidate fingerprints (turn-9 finding 6),
// and the operator's snapshot is never opened directly.
const workDir = mkdtempSync(join(tmpdir(), "clawmem-stamp-"));
let scored: typeof rawScored;
try {
  const workDb = join(workDir, "work.sqlite");
  cpSync(dbPath, workDb);
  if (existsSync(dbPath + "-wal")) cpSync(dbPath + "-wal", workDb + "-wal");
  const generalDb = new Database(workDb, { readonly: true });
  let skillDb: Database | undefined;
  if (skillDbPath) {
    const workSkill = join(workDir, "work-skill.sqlite");
    cpSync(skillDbPath, workSkill);
    if (existsSync(skillDbPath + "-wal")) cpSync(skillDbPath + "-wal", workSkill + "-wal");
    skillDb = new Database(workSkill, { readonly: true });
  }
  try {
    const resolved = resolveHookLabels({ db: generalDb }, rawScored, skillDb ? { db: skillDb } : undefined);
    for (const r of resolved) {
      if (r.unresolved.length > 0) {
        die(`case "${r.example.id}" has unresolved labels against the attested snapshot (${r.unresolved.join("; ")}) — it could not have been a scored case of this baseline`);
      }
    }
    scored = resolved.map(r => r.example); // cleaned examples — same objects a live run fingerprints
  } finally {
    generalDb.close();
    skillDb?.close();
  }
} finally {
  rmSync(workDir, { recursive: true, force: true });
}

// Corpus content hash — identical helper + framing to the eval CLI.
const corpusHash = await hashCorpusFiles([
  dbPath,
  existsSync(dbPath + "-wal") ? dbPath + "-wal" : undefined,
  skillDbPath,
  skillDbPath && existsSync(skillDbPath + "-wal") ? skillDbPath + "-wal" : undefined,
]);

const envOrUnset = (name: string): string => process.env[name] ?? "unset";
const { DEFAULT_EMBED_MODEL, DEFAULT_QUERY_MODEL, DEFAULT_RERANK_MODEL } = await import("../src/store.ts");
const { normalizeRemoteLlmReasoningEffort, normalizeRemoteLlmNoThink } = await import("../src/llm.ts");

const identity: RunIdentity = {
  gold_fingerprint: goldFingerprint(scored),
  limit: report.limit,
  budget_ms: report.budget_ms,
  profiles: [...new Set(report.cases.map(c => c.profile))].sort().join("+"),
  corpus: corpusHash,
  corpus_label: `${dbPath} (attested)`,
  topology: {
    embed: envOrUnset("CLAWMEM_EMBED_URL"),
    llm: envOrUnset("CLAWMEM_LLM_URL"),
    rerank: envOrUnset("CLAWMEM_RERANK_URL"),
    // Same effective-value rules as the live identity: rerank model is the
    // store constant (no env override is honored by the runtime);
    // effort/no-think go through the runtime's own normalizers.
    embed_model: process.env.CLAWMEM_EMBED_MODEL?.trim() || DEFAULT_EMBED_MODEL,
    query_model: process.env.CLAWMEM_LLM_MODEL?.trim() || DEFAULT_QUERY_MODEL,
    rerank_model: DEFAULT_RERANK_MODEL,
    llm_effort: normalizeRemoteLlmReasoningEffort(process.env.CLAWMEM_LLM_REASONING_EFFORT) ?? "default",
    // EFFECTIVE boolean — the LlamaCpp constructor defaults noThink TRUE on
    // an unset env (`?? true`, llm.ts), so unset and "true" fingerprint
    // identically (codex turn-11 finding 5; same rule as the live identity).
    llm_no_think: String(normalizeRemoteLlmNoThink(process.env.CLAWMEM_LLM_NO_THINK) ?? true),
    local_fallback: localFallback,
    ...(fallbackObserved !== undefined ? { fallback_observed: fallbackObserved as "none" | "unknown" } : {}),
    served_embed: await probeServedModel(process.env.CLAWMEM_EMBED_URL),
    served_llm: await probeServedModel(process.env.CLAWMEM_LLM_URL),
    served_rerank: await probeRerankFingerprint(process.env.CLAWMEM_RERANK_URL),
  },
  latency_protocol: { reps, aggregation: "lower-median" },
  attested: `retro-stamped ${new Date().toISOString().slice(0, 10)} by scripts/eval-hook-stamp-baseline.ts`,
};

const backup = `${runPath}.bak-${new Date().toISOString().replace(/[:.]/g, "-")}-prestamp`;
copyFileSync(runPath, backup);
const raw = JSON.parse(readFileSync(runPath, "utf-8")) as Record<string, unknown>;
raw.identity = identity;
writeFileSync(runPath, JSON.stringify(raw, null, 2));
console.log(`stamped ${runPath}`);
console.log(`  gold ${identity.gold_fingerprint.slice(0, 12)}… (cleaned scored cases) · corpus ${corpusHash.slice(0, 12)}… · reps ${reps}`);
console.log(`  topology embed=${identity.topology.embed} (${identity.topology.served_embed}) llm=${identity.topology.llm} (${identity.topology.served_llm}) rerank=${identity.topology.rerank} (${identity.topology.served_rerank})`);
console.log(`  local_fallback=${identity.topology.local_fallback}${identity.topology.fallback_observed ? ` fallback_observed=${identity.topology.fallback_observed}` : ""} · llm_no_think=${identity.topology.llm_no_think}`);
console.log(`  backup: ${backup}`);
