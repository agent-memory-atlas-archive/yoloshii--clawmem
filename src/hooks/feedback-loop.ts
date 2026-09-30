/**
 * Feedback Loop Hook - Stop (Claude Code) / agent_end (OpenClaw)
 *
 * Detects which surfaced notes the assistant actually referenced and credits them. 62.1 D6: each turn is credited
 * ONCE — its injection manifest was recorded by the bookkeeping drainer, the turn is paired with its usage row by
 * identity (D1, never by position), the reference test runs once over the whole manifest, and only the first
 * verified reference of an entry moves counters (access_count, last_accessed_at, utility signals, same-turn
 * co-activations and usage relations). Named vaults then apply their slice of the verdict.
 *
 * Silent — does not inject context back to Claude.
 */

import type { Store } from "../store.ts";
import { resolveStore } from "../store.ts";
import { listVaults } from "../config.ts";
import type { HookInput, HookOutput } from "../hooks.ts";
import { makeEmptyOutput } from "../hooks.ts";
import { stopPipelineReady } from "../stop-schema.ts";
import { applyMirrorSlices, attributeTranscript } from "../stop-feedback.ts";
import { monoNow, deadlineAfter, duration } from "../clock.ts";
import { resolveStopBudgetMs } from "../causal-writer.ts";

export type FeedbackLoopOptions = {
  /** The named vaults whose mirror rows take their slice of the verdict (default: every configured vault). */
  vaults?: { name: string; store: Store }[];
};

export async function feedbackLoop(
  store: Store,
  input: HookInput,
  opts?: FeedbackLoopOptions,
): Promise<HookOutput> {
  const sessionId = input.sessionId;
  // D10: on a vault whose stop-pipeline migration is not verified, counter work is skipped (fail closed).
  if (!sessionId || !input.transcriptPath || !stopPipelineReady(store.db)) return makeEmptyOutput("feedback-loop");

  try {
    attributeTranscript(store, {
      sessionId,
      transcriptPath: input.transcriptPath,
      host: input.host,
      sessionKey: input.sessionKey,
      atStop: true,
      deadline: deadlineAfter(monoNow(), duration(resolveStopBudgetMs().budgetMs)),
    });
  } catch (err) {
    process.stderr.write(`[feedback-loop] attribution failed: ${err instanceof Error ? err.message : String(err)}\n`);
  }

  const vaults = opts?.vaults ?? configuredVaults();
  for (const v of vaults) {
    try {
      applyMirrorSlices(store, v.store, v.name, { sessionId });
    } catch { /* vault unavailable — its mirrors stay pending for the next Stop or the worker */ }
  }

  // Silent return — feedback loop doesn't inject context
  return makeEmptyOutput("feedback-loop");
}

function configuredVaults(): { name: string; store: Store }[] {
  const out: { name: string; store: Store }[] = [];
  for (const name of listVaults()) {
    try { out.push({ name, store: resolveStore(name) }); } catch { /* unavailable — skipped this Stop */ }
  }
  return out;
}
