import { describe, it, expect, afterAll, setDefaultTimeout } from "bun:test";

// Every test here builds one or more TypeScript programs over the real tree (~3-5 s each);
// bun test's default 5 s per-test timeout SIGTERMs the spawned CLI mid-build.
setDefaultTimeout(180_000);
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import ts from "typescript";

import { buildProgram, classify, collectSites, countBy, diff, loadRatchet, scopedFiles, type ClockSite, type Ratchet } from "../../scripts/o1-clock-audit.ts";

/**
 * The raw-clock audit is a ratchet, and a ratchet that cannot fail is worse
 * than none. These tests are mostly proof that it BITES — on every clock in
 * the stated contract, on every alias form a text matcher would miss, on
 * relocation, and on both write modes — and that it never classifies.
 *
 * Fixtures are synthetic temp trees; the real sources are never mutated. The
 * CLI modes are exercised end-to-end against the REAL tree by pointing
 * `O1_CLOCK_RATCHET` at a temp copy of the checked-in ratchet.
 */

const REPO = resolve(import.meta.dir, "../..");
const SCRIPT = join(REPO, "scripts/o1-clock-audit.ts");
const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

function fixture(files: Record<string, string>): { root: string; files: string[] } {
  const root = mkdtempSync(join(tmpdir(), "o1-clock-"));
  dirs.push(root);
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(join(root, rel, ".."), { recursive: true });
    writeFileSync(join(root, rel), body);
  }
  return { root, files: Object.keys(files) };
}

function census(files: Record<string, string>, base: Ratchet | null = null): ClockSite[] {
  const { root, files: names } = fixture(files);
  const { program, checker } = buildProgram(names, root);
  return classify(collectSites(program, checker, names.filter((f) => !f.endsWith(".d.ts")), root), base); // declarations hold no expressions
}

const ratchetOf = (sites: ClockSite[]): Ratchet => ({ generated: "t", note: "t", counts: countBy(sites), sites });
const cli = (args: string[], ratchet: string) => {
  const r = spawnSync("bun", [SCRIPT, ...args], { cwd: REPO, encoding: "utf8", timeout: 300_000, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, O1_CLOCK_RATCHET: ratchet } });
  if (r.status === null) console.error(`[cli-dbg] args=${args.join(" ")} signal=${r.signal} error=${r.error?.message} stderr=${(r.stderr ?? "").slice(0, 300)}`);
  return r;
};

// ─── detection resolves the SIGNATURE, not the text ─────────────────

