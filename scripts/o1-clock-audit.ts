#!/usr/bin/env bun
/**
 * O1 raw-clock audit + ratchet (v9 — codex code-review round 8 finding 2; rounds 2–7 retained).
 *
 * ONE RULE (O1-DESIGN §1): outside `src/clock.ts`, sampling a platform clock is
 * permitted only as an exact ratchet debt entry. Additions fail. Category D/E
 * keeps wall-clock SEMANTICS through `epochNow()` — the ban is on raw SAMPLING,
 * never on wall time. Activation requires ZERO entries; the prohibition is then
 * absolute across every first-party surface.
 *
 * THE CLOCK-SOURCE CONTRACT (round 2 finding 5, round 3 finding 7, round 5
 * finding 5). A "sample" is any of, resolved through the signature or symbol the
 * checker picked (spelling and aliasing are irrelevant; comments and strings
 * resolve to nothing):
 *
 *   wall / monotonic:   Date.now()  Date()  new Date() (argless, or with a spread — argument count unknown)
 *                       performance.now()  performance.timeOrigin (a READ)
 *                       process.hrtime()  process.hrtime.bigint()  process.uptime()  os.uptime()
 *                       Bun.nanoseconds()
 *   timeline evidence:  performance.mark()  performance.measure()  performance.getEntries*()
 *                       performance.eventLoopUtilization() / perf_hooks.eventLoopUtilization()
 *                       performance.toJSON()  performance.nodeTiming (a READ)
 *                       performance.timerify() / perf_hooks.timerify()  perf_hooks.monitorEventLoopDelay()
 *                       new PerformanceObserver()  console.time() / timeEnd() / timeLog()
 *   implicit "now":     Intl.DateTimeFormat#format() / formatToParts() with NO argument
 *   fail-closed:        ANY member of a `Temporal` namespace, should one enter the program's lib —
 *                       it is not in lib.esnext today, and it is reported as a sample the day it is.
 *
 * A READ is a read however it is spelled — the property SYMBOL is resolved,
 * never the text (round 6 finding 5): `performance.nodeTiming`,
 * `performance?.nodeTiming`, `performance["nodeTiming"]`, `performance[key]`
 * for a key whose TYPE is a literal (`as const`, an enum member, a union of
 * literals — every constituent is a read), `const { nodeTiming } = performance`,
 * a renamed / computed / nested binding, a destructuring ASSIGNMENT
 * `({ nodeTiming } = performance)`, an ITERATION pattern `for ({ nodeTiming }
 * of xs)` / `for await` over ANY iterable (the checker types the pattern —
 * round 7 finding 2), and every nesting of those. A `keyof
 * Performance` key is a union of every key literal and is reported (fail
 * closed); a key the checker cannot narrow to literals at all (`someString` into
 * an index signature) is not a resolvable read and is not reported — stated
 * residual. (`perf_hooks.createHistogram()` is NOT a sample: it records values
 * the caller supplies.)
 *
 * `new Date(x)` with an argument is a CONVERSION, not a sample (`new
 * Date(undefined)` is an Invalid Date, never "now"); so are `Date.parse`,
 * `Date.UTC` and formatting a Date you already hold. CPU / resource meters
 * (`process.cpuUsage`, `process.resourceUsage`) are not clocks and are out of
 * contract. Every source extension the compiler knows is in scope (`ts.Extension`
 * minus `.json`/`.tsbuildinfo` and minus declaration files, which hold no
 * expressions — excluded by NAME, `x.d.ts` never matching `.ts` by suffix, round
 * 5 finding 6): `.ts .tsx .mts .cts .js .jsx .mjs .cjs`. The program is built
 * under the repository's own compiler contract (`tsconfig.json`, round 5 finding
 * 1; see `o1-tsconfig.ts`), so symbols resolve exactly as they do in production.
 *
 * CLASSIFICATION IS A HUMAN ACT (finding 7). The tool never assigns a category:
 * a site not carried from the baseline is `UNCLASSIFIED` and the audit fails
 * until a reader sets `category` in the ratchet by reading the site. Category
 * `X` ("outside the seam files, retire mechanically") is RETIRED — the sites it
 * held included retry cancellation, a causal-step deadline and worker
 * stop-drain deadlines: zero raw-clock debt proves replacement, not replacement
 * with the correct clock semantics, and only a reading decides the semantics.
 *
 *   A  deadline / budget / pacing CONTROL           -> monotonic deadline
 *   B  DURATION EVIDENCE (gate timing, logged/persisted elapsed_ms) -> monotonic elapsed
 *   C  transport / attempt CANCELLATION             -> relative budget from a monotonic anchor
 *   D  calendar, persistence, identifiers from wall time -> epochNow()
 *   E  deferred NON-budget control on wall time (provider cooldowns, cross-process
 *      lease expiry, dedup windows, log throttles)   -> epochNow()
 *
 * IDENTITY. A site is `file::scope::clock::<hash of its maximal enclosing
 * expression>#occurrence`: it survives unrelated line shifts and CHANGES when the
 * sample moves to a different expression (finding 5, round 1). Accepted residual
 * (finding 6): two byte-identical expressions in one scope are told apart by
 * occurrence order only, so swapping them, or moving one past the other, keeps
 * both ids — the census, the categories and the count are unchanged by such a move.
 *
 * `--write` is RETIRE-ONLY: it refuses if any live site is not already in the
 * baseline. `--init` bootstraps once and refuses if a baseline exists. Neither
 * mode can bless new debt, and neither classifies.
 *
 * Usage:
 *   bun scripts/o1-clock-audit.ts            # check against the ratchet (exit 1 on any finding)
 *   bun scripts/o1-clock-audit.ts --init     # bootstrap the ratchet, all UNCLASSIFIED (refuses if one exists)
 *   bun scripts/o1-clock-audit.ts --write    # retire migrated sites (refuses on additions)
 *   bun scripts/o1-clock-audit.ts --json     # machine-readable live census
 */

