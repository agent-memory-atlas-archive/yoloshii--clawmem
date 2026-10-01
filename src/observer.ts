/**
 * Local Observer Agent - Structured observation extraction using local GGUF model
 *
 * Uses Qwen3-1.7B (already loaded for query expansion) with XML-formatted prompts
 * to extract structured observations and session summaries from transcripts.
 * Falls back gracefully when model is unavailable.
 */

import type { TranscriptMessage } from "./hooks.ts";
import type { DurationMs } from "./clock.ts";
import { getDefaultLlamaCpp } from "./llm.ts";
import { withRetryAndFeedback, type RetryLlm } from "./llm-retry.ts";
import { isSchemaPlaceholder } from "./schema-placeholder.ts";

// =============================================================================
// Types
// =============================================================================

export type Observation = {
  type: "decision" | "bugfix" | "feature" | "refactor" | "discovery" | "change" | "preference" | "milestone" | "problem";
  title: string;
  facts: string[];
  narrative: string;
  concepts: string[];
  filesRead: string[];
  filesModified: string[];
  triples?: ParsedTriple[];
};

export type ParsedTriple = {
  subject: string;
  predicate: string;
  object: string;
};

export type SessionSummary = {
  request: string;
  investigated: string;
  learned: string;
  completed: string;
  nextSteps: string;
};

// =============================================================================
// Config
// =============================================================================

const MAX_TRANSCRIPT_MESSAGES = 100;
const MAX_USER_MSG_CHARS = 200;
const MAX_ASSISTANT_MSG_CHARS = 500;
const MAX_TRANSCRIPT_TOKENS = 2000;
const GENERATION_MAX_TOKENS = 2000;
const GENERATION_TEMPERATURE = 0.3;

// =============================================================================
// System Prompts
// =============================================================================

const OBSERVATION_SYSTEM_PROMPT = `You are an observer analyzing a coding session transcript. Extract structured observations.
For each significant action, decision, or discovery, output an <observation> XML element with the structure below.

Structure:
<observation>
  <type>...</type>
  <title>...</title>
  <facts>
    <fact>...</fact>
  </facts>
  <triples>
    <triple>
      <subject>...</subject>
      <predicate>...</predicate>
      <object>...</object>
    </triple>
  </triples>
  <narrative>...</narrative>
  <concepts>
    <concept>...</concept>
  </concepts>
  <files_read><file>...</file></files_read>
  <files_modified><file>...</file></files_modified>
</observation>

Field rules:
- <type>: one of decision, bugfix, feature, refactor, discovery, change, preference, milestone, problem
- <title>: brief descriptive title, max 80 chars
- <facts>: 1-5 <fact> elements, each a standalone atomic claim about what happened or what is true (concrete, specific, no schema placeholders or template text)
- <triples>: 0-3 <triple> elements for structural relationships between named entities (see predicate vocabulary below). Omit entirely if no relational claims apply. Do NOT emit triples for descriptive facts — only for explicit S-P-O relations.
- <narrative>: 2-3 sentences explaining WHY something was done, not just WHAT
- <concepts>: 0-3 <concept> elements from: how-it-works, why-it-exists, what-changed, problem-solution, gotcha, pattern, trade-off
- <files_read>, <files_modified>: only files explicitly mentioned in the transcript

Predicate vocabulary (use EXACTLY these predicates in <predicate>, nothing else):
- adopted, migrated_to — switching to a new tool/framework/approach
- deployed_to, runs_on — where something runs
- replaced — when one thing supersedes another
- depends_on, integrates_with, uses — structural dependencies
- prefers, avoids — user preferences (use for <subject>user</subject>)
- caused_by, resolved_by — causal relationships between problems and fixes
- owned_by — responsibility / ownership

<subject> and <object> must be short canonical entity names (2-80 chars). No sentences. No placeholder text. If you cannot fit a claim into this vocabulary, keep it in <facts> instead and omit the triple.

Observation rules:
- Output 1-5 observations, focusing on the MOST significant events
- If no significant observations, output nothing
- Never use schema example text or template placeholders in <fact>, <subject>, or <object> — emit only real content extracted from the transcript

Type guidance:
- preference: user expresses a preference, habit, or way of working (e.g., "don't use subagents for this", "I prefer single PRs")
- milestone: significant completion point, version release, deployment, or phase transition
- problem: persistent issue, recurring bug, architectural limitation, or unresolved blocker`;

