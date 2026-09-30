/**
 * 62.1 D7 (CM-19): relation weights are clamped on write and on every read.
 *
 * Baseline (8e2579a): `insertRelation` upserts `weight = weight + excluded.weight`, so a pair re-inserted on every
 * Stop grows without bound (live: usage edges up to 8,930), and every reader uses the raw weight. Each test below
 * asserts the correct result, which the baseline gets wrong.
 */
import { describe, it, expect } from "bun:test";
import { createTestStore, seedDocuments } from "../helpers/test-store.ts";
import { createMockLLM } from "../helpers/mock-llm.ts";
import type { Store } from "../../src/store.ts";
import { adaptiveTraversal, mpfpTraversal } from "../../src/graph-traversal.ts";
import { buildSourceRelationContext } from "../../src/deductive-guardrails.ts";
import { fetchRelationSnippets } from "../../src/hooks/context-surfacing.ts";
import { evolveMemories } from "../../src/amem.ts";

function weightOf(store: Store, from: number, to: number, type: string): number | null {
  const row = store.db.prepare(
    `SELECT weight FROM memory_relations WHERE source_id = ? AND target_id = ? AND relation_type = ?`
  ).get(from, to, type) as { weight: number | null } | undefined;
  return row ? row.weight : null;
}

/** A pre-upgrade row as the baseline left it: inserted raw, weight far above 1. */
function insertLegacyEdge(store: Store, from: number, to: number, type: string, weight: number, createdAt: string): void {
  store.db.prepare(
    `INSERT INTO memory_relations (source_id, target_id, relation_type, weight, created_at) VALUES (?, ?, ?, ?, ?)`
  ).run(from, to, type, weight, createdAt);
}

function hashOf(store: Store, id: number): string {
  return (store.db.prepare(`SELECT hash FROM documents WHERE id = ?`).get(id) as { hash: string }).hash;
}

describe("D7 insertRelation clamps and never sums", () => {
  it("re-inserting a pair keeps 1.0 (baseline sums to 2.0)", () => {
    const store = createTestStore();
    const [a, b] = seedDocuments(store, [
      { path: "a.md", title: "Doc A", body: "a" },
      { path: "b.md", title: "Doc B", body: "b" },
    ]) as [number, number];
    store.insertRelation(a, b, "semantic");
    store.insertRelation(a, b, "semantic");
    expect(weightOf(store, a, b, "semantic")).toBe(1.0);
  });

  it("clamps its input: > 1 → 1, < 0 → 0, non-finite → 1", () => {
    const store = createTestStore();
    const [a, b, c, d, e] = seedDocuments(store, [
      { path: "a.md", title: "A", body: "a" },
      { path: "b.md", title: "B", body: "b" },
      { path: "c.md", title: "C", body: "c" },
      { path: "d.md", title: "D", body: "d" },
      { path: "e.md", title: "E", body: "e" },
    ]) as [number, number, number, number, number];
    store.insertRelation(a, b, "semantic", 5);
    store.insertRelation(a, c, "semantic", -3);
    store.insertRelation(a, d, "semantic", Number.NaN);
    store.insertRelation(a, e, "semantic", Number.POSITIVE_INFINITY);
    expect(weightOf(store, a, b, "semantic")).toBe(1.0);
    expect(weightOf(store, a, c, "semantic")).toBe(0);
    expect(weightOf(store, a, d, "semantic")).toBe(1.0);
    expect(weightOf(store, a, e, "semantic")).toBe(1.0);
  });

  it("an upsert keeps the larger of the stored and the new weight (baseline: their sum)", () => {
    const store = createTestStore();
    const [a, b, c] = seedDocuments(store, [
      { path: "a.md", title: "A", body: "a" },
      { path: "b.md", title: "B", body: "b" },
      { path: "c.md", title: "C", body: "c" },
    ]) as [number, number, number];
    store.insertRelation(a, b, "semantic", 0.3);
    store.insertRelation(a, b, "semantic", 0.8);
    store.insertRelation(a, c, "semantic", 0.8);
    store.insertRelation(a, c, "semantic", 0.3);
    expect(weightOf(store, a, b, "semantic")).toBeCloseTo(0.8, 10);
    expect(weightOf(store, a, c, "semantic")).toBeCloseTo(0.8, 10);
  });

  it("an upsert over a legacy weight above 1 leaves at most 1.0", () => {
    const store = createTestStore();
    const [a, b] = seedDocuments(store, [
      { path: "a.md", title: "A", body: "a" },
      { path: "b.md", title: "B", body: "b" },
    ]) as [number, number];
    insertLegacyEdge(store, a, b, "semantic", 8931, "2026-01-01T00:00:00.000Z");
    store.insertRelation(a, b, "semantic", 0.5);
    expect(weightOf(store, a, b, "semantic")).toBe(1.0);
  });
});