describe("detection", () => {
  it("finds every alias form of the same sample", () => {
    const sites = census({ "src/a.ts": [
      "export const a = Date.now();",
      "const D = Date; export const b = D.now();",
      "const { now } = Date; export const c = now();",
      "export const d = globalThis.Date.now();",
      'export const e = Date["now"]();',
      "export const f = new Date().getTime();",
      "export const g = new Date();",
      "export const h = performance.now();",
    ].join("\n") });
    expect(sites.map((s) => s.clock)).toEqual([
      "Date.now", "Date.now", "Date.now", "Date.now", "Date.now", "new Date()", "new Date()", "performance.now",
    ]);
  });

  it("finds EVERY clock in the stated contract — hrtime is a call signature, timeOrigin a read, nanoseconds a namespace member", () => {
    const sites = census({ "src/a.ts": [
      "export const a = process.hrtime();",
      "export const b = process.hrtime.bigint();",
      "export const c = process.uptime();",
      "export const d = performance.timeOrigin;",
      "export const e = Bun.nanoseconds();",
      "const { hrtime } = process; export const f = hrtime();",
      "const P = process; export const g = P.uptime();",
      "export const h = new Date(...([] as []));",
    ].join("\n") });
    expect(sites.map((s) => s.clock)).toEqual([
      "process.hrtime", "process.hrtime.bigint", "process.uptime", "performance.timeOrigin", "Bun.nanoseconds", "process.hrtime", "process.uptime", "new Date()",
    ]);
  });

  it("finds the ROUND-3 contract additions: the performance timeline, console timers, os.uptime, an implicit-now Intl format, and JavaScript sources", () => {
    const sites = census({
      "src/a.ts": [
        'export const a = performance.mark("a");',
        'export const b = performance.measure("m", "a");',
        'export const c = performance.getEntriesByName("a");',
        'console.time("t"); console.timeEnd("t");',
        'import { uptime } from "node:os"; export const d = uptime();',
        "export const e = new Intl.DateTimeFormat().format();",          // no argument: formats NOW
        "export const f = new Intl.DateTimeFormat().format(0);",         // an argument: a conversion
        "export const g = new Date(0).toLocaleDateString();",            // formats a Date you hold
      ].join("\n"),
      "src/j.js": "export const t = Date.now();",
    });
    expect(sites.map((s) => s.clock)).toEqual([
      "performance.mark", "performance.measure", "performance.getEntriesByName", "console.time", "console.timeEnd", "os.uptime", "Intl.DateTimeFormat.format()", "Date.now",
    ]);
    expect(sites[sites.length - 1]!.file).toBe("src/j.js");
  });

  it("finds the ROUND-4 contract additions: timerify (both forms), monitorEventLoopDelay, PerformanceObserver, toJSON — and .tsx/.mts sources", () => {
    const sites = census({
      "src/a.ts": [
        'import { timerify, monitorEventLoopDelay } from "node:perf_hooks";',
        "export const a = performance.timerify(() => 1);",
        "export const b = timerify(() => 2);",
        "export const c = monitorEventLoopDelay();",
        "export const d = new PerformanceObserver(() => {});",
        "export const e = performance.toJSON();",
      ].join("\n"),
      "src/x.tsx": "export const El = () => <div>{Date.now()}</div>;",
      "src/m.mts": "export const t = performance.now();",
    });
    expect(sites.map((s) => [s.clock, s.file])).toEqual([
      ["performance.timerify", "src/a.ts"], ["perf_hooks.timerify", "src/a.ts"], ["perf_hooks.monitorEventLoopDelay", "src/a.ts"],
      ["new PerformanceObserver()", "src/a.ts"], ["performance.toJSON", "src/a.ts"], ["Date.now", "src/x.tsx"], ["performance.now", "src/m.mts"],
    ]);
  });

  it("finds the ROUND-5 contract additions: perf_hooks.eventLoopUtilization, performance.nodeTiming — and a READ in every spelling; createHistogram is not a sample", () => {
    const sites = census({ "src/a.ts": [
      'import { eventLoopUtilization, createHistogram } from "node:perf_hooks";',
      "export const a = eventLoopUtilization();",
      "export const b = performance.nodeTiming;",
      'export const c = performance["nodeTiming"];',
      "const { nodeTiming } = performance; export const d = nodeTiming;",
      "const { timeOrigin: t0 } = performance; export const e = t0;",
      "export const h = createHistogram();",   // records values the caller supplies
    ].join("\n") });
    expect(sites.map((s) => s.clock)).toEqual([
      "perf_hooks.eventLoopUtilization", "performance.nodeTiming", "performance.nodeTiming", "performance.nodeTiming", "performance.timeOrigin",
    ]);
  });

  it("a READ in the spellings round 6 named: an `as const` key, an enum key, a union key, a destructuring ASSIGNMENT, a nested assignment pattern, a computed binding key — and never a first-party lookalike", () => {
    const sites = census({ "src/a.ts": [
      'const key = "nodeTiming" as const; export const a = performance[key];',
      'enum K { T = "timeOrigin" } export const b = performance[K.T];',
      'declare const which: "nodeTiming" | "now"; export const c = performance[which];',
      "let nt: unknown; ({ nodeTiming: nt } = performance); export { nt };",
      "let dur: unknown; ({ nodeTiming: { duration: dur } } = performance); export { dur };",
      'const { ["nodeTiming"]: viaComputed } = performance; export const d = viaComputed;',
      "const other = { nodeTiming: 1 }; const { nodeTiming: mine } = other; export const e = mine;",
      "declare const k: keyof Performance; export const f = performance[k];",                             // every key literal: fail closed
      "declare const s: string; export const g = (performance as unknown as Record<string, unknown>)[s];", // unnarrowable: stated residual
    ].join("\n") });
    expect(sites.map((s) => s.clock)).toEqual([
      "performance.nodeTiming", "performance.timeOrigin", "performance.nodeTiming", "performance.nodeTiming", "performance.nodeTiming", "performance.nodeTiming", "performance.nodeTiming",
    ]);
  });

  it("a READ through an ARRAY assignment pattern, a for-of over an array and over a Set, and a for-await-of (round 7)", () => {
    const sites = census({ "src/a.ts": [
      "let a: unknown; [{ nodeTiming: a }] = [performance]; export { a };",
      "let b: unknown; for ({ nodeTiming: b } of [performance]) { void b; } export { b };",
      "let c: unknown; for ({ timeOrigin: c } of new Set([performance])) { void c; } export { c };",
      "export async function f(): Promise<unknown> { let d: unknown; for await ({ nodeTiming: d } of [Promise.resolve(performance)]) { void d; } return d; }",
      "let e: unknown; for ({ nodeTiming: e } of [{ nodeTiming: 1 }]) { void e; } export { e };", // first-party lookalike
    ].join("\n") });
    expect(sites.map((s) => s.clock)).toEqual(["performance.nodeTiming", "performance.nodeTiming", "performance.timeOrigin", "performance.nodeTiming"]);
  });

  it("a for-in initializer is NOT an assignment pattern (round 8): `for ({ x } in v)` is TS2491 — the audit neither reads it nor throws", () => {
    expect(census({ "src/a.ts": "let x: unknown; for ({ nodeTiming: x } in performance) { void x; } export { x };\n" })).toEqual([]);
  });

  it("declaration files are excluded by NAME (round 5): `x.d.ts` never matches `.ts` by suffix", () => {
    const { root } = fixture({ "src/x.d.ts": "export declare const t: number;\n", "src/y.d.mts": "export declare const u: number;\n", "src/z.d.cts": "export declare const v: number;\n", "src/w.ts": "export const w = 1;\n" });
    expect(scopedFiles(root)).toEqual(["src/w.ts"]);
  });

  it("the program is built under the repository's compiler contract (round 5): tsconfig.json options, only the audit's keys overridden", () => {
    const o = buildProgram(["src/clock-legacy.ts"]).program.getCompilerOptions();
    expect([o.module, o.moduleDetection, o.noEmit, o.allowJs]).toEqual([ts.ModuleKind.Preserve, ts.ModuleDetectionKind.Force, true, true]);
  });

  it("FAILS CLOSED on `Temporal` the day it enters the program's lib", () => {
    const sites = census({
      "src/temporal.d.ts": "declare namespace Temporal { namespace Now { function instant(): number; const timeZoneId: string; } }\n",
      "src/a.ts": "export const a = Temporal.Now.instant();\nexport const b = Temporal.Now.timeZoneId;\n",
    });
    expect(sites.map((s) => s.clock)).toEqual(["Temporal.Now.instant", "Temporal.Now.timeZoneId"]);
  });

  it("IGNORES comments, strings, a dated constructor, a possibly-undefined argument (Invalid Date, not now), and an unrelated .now()", () => {
    const sites = census({ "src/a.ts": [
      "// Date.now() is free, says the comment",
      "/** absolute wall-clock deadline (Date.now() epoch ms) */",
      'export const s = "Date.now()";',
      "export const dated = new Date(0);",
      "export const parsed = new Date('2026-01-01');",
      "declare const maybe: number | undefined; export const conv = new Date(maybe);",
      "const clock = { now: () => 1, hrtime: () => 2, uptime: () => 3, timeOrigin: 4 }; export const v = clock.now() + clock.hrtime() + clock.uptime() + clock.timeOrigin;",
      "export const diff = process.hrtime.bigint; // a reference, not a sample",
    ].join("\n") });
    expect(sites).toHaveLength(0);
  });

  it("charges a first-party wrapper's BODY, never its callers", () => {
    const sites = census({ "src/a.ts": "export function myNow() { return Date.now(); }\nexport const x = myNow() + myNow();\n" });
    expect(sites).toHaveLength(1);
    expect(sites[0]!.scope).toBe("myNow");
  });
});

