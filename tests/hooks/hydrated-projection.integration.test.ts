/**
 * Projection-complete daemon hydration — the codex #28 t83–t88 design locks.
 *
 * The load-bearing suite is the CROSS-TOPOLOGY EQUIVALENCE LOCK (t86): the
 * full contextSurfacing pipeline runs twice on the SAME store — once with no
 * daemon (the in-process body path) and once against a live vector daemon
 * (the hydrated-v1 projection path) — and the INJECTED CONTEXT must be
 * byte-identical, along with the rerank transmit hashes and the noise/gate
 * decisions. This proves projection ≡ body-path per CONSUMER, not per
 * function.
 *
 * Also here: the t87 F4 presentationQuery fixture (prior/deep legs SEARCH
 * with different text than the current prompt — snippets must still come
 * from the prompt), the t87 F3 non-ASCII bodyLength fixture (UTF-16, never
 * UTF-8 bytes), the t87 F1 source-body ceiling (oversized → FTS, distinct
 * trace), and the t82 S1 real prior/deep per-invocation deadline records
 * with their dynamic budgets (mutation-locks on each recordVectorLegDeadline
 * call site).
 */
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { contextSurfacing } from "../../src/hooks/context-surfacing.ts";
import { newSurfacingTrace, type SurfacingTrace } from "../../src/eval/hook-trace.ts";
import { seedDocuments } from "../helpers/test-store.ts";
import {
  createStore, DEFAULT_EMBED_MODEL, DEFAULT_QUERY_MODEL, extractSnippet, hydrateVecResults,
  projectVecResults, expandQueryCacheKey, setCachedResult, type Store,
} from "../../src/store.ts";
import { sanitizeSnippet } from "../../src/promptguard.ts";
import { isRetrievedNoise } from "../../src/retrieval-gate.ts";
import { docGateTokens } from "../../src/hooks/gate-tokens.ts";
import { HYDRATED_MAX_SOURCE_BODY_BYTES, HYDRATED_SNIPPET_LENS, HYDRATED_RERANK_TEXT_LEN, HYDRATED_GATE_TEXT_LEN } from "../../src/vector-protocol.ts";
import { startVectorDaemon, type VectorDaemonHandle } from "../../src/vector-daemon.ts";
import { clearConfigCache } from "../../src/config.ts";
import { setDefaultLlamaCpp } from "../../src/llm.ts";

const PROMPT = "Explain the OAuth refresh token rotation decision we made for the auth service";
const FOLLOWUP = "Can you explain that rationale in a bit more depth please";
const PRIOR_TEXTS = [
  "What did we settle on for credential vault escrow amanuensis handling",
  "Remind me about the escrow amanuensis policy for the credential vault",
];

// 4-dim vectors; the fake embed server answers EVERY query with QUERY_VEC, so
// MATCH distance orders docs by how close their stored vector is to it.
const QUERY_VEC = new Float32Array([1, 0, 0, 0]);
const VEC_A = new Float32Array([1, 0, 0, 0]);        // oauth doc — distance 0
const VEC_B = new Float32Array([0.95, 0.3, 0, 0]);   // unicode doc
const VEC_C = new Float32Array([0.9, 0.42, 0, 0]);   // prior-topic doc
const VEC_D = new Float32Array([0.85, 0.52, 0, 0]);  // filler (rerank needs >=3)

// t87 F4 fixture body: section 1 matches the CURRENT PROMPT's vocabulary,
// section 2 matches the PRIOR turns' / forged-expansion vocabulary. If the
// daemon computed snippets from the leg's RETRIEVAL query instead of the
// presentationQuery, its snippet window would land in section 2 and the
// cross-topology byte-equality below would fail.
const PRIOR_TOPIC_BODY =
  "# Prior topic\n" +
  "OAuth refresh token rotation decision context for the auth service. The rotation decision explained here is the section the current prompt selects.\n" +
  "\n\n\n" + "x".repeat(600) + "\n\n" +
  "Credential vault escrow amanuensis handling policy. The escrow amanuensis section is what the prior turns and the forged expansion variant select.";