import ts from "typescript";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { isoNow } from "../src/clock.ts";
import { repoCompilerOptions } from "./o1-tsconfig.ts";

const REPO = resolve(import.meta.dir, "..");
/** Tests point this at a temp copy so --init/--write can be exercised end-to-end against the real tree. */
const RATCHET = process.env.O1_CLOCK_RATCHET ? resolve(process.env.O1_CLOCK_RATCHET) : join(REPO, "o1-clock-debt.json");

/** The clock module itself — the only place a platform clock may be sampled. */
export const CLOCK_MODULE = "src/clock.ts";

/** Every source extension the compiler knows, minus data/metadata files and declaration files (no expressions). */
export const SOURCE_EXTENSIONS: readonly string[] = Object.values(ts.Extension).filter((e): e is ts.Extension =>
  typeof e === "string" && e !== ts.Extension.Json && e !== ts.Extension.TsBuildInfo && e !== ts.Extension.Dts && e !== ts.Extension.Dmts && e !== ts.Extension.Dcts);
/** A declaration file by NAME — `x.d.ts` also ends with `.ts`, so the suffix list alone cannot exclude it (round 5 finding 6). */
export const isDeclarationName = (f: string): boolean => /\.d\.(ts|mts|cts)$/.test(f);

export type Category = "A" | "B" | "C" | "D" | "E" | "UNCLASSIFIED";
const CLASSIFIED: ReadonlySet<string> = new Set(["A", "B", "C", "D", "E"]);

export const CATEGORY_MEANING: Record<Category, string> = {
  A: "deadline/budget/pacing CONTROL (hook budget, worker stop-drain, request pacing) -> monotonic deadline",
  B: "DURATION EVIDENCE (gate/trust timing, logged or persisted elapsed_ms) -> monotonic elapsed",
  C: "transport/attempt CANCELLATION -> relative budget (remaining ms) from a monotonic anchor",
  D: "calendar, persistence and identifiers from wall time -> epochNow()",
  E: "deferred NON-budget control on wall time (provider cooldowns, cross-process lease expiry, dedup windows, log throttles) -> epochNow()",
  UNCLASSIFIED: "not yet classified by a reader — the audit fails on these",
};

