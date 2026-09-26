/**
 * Hook replay-eval gold loader — strictness contract (BUILD-0).
 * Any malformed line, unknown field, duplicate id, or label contradiction
 * fails the whole load; a silently dropped case would corrupt the metric.
 */
import { describe, it, expect } from "bun:test";
import { mkdtempSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { parseHookGoldFile, HookGoldFileError } from "../../src/eval/hook-gold.ts";

const dir = mkdtempSync(join(tmpdir(), "hook-gold-"));
let fileNo = 0;
function goldFile(lines: unknown[]): string {
  const p = join(dir, `gold-${fileNo++}.jsonl`);
  writeFileSync(p, lines.map(l => (typeof l === "string" ? l : JSON.stringify(l))).join("\n") + "\n");
  return p;
}

const VALID = {
  id: "hk-001",
  prompt: "Explain the OAuth refresh token rotation decision we made",
  priors: [{ text: "prior turn about oauth", age_minutes: 2 }],
  profile: "balanced",
  expect_abstain: false,
  prior_leg: "harmless",
  labels: { must_include: ["test/oauth.md"], acceptable: ["test/tokens.md"], must_not_include: ["test/seo.md"] },
  split: "tuning",
  tags: ["multi-turn"],
};

describe("hook gold loader — strictness", () => {
  it("parses a valid file with defaults applied", () => {
    const noPriors = { ...VALID, id: "hk-002", priors: undefined, prior_leg: undefined };
    delete (noPriors as Record<string, unknown>).priors;
    delete (noPriors as Record<string, unknown>).prior_leg;
    const examples = parseHookGoldFile(goldFile([VALID, noPriors]));
    expect(examples).toHaveLength(2);
    expect(examples[0]!.priors).toHaveLength(1);
    expect(examples[0]!.prior_leg).toBe("harmless");
    // priors-free case defaults prior_leg to "forbidden"
    expect(examples[1]!.priors).toHaveLength(0);
    expect(examples[1]!.prior_leg).toBe("forbidden");
  });

  it("fails on an unknown top-level field", () => {
    expect(() => parseHookGoldFile(goldFile([{ ...VALID, promt: "typo" }]))).toThrow(HookGoldFileError);
  });

  it("fails on a duplicate id", () => {
    expect(() => parseHookGoldFile(goldFile([VALID, VALID]))).toThrow(/duplicate id/);
  });

  it("fails when one document carries two labels", () => {
    const bad = { ...VALID, id: "hk-x", labels: { must_include: ["test/a.md"], must_not_include: ["test/a.md"] } };
    expect(() => parseHookGoldFile(goldFile([bad]))).toThrow(/labeled both/);
  });

  it("fails when expect_abstain contradicts must_include", () => {
    const bad = { ...VALID, id: "hk-x", expect_abstain: true };
    expect(() => parseHookGoldFile(goldFile([bad]))).toThrow(/expect_abstain/);
  });

  it("fails on a missing split", () => {
    const bad = { ...VALID, id: "hk-x" } as Record<string, unknown>;
    delete bad.split;
    expect(() => parseHookGoldFile(goldFile([bad]))).toThrow(/split/);
  });

  it("fails when prior_leg is omitted on a case WITH priors", () => {
    const bad = { ...VALID, id: "hk-x" } as Record<string, unknown>;
    delete bad.prior_leg;
    expect(() => parseHookGoldFile(goldFile([bad]))).toThrow(/prior_leg/);
  });

  it("fails on a negative prior age", () => {
    const bad = { ...VALID, id: "hk-x", priors: [{ text: "p", age_minutes: -1 }] };
    expect(() => parseHookGoldFile(goldFile([bad]))).toThrow(/age_minutes/);
  });

  it("fails on invalid JSON and on an empty file", () => {
    expect(() => parseHookGoldFile(goldFile(["{not json"]))).toThrow(/invalid JSON/);
    expect(() => parseHookGoldFile(goldFile([""]))).toThrow(/empty/);
  });

  it("fails on an unknown profile", () => {
    const bad = { ...VALID, id: "hk-x", profile: "turbo" };
    expect(() => parseHookGoldFile(goldFile([bad]))).toThrow(/profile/);
  });
});
