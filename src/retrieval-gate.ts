/**
 * Retrieval Gate — Adaptive prompt filtering for context-surfacing
 *
 * Determines whether a prompt warrants memory retrieval. Skips greetings,
 * shell commands, affirmations, pure emoji, and system pings. Forces
 * retrieval for memory-intent queries even if short.
 *
 * Ported from memory-lancedb-pro's adaptive-retrieval.ts + noise-filter.ts,
 * complementing ClawMem's existing short-prompt, slash-command, heartbeat,
 * and dedupe gates in context-surfacing.
 */

// Prompts that should skip retrieval entirely
const SKIP_PATTERNS = [
  // Greetings & pleasantries
  /^(hi|hello|hey|good\s*(morning|afternoon|evening|night)|greetings|yo|sup|howdy|what'?s up)\b/i,
  // Shell/dev commands (slash commands handled separately in context-surfacing)
  /^(run|build|test|ls|cd|git|npm|pip|docker|curl|cat|grep|find|make|sudo|bun|node|deno)\b/i,
  // Simple affirmations/negations
  /^(yes|no|yep|nope|ok|okay|sure|fine|thanks|thank you|thx|ty|got it|understood|cool|nice|great|good|perfect|awesome)\s*[.!]?$/i,
  // Continuation prompts
  /^(go ahead|continue|proceed|do it|start|begin|next)\s*[.!]?$/i,
  // Pure emoji
  /^[\p{Emoji}\s]+$/u,
  // Single-word utility pings
  /^(ping|pong|test|debug)\s*[.!?]?$/i,
];

// Prompts that MUST trigger retrieval even if short (checked before skip)
const FORCE_RETRIEVE_PATTERNS = [
  /\b(remember|recall|forgot|memory|memories)\b/i,
  /\b(last time|before|previously|earlier|yesterday|ago)\b/i,
  /\b(my (name|email|phone|address|birthday|preference))\b/i,
  /\b(what did (i|we)|did i (tell|say|mention))\b/i,
];

/**
 * Normalize OpenClaw-injected metadata from prompts.
 * Strips cron wrappers, timestamp prefixes, and conversation metadata.
 */
function normalizePrompt(prompt: string): string {
  let s = prompt.trim();
  // Strip OpenClaw metadata headers
  s = s.replace(/^(Conversation info|Sender) \(untrusted metadata\):[\s\S]*?\n\s*\n/gim, "");
  // Strip cron wrapper prefix
  s = s.trim().replace(/^\[cron:[^\]]+\]\s*/i, "");
  // Strip timestamp prefix
  s = s.trim().replace(/^\[[A-Za-z]{3}\s\d{4}-\d{2}-\d{2}\s\d{2}:\d{2}\s[^\]]+\]\s*/, "");
  return s.trim();
}

/**
 * Memory-intent force check on the normalized prompt. Exported so
 * context-surfacing can honor the "(checked before skip)" contract at its OWN
 * skip gates too — §51.5: its MIN_PROMPT_LENGTH early-return used to fire
 * before this check ever ran, dropping short explicit memory queries like
 * "what did I say?".
 */
export function hasForceRetrieveIntent(prompt: string): boolean {
  const trimmed = normalizePrompt(prompt);
  return FORCE_RETRIEVE_PATTERNS.some(p => p.test(trimmed));
}

/**
 * Check if a prompt should skip memory retrieval.
 * Returns true if retrieval should be skipped.
 *
 * This complements (does NOT replace) existing gates in context-surfacing:
 * - MIN_PROMPT_LENGTH (<20 chars — force-intent prompts exempt, §51.5)
 * - Slash commands (starts with /)
 * - Heartbeat suppression
 * - Duplicate prompt dedupe
 */
export function shouldSkipRetrieval(prompt: string): boolean {
  // Force retrieve if query has memory-related intent (before length/pattern checks)
  if (hasForceRetrieveIntent(prompt)) return false;

  const trimmed = normalizePrompt(prompt);

  // Too short to be meaningful (below context-surfacing's MIN_PROMPT_LENGTH)
  if (trimmed.length < 5) return true;

  // Skip if matches any skip pattern
  if (SKIP_PATTERNS.some(p => p.test(trimmed))) return true;

  // Skip very short non-question messages
  // CJK characters carry more meaning per character — lower threshold
  const hasCJK = /[\u4e00-\u9fff\u3040-\u309f\u30a0-\u30ff\uac00-\ud7af]/.test(trimmed);
  const minLength = hasCJK ? 6 : 15;
  if (trimmed.length < minLength && !trimmed.includes('?') && !trimmed.includes('\uff1f')) return true;

  return false;
}

// =============================================================================
// Prior-turn leg gate (C1, RANKING-DEFECT-HANDOFF Addendum 5)
// =============================================================================

// Anaphoric / deictic markers: the prompt refers to something it doesn't name.
const ANAPHORA_MARKERS = /\b(that|this|it|its|them|those|these|same|previous|above|earlier|aforementioned)\b/i;

// Continuation openers: the prompt is a follow-up move, not a fresh question.
const CONTINUATION_OPENERS = /^(ok|okay|and|but|also|now|then|so|next|again|more|expand|elaborate|continue|go (on|deeper|further|back)|keep going|deeper|further|why not|what about|how about|same (for|with))\b/i;

// Explicit back-references to the conversation itself.
const CONVERSATION_BACKREF = /\b(as (i|we|you) (said|mentioned|discussed|noted))\b|\b(the|your) (above|previous|last|earlier) (one|point|question|answer|step|suggestion)\b/i;