export interface ClockSite {
  file: string;
  line: number;
  /** One of the clock-source contract's spellings above. */
  clock: string;
  scope: string;
  /** Normalized maximal enclosing expression (truncated for display). */
  expr: string;
  category: Category;
  /** `file::scope::clock::<hash of expr>#k` — moves with unrelated edits, not with the expression. */
  id: string;
}

export interface Ratchet {
  generated: string;
  note: string;
  counts: Record<string, number>;
  sites: ClockSite[];
}

// ─── scope ──────────────────────────────────────────────────────────

export function scopedFiles(root: string = REPO): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    if (!existsSync(dir)) return;
    for (const name of readdirSync(dir)) {
      const abs = join(dir, name);
      if (name === "gits" || name === "node_modules" || name.startsWith(".")) continue;
      if (statSync(abs).isDirectory()) walk(abs);
      else if (!isDeclarationName(name) && SOURCE_EXTENSIONS.some((e) => name.endsWith(e))) out.push(relative(root, abs));
    }
  };
  walk(join(root, "src"));
  walk(join(root, "scripts"));
  return out.filter((f) => f !== CLOCK_MODULE).sort();
}

/** The program under the REPOSITORY'S compiler contract (`tsconfig.json`, round 5 finding 1), whatever the root; only audit-specific keys are overridden. */
export function buildProgram(files: readonly string[], root: string = REPO): { program: ts.Program; checker: ts.TypeChecker } {
  const program = ts.createProgram(files.map((f) => join(root, f)), {
    ...repoCompilerOptions(),
    noEmit: true,
    allowJs: true, // JS roots are in scope whatever the contract says about emitting them
  });
  return { program, checker: program.getTypeChecker() };
}

// ─── detection (signature-resolved) ─────────────────────────────────

/** The interface / class / type-alias / `declare module` a lib declaration belongs to. */
function declOwnerName(decl: ts.Declaration): string {
  let p: ts.Node | undefined = decl.parent;
  if (p && ts.isModuleBlock(p)) p = p.parent;
  if (!p) return "";
  if ((ts.isInterfaceDeclaration(p) || ts.isClassDeclaration(p)) && p.name) return p.name.text;
  if (ts.isModuleDeclaration(p)) return ts.isIdentifier(p.name) ? p.name.text : p.name.text;
  if (ts.isTypeLiteralNode(p) && p.parent && ts.isTypeAliasDeclaration(p.parent)) return p.parent.name.text;
  // `declare var PerformanceObserver: { new (...): ...; prototype: ... }` — possibly wrapped in type references /
  // conditional types (bun-types' `UseLibDomIfAvailable<"PerformanceObserver", {...}>`): the owner is the variable the literal types.
  if (ts.isTypeLiteralNode(p)) {
    let q: ts.Node | undefined = p.parent;
    while (q && ts.isTypeNode(q)) q = q.parent;
    if (q && ts.isVariableDeclaration(q) && ts.isIdentifier(q.name)) return q.name.text;
  }
  return "";
}

function declName(decl: ts.Declaration): string {
  const n = (decl as ts.NamedDeclaration).name;
  return n && ts.isIdentifier(n) ? n.text : "";
}

/** The `declare namespace` / `declare module` chain a lib declaration sits in, outermost first. */
function namespaceChain(decl: ts.Declaration): string[] {
  const out: string[] = [];
  for (let p: ts.Node | undefined = decl.parent; p; p = p.parent) if (ts.isModuleDeclaration(p)) out.unshift(p.name.text);
  return out;
}

const PERFORMANCE_TIMELINE = new Set(["mark", "measure", "getEntries", "getEntriesByName", "getEntriesByType", "eventLoopUtilization", "timerify", "toJSON"]);
/** Property READS of `Performance` that are samples: the process origin and the boot timeline (round 5 finding 5). */
const PERFORMANCE_READS = new Set(["timeOrigin", "nodeTiming"]);
const PERF_HOOKS_MODULE = new Set(["perf_hooks", "node:perf_hooks"]);
const PERF_HOOKS_SAMPLERS = new Set(["timerify", "monitorEventLoopDelay", "eventLoopUtilization"]);
const CONSOLE_TIMERS = new Set(["time", "timeEnd", "timeLog"]);

