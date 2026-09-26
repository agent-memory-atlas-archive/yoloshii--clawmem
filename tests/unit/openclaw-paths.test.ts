/**
 * Unit tests for src/openclaw-paths.ts (§28.1, issue #11).
 *
 * Covers the CLI-absent fallback resolver semantics + printSetupOpenClawHelp
 * output. These helpers are pure (take injected env + homedir) so we don't
 * need to touch process.env at all for U1-U7.
 *
 * U8 captures stdout from printSetupOpenClawHelp — uses console.log
 * monkey-patching scoped to the test, restored in afterEach.
 *
 * Source-text regression gates for the rewritten cmdSetupOpenClaw live in
 * tests/integration/setup-openclaw.integration.test.ts (which exercises the
 * actual CLI surface via subprocess + stub binary).
 */

import { afterEach, describe, expect, test } from "bun:test";
import { resolve as pathResolve } from "node:path";

import {
  expandHome,
  printSetupOpenClawHelp,
  resolveExtensionsDirNoOpenClaw,
  resolveHomeForOpenClaw,
  trim,
} from "../../src/openclaw-paths.ts";
import { canExecuteAs, canReadAs, moveTargetAside, pluginFilesOpenClawReads, resolveOpenClawProfile, resolveRecordableClawmemBin, swapDirIntoPlace, unreadablePluginFiles } from "../../src/openclaw-paths.ts";

const STATIC_HOME = "/home/test-user";
const staticHomedir = () => STATIC_HOME;

describe("§28.1 trim — home-resolution env value normalization", () => {
  test("returns undefined for empty / whitespace / 'undefined' / 'null'", () => {
    expect(trim(undefined)).toBeUndefined();
    expect(trim("")).toBeUndefined();
    expect(trim("   ")).toBeUndefined();
    expect(trim("\t")).toBeUndefined();
    // "undefined" / "null" literal strings are filtered (matches OpenClaw's
    // home-dir.ts normalize for OPENCLAW_HOME / HOME / USERPROFILE)
    expect(trim("undefined")).toBeUndefined();
    expect(trim("null")).toBeUndefined();
  });
  test("returns trimmed value for real strings", () => {
    expect(trim("  /tmp/foo  ")).toBe("/tmp/foo");
    expect(trim("/tmp/foo")).toBe("/tmp/foo");
  });
});

describe("§28.1 U1 — default extensions dir with empty env", () => {
  test("returns <home>/.openclaw/extensions when no env vars set", () => {
    const result = resolveExtensionsDirNoOpenClaw({
      env: {},
      homedir: staticHomedir,
    });
    expect(result).toBe(pathResolve(STATIC_HOME, ".openclaw", "extensions"));
  });
});

describe("§28.1 U2 — OPENCLAW_STATE_DIR override", () => {
  test("returns <STATE_DIR>/extensions when set", () => {
    const result = resolveExtensionsDirNoOpenClaw({
      env: { OPENCLAW_STATE_DIR: "/custom/state" },
      homedir: staticHomedir,
    });
    expect(result).toBe(pathResolve("/custom/state", "extensions"));
  });
});

describe("§28.1 U3 — OPENCLAW_CONFIG_PATH precedence", () => {
  test("config root = dirname(config file); extensions hangs off root", () => {
    const result = resolveExtensionsDirNoOpenClaw({
      env: { OPENCLAW_CONFIG_PATH: "/custom/configs/openclaw.json" },
      homedir: staticHomedir,
    });
    expect(result).toBe(pathResolve("/custom/configs", "extensions"));
  });
});

describe("§28.1 U4 — OPENCLAW_STATE_DIR wins over OPENCLAW_CONFIG_PATH", () => {
  test("STATE_DIR takes precedence when both set", () => {
    const result = resolveExtensionsDirNoOpenClaw({
      env: {
        OPENCLAW_STATE_DIR: "/winner",
        OPENCLAW_CONFIG_PATH: "/other/openclaw.json",
      },
      homedir: staticHomedir,
    });
    expect(result).toBe(pathResolve("/winner", "extensions"));
  });
});

describe("§28.1 U5 — tilde expansion in env values", () => {
  test("OPENCLAW_STATE_DIR=~/foo expands against home", () => {
    const result = resolveExtensionsDirNoOpenClaw({
      env: { OPENCLAW_STATE_DIR: "~/foo" },
      homedir: staticHomedir,
    });
    expect(result).toBe(pathResolve(STATIC_HOME, "foo", "extensions"));
  });
  test("bare ~ in OPENCLAW_STATE_DIR expands to home", () => {
    const result = resolveExtensionsDirNoOpenClaw({
      env: { OPENCLAW_STATE_DIR: "~" },
      homedir: staticHomedir,
    });
    expect(result).toBe(pathResolve(STATIC_HOME, "extensions"));
  });
  test("OPENCLAW_CONFIG_PATH tilde expands before dirname", () => {
    const result = resolveExtensionsDirNoOpenClaw({
      env: { OPENCLAW_CONFIG_PATH: "~/profiles/dev/openclaw.json" },
      homedir: staticHomedir,
    });
    expect(result).toBe(pathResolve(STATIC_HOME, "profiles/dev", "extensions"));
  });
  test("expandHome leaves non-home tilde forms untouched (no ~user expansion)", () => {
    expect(
      expandHome("~bob/foo", { env: {}, homedir: staticHomedir }),
    ).toBe("~bob/foo");
  });
});

