/**
 * 62.1 D3/D4: the observer's status-returning form (design tests 7, 8 at the observer layer).
 *
 * Baseline (8e2579a): `extractObservations` returns [] below 4 messages AND on every failure (`parsed ?? []`,
 * `withRetryAndFeedback` → null), so a Stop cannot tell "nothing to record" from "the model was down" — a failed
 * turn is silently committed as empty and never retried. An empty completion ("output nothing", as the prompt asks)
 * is itself treated as an error and retried.
 */
import { describe, it, expect, afterEach } from "bun:test";
import { setDefaultLlamaCpp } from "../../src/llm.ts";

const obsMod = () => import("../../src/observer.ts");

function fakeLlm(responses: (string | null)[]) {
  const prompts: string[] = [];
  let i = 0;
  const llm = {
    generate: async (prompt: string) => {
      prompts.push(prompt);
      const r = responses[Math.min(i++, responses.length - 1)];
      return r === null ? null : { text: r, model: "fake", done: true };
    },
  };
  setDefaultLlamaCpp(llm as any);
  return prompts;
}
afterEach(() => setDefaultLlamaCpp(null));

const OBS = `<observation><type>decision</type><title>Batch writes in the ingest pipeline</title>
<facts><fact>The ingest pipeline batches writes in groups of 500</fact></facts>
<narrative>Batching cuts fsync cost.</narrative></observation>`;
const msgs = [
  { role: "user" as const, content: "should we batch the writes?" },
  { role: "assistant" as const, content: "Yes, batch them in groups of 500 to cut fsync cost." },
];

describe("D3 extractObservationsResult", () => {
  it("ok: parsed observations, with no minimum message count (admission is the caller's)", async () => {
    const { extractObservationsResult } = await obsMod();
    fakeLlm([OBS]);
    const r = await extractObservationsResult(msgs);
    expect(r.status).toBe("ok");
    if (r.status === "ok") expect(r.observations.map(o => o.title)).toEqual(["Batch writes in the ingest pipeline"]);
  });

  it("empty: an empty completion or a short plain 'nothing' is a valid answer, not a failure", async () => {
    const { extractObservationsResult } = await obsMod();
    let prompts = fakeLlm([""]);
    expect((await extractObservationsResult(msgs)).status).toBe("empty");
    expect(prompts.length).toBe(1);   // accepted at once, never retried
    prompts = fakeLlm(["No significant observations."]);
    expect((await extractObservationsResult(msgs)).status).toBe("empty");
    expect(prompts.length).toBe(1);
  });

  it("retryable: the model unavailable, or output that never parses, is reported as such (never as empty)", async () => {
    const { extractObservationsResult } = await obsMod();
    fakeLlm([null]);
    const down = await extractObservationsResult(msgs);
    expect(down.status).toBe("retryable");
    if (down.status === "retryable") expect(down.reason).toContain("unavailable");
    fakeLlm(["<observation><type>bogus</type></observation>"]);
    expect((await extractObservationsResult(msgs)).status).toBe("retryable");
  });

  it("the CONTEXT section carries prior turns and recorded titles, marked as already recorded", async () => {
    const { extractObservationsResult } = await obsMod();
    const prompts = fakeLlm([""]);
    await extractObservationsResult(msgs, {
      context: { priorMessages: [{ role: "user", content: "earlier question about caching" }], recordedTitles: ["Cache keys use sha256"] },
    });
    const p = prompts[0]!;
    expect(p).toContain("CONTEXT (already recorded — do not extract)");
    expect(p).toContain("earlier question about caching");
    expect(p).toContain("Cache keys use sha256");
    expect(p.indexOf("CONTEXT (already recorded")).toBeLessThan(p.indexOf("should we batch the writes?"));
  });
});

describe("D4 observerRenderChars (batch packing)", () => {
  it("measures a batch the way the observer renders it: per-message caps, one line each", async () => {
    const { observerRenderChars } = await obsMod();
    const small = observerRenderChars([{ role: "user", content: "hi" }]);
    expect(small).toBe("[user]: hi".length + 1);
    const long = observerRenderChars([{ role: "assistant", content: "x".repeat(5000) }]);
    expect(long).toBeLessThan(5000);   // capped like prepareTranscript caps it
  });
});