/** The key(s) an expression's TYPE denotes: a literal, an enum member, a union of literals (every constituent — `keyof Performance` included, fail closed). An unnarrowable key denotes nothing. */
function keysOfExpression(expr: ts.Expression, checker: ts.TypeChecker): string[] {
  const t = checker.getTypeAtLocation(expr);
  return (t.isUnion() ? t.types : [t]).flatMap((c) => (c.isStringLiteral() ? [c.value] : c.isNumberLiteral() ? [String(c.value)] : []));
}

/** The key(s) a property NAME denotes: an identifier or literal is the name itself; a computed name goes by its expression's type. */
function keysOfName(name: ts.PropertyName, checker: ts.TypeChecker): string[] {
  return ts.isComputedPropertyName(name) ? keysOfExpression(name.expression, checker) : [name.text];
}

/**
 * Is this object / array literal (transitively) the LEFT side of a destructuring assignment — `=`, or a for-of /
 * for-await-of initializer? NOT for-in (round 8 finding 2): `for ({ x } in v)` is TS2491, the checker's
 * `getTypeOfAssignmentPattern` rejects it outright, and the seam audit's C0 carries the diagnostic — it is never a read.
 */
function isAssignmentPattern(lit: ts.Node): boolean {
  for (let cur: ts.Node = lit, p = lit.parent; p; cur = p, p = p.parent) {
    if (ts.isBinaryExpression(p)) return p.operatorToken.kind === ts.SyntaxKind.EqualsToken && p.left === cur;
    if (ts.isForOfStatement(p)) return p.initializer === cur;
    if (!(ts.isParenthesizedExpression(p) || ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p) || ts.isSpreadAssignment(p) || ts.isSpreadElement(p) || ts.isObjectLiteralExpression(p) || ts.isArrayLiteralExpression(p))) return false;
  }
  return false;
}

/**
 * The property symbol(s) a READ resolves to, whatever the spelling: `a.b`, `a?.b`,
 * `a["b"]`, `a[key]` (literal-typed key, every constituent of a union), a binding
 * element `const { b } = a` / `{ b: c }` / `{ ["b"]: c }` / nested, and a destructuring
 * ASSIGNMENT `({ b } = a)` / nested (round 6 finding 5).
 */
function readSymbols(node: ts.Node, checker: ts.TypeChecker): ts.Symbol[] {
  const props = (t: ts.Type | undefined, keys: string[]): ts.Symbol[] => (t ? keys.flatMap((k) => { const s = checker.getPropertyOfType(t, k); return s ? [s] : []; }) : []);
  if (ts.isPropertyAccessExpression(node)) { const s = checker.getSymbolAtLocation(node.name); return s ? [s] : []; }
  if (ts.isElementAccessExpression(node)) return props(checker.getTypeAtLocation(node.expression), keysOfExpression(node.argumentExpression, checker));
  if (ts.isBindingElement(node) && ts.isObjectBindingPattern(node.parent)) {
    const key = node.propertyName ?? (ts.isIdentifier(node.name) ? node.name : undefined);
    return key ? props(checker.getTypeAtLocation(node.parent), keysOfName(key, checker)) : [];
  }
  if ((ts.isPropertyAssignment(node) || ts.isShorthandPropertyAssignment(node)) && ts.isObjectLiteralExpression(node.parent) && isAssignmentPattern(node.parent)) {
    // The checker's own typing of an assignment pattern: the right side, the iterated element of a for-of / for-await-of
    // (any iterable), the matching member of an enclosing pattern, an array element — every nesting (round 7 finding 2).
    return props(checker.getTypeOfAssignmentPattern(node.parent), keysOfName(node.name, checker));
  }
  return [];
}

