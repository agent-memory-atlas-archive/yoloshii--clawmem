/**
 * 62.1 transcript fixtures: the 62.2 Claude Code entry shapes (compaction-fixtures.ts) plus the entry timestamps the
 * pairing rule and the cursor read, and OpenClaw-shaped message entries (line-level ISO timestamp, message-level
 * epoch ms). Files are written byte-exact so tests can reason about offsets.
 */
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import * as cc from "./compaction-fixtures.ts";

export type Entry = Record<string, unknown>;

/** A fixed epoch base: fixture times are small offsets from it, so orderings read plainly in tests. */
export const T0 = Date.parse("2026-09-30T10:00:00.000Z");
export const iso = (offsetMs: number) => new Date(T0 + offsetMs).toISOString();

const at = (e: Entry, offsetMs: number | null): Entry => (offsetMs === null ? e : { ...e, timestamp: iso(offsetMs) });

// Claude Code shapes, timestamped (null = the entry carries no timestamp).
export const human = (text: string, t: number | null): Entry => at(cc.human(text), t);
export const assistant = (text: string, t: number | null, toolUses: { id: string; name: string; input: Record<string, unknown> }[] = []): Entry =>
  at(cc.assistant(text, toolUses), t);
export const toolResult = (id: string, text: string, t: number | null): Entry => at(cc.toolResult(id, text), t);
export const meta = (text: string, t: number | null): Entry => at(cc.meta(text), t);
export const command = (name: string, args: string, t: number | null): Entry => at(cc.command(name, args), t);
export const localStdout = (text: string, t: number | null): Entry => at(cc.localStdout(text), t);

/** Claude Code's record that a Stop fired (written even when a Stop hook fails). */
export const stopMarker = (t: number | null): Entry => at({
  type: "system", subtype: "stop_hook_summary", hookCount: 1, hookInfos: [], hookErrors: [], preventedContinuation: false,
  stopReason: "", hasOutput: false, level: "suggestion",
}, t);

/** An OpenClaw session line: line-level ISO timestamp, message-level epoch ms. */
export const ocMessage = (role: "user" | "assistant", text: string, t: number): Entry => ({
  type: "message",
  timestamp: iso(t),
  message: { role, content: [{ type: "text", text }], timestamp: T0 + t },
});

export function serialize(entries: Entry[]): string {
  return entries.map(e => JSON.stringify(e)).join("\n") + (entries.length ? "\n" : "");
}

export function writeTranscriptFile(dir: string, name: string, entries: Entry[]): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  writeFileSync(path, serialize(entries), "utf-8");
  return path;
}

export function appendEntries(path: string, entries: Entry[]): void {
  appendFileSync(path, serialize(entries), "utf-8");
}

/** Byte offset where each line of the file starts. */
export function lineStarts(path: string): number[] {
  const buf = readFileSync(path);
  const starts = [0];
  for (let i = 0; i < buf.length; i++) if (buf[i] === 0x0a && i + 1 < buf.length) starts.push(i + 1);
  return starts;
}