// ─── identity ───────────────────────────────────────────────────────

describe("identity", () => {
  const src = "export function f(x: number) { return x + Date.now(); }\n";

  it("survives unrelated line shifts", () => {
    const a = census({ "src/a.ts": src });
    const b = census({ "src/a.ts": `// pushed\n// down\n${src}` });
    expect(a[0]!.line).not.toBe(b[0]!.line);
    expect(a[0]!.id).toBe(b[0]!.id);
  });

  it("CHANGES when the sample moves to a different expression in the same scope", () => {
    const a = census({ "src/a.ts": src });
    const b = census({ "src/a.ts": "export function f(x: number) { const t = Date.now(); return x + t; }\n" });
    expect(a[0]!.id).not.toBe(b[0]!.id);
    const d = diff(b, ratchetOf(a));
    expect(d.added).toHaveLength(1);
    expect(d.removed).toHaveLength(1);
  });

  it("distinguishes identical samples in one scope by occurrence", () => {
    const sites = census({ "src/a.ts": "export function f() { const a = Date.now(); const b = Date.now(); return b - a; }\n" });
    expect(sites).toHaveLength(2);
    expect(sites[0]!.id).not.toBe(sites[1]!.id);
  });

  it("ACCEPTED RESIDUAL: swapping two identical expressions in one scope keeps both ids (census and categories unchanged)", () => {
    const G = "declare function g(n: number): void; declare function h(): void;\n";
    const a = census({ "src/a.ts": G + "export function f() { g(Date.now()); h(); g(Date.now()); }\n" });
    const b = census({ "src/a.ts": G + "export function f() { g(Date.now()); g(Date.now()); h(); }\n" });
    expect(a).toHaveLength(2);
    expect(b.map((s) => s.id)).toEqual(a.map((s) => s.id));
    expect(diff(b, ratchetOf(a)).added).toHaveLength(0);
  });
});