/**
 * Which platform clock does this node sample, if any? Calls and constructions
 * resolve through the signature the checker picked; the property READS in the
 * contract (`performance.timeOrigin`, `performance.nodeTiming`, any `Temporal`
 * member) through their symbol, in every spelling `readSymbols` resolves. Only
 * lib/ambient declarations count: a first-party `now()` wrapper is a CONSUMER,
 * and its own body is where the sample is caught.
 */
export function samplerOf(node: ts.Node, checker: ts.TypeChecker): string | null {
  const reads = readSymbols(node, checker);
  if (reads.length > 0) {
    // A READ — not the callee of a call / construction (that call is the sample), not a namespace.
    if (node.parent && (ts.isCallExpression(node.parent) || ts.isNewExpression(node.parent)) && node.parent.expression === node) return null;
    for (const read of reads) {
      const decl = read.declarations?.[0];
      if (!decl || !decl.getSourceFile().isDeclarationFile) continue;
      if (!ts.isModuleDeclaration(decl) && namespaceChain(decl)[0] === "Temporal") return `Temporal.${[...namespaceChain(decl).slice(1), declName(decl)].join(".")}`;
      if (PERFORMANCE_READS.has(declName(decl)) && declOwnerName(decl) === "Performance") return `performance.${declName(decl)}`;
    }
    return null;
  }
  if (!ts.isCallExpression(node) && !ts.isNewExpression(node)) return null;
  const sig = checker.getResolvedSignature(node);
  const decl = sig?.declaration;
  if (!decl || !decl.getSourceFile().isDeclarationFile) return null;
  const args = node.arguments ?? [];
  const argc = args.some((a) => ts.isSpreadElement(a)) ? -1 : args.length;
  const owner = declOwnerName(decl);
  const name = declName(decl);
  const ns = namespaceChain(decl);
  if (ns[0] === "Temporal") return `Temporal.${[...ns.slice(1), name || "<call>"].join(".")}`; // fail closed

  if (ts.isNewExpression(node)) {
    if (ts.isConstructSignatureDeclaration(decl) && owner === "DateConstructor" && argc <= 0) return "new Date()";
    if ((ts.isConstructorDeclaration(decl) || ts.isConstructSignatureDeclaration(decl)) && owner === "PerformanceObserver") return "new PerformanceObserver()";
    return null;
  }
  if (ts.isCallSignatureDeclaration(decl)) {
    if (owner === "DateConstructor" && argc <= 0) return "Date()";
    if (owner === "HRTime") return "process.hrtime";
    return null;
  }
  if (name === "now" && owner === "DateConstructor") return "Date.now";
  if (name === "now" && owner === "Performance") return "performance.now";
  if (name === "bigint" && owner === "HRTime") return "process.hrtime.bigint";
  if (name === "uptime" && owner === "Process") return "process.uptime";
  if (name === "uptime" && (owner === "os" || owner === "node:os")) return "os.uptime"; // @types/node declares it under either module name
  if (name === "nanoseconds" && owner === "bun") return "Bun.nanoseconds";
  if (owner === "Performance" && PERFORMANCE_TIMELINE.has(name)) return `performance.${name}`;
  if (PERF_HOOKS_MODULE.has(owner) && PERF_HOOKS_SAMPLERS.has(name)) return `perf_hooks.${name}`;
  if (owner === "Console" && CONSOLE_TIMERS.has(name)) return `console.${name}`;
  if (owner === "DateTimeFormat" && (name === "format" || name === "formatToParts") && argc === 0) return `Intl.DateTimeFormat.${name}()`;
  return null;
}

// ─── identity ───────────────────────────────────────────────────────

function enclosingScope(node: ts.Node): string {
  const parts: string[] = [];
  for (let cur: ts.Node | undefined = node; cur; cur = cur.parent) {
    if ((ts.isFunctionDeclaration(cur) || ts.isMethodDeclaration(cur)) && cur.name) parts.unshift(cur.name.getText());
    else if (ts.isClassDeclaration(cur) && cur.name) parts.unshift(cur.name.getText());
    else if (ts.isVariableDeclaration(cur) && ts.isIdentifier(cur.name)) parts.unshift(cur.name.getText());
    else if (ts.isPropertyAssignment(cur) && ts.isIdentifier(cur.name)) parts.unshift(cur.name.getText());
  }
  return parts.length > 0 ? parts.join(".") : "<module>";
}