// Mostly-ASCII with a genuinely multibyte tail — passes the prompt-injection
// guard (a denser non-ASCII mix trips its unicode_obfuscation detector) while
// still making UTF-8 byte length differ from UTF-16 length (the t87 F3 point).
const UNICODE_BODY = "# Notes\n" + "The OAuth refresh token rotation decision for the auth service. ".repeat(8) + "žluťoučký kůň 認証 ";

function fakeEmbedServer(): { url: string; stop: () => void } {
  const srv = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    async fetch(req) {
      if (!req.url.endsWith("/v1/embeddings")) return new Response("not found", { status: 404 });
      const body = await req.json() as { input: string | string[] };
      const n = Array.isArray(body.input) ? body.input.length : 1;
      return Response.json({ object: "list", model: DEFAULT_EMBED_MODEL, data: Array.from({ length: n }, (_, i) => ({ object: "embedding", index: i, embedding: Array.from(QUERY_VEC) })) });
    },
  });
  return { url: `http://127.0.0.1:${srv.port}`, stop: () => srv.stop(true) };
}

const ENV_KEYS = ["CLAWMEM_PROFILE", "CLAWMEM_VECTOR_DAEMON_REQUIRED", "CLAWMEM_PRIOR_VECTOR_INPROC", "CLAWMEM_EMBED_URL", "CLAWMEM_LLM_URL", "CLAWMEM_RERANK_URL", "CLAWMEM_NO_LOCAL_MODELS", "XDG_RUNTIME_DIR", "CLAWMEM_SESSION_FOCUS", "CLAWMEM_HOOK_DEDUP_WINDOW_SEC"] as const;

