/**
 * 62.1 D4: session documents rendered from items (design tests 10, 11 at the document layer).
 *
 * Baseline (8e2579a): each Stop rewrites the session's decisions document from the last 200 entries (earlier
 * decisions fall out), overwrites or dedups an antipatterns document against ANOTHER session's (merge_recent /
 * the 30-minute hash window: live, 1,912 of 1,923 antipattern bodies orphaned), and a date change mid-session starts a
 * second document.
 */
import { describe, it, expect } from "bun:test";
import { createTestStore } from "../helpers/test-store.ts";

const mod = () => import("../../src/stop-session-docs.ts");
const DAY1 = "2026-09-30T23:50:00.000Z";
const DAY2 = "2026-10-01T00:10:00.000Z";

function doc(store: ReturnType<typeof createTestStore>, path: string) {
  return store.db.prepare(
    `SELECT d.id, d.active, d.origin, d.content_type, d.revision_count, d.doc_stamp, d.title, c.doc AS body
     FROM documents d JOIN content c ON c.hash = d.hash WHERE d.collection = '_clawmem' AND d.path = ?`
  ).get(path) as { id: number; active: number; origin: string; content_type: string; revision_count: number; doc_stamp: string | null; title: string; body: string } | null;
}

describe("D4 upsertSessionDoc", () => {
  it("inserts at the canonical path, replaces the body on change (revision + 1), and leaves an unchanged render alone", async () => {
    const { upsertSessionDoc } = await mod();
    const store = createTestStore();
    const w1 = upsertSessionDoc(store.db, { sessionId: "abcd1234-sess", transcriptKey: "tk0001aaaa", kind: "decisions", title: "Decisions 2026-09-30", body: "v1", now: DAY1 });
    expect(w1).toMatchObject({ action: "inserted", path: "decisions/2026-09-30-abcd1234.md" });
    const d1 = doc(store, "decisions/2026-09-30-abcd1234.md")!;
    expect(d1).toMatchObject({ origin: "api", content_type: "decision", revision_count: 1, body: "v1" });
    expect(d1.doc_stamp).not.toBeNull();
    expect(upsertSessionDoc(store.db, { sessionId: "abcd1234-sess", transcriptKey: "tk0001aaaa", kind: "decisions", title: "Decisions 2026-09-30", body: "v2", now: DAY1 }).action).toBe("updated");
    expect(upsertSessionDoc(store.db, { sessionId: "abcd1234-sess", transcriptKey: "tk0001aaaa", kind: "decisions", title: "Decisions 2026-09-30", body: "v2", now: DAY1 }).action).toBe("unchanged");
    expect(doc(store, "decisions/2026-09-30-abcd1234.md")!).toMatchObject({ revision_count: 2, body: "v2" });
    expect((store.db.prepare(`SELECT COALESCE(SUM(count), 0) AS n FROM legacy_writer_log`).get() as { n: number }).n).toBe(0);
  });

  it("a session crossing midnight keeps its first path (test 10)", async () => {
    const { upsertSessionDoc } = await mod();
    const store = createTestStore();
    upsertSessionDoc(store.db, { sessionId: "abcd1234-sess", transcriptKey: "tk", kind: "decisions", title: "t", body: "day one", now: DAY1 });
    const w = upsertSessionDoc(store.db, { sessionId: "abcd1234-sess", transcriptKey: "tk", kind: "decisions", title: "t", body: "day two", now: DAY2 });
    expect(w.path).toBe("decisions/2026-09-30-abcd1234.md");
    expect(store.db.prepare(`SELECT 1 FROM documents WHERE path LIKE 'decisions/2026-10-01%'`).get()).toBeNull();
  });

  it("a second transcript of the same session id, or a path held by a document this pipeline did not create, gets -<tk6>", async () => {
    const { upsertSessionDoc } = await mod();
    const store = createTestStore();
    upsertSessionDoc(store.db, { sessionId: "abcd1234-sess", transcriptKey: "base00key", kind: "antipatterns", title: "t", body: "base", now: DAY1 });
    const topic = upsertSessionDoc(store.db, { sessionId: "abcd1234-sess", transcriptKey: "topic1key", kind: "antipatterns", title: "t", body: "topic", now: DAY1 });
    expect(topic.path).toBe("antipatterns/2026-09-30-abcd1234-topic1.md");
    expect(doc(store, "antipatterns/2026-09-30-abcd1234.md")!.body).toBe("base");

    // A pre-upgrade document already sits at the canonical path: it is left intact.
    store.saveMemory({ collection: "_clawmem", path: "decisions/2026-09-30-ffff0000.md", title: "old", body: "pre-upgrade decisions", contentType: "decision" });
    const w = upsertSessionDoc(store.db, { sessionId: "ffff0000-sess", transcriptKey: "newkey000", kind: "decisions", title: "t", body: "new", now: DAY1 });
    expect(w.path).toBe("decisions/2026-09-30-ffff0000-newkey.md");
    expect(doc(store, "decisions/2026-09-30-ffff0000.md")!.body).toBe("pre-upgrade decisions");
  });

  it("an inactive (archived) document is not written; restoring it re-renders from its items (test 10)", async () => {
    const { upsertSessionDoc, insertStopItem, itemFingerprint, renderDecisions, reconcileSessionDocs } = await mod();
    const store = createTestStore();
    const add = (text: string, from: number) => insertStopItem(store.db, {
      sessionId: "abcd1234-sess", transcriptKey: "tk", kind: "decision", fp: itemFingerprint({ source: "regex", text, context: "" }),
      payload: { source: "regex", text, context: "" }, anchorEpoch: 0, rangeFrom: from,
    });
    add("We decided to batch the writes in groups of 500.", 0);
    const r1 = renderDecisions(store.db, "abcd1234-sess", "tk", DAY1)!;
    const w1 = upsertSessionDoc(store.db, { sessionId: "abcd1234-sess", transcriptKey: "tk", kind: "decisions", title: r1.title, body: r1.body, now: DAY1 });
    store.archiveDocuments([w1.docId!]);
    add("We decided to keep the cache on local disk.", 100);
    expect(reconcileSessionDocs(store.db, "abcd1234-sess", "tk", DAY1)).toBe(0);   // inactive: nothing written
    expect(store.restoreArchivedDocuments({ ids: [w1.docId!] })).toBe(1);
    const restored = doc(store, w1.path!)!;
    expect(restored.active).toBe(1);
    expect(restored.body).toContain("batch the writes");
    expect(restored.body).toContain("keep the cache on local disk");
  });
});