const SUMMARY_SYSTEM_PROMPT = `You are a session summarizer. Analyze this coding session transcript and output a structured summary.

<summary>
  <request>What the user originally asked for (1-2 sentences)</request>
  <investigated>What was explored or researched (1-2 sentences)</investigated>
  <learned>Key insights or discoveries (1-2 sentences)</learned>
  <completed>What was actually accomplished (1-2 sentences)</completed>
  <next_steps>What should happen next (1-2 sentences)</next_steps>
</summary>

Rules:
- Be concise and specific
- Focus on outcomes, not process
- If a section has nothing relevant, write "None"`;

// =============================================================================
// Transcript Preparation — Priority-Based Formatting
//
// Priority levels (lower = more important):
//   P0 — First user message (original request)
//   P1 — Last assistant message (final response)
//   P2 — Tool calls + tool errors
//   P3 — Other user/assistant messages
//   P4 — System messages
// =============================================================================

const P_USER_INSTRUCTION = 0;
const P_FINAL_RESPONSE = 1;
const P_TOOL_ACTIVITY = 2;
const P_CONVERSATION = 3;
const P_SYSTEM = 4;

export type PrioritizedMessage = {
  priority: number;
  index: number;  // original position for chronological reassembly
  role: string;
  content: string;
};

function isToolContent(content: string): boolean {
  return content.includes("[tool_use") || content.includes("[tool_result");
}

export function classifyMessages(messages: TranscriptMessage[]): PrioritizedMessage[] {
  const classified: PrioritizedMessage[] = [];
  let firstUserSeen = false;

  // Find last assistant message that is NOT a tool message (real final response)
  const lastRealAssistantIdx = messages.reduce(
    (last, m, i) => (m.role === "assistant" && !isToolContent(m.content)) ? i : last, -1
  );

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]!;
    let priority: number;

    // Tool content check first — tool messages in assistant role stay P2
    if (isToolContent(msg.content)) {
      priority = P_TOOL_ACTIVITY;
    } else if (msg.role === "user" && !firstUserSeen) {
      priority = P_USER_INSTRUCTION;
      firstUserSeen = true;
    } else if (msg.role === "assistant" && i === lastRealAssistantIdx) {
      priority = P_FINAL_RESPONSE;
    } else if (msg.role === "system") {
      priority = P_SYSTEM;
    } else {
      priority = P_CONVERSATION;
    }

    classified.push({ priority, index: i, role: msg.role, content: msg.content });
  }

  return classified;
}

/**
 * The transcript as the observer reads it, at most `charBudget` characters (~4 per token). v0.41.1: the budget is
 * the caller's — the observer gives its transcript what the CONTEXT section leaves of the render budget.
 */
