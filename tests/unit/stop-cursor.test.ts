/**
 * 62.1 D2: the durable transcript cursor (design tests 20, 38 at the reader layer; the hooks' use of it is tested with
 * D4-D6).
 *
 * Baseline (8e2579a): every Stop re-reads the last 200 entries (`readTranscriptTurns`, `readTranscript`), so the same
 * turns are re-processed by every Stop and a long turn silently falls out of the window. There is no cursor, no file
 * identity and no byte offset: a replaced or truncated transcript is indistinguishable from an appended one.
 */
import { describe, it, expect, afterEach } from "bun:test";
import { createHash } from "crypto";
import { mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createTestStore } from "../helpers/test-store.ts";
import {
  T0, human, assistant, toolResult, meta, command, localStdout, ocMessage,
  writeTranscriptFile, appendEntries, lineStarts, serialize,
} from "./stop-fixtures.ts";

const sha256 = (s: string | Buffer) => createHash("sha256").update(s).digest("hex");
const cursorMod = () => import("../../src/stop-cursor.ts");

const dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "clawmem-621-cursor-"));
  dirs.push(d);
  return d;
}
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }); });

describe("D2 readLines: complete lines with exact byte offsets", () => {
  it("returns every complete line with its offsets, sha and timestamp; a partial trailing line is left for later", async () => {
    const { readLines } = await cursorMod();
    const path = writeTranscriptFile(tmp(), "s.jsonl", [human("first question please", 100), assistant("an answer", 110)]);
    writeFileSync(path, readFileSync(path, "utf8") + '{"type":"user","message":{"role":"user","content":"half-writ', "utf8");
    const starts = lineStarts(path);
    const raw = readFileSync(path);
    const r = readLines(path, 0);
    expect(r.lines.length).toBe(2);
    expect(r.lines.map(l => l.start)).toEqual([starts[0]!, starts[1]!]);
    expect(r.lines[1]!.end).toBe(starts[2]!);
    expect(r.next).toBe(starts[2]!);
    expect(r.lines[0]!.sha).toBe(sha256(raw.subarray(starts[0]!, starts[1]! - 1)));
    expect(r.lines[0]!.kind).toBe("human");
    expect(r.lines[0]!.text).toBe("first question please");
    expect(r.lines[0]!.ts).toBe(T0 + 100);
    expect(r.lines[1]!.kind).toBe("assistant");
  });

  it("reads OpenClaw lines: the line-level timestamp, else the message's epoch ms", async () => {
    const { readLines } = await cursorMod();
    const noLineTs = { type: "message", message: { role: "user", content: [{ type: "text", text: "hello there" }], timestamp: T0 + 7 } };
    const path = writeTranscriptFile(tmp(), "oc.jsonl", [ocMessage("user", "what is the plan", 50), noLineTs]);
    const r = readLines(path, 0);
    expect(r.lines.map(l => [l.kind, l.ts])).toEqual([["human", T0 + 50], ["human", T0 + 7]]);
  });

  it("bounds a read by bytes; the next read resumes exactly where it stopped", async () => {
    const { readLines } = await cursorMod();
    const path = writeTranscriptFile(tmp(), "s.jsonl", [human("q one here", 1), assistant("a1", 2), human("q two here", 3), assistant("a2", 4)]);
    const starts = lineStarts(path);
    const first = readLines(path, 0, { maxBytes: starts[2]! + 1 });   // room for two lines, not three
    expect(first.lines.length).toBe(2);
    expect(first.next).toBe(starts[2]!);
    expect(first.eof).toBe(false);
    const second = readLines(path, first.next);
    expect(second.lines.map(l => l.start)).toEqual([starts[2]!, starts[3]!]);
    expect(second.eof).toBe(true);
  });

  it("a single line larger than the bound is passed over as meta, so the cursor can still advance", async () => {
    const { readLines } = await cursorMod();
    const path = writeTranscriptFile(tmp(), "s.jsonl", [assistant("x".repeat(5000), 1), human("after the big one", 2)]);
    const r = readLines(path, 0, { maxBytes: 1000 });
    expect(r.lines.length).toBe(1);
    expect(r.lines[0]!.kind).toBe("meta");
    expect(r.lines[0]!.oversized).toBe(true);
    expect(r.next).toBe(lineStarts(path)[1]!);
    expect(readLines(path, r.next, { maxBytes: 1000 }).lines[0]!.text).toBe("after the big one");
  });
});