const EXPR_KINDS = new Set<ts.SyntaxKind>([
  ts.SyntaxKind.BinaryExpression, ts.SyntaxKind.CallExpression, ts.SyntaxKind.NewExpression,
  ts.SyntaxKind.PropertyAccessExpression, ts.SyntaxKind.ElementAccessExpression, ts.SyntaxKind.ConditionalExpression,
  ts.SyntaxKind.ParenthesizedExpression, ts.SyntaxKind.PrefixUnaryExpression, ts.SyntaxKind.PostfixUnaryExpression,
  ts.SyntaxKind.AsExpression, ts.SyntaxKind.NonNullExpression, ts.SyntaxKind.TemplateExpression, ts.SyntaxKind.TemplateSpan,
  ts.SyntaxKind.ObjectLiteralExpression, ts.SyntaxKind.PropertyAssignment, ts.SyntaxKind.ShorthandPropertyAssignment,
  ts.SyntaxKind.ArrayLiteralExpression, ts.SyntaxKind.SpreadElement, ts.SyntaxKind.TypeOfExpression,
  ts.SyntaxKind.AwaitExpression, ts.SyntaxKind.VoidExpression, ts.SyntaxKind.SatisfiesExpression,
]);

/** The largest expression containing `node` without crossing a function boundary or a statement. */
function maximalExpression(node: ts.Node): ts.Node {
  let cur = node;
  while (cur.parent && EXPR_KINDS.has(cur.parent.kind)) cur = cur.parent;
  return cur;
}

function normalize(text: string): string { return text.replace(/\s+/g, " ").trim(); }
function hash8(s: string): string { return createHash("sha256").update(s).digest("hex").slice(0, 8); }

// ─── census ─────────────────────────────────────────────────────────