export function prepareTranscript(messages: TranscriptMessage[], charBudget: number = MAX_TRANSCRIPT_TOKENS * 4): string {
  const recent = messages.slice(-MAX_TRANSCRIPT_MESSAGES);

  const classified = classifyMessages(recent);

  // Phase 1: Critical (P0 + P1) — always included, truncated to per-role limits
  const critical = classified.filter(m => m.priority <= P_FINAL_RESPONSE);
  const criticalLines = critical.map(m => {
    const maxChars = m.role === "user" ? MAX_USER_MSG_CHARS * 2 : MAX_ASSISTANT_MSG_CHARS * 2;
    const content = m.content.length > maxChars ? m.content.slice(0, maxChars) + "..." : m.content;
    return { ...m, content, formatted: `[${m.role}]: ${content}` };
  });
  let used = criticalLines.reduce((sum, l) => sum + l.formatted.length + 1, 0);

  // Phase 2: Tool activity (P2) — budget-allocated, truncate to fit (not drop)
  const toolMsgs = classified.filter(m => m.priority === P_TOOL_ACTIVITY);
  const toolLines: typeof criticalLines = [];
  for (const m of toolMsgs) {
    if (used >= charBudget) break;
    const remaining = charBudget - used;
    const prefix = `[${m.role}]: `;
    const overhead = prefix.length + 1; // +1 for newline join
    if (remaining <= overhead + 20) break; // not enough room for meaningful content
    const contentBudget = Math.min(500, remaining - overhead);
    const content = m.content.length > contentBudget
      ? m.content.slice(0, contentBudget - 3) + "..."
      : m.content;
    const formatted = `${prefix}${content}`;
    toolLines.push({ ...m, content, formatted });
    used += formatted.length + 1;
  }

  // Phase 3: Conversation (P3) — fills remaining budget
  const convMsgs = classified.filter(m => m.priority === P_CONVERSATION);
  const convLines: typeof criticalLines = [];
  for (const m of convMsgs) {
    if (used >= charBudget) break;
    const maxChars = m.role === "user" ? MAX_USER_MSG_CHARS : MAX_ASSISTANT_MSG_CHARS;
    const content = m.content.length > maxChars ? m.content.slice(0, maxChars) + "..." : m.content;
    const formatted = `[${m.role}]: ${content}`;
    if (used + formatted.length + 1 <= charBudget) {
      convLines.push({ ...m, content, formatted });
      used += formatted.length + 1;
    }
  }

  // Reassemble in chronological order
  const all = [...criticalLines, ...toolLines, ...convLines];
  all.sort((a, b) => a.index - b.index);

  // Phase 1 is kept whatever the budget; under a budget smaller than it (the CONTEXT's share), the latest text is.
  const out = all.map(l => l.formatted).join("\n");
  if (out.length <= charBudget) return out;
  const tail = out.slice(out.length - charBudget + 1);
  return "…" + (LOW_SURROGATE_FIRST.test(tail) ? tail.slice(1) : tail);
}

/** A cut must not leave half of a surrogate pair: llama-server refuses a lone surrogate in the request (HTTP 500). */
const LOW_SURROGATE_FIRST = /^[\uDC00-\uDFFF]/;
const HIGH_SURROGATE_LAST = /[\uD800-\uDBFF]$/;

// =============================================================================
// XML Parsers
// =============================================================================

const VALID_OBSERVATION_TYPES = new Set([
  "decision", "bugfix", "feature", "refactor", "discovery", "change",
  "preference", "milestone", "problem",
]);

const VALID_CONCEPTS = new Set([
  "how-it-works", "why-it-exists", "what-changed", "problem-solution",
  "gotcha", "pattern", "trade-off",
]);

// Canonical SPO predicate vocabulary — parser rejects anything outside this set.
// Must stay in sync with the predicate list in OBSERVATION_SYSTEM_PROMPT.
export const VALID_PREDICATES = new Set([
  "adopted", "migrated_to",
  "deployed_to", "runs_on",
  "replaced",
  "depends_on", "integrates_with", "uses",
  "prefers", "avoids",
  "caused_by", "resolved_by",
  "owned_by",
]);

// Predicates whose <object> should be stored as a literal (not resolved to an entity).
export const LITERAL_PREDICATES = new Set(["prefers", "avoids"]);

// Anti-parrot residue guard (SCHEMA_PLACEHOLDER_STRINGS / isMarkerOnly / isSchemaPlaceholder)
// now lives in ./schema-placeholder.ts, shared with the consolidation + conversation-synthesis
// extraction paths. Imported at the top of this file.

export function parseObservationXml(xml: string): Observation | null {
  const typeMatch = xml.match(/<type>\s*(.*?)\s*<\/type>/s);
  const titleMatch = xml.match(/<title>\s*(.*?)\s*<\/title>/s);
  const narrativeMatch = xml.match(/<narrative>\s*(.*?)\s*<\/narrative>/s);

  if (!typeMatch?.[1] || !titleMatch?.[1]) return null;

  const type = typeMatch[1].trim().toLowerCase();
  if (!VALID_OBSERVATION_TYPES.has(type)) return null;

  const rawTitle = titleMatch[1].trim();
  if (isSchemaPlaceholder(rawTitle)) return null;

  const facts = extractMultiple(xml, "fact")
    .filter(f => f.length >= 5)
    .filter(f => !isSchemaPlaceholder(f));

  const concepts = extractMultiple(xml, "concept")
    .filter(c => VALID_CONCEPTS.has(c.toLowerCase()))
    .map(c => c.toLowerCase());
  const filesRead = extractMultiple(xml, "file", "files_read");
  const filesModified = extractMultiple(xml, "file", "files_modified");

  // Parse triples (Fix A): strict validation against canonical predicate vocabulary.
  // Missing/malformed triples are silently dropped — fail-closed on ambiguity.
  const triples = extractTriples(xml);

  return {
    type: type as Observation["type"],
    title: rawTitle.slice(0, 80),
    facts,
    narrative: narrativeMatch?.[1]?.trim() || "",
    concepts,
    filesRead,
    filesModified,
    triples: triples.length > 0 ? triples : undefined,
  };
}

