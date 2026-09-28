/**
 * Claude Code transcript fixtures for the 62.2 compaction tests.
 *
 * Every builder mirrors a user-/assistant-entry shape counted in a real Claude Code session JSONL
 * (DESIGN-62.2 §1): human prompts as a string or text blocks, tool results as user-role
 * `tool_result` lists carrying `toolUseResult`, `isMeta` expansions, slash-command and
 * local-command wrappers, task notifications, interrupt markers and compact summaries.
 */
import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";

type Entry = Record<string, unknown>;

let seq = 0;
const uuid = () => `00000000-0000-4000-8000-${String(++seq).padStart(12, "0")}`;

export const human = (text: string): Entry =>
  ({ type: "user", uuid: uuid(), message: { role: "user", content: text } });

export const humanBlocks = (text: string): Entry =>
  ({ type: "user", uuid: uuid(), message: { role: "user", content: [{ type: "text", text }] } });

export const assistant = (text: string, toolUses: { id: string; name: string; input: Record<string, unknown> }[] = []): Entry => ({
  type: "assistant",
  uuid: uuid(),
  message: {
    role: "assistant",
    content: [
      { type: "text", text },
      ...toolUses.map(t => ({ type: "tool_use", id: t.id, name: t.name, input: t.input })),
    ],
  },
});

export const toolResult = (toolUseId: string, text: string): Entry => ({
  type: "user",
  uuid: uuid(),
  message: { role: "user", content: [{ type: "tool_result", tool_use_id: toolUseId, content: text }] },
  toolUseResult: { stdout: text, stderr: "", interrupted: false },
});

export const meta = (text: string): Entry =>
  ({ type: "user", uuid: uuid(), isMeta: true, message: { role: "user", content: text } });

export const command = (name: string, args = ""): Entry => ({
  type: "user",
  uuid: uuid(),
  message: {
    role: "user",
    content: `<command-name>${name}</command-name>\n            <command-message>${name.replace(/^\//, "")}</command-message>\n            <command-args>${args}</command-args>`,
  },
});

export const localStdout = (text: string): Entry =>
  ({ type: "user", uuid: uuid(), message: { role: "user", content: `<local-command-stdout>${text}</local-command-stdout>` } });

export const taskNotification = (text: string): Entry => ({
  type: "user",
  uuid: uuid(),
  message: { role: "user", content: `<task-notification> <task-id>bx1</task-id> <status>completed</status> <summary>${text}</summary> </task-notification>` },
});

export const interrupt = (): Entry =>
  ({ type: "user", uuid: uuid(), message: { role: "user", content: [{ type: "text", text: "[Request interrupted by user]" }] } });

export const compactSummary = (text: string): Entry =>
  ({ type: "user", uuid: uuid(), isCompactSummary: true, isVisibleInTranscriptOnly: true, message: { role: "user", content: text } });

/** Write entries as a JSONL transcript at <projectDir>/<sessionId>.jsonl and return its path. */
export function writeTranscript(projectDir: string, sessionId: string, entries: Entry[]): string {
  mkdirSync(projectDir, { recursive: true });
  const path = join(projectDir, `${sessionId}.jsonl`);
  writeFileSync(path, entries.map(e => JSON.stringify({ ...e, sessionId })).join("\n") + "\n", "utf-8");
  return path;
}
