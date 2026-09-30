/**
 * OpenClaw prompt cleaning, dependency-free so ClawMem's Stop side can import it too (62.1 D1): the surfacing hook
 * receives `cleanPromptForSearch(event.prompt)` and hashes it; pairing a transcript's human entry with that row applies
 * the same function to the entry's text. One definition keeps the two hashes comparable.
 */

/**
 * Strip OpenClaw-specific noise from the user prompt before using it as a
 * search query. Gateway prompts contain metadata, system events, timestamps,
 * and previously injected context that degrade embedding/BM25 quality.
 */
export function cleanPromptForSearch(prompt: string): string {
  let cleaned = prompt;
  // Strip previously injected vault-context (avoid re-searching our own output)
  cleaned = cleaned.replace(/<vault-context>[\s\S]*?<\/vault-context>/g, "");
  cleaned = cleaned.replace(/<vault-routing>[\s\S]*?<\/vault-routing>/g, "");
  cleaned = cleaned.replace(/<vault-session>[\s\S]*?<\/vault-session>/g, "");
  // Strip OpenClaw sender metadata block
  cleaned = cleaned.replace(/Sender\s*\(untrusted metadata\)\s*:\s*```json\n[\s\S]*?```/g, "");
  cleaned = cleaned.replace(/Sender\s*\(untrusted metadata\)\s*:\s*\{[\s\S]*?\}\s*/g, "");
  // Strip OpenClaw runtime context blocks
  cleaned = cleaned.replace(/OpenClaw runtime context \(internal\):[\s\S]*?(?=\n\n|\n?$)/g, "");
  // Strip "System: ..." single-line event entries
  cleaned = cleaned.replace(/^System:.*$/gm, "");
  // Strip timestamp prefixes e.g. "[Sat 2026-03-14 16:19 GMT+8] "
  cleaned = cleaned.replace(/^\[.*?GMT[+-]\d+\]\s*/gm, "");
  // Collapse excessive whitespace
  cleaned = cleaned.replace(/\n{3,}/g, "\n\n").trim();
  return cleaned || prompt;
}
