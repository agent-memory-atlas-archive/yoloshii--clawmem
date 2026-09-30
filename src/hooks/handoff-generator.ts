/**
 * Handoff Generator Hook - Stop, SessionEnd
 *
 * 62.1 D5 (stop-handoff.ts): at a Stop, the digest step records every new turn of the transcript (no model), then the
 * throttled summary step folds the digests past its watermark into the session's summary (the observer, incremental)
 * and renders the transcript's handoff document in `_clawmem/handoffs/`. At SessionEnd it only renders what is
 * stored — no transcript read, no model call — under a 1,000 ms deadline.
 */

import type { Store } from "../store.ts";
import { epochNow, epochMs, isoNow, monoNow, deadlineAfter, duration, type MonoDeadline } from "../clock.ts";
import type { HookInput, HookOutput } from "../hooks.ts";
import { makeContextOutput, makeEmptyOutput, validateTranscriptPath } from "../hooks.ts";
import { updateDirectoryContext } from "../directory-context.ts";
import { loadConfig } from "../collections.ts";
import { resolveStopBudgetMs } from "../causal-writer.ts";
import { stopPipelineReady } from "../stop-schema.ts";
import { readSessionDoc } from "../stop-session-docs.ts";
import {
  runHandoffDigests, runHandoffSummary, flushHandoffAtSessionEnd, handoffSessionLine, SESSION_END_DEADLINE_MS,
  type SummaryRun,
} from "../stop-handoff.ts";

export async function handoffGenerator(
  store: Store,
  input: HookInput,
  opts?: { sessionEndDeadline?: MonoDeadline },
): Promise<HookOutput> {
  const sessionId = input.sessionId || `session-${epochMs(epochNow())}`;

  // SessionEnd: render only, inside the host's cap. Pending feedback and any catch-up are left to the worker.
  if (input.hookEventName === "SessionEnd") {
    try {
      flushHandoffAtSessionEnd(store, {
        sessionId, transcriptPath: input.transcriptPath, host: input.host, sessionKey: input.sessionKey,
        deadline: opts?.sessionEndDeadline ?? deadlineAfter(monoNow(), duration(SESSION_END_DEADLINE_MS)),
      });
    } catch (err) {
      console.error(`[handoff-generator] SessionEnd flush failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    return makeEmptyOutput("handoff-generator");
  }

  // 62.1 D10: on a vault whose stop-pipeline migration is not verified, cursor work is skipped (fail closed).
  if (!stopPipelineReady(store.db) || !validateTranscriptPath(input.transcriptPath)) return makeEmptyOutput("handoff-generator");
  const stopBudget = resolveStopBudgetMs();
  if (stopBudget.invalid) console.error(`[handoff-generator] ${stopBudget.invalid}`);
  const deadline = deadlineAfter(monoNow(), duration(stopBudget.budgetMs));

  // Digest step first (its own Phase B): the turns are recorded whatever the summary step does. A vault busy past the
  // wait commits nothing; the next Stop or the worker redoes it from the same cursor.
  let digest: ReturnType<typeof runHandoffDigests>;
  try {
    digest = runHandoffDigests(store, {
      sessionId, transcriptPath: input.transcriptPath!, host: input.host, sessionKey: input.sessionKey, atStop: true,
    });
  } catch (err) {
    console.error(`[handoff-generator] digest step not committed: ${err instanceof Error ? err.message : String(err)}`);
    return makeEmptyOutput("handoff-generator");
  }
  const key = digest.transcriptKey;
  if (!key) return makeEmptyOutput("handoff-generator");

  let summary: SummaryRun | null = null;
  try {
    summary = await runHandoffSummary(store, { sessionId, transcriptKey: key, deadline });
  } catch (err) {
    console.error(`[handoff-generator] summary step failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  // The session record: its handoff path, opening request and changed files.
  const doc = readSessionDoc(store.db, sessionId, key, "handoff");
  const line = doc ? handoffSessionLine(store.db, sessionId, key) : null;
  if (doc && line) {
    try {
      store.updateSession(sessionId, { endedAt: isoNow(), handoffPath: doc.path, summary: line.summary, filesChanged: line.files });
    } catch { /* non-fatal */ }
  }

  // Directory context for the files the new turns changed.
  if (digest.files.length > 0) {
    const config = loadConfig();
    if (config.directoryContext) {
      try {
        updateDirectoryContext(store, digest.files);
      } catch { /* non-fatal */ }
    }
  }

  return summary && summary.committed > 0 && doc
    ? makeContextOutput("handoff-generator", `<vault-handoff>Handoff note saved: ${doc.path}</vault-handoff>`)
    : makeEmptyOutput("handoff-generator");
}