// ─── classification is a human act ──────────────────────────────────

describe("classification", () => {
  it("the tool NEVER classifies: a site absent from the baseline is UNCLASSIFIED in every file, brand or no brand", () => {
    const sites = census({
      "src/plain.ts": "export const a = Date.now();\n",
      "src/gated.ts": 'import type { DurationMs } from "./clock.ts";\nexport const c: DurationMs | null = null; export const d = Date.now();\n',
      "src/stamp.ts": "export const iso = new Date().toISOString();\n", // even the obvious calendar stamp
    });
    expect(sites.map((s) => s.category)).toEqual(["UNCLASSIFIED", "UNCLASSIFIED", "UNCLASSIFIED"]);
  });

  it("carries a prior category by id; the retired category X and anything outside A–E are NOT carried", () => {
    const first = census({ "src/a.ts": "export const a = Date.now();\n" });
    const carry = (cat: string) => census({ "src/a.ts": "export const a = Date.now();\n" }, ratchetOf(first.map((s) => ({ ...s, category: cat as ClockSite["category"] }))))[0]!.category;
    expect(carry("D")).toBe("D");
    expect(carry("X")).toBe("UNCLASSIFIED");
    expect(carry("UNCLASSIFIED")).toBe("UNCLASSIFIED");
    expect(carry("F")).toBe("UNCLASSIFIED");
  });
});

// ─── write modes, end-to-end against the real tree ──────────────────

describe("ratchet write modes (real tree, temp ratchet)", () => {
  const real = join(REPO, "o1-clock-debt.json");

  it("--init refuses when a ratchet exists; check passes on the checked-in one", () => {
    const dir = mkdtempSync(join(tmpdir(), "o1-clock-cli-")); dirs.push(dir);
    const tmp = join(dir, "r.json");
    copyFileSync(real, tmp);
    expect(cli(["--init"], tmp).status).toBe(2);
    const r = cli([], tmp);
    expect(r.stdout).toContain("OK —");
    expect(r.status).toBe(0);
  });

  it("--write REFUSES to bless a site missing from the baseline (proven on a fixture: the real tree holds ZERO raw sites after the O1 migration, so the CLI refusal cannot be provoked there)", () => {
    const base = JSON.parse(readFileSync(real, "utf8")) as Ratchet;
    expect(base.sites).toHaveLength(0); // the activation precondition (O1 §6 step 4)
    // The SAME `diff` the CLI gates `--write` on: a live site the baseline lacks is an ADDITION.
    const live = census({ "src/a.ts": "export const t = Date.now();\n" }, { ...base, sites: [] });
    expect(live).toHaveLength(1);
    const d = diff(live, { ...base, sites: [] });
    expect(d.added).toHaveLength(1);
    expect(d.removed).toHaveLength(0);
    // and against the REAL tree the same baseline reports nothing added — the check stays green.
    expect(cli([], real).status).toBe(0);
  });

  it("--write RETIRES an entry that no longer exists", () => {
    const dir = mkdtempSync(join(tmpdir(), "o1-clock-cli-")); dirs.push(dir);
    const tmp = join(dir, "r.json");
    const base = JSON.parse(readFileSync(real, "utf8")) as Ratchet;
    const ghost: ClockSite = { ...base.sites[0]!, id: "src/ghost.ts::g::Date.now::deadbeef#0", file: "src/ghost.ts", scope: "g" };
    writeFileSync(tmp, JSON.stringify({ ...base, sites: [...base.sites, ghost] }));
    const w = cli(["--write"], tmp);
    expect(w.stdout).toContain("retired 1 site");
    expect(w.status).toBe(0);
    expect(JSON.parse(readFileSync(tmp, "utf8")).sites).toHaveLength(base.sites.length);
  });

  it("a site the baseline holds as UNCLASSIFIED fails the check (proven on a fixture: `classify` carries only A–E by id, so the CLI's UNCLASSIFIED gate fires on it)", () => {
    const base = JSON.parse(readFileSync(real, "utf8")) as Ratchet;
    const files = { "src/a.ts": "export const t = Date.now();\n" };
    const first = census(files, null)[0]!;
    const held = census(files, { ...base, sites: [{ ...first, category: "UNCLASSIFIED" }] });
    expect(held[0]!.category).toBe("UNCLASSIFIED");
    const carried = census(files, { ...base, sites: [{ ...first, category: "D" }] });
    expect(carried[0]!.category).toBe("D");
  });
});