function extractTriples(xml: string): ParsedTriple[] {
  const parentMatch = xml.match(/<triples>([\s\S]*?)<\/triples>/s);
  if (!parentMatch?.[1]) return [];

  const blockRegex = /<triple>([\s\S]*?)<\/triple>/g;
  const results: ParsedTriple[] = [];
  let match;
  while ((match = blockRegex.exec(parentMatch[1])) !== null) {
    const block = match[1] ?? "";
    const subject = block.match(/<subject>\s*(.*?)\s*<\/subject>/s)?.[1]?.trim();
    const rawPredicate = block.match(/<predicate>\s*(.*?)\s*<\/predicate>/s)?.[1]?.trim();
    const object = block.match(/<object>\s*(.*?)\s*<\/object>/s)?.[1]?.trim();

    if (!subject || !rawPredicate || !object) continue;

    const predicate = rawPredicate.toLowerCase().replace(/\s+/g, "_");
    if (!VALID_PREDICATES.has(predicate)) continue;

    // Length bounds — guards against sentence-shaped subjects/objects that the
    // regex-era tests expected. Subject and object should be short canonical names.
    if (subject.length < 2 || subject.length > 80) continue;
    if (object.length < 2 || object.length > 120) continue;

    // Identifier scope: a subject/object is an entity name or literal value, not an
    // assertion — `${HOME}` is a legitimate object of `uses` / `depends_on` / `prefers`.
    if (isSchemaPlaceholder(subject, undefined, "identifier") ||
        isSchemaPlaceholder(object, undefined, "identifier")) continue;

    results.push({ subject, predicate, object });

    if (results.length >= 5) break; // cap per observation
  }
  return results;
}

export function parseSummaryXml(xml: string): SessionSummary | null {
  const request = extractSingle(xml, "request");
  const investigated = extractSingle(xml, "investigated");
  const learned = extractSingle(xml, "learned");
  const completed = extractSingle(xml, "completed");
  const nextSteps = extractSingle(xml, "next_steps");

  if (!request && !completed) return null;

  return {
    request: request || "Unknown",
    investigated: investigated || "None",
    learned: learned || "None",
    completed: completed || "None",
    nextSteps: nextSteps || "None",
  };
}

function extractSingle(xml: string, tag: string): string | null {
  const match = xml.match(new RegExp(`<${tag}>\\s*(.*?)\\s*</${tag}>`, "s"));
  return match?.[1]?.trim() || null;
}

function extractMultiple(xml: string, tag: string, parentTag?: string): string[] {
  let scope = xml;
  if (parentTag) {
    const parentMatch = xml.match(new RegExp(`<${parentTag}>([\\s\\S]*?)</${parentTag}>`, "s"));
    if (!parentMatch?.[1]) return [];
    scope = parentMatch[1];
  }

  const results: string[] = [];
  const regex = new RegExp(`<${tag}>\\s*(.*?)\\s*</${tag}>`, "gs");
  let match;
  while ((match = regex.exec(scope)) !== null) {
    const text = match[1]?.trim();
    if (text) results.push(text);
  }
  return results;
}

// =============================================================================
// Core Extraction Functions
// =============================================================================

/** The observer's outcome for one batch (62.1 D3): only `ok` and `empty` may commit a range's effects. */
export type ObservationResult =
  | { status: "ok"; observations: Observation[] }
  | { status: "empty" }
  | { status: "retryable"; reason: string };