describe("D4 items and renders", () => {
  it("an exact re-emission is dropped; changed evidence is kept; items render in transcript order", async () => {
    const { insertStopItem, itemFingerprint, renderDecisions } = await mod();
    const store = createTestStore();
    const item = (title: string, facts: string[]) => ({ source: "observer", title, facts, narrative: "why", filesModified: [] });
    const ins = (payload: unknown, from: number) => insertStopItem(store.db, {
      sessionId: "s", transcriptKey: "tk", kind: "decision", fp: itemFingerprint(payload), payload, anchorEpoch: 0, rangeFrom: from,
    });
    expect(ins(item("Turn five decision", ["f5"]), 500)).toBe(true);
    expect(ins(item("Turn one decision", ["f1"]), 10)).toBe(true);
    expect(ins(item("Turn one decision", ["f1"]), 900)).toBe(false);          // exact re-emission
    expect(ins(item("Turn one  decision", ["f1"]), 900)).toBe(false);         // whitespace-only difference
    expect(ins(item("Turn one decision", ["f1", "more evidence"]), 900)).toBe(true);
    const body = renderDecisions(store.db, "s", "tk", DAY1)!.body;
    expect(body.indexOf("Turn one decision")).toBeLessThan(body.indexOf("Turn five decision"));
    expect(body).toContain("more evidence");
  });

  it("two sessions' identical antipatterns land in two documents, both intact (test 11)", async () => {
    const { insertStopItem, itemFingerprint, renderAntipatterns, upsertSessionDoc } = await mod();
    const store = createTestStore();
    for (const sid of ["aaaa1111-s", "bbbb2222-s"]) {
      const payload = { text: "Never run the migration without a backup", context: "the prod incident" };
      insertStopItem(store.db, { sessionId: sid, transcriptKey: "tk", kind: "antipattern", fp: itemFingerprint(payload), payload, anchorEpoch: 0, rangeFrom: 0 });
      const r = renderAntipatterns(store.db, sid, "tk", DAY1)!;
      upsertSessionDoc(store.db, { sessionId: sid, transcriptKey: "tk", kind: "antipatterns", title: r.title, body: r.body, now: DAY1 });
    }
    expect(doc(store, "antipatterns/2026-09-30-aaaa1111.md")!.body).toContain("- **Avoid:** Never run the migration without a backup");
    expect(doc(store, "antipatterns/2026-09-30-bbbb2222.md")!.body).toContain("- **Avoid:** Never run the migration without a backup");
  });
});
