/**
 * The in-process reranker's cache namespace carries LOCAL_RERANK_SCORE_REV
 * (issue #26). node-llama-cpp 3.15.1 squeezed Qwen3 reranker scores into about
 * 0.50-0.73 through a second sigmoid; 3.20 returns the probability itself. A
 * v0.38 install cached local scores under "local:<model>", so without the
 * revision those old-scale scores would keep serving after the upgrade and mix
 * with new ones in a single ranking.
 */
import { describe, test, expect } from "bun:test";
import { rerankProviderNamespace, rerankCacheKey, LOCAL_RERANK_SCORE_REV } from "../../src/store.ts";

describe("local rerank cache namespace carries the local score revision", () => {
  test("the namespace names the revision; the pre-3.20 key never matches", () => {
    const model = "qwen3-reranker-0.6b";
    const ns = rerankProviderNamespace("local", model);
    expect(LOCAL_RERANK_SCORE_REV).toBeGreaterThanOrEqual(2);
    expect(ns).toBe(`local:${model}#score-rev${LOCAL_RERANK_SCORE_REV}`);
    const today = rerankCacheKey("q", "a.md", model, "body", ns!);
    const v038 = rerankCacheKey("q", "a.md", model, "body", `local:${model}`);
    expect(today).not.toBe(v038);
  });
});