// A deictic that points BACK at prior content as the OBJECT of a back-
// reference preposition ("on that", "about this", "into it") or an explicit
// "the previous/last/earlier …" phrase. NOTE: this cannot distinguish the
// pronoun use ("about this") from a determiner+noun ("about this middleware")
// — which is why the token-count-independent branch below additionally
// requires a STRONG continuation move, not any opener (codex turn-17).
const DEICTIC_BACKREF_OBJECT = /\b(on|about|into|regarding|from|of|to)\s+(that|this|those|these|it)\b|\bthe\s+(above|previous|last|earlier|prior|preceding)\b/i;

// STRONG continuation moves — verbs/moves whose whole purpose is to extend
// prior discussion ("go deeper", "expand", "continue", "elaborate", "more").
// Only these may enable the prior leg REGARDLESS of content-token count; weak
// discourse openers (now/so/and/ok…) stay behind the content threshold, since
// they routinely open self-contained imperatives ("now write a security
// report about this authentication middleware…" — codex turn-17). An optional
// leading discourse particle is tolerated ("ok, go deeper on that…").
const STRONG_CONTINUATION_MOVE = /^(?:(?:ok|okay|and|but|also|now|then|so|yes|right|great)[,\s]+)?(?:expand|elaborate|continue|more|go (?:on|deeper|further|back)|keep going|deeper|further)\b/i;

// Stopwords + anaphora markers excluded when counting content tokens.
const CONTENT_STOPWORDS = new Set([
  "a", "an", "the", "of", "in", "on", "at", "to", "for", "from", "with", "by", "and", "or", "but",
  "is", "are", "was", "were", "be", "been", "being", "do", "does", "did", "can", "could", "should",
  "would", "will", "shall", "may", "might", "must", "have", "has", "had", "i", "we", "you", "he",
  "she", "they", "me", "us", "my", "our", "your", "their", "what", "which", "who", "how", "when",
  "where", "why", "please", "bit", "little", "very", "really", "just", "some", "any", "more",
  "that", "this", "it", "its", "them", "those", "these", "same", "previous", "above", "earlier",
  "ok", "okay", "also", "now", "then", "so", "again", "expand", "elaborate", "continue", "explain",
  "tell", "about", "not", "no", "yes",
]);

/** Content tokens = words carrying topical signal (stopwords + anaphora scaffolding removed). */
export function contentTokenSet(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter(t => t.length > 1 && !CONTENT_STOPWORDS.has(t))
  );
}

export function countContentTokens(prompt: string): number {
  return contentTokenSet(prompt).size;
}

export interface PriorContextDecision {
  enabled: boolean;
  reason: string;
}

/**
 * Deterministic underspecification/anaphora test on the CURRENT prompt —
 * the ONLY enabler of the prior-turns retrieval leg (CONTRACT-1e). A prompt
 * that fully specifies its own topic gets a current-only retrieval; a prompt
 * that delegates its meaning to earlier turns ("expand on that", "ok but
 * why…", "same for X") gets the prior leg fused BELOW the current leg.
 * Topic-continuity may later act as a VETO on top of this — never as an
 * independent enabler. Deliberately conservative and deterministic; promote
 * to a classifier only if the replay set shows material missed follow-ups.
 */
export function needsPriorContext(prompt: string): PriorContextDecision {
  const trimmed = normalizePrompt(prompt);
  const contentTokens = countContentTokens(trimmed);

  if (CONVERSATION_BACKREF.test(trimmed)) {
    return { enabled: true, reason: "conversation-backref" };
  }
  // A STRONG continuation move that points BACK at prior content ("go deeper
  // on that …", "expand on this …", "more about that …") depends on the
  // earlier turns no matter how much elaboration follows — the content-token
  // count must NOT veto it (codex turn-16: a detailed "go deeper on that" is
  // a follow-up, not a fresh question — the required doc was starved from the
  // pool because the prior leg never fired). Restricted to STRONG moves only
  // (codex turn-17): a weak opener plus a preposition+determiner+noun ("now
  // write a security report about this authentication middleware…") is a
  // self-contained imperative, so weak now/so/and forms stay behind the
  // content threshold below.
  if (STRONG_CONTINUATION_MOVE.test(trimmed) && DEICTIC_BACKREF_OBJECT.test(trimmed)) {
    return { enabled: true, reason: "continuation-deictic" };
  }
  if (CONTINUATION_OPENERS.test(trimmed) && contentTokens < 8) {
    return { enabled: true, reason: "continuation-opener" };
  }
  if (ANAPHORA_MARKERS.test(trimmed) && contentTokens < 6) {
    return { enabled: true, reason: "anaphora-low-content" };
  }
  if (contentTokens < 3) {
    return { enabled: true, reason: "underspecified" };
  }
  return { enabled: false, reason: "self-sufficient" };
}

// =============================================================================
// Noise Filter — Post-retrieval result filtering
// =============================================================================

// Agent denial patterns (filter from retrieved results)
const DENIAL_PATTERNS = [
  /i don'?t have (any )?(information|data|memory|record)/i,
  /i'?m not sure about/i,
  /i don'?t recall/i,
  /i don'?t remember/i,
  /no (relevant )?memories found/i,
  /i don'?t have access to/i,
];

/**
 * Check if a retrieved memory snippet is noise that should be filtered.
 * Use on search results before injection, NOT on indexed documents.
 */
export function isRetrievedNoise(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length < 10) return true;
  if (DENIAL_PATTERNS.some(p => p.test(trimmed))) return true;
  return false;
}
