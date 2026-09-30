/**
 * BUILD-5 t60 (codex F59-1/F59-2) — the off-process surfacing bookkeeping
 * module. Locks:
 *
 *  1. applySurfacingBookkeeping fills the early alignment row (paths/tokens
 *     UPDATE) and writes recall events linked to it; usageId=-1 (failed-open
 *     alignment insert) skips the UPDATE and writes events unlinked.
 *  2. The in-process handoff slot is consume-once.
 *  3. Spool roundtrip on a file-backed store: write → drain applies + unlinks.
 *  4. Poison jobs (unparsable / wrong shape) are DISCARDED, never retried.
 *  5. A job whose writes throw is RETAINED (claim released) for a later
 *     drainer — transient DB errors are the retry case.
 *  6. :memory: stores never touch the filesystem (spool write returns null).
 *  7. Stale leftovers (.tmp/.claim past SPOOL_MAX_AGE_MS) are reaped.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, readdirSync, readFileSync, renameSync, existsSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createStore, type Store } from "../../src/store.ts";
import { seedDocuments } from "../helpers/test-store.ts";
import {
  serializeSurfacingBookkeepingJob,
  SPOOL_JOB_MAX_BYTES,
  setPendingSurfacingBookkeeping,
  consumePendingSurfacingBookkeeping,
  applySurfacingBookkeeping,
  writeSurfacingBookkeepingSpoolJob,
  drainSurfacingBookkeepingSpool,
  spoolDirForDb,
  SPOOL_MAX_AGE_MS,
  validateSurfacingBookkeepingJob,
  type SurfacingBookkeepingJob,
} from "../../src/hooks/surfacing-bookkeeping.ts";

let dir: string;
let store: Store;

function fileStore(): Store {
  return createStore(join(dir, "index.sqlite"));
}

function job(over: Partial<SurfacingBookkeepingJob> = {}): SurfacingBookkeepingJob {
  return {
    v: 1,
    kind: "surfacing-bookkeeping",
    jobId: "job-test-1",
    sessionId: "bk-s1",
    turnIndex: 0,
    usageId: 1,
    queryHash: "qh-1",
    injectedPaths: ["test/m/a.md"],
    estimatedTokens: 42,
    vaults: [{ vault: null, docs: [{ displayPath: "test/m/a.md", searchScore: 0.9 }] }],
    ...over,
  };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "clawmem-spool-test-"));
  store = fileStore();
  seedDocuments(store, [{ path: "m/a.md", title: "doc a", body: "alpha content for bookkeeping" }]);
  consumePendingSurfacingBookkeeping(); // clear any slot residue from other suites
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("handoff slot", () => {
  it("is consume-once", () => {
    const j = job();
    setPendingSurfacingBookkeeping(j);
    expect(consumePendingSurfacingBookkeeping()).toBe(j);
    expect(consumePendingSurfacingBookkeeping()).toBeNull();
  });
});

describe("applySurfacingBookkeeping", () => {
  it("fills the alignment row and links recall events to it", () => {
    const usageId = store.insertUsage({
      sessionId: "bk-s1", timestamp: new Date().toISOString(), hookName: "context-surfacing",
      injectedPaths: [], estimatedTokens: 0, wasReferenced: 0, turnIndex: 0, queryText: "the prompt",
    });
    applySurfacingBookkeeping(store, job({ usageId }));
    const row = store.db.prepare(`SELECT injected_paths, estimated_tokens, query_text FROM context_usage WHERE id = ?`)
      .get(usageId) as { injected_paths: string; estimated_tokens: number; query_text: string };
    expect(JSON.parse(row.injected_paths)).toEqual(["test/m/a.md"]);
    expect(row.estimated_tokens).toBe(42);
    expect(row.query_text).toBe("the prompt"); // UPDATE never touches alignment fields
    const ev = store.db.prepare(`SELECT usage_id FROM recall_events WHERE session_id = 'bk-s1'`).all() as { usage_id: number | null }[];
    expect(ev.length).toBe(1);
    expect(ev[0]!.usage_id).toBe(usageId);
  });

  it("t62 F61-1: a FALSE guarded update (row absent / identity mismatch) writes events UNLINKED — never the stale id", () => {
    // usageId 7 references no row at all — the guarded UPDATE returns false,
    // so linkage must be dropped (pre-t62 the bare `usageId > 0` check
    // attached the stale id anyway; recall_events.usage_id has no FK, so the
    // bad attribution would persist silently).
    const r = applySurfacingBookkeeping(store, job({ usageId: 7 }));
    expect(r.usageLinked).toBe(false);
    const ev = store.db.prepare(`SELECT usage_id FROM recall_events WHERE session_id = 'bk-s1'`).all() as { usage_id: number | null }[];
    expect(ev.length).toBe(1);
    expect(ev[0]!.usage_id).toBeNull();
  });

  it("t62 F61-1: the linkage outcome persists across a retry — pass 2 events still honor pass 1's false", () => {
    // Identity mismatch: a row EXISTS at the id but under a different turn.
    const wrongTurnId = store.insertUsage({
      sessionId: "bk-s1", timestamp: new Date().toISOString(), hookName: "context-surfacing",
      injectedPaths: [], estimatedTokens: 0, wasReferenced: 0, turnIndex: 9, queryText: "p",
    });
    // Pass 1: update runs (false), the general unit FAILS (stub) → retained
    // shape carries completedUnits + usageLinked.
    const realInsert = store.insertRecallEvents;
    store.insertRecallEvents = () => { throw new Error("SQLITE_BUSY (simulated)"); };
    const j = job({ usageId: wrongTurnId });
    const r1 = applySurfacingBookkeeping(store, j);
    expect(r1.usageLinked).toBe(false);
    expect(r1.completedUnits).toContain("update");
    expect(r1.failedUnits).toEqual(["general"]);
    store.insertRecallEvents = realInsert;
    // Pass 2 — as the drainer would rerun it: completedUnits + usageLinked in.
    const r2 = applySurfacingBookkeeping(store, { ...j, completedUnits: r1.completedUnits, usageLinked: r1.usageLinked });
    expect(r2.failedUnits).toEqual([]);
    const ev = store.db.prepare(`SELECT usage_id FROM recall_events WHERE session_id = 'bk-s1'`).all() as { usage_id: number | null }[];
    expect(ev.length).toBe(1);
    expect(ev[0]!.usage_id).toBeNull(); // linked per the REAL pass-1 outcome, not the stale id
    // The mismatched row itself was never touched.
    const row = store.db.prepare(`SELECT injected_paths FROM context_usage WHERE id = ?`).get(wrongTurnId) as { injected_paths: string };
    expect(JSON.parse(row.injected_paths)).toEqual([]);
  });
});

describe("spool roundtrip", () => {
  it(":memory: stores never touch the filesystem", () => {
    expect(writeSurfacingBookkeepingSpoolJob(":memory:", job())).toBeNull();
    const mem = createStore(":memory:");
    expect(drainSurfacingBookkeepingSpool(mem)).toEqual({ applied: 0, discarded: 0, retained: 0 });
    mem.close();
  });

  it("write → drain applies the job and unlinks the file", () => {
    const usageId = store.insertUsage({
      sessionId: "bk-s1", timestamp: new Date().toISOString(), hookName: "context-surfacing",
      injectedPaths: [], estimatedTokens: 0, wasReferenced: 0, turnIndex: 0, queryText: "p",
    });
    const file = writeSurfacingBookkeepingSpoolJob(store.dbPath, job({ usageId }));
    expect(file).not.toBeNull();
    expect(existsSync(file!)).toBe(true);
    const r = drainSurfacingBookkeepingSpool(store);
    expect(r).toEqual({ applied: 1, discarded: 0, retained: 0 });
    expect(readdirSync(spoolDirForDb(store.dbPath))).toEqual([]);
    const row = store.db.prepare(`SELECT injected_paths FROM context_usage WHERE id = ?`).get(usageId) as { injected_paths: string };
    expect(JSON.parse(row.injected_paths)).toEqual(["test/m/a.md"]);
  });

  it("poison jobs are discarded, never retried", () => {
    const spool = spoolDirForDb(store.dbPath);
    writeSurfacingBookkeepingSpoolJob(store.dbPath, job()); // creates the dir
    writeFileSync(join(spool, "0-poison-0.json"), "{not json");
    writeFileSync(join(spool, "0-poison-1.json"), JSON.stringify({ v: 99, kind: "other" }));
    const r = drainSurfacingBookkeepingSpool(store);
    expect(r.applied).toBe(1);
    expect(r.discarded).toBe(2);
    expect(r.retained).toBe(0);
    expect(readdirSync(spool)).toEqual([]);
  });

  it("a job whose writes throw is retained for a later drainer (claim released)", () => {
    const usageId = store.insertUsage({
      sessionId: "bk-s1", timestamp: new Date().toISOString(), hookName: "context-surfacing",
      injectedPaths: [], estimatedTokens: 0, wasReferenced: 0, turnIndex: 0,
    });
    writeSurfacingBookkeepingSpoolJob(store.dbPath, job({ usageId }));
    const real = store.updateUsageInjection;
    store.updateUsageInjection = () => { throw new Error("SQLITE_BUSY (simulated)"); };
    const r1 = drainSurfacingBookkeepingSpool(store);
    expect(r1).toEqual({ applied: 0, discarded: 0, retained: 1 });
    // Claim was released back to .json — a later drainer succeeds.
    const names = readdirSync(spoolDirForDb(store.dbPath));
    expect(names.length).toBe(1);
    expect(names[0]!.endsWith(".json")).toBe(true);
    store.updateUsageInjection = real;
    const r2 = drainSurfacingBookkeepingSpool(store);
    expect(r2.applied).toBe(1);
    expect(readdirSync(spoolDirForDb(store.dbPath))).toEqual([]);
  });

  it("stale leftovers (.tmp / .claim past SPOOL_MAX_AGE_MS) are reaped", () => {
    writeSurfacingBookkeepingSpoolJob(store.dbPath, job()); // ensure dir exists
    const spool = spoolDirForDb(store.dbPath);
    const orphanTmp = join(spool, "1-1-1.json.tmp");
    const orphanClaim = join(spool, "2-2-2.json.claim-99999");
    writeFileSync(orphanTmp, "{}");
    writeFileSync(orphanClaim, "{}");
    const old = new Date(Date.now() - SPOOL_MAX_AGE_MS - 60_000);
    utimesSync(orphanTmp, old, old);
    utimesSync(orphanClaim, old, old);
    const r = drainSurfacingBookkeepingSpool(store);
    expect(r.applied).toBe(1);
    expect(r.discarded).toBe(2);
    expect(readdirSync(spool)).toEqual([]);
  });
});

describe("t61 F60-5: structural job validation", () => {
  it("accepts the canonical job and rejects every malformed variant", () => {
    expect(validateSurfacingBookkeepingJob(job())).toBe(true);
    expect(validateSurfacingBookkeepingJob(job({ completedUnits: ["update", "general"], usageLinked: true }))).toBe(true);
    expect(validateSurfacingBookkeepingJob(job({ completedUnits: ["update"], usageLinked: false }))).toBe(true);
    const bad: unknown[] = [
      null, 42, "x", {},
      job({ v: 2 as never }),
      job({ kind: "other" as never }),
      job({ jobId: "" }),
      { ...job(), jobId: undefined },
      job({ sessionId: "" }),
      job({ turnIndex: -1 }),
      job({ turnIndex: 1.5 }),
      { ...job(), turnIndex: "0" as never },
      { ...job(), usageId: 1.2 },
      job({ usageId: 0 }),
      job({ usageId: -1 }),
      job({ completedUnits: ["bogus-unit"] }),
      job({ completedUnits: ["general", "general"] }),
      job({ completedUnits: ["skillvault"] }), // a vault unit the job does NOT declare
      job({ completedUnits: ["update"] }), // t63: update marked complete WITHOUT its usageLinked outcome
      job({ usageLinked: true }), // t63: outcome present WITHOUT a completed update unit
      job({ completedUnits: ["@general"] }), // t63: the old untagged name is no longer a unit
      job({ completedUnits: ["general"] }), // t64 F63-1: event unit complete WITHOUT a completed update — the pre-t63 failure state
      job({ vaults: [{ vault: "skill", docs: [] }], completedUnits: ["vault:skill"] }), // t64 F63-1: named-vault twin of the same poison
      { ...job(), usageLinked: "yes" as never },
      job({ queryHash: "" }),
      { ...job(), estimatedTokens: Number.NaN },
      { ...job(), estimatedTokens: -1 },
      { ...job(), injectedPaths: ["ok", ""] },
      { ...job(), injectedPaths: "not-array" as never },
      { ...job(), vaults: "not-array" as never },
      { ...job(), vaults: [{ vault: "", docs: [] }] },
      { ...job(), vaults: [{ vault: null, docs: [{ displayPath: "", searchScore: 1 }] }] },
      { ...job(), vaults: [{ vault: null, docs: [{ displayPath: "a/b.md", searchScore: Number.POSITIVE_INFINITY }] }] },
      { ...job(), vaults: [{ vault: null, docs: [] }, { vault: null, docs: [] }] }, // duplicate unit — ambiguous
      { ...job(), completedUnits: [""] },
    ];
    for (const [i, b] of bad.entries()) {
      expect(validateSurfacingBookkeepingJob(b), `variant ${i} should be rejected`).toBe(false);
    }
  });

  it("drain discards a structurally-invalid job instead of applying it", () => {
    const spool = spoolDirForDb(store.dbPath);
    writeSurfacingBookkeepingSpoolJob(store.dbPath, job({ usageId: 1 })); // ensures dir; valid job
    writeFileSync(join(spool, "0-bad-shape.json"), JSON.stringify({ ...job(), turnIndex: "zero" }));
    const r = drainSurfacingBookkeepingSpool(store);
    expect(r.applied).toBe(1);
    expect(r.discarded).toBe(1);
    expect(readdirSync(spool)).toEqual([]);
  });
});

describe("t61 F60-5: guarded updateUsageInjection", () => {
  it("updates only the row matching id + session + turn identity, and reports it", () => {
    const usageId = store.insertUsage({
      sessionId: "bk-s1", timestamp: new Date().toISOString(), hookName: "context-surfacing",
      injectedPaths: [], estimatedTokens: 0, wasReferenced: 0, turnIndex: 3, queryText: "p",
    });
    // Wrong turn identity → refused, row untouched, reported false.
    expect(store.updateUsageInjection(usageId, ["x/y.md"], 9, { sessionId: "bk-s1", turnIndex: 4 })).toBe(false);
    expect(store.updateUsageInjection(usageId, ["x/y.md"], 9, { sessionId: "other", turnIndex: 3 })).toBe(false);
    let row = store.db.prepare("SELECT injected_paths FROM context_usage WHERE id = ?").get(usageId) as { injected_paths: string };
    expect(JSON.parse(row.injected_paths)).toEqual([]);
    // Matching identity → applied, reported true.
    expect(store.updateUsageInjection(usageId, ["x/y.md"], 9, { sessionId: "bk-s1", turnIndex: 3 })).toBe(true);
    row = store.db.prepare("SELECT injected_paths FROM context_usage WHERE id = ?").get(usageId) as { injected_paths: string };
    expect(JSON.parse(row.injected_paths)).toEqual(["x/y.md"]);
  });
});

describe("t61 F60-3: idempotent retries and claim reclaim", () => {
  it("partial apply → retry never duplicates recall events and completes the failed unit", () => {
    // t63 shape: the update unit SETTLES (true) but the general events unit
    // fails on pass 1. The retained claim carries {completedUnits:["update"],
    // usageLinked:true}; the retry completes the events unit exactly once
    // (checkpoint skip + dedupe keys as the second belt).
    const usageId = store.insertUsage({
      sessionId: "bk-s1", timestamp: new Date().toISOString(), hookName: "context-surfacing",
      injectedPaths: [], estimatedTokens: 0, wasReferenced: 0, turnIndex: 0, queryText: "p",
    });
    writeSurfacingBookkeepingSpoolJob(store.dbPath, job({ usageId }));
    const real = store.insertRecallEvents;
    store.insertRecallEvents = () => { throw new Error("SQLITE_BUSY (simulated)"); };
    const r1 = drainSurfacingBookkeepingSpool(store);
    expect(r1).toEqual({ applied: 0, discarded: 0, retained: 1 });
    // The update unit landed on the failed pass; no events yet.
    expect((store.db.prepare("SELECT COUNT(*) c FROM recall_events WHERE session_id = 'bk-s1'").get() as { c: number }).c).toBe(0);
    const row1 = store.db.prepare("SELECT injected_paths FROM context_usage WHERE id = ?").get(usageId) as { injected_paths: string };
    expect(JSON.parse(row1.injected_paths)).toEqual(["test/m/a.md"]);
    // The retained claim carries the consistent checkpoint state.
    const spool = spoolDirForDb(store.dbPath);
    const retainedName = readdirSync(spool)[0]!;
    const retained = JSON.parse(readFileSync(join(spool, retainedName), "utf-8")) as { completedUnits?: string[]; usageLinked?: boolean };
    expect(retained.completedUnits).toEqual(["update"]);
    expect(retained.usageLinked).toBe(true);
    store.insertRecallEvents = real;
    const r2 = drainSurfacingBookkeepingSpool(store);
    expect(r2.applied).toBe(1);
    // Exactly one event after the retry, LINKED per the persisted outcome.
    const ev = store.db.prepare("SELECT usage_id FROM recall_events WHERE session_id = 'bk-s1'").all() as { usage_id: number | null }[];
    expect(ev.length).toBe(1);
    expect(ev[0]!.usage_id).toBe(usageId);
  });

  it("dedupe keys alone stop a double-apply even with completedUnits stripped (the second belt)", () => {
    const j = job();
    applySurfacingBookkeeping(store, j);
    applySurfacingBookkeeping(store, j); // same jobId, no completedUnits carried
    const c = (store.db.prepare("SELECT COUNT(*) c FROM recall_events WHERE session_id = 'bk-s1'").get() as { c: number }).c;
    expect(c).toBe(1);
  });

  it("a claim abandoned by a DEAD drainer pid is reclaimed and applied by the next drain", () => {
    const usageId = store.insertUsage({
      sessionId: "bk-s1", timestamp: new Date().toISOString(), hookName: "context-surfacing",
      injectedPaths: [], estimatedTokens: 0, wasReferenced: 0, turnIndex: 0, queryText: "p",
    });
    const file = writeSurfacingBookkeepingSpoolJob(store.dbPath, job({ usageId }))!;
    // Simulate a drainer that died right after claiming: rename to a claim
    // owned by a pid that certainly does not exist.
    const deadClaim = `${file}.claim-999999`;
    renameSync(file, deadClaim);
    const r = drainSurfacingBookkeepingSpool(store);
    expect(r.applied).toBe(1);
    expect(readdirSync(spoolDirForDb(store.dbPath))).toEqual([]);
    const row = store.db.prepare("SELECT injected_paths FROM context_usage WHERE id = ?").get(usageId) as { injected_paths: string };
    expect(JSON.parse(row.injected_paths)).toEqual(["test/m/a.md"]);
  });

  it("a claim held by a LIVE pid is left alone", () => {
    writeSurfacingBookkeepingSpoolJob(store.dbPath, job());
    const spool = spoolDirForDb(store.dbPath);
    const name = readdirSync(spool)[0]!;
    const liveClaim = join(spool, `${name}.claim-${process.pid}2`); // a pid string that... must be a REAL live pid: use our own
    renameSync(join(spool, name), join(spool, `${name}.claim-1`)); // pid 1 = init, always alive (EPERM → treated live)
    void liveClaim;
    const r = drainSurfacingBookkeepingSpool(store);
    expect(r.applied).toBe(0);
    expect(readdirSync(spool).length).toBe(1); // untouched (not stale yet)
  });
});

describe("t62 F61-3: bounded pipe handoff serialization", () => {
  it("serializes an admissible job and refuses an oversized one (fail-open drop)", () => {
    const ok = serializeSurfacingBookkeepingJob(job());
    expect(ok).not.toBeNull();
    expect(Buffer.byteLength(ok!, "utf-8")).toBeLessThanOrEqual(SPOOL_JOB_MAX_BYTES);
    // Structurally admissible (25 paths × ~1KB each) but serialized past the
    // cap → refused: the parent drops it rather than write an unbounded blob.
    const big = job({ injectedPaths: Array.from({ length: 35 }, (_, i) => `test/m/${"x".repeat(1000)}-${i}.md`) });
    expect(validateSurfacingBookkeepingJob(big)).toBe(true);
    expect(serializeSurfacingBookkeepingJob(big)).toBeNull();
    // Structurally inadmissible → also null.
    expect(serializeSurfacingBookkeepingJob(job({ usageId: 0 }))).toBeNull();
  });
});

describe("t62 F61-4: named-vault mirror insert is retry-idempotent", () => {
  it("crash after the mirror insert but before events/checkpoint: reclaim yields exactly ONE mirror and ONE event, linked", () => {
    // A real second file-backed store stands in for the named vault; the
    // test seam routes resolution to it. Its insertRecallEvents throws on
    // the FIRST attempt — the crash window codex named: mirror inserted,
    // events + checkpoint never reached, unit NOT completed.
    const vaultDir = mkdtempSync(join(tmpdir(), "clawmem-vault-"));
    const vaultStore = createStore(join(vaultDir, "skill.sqlite"));
    try {
      seedDocuments(vaultStore, [{ path: "m/v.md", title: "vault doc", body: "vault content for mirror idempotency" }]);
      const j = job({
        usageId: 1,
        vaults: [{ vault: "skill", docs: [{ displayPath: "test/m/v.md", searchScore: 0.7 }] }],
      });
      const seam = { resolveVaultStore: () => vaultStore };
      const realInsert = vaultStore.insertRecallEvents;
      vaultStore.insertRecallEvents = () => { throw new Error("crash window (simulated)"); };
      const r1 = applySurfacingBookkeeping(store, j, seam);
      expect(r1.failedUnits).toEqual(["vault:skill"]);
      // 62.1 D6: the mirror, its membership and its events commit in ONE vault transaction, so the crash leaves no
      // half-written mirror behind (through v0.40 the mirror survived alone: 1 row here).
      expect((vaultStore.db.prepare("SELECT COUNT(*) c FROM context_usage WHERE session_id = 'bk-s1'").get() as { c: number }).c).toBe(0);
      vaultStore.insertRecallEvents = realInsert;
      // Reclaim/retry — the unit reruns FROM THE TOP (mirror insert included).
      const r2 = applySurfacingBookkeeping(store, { ...j, completedUnits: r1.completedUnits, ...(r1.usageLinked !== undefined ? { usageLinked: r1.usageLinked } : {}) }, seam);
      expect(r2.failedUnits).toEqual([]);
      const mirrors = vaultStore.db.prepare("SELECT id FROM context_usage WHERE session_id = 'bk-s1'").all() as { id: number }[];
      expect(mirrors.length).toBe(1); // pre-t62: 2 — the F60-3 replay defect
      const ev = vaultStore.db.prepare("SELECT usage_id FROM recall_events WHERE session_id = 'bk-s1'").all() as { usage_id: number | null }[];
      expect(ev.length).toBe(1);
      expect(ev[0]!.usage_id).toBe(mirrors[0]!.id); // linked to the ONE true mirror
    } finally {
      vaultStore.close();
      rmSync(vaultDir, { recursive: true, force: true });
    }
  });
});

describe("t63 F62-1: a THROWN update defers every event unit — nothing commits unlinked-and-complete", () => {
  it("pass 1 (update throws): zero events, all units failed; pass 2: events land LINKED to the updated row", () => {
    const usageId = store.insertUsage({
      sessionId: "bk-s1", timestamp: new Date().toISOString(), hookName: "context-surfacing",
      injectedPaths: [], estimatedTokens: 0, wasReferenced: 0, turnIndex: 0, queryText: "p",
    });
    const j = job({ usageId });
    const real = store.updateUsageInjection;
    store.updateUsageInjection = () => { throw new Error("SQLITE_BUSY (simulated)"); };
    const r1 = applySurfacingBookkeeping(store, j);
    store.updateUsageInjection = real;
    // The update failed WITHOUT a settled outcome — event units were
    // DEFERRED, not run (pre-t63 they committed unlinked and completed,
    // making later linkage impossible).
    expect(r1.usageLinked).toBeUndefined();
    expect(r1.completedUnits).toEqual([]);
    expect(new Set(r1.failedUnits)).toEqual(new Set(["update", "general"]));
    expect((store.db.prepare("SELECT COUNT(*) c FROM recall_events WHERE session_id = 'bk-s1'").get() as { c: number }).c).toBe(0);
    // Pass 2 — the retry the drainer would run.
    const r2 = applySurfacingBookkeeping(store, { ...j, completedUnits: r1.completedUnits });
    expect(r2.failedUnits).toEqual([]);
    expect(r2.usageLinked).toBe(true);
    const ev = store.db.prepare("SELECT usage_id FROM recall_events WHERE session_id = 'bk-s1'").all() as { usage_id: number | null }[];
    expect(ev.length).toBe(1);
    expect(ev[0]!.usage_id).toBe(usageId); // LINKED — the whole point of the deferral
  });
});

describe("t63 F62-2: tagged unit namespace — vault names cannot collide with reserved units", () => {
  it("a vault literally named \"update\" is admissible and its unit is NOT skipped when the update unit completes", () => {
    const vaultDir = mkdtempSync(join(tmpdir(), "clawmem-vaultname-"));
    const vaultStore = createStore(join(vaultDir, "u.sqlite"));
    try {
      seedDocuments(vaultStore, [{ path: "m/u.md", title: "u doc", body: "collision namespace content" }]);
      const usageId = store.insertUsage({
        sessionId: "bk-s1", timestamp: new Date().toISOString(), hookName: "context-surfacing",
        injectedPaths: [], estimatedTokens: 0, wasReferenced: 0, turnIndex: 0, queryText: "p",
      });
      const j = job({
        usageId,
        vaults: [{ vault: "update", docs: [{ displayPath: "test/m/u.md", searchScore: 0.5 }] }],
      });
      expect(validateSurfacingBookkeepingJob(j)).toBe(true);
      const r = applySurfacingBookkeeping(store, j, { resolveVaultStore: () => vaultStore });
      // Pre-t63 the vault unit key WAS "update" — completing the reserved
      // update unit marked the vault unit done and it never ran.
      expect(r.completedUnits).toContain("vault:update");
      expect((vaultStore.db.prepare("SELECT COUNT(*) c FROM context_usage WHERE session_id = 'bk-s1'").get() as { c: number }).c).toBe(1);
      expect((vaultStore.db.prepare("SELECT COUNT(*) c FROM recall_events WHERE session_id = 'bk-s1'").get() as { c: number }).c).toBe(1);
    } finally {
      vaultStore.close();
      rmSync(vaultDir, { recursive: true, force: true });
    }
  });
});