describe("§28.1 U6 — empty / whitespace state-dir/config-path falls through; literal 'undefined'/'null' do NOT", () => {
  test("OPENCLAW_STATE_DIR='' falls through to default", () => {
    const result = resolveExtensionsDirNoOpenClaw({
      env: { OPENCLAW_STATE_DIR: "" },
      homedir: staticHomedir,
    });
    expect(result).toBe(pathResolve(STATIC_HOME, ".openclaw", "extensions"));
  });
  test("OPENCLAW_STATE_DIR='   ' falls through", () => {
    const result = resolveExtensionsDirNoOpenClaw({
      env: { OPENCLAW_STATE_DIR: "   " },
      homedir: staticHomedir,
    });
    expect(result).toBe(pathResolve(STATIC_HOME, ".openclaw", "extensions"));
  });
  test("OPENCLAW_STATE_DIR='undefined' is treated as a LITERAL directory name (matches OpenClaw resolveConfigDir)", () => {
    // OpenClaw's resolveConfigDir applies only `.trim()` to OPENCLAW_STATE_DIR
    // — it does NOT filter "undefined"/"null" literal strings. ClawMem's
    // fallback resolver mirrors that exactly; diverging here would mean
    // Path 1 (delegation) and Path 3 (fallback) install into different
    // directories for the same env, which is the bug class §28.1 set out
    // to fix.
    const result = resolveExtensionsDirNoOpenClaw({
      env: { OPENCLAW_STATE_DIR: "undefined" },
      homedir: staticHomedir,
    });
    expect(result).toBe(pathResolve("undefined", "extensions"));
  });
  test("OPENCLAW_CONFIG_PATH='null' is treated as a LITERAL config file path", () => {
    const result = resolveExtensionsDirNoOpenClaw({
      env: { OPENCLAW_CONFIG_PATH: "null" },
      homedir: staticHomedir,
    });
    // dirname("null") on POSIX is "."
    expect(result).toBe(pathResolve(".", "extensions"));
  });
});

describe("§28.1 U7 — home resolution priority + cwd fallback", () => {
  test("OPENCLAW_HOME overrides HOME for default path", () => {
    const result = resolveExtensionsDirNoOpenClaw({
      env: { OPENCLAW_HOME: "/openclaw-home", HOME: "/regular-home" },
      homedir: () => "/os-homedir",
    });
    expect(result).toBe(pathResolve("/openclaw-home", ".openclaw", "extensions"));
  });
  test("HOME wins over USERPROFILE when OPENCLAW_HOME is unset", () => {
    const result = resolveExtensionsDirNoOpenClaw({
      env: { HOME: "/posix-home", USERPROFILE: "C:\\Users\\test" },
      homedir: () => "/os-homedir",
    });
    expect(result).toBe(pathResolve("/posix-home", ".openclaw", "extensions"));
  });
  test("USERPROFILE wins over os.homedir() when HOME is unset", () => {
    const result = resolveExtensionsDirNoOpenClaw({
      env: { USERPROFILE: "C:\\Users\\test" },
      homedir: () => "/os-homedir",
    });
    expect(result).toBe(
      pathResolve("C:\\Users\\test", ".openclaw", "extensions"),
    );
  });
  test("os.homedir() is consulted when no env vars set", () => {
    const result = resolveHomeForOpenClaw({
      env: {},
      homedir: () => "/from-os-homedir",
    });
    expect(result).toBe(pathResolve("/from-os-homedir"));
  });
  test("os.homedir() throwing falls through to cwd", () => {
    const result = resolveHomeForOpenClaw({
      env: {},
      homedir: () => {
        throw new Error("homedir unavailable");
      },
    });
    // cwd-resolved path is process.cwd() — assert it's an absolute path
    // and not the empty string. We don't assert exact value because the
    // test runner controls cwd.
    expect(result).toBe(pathResolve(process.cwd()));
  });
  test("OPENCLAW_HOME with leading tilde expands against next priority", () => {
    const result = resolveHomeForOpenClaw({
      env: { OPENCLAW_HOME: "~/profiles", HOME: "/regular-home" },
      homedir: () => "/os-homedir",
    });
    expect(result).toBe(pathResolve("/regular-home", "profiles"));
  });
});

describe("§28.1 U8 — printSetupOpenClawHelp output content", () => {
  let capturedLogs: string[] = [];
  const originalLog = console.log;

  afterEach(() => {
    console.log = originalLog;
    capturedLogs = [];
  });

  test("prints usage line, all flags, and env vars consulted", () => {
    capturedLogs = [];
    console.log = (msg?: any) => {
      capturedLogs.push(typeof msg === "string" ? msg : String(msg));
    };
    printSetupOpenClawHelp();
    const output = capturedLogs.join("\n");

    // Usage line
    expect(output).toContain(
      "clawmem setup openclaw [--link] [--accept-capabilities] [--gateway-user <name>] [--remove] [--help|-h]",
    );

    // All four flags documented
    expect(output).toContain("--link");
    expect(output).toContain("--remove");
    expect(output).toContain("--help, -h");

    // All env vars consulted (matches the four BACKLOG §28.1 docs)
    expect(output).toContain("OPENCLAW_STATE_DIR");
    expect(output).toContain("OPENCLAW_CONFIG_PATH");
    expect(output).toContain("OPENCLAW_HOME");
    expect(output).toContain("HOME / USERPROFILE");

    // Delegation behavior is mentioned (so users understand v0.10.4 change)
    expect(output).toContain("openclaw CLI is on PATH");
    expect(output).toContain("openclaw plugins install");

    // At least one example shows OPENCLAW_STATE_DIR usage
    expect(output).toContain("OPENCLAW_STATE_DIR=~/.openclaw-dev");
  });
});

