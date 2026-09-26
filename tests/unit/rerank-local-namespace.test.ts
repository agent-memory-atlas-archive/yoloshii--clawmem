/**
 * The in-process reranker's cache namespace carries LOCAL_RERANK_SCORE_REV
 * (issue #26). node-llama-cpp 3.15.1 squeezed Qwen3 reranker scores into about
 * 0.50-0.73 through a second sigmoid; 3.20 returns the probability itself. A
 * v0.38 install cached local scores under "local:<model>", so without the
 * revision those old-scale scores would keep serving after the upgrade and mix
 * with new ones in a single ranking.
 */
import { describe, test, expect, afterEach } from "bun:test";
import {
  createStore,
  getCachedResult,
  rerankProviderNamespace,
  rerankCacheKey,
  writeRerankProviderFingerprint,
  LOCAL_RERANK_SCORE_REV,
  REMOTE_RERANK_NAMESPACE_REV,
} from "../../src/store.ts";
import { setDefaultLlamaCpp } from "../../src/llm.ts";

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

describe("an attested endpoint that fails: the local fallback never caches under its namespace", () => {
  const saved = { url: process.env.CLAWMEM_RERANK_URL, pid: process.env.CLAWMEM_RERANK_PROVIDER_ID, fetch: globalThis.fetch };
  afterEach(() => {
    if (saved.url === undefined) delete process.env.CLAWMEM_RERANK_URL; else process.env.CLAWMEM_RERANK_URL = saved.url;
    if (saved.pid === undefined) delete process.env.CLAWMEM_RERANK_PROVIDER_ID; else process.env.CLAWMEM_RERANK_PROVIDER_ID = saved.pid;
    globalThis.fetch = saved.fetch;
    setDefaultLlamaCpp(null);
  });

  test("the remote namespace carries its revision, so a v0.38 remote key never matches", () => {
    const url = "http://rerank-a.test:8090";
    process.env.CLAWMEM_RERANK_URL = url;
    delete process.env.CLAWMEM_RERANK_PROVIDER_ID;
    const st = createStore(":memory:");
    writeRerankProviderFingerprint(st.db, url, "behavioral:testfixture0000");
    const ns = rerankProviderNamespace("remote", "m", st.db);
    expect(REMOTE_RERANK_NAMESPACE_REV).toBeGreaterThanOrEqual(2);
    expect(ns).toBe(`remote:${url}#behavioral:testfixture0000#ns-rev${REMOTE_RERANK_NAMESPACE_REV}`);
    expect(rerankCacheKey("q", "a.md", "m", "body", ns!)).not.toBe(
      rerankCacheKey("q", "a.md", "m", "body", `remote:${url}#behavioral:testfixture0000`),
    );
  });

  test("endpoint down → the local fallback scores → nothing lands under the endpoint's key → the next healthy call scores live", async () => {
    const url = "http://rerank-down.test:8090";
    process.env.CLAWMEM_RERANK_URL = url;
    delete process.env.CLAWMEM_RERANK_PROVIDER_ID;
    const st = createStore(":memory:");
    writeRerankProviderFingerprint(st.db, url, "behavioral:testfixture0000");
    const remoteNs = rerankProviderNamespace("remote", "m", st.db);
    expect(remoteNs).not.toBeNull();
    let localCalls = 0;
    setDefaultLlamaCpp({
      rerank: async (_q: string, docs: { file: string }[]) => {
        localCalls++;
        return { results: docs.map((d) => ({ file: d.file, score: 0.42 })) };
      },
    } as never);
    globalThis.fetch = (async () => { throw new TypeError("fetch failed: ECONNREFUSED"); }) as unknown as typeof fetch;
    const doc = [{ file: "notes/a.md", text: "a body the local fallback scored" }];
    const first = await st.rerank("q", doc, "m");
    expect(localCalls).toBe(1);
    expect(first[0]!.score).toBeCloseTo(0.42, 5);
    expect(getCachedResult(st.db, rerankCacheKey("q", "notes/a.md", "m", doc[0]!.text, remoteNs!))).toBeNull();

    let remoteCalls = 0;
    globalThis.fetch = (async (_u: string | URL | Request, init?: RequestInit) => {
      remoteCalls++;
      const body = JSON.parse(String(init?.body ?? "{}")) as { documents: string[] };
      return new Response(JSON.stringify({ results: body.documents.map((_d, i) => ({ index: i, relevance_score: 0.9 })) }), { status: 200 });
    }) as unknown as typeof fetch;
    const second = await st.rerank("q", doc, "m");
    expect(remoteCalls).toBe(1);
    expect(second[0]!.score).toBeCloseTo(0.9, 5);
  });
});
