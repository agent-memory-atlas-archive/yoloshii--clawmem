/**
 * 62.2 CM-05 — `clawmem setup hooks` gives `postcompact-inject` its own SessionStart group with
 * matcher "compact". Bug-first: v0.39.1 installed `[postcompact-inject, curator-nudge]` in ONE group
 * with matcher "", so the post-compaction hook ran on every session start (the default-install
 * vector for CM-01). Runs the real CLI in a subprocess with an isolated HOME.
 */
import { describe, it, expect } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const ROOT = join(import.meta.dir, "../..");

function run(home: string, ...args: string[]): { exitCode: number; stderr: string } {
  const env = { ...process.env } as Record<string, string>;
  env.HOME = home;
  delete env.CLAWMEM_HOOK_BUDGET_MS;
  const proc = Bun.spawnSync([process.execPath, "src/clawmem.ts", "setup", "hooks", ...args], { env, cwd: ROOT });
  return { exitCode: proc.exitCode, stderr: proc.stderr.toString() };
}

type Group = { matcher?: string; hooks?: { type?: string; command?: string; timeout?: number }[] };
const settingsOf = (home: string) => JSON.parse(readFileSync(join(home, ".claude", "settings.json"), "utf-8"));
// A ClawMem hook is "<…clawmem…> hook <name>"; a foreign script whose name contains "clawmem" is not one.
// Written independently of src/hook-settings.ts: [ENV=v …] [timeout N] <clawmem | …/clawmem> hook <name>.
const isClawmemHook = (command?: string) =>
  /^\s*(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)*(?:timeout\s+\d+\s+)?(?:\S*\/)?clawmem\s+hook\s+[a-z-]+\s*$/.test(command ?? "");
const clawmemGroups = (groups: Group[] | undefined) =>
  (groups ?? []).filter(g => g.hooks?.some(h => isClawmemHook(h.command)));
const hookNames = (g: Group) => (g.hooks ?? []).map(h => (h.command ?? "").split(" hook ")[1]);