describe("canExecuteAs — traverse + execute judged for another identity", () => {
  // /home(755 root) /home/u(700 uid 1000) /home/u/bin(755 uid 1000) /home/u/bin/clawmem(755 uid 1000)
  const tree: Record<string, { uid: number; gid: number; mode: number }> = {
    "/": { uid: 0, gid: 0, mode: 0o40755 },
    "/home": { uid: 0, gid: 0, mode: 0o40755 },
    "/home/u": { uid: 1000, gid: 1000, mode: 0o40700 },
    "/home/u/bin": { uid: 1000, gid: 1000, mode: 0o40755 },
    "/home/u/bin/clawmem": { uid: 1000, gid: 1000, mode: 0o100755 },
  };
  const look = (p: string) => { const st = tree[p]; if (!st) throw new Error("ENOENT " + p); return st; };
  const fsx = { statSync: look, lstatSync: look, readlinkSync: (p: string): string => { throw new Error("EINVAL " + p); } };
  test("owner can, a stranger cannot traverse a 700 home, root always can", () => {
    expect(canExecuteAs("/home/u/bin/clawmem", 1000, [1000], fsx)).toBe(true);
    expect(canExecuteAs("/home/u/bin/clawmem", 65534, [65534], fsx)).toBe(false);
    expect(canExecuteAs("/home/u/bin/clawmem", 0, [], fsx)).toBe(true);
  });
  test("group membership grants traverse when the group x bit is set", () => {
    tree["/home/u"] = { uid: 1000, gid: 1000, mode: 0o40750 };
    expect(canExecuteAs("/home/u/bin/clawmem", 2000, [1000], fsx)).toBe(true);
    expect(canExecuteAs("/home/u/bin/clawmem", 2000, [2000], fsx)).toBe(false);
    tree["/home/u"] = { uid: 1000, gid: 1000, mode: 0o40700 };
  });
  test("a missing x bit on the binary itself fails", () => {
    tree["/home/u/bin/clawmem"] = { uid: 1000, gid: 1000, mode: 0o100644 };
    expect(canExecuteAs("/home/u/bin/clawmem", 1000, [1000], fsx)).toBe(false);
    tree["/home/u/bin/clawmem"] = { uid: 1000, gid: 1000, mode: 0o100755 };
  });
  test("root skips traversal but still needs an x bit on the file itself (execve)", () => {
    tree["/home/u/bin/clawmem"] = { uid: 1000, gid: 1000, mode: 0o100644 };
    expect(canExecuteAs("/home/u/bin/clawmem", 0, [], fsx)).toBe(false);
    tree["/home/u/bin/clawmem"] = { uid: 1000, gid: 1000, mode: 0o100755 };
    expect(canExecuteAs("/home/u/bin/clawmem", 0, [], fsx)).toBe(true);
  });
  test("a directory target fails for root and non-root even with every x bit set (execve needs a regular file)", () => {
    tree["/home/u/bin/clawmem"] = { uid: 1000, gid: 1000, mode: 0o40755 };
    expect(canExecuteAs("/home/u/bin/clawmem", 1000, [1000], fsx)).toBe(false);
    expect(canExecuteAs("/home/u/bin/clawmem", 0, [], fsx)).toBe(false);
    tree["/home/u/bin/clawmem"] = { uid: 1000, gid: 1000, mode: 0o100755 };
  });
  test("OPENCLAW_PROFILE maps to ~/.openclaw-<profile>, default/empty to ~/.openclaw", async () => {
    const { resolveExtensionsDirNoOpenClaw } = await import("../../src/openclaw-paths.ts");
    const home = () => "/home/u";
    expect(resolveExtensionsDirNoOpenClaw({ env: { OPENCLAW_PROFILE: "dev" }, homedir: home })).toBe("/home/u/.openclaw-dev/extensions");
    expect(resolveExtensionsDirNoOpenClaw({ env: { OPENCLAW_PROFILE: "default" }, homedir: home })).toBe("/home/u/.openclaw/extensions");
    expect(resolveExtensionsDirNoOpenClaw({ env: {}, homedir: home })).toBe("/home/u/.openclaw/extensions");
    expect(resolveExtensionsDirNoOpenClaw({ env: { OPENCLAW_PROFILE: "dev", OPENCLAW_STATE_DIR: "/x" }, homedir: home })).toBe("/x/extensions");
  });
});