// ─── the real tree ──────────────────────────────────────────────────

describe("repository state", () => {
  const r = loadRatchet()!;
  const cat = (file: string, scope: string, clock: string) => r.sites.find((s) => s.file === file && s.scope === scope && s.clock === clock)?.category;

  it("every site is classified A–E by a reader; category X no longer exists", () => {
    expect(r.sites.filter((s) => !["A", "B", "C", "D", "E"].includes(s.category))).toHaveLength(0);
    expect(r.counts["cat:X"]).toBeUndefined();
  });

  it("covers src/ AND scripts/, and never src/clock.ts", () => {
    const files = scopedFiles();
    expect(files.some((f) => f.startsWith("scripts/"))).toBe(true);
    expect(files).not.toContain("src/clock.ts");
    // O1 step 2 (the migration): every CONTROL site (A/B/C) has been retired from the census —
    // only calendar/persistence (D) and deferred wall-clock policy (E) remain until the D/E sweep.
    expect(r.sites.filter((s) => s.category === "A" || s.category === "B" || s.category === "C")).toHaveLength(0);
  });

  it("the design-critical CONTROL sites are RETIRED (O1 step 2): the budget anchor, the over_ms evidence, the Stop-hook anchor no longer sample a raw clock", () => {
    expect(cat("src/hooks/context-surfacing.ts", "contextSurfacing.traceT0", "Date.now")).toBeUndefined();          // the budget anchor → monoNow()
    expect(cat("src/hooks/context-surfacing.ts", "contextSurfacing.recordVectorLegDeadline.over_ms", "Date.now")).toBeUndefined(); // over_ms → overshoot()
    expect(cat("src/hooks/decision-extractor.ts", "decisionExtractor.deadlineAt", "Date.now")).toBeUndefined();        // the Stop-hook anchor → deadlineAfter(monoNow(), …)
    // Whatever remains is D or E — wall-clock SEMANTICS, migrated to epochNow() by the D/E sweep, never control.
    for (const site of r.sites) expect(["D", "E"]).toContain(site.category);
  });

  it("FALSIFIER (round 2, finding 7): the sites codex named inside former category X were control, not stamps — and every one is now RETIRED", () => {
    expect(cat("src/llm-retry.ts", "withRetryAndFeedback.remaining", "Date.now")).toBeUndefined();           // retry cancellation → deadlineTimer
    expect(cat("src/causal-writer.ts", "runCausalStep.remaining", "Date.now")).toBeUndefined();              // causal-step deadline → remainingForTimeout
    expect(cat("src/eval/vec-daemon-child.ts", "spawnEvalVectorDaemon.next", "Date.now")).toBeUndefined();   // readiness budget → untilDeadline
    expect(cat("src/consolidation.ts", "stopConsolidationWorker.deadline", "Date.now")).toBeUndefined();     // worker stop-drain → isExpired
    expect(cat("src/maintenance.ts", "startHeavyMaintenanceWorker.deadline", "Date.now")).toBeUndefined();   // worker stop-drain → isExpired
    expect(cat("src/clawmem.ts", "cmdEmbed", "Date.now")).toBeUndefined();                                    // TPM pacing anchor → remainingForTimeout
    // A stamp and a lease expiry are D/E: still raw until the sweep, or already epochNow() — never A/B/C.
    for (const c of [cat("src/worker-lease.ts", "acquireWorkerLease", "new Date()"), cat("src/amem.ts", "generateMemoryLinks.now", "new Date()")]) {
      expect(c === undefined || c === "D" || c === "E").toBe(true);
    }
  });
});