export function collectSites(program: ts.Program, checker: ts.TypeChecker, files: readonly string[], root: string = REPO): ClockSite[] {
  const sites: ClockSite[] = [];
  for (const rel of files) {
    const sf = program.getSourceFile(join(root, rel));
    if (!sf) throw new Error(`not in program: ${rel}`);
    const perKey = new Map<string, number>();
    const visit = (node: ts.Node): void => {
      const clock = samplerOf(node, checker);
      if (clock !== null) {
        const scope = enclosingScope(node);
        const expr = normalize(maximalExpression(node).getText(sf));
        const key = `${rel}::${scope}::${clock}::${hash8(expr)}`;
        const k = perKey.get(key) ?? 0;
        perKey.set(key, k + 1);
        sites.push({
          file: rel,
          line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1,
          clock, scope,
          expr: expr.length > 160 ? `${expr.slice(0, 157)}...` : expr,
          category: "UNCLASSIFIED",
          id: `${key}#${k}`,
        });
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  return sites;
}

export function countBy(sites: ClockSite[]): Record<string, number> {
  const out: Record<string, number> = { TOTAL: sites.length };
  for (const s of sites) {
    out[`cat:${s.category}`] = (out[`cat:${s.category}`] ?? 0) + 1;
    out[`clock:${s.clock}`] = (out[`clock:${s.clock}`] ?? 0) + 1;
  }
  return out;
}

export function diff(live: ClockSite[], base: Ratchet): { added: ClockSite[]; removed: ClockSite[] } {
  const baseIds = new Set(base.sites.map((s) => s.id));
  const liveIds = new Set(live.map((s) => s.id));
  return { added: live.filter((s) => !baseIds.has(s.id)), removed: base.sites.filter((s) => !liveIds.has(s.id)) };
}

export function loadRatchet(path: string = RATCHET): Ratchet | null {
  return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as Ratchet) : null;
}

/** Live census with categories carried over from the baseline BY ID. Nothing else assigns a category. */
export function classify(live: ClockSite[], base: Ratchet | null): ClockSite[] {
  const prior = new Map((base?.sites ?? []).map((s) => [s.id, s.category as string]));
  for (const s of live) {
    const p = prior.get(s.id);
    s.category = p !== undefined && CLASSIFIED.has(p) ? (p as Category) : "UNCLASSIFIED";
  }
  return live;
}

export function ratchetOf(sites: ClockSite[]): Ratchet {
  return {
    generated: isoNow(),
    note: "O1 raw-clock debt across src/ and scripts/. Every entry samples a platform clock outside src/clock.ts and was classified A-E by a reader. " +
      "The ratchet only tightens: --write refuses additions and only retires; nothing here is assigned by the tool. Activation requires ZERO entries.",
    counts: countBy(sites),
    sites,
  };
}

// ─── main ───────────────────────────────────────────────────────────

function main(): number {
  const args = new Set(process.argv.slice(2));
  const files = scopedFiles();
  const { program, checker } = buildProgram(files);
  const base = loadRatchet();
  const live = classify(collectSites(program, checker, files), base);

  if (args.has("--json")) { console.log(JSON.stringify({ counts: countBy(live), sites: live }, null, 2)); return 0; }

  if (args.has("--init")) {
    if (base) { console.error(`REFUSED: ${relative(REPO, RATCHET)} exists. --init bootstraps only; use --write to retire debt.`); return 2; }
    writeFileSync(RATCHET, `${JSON.stringify(ratchetOf(live), null, 2)}\n`);
    console.log(`initialized ${relative(REPO, RATCHET)} — ${live.length} sites, ALL UNCLASSIFIED: set each site's category (A–E) by reading it.`);
    for (const [k, v] of Object.entries(countBy(live))) console.log(`  ${k.padEnd(28)} ${v}`);
    return live.some((s) => s.category === "UNCLASSIFIED") ? 1 : 0;
  }

  if (!base) { console.error(`FAIL: no ratchet at ${relative(REPO, RATCHET)}. Bootstrap with --init.`); return 1; }
  const { added, removed } = diff(live, base);

  if (args.has("--write")) {
    if (added.length > 0) {
      console.error(`REFUSED: --write is retire-only, but ${added.length} site(s) are not in the baseline:`);
      for (const s of added) console.error(`  + ${s.file}:${s.line} [${s.scope}] ${s.clock} — ${s.expr}`);
      return 2;
    }
    writeFileSync(RATCHET, `${JSON.stringify(ratchetOf(live), null, 2)}\n`);
    console.log(`retired ${removed.length} site(s); ${live.length} remain`);
    return 0;
  }

  let failed = false;
  if (added.length > 0) {
    failed = true;
    console.error(`FAIL: ${added.length} NEW raw clock sample(s) — the ratchet only tightens. Use epochNow()/monoNow().`);
    for (const s of added) console.error(`  + ${s.file}:${s.line} [${s.scope}] ${s.clock} — ${s.expr}`);
  }
  const uncl = live.filter((s) => s.category === "UNCLASSIFIED");
  if (uncl.length > 0) {
    failed = true;
    console.error(`FAIL: ${uncl.length} UNCLASSIFIED site(s) — classify each A–E in the ratchet by reading it:`);
    for (const s of uncl) console.error(`  ? ${s.file}:${s.line} [${s.scope}] ${s.clock} — ${s.expr}`);
  }
  if (removed.length > 0) {
    console.log(`${removed.length} site(s) retired since the baseline — run --write to tighten:`);
    for (const s of removed) console.log(`  - ${s.file} [${s.scope}] ${s.clock}`);
  }
  if (!failed) {
    console.log(`OK — ${live.length} raw clock site(s), none added, all classified.`);
    for (const [k, v] of Object.entries(countBy(live))) console.log(`  ${k.padEnd(28)} ${v}`);
  }
  return failed ? 1 : 0;
}

if (import.meta.main) process.exit(main());