describe("swapDirIntoPlace — the previous entry is parked, restored when the rename in fails", () => {
  function fakeFs(entries: Map<string, "symlink" | "directory" | "file">) {
    const ops: string[] = [];
    const fsx = {
      lstatSync: (p: string) => {
        const k = entries.get(p);
        if (!k) { const e: any = new Error("ENOENT " + p); e.code = "ENOENT"; throw e; }
        return { isSymbolicLink: () => k === "symlink", isDirectory: () => k === "directory" };
      },
      renameSync: (a: string, b: string) => { ops.push(`rename ${a} -> ${b}`); const k = entries.get(a)!; entries.delete(a); entries.set(b, k); },
      rmSync: (p: string, _o: { recursive: boolean; force: boolean }) => { ops.push(`rm ${p}`); entries.delete(p); },
    };
    return { ops, entries, fsx };
  }
  function failRenameIn(f: ReturnType<typeof fakeFs>) {
    const inner = f.fsx.renameSync;
    f.fsx.renameSync = (a: string, b: string) => {
      if (a === "/ext/clawmem.new-1") { f.ops.push(`rename ${a} -> ${b} FAILED`); throw new Error("EXDEV simulated"); }
      inner(a, b);
    };
  }
  const backup = `/ext/clawmem.old-${process.pid}`;
  test("replaces an existing directory and removes the backup afterwards", () => {
    const f = fakeFs(new Map([["/ext/clawmem", "directory"], ["/ext/clawmem.new-1", "directory"]]));
    expect(swapDirIntoPlace("/ext/clawmem.new-1", "/ext/clawmem", f.fsx)).toEqual({ replaced: true, previous: "directory" });
    expect(f.entries.get("/ext/clawmem")).toBe("directory");
    expect(f.entries.has(backup)).toBe(false);
    expect(f.entries.has("/ext/clawmem.new-1")).toBe(false);
    expect(f.ops).toEqual([`rm ${backup}`, `rename /ext/clawmem -> ${backup}`, `rename /ext/clawmem.new-1 -> /ext/clawmem`, `rm ${backup}`]);
  });
  test("a fresh install is a plain rename", () => {
    const f = fakeFs(new Map([["/ext/clawmem.new-1", "directory"]]));
    expect(swapDirIntoPlace("/ext/clawmem.new-1", "/ext/clawmem", f.fsx)).toEqual({ replaced: false, previous: "none" });
    expect(f.ops).toEqual([`rename /ext/clawmem.new-1 -> /ext/clawmem`]);
  });
  test("a stale symlink is parked as the link itself and replaced by the directory", () => {
    const f = fakeFs(new Map([["/ext/clawmem", "symlink"], ["/ext/clawmem.new-1", "directory"]]));
    expect(swapDirIntoPlace("/ext/clawmem.new-1", "/ext/clawmem", f.fsx)).toEqual({ replaced: true, previous: "symlink" });
    expect(f.entries.get("/ext/clawmem")).toBe("directory");
    expect(f.entries.has(backup)).toBe(false);
    expect(f.ops).toEqual([`rm ${backup}`, `rename /ext/clawmem -> ${backup}`, `rename /ext/clawmem.new-1 -> /ext/clawmem`, `rm ${backup}`]);
  });
  test("a regular file at the target is refused before anything moves", () => {
    const f = fakeFs(new Map([["/ext/clawmem", "file"], ["/ext/clawmem.new-1", "directory"]]));
    expect(() => swapDirIntoPlace("/ext/clawmem.new-1", "/ext/clawmem", f.fsx)).toThrow("neither a symlink nor a directory");
    expect(f.ops).toEqual([]);
  });
  test("when the rename in fails the previous directory is restored and the error propagates", () => {
    const f = fakeFs(new Map([["/ext/clawmem", "directory"], ["/ext/clawmem.new-1", "directory"]]));
    failRenameIn(f);
    expect(() => swapDirIntoPlace("/ext/clawmem.new-1", "/ext/clawmem", f.fsx)).toThrow("EXDEV simulated");
    expect(f.entries.get("/ext/clawmem")).toBe("directory");      // the old tree is back
    expect(f.entries.has(backup)).toBe(false);
    expect(f.entries.get("/ext/clawmem.new-1")).toBe("directory"); // the new tree is left for inspection
    expect(f.ops).toEqual([`rm ${backup}`, `rename /ext/clawmem -> ${backup}`, `rename /ext/clawmem.new-1 -> /ext/clawmem FAILED`, `rename ${backup} -> /ext/clawmem`]);
  });
  test("when the rename in fails a parked symlink is put back as the same link", () => {
    const f = fakeFs(new Map([["/ext/clawmem", "symlink"], ["/ext/clawmem.new-1", "directory"]]));
    failRenameIn(f);
    expect(() => swapDirIntoPlace("/ext/clawmem.new-1", "/ext/clawmem", f.fsx)).toThrow("EXDEV simulated");
    expect(f.entries.get("/ext/clawmem")).toBe("symlink");
    expect(f.entries.has(backup)).toBe(false);
    expect(f.ops).toEqual([`rm ${backup}`, `rename /ext/clawmem -> ${backup}`, `rename /ext/clawmem.new-1 -> /ext/clawmem FAILED`, `rename ${backup} -> /ext/clawmem`]);
  });
  test("when the restore also fails an AggregateError carries both errors and names the backup path", () => {
    const f = fakeFs(new Map([["/ext/clawmem", "directory"], ["/ext/clawmem.new-1", "directory"]]));
    const inner = f.fsx.renameSync;
    f.fsx.renameSync = (a: string, b: string) => {
      if (a === "/ext/clawmem.new-1") { f.ops.push(`rename ${a} -> ${b} FAILED`); throw new Error("EXDEV simulated"); }
      if (a === backup) { f.ops.push(`rename ${a} -> ${b} FAILED`); throw new Error("EACCES simulated"); }
      inner(a, b);
    };
    let caught: unknown;
    try { swapDirIntoPlace("/ext/clawmem.new-1", "/ext/clawmem", f.fsx); } catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(AggregateError);
    const agg = caught as AggregateError;
    expect((agg.errors[0] as Error).message).toBe("EXDEV simulated");
    expect((agg.errors[1] as Error).message).toContain("EACCES simulated");
    expect(((agg.errors[1] as Error).cause as Error).message).toBe("EACCES simulated");
    expect(agg.message).toContain(`It remains at ${backup}`);
    expect(agg.message).toContain(`mv ${backup} /ext/clawmem`);
    expect(f.entries.has("/ext/clawmem")).toBe(false);            // the target is empty — the message says so
    expect(f.entries.get(backup)).toBe("directory");              // the previous tree is still there to recover
    expect(f.entries.get("/ext/clawmem.new-1")).toBe("directory");
  });
});