describe("D7 every weight reader clamps a legacy weight", () => {
  it("adaptiveTraversal scores a neighbour with the clamped weight (graph-traversal neighbour query)", () => {
    const store = createTestStore();
    const [a, b, c] = seedDocuments(store, [
      { path: "a.md", title: "Anchor", body: "a" },
      { path: "b.md", title: "Legacy neighbour", body: "b" },
      { path: "c.md", title: "Ordinary neighbour", body: "c" },
    ]) as [number, number, number];
    insertLegacyEdge(store, a, b, "semantic", 8931, "2026-01-01T00:00:00.000Z");
    insertLegacyEdge(store, a, c, "semantic", 0.9, "2026-01-01T00:00:00.000Z");
    store.ensureVecTable(4);   // no embeddings stored: semantic affinity 0 for every neighbour
    const nodes = adaptiveTraversal(store.db, [{ hash: hashOf(store, a), score: 1 }], {
      maxDepth: 1, beamWidth: 5, budget: 10, intent: "WHAT", queryEmbedding: [],
    });
    const legacy = nodes.find(n => n.docId === b)!;
    const ordinary = nodes.find(n => n.docId === c)!;
    // score = 0.9·anchor + exp(0.6·structure)·weight: with the weight clamped to 1.0 the two neighbours differ only
    // by the 1.0 : 0.9 weight ratio, never by the raw 8931 : 0.9 one.
    const transition = (legacy.score - 0.9) / 1.0;
    expect(legacy.score).toBeLessThan(1000);
    expect(ordinary.score).toBeCloseTo(0.9 + transition * 0.9, 6);
  });

  it("mpfpTraversal propagates mass by the clamped weight (graph-traversal edge batch)", () => {
    const store = createTestStore();
    const [a, b, c] = seedDocuments(store, [
      { path: "a.md", title: "Anchor", body: "a" },
      { path: "b.md", title: "Legacy neighbour", body: "b" },
      { path: "c.md", title: "Ordinary neighbour", body: "c" },
    ]) as [number, number, number];
    insertLegacyEdge(store, a, b, "semantic", 8931, "2026-01-01T00:00:00.000Z");
    insertLegacyEdge(store, a, c, "semantic", 0.9, "2026-01-01T00:00:00.000Z");
    const nodes = mpfpTraversal(store.db, [{ hash: hashOf(store, a), score: 1 }], "WHAT", 30);
    const legacy = nodes.find(n => n.docId === b)?.score ?? 0;
    const ordinary = nodes.find(n => n.docId === c)?.score ?? 0;
    // Clamped: shares 1.0 : 0.9. Raw: 8931 : 0.9, which starves the ordinary neighbour below the result threshold.
    expect(legacy).toBeGreaterThan(0);
    expect(ordinary / legacy).toBeGreaterThan(0.8);
  });

  it("buildSourceRelationContext renders the clamped weight (deductive guardrails)", () => {
    const store = createTestStore();
    const [a, b] = seedDocuments(store, [
      { path: "a.md", title: "A", body: "a" },
      { path: "b.md", title: "B", body: "b" },
    ]) as [number, number];
    insertLegacyEdge(store, a, b, "semantic", 8931, "2026-01-01T00:00:00.000Z");
    const text = buildSourceRelationContext(store, [a, b]);
    expect(text).toContain("w=1.00");
    expect(text).not.toContain("8931");
  });

  it("fetchRelationSnippets orders by the clamped weight, then recency (context-surfacing)", () => {
    const store = createTestStore();
    const [a, b, c] = seedDocuments(store, [
      { path: "a.md", title: "Anchor document", body: "a" },
      { path: "b.md", title: "Older inflated target", body: "b" },
      { path: "c.md", title: "Newer target", body: "c" },
    ]) as [number, number, number];
    insertLegacyEdge(store, a, b, "semantic", 1.5, "2026-01-01T00:00:00.000Z");
    insertLegacyEdge(store, a, c, "semantic", 1.0, "2026-06-01T00:00:00.000Z");
    const snippets = fetchRelationSnippets(store, [a, b, c], 1);
    // Clamped, both edges weigh 1.0 and the newer one wins the tie; raw, the 1.5 edge wins.
    expect(snippets).toHaveLength(1);
    expect(snippets[0]!.targetTitle ?? (snippets[0] as any).target_title).toBe("Newer target");
  });

  it("evolveMemories shows the clamped neighbour confidence (A-MEM neighbour query)", async () => {
    const store = createTestStore();
    const [memId, nbId] = seedDocuments(store, [
      { path: "mem.md", title: "Memory A", body: "memory body" },
      { path: "nb.md", title: "Neighbor B", body: "neighbor body" },
    ]) as [number, number];
    store.db.prepare("UPDATE documents SET amem_context = ?, amem_keywords = ?, amem_tags = ? WHERE id = ?")
      .run("Original context.", '["orig"]', '["old-tag"]', memId);
    store.db.prepare("UPDATE documents SET amem_context = ? WHERE id = ?").run("Neighbor context.", nbId);
    insertLegacyEdge(store, memId, nbId, "related", 8931, "2026-01-01T00:00:00.000Z");
    const llm = createMockLLM();
    llm.generate.mockResolvedValue({
      text: JSON.stringify({ should_evolve: false, new_keywords: [], new_tags: [], new_context: "", reasoning: "none" }),
      model: "mock",
      done: true,
    });
    await evolveMemories(store, llm as any, memId, nbId);
    const prompt = llm.generate.mock.calls[0]?.[0] as string;
    expect(prompt).toContain("conf=1.00");
    expect(prompt).not.toContain("conf=8931.00");
  });
});