describe("D2 the local-command rule across batches (test 20)", () => {
  it("a trailing built-in command record waits for its successor; with its local output it is meta, not a human turn", async () => {
    const { readLines } = await cursorMod();
    const path = writeTranscriptFile(tmp(), "s.jsonl", [human("real question here", 1), assistant("answer", 2), command("/model", "sonnet", 3)]);
    const starts = lineStarts(path);
    const r1 = readLines(path, 0);
    expect(r1.lines.length).toBe(2);          // the command record is held back …
    expect(r1.next).toBe(starts[2]!);          // … and the read ends before it
    appendEntries(path, [localStdout("Set model to sonnet", 4)]);
    const r2 = readLines(path, r1.next);
    expect(r2.lines.map(l => l.kind)).toEqual(["meta", "meta"]);
  });

  it("a prompt command followed by the assistant is a human turn carrying its task", async () => {
    const { readLines } = await cursorMod();
    const path = writeTranscriptFile(tmp(), "s.jsonl", [command("/review", "the diff", 1), assistant("reviewing", 2)]);
    const r = readLines(path, 0);
    expect(r.lines[0]!.kind).toBe("human");
    expect(r.lines[0]!.text).toBe("/review the diff");
  });
});

describe("D2 segmentTurns", () => {
  it("splits at human lines; lines before the first human continue the previous turn; completeness is explicit", async () => {
    const { readLines, segmentTurns } = await cursorMod();
    const path = writeTranscriptFile(tmp(), "s.jsonl", [
      assistant("continuing the earlier turn", 1), human("second question", 2), assistant("a2", 3), toolResult("t1", "ok", 4),
      assistant("a2b", 5), human("third question", 6), assistant("a3", 7),
    ]);
    const { lines } = readLines(path, 0);
    const atStop = segmentTurns(lines, { trailingComplete: true });
    expect(atStop.map(s => [s.humanIndex, s.lines.length, s.complete])).toEqual([[null, 1, true], [1, 4, true], [5, 2, true]]);
    const noStop = segmentTurns(lines, { trailingComplete: false });
    expect(noStop[2]!.complete).toBe(false);
    expect(noStop[1]!.start).toBe(lines[1]!.start);
    expect(noStop[1]!.end).toBe(lines[4]!.end);
  });
});