describe("moveTargetAside — a symlink or directory is parked, then discarded or put back", () => {
  function fakeFs(entries: Map<string, "symlink" | "directory" | "file">) {
    const ops: string[] = [];
    const fsx = {
      lstatSync: (p: string) => {
        const k = entries.get(p);
        if (!k) { const e: any = new Error("ENOENT " + p); e.code = "ENOENT"; throw e; }
        return { isSymbolicLink: () => k === "symlink", isDirectory: () => k === "directory" };
      },
      renameSync: (a: string, b: string) => { ops.push(`rename ${a} -> ${b}`); const k = entries.get(a)!; entries.delete(a); entries.set(b, k); },
      rmSync: (p: string, _o: { recursive: boolean; force: boolean }) => { ops.push(`rm ${p}`); entries.delete(p); },
    };
    return { ops, entries, fsx };
  }
  const backup = `/ext/clawmem.old-${process.pid}`;
  test("a directory is parked and discard() deletes the backup", () => {
    const f = fakeFs(new Map([["/ext/clawmem", "directory"]]));
    const aside = moveTargetAside("/ext/clawmem", f.fsx);
    expect(aside.kind).toBe("directory");
    expect(aside.backup).toBe(backup);
    expect(f.entries.has("/ext/clawmem")).toBe(false);
    expect(f.entries.get(backup)).toBe("directory");
    aside.discard();
    expect(f.entries.has(backup)).toBe(false);
    expect(f.ops).toEqual([`rm ${backup}`, `rename /ext/clawmem -> ${backup}`, `rm ${backup}`]);
  });
  test("a symlink is parked as the link itself and restore() puts it back", () => {
    const f = fakeFs(new Map([["/ext/clawmem", "symlink"]]));
    const aside = moveTargetAside("/ext/clawmem", f.fsx);
    expect(aside.kind).toBe("symlink");
    aside.restore();
    expect(f.entries.get("/ext/clawmem")).toBe("symlink");
    expect(f.entries.has(backup)).toBe(false);
    expect(f.ops).toEqual([`rm ${backup}`, `rename /ext/clawmem -> ${backup}`, `rename ${backup} -> /ext/clawmem`]);
  });
  test("an absent target makes restore() and discard() no-ops", () => {
    const f = fakeFs(new Map());
    const aside = moveTargetAside("/ext/clawmem", f.fsx);
    expect(aside.kind).toBe("none");
    aside.restore();
    aside.discard();
    expect(f.ops).toEqual([]);
  });
  test("a regular file is reported as 'other' and never touched", () => {
    const f = fakeFs(new Map([["/ext/clawmem", "file"]]));
    const aside = moveTargetAside("/ext/clawmem", f.fsx);
    expect(aside.kind).toBe("other");
    aside.restore();
    aside.discard();
    expect(f.entries.get("/ext/clawmem")).toBe("file");
    expect(f.ops).toEqual([]);
  });
  test("a failed restore throws naming the backup path so the operator can recover by hand", () => {
    const f = fakeFs(new Map([["/ext/clawmem", "directory"]]));
    const aside = moveTargetAside("/ext/clawmem", f.fsx);
    f.fsx.renameSync = () => { throw new Error("EACCES simulated"); };
    expect(() => aside.restore()).toThrow(`it remains at ${backup}`);
    expect(f.entries.get(backup)).toBe("directory");
  });
});