describe("hydrated projection — cross-topology equivalence (codex #28 t83–t88)", () => {
  let scratch: string;
  let store: Store;
  let embed: ReturnType<typeof fakeEmbedServer>;
  let daemon: VectorDaemonHandle | null = null;
  const saved: Record<string, string | undefined> = {};
  let seqCounter = 0;

  beforeAll(() => {
    scratch = mkdtempSync(join(tmpdir(), "clawmem-hydra-"));
    for (const k of ENV_KEYS) saved[k] = process.env[k];
    // Private socket namespace + deterministic inference topology.
    process.env.XDG_RUNTIME_DIR = join(scratch, "xdg");
    embed = fakeEmbedServer();
    process.env.CLAWMEM_EMBED_URL = embed.url;
    process.env.CLAWMEM_LLM_URL = "http://127.0.0.1:1";
    process.env.CLAWMEM_RERANK_URL = "http://127.0.0.1:1";
    process.env.CLAWMEM_NO_LOCAL_MODELS = "true";
    // The second arm deliberately replays the first arm's prompt — disable the
    // hook_dedupe recent-duplicate gate (0 = off), exactly what a replay
    // harness needs; the gate itself is out of scope here.
    process.env.CLAWMEM_HOOK_DEDUP_WINDOW_SEC = "0";
    delete process.env.CLAWMEM_VECTOR_DAEMON_REQUIRED;
    delete process.env.CLAWMEM_SESSION_FOCUS;
    clearConfigCache();

    store = createStore(join(scratch, "vault.sqlite"));
    store.ensureVecTable(QUERY_VEC.length);
    seedDocuments(store, [
      { path: "memory/oauth-refresh-decision.md", title: "OAuth refresh token rotation decision", body: "# OAuth refresh token rotation\n\nExplain the OAuth refresh token rotation decision we made for the auth service. Rotation on every refresh, reuse detection revokes the family.", contentType: "decision", confidence: 0.9, qualityScore: 0.8 },
      { path: "memory/unicode-notes.md", title: "Vícejazyčné poznámky", body: UNICODE_BODY, contentType: "note", confidence: 0.7, qualityScore: 0.7 },
      { path: "memory/prior-topic.md", title: "Prior topic escrow notes", body: PRIOR_TOPIC_BODY, contentType: "note", confidence: 0.7, qualityScore: 0.7 },
      { path: "memory/filler.md", title: "Auth service deployment filler", body: "# Filler\n\nAuth service deployment notes about the token rotation decision rollout for the service.", contentType: "note", confidence: 0.6, qualityScore: 0.6 },
    ]);
    const vecs: [string, Float32Array][] = [
      ["memory/oauth-refresh-decision.md", VEC_A],
      ["memory/unicode-notes.md", VEC_B],
      ["memory/prior-topic.md", VEC_C],
      ["memory/filler.md", VEC_D],
    ];
    for (const [path, vec] of vecs) {
      const row = store.db.prepare(`SELECT hash FROM documents WHERE path = ? AND active = 1`).get(path) as { hash: string } | null;
      if (!row) throw new Error(`fixture: ${path} not seeded`);
      store.insertEmbedding(row.hash, 0, 0, vec, DEFAULT_EMBED_MODEL, new Date().toISOString());
    }
    // t87 F4 deep fixture: a FORGED frozen expansion — the deep leg's retrieval
    // query is this variant text (section-2 vocabulary), NOT the prompt.
    setCachedResult(store.db, expandQueryCacheKey(PROMPT, DEFAULT_QUERY_MODEL, undefined), JSON.stringify([
      { type: "vec", query: "credential vault escrow amanuensis policy" },
    ]));
  });

  afterAll(() => {
    daemon?.close();
    embed?.stop();
    store?.close();
    for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
    clearConfigCache();
    rmSync(scratch, { recursive: true, force: true });
  });

  /** Seed the SAME priors for one arm's session (the eval's insertUsage shape). */
  function seedPriors(sessionId: string): void {
    const nowMs = Date.now();
    for (let p = PRIOR_TEXTS.length - 1; p >= 0; p--) {
      store.insertUsage({
        sessionId,
        timestamp: new Date(nowMs - 2 * 60_000).toISOString(),
        hookName: "context-surfacing",
        injectedPaths: [], estimatedTokens: 0, wasReferenced: 0,
        turnIndex: PRIOR_TEXTS.length - 1 - p,
        queryText: PRIOR_TEXTS[p]!,
      });
    }
  }

  type ArmResult = { context: string; trace: SurfacingTrace };
  async function runArm(prompt: string, profile: string, opts: { daemon: boolean; priors?: boolean }): Promise<ArmResult> {
    process.env.CLAWMEM_PROFILE = profile;
    if (opts.daemon) {
      delete process.env.CLAWMEM_PRIOR_VECTOR_INPROC;
      if (!daemon) {
        daemon = await startVectorDaemon(store);
        if (!daemon) throw new Error("daemon failed to bind");
      }
    } else {
      // In-process arm: no daemon may be live (absent → today's body path), and the
      // prior leg takes its documented eval/testing in-process override.
      if (daemon) { daemon.close(); daemon = null; }
      process.env.CLAWMEM_PRIOR_VECTOR_INPROC = "1";
    }
    // Each arm starts from a clean usage ledger: the hook's pre-retrieval
    // gate refuses a RECENTLY-REPEATED prompt (gate:recent-duplicate), and the
    // second arm deliberately replays the first arm's prompt. The eval harness
    // does the same per-rep cleanup.
    store.db.exec(`DELETE FROM context_usage`);
    // The LlamaCpp SINGLETON captures CLAWMEM_EMBED_URL at first construction and
    // carries a 60s remote-embed cooldown across test FILES — earlier suite files
    // that hit dead endpoints would otherwise leave this file's fake embed server
    // unconsulted (empty scans: no deep escalation, no ceiling hit). Reset per arm
    // so each run constructs fresh from THIS file's env.
    setDefaultLlamaCpp(null);
    const sessionId = `hydra-${opts.daemon ? "d" : "i"}-${profile}-${seqCounter++}`;
    if (opts.priors) seedPriors(sessionId);
    const trace = newSurfacingTrace();
    const out = await contextSurfacing(store, { prompt, sessionId }, { trace });
    return { context: out.hookSpecificOutput?.additionalContext ?? "", trace };
  }

  /**
   * Load-robust arm pair: the legs run under REAL profile deadlines (balanced
   * 900ms), so on a busy host (the full suite) a leg can legitimately drop to
   * error/busy or miss the deep-escalation window — that is bounded-degradation
   * behavior, not what this lock certifies. The LOCK is cross-topology EQUALITY
   * on a clean pair, so retry until both arms ran every wanted leg cleanly
   * (in-process arm: absent; daemon arm: ok + hydrated-v1); the strict
   * assertions then run against that clean pair (the final attempt is returned
   * either way so a persistent failure still fails loudly).
   */
  async function armPair(prompt: string, profile: string, opts: { priors?: boolean; wantLegs: ("primary" | "prior" | "deep")[] }): Promise<{ a: ArmResult; b: ArmResult }> {
    let last: { a: ArmResult; b: ArmResult } | null = null;
    for (let attempt = 0; attempt < 6; attempt++) {
      if (attempt > 0) await new Promise(r => setTimeout(r, 300)); // let a saturated host breathe between attempts
      const a = await runArm(prompt, profile, { daemon: false, priors: opts.priors });
      const b = await runArm(prompt, profile, { daemon: true, priors: opts.priors });
      last = { a, b };
      const aLegs = a.trace.vectorLegs ?? [];
      const bLegs = b.trace.vectorLegs ?? [];
      const aClean = opts.wantLegs.every(w => aLegs.some(l => l.leg === w && l.path === "absent")) && aLegs.every(l => l.path === "absent");
      const bClean = opts.wantLegs.every(w => bLegs.some(l => l.leg === w && l.path === "ok" && l.protocol === "hydrated-v1")) && bLegs.every(l => l.path === "ok");
      if (aClean && bClean && a.context.length > 0) return last;
    }
    return last!;
  }

  it("EQUIVALENCE (primary leg + non-ASCII doc): in-process vs daemon-projected injection is byte-identical", async () => {
    const { a, b } = await armPair(PROMPT, "balanced", { wantLegs: ["primary"] });
    expect(a.context.length).toBeGreaterThan(0);
    expect(b.context).toBe(a.context); // byte-identical injected context
    // The daemon arm really ran hydrated-v1 on the primary leg.
    expect(b.trace.vectorLegs).toEqual([{ leg: "primary", path: "ok", protocol: "hydrated-v1" }]);
    expect(a.trace.vectorLegs).toEqual([{ leg: "primary", path: "absent" }]);
    // Same noise/gate outcomes.
    expect(b.trace.filters.noiseDropped).toEqual(a.trace.filters.noiseDropped);
    expect(new Set(b.trace.fusion!.lanes.map(l => l.lane))).toEqual(new Set(a.trace.fusion!.lanes.map(l => l.lane)));
  }, 30_000);

  it("EQUIVALENCE (prior leg, t87 F4): the prior leg SEARCHES with joined priors but snippets come from the CURRENT prompt", async () => {
    const { a, b } = await armPair(FOLLOWUP, "balanced", { priors: true, wantLegs: ["primary", "prior"] });
    expect(b.context).toBe(a.context);
    // Both arms ran a REAL prior vector leg (t82 S1: real-handler coverage).
    const priorLegsB = (b.trace.vectorLegs ?? []).filter(l => l.leg === "prior");
    expect(priorLegsB).toEqual([{ leg: "prior", path: "ok", protocol: "hydrated-v1" }]);
    expect((a.trace.vectorLegs ?? []).filter(l => l.leg === "prior")).toEqual([{ leg: "prior", path: "absent" }]);
    // The t87 F4 fixture bites: the prior-topic doc's prompt-section snippet differs
    // from its prior-section snippet, so byte-equality above proves the daemon used
    // presentationQuery. Assert the divergence is REAL (the fixture is not vacuous):
    const sanitized = sanitizeSnippet(PRIOR_TOPIC_BODY);
    const viaPrompt = extractSnippet(sanitized, FOLLOWUP, 300, 0, undefined).snippet;
    const viaPriors = extractSnippet(sanitized, PRIOR_TEXTS.join("\n\n"), 300, 0, undefined).snippet;
    expect(viaPrompt).not.toBe(viaPriors);
    // t82 S1: the prior leg recorded its per-invocation deadline with the DYNAMIC
    // budget min(400, vectorTimeout=900) = 400 (mutation-lock on the prior call site).
    const priorDl = (b.trace.vectorLegDeadlines ?? []).filter(d => d.leg === "prior");
    expect(priorDl.length).toBe(1);
    expect(priorDl[0]!.budget_ms).toBeGreaterThan(300);
    // + float noise: budget_ms = (started + 400) − started on performance.now() instants, and the
    // addition rounds — observed 400.0000000000582 (half an ulp at ~5.4e5 ms uptime). 1e-6 still
    // tells 400 from 900.
    expect(priorDl[0]!.budget_ms).toBeLessThanOrEqual(400 + 1e-6);
    expect(priorDl[0]!.over_ms).toBeLessThanOrEqual(150);
  }, 30_000);

  it("EQUIVALENCE (deep profile: expansion legs + rerank transmit): forged vec variant searches section-2 text, snippets stay on the prompt; sentTextHashes identical", async () => {
    const { a, b } = await armPair(PROMPT, "deep", { wantLegs: ["primary", "deep"] });
    expect(b.context).toBe(a.context);
    // Deep legs really ran (the forged frozen expansion has one vec variant) and
    // were daemon-projected in arm B (t82 S1 deep coverage + mutation-lock).
    const deepB = (b.trace.vectorLegs ?? []).filter(l => l.leg === "deep");
    expect(deepB).toEqual([{ leg: "deep", path: "ok", protocol: "hydrated-v1" }]);
    const deepDl = (b.trace.vectorLegDeadlines ?? []).filter(d => d.leg === "deep");
    expect(deepDl.length).toBe(1);
    expect(deepDl[0]!.budget_ms).toBeGreaterThan(0);
    // Primary deadline entry exists too, with the profile's dynamic budget.
    const primDl = (b.trace.vectorLegDeadlines ?? []).filter(d => d.leg === "primary");
    expect(primDl.length).toBe(1);
    expect(primDl[0]!.budget_ms).toBeGreaterThan(0);
    // Rerank transmit identity (site context-surfacing.ts:781): the ATTEMPT records
    // the transmitted-text hashes before the (unreachable) reranker fails — identical
    // hashes across arms prove rerankText === body.slice(0, 2000) byte-for-byte.
    expect(b.trace.rerank?.attempted).toBe(true);
    expect(a.trace.rerank?.attempted).toBe(true);
    expect(b.trace.rerank!.sentTextHashes).toEqual(a.trace.rerank!.sentTextHashes);
    expect(b.trace.rerank!.sentPaths).toEqual(a.trace.rerank!.sentPaths);
  }, 30_000);

  it("DIRECT projection ≡ hydration per field — non-ASCII bodyLength stays UTF-16 (t87 F3)", () => {
    const row = store.db.prepare(`SELECT hash FROM documents WHERE path = ? AND active = 1`).get("memory/unicode-notes.md") as { hash: string };
    const hits = [{ hash_seq: `${row.hash}_0`, distance: 0.25 }];
    const hyd = hydrateVecResults(store.db, hits, 10);
    const proj = projectVecResults(store.db, hits, {
      limit: 10, presentationQuery: PROMPT, intent: undefined,
      snippetLens: [...HYDRATED_SNIPPET_LENS], rerankTextLen: HYDRATED_RERANK_TEXT_LEN, gateTextLen: HYDRATED_GATE_TEXT_LEN,
      maxSourceBodyBytes: HYDRATED_MAX_SOURCE_BODY_BYTES,
    });
    expect(hyd.length).toBe(1);
    expect(proj.length).toBe(1);
    const h = hyd[0]!, p = proj[0]!;
    const body = h.body!;
    // Non-ASCII is the point: UTF-8 byte length differs from UTF-16 length.
    expect(Buffer.byteLength(body, "utf-8")).not.toBe(body.length);
    expect(p.bodyLength).toBe(body.length);          // UTF-16, byte-identical to hydration
    expect(p.bodyLength).toBe(h.bodyLength);
    for (const k of ["filepath", "displayPath", "title", "hash", "docid", "collectionName", "modifiedAt", "score", "chunkPos", "fragmentType", "fragmentLabel", "context"] as const) {
      expect(p[k]).toEqual(h[k]);
    }
    const sanitized = sanitizeSnippet(body);
    for (const len of HYDRATED_SNIPPET_LENS) {
      expect(p.snippets[len]).toBe(extractSnippet(sanitized, PROMPT, len, h.chunkPos, undefined).snippet);
    }
    expect(p.rerankText).toBe(body.slice(0, HYDRATED_RERANK_TEXT_LEN));
    expect(p.noise).toBe(isRetrievedNoise(body));
    expect(p.hasBody).toBe(true);
    expect(p.gateTokens).toEqual(docGateTokens(h.title, body, HYDRATED_GATE_TEXT_LEN));
    expect(p.sanitizeFiltered).toBe(false);
  });

  it("SOURCE-BODY CEILING (t87 F1): a stored body over the 4 MiB ceiling is refused pre-fetch → oversized → FTS fallback, traced distinctly", async () => {
    // Own store so the giant doc cannot leak into the equivalence fixtures.
    const dir = mkdtempSync(join(scratch, "big-"));
    const big = createStore(join(dir, "big.sqlite"));
    big.ensureVecTable(QUERY_VEC.length);
    // Full prompt sentence so the FTS fallback (AND semantics over the prompt's
    // tokens) can actually hit this doc after the vector leg is refused.
    const giant = "# Giant\n\n" + "Explain the OAuth refresh token rotation decision we made for the auth service. ".repeat(60_000); // ~4.7 MB > 4 MiB ceiling
    seedDocuments(big, [
      { path: "memory/giant.md", title: "Giant OAuth notes", body: giant, contentType: "note", confidence: 0.7, qualityScore: 0.7 },
    ]);
    const row = big.db.prepare(`SELECT hash FROM documents WHERE path = ? AND active = 1`).get("memory/giant.md") as { hash: string };
    big.insertEmbedding(row.hash, 0, 0, VEC_A, DEFAULT_EMBED_MODEL, new Date().toISOString());
    const d2 = await startVectorDaemon(big);
    if (!d2) throw new Error("daemon failed to bind");
    try {
      process.env.CLAWMEM_PROFILE = "balanced";
      // Load robustness: on a busy host the query embed can miss the 900ms leg
      // deadline (empty scan → an ok-hydrated EMPTY response, no ceiling hit) or
      // the leg can time out — retry until the scan genuinely reached the
      // ceiling; the assertions then run on that attempt.
      setDefaultLlamaCpp(null); // fresh singleton: this file's embed URL, zero inherited cooldowns
      let trace = newSurfacingTrace();
      let out = await contextSurfacing(big, { prompt: PROMPT, sessionId: "hydra-big-0" }, { trace });
      for (let attempt = 1; attempt < 6 && (trace.vectorLegs ?? [])[0]?.path !== "oversized"; attempt++) {
        await new Promise(r => setTimeout(r, 300)); // let a saturated host breathe between attempts
        setDefaultLlamaCpp(null);
        trace = newSurfacingTrace();
        out = await contextSurfacing(big, { prompt: PROMPT, sessionId: `hydra-big-${attempt}` }, { trace });
      }
      expect(trace.vectorLegs).toEqual([{ leg: "primary", path: "oversized" }]);
      // FTS carried the turn — graceful degradation with vector-candidate loss.
      const lanes = new Set(trace.fusion!.lanes.map(l => l.lane));
      expect(lanes.has("vector")).toBe(false);
      expect(lanes.has("fts-fallback")).toBe(true);
      expect(out.hookSpecificOutput?.additionalContext ?? "").toContain("Giant");
    } finally {
      d2.close();
      big.close();
    }
  }, 30_000);
});