/** What the batch must not re-extract (62.1 D4): the turns just before it and this session's recorded titles. */
export type ObservationContext = { priorMessages: TranscriptMessage[]; recordedTitles: string[] };

/** A valid empty completion ("If no significant observations, output nothing"), passed through the retry helper. */
const EMPTY_COMPLETION = "\u0000observer:empty-completion\u0000";
/** A reply with no observation blocks and no markup, short enough to be a plain "nothing" rather than lost output. */
const PLAIN_NOTHING_MAX_CHARS = 300;

/**
 * The CONTEXT section's share of the render budget (v0.41.1). The section is at most this long, the transcript gets the
 * rest, and batches are packed to leave it (stop-extract.ts), so CONTEXT + transcript stay within
 * OBSERVER_MAX_RENDER_CHARS — the prompt v0.40 sent at its largest, which the documented `-c 4096` was sized for.
 */
export const OBSERVER_CONTEXT_MAX_CHARS = 2_000;
/**
 * A retry's feedback block (llm-retry.ts: its fixed lines, the parse error, up to 500 characters of the response) and
 * the blank line before it, at most (805 with the observer's longest error). A retry takes it out of the transcript's
 * budget, so every attempt stays within OBSERVER_MAX_RENDER_CHARS (v0.41.1).
 */
export const OBSERVER_RETRY_FEEDBACK_MAX_CHARS = 850;
/** What a batch leaves of the render budget: the CONTEXT and a retry's feedback, so it reaches the model whole on every attempt. */
export const OBSERVER_BATCH_RESERVED_CHARS = OBSERVER_CONTEXT_MAX_CHARS + OBSERVER_RETRY_FEEDBACK_MAX_CHARS;
/** Within it: the prior turns' text, the titles' lines, and one title's length. Headers take ~100 more (1,901 at most in all). */
const CONTEXT_PRIOR_CHARS = 1_100;
const CONTEXT_TITLES_CHARS = 700;
const CONTEXT_TITLE_CHARS = 100;

function renderContextSection(ctx: ObservationContext | undefined): string {
  if (!ctx || (ctx.priorMessages.length === 0 && ctx.recordedTitles.length === 0)) return "";
  const lines = ["--- CONTEXT (already recorded — do not extract) ---"];
  if (ctx.priorMessages.length > 0) lines.push(prepareTranscript(ctx.priorMessages, CONTEXT_PRIOR_CHARS));
  // The newest titles that fit (the list is oldest first), kept in that order.
  const titles: string[] = [];
  let used = 0;
  for (let i = ctx.recordedTitles.length - 1; i >= 0; i--) {
    const t = ctx.recordedTitles[i]!;
    const head = t.slice(0, CONTEXT_TITLE_CHARS - 1);
    const line = `- ${t.length > CONTEXT_TITLE_CHARS ? (HIGH_SURROGATE_LAST.test(head) ? head.slice(0, -1) : head) + "…" : t}`;
    if (used + line.length + 1 > CONTEXT_TITLES_CHARS) break;
    titles.unshift(line);
    used += line.length + 1;
  }
  if (titles.length > 0) lines.push("Already recorded observations:", ...titles);
  lines.push("--- END CONTEXT ---", "");
  return lines.join("\n") + "\n";
}

/**
 * Extract observations from one batch, reporting WHY it has none (62.1 D3): `empty` is a valid model answer with
 * nothing to record; `retryable` is a failure (model unavailable, timeout, output that never parses) that must not
 * commit the batch. Admission (enough assistant content) is the caller's; there is no minimum message count here.
 */
