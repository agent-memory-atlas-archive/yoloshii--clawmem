/**
 * Live-model reranker contract (node-llama-cpp >= 3.20.0, issue #26 follow-up).
 *
 * 3.15.1 applied a sigmoid to Qwen3 reranker outputs that the model had
 * already normalized, compressing every score into ~[0.50, 0.73]. 3.20.0
 * returns the true probability. ClawMem blends rerank scores into ranking,
 * so the contract this pins is: finite scores in [0, 1], the relevant
 * document first, and a real spread between relevant and irrelevant.
 *
 * Needs the cached reranker GGUF (~640 MB). Skips when it is absent, so an
 * ordinary `bun test` never downloads a model; the release gate runs it with
 * the model provisioned (see docs/guides/upgrading.md, release checklist).
 * Assertions are tolerant on purpose — semantic, not bit-exact.
 */
import { describe, test, expect } from "bun:test";
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const MODEL_DIR = join(homedir(), ".cache", "qmd", "models");
const modelFile = existsSync(MODEL_DIR)
  ? readdirSync(MODEL_DIR).find((f) => /qwen3-reranker/i.test(f) && f.endsWith(".gguf"))
  : undefined;
const live = Boolean(modelFile) && process.env.CLAWMEM_NO_LOCAL_MODELS !== "true";

describe("live Qwen3 reranker scores (node-llama-cpp >= 3.20.0)", () => {
  test.skipIf(!live)("scores are probabilities: finite, in [0,1], relevant doc first, spread > 0.5", async () => {
    const m = await import("node-llama-cpp");
    const llama = await m.getLlama({ logLevel: m.LlamaLogLevel.error, gpu: false });
    const model = await llama.loadModel({ modelPath: join(MODEL_DIR, modelFile!) });
    const ctx = await model.createRankingContext();
    try {
      const docs = [
        "The Eiffel Tower is in Paris.",
        "OpenClaw memory plugins register with kind memory and declare their tools in the manifest.",
        "Bananas are yellow fruit.",
      ];
      const ranked = await ctx.rankAndSort("how do openclaw memory plugins register", docs);
      expect(ranked.length).toBe(docs.length);
      for (const r of ranked) {
        expect(Number.isFinite(r.score)).toBe(true);
        expect(r.score).toBeGreaterThanOrEqual(0);
        expect(r.score).toBeLessThanOrEqual(1);
      }
      const first = ranked[0]!;
      const last = ranked[ranked.length - 1]!;
      expect(first.document).toBe(docs[1]!);
      const spread = first.score - last.score;
      // 3.15.1's double sigmoid could never exceed ~0.23 here; the true
      // probability scale gives well over 0.5 for this contrast.
      expect(spread).toBeGreaterThan(0.5);
    } finally {
      await ctx.dispose();
      await model.dispose();
      await llama.dispose();
    }
  }, 120_000);
});