describe("resolveOpenClawProfile — one grammar for --profile and .openclaw-<profile>", () => {
  test("unset, blank and 'default' select the default profile", () => {
    expect(resolveOpenClawProfile({})).toBeUndefined();
    expect(resolveOpenClawProfile({ OPENCLAW_PROFILE: "" })).toBeUndefined();
    expect(resolveOpenClawProfile({ OPENCLAW_PROFILE: "   " })).toBeUndefined();
    expect(resolveOpenClawProfile({ OPENCLAW_PROFILE: "default" })).toBeUndefined();
    expect(resolveOpenClawProfile({ OPENCLAW_PROFILE: "DEFAULT" })).toBeUndefined();
  });
  test("a valid name is returned trimmed", () => {
    expect(resolveOpenClawProfile({ OPENCLAW_PROFILE: " dev " })).toBe("dev");
    expect(resolveOpenClawProfile({ OPENCLAW_PROFILE: "Team_A-2" })).toBe("Team_A-2");
    expect(resolveOpenClawProfile({ OPENCLAW_PROFILE: "a".repeat(64) })).toBe("a".repeat(64));
  });
  test("separators, dots, spaces, a leading dash and over-long names are refused", () => {
    for (const bad of ["x/../victim", "../victim", "a/b", "a\\b", "..", ".", "bad name!", "-dev", "a".repeat(65)]) {
      expect(() => resolveOpenClawProfile({ OPENCLAW_PROFILE: bad })).toThrow("not a valid OpenClaw profile name");
    }
  });
  test("resolveExtensionsDirNoOpenClaw refuses the name even when OPENCLAW_STATE_DIR decides the directory", () => {
    const home = () => "/home/u";
    expect(() => resolveExtensionsDirNoOpenClaw({ env: { OPENCLAW_PROFILE: "x/../victim" }, homedir: home })).toThrow("not a valid OpenClaw profile name");
    expect(() => resolveExtensionsDirNoOpenClaw({ env: { OPENCLAW_PROFILE: "x/../victim", OPENCLAW_STATE_DIR: "/x" }, homedir: home })).toThrow("not a valid OpenClaw profile name");
  });
});

describe("canReadAs — the gateway identity can traverse to and read the installed plugin", () => {
  // /home(755 root) /home/inst(750 uid 1000) .../clawmem(755) .../dist(755) .../index.js(644)
  const tree: Record<string, { uid: number; gid: number; mode: number }> = {
    "/": { uid: 0, gid: 0, mode: 0o40755 },
    "/home": { uid: 0, gid: 0, mode: 0o40755 },
    "/home/inst": { uid: 1000, gid: 1000, mode: 0o40750 },
    "/home/inst/ext": { uid: 1000, gid: 1000, mode: 0o40755 },
    "/home/inst/ext/clawmem": { uid: 1000, gid: 1000, mode: 0o40755 },
    "/home/inst/ext/clawmem/dist": { uid: 1000, gid: 1000, mode: 0o40755 },
    "/home/inst/ext/clawmem/dist/index.js": { uid: 1000, gid: 1000, mode: 0o100644 },
  };
  const look = (p: string) => { const st = tree[p]; if (!st) throw new Error("ENOENT " + p); return st; };
  const fsx = { statSync: look, lstatSync: look, readlinkSync: (p: string): string => { throw new Error("EINVAL " + p); } };
  const entry = "/home/inst/ext/clawmem/dist/index.js";
  test("the installer can read the entry; a gateway user outside the home's group cannot traverse to it", () => {
    expect(canReadAs(entry, 1000, [1000], fsx)).toBe(true);
    expect(canReadAs(entry, 2000, [2000], fsx)).toBe(false);
    expect(canReadAs("/home/inst/ext/clawmem", 2000, [2000], fsx)).toBe(false);
  });
  test("membership in the home's group grants the traverse; root always reads an existing path", () => {
    expect(canReadAs(entry, 2000, [1000], fsx)).toBe(true);
    expect(canReadAs(entry, 0, [], fsx)).toBe(true);
    expect(canReadAs("/home/inst/ext/clawmem/missing.json", 0, [], fsx)).toBe(false);
  });
  test("an owner-only file is unreadable to others even when every ancestor is open", () => {
    tree["/home/inst"] = { uid: 1000, gid: 1000, mode: 0o40755 };
    tree[entry] = { uid: 1000, gid: 1000, mode: 0o100600 };
    expect(canReadAs(entry, 2000, [2000], fsx)).toBe(false);
    expect(canReadAs(entry, 1000, [1000], fsx)).toBe(true);
    tree[entry] = { uid: 1000, gid: 1000, mode: 0o100644 };
    expect(canReadAs(entry, 2000, [2000], fsx)).toBe(true);
    tree["/home/inst"] = { uid: 1000, gid: 1000, mode: 0o40750 };
  });
  test("a directory target must be searchable as well as readable", () => {
    tree["/home/inst/ext/clawmem"] = { uid: 1000, gid: 1000, mode: 0o40754 };
    tree["/home/inst"] = { uid: 1000, gid: 1000, mode: 0o40755 };
    expect(canReadAs("/home/inst/ext/clawmem", 2000, [2000], fsx)).toBe(false);
    tree["/home/inst/ext/clawmem"] = { uid: 1000, gid: 1000, mode: 0o40755 };
    expect(canReadAs("/home/inst/ext/clawmem", 2000, [2000], fsx)).toBe(true);
    tree["/home/inst"] = { uid: 1000, gid: 1000, mode: 0o40750 };
  });
});