export async function extractObservationsResult(
  messages: TranscriptMessage[],
  opts?: { timeoutMs?: DurationMs; context?: ObservationContext },
): Promise<ObservationResult> {
  const context = renderContextSection(opts?.context);
  const budget = OBSERVER_MAX_RENDER_CHARS - context.length;
  const promptWithin = (transcriptBudget: number) =>
    `${OBSERVATION_SYSTEM_PROMPT}\n\n${context}--- TRANSCRIPT ---\n${prepareTranscript(messages, transcriptBudget)}\n--- END TRANSCRIPT ---\n\nExtract observations:`;

  const inner = getDefaultLlamaCpp();
  let unavailable = false;
  const llm: RetryLlm = {
    async generate(p, o) {
      const r = await inner.generate(p, o);
      if (r === null) { unavailable = true; return null; }
      return r.text.trim() === "" ? { ...r, text: EMPTY_COMPLETION } : r;
    },
  };
  const parsed = await withRetryAndFeedback<Observation[]>({
    initialPrompt: promptWithin(budget),
    // A retry's feedback comes out of the transcript's budget (v0.41.1), so every attempt stays inside the bound.
    retryPrompt: (feedback) => `${promptWithin(budget - feedback.length - 2)}\n\n${feedback}`,
    llm,
    maxTokens: GENERATION_MAX_TOKENS,
    temperature: GENERATION_TEMPERATURE,
    timeoutMs: opts?.timeoutMs,
    label: "observer.extractObservations",
    parse: (text) => {
      if (text === EMPTY_COMPLETION) return { ok: true, value: [] };
      // Parse all <observation>...</observation> blocks
      const observations: Observation[] = [];
      let blocks = 0;
      const regex = /<observation>([\s\S]*?)<\/observation>/g;
      let match;
      while ((match = regex.exec(text)) !== null) {
        blocks++;
        const obs = parseObservationXml(match[1]!);
        if (obs) observations.push(obs);
      }
      if (observations.length > 0) return { ok: true, value: observations };
      if (blocks === 0 && !/[<>]/.test(text) && text.trim().length <= PLAIN_NOTHING_MAX_CHARS) return { ok: true, value: [] };
      return {
        ok: false,
        error:
          blocks === 0
            ? "No <observation>...</observation> blocks found in the response. Wrap each observation in <observation> tags."
            : `Found ${blocks} <observation> block(s) but none contained the required fields. Each block needs valid <type>, <content>, and the documented child tags.`,
      };
    },
  });
  if (parsed === null) return { status: "retryable", reason: unavailable ? "model unavailable" : "no parseable response within the budget" };
  return parsed.length === 0 ? { status: "empty" } : { status: "ok", observations: parsed };
}

/** The pre-62.1 form: observations, or [] for anything else (below 4 messages, empty, or failed). */
export async function extractObservations(
  messages: TranscriptMessage[],
  /** s342 D2: the Stop handler threads its remaining whole-handler budget here
   *  so extraction cannot outlive `CLAWMEM_STOP_BUDGET_MS`. Omitted → the
   *  retry helper's default wall-clock cap applies (non-hook callers). */
  opts?: { timeoutMs?: DurationMs }
): Promise<Observation[]> {
  if (messages.length < 4) return [];
  const r = await extractObservationsResult(messages, opts);
  return r.status === "ok" ? r.observations : [];
}

/**
 * The characters `prepareTranscript` would render for these messages before its overall budget applies (62.1 D4
 * batch packing): each message capped as the observer caps it, one line each.
 */
export function observerRenderChars(messages: TranscriptMessage[]): number {
  let total = 0;
  for (const m of classifyMessages(messages.slice(-MAX_TRANSCRIPT_MESSAGES))) {
    const cap = m.priority <= P_FINAL_RESPONSE
      ? (m.role === "user" ? MAX_USER_MSG_CHARS * 2 : MAX_ASSISTANT_MSG_CHARS * 2)
      : m.priority === P_TOOL_ACTIVITY ? 500 : (m.role === "user" ? MAX_USER_MSG_CHARS : MAX_ASSISTANT_MSG_CHARS);
    const content = m.content.length > cap ? m.content.slice(0, cap) + "..." : m.content;
    total += `[${m.role}]: ${content}`.length + 1;
  }
  return total;
}

/** The observer's input bounds a batch must fit (62.1 D4). */
export const OBSERVER_MAX_MESSAGES = MAX_TRANSCRIPT_MESSAGES;
export const OBSERVER_MAX_RENDER_CHARS = MAX_TRANSCRIPT_TOKENS * 4;

/** One turn as the summary step sees it (62.1 D5 digests). */
export type TurnDigestText = { request: string; outcome: string; files: string[] };

/** The summary's outcome for one batch (62.1 D5): `retryable` changes nothing but the audit. */
export type SummaryResult = { status: "ok"; summary: SessionSummary } | { status: "retryable"; reason: string };