describe("D2 where a hook's read starts: cursor, fresh anchor, or re-anchor", () => {
  function transcript(dir: string) {
    return writeTranscriptFile(dir, "s.jsonl", [
      human("turn one question", 10), assistant("a1", 11), meta("expansion", 12),
      human("turn two question", 20), assistant("a2", 21), command("/model", "opus", 22), localStdout("Set model", 23),
    ]);
  }

  it("without a cursor the read anchors at the current turn's start (the last human entry, not a local command)", async () => {
    const { resolveCursorStart } = await cursorMod();
    const store = createTestStore();
    const path = transcript(tmp());
    const start = resolveCursorStart(store.db, "s", "decision-extractor", "k", path)!;
    expect(start.reason).toBe("fresh");
    expect(start.anchorEpoch).toBe(0);
    expect(start.start).toBe(lineStarts(path)[3]!);
  });

  it("a valid cursor is resumed at its byte offset; advancing it is a CAS on the position it was read at", async () => {
    const { resolveCursorStart, casAdvanceCursor, readStopCursor, readLines } = await cursorMod();
    const store = createTestStore();
    const path = transcript(tmp());
    const s0 = resolveCursorStart(store.db, "s", "decision-extractor", "k", path)!;
    const { lines, next } = readLines(path, s0.start);
    const advance = {
      transcriptPath: path, file: s0.file, anchorEpoch: s0.anchorEpoch, byteOffset: next, tailSha: lines.at(-1)!.sha,
      turnStartOffset: s0.start, humanTurns: 1,
    };
    store.db.exec("BEGIN IMMEDIATE");
    expect(casAdvanceCursor(store.db, "s", "decision-extractor", "k", null, advance)).toBe(true);
    store.db.exec("COMMIT");
    // A second writer that read "no cursor" too loses the CAS.
    expect(casAdvanceCursor(store.db, "s", "decision-extractor", "k", null, advance)).toBe(false);

    appendEntries(path, [human("turn three question", 30), assistant("a3", 31)]);
    const s1 = resolveCursorStart(store.db, "s", "decision-extractor", "k", path)!;
    expect(s1.reason).toBe("cursor");
    expect(s1.start).toBe(next);
    const cur = readStopCursor(store.db, "s", "decision-extractor", "k")!;
    const r = readLines(path, s1.start);
    const moved = { ...advance, byteOffset: r.next, tailSha: r.lines.at(-1)!.sha, humanTurns: 2 };
    expect(casAdvanceCursor(store.db, "s", "decision-extractor", "k", cur, moved)).toBe(true);
    // The stale read (the old cursor) cannot move it again.
    expect(casAdvanceCursor(store.db, "s", "decision-extractor", "k", cur, moved)).toBe(false);
    // Cursors are per hook and per transcript key.
    expect(readStopCursor(store.db, "s", "handoff-generator", "k")).toBeNull();
    expect(readStopCursor(store.db, "s", "decision-extractor", "other-key")).toBeNull();
  });

  async function cursorAtEnd(store: ReturnType<typeof createTestStore>, path: string) {
    const { resolveCursorStart, casAdvanceCursor, readLines } = await cursorMod();
    const s0 = resolveCursorStart(store.db, "s", "decision-extractor", "k", path)!;
    const r = readLines(path, 0);
    casAdvanceCursor(store.db, "s", "decision-extractor", "k", null, {
      transcriptPath: path, file: s0.file, anchorEpoch: s0.anchorEpoch, byteOffset: r.next, tailSha: r.lines.at(-1)!.sha,
      turnStartOffset: s0.start, humanTurns: 2,
    });
  }

  it("truncation, a rewritten tail line and a changed first line each re-anchor with anchor_epoch + 1", async () => {
    const { resolveCursorStart } = await cursorMod();
    const cases: [string, (path: string) => void][] = [
      ["truncated", p => writeFileSync(p, readFileSync(p).subarray(0, lineStarts(p)[4]!))],
      ["tail rewritten", p => {
        const buf = readFileSync(p, "utf8");
        const out = buf.replace("Set model", "Set MODEL");   // the last line only, same length
        expect(out).not.toBe(buf);
        writeFileSync(p, out);
      }],
      ["first line changed", p => {
        const buf = readFileSync(p, "utf8");
        const out = buf.replace("turn one question", "turn 1 question!!");
        expect(out).not.toBe(buf);
        writeFileSync(p, out);
      }],
    ];
    for (const [name, mutate] of cases) {
      const store = createTestStore();
      const path = transcript(tmp());
      await cursorAtEnd(store, path);
      mutate(path);
      const s = resolveCursorStart(store.db, "s", "decision-extractor", "k", path)!;
      expect(`${name}:${s.reason}:${s.anchorEpoch}`).toBe(`${name}:re-anchor:1`);
    }
  });

  it("a new inode at the same path with identical bytes re-anchors (test 38)", async () => {
    const { resolveCursorStart } = await cursorMod();
    const store = createTestStore();
    const dir = tmp();
    const path = transcript(dir);
    await cursorAtEnd(store, path);
    const replacement = join(dir, "replacement.jsonl");
    writeFileSync(replacement, readFileSync(path));
    renameSync(replacement, path);
    const s = resolveCursorStart(store.db, "s", "decision-extractor", "k", path)!;
    expect(s.reason).toBe("re-anchor");
    expect(s.anchorEpoch).toBe(1);
    expect(s.start).toBe(lineStarts(path)[3]!);   // the current turn only
  });
});

describe("D2 byte-range identity", () => {
  it("rangeSha hashes exactly the bytes of a range; lineShaEndingAt the line that ends at an offset", async () => {
    const { rangeSha, lineShaEndingAt, EMPTY_LINE_SHA } = await cursorMod();
    const entries = [human("q one here", 1), assistant("a1", 2), human("q two here", 3)];
    const path = writeTranscriptFile(tmp(), "s.jsonl", entries);
    const starts = lineStarts(path);
    const raw = readFileSync(path);
    expect(rangeSha(path, starts[1]!, starts[2]!)).toBe(sha256(raw.subarray(starts[1]!, starts[2]!)));
    expect(lineShaEndingAt(path, starts[2]!)).toBe(sha256(raw.subarray(starts[1]!, starts[2]! - 1)));
    expect(lineShaEndingAt(path, 0)).toBe(EMPTY_LINE_SHA);
    expect(lineShaEndingAt(path, starts[1]! + 3)).toBeNull();   // not a line boundary
    expect(serialize(entries).length).toBe(raw.length);
  });
});