describe("resolveRecordableClawmemBin — setup records only an absolute, regular, executable binary", () => {
  test("a bare name resolves through PATH; an unresolvable name is refused", async () => {
    const { chmodSync, mkdtempSync, rmSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const dir = mkdtempSync(pathResolve(tmpdir(), "clawmem-recordable-"));
    try {
      const exe = pathResolve(dir, "clawmem");
      writeFileSync(exe, "#!/bin/sh\n");
      chmodSync(exe, 0o755);
      expect(resolveRecordableClawmemBin("clawmem", () => exe)).toEqual({ ok: true, path: exe });
      const none = resolveRecordableClawmemBin("clawmem", () => null);
      expect(none.ok).toBe(false);
      if (!none.ok) expect(none.reason).toContain("on PATH");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  test("a non-executable file and a directory are refused; an executable absolute path passes", async () => {
    const { chmodSync, mkdtempSync, rmSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const dir = mkdtempSync(pathResolve(tmpdir(), "clawmem-recordable-"));
    try {
      const plain = pathResolve(dir, "plain");
      writeFileSync(plain, "#!/bin/sh\n");
      chmodSync(plain, 0o644);
      const noexec = resolveRecordableClawmemBin(plain, () => null);
      expect(noexec.ok).toBe(false);
      if (!noexec.ok) expect(noexec.reason).toContain("not executable");
      const asDir = resolveRecordableClawmemBin(dir, () => null);
      expect(asDir.ok).toBe(false);
      if (!asDir.ok) expect(asDir.reason).toContain("not a regular file");
      chmodSync(plain, 0o755);
      expect(resolveRecordableClawmemBin(plain, () => null)).toEqual({ ok: true, path: plain });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("canReadAs / canExecuteAs follow symlinks the way the kernel does (codex v0.39 turn 9)", () => {
  // /public (755 root) holds links into /private (700 uid 1000)
  const tree: Record<string, { uid: number; gid: number; mode: number }> = {
    "/": { uid: 0, gid: 0, mode: 0o40755 },
    "/public": { uid: 0, gid: 0, mode: 0o40755 },
    "/public/plugin": { uid: 0, gid: 0, mode: 0o120777 },
    "/public/rel": { uid: 0, gid: 0, mode: 0o120777 },
    "/public/clawmem": { uid: 0, gid: 0, mode: 0o120777 },
    "/private": { uid: 1000, gid: 1000, mode: 0o40700 },
    "/private/plugin": { uid: 1000, gid: 1000, mode: 0o40755 },
    "/private/plugin/index.js": { uid: 1000, gid: 1000, mode: 0o100644 },
    "/private/bin": { uid: 1000, gid: 1000, mode: 0o40755 },
    "/private/bin/clawmem": { uid: 1000, gid: 1000, mode: 0o100755 },
    "/loop": { uid: 0, gid: 0, mode: 0o40755 },
    "/loop/a": { uid: 0, gid: 0, mode: 0o120777 },
    "/loop/b": { uid: 0, gid: 0, mode: 0o120777 },
  };
  const links: Record<string, string> = {
    "/public/plugin": "/private/plugin",
    "/public/rel": "../private/plugin",
    "/public/clawmem": "/private/bin/clawmem",
    "/loop/a": "/loop/b",
    "/loop/b": "/loop/a",
  };
  const look = (p: string) => { const st = tree[p]; if (!st) throw new Error("ENOENT " + p); return st; };
  const fsx = {
    lstatSync: look,
    statSync: look, // the root branch only; the cases below use non-root identities
    readlinkSync: (p: string): string => { const l = links[p]; if (l === undefined) throw new Error("EINVAL " + p); return l; },
  };
  test("a readable target behind an absolute link into a 0700 directory is unreadable for others", () => {
    expect(canReadAs("/public/plugin/index.js", 2000, [2000], fsx)).toBe(false);
    expect(canReadAs("/public/plugin/index.js", 1000, [1000], fsx)).toBe(true);
  });
  test("a relative link resolves against its own directory and is judged the same way", () => {
    expect(canReadAs("/public/rel/index.js", 2000, [2000], fsx)).toBe(false);
    tree["/private"] = { uid: 1000, gid: 1000, mode: 0o40755 };
    expect(canReadAs("/public/rel/index.js", 2000, [2000], fsx)).toBe(true);
    expect(canReadAs("/public/plugin/index.js", 2000, [2000], fsx)).toBe(true);
    tree["/private"] = { uid: 1000, gid: 1000, mode: 0o40700 };
  });
  test("a binary reached through a link into a 0700 directory is not executable for others", () => {
    expect(canExecuteAs("/public/clawmem", 2000, [2000], fsx)).toBe(false);
    expect(canExecuteAs("/public/clawmem", 1000, [1000], fsx)).toBe(true);
  });
  test("a symlink loop is refused rather than walked forever", () => {
    expect(canReadAs("/loop/a", 1000, [1000], fsx)).toBe(false);
    expect(canExecuteAs("/loop/a", 1000, [1000], fsx)).toBe(false);
  });
});

describe("unreadablePluginFiles — every file OpenClaw reads, a missing one included (codex v0.39 turn 9)", () => {
  const tree: Record<string, { uid: number; gid: number; mode: number }> = {
    "/": { uid: 0, gid: 0, mode: 0o40755 },
    "/ext": { uid: 0, gid: 0, mode: 0o40755 },
    "/ext/clawmem": { uid: 1000, gid: 1000, mode: 0o40755 },
    "/ext/clawmem/dist": { uid: 1000, gid: 1000, mode: 0o40755 },
    "/ext/clawmem/dist/index.js": { uid: 1000, gid: 1000, mode: 0o100644 },
    "/ext/clawmem/openclaw.plugin.json": { uid: 1000, gid: 1000, mode: 0o100644 },
    "/ext/clawmem/package.json": { uid: 1000, gid: 1000, mode: 0o100644 },
  };
  const look = (p: string) => { const st = tree[p]; if (!st) throw new Error("ENOENT " + p); return st; };
  const fsx = { statSync: look, lstatSync: look, readlinkSync: (p: string): string => { throw new Error("EINVAL " + p); } };
  const root = "/ext/clawmem";
  const entry = "/ext/clawmem/dist/index.js";
  test("the list is the root, the entry, the manifest and package.json", () => {
    expect(pluginFilesOpenClawReads(root, entry)).toEqual([root, entry, "/ext/clawmem/openclaw.plugin.json", "/ext/clawmem/package.json"]);
  });
  test("all readable → none reported; each required metadata file absent → that file is reported", () => {
    expect(unreadablePluginFiles(root, entry, 2000, [2000], fsx)).toEqual([]);
    for (const f of ["openclaw.plugin.json", "package.json"]) {
      const p = `/ext/clawmem/${f}`;
      const saved = tree[p]!;
      delete tree[p];
      expect(unreadablePluginFiles(root, entry, 2000, [2000], fsx)).toEqual([p]);
      tree[p] = saved;
    }
  });
  test("a root the identity cannot search hides every file under it", () => {
    tree[root] = { uid: 1000, gid: 1000, mode: 0o40700 };
    expect(unreadablePluginFiles(root, entry, 2000, [2000], fsx)).toEqual(pluginFilesOpenClawReads(root, entry));
    expect(unreadablePluginFiles(root, entry, 1000, [1000], fsx)).toEqual([]);
    tree[root] = { uid: 1000, gid: 1000, mode: 0o40755 };
  });
});

describe("the walk keeps pathname semantics: no lexical '..', trailing slashes demand directories (codex v0.39 turn 10)", () => {
  const tree: Record<string, { uid: number; gid: number; mode: number }> = {
    "/": { uid: 0, gid: 0, mode: 0o40755 },
    "/dev": { uid: 0, gid: 0, mode: 0o40755 },
    "/dev/fd": { uid: 0, gid: 0, mode: 0o120777 },
    "/proc": { uid: 0, gid: 0, mode: 0o40755 },
    "/proc/self": { uid: 1000, gid: 1000, mode: 0o40755 },
    "/proc/self/fd": { uid: 1000, gid: 1000, mode: 0o40755 },
    "/proc/self/status": { uid: 1000, gid: 1000, mode: 0o100644 },
    "/public": { uid: 0, gid: 0, mode: 0o40755 },
    "/public/link": { uid: 0, gid: 0, mode: 0o120777 },
    "/public/secret": { uid: 0, gid: 0, mode: 0o100644 },
    "/private": { uid: 1000, gid: 1000, mode: 0o40700 },
    "/private/sub": { uid: 1000, gid: 1000, mode: 0o40755 },
    "/private/secret": { uid: 1000, gid: 1000, mode: 0o100600 },
    "/manifest.json": { uid: 1000, gid: 1000, mode: 0o100644 },
    "/data": { uid: 1000, gid: 1000, mode: 0o40755 },
    "/ext": { uid: 1000, gid: 1000, mode: 0o40755 },
    "/ext/openclaw.plugin.json": { uid: 1000, gid: 1000, mode: 0o120777 },
    "/ext/ok.json": { uid: 1000, gid: 1000, mode: 0o120777 },
    "/ext/package.json": { uid: 1000, gid: 1000, mode: 0o100644 },
  };
  const links: Record<string, string> = {
    "/dev/fd": "/proc/self/fd",
    "/public/link": "/private/sub",
    "/ext/openclaw.plugin.json": "/manifest.json/",
    "/ext/ok.json": "/manifest.json",
  };
  const look = (p: string) => { const st = tree[p]; if (!st) throw new Error("ENOENT " + p); return st; };
  const fsx = {
    lstatSync: look,
    statSync: look,
    readlinkSync: (p: string): string => { const l = links[p]; if (l === undefined) throw new Error("EINVAL " + p); return l; },
  };
  test("'..' after a symlink is the physical parent: /dev/fd/../status reads /proc/self/status", () => {
    expect(canReadAs("/dev/fd/../status", 1000, [1000], fsx)).toBe(true);
  });
  test("'..' after a symlink is not lexical: /public/link/../secret is /private/secret, unreadable to others", () => {
    expect(canReadAs("/public/link/../secret", 2000, [2000], fsx)).toBe(false);
    expect(canReadAs("/public/link/../secret", 1000, [1000], fsx)).toBe(true);
  });
  test("a symlink target ending in a slash demands a directory (ENOTDIR on a regular file)", () => {
    expect(canReadAs("/ext/openclaw.plugin.json", 1000, [1000], fsx)).toBe(false);
    expect(canReadAs("/ext/ok.json", 1000, [1000], fsx)).toBe(true);
  });
  test("an input trailing slash demands a directory too", () => {
    expect(canReadAs("/manifest.json/", 1000, [1000], fsx)).toBe(false);
    expect(canReadAs("/data/", 1000, [1000], fsx)).toBe(true);
  });
  test("unreadablePluginFiles reports a manifest whose link target ends in a slash", () => {
    expect(unreadablePluginFiles("/ext", "/ext/ok.json", 1000, [1000], fsx)).toEqual(["/ext/openclaw.plugin.json"]);
  });
});