/** A digest as one prompt line (also the unit the summary batches are packed by). */
export function renderDigestLine(d: TurnDigestText, n: number): string {
  return `${n}. Request: ${d.request || "(continued turn)"} | Outcome: ${d.outcome || "(none)"}${d.files.length > 0 ? ` | Files: ${d.files.join(", ")}` : ""}`;
}

/** A summary as prompt text (the previous summary an incremental call carries). */
export function renderSummaryText(s: SessionSummary): string {
  return [
    `Request: ${s.request}`, `Investigated: ${s.investigated}`, `Learned: ${s.learned}`,
    `Completed: ${s.completed}`, `Next steps: ${s.nextSteps}`,
  ].join("\n");
}

const INCREMENTAL_SUMMARY_NOTE = `You are given the summary of the session so far (when there is one), the turns since it (oldest first), and the text of the latest of those turns. Output the updated summary of the WHOLE session so far, in the same format.`;

function parseSummaryResponse(text: string): { ok: true; value: SessionSummary } | { ok: false; error: string } {
  const summaryMatch = text.match(/<summary>([\s\S]*?)<\/summary>/);
  if (!summaryMatch?.[1]) {
    return { ok: false, error: "No <summary>...</summary> block found in the response. Wrap the summary in <summary> tags." };
  }
  const summary = parseSummaryXml(summaryMatch[1]);
  if (!summary) return { ok: false, error: "A <summary> block was found but its child tags were missing or invalid." };
  return { ok: true, value: summary };
}

/**
 * 62.1 D5 (honcho's incremental summarizer, `summarizer.py:390-433`): the previous summary + the digests of the turns
 * since it + the recent text → the updated summary. The opening request survives in `previous.request`.
 */
export async function extractSummaryIncremental(
  previous: SessionSummary | null,
  digests: readonly TurnDigestText[],
  recentText: string,
  opts?: { timeoutMs?: DurationMs },
): Promise<SummaryResult> {
  const parts = [SUMMARY_SYSTEM_PROMPT, "", INCREMENTAL_SUMMARY_NOTE, ""];
  if (previous) parts.push("--- PREVIOUS SUMMARY ---", renderSummaryText(previous), "--- END PREVIOUS SUMMARY ---", "");
  parts.push("--- NEW TURNS (oldest first) ---", ...digests.map((d, i) => renderDigestLine(d, i + 1)), "--- END NEW TURNS ---", "");
  if (recentText) parts.push("--- RECENT TRANSCRIPT ---", recentText, "--- END RECENT TRANSCRIPT ---", "");
  parts.push("Generate the updated summary:");

  const inner = getDefaultLlamaCpp();
  let unavailable = false;
  const llm: RetryLlm = {
    async generate(p, o) {
      const r = await inner.generate(p, o);
      if (r === null) unavailable = true;
      return r;
    },
  };
  const parsed = await withRetryAndFeedback<SessionSummary>({
    initialPrompt: parts.join("\n"),
    llm,
    maxTokens: 500,
    temperature: GENERATION_TEMPERATURE,
    timeoutMs: opts?.timeoutMs,
    label: "observer.extractSummaryIncremental",
    parse: parseSummaryResponse,
  });
  if (parsed === null) return { status: "retryable", reason: unavailable ? "model unavailable" : "no parseable response within the budget" };
  const keep = previous && previous.request !== "Unknown" && previous.request !== "None" ? previous.request : null;
  return { status: "ok", summary: keep ? { ...parsed, request: keep } : parsed };
}

export async function extractSummary(
  messages: TranscriptMessage[]
): Promise<SessionSummary | null> {
  if (messages.length < 4) return null;

  const transcript = prepareTranscript(messages);
  const prompt = `${SUMMARY_SYSTEM_PROMPT}\n\n--- TRANSCRIPT ---\n${transcript}\n--- END TRANSCRIPT ---\n\nGenerate summary:`;

  return withRetryAndFeedback<SessionSummary>({
    initialPrompt: prompt,
    llm: getDefaultLlamaCpp(),
    maxTokens: 500,
    temperature: GENERATION_TEMPERATURE,
    label: "observer.extractSummary",
    parse: parseSummaryResponse,
  });
}
