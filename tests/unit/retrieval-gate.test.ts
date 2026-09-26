import { describe, it, expect } from "bun:test";

/**
 * Retrieval gate — force-intent contract (§51.5).
 *
 * FORCE_RETRIEVE_PATTERNS are documented "(checked before skip)". That must
 * hold inside shouldSkipRetrieval AND be independently consumable by
 * context-surfacing's own gates via hasForceRetrieveIntent — the §51.5 bug was
 * the hook's MIN_PROMPT_LENGTH return firing before the gate ever ran.
 */

import { hasForceRetrieveIntent, shouldSkipRetrieval } from "../../src/retrieval-gate.ts";

describe("hasForceRetrieveIntent", () => {
  it("matches every force family", () => {
    expect(hasForceRetrieveIntent("remember the plan")).toBe(true);      // memory verb
    expect(hasForceRetrieveIntent("last time we met")).toBe(true);       // temporal ref
    expect(hasForceRetrieveIntent("what's my email?")).toBe(true);       // personal data
    expect(hasForceRetrieveIntent("what did I say?")).toBe(true);        // did-i family
  });

  it("does not match plain short prompts", () => {
    expect(hasForceRetrieveIntent("hello there")).toBe(false);
    expect(hasForceRetrieveIntent("run the tests")).toBe(false);
    expect(hasForceRetrieveIntent("")).toBe(false);
  });

  it("tests against the NORMALIZED prompt (cron wrapper stripped)", () => {
    expect(hasForceRetrieveIntent("[cron:daily] what did I say?")).toBe(true);
  });
});

describe("shouldSkipRetrieval — force checked before every skip", () => {
  it("a bare force term shorter than every length threshold is never skipped", () => {
    expect(shouldSkipRetrieval("recall")).toBe(false); // 6 chars — under the 15-char non-question floor
  });

  it("skip patterns still apply to non-force prompts", () => {
    expect(shouldSkipRetrieval("hi")).toBe(true);
    expect(shouldSkipRetrieval("run build")).toBe(true);
    expect(shouldSkipRetrieval("ok")).toBe(true);
  });
});

const { needsPriorContext, countContentTokens } = await import("../../src/retrieval-gate.ts");

describe("needsPriorContext — prior-turn leg gate (C1, BUILD-1)", () => {
  it("enables on anaphoric low-content follow-ups", () => {
    expect(needsPriorContext("Can you explain that rationale in a bit more depth please").enabled).toBe(true);
    expect(needsPriorContext("ok expand on that cache eviction analysis with some added detail please").enabled).toBe(true);
    expect(needsPriorContext("same for the staging environment").enabled).toBe(true);
    expect(needsPriorContext("ok but why does it do that").enabled).toBe(true);
    expect(needsPriorContext("as we discussed, continue with the second option").enabled).toBe(true);
  });

  it("enables a DETAILED continuation that points back via a deictic object — regardless of token count (codex turn-16 CONTRACT-1e)", () => {
    // The exact failing case: an explicit "go deeper on that" whose elaboration
    // pushes the content-token count above the low-content veto. Pre-fix this
    // scored self-sufficient and the required doc was starved from the pool.
    const target = needsPriorContext("go deeper on that — specifically the cache eviction failure mode and how partial coverage interacts with the final sort order");
    expect(target.enabled).toBe(true);
    expect(target.reason).toBe("continuation-deictic");
    expect(needsPriorContext("expand on this in far more architectural detail with the full data flow and persistence layer").enabled).toBe(true);
    expect(needsPriorContext("more about that decision and every tradeoff we weighed across latency recall and cost").enabled).toBe(true);
    // A leading discourse particle before a STRONG move still counts.
    expect(needsPriorContext("ok, go deeper on that — cover the admission floor arithmetic and the full candidate pool lifecycle").reason).toBe("continuation-deictic");
    // Requires BOTH signals: a continuation opener WITHOUT a back-reference
    // object stays self-sufficient, and a deictic-as-determiner ("that
    // function") is not a back-reference object.
    expect(needsPriorContext("so design the authentication flow using JWT tokens validated in middleware across all backend services now").enabled).toBe(false);
    expect(needsPriorContext("now refactor that authentication middleware to validate tokens against the new issuer configuration endpoint").enabled).toBe(false);
  });

  it("weak openers with deictic determiners stay behind the content threshold (codex turn-17 counterexamples)", () => {
    // now/so/and open self-contained imperatives; "about this X"/"to that X"/
    // "regarding this X" are preposition+determiner+noun, not back-references.
    // The token-independent branch must NOT fire — these carry ample content.
    expect(needsPriorContext("now write a security report about this authentication middleware using the new issuer configuration rollout").enabled).toBe(false);
    expect(needsPriorContext("so navigate to that deployment dashboard and verify production health across all services after the release").enabled).toBe(false);
    expect(needsPriorContext("and draft a migration plan regarding this database schema covering indexes constraints and rollback procedures").enabled).toBe(false);
    // Weak openers WITH genuinely low content still enable via the existing
    // token-count branch — narrowing the unconditional branch must not break it.
    expect(needsPriorContext("ok but why does it do that").enabled).toBe(true);
    expect(needsPriorContext("same for the staging environment").enabled).toBe(true);
  });

  it("stays disabled on self-sufficient prompts", () => {
    expect(needsPriorContext("Explain the OAuth refresh token rotation decision we made for the auth service").enabled).toBe(false);
    expect(needsPriorContext("plan the banner artwork composite for the spring newsletter template asset pack sizing rules").enabled).toBe(false);
    expect(needsPriorContext("compare regional hosting plans — plan the next staging cluster build for the shared analytics dashboard project").enabled).toBe(false);
    expect(needsPriorContext("Design the incident review archive: a findings graph built over past tickets, service ownership notes, and how postmortem output feeds the runbook index").enabled).toBe(false);
  });

  it("a long anaphora-marked prompt with plenty of content tokens is self-sufficient", () => {
    const r = needsPriorContext("i remember setting it to verbose ages ago, so something changed the build accuracy on the deployment pipeline thread with cached artifacts returning stale bundles");
    expect(r.enabled).toBe(false);
  });

  it("content-token counting ignores stopwords and anaphora scaffolding", () => {
    expect(countContentTokens("can you explain that in more depth please")).toBe(1); // depth
    expect(countContentTokens("oauth refresh token rotation decision")).toBe(5);
  });
});