function withHome(fn: (home: string) => void) {
  const home = mkdtempSync(join(tmpdir(), "clawmem-622-hooks-"));
  try {
    mkdirSync(join(home, ".claude"), { recursive: true });
    fn(home);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

function expectCompactLayout(home: string) {
  const ss = clawmemGroups(settingsOf(home).hooks?.SessionStart);
  expect(ss.length).toBe(2);
  const compact = ss.find(g => g.matcher === "compact");
  const every = ss.find(g => g.matcher === "");
  expect(compact && hookNames(compact)).toEqual(["postcompact-inject"]);
  expect(every && hookNames(every)).toEqual(["curator-nudge"]);
}

describe("62.2 CM-05 — SessionStart layout written by setup hooks", () => {
  it("postcompact-inject sits alone under matcher \"compact\"; curator-nudge keeps matcher \"\"", () => {
    withHome(home => {
      expect(run(home).exitCode).toBe(0);
      expectCompactLayout(home);
      // The other events are untouched: one clawmem group each.
      const hooks = settingsOf(home).hooks;
      expect(clawmemGroups(hooks.PreCompact).map(hookNames)).toEqual([["precompact-extract"]]);
      expect(clawmemGroups(hooks.UserPromptSubmit).map(hookNames)).toEqual([["context-surfacing"]]);
      expect(clawmemGroups(hooks.Stop).map(hookNames)).toEqual([["decision-extractor", "handoff-generator", "feedback-loop"]]);
    });
  });

  it("re-installing is idempotent: still exactly the two SessionStart groups", () => {
    withHome(home => {
      expect(run(home).exitCode).toBe(0);
      expect(run(home).exitCode).toBe(0);
      expect(run(home).exitCode).toBe(0);
      expectCompactLayout(home);
    });
  });

  it("installing over the v0.39 combined group migrates it and keeps a foreign SessionStart hook", () => {
    withHome(home => {
      writeFileSync(join(home, ".claude", "settings.json"), JSON.stringify({
        hooks: {
          SessionStart: [
            { matcher: "", hooks: [
              { type: "command", command: "/old/bin/clawmem hook postcompact-inject", timeout: 5 },
              { type: "command", command: "/old/bin/clawmem hook curator-nudge", timeout: 5 },
            ] },
            { matcher: "startup", hooks: [{ type: "command", command: "/usr/local/bin/my-own-hook", timeout: 3 }] },
          ],
        },
      }, null, 2));
      expect(run(home).exitCode).toBe(0);
      expectCompactLayout(home);
      const all = settingsOf(home).hooks.SessionStart as Group[];
      expect(all.filter(g => g.hooks?.some(h => h.command === "/usr/local/bin/my-own-hook")).length).toBe(1);
      expect(all.some(g => g.hooks?.some(h => h.command?.startsWith("/old/bin/clawmem")))).toBe(false);
    });
  });

  it("--remove clears both SessionStart groups and leaves the foreign hook", () => {
    withHome(home => {
      expect(run(home).exitCode).toBe(0);
      const s = settingsOf(home);
      s.hooks.SessionStart.push({ matcher: "startup", hooks: [{ type: "command", command: "/usr/local/bin/my-own-hook", timeout: 3 }] });
      writeFileSync(join(home, ".claude", "settings.json"), JSON.stringify(s, null, 2));
      expect(run(home, "--remove").exitCode).toBe(0);
      const after = settingsOf(home).hooks;
      expect(clawmemGroups(after.SessionStart).length).toBe(0);
      expect((after.SessionStart as Group[]).length).toBe(1);
    });
  });
});

describe("62.2 (codex T1 #4) — ClawMem's handlers are removed, a foreign hook in the same group is kept", () => {
  const mixed = () => ({
    hooks: {
      SessionStart: [
        { matcher: "", hooks: [
          { type: "command", command: "/old/bin/clawmem hook postcompact-inject", timeout: 5 },
          { type: "command", command: "/usr/local/bin/my-own-hook", timeout: 3 },
          { type: "command", command: "/usr/local/bin/clawmem-backup.sh hook postcompact-inject", timeout: 3 },
          { type: "command", command: "echo clawmem hook postcompact-inject", timeout: 1 },
          { type: "command", command: "timeout 10 /old/bin/clawmem hook precompact-extract", timeout: 5 },
          { type: "command", command: "/old/bin/clawmem hook curator-nudge", timeout: 5 },
        ] },
      ],
      Stop: [
        { matcher: "", hooks: [
          { type: "command", command: "/old/bin/clawmem hook feedback-loop", timeout: 30 },
          { type: "command", command: "/usr/local/bin/clawmem-backup.sh", timeout: 10 },
        ] },
      ],
    },
  });
  const foreignGroups = (home: string, event: string) =>
    ((settingsOf(home).hooks?.[event] ?? []) as Group[]).filter(g => g.hooks?.some(h => !isClawmemHook(h.command)));

  it("install over a mixed group keeps the foreign handler with its group's matcher; reinstall is stable", () => {
    withHome(home => {
      writeFileSync(join(home, ".claude", "settings.json"), JSON.stringify(mixed(), null, 2));
      expect(run(home).exitCode).toBe(0);
      expect(run(home).exitCode).toBe(0);
      expectCompactLayout(home);
      const ss = foreignGroups(home, "SessionStart");
      expect(ss.length).toBe(1);
      expect(ss[0]!.matcher).toBe("");
      expect(ss[0]!.hooks!.map(h => h.command)).toEqual([
        "/usr/local/bin/my-own-hook",
        "/usr/local/bin/clawmem-backup.sh hook postcompact-inject", // same subcommand words, foreign executable
        "echo clawmem hook postcompact-inject",                      // same words, not an invocation of ClawMem
      ]); // the 2026-03 installer's `timeout 10 … hook precompact-extract` WAS ClawMem's, and is gone
      // A foreign command whose NAME contains "clawmem" is not a ClawMem hook.
      const stop = foreignGroups(home, "Stop");
      expect(stop.flatMap(g => g.hooks!.map(h => h.command))).toEqual(["/usr/local/bin/clawmem-backup.sh"]);
      expect(clawmemGroups(settingsOf(home).hooks.Stop).map(hookNames)).toEqual([["decision-extractor", "handoff-generator", "feedback-loop"]]);
    });
  });

  it("--remove over a mixed group keeps the foreign handlers", () => {
    withHome(home => {
      writeFileSync(join(home, ".claude", "settings.json"), JSON.stringify(mixed(), null, 2));
      expect(run(home, "--remove").exitCode).toBe(0);
      const after = settingsOf(home).hooks;
      expect((after.SessionStart as Group[]).flatMap(g => g.hooks!.map(h => h.command))).toEqual([
        "/usr/local/bin/my-own-hook",
        "/usr/local/bin/clawmem-backup.sh hook postcompact-inject",
        "echo clawmem hook postcompact-inject",
      ]);
      expect((after.Stop as Group[]).flatMap(g => g.hooks!.map(h => h.command))).toEqual(["/usr/local/bin/clawmem-backup.sh"]);
    });
  });
});
