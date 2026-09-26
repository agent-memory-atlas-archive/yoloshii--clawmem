#!/usr/bin/env bun
/**
 * O1 typed seam audit + brand-debt ratchet (v16 — codex code-review round 15
 * findings 1–3: a VALUE that is a type parameter reads as its constraint, every
 * invocation form has its receiver (`super.m()` is the CURRENT instance, a tagged
 * template invokes its tag), and an unconstrained LIBRARY type parameter is a
 * fail-closed read unless LIBRARY_GENERIC_TRUST names the declaration; round 14: a
 * DECLARED view is read position by position (`dropped`: a type parameter as its
 * constraint, a brand the declaration cannot reach is not consumed) and a method
 * call's RECEIVER is an edge (the explicit `this` parameter, else the declaring
 * owner type); round 13: a viable union
 * constituent without a view is a view itself, every spread — nested or not — is
 * placed by one positional routine; round 12: a value meets EVERY declared view it
 * can reach — a union sink's
 * inhabitable constituents, a generic's declared type beside its instantiation,
 * each parameter a spread feeds positionally — and ANY unbranded view is an
 * erasure, nothing unioned; round 11: a slot's named property and every index
 * whose domain holds its key, each on its own; rounds 8–10: index ↔ property
 * pairing in BOTH directions under TypeScript's own applicability rules, every
 * applicable index paired, no preference anywhere; rounds 2–7 retained).
 *
 * The clock brands (`src/clock.ts`; the legacy brand's `src/clock-legacy.ts`
 * is retired from the tree and lives on only in this audit's fixtures) make an
 * epoch, a monotonic instant, a duration and a deadline non-interchangeable — but only
 * where the compiler can see, and only if something RUNS the compiler. Bun does
 * not. This audit is the gate. Every check is driven by the TypeScript program;
 * nothing is a regex.
 *
 *   C0  EVERY first-party file type-checks UNDER THE REPOSITORY'S OWN COMPILER
 *       CONTRACT — the options are read from `tsconfig.json` (`module: Preserve`,
 *       `moduleDetection: force`, `noImplicitOverride`, … — round 5 finding 1;
 *       see `o1-tsconfig.ts`), and only audit-specific keys are overridden:
 *       `noEmit`, `allowJs`, `checkJs`, the roots, and `skipLibCheck`, which a
 *       first-party declaration root turns off (TypeScript cannot skip lib checks
 *       per file). Roots are every source extension the compiler itself knows
 *       (`ts.Extension` minus `.json`/`.tsbuildinfo`: `.ts .tsx .d.ts .mts .d.mts
 *       .cts .d.cts .js .jsx .mjs .cjs`) under `src/**` and `scripts/**` (round 3
 *       finding 1, round 4 finding 1). Pre-existing errors are a
 *       ratcheted baseline keyed as a MULTISET of
 *       `file|code|message|scope|control-flow context|statement fingerprint`:
 *       a second identical error, the same error in another scope, or the same
 *       statement moved to a different branch/loop/case/try-part (finding 5) is
 *       NOT covered. A statement moving within the SAME control-flow context of
 *       its scope is (accepted residual, stated).
 *   C1  Every brand CONSTRUCTION outside the clock module carries an adjacent
 *       `O1-DEBT-NNNN` marker: assertions (`as`, `<T>`, JSDoc casts in JS) to a
 *       brand or to any type carrying a brand at ANY depth, type predicates, and
 *       ambient `declare` declarations — in `.d.ts` files too.
 *   C2  Markers <-> ratchet entries are a bijection. Identity = marker id, file,
 *       scope, kind, brand set and a hash of the COMPLETE normalized expression
 *       (finding 6: the stored text is display only).
 *   C3  No `any` / `unknown` reaches a brand-carrying sink — as the whole value,
 *       OR structurally inside a container whose corresponding sink shape carries
 *       a brand (finding 2: `{ deadlineAt: someAny }` into branded options,
 *       `[someAny]` into `LegacyWallDeadline[]`), OR through a SIGNATURE (round 5
 *       finding 3): a sink whose call signature takes or returns a brand is
 *       brand-carrying, so `const i: { m(d: LegacyWallDeadline): void } = someAny`,
 *       an implementation returning `any` behind `m(): LegacyWallDeadline`, and an
 *       implementation PARAMETER declared or inferred `any` behind a branded one
 *       (round 6) are all C3 — value and signature positions are paired to any
 *       depth, sink signatures matched to value signatures by correspondence
 *       (below). Each defect has ONE reporter: returns and whole values through
 *       `anyReaches` at the edge, parameters through the drop lock. The sink's
 *       DECLARED type is checked as well as its instantiated type, so a
 *       constrained generic called with `any` is caught.
 *   C4  A TARGET brand never erases — itself or inside any container — into a
 *       sink typed without it, never appears in direct or compound arithmetic
 *       outside the clock module, and is never DROPPED by an implementation whose
 *       declared parameter is wider than its public signature (below).
 *   C5  THE VALUE-FLOW CLOSURE. A value that IS or CARRIES `LegacyWallDeadline`
 *       may not flow into a sink typed without it, whatever the sink's
 *       provenance. Exactly three exemptions exist, all explicit:
 *         - LEGACY_SINK_ALLOWLIST — TERMINAL default-lib operations whose result
 *           cannot carry a deadline onward: boolean predicates ONLY. Arithmetic
 *           (`Math.min` …) returns a bare `number` the audit cannot follow, and
 *           `String(d)` is serialization that `Number(String(d))` re-materializes
 *           (round 4 finding 3), so both are erasures unless the result is
 *           re-asserted with debt or the value is marked. Identity is the DEFAULT LIB
 *           (`program.isSourceFileDefaultLibrary`), never a name: a dependency's
 *           declaration merging cannot spoof an entry.
 *         - LIBRARY_GENERIC_TRUST — default-lib GENERICS whose unconstrained type
 *           parameter is held, passed or compared, never consumed (round 15
 *           finding 3): a `.d.ts` proves nothing about the body behind it
 *           (`coerce<T>(x: T): number` may `Number(x)`), so an unconstrained
 *           library `T` reads EVERYTHING the value carries — fail closed — unless
 *           its declaration is named here, under the same default-lib identity gate.
 *         - a debt marker on the VALUE expression (`sink(x /​* O1-DEBT-NNNN *​/)`)
 *           records the erasure as a ratchet entry of kind `erasure` — counted,
 *           bijective, retire-only, and zero at activation like every entry.
 *       A first-party parameter or property typed bare `number` that receives a
 *       legacy deadline is an UNBRANDED SEAM; removing the brand from any
 *       implementation fails here.
 *
 * Sinks (every value-bearing edge the checker resolves): call/construct
 * arguments including spread arguments (each remaining parameter); annotated
 * variable initializers; `return`s and expression bodies against the declared
 * return type — or, for arrow/function expressions and object-literal
 * methods/accessors, the CONTEXTUAL one when it is concrete (an inference type
 * parameter carries the brand; `void` discards; `any` is a sink); `yield`
 * against the declared `Generator<Y, R>` yield type, and a generator's `return`
 * against `R`; assignments `=`, `??=`, `||=`, `&&=` including element
 * assignments `a[i] = x` (compound arithmetic assignments are the legacy
 * arithmetic path for a legacy deadline and C4 for a target brand). Object and
 * array LITERALS are descended to their leaves — each property (identifier,
 * string, numeric or literal-computed name) against the sink's property type,
 * each element against the sink's element type, each spread against the sink —
 * so every erasure is reported once, at the leaf.
 *
 * PRODUCTION-BOUNDARY LOCKS (round 3 finding 3, round 4 finding 2, round 5
 * findings 2–4). TypeScript's method bivariance lets an implementation declare a
 * WIDER parameter than the signature it stands behind — an overload's
 * implementation, a class member behind an `implements`/`extends` member, an
 * object-literal method / function property / accessor under a contextual type,
 * an INTERFACE redeclaring an inherited member, and any value STRUCTURALLY
 * assigned to a branded shape without `implements` (`const i: I = new C()`, a
 * function passed where a branded callback type is expected). Calls resolve to
 * the public signature, so the wider parameter is an unbranded seam no call-site
 * check sees. Every declaration-shaped case is checked at its declaration, and
 * every value-bearing edge additionally compares the VALUE's member / call
 * signatures against the sink's, member by member, to any depth: a brand the
 * sink parameter carries that the DECLARED value parameter does not is C5
 * (legacy) / C4 (target). RETURNS are compared too (round 5 finding 3):
 * covariance means a narrower return cannot erase, so the two ways a return
 * drops are `any` (C3) and a brand in a PARAMETER of the returned type (`():
 * (d: LegacyWallDeadline) => void` implemented by `(): (d: number) => void`),
 * which the same lock finds recursively. Sink signatures are matched to value
 * signatures by CORRESPONDENCE, never as a Cartesian product (round 5 finding
 * 4): a sink overload is paired with the value overloads that accept what it
 * carries at every shared parameter position — `this` included (round 6 finding
 * 2: `(this: { d: number }) => void` behind `(this: { d: LegacyWallDeadline })
 * => void` is a drop like any other parameter). An UNCONSTRAINED type parameter
 * (`<T>(d: T)`) pairs with any sink parameter and IS a drop (round 6 finding 1):
 * `T` carries no brand, so nothing inside the callee is a seam — `Number(String(d))`
 * there is invisible — and the implementation must declare the brand it stands
 * behind. (`Brands.withinSig` traverses call and construct signatures for the
 * locks — parameters, `this`, returns; `Brands.within`, value flow, does not: an
 * object whose METHOD takes a deadline does not itself carry one.)
 *
 * Brand identity is the private `unique symbol` each brand is keyed on: a
 * property whose computed key resolves to that symbol IS the brand, through
 * aliases, instantiations, unions, intersections, type parameters (via their
 * base constraint), type arguments, array elements and INDEX SIGNATURES of
 * every key domain — string, number, template literal, symbol (`Record<string,
 * LegacyWallDeadline>` carries the brand; a literal's key with no named property
 * flows into the sink index whose domain holds it; an optional sink PROPERTY the
 * value answers only through an index is paired with that index — rounds 6–8,
 * under the checker's own applicability rules, mirrored not approximated) alike, to
 * ANY depth (no depth cap; a cycle guard bounds the walk and only complete
 * results are memoized). Names are never compared. The walk descends into
 * members that are FIRST-PARTY by path ownership (`ownsPath`, the ONE predicate
 * every first-party test here uses) — the type's own declaration or the
 * member's, so a first-party `.d.ts` counts (round 5 finding 2) and a lib mapped
 * type over a first-party shape (`Partial<Req>`) is followed to `Req`'s members
 * — plus, as a separate stated POLICY, members and types without a declaration
 * at all (synthesized: spreads, mapped instantiations), which have no path to
 * test and are descended. `Date`, `Map`, `Promise` and a dependency's DECLARED
 * members are never descended: they cannot carry a first-party brand (their
 * type arguments are walked).
 *
 * Accepted residuals, stated: (a) two byte-identical constructions in one scope
 * are told apart by their markers, so swapping them is invisible — harmless, the
 * entries are identical; (b) a baselined diagnostic whose statement moves within
 * the same control-flow context of its scope stays covered; (c) a computed
 * property key that is not a literal is checked against the sink's string index
 * type, or the sink itself when it has none.
 *
 * KNOWN GAPS (the review ladder closed at v16 by operator ruling, 2026-08-29 —
 * round 16's claims, recorded rather than adjudicated; each fails CLOSED where the
 * walk can see it and is simply unmodelled where it cannot):
 *   (1) `dropped`'s value-side rule resolves a type parameter to its BASE
 *       constraint — an intersection holding one (`T & {}`), a `keyof T` / `T[K]`
 *       value, a union of type parameters, and a constraint wider than the
 *       instantiation may over- or under-read.
 *   (2) Receivers: `super` inside an object-literal method or a class field
 *       initializer falls back to the checker's base-typed `super`; `super.x`
 *       property READS are no edge (no call); a class expression reached through a
 *       variable resolves by `classSymbol` only when the declaration is in reach.
 *   (3) LIBRARY_GENERIC_TRUST is MINIMAL — a library generic the tree starts using
 *       fails closed until an entry with its contract is added; an instantiated
 *       library callback type is opened ONE level (a library callback that itself
 *       takes a callback — `then` over a `PromiseLike`, iterator helpers — and an
 *       object-literal parameter carrying callbacks are not opened).
 *   (4) A value parameter declared in ANOTHER first-party file is checked at the
 *       edge, not at its declaration; whether a declaration-side lock can report
 *       the same drop twice, and whether a same-file value's foreign-declared
 *       overload is reached, is unverified.
 *   (5) Nothing cleared in rounds 8–15 has been re-verified against v16 by review
 *       (the 129 locks are the record).
 *
 * `--write` is RETIRE-ONLY; `--init` bootstraps once and refuses non-C0 findings.
 *
 * Usage:
 *   bun scripts/o1-seam-audit.ts            # check
 *   bun scripts/o1-seam-audit.ts --init     # bootstrap o1-seam-debt.json (refuses if it exists)
 *   bun scripts/o1-seam-audit.ts --write    # retire debt / diagnostics (refuses additions)
 *   bun scripts/o1-seam-audit.ts --json     # closure + entries + diagnostics + findings
 */

import ts from "typescript";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { isoNow } from "../src/clock.ts";
import { repoCompilerOptions } from "./o1-tsconfig.ts";

const REPO = resolve(import.meta.dir, "..");
const RATCHET = process.env.O1_SEAM_RATCHET ? resolve(process.env.O1_SEAM_RATCHET) : join(REPO, "o1-seam-debt.json");

export const CLOCK_MODULE = "src/clock.ts";
/** The legacy brand's module — RETIRED from the real tree at the O1 migration (zero debt entries); the fixture
 * tests still write it, and `Brands` simply skips it when the program has no such file. */
export const LEGACY_MODULE = "src/clock-legacy.ts";
export const LEGACY_BRAND = "LegacyWallDeadline";

/** `declare const NAME: unique symbol` -> brand alias. Resolved to SYMBOLS at program start. */
const SYMBOL_TO_BRAND: Record<string, string> = {
  EPOCH_MS: "EpochMs",
  MONO_INSTANT: "MonoInstant",
  DURATION_MS: "DurationMs",
  MONO_DEADLINE: "MonoDeadline",
  SIGNED_DELTA_MS: "SignedDeltaMs",
  LEGACY_WALL_DEADLINE: LEGACY_BRAND,
};
export const BRAND_NAMES = new Set(Object.values(SYMBOL_TO_BRAND));
const MARKER_RE = /\/\*\s*(O1-DEBT-\d{4})\s*\*\//g;

/**
 * The ONLY sinks a `LegacyWallDeadline` may flow into unmarked: TERMINAL
 * default-lib operations whose result cannot carry a deadline onward — boolean
 * predicates. Keyed `<Owner>.<member>` (`<call>` / `<construct>` for signatures
 * on the owner itself) AND required to come from TypeScript's own lib files.
 * `Math.*` arithmetic is NOT here (its bare-number result would leave the
 * closure) and neither is `String` (serialization: `Number(String(d))` comes
 * back) — a legacy `Math.min(a, b)` must be re-asserted as debt and a
 * `String(d)` must be a marked erasure.
 */
export const LEGACY_SINK_ALLOWLIST: ReadonlySet<string> = new Set([
  "NumberConstructor.isFinite", "NumberConstructor.isInteger", "NumberConstructor.isSafeInteger", "NumberConstructor.isNaN",
  "isFinite", "isNaN",
]);

/**
 * Default-lib GENERICS whose unconstrained type parameter is HELD, PASSED or COMPARED — never consumed (round 15
 * finding 3). An unconstrained `T` in a `.d.ts` proves nothing about the body behind it — `coerce<T>(x: T): number`
 * may `Number(x)` — so an untrusted library `T` reads EVERYTHING the value carries (fail closed, as a first-party
 * one does, round 6 finding 1) and only an entry here reads nothing. Keyed `<Owner>.<member>` and gated on the
 * DEFAULT LIB exactly like LEGACY_SINK_ALLOWLIST: a dependency is never trusted, whatever it spells. Each entry is
 * identity-preserving by the lib's own contract — a container holds `T`, an iteration method passes `T` to a
 * first-party callback (whose own parameters are audited), a search compares by SameValueZero, `Promise` settles
 * with it. NOT here, an erasure when a deadline reaches them: `Array.join` / `Array.toString` /
 * `Array.toLocaleString` (serialization), `Array.sort` (the default comparator serializes), `Array.flat` (its depth
 * is a number).
 */
export const LIBRARY_GENERIC_TRUST: ReadonlySet<string> = new Set([
  "PromiseConstructor.resolve",              // settles with the value
  "Array.includes", "Array.indexOf",         // compare by SameValueZero
  "Array.map",                               // passes each element to a first-party callback; holds what it returns
  "Array.fill",                              // holds `value: T` (`start` / `end` are numbers: their own erasure)
  "Map.set", "Map.get",                      // hold / return `V`
]);

export type Check = "C0" | "C1" | "C2" | "C3" | "C4" | "C5";
export interface Finding { check: Check; file: string; line: number; message: string }
export type DebtKind = "construction" | "erasure";
export interface DebtEntry {
  id: string; kind: DebtKind; file: string; scope: string; brands: string[];
  /** sha256-8 of the COMPLETE normalized node text — the identity. */
  hash: string;
  /** Display only (truncated). */
  text: string;
}
export interface KnownDiagnostic { file: string; code: number; message: string; scope: string; context: string; fingerprint: string }
export interface ClosureMember { file: string; line: number; kind: "parameter" | "property" | "variable"; name: string; owner: string; brands: string[] }
export interface SeamRatchet { generated: string; note: string; entries: DebtEntry[]; knownDiagnostics: KnownDiagnostic[] }
export interface AuditResult {
  findings: Finding[];
  closure: ClosureMember[];
  entries: DebtEntry[];
  diagnostics: KnownDiagnostic[];
  /** Ratchet entries / diagnostics no longer present — progress, reported for --write. */
  retired: { entries: DebtEntry[]; diagnostics: KnownDiagnostic[] };
}

// ─── scope ──────────────────────────────────────────────────────────

/** Every source extension the compiler knows, minus data/metadata files. */
export const SOURCE_EXTENSIONS: readonly string[] = Object.values(ts.Extension).filter((e): e is ts.Extension => typeof e === "string" && e !== ts.Extension.Json && e !== ts.Extension.TsBuildInfo);

/** Every first-party source under src/ and scripts/, by the compiler's own extension list (declaration files included). */
export function scopedFiles(root: string = REPO): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    if (!existsSync(dir)) return;
    for (const name of readdirSync(dir)) {
      const abs = join(dir, name);
      if (name === "gits" || name === "node_modules" || name.startsWith(".")) continue;
      if (statSync(abs).isDirectory()) walk(abs);
      else if (SOURCE_EXTENSIONS.some((e) => name.endsWith(e))) out.push(relative(root, abs));
    }
  };
  walk(join(root, "src"));
  walk(join(root, "scripts"));
  return out.sort();
}

const isDeclarationName = (f: string): boolean => /\.d\.(ts|mts|cts)$/.test(f);

/** THE first-party predicate — PATH OWNERSHIP: under the root and not under node_modules; `.d.ts` and JS included. */
export const ownsPath = (root: string, fileName: string): boolean => fileName.startsWith(`${root}/`) && !fileName.includes("/node_modules/");
const isThisParam = (p: ts.ParameterDeclaration): boolean => ts.isIdentifier(p.name) && p.name.text === "this";

/**
 * The program under the REPOSITORY'S compiler contract (`tsconfig.json`, round 5
 * finding 1) — whatever the root, so a fixture is checked under the options the
 * real tree ships with. Overridden: only what the audit itself requires.
 */
export function buildProgram(files: readonly string[], root: string = REPO): { program: ts.Program; checker: ts.TypeChecker } {
  const firstPartyDts = files.some(isDeclarationName);
  const program = ts.createProgram(files.map((f) => join(root, f)), {
    ...repoCompilerOptions(),
    noEmit: true,
    allowJs: true,   // JS roots are in scope whatever the contract says about emitting them
    checkJs: true,   // …and they are CHECKED: a first-party .js is a first-party surface
    // TypeScript skips lib checks for EVERY declaration file or none: a first-party `.d.ts` root
    // buys its C0 at the price of checking the external ones too (diagnostics are collected per ROOT).
    skipLibCheck: !firstPartyDts,
  });
  return { program, checker: program.getTypeChecker() };
}

// ─── brand identity (by unique symbol, never by name) ───────────────

class Brands {
  private readonly bySymbol = new Map<ts.Symbol, string>();
  private readonly ofCache = new Map<ts.Type, Set<string>>();
  /** Only COMPLETE results are memoized: a walk that met a cycle is not. Two caches: values vs. values+signatures. */
  private readonly withinCache = new Map<ts.Type, Set<string>>();
  private readonly withinSigCache = new Map<ts.Type, Set<string>>();

  constructor(program: ts.Program, private readonly checker: ts.TypeChecker, private readonly root: string) {
    for (const rel of [CLOCK_MODULE, LEGACY_MODULE]) {
      const sf = program.getSourceFile(join(root, rel));
      if (!sf) continue;
      for (const st of sf.statements) {
        if (!ts.isVariableStatement(st)) continue;
        for (const d of st.declarationList.declarations) {
          if (!ts.isIdentifier(d.name) || !d.type || !ts.isTypeOperatorNode(d.type) || d.type.operator !== ts.SyntaxKind.UniqueKeyword) continue;
          const brand = SYMBOL_TO_BRAND[d.name.text];
          const sym = checker.getSymbolAtLocation(d.name);
          if (brand && sym) this.bySymbol.set(sym, brand);
        }
      }
    }
  }

  get resolved(): number { return this.bySymbol.size; }

  /**
   * May the walk descend here? `ownsPath` for anything declared (round 5 finding 2: a
   * first-party `.d.ts` is ours); a type or member with NO declaration (intrinsic /
   * synthesized) has no path to test and is descended — a stated POLICY, kept apart from
   * the path predicate `audit` shares (round 6 finding 4).
   */
  private owns(d: ts.Declaration | undefined): boolean {
    return d === undefined || ownsPath(this.root, d.getSourceFile().fileName);
  }

  /** The brand a property symbol keys, if its computed name resolves to a brand symbol. */
  private brandOfProperty(p: ts.Symbol): string | undefined {
    for (const d of p.declarations ?? []) {
      const name = (d as ts.NamedDeclaration).name;
      if (name && ts.isComputedPropertyName(name)) {
        const s = this.checker.getSymbolAtLocation(name.expression);
        const b = s ? this.bySymbol.get(s) : undefined;
        if (b) return b;
      }
    }
    return undefined;
  }

  /** Brands the type ITSELF is (unions / intersections / aliases / type-parameter constraints resolved). */
  of(t: ts.Type): Set<string> {
    const hit = this.ofCache.get(t);
    if (hit) return hit;
    const out = new Set<string>();
    this.ofCache.set(t, out); // cycle guard (unions/intersections are flattened by the checker)
    if (t.flags & ts.TypeFlags.TypeParameter) {
      const c = this.checker.getBaseConstraintOfType(t);
      if (c && c !== t) for (const b of this.of(c)) out.add(b);
      return out;
    }
    if (t.isUnion()) { for (const c of t.types) for (const b of this.of(c)) out.add(b); return out; }
    if (t.isIntersection()) {
      for (const c of t.types) {
        for (const b of this.of(c)) out.add(b);
        for (const p of c.getProperties()) { const b = this.brandOfProperty(p); if (b) out.add(b); }
      }
      return out;
    }
    for (const p of t.getProperties()) { const b = this.brandOfProperty(p); if (b) out.add(b); }
    return out;
  }

  /**
   * Brands a VALUE of this type is or carries at ANY depth: constituents, constraints,
   * type arguments, array elements, properties. Signatures are NOT values: an object
   * whose METHOD takes a deadline does not itself carry one (see `withinSig`).
   */
  within(t: ts.Type, at: ts.Node): Set<string> { return this.query(t, at, false); }

  /**
   * Brands the type carries in its VALUES OR ITS SIGNATURES — parameters and returns
   * of call / construct signatures of first-party types, to any depth. This is the
   * shape the structural locks compare; it is never used for value flow.
   */
  withinSig(t: ts.Type, at: ts.Node): Set<string> { return this.query(t, at, true); }

  private query(t: ts.Type, at: ts.Node, sigs: boolean): Set<string> {
    const cache = sigs ? this.withinSigCache : this.withinCache;
    const hit = cache.get(t);
    if (hit) return hit;
    const out = new Set<string>();
    const complete = this.walk(t, at, new Set(), out, sigs);
    if (complete) cache.set(t, out);
    return out;
  }

  /** Returns false if the walk met a type already on the path (a cycle) — the shared `out` is still complete for the ROOT query. */
  private walk(t: ts.Type, at: ts.Node, path: Set<ts.Type>, out: Set<string>, sigs: boolean): boolean {
    const memo = (sigs ? this.withinSigCache : this.withinCache).get(t);
    if (memo) { for (const b of memo) out.add(b); return true; }
    if (path.has(t)) return false;
    path.add(t);
    let complete = true;
    for (const b of this.of(t)) out.add(b);
    if (t.flags & ts.TypeFlags.TypeParameter) {
      const c = this.checker.getBaseConstraintOfType(t);
      if (c && c !== t) complete = this.walk(c, at, path, out, sigs) && complete;
    } else if (t.isUnion() || t.isIntersection()) {
      for (const c of t.types) complete = this.walk(c, at, path, out, sigs) && complete;
    } else if (t.flags & ts.TypeFlags.Object) {
      if ((t as ts.ObjectType).objectFlags & ts.ObjectFlags.Reference) {
        for (const a of this.checker.getTypeArguments(t as ts.TypeReference)) complete = this.walk(a, at, path, out, sigs) && complete;
      }
      // Descend into members that are FIRST-PARTY — by the type's own declaration or by the
      // member's (a lib mapped type over a first-party shape, `Partial<Req>`, declares its
      // properties where `Req` does). `Date`, `Map`, `Promise` and a dependency's DECLARED
      // types are never descended: their type arguments were covered above and their members
      // can never carry a first-party brand. A first-party `.d.ts` IS descended (round 5
      // finding 2). In SIGNATURE mode an INSTANTIATED library CALLBACK type — a function type literal
      // (a `__type` symbol), never a member's method type — is opened for its signatures (round 15):
      // `map`'s `(value: LegacyWallDeadline, index: number, array: LegacyWallDeadline[]) => U` carries
      // the brand in the substitution, which is no type argument the reference walk sees. It is read
      // ONE level deep: its parameters and return as VALUES (their constituents, type arguments and
      // owned members), never as signatures again. A library interface's MEMBERS stay closed: opening
      // `Array<LegacyWallDeadline>.includes`'s method type would make every structural comparison walk
      // the whole library type graph behind it (Array → iterators → iterator helpers …) — measured as
      // a 20 GB runaway on a single `return [d].map(x => x)` edge.
      const ownType = this.owns(t.getSymbol()?.declarations?.[0]);
      const instantiated = sigs && !ownType && ((t as ts.ObjectType).objectFlags & ts.ObjectFlags.Instantiated) !== 0
        && ((t.getSymbol()?.flags ?? 0) & ts.SymbolFlags.TypeLiteral) !== 0;
      for (const p of t.getProperties()) {
        if (this.brandOfProperty(p)) continue; // the brand key itself
        if (!ownType && !this.owns(p.declarations?.[0])) continue;
        complete = this.walk(this.checker.getTypeOfSymbolAtLocation(p, at), at, path, out, sigs) && complete;
      }
      // Index signatures are members too (round 6): `Record<string, LegacyWallDeadline>` carries the brand.
      for (const info of this.checker.getIndexInfosOfType(t)) {
        if (!ownType && !this.owns(info.declaration)) continue;
        complete = this.walk(info.type, at, path, out, sigs) && complete;
      }
      if (sigs) for (const sig of [...t.getCallSignatures(), ...t.getConstructSignatures()]) {
        const owned = ownType || this.owns(sig.declaration);
        if (!owned && !instantiated) continue;
        const deeper = owned; // an instantiated library signature's positions are read as values
        for (const p of [...sig.getParameters(), ...(sig.thisParameter ? [sig.thisParameter] : [])]) complete = this.walk(this.checker.getTypeOfSymbolAtLocation(p, at), at, path, out, deeper) && complete;
        complete = this.walk(sig.getReturnType(), at, path, out, deeper) && complete;
      }
    }
    path.delete(t);
    return complete;
  }
}

const isTarget = (b: string): boolean => b !== LEGACY_BRAND;
const isAnyish = (t: ts.Type): boolean => (t.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0;
const isVoidish = (t: ts.Type): boolean => (t.flags & (ts.TypeFlags.Void | ts.TypeFlags.Undefined | ts.TypeFlags.Never)) !== 0;
const isRef = (t: ts.Type): t is ts.TypeReference => (t.flags & ts.TypeFlags.Object) !== 0 && ((t as ts.ObjectType).objectFlags & ts.ObjectFlags.Reference) !== 0;

// ─── helpers ────────────────────────────────────────────────────────

function ownerOf(node: ts.Node): string {
  const parts: string[] = [];
  for (let cur: ts.Node | undefined = node.parent; cur; cur = cur.parent) {
    if ((ts.isFunctionDeclaration(cur) || ts.isMethodDeclaration(cur) || ts.isMethodSignature(cur) || ts.isClassDeclaration(cur) ||
         ts.isInterfaceDeclaration(cur) || ts.isTypeAliasDeclaration(cur)) && cur.name) parts.unshift(cur.name.getText());
    else if (ts.isVariableDeclaration(cur) && ts.isIdentifier(cur.name)) parts.unshift(cur.name.getText());
    else if ((ts.isPropertyAssignment(cur) || ts.isPropertySignature(cur)) && ts.isIdentifier(cur.name)) parts.unshift(cur.name.getText());
  }
  return parts.length > 0 ? parts.join(".") : "<module>";
}

/** `<Owner>.<member>` of the signature or property a sink declaration belongs to, for the allowlist and messages. */
function sinkName(decl: ts.Declaration | undefined): string {
  if (!decl) return "<unknown>";
  const member: ts.Node = ts.isParameter(decl) ? decl.parent : decl;
  let name: string;
  if (ts.isCallSignatureDeclaration(member)) name = "<call>";
  else if (ts.isConstructSignatureDeclaration(member)) name = "<construct>";
  else if (ts.isConstructorDeclaration(member)) name = "<constructor>";
  else name = ((member as ts.NamedDeclaration).name?.getText() ?? "<anonymous>");
  let owner = "";
  for (let p: ts.Node | undefined = member.parent; p; p = p.parent) {
    if ((ts.isInterfaceDeclaration(p) || ts.isClassDeclaration(p) || ts.isModuleDeclaration(p)) && p.name) { owner = p.name.getText(); break; }
    if (ts.isTypeLiteralNode(p) && p.parent && ts.isTypeAliasDeclaration(p.parent)) { owner = p.parent.name.text; break; }
    if (ts.isSourceFile(p) || ts.isFunctionLike(p)) break;
  }
  return owner ? `${owner}.${name}` : name;
}

/** A property name as a key when it is statically known: identifier, string/numeric literal, or a literal-computed name. */
function propKey(name: ts.PropertyName | undefined): string | undefined {
  if (!name) return undefined;
  if (ts.isIdentifier(name) || ts.isPrivateIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) return name.text;
  if (ts.isComputedPropertyName(name) && (ts.isStringLiteral(name.expression) || ts.isNumericLiteral(name.expression) || ts.isNoSubstitutionTemplateLiteral(name.expression))) return name.expression.text;
  return undefined;
}

function markerAfter(sf: ts.SourceFile, node: ts.Node): { id: string; pos: number } | null {
  for (const r of ts.getTrailingCommentRanges(sf.text, node.end) ?? []) {
    const m = /^\/\*\s*(O1-DEBT-\d{4})\s*\*\/$/.exec(sf.text.slice(r.pos, r.end));
    if (m) return { id: m[1]!, pos: r.pos };
  }
  return null;
}

function withinMarkedAssertion(sf: ts.SourceFile, node: ts.Node): boolean {
  for (let cur: ts.Node | undefined = node.parent; cur; cur = cur.parent) {
    if ((ts.isAsExpression(cur) || ts.isTypeAssertionExpression(cur) || jsDocCastType(cur)) && markerAfter(sf, cur)) return true;
  }
  return false;
}

/** A JS cast `/** @type {T} *​/ (expr)`: the parenthesized expression's `@type` tag, in a JavaScript file only. */
function jsDocCastType(node: ts.Node): ts.TypeNode | undefined {
  if (!ts.isParenthesizedExpression(node) || !(node.getSourceFile().flags & ts.NodeFlags.JavaScriptFile)) return undefined;
  return ts.getJSDocTypeTag(node)?.typeExpression.type;
}

const lineOf = (sf: ts.SourceFile, node: ts.Node): number => sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
const isAmbient = (n: ts.Node): boolean => (ts.getCombinedModifierFlags(n as ts.Declaration) & ts.ModifierFlags.Ambient) !== 0;
const normalize = (s: string): string => s.replace(/\s+/g, " ").trim();
const hash8 = (s: string): string => createHash("sha256").update(s).digest("hex").slice(0, 8);

function enclosingFunction(node: ts.Node): ts.SignatureDeclaration | undefined {
  for (let cur: ts.Node | undefined = node.parent; cur; cur = cur.parent) if (ts.isFunctionLike(cur)) return cur;
  return undefined;
}

/** The innermost statement (or class member) containing `pos` — the unit a diagnostic is fingerprinted on. */
function statementAt(sf: ts.SourceFile, pos: number): ts.Node {
  let best: ts.Node = sf;
  const visit = (n: ts.Node): void => {
    if (n.pos > pos || pos >= n.end) return;
    if (ts.isStatement(n) || ts.isClassElement(n) || ts.isTypeElement(n)) best = n;
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return best;
}

/** Normalized control-flow ancestry of a statement within its scope: which branch / loop / case / try-part holds it. */
function controlContext(stmt: ts.Node, sf: ts.SourceFile): string {
  const parts: string[] = [];
  const N = (n: ts.Node | undefined): string => (n ? normalize(n.getText(sf)) : "");
  let child: ts.Node = stmt;
  for (let cur: ts.Node | undefined = stmt.parent; cur && !ts.isSourceFile(cur) && !ts.isFunctionLike(cur); child = cur, cur = cur.parent) {
    if (ts.isIfStatement(cur)) parts.unshift(`if(${N(cur.expression)}):${child === cur.elseStatement ? "else" : "then"}`);
    else if (ts.isForStatement(cur)) parts.unshift(`for(${N(cur.initializer)};${N(cur.condition)};${N(cur.incrementor)})`);
    else if (ts.isForOfStatement(cur)) parts.unshift(`for(${N(cur.initializer)} of ${N(cur.expression)})`);
    else if (ts.isForInStatement(cur)) parts.unshift(`for(${N(cur.initializer)} in ${N(cur.expression)})`);
    else if (ts.isWhileStatement(cur)) parts.unshift(`while(${N(cur.expression)})`);
    else if (ts.isDoStatement(cur)) parts.unshift(`do-while(${N(cur.expression)})`);
    else if (ts.isSwitchStatement(cur)) parts.unshift(`switch(${N(cur.expression)})`);
    else if (ts.isCaseClause(cur)) parts.unshift(`case(${N(cur.expression)})`);
    else if (ts.isDefaultClause(cur)) parts.unshift("default");
    else if (ts.isTryStatement(cur)) { if (child === cur.tryBlock) parts.unshift("try"); else if (child === cur.finallyBlock) parts.unshift("finally"); }
    else if (ts.isCatchClause(cur)) parts.unshift(`catch(${N(cur.variableDeclaration)})`);
    else if (ts.isLabeledStatement(cur)) parts.unshift(`label(${cur.label.text})`);
  }
  return parts.join(">");
}

// ─── the audit ──────────────────────────────────────────────────────

/** A view of a value: its declared type and declaration; `structural` when it is a DECLARED (generic) type read position by position (`dropped`), `trusted` when an unconstrained type parameter in it reads nothing (a LIBRARY_GENERIC_TRUST declaration; every other one reads everything). */
interface Sink { type: ts.Type; decl?: ts.Declaration; structural?: boolean; trusted?: boolean }

export function audit(files: readonly string[] = scopedFiles(), root: string = REPO, ratchet: SeamRatchet | null = loadRatchet()): AuditResult {
  const { program, checker } = buildProgram(files, root);
  const brands = new Brands(program, checker, root);
  if (brands.resolved === 0) throw new Error("no brand symbols resolved — are src/clock.ts and src/clock-legacy.ts in the program?");

  /** First-party = `ownsPath` (the one predicate); an undeclared sink is not first-party. */
  const firstParty = (d: ts.Declaration | undefined): boolean => d !== undefined && ownsPath(root, d.getSourceFile().fileName);
  /** TypeScript's OWN lib files — the only provenance the allowlist accepts. */
  const isDefaultLib = (d: ts.Declaration | undefined): boolean => !!d && program.isSourceFileDefaultLibrary(d.getSourceFile());
  /** A LIBRARY_GENERIC_TRUST declaration — by default-lib identity, never by name alone (a dependency's declaration merging cannot spoof an entry). */
  const isTrusted = (d: ts.Declaration | undefined): boolean => isDefaultLib(d) && LIBRARY_GENERIC_TRUST.has(sinkName(d));
  /** The symbol of a class or interface — by name, or the declaration's own symbol for an anonymous class expression. */
  const classSymbol = (d: ts.ClassLikeDeclaration | ts.InterfaceDeclaration): ts.Symbol | undefined =>
    d.name ? checker.getSymbolAtLocation(d.name) : (d as ts.Declaration & { symbol?: ts.Symbol }).symbol;

  const findings: Finding[] = [];
  const seen = new Set<string>();
  const closure: ClosureMember[] = [];
  const entries: DebtEntry[] = [];
  const diagnostics: KnownDiagnostic[] = [];
  const markerSeen = new Map<string, { file: string; pos: number }[]>();
  const fail = (check: Check, file: string, line: number, message: string): void => {
    const k = `${check}|${file}|${line}|${message}`;
    if (seen.has(k)) return;
    seen.add(k);
    findings.push({ check, file, line, message });
  };

  const paramType = (p: ts.Symbol, at: ts.Node): ts.Type => checker.getTypeOfSymbolAtLocation(p, at);

  /** An UNCONSTRAINED type parameter accepts any argument (round 5 finding 4) — a signature-CORRESPONDENCE predicate only; what a body does with the value is `dropped`'s question (round 15 finding 3). */
  const unconstrainedParam = (t: ts.Type): boolean => {
    if (!(t.flags & ts.TypeFlags.TypeParameter)) return false;
    const c = checker.getBaseConstraintOfType(t);
    return !c || (c.flags & ts.TypeFlags.Unknown) !== 0;
  };

  /**
   * CORRESPONDENCE, not a Cartesian product (round 5 finding 4): each sink
   * signature is paired with the value signatures that can stand behind it —
   * those accepting, at every shared parameter position and at `this` (round 6
   * finding 2), what the sink parameter carries (a type parameter accepts
   * anything — it is paired, then COMPARED, and found wanting: round 6 finding 1).
   * A sink signature that no value signature matches is paired with ALL of them:
   * that fails closed, and cannot arise from an assignment the compiler accepted.
   */
  const correspond = (ssigs: readonly ts.Signature[], vsigs: readonly ts.Signature[], at: ts.Node): [ts.Signature, ts.Signature][] => {
    const accepts = (s: ts.Symbol | undefined, v: ts.Symbol | undefined): boolean => {
      if (!s || !v) return true; // nothing on one side to accept
      const vt = paramType(v, at);
      return unconstrainedParam(vt) || checker.isTypeAssignableTo(paramType(s, at), vt);
    };
    const out: [ts.Signature, ts.Signature][] = [];
    for (const ss of ssigs) {
      const sp = ss.getParameters();
      // a surplus value parameter is optional, or the assignment did not compile (C0)
      const compatible = vsigs.filter((vs) => accepts(ss.thisParameter, vs.thisParameter) && vs.getParameters().every((vp, i) => accepts(sp[i], vp)));
      for (const vs of compatible.length > 0 ? compatible : vsigs) out.push([ss, vs]);
    }
    return out;
  };
  const corresponding = (v: ts.Type, s: ts.Type, at: ts.Node): [ts.Signature, ts.Signature][] =>
    [...correspond(s.getCallSignatures(), v.getCallSignatures(), at), ...correspond(s.getConstructSignatures(), v.getConstructSignatures(), at)];

  /**
   * TYPESCRIPT'S OWN KEY RULES (round 8 finding 1), each mirrored from the checker rather than approximated:
   *   `isNumericLiteralName`    — a name is numeric iff it round-trips through ToNumber: `"-1"`, `"1.5"`, `"NaN"` are;
   *                               `"01"`, `"1e21"` are not.
   *   `numericStringType`       — `${number}` ITSELF: the single-placeholder template over the intrinsic `number`
   *                               (template types are interned, so that shape is identity); `${number}${number}`
   *                               and `${bigint}` are other types the checker relates to nothing numeric.
   *   `isApplicableIndexType`   — an index keyed `indexKey` answers a key of type `key` iff the key is assignable to
   *                               it, or the index is `string` and the key is assignable to `number`, or the index
   *                               is `number` and the key is `${number}` or a numeric-name string literal.
   *   `findApplicableIndexInfo` — the checker's preference (the `string` index only when no other applies) is used
   *                               NOWHERE here (round 11 finding 2): a runtime property is ONE slot with several
   *                               declared VIEWS — its named property and every index whose domain holds its key —
   *                               and an `any` `string` index can write it whatever the preferred index declares, so
   *                               every view is paired (`indexPairs`) and, for a literal, checked on its own (`viewsOf`).
   */
  const isNumericLiteralName = (name: string): boolean => (+name).toString() === name;
  const isNumericStringType = (t: ts.Type): boolean => {
    if (!(t.flags & ts.TypeFlags.TemplateLiteral)) return false;
    const { texts, types } = t as ts.TemplateLiteralType;
    return texts.length === 2 && texts[0] === "" && texts[1] === "" && types.length === 1 && types[0] === checker.getNumberType();
  };
  const applicable = (key: ts.Type, indexKey: ts.Type): boolean =>
    checker.isTypeAssignableTo(key, indexKey)
    || (indexKey === checker.getStringType() && checker.isTypeAssignableTo(key, checker.getNumberType()))
    || (indexKey === checker.getNumberType() && (isNumericStringType(key) || (key.isStringLiteral() && isNumericLiteralName(key.value))));
  /**
   * The key type(s) a property answers to: a computed key by its expression's type; a symbol-named property WITHOUT a
   * declaration (a mapped `Record<typeof sym, …>` member — its name is the checker's `__@` escape, `isKnownSymbol`) as
   * `symbol`, which no index key domain can be narrower than; a NUMERIC name (TypeScript's rule) as a number AND a
   * string — the checker keeps one of the two by declaration form, the runtime answers both; any other name as its
   * string literal.
   */
  const propKeyTypes = (p: ts.Symbol): ts.Type[] => {
    const name = (p.declarations?.[0] as ts.NamedDeclaration | undefined)?.name;
    if (name && ts.isComputedPropertyName(name) && propKey(name) === undefined) return [checker.getTypeAtLocation(name.expression)];
    if ((p.escapedName as string).startsWith("__@")) return [checker.getESSymbolType()];
    return isNumericLiteralName(p.name) ? [checker.getNumberLiteralType(Number(p.name)), checker.getStringLiteralType(p.name)] : [checker.getStringLiteralType(p.name)];
  };
  /** The property of `t` that `p` names — by ESCAPED name, so a symbol-keyed member resolves (`getPropertyOfType` re-escapes a leading `__`). */
  const propertyOf = (t: ts.Type, p: ts.Symbol): ts.Symbol | undefined => t.getProperties().find((q) => q.escapedName === p.escapedName);
  /**
   * INDEX SIGNATURES paired by KEY DOMAIN in BOTH directions (round 7 finding 1, round 8 finding 1) — string, number,
   * template-literal and symbol keys alike, under the checker's applicability rules above:
   *   sink INDEX    ← EVERY value INDEX applicable in either direction (round 9 finding 1): one that answers the sink's
   *                   key (`getApplicableIndexInfo` — the checker keeps ONE by preference; the audit keeps all, since a
   *                   `string` `any` index answers numeric keys at runtime too) or one whose keys fall within the
   *                   sink's domain (`membersRelatedToIndexInfo`, the checker's fallback when none answers) — and every
   *                   value PROPERTY whose key falls in its domain;
   *   sink PROPERTY ← EVERY value INDEX that answers its key (round 10 finding 1: no preference — the `any` string
   *                   index writes the slot a number index declares branded), WHETHER OR NOT the value also names the
   *                   property (round 11 finding 1: the named property and the index reach the same slot) — an
   *                   OPTIONAL sink property the compiler never relates (`Partial<Record<-1, LegacyWallDeadline>>`
   *                   from `{ [k: number]: any }`), yet the runtime reads through the index.
   * Each pair is (value type, sink type) for the structural walks.
   */
  const indexPairs = (v: ts.Type, s: ts.Type, at: ts.Node): [ts.Type, ts.Type][] => {
    const out: [ts.Type, ts.Type][] = [];
    const vInfos = checker.getIndexInfosOfType(v);
    for (const si of checker.getIndexInfosOfType(s)) {
      if (brands.withinSig(si.type, at).size === 0) continue;
      for (const vi of vInfos) if (applicable(si.keyType, vi.keyType) || applicable(vi.keyType, si.keyType)) out.push([vi.type, si.type]);
      for (const vp of v.getProperties()) if (propKeyTypes(vp).some((k) => applicable(k, si.keyType))) out.push([checker.getTypeOfSymbolAtLocation(vp, at), si.type]);
    }
    if (vInfos.length > 0) {
      for (const sp of s.getProperties()) {
        const spt = checker.getTypeOfSymbolAtLocation(sp, at);
        if (brands.withinSig(spt, at).size === 0) continue;
        const keys = propKeyTypes(sp);
        for (const vi of vInfos) if (keys.some((k) => applicable(k, vi.keyType))) out.push([vi.type, spt]);
      }
    }
    return out;
  };

  /**
   * Does an `any`/`unknown` in the VALUE reach a position whose corresponding
   * SINK shape carries a brand — in a value OR a signature? Structural: unions,
   * constituents, type arguments, array elements, index signatures of every key
   * domain in both directions (`indexPairs` — rounds 7–8), same-named properties
   * by escaped name (round 3 finding 2; round 8: symbol-keyed too) and, per
   * corresponding signature, RETURNS (round 5 finding 3).
   * Parameters — declared or inferred `any` — are the drop lock's (`checkParamDrop`),
   * so that each defect has exactly one reporter.
   */
  const anyReaches = (v: ts.Type, s: ts.Type, at: ts.Node, seen = new Set<string>()): boolean => {
    if (brands.withinSig(s, at).size === 0) return false;
    if (isAnyish(v)) return true;
    const key = `${(v as unknown as { id: number }).id}|${(s as unknown as { id: number }).id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    if (v.isUnion()) return v.types.some((c) => anyReaches(c, s, at, seen));
    if (s.isUnion() || s.isIntersection()) return s.types.some((c) => anyReaches(v, c, at, seen));
    for (const [vt, st] of indexPairs(v, s, at)) if (anyReaches(vt, st, at, seen)) return true;
    if (isRef(v) && isRef(s)) {
      const va = checker.getTypeArguments(v);
      const sa = checker.getTypeArguments(s);
      for (let i = 0; i < Math.min(va.length, sa.length); i++) if (anyReaches(va[i]!, sa[i]!, at, seen)) return true;
    }
    for (const sp of s.getProperties()) {
      const spt = checker.getTypeOfSymbolAtLocation(sp, at);
      if (brands.withinSig(spt, at).size === 0) continue;
      const vp = propertyOf(v, sp);
      if (vp && anyReaches(checker.getTypeOfSymbolAtLocation(vp, at), spt, at, seen)) return true;
    }
    for (const [ss, vs] of corresponding(v, s, at)) if (anyReaches(vs.getReturnType(), ss.getReturnType(), at, seen)) return true;
    return false;
  };

  /** A branded PRIMITIVE — `number & { [brand]: true }` — as opposed to an object that carries a brand somewhere inside. */
  const isBrandedPrimitive = (v: ts.Type): boolean =>
    v.isIntersection() && v.types.some((t) => (t.flags & (ts.TypeFlags.NumberLike | ts.TypeFlags.StringLike | ts.TypeFlags.BigIntLike | ts.TypeFlags.BooleanLike | ts.TypeFlags.ESSymbolLike)) !== 0);
  /**
   * The brands a value of type `v` LOSES when it is read through a DECLARED type `s` (round 14 finding 1) — a generic
   * parameter's declaration, a method's declaring owner — position by position, never as a whole: a type parameter
   * reads as its base constraint (an unconstrained one reads NOTHING when `trusted` — a LIBRARY_GENERIC_TRUST
   * declaration holds or passes the value by contract — and EVERYTHING when not: a first-party body is audited
   * without the brand, round 6 finding 1, and a library's `.d.ts` proves nothing about its body, round 15 finding 3);
   * a VALUE that is a type parameter reads as its own constraint (round 15 finding 1: `f<T extends
   * LegacyWallDeadline>(d: T)` carries the brand through `T`, and so does `this` in a subclass that narrowed a
   * property); a branded primitive read as a concrete type that does not carry the brand — `number`, `{}`
   * (`toString`), `any` — is lost; a brand the declared type cannot REACH (a nested property behind `T extends {}`) is
   * not consumed. Type arguments, array / tuple elements, same-named properties, index signatures and callback RETURNS
   * (the callee reads them) are followed; callback parameters are the callee's own values and are not.
   */
  const dropped = (v: ts.Type, s: ts.Type, at: ts.Node, trusted: boolean, seen = new Set<string>()): Set<string> => {
    const out = new Set<string>();
    const vb = brands.within(v, at);
    if (vb.size === 0) return out;
    const key = `${(v as unknown as { id: number }).id}|${(s as unknown as { id: number }).id}`;
    if (seen.has(key)) return out;
    seen.add(key);
    const merge = (x: Set<string>): void => { for (const b of x) out.add(b); };
    if (v.flags & ts.TypeFlags.TypeParameter) { // the VALUE is a type parameter (round 15 finding 1): it is whatever its constraint is — `this` included
      const c = checker.getBaseConstraintOfType(v);
      if (c && c !== v) merge(dropped(c, s, at, trusted, seen));
      return out;
    }
    if (s.flags & ts.TypeFlags.TypeParameter) {
      const c = checker.getBaseConstraintOfType(s);
      if (!c || (c.flags & ts.TypeFlags.Unknown) !== 0) { if (!trusted) merge(vb); return out; }
      return dropped(v, c, at, trusted, seen);
    }
    if (v.isUnion()) { for (const c of v.types) merge(dropped(c, s, at, trusted, seen)); return out; }
    if (s.isUnion()) { // read as each constituent the value can INHABIT (`LegacyWallDeadline | undefined` never reads a deadline as `undefined`); none ⇒ all, fail closed
      const parts = s.types.filter((c) => checker.isTypeAssignableTo(v, c));
      for (const c of parts.length > 0 ? parts : s.types) merge(dropped(v, c, at, trusted, seen));
      return out;
    } // an INTERSECTION sink is read as a whole: `number & { [brand]: true }` carries the brand its `number` constituent alone would drop
    if (isAnyish(s)) { merge(vb); return out; }
    if (isBrandedPrimitive(v)) { const sb = brands.within(s, at); for (const b of vb) if (!sb.has(b)) out.add(b); return out; }
    if (isRef(v) && isRef(s)) {
      const va = checker.getTypeArguments(v);
      const sa = checker.getTypeArguments(s);
      for (let i = 0; i < Math.min(va.length, sa.length); i++) merge(dropped(va[i]!, sa[i]!, at, trusted, seen));
    }
    const ve = checker.getIndexTypeOfType(v, ts.IndexKind.Number);
    const se = checker.getIndexTypeOfType(s, ts.IndexKind.Number);
    if (ve && se) merge(dropped(ve, se, at, trusted, seen));
    for (const p of v.getProperties()) {
      const pt = checker.getTypeOfSymbolAtLocation(p, at);
      if (brands.within(pt, at).size === 0) continue;
      const q = propertyOf(s, p);
      if (q) merge(dropped(pt, checker.getTypeOfSymbolAtLocation(q, at), at, trusted, seen));
      const keys = propKeyTypes(p);
      for (const i of checker.getIndexInfosOfType(s)) if (keys.some((k) => applicable(k, i.keyType))) merge(dropped(pt, i.type, at, trusted, seen));
    }
    for (const vi of checker.getIndexInfosOfType(v)) for (const si of checker.getIndexInfosOfType(s)) if (applicable(si.keyType, vi.keyType) || applicable(vi.keyType, si.keyType)) merge(dropped(vi.type, si.type, at, trusted, seen));
    for (const [ss, vs] of corresponding(v, s, at)) merge(dropped(vs.getReturnType(), ss.getReturnType(), at, trusted, seen));
    return out;
  };

  for (const rel of files) {
    const sf = program.getSourceFile(join(root, rel));
    if (!sf) throw new Error(`not in program: ${rel}`);
    const inClock = rel === CLOCK_MODULE || rel === LEGACY_MODULE;
    const attached = new Set<number>();

    for (const d of ts.getPreEmitDiagnostics(program, sf)) {
      if (d.category !== ts.DiagnosticCategory.Error) continue;
      const at = d.start !== undefined ? statementAt(sf, d.start) : sf;
      diagnostics.push({
        file: rel, code: d.code, message: ts.flattenDiagnosticMessageText(d.messageText, " "),
        scope: at === sf ? "<module>" : ownerOf(at),
        context: at === sf ? "" : controlContext(at, sf),
        fingerprint: hash8(normalize(at === sf ? "" : at.getText(sf))),
      });
    }

    const record = (kind: DebtKind, marker: { id: string; pos: number }, node: ts.Node, b: Set<string>): void => {
      attached.add(marker.pos);
      const full = normalize(node.getText(sf));
      entries.push({ id: marker.id, kind, file: rel, scope: ownerOf(node), brands: [...b].sort(), hash: hash8(full), text: full.slice(0, 120) });
      (markerSeen.get(marker.id) ?? markerSeen.set(marker.id, []).get(marker.id)!).push({ file: rel, pos: marker.pos });
    };

    /** The key type(s) a literal's NAME denotes: a literal name by TypeScript's rule (a numeric name is a number and a string); a computed name by its expression's type, a union SPLIT into its runtime alternatives. */
    const literalKeyTypes = (name: ts.PropertyName): ts.Type[] => {
      const key = propKey(name);
      if (key !== undefined) return isNumericLiteralName(key) ? [checker.getNumberLiteralType(Number(key)), checker.getStringLiteralType(key)] : [checker.getStringLiteralType(key)];
      if (!ts.isComputedPropertyName(name)) return [];
      const t = checker.getTypeAtLocation(name.expression);
      return t.isUnion() ? t.types : [t];
    };
    /**
     * Every declared VIEW of the runtime slot a literal's property lands in, within ONE sink type (round 11 finding 2):
     * the property of that name AND every index signature whose domain holds the key — a named property does not
     * exclude an index, and no index is preferred over another (the checker's `findApplicableIndexInfo` picks one for
     * the literal's contextual type; the slot stays readable through every other applicable view). A key the checker
     * cannot narrow (`string`, `number`, `symbol`) meets every property in its domain.
     */
    const viewsOf = (s: Sink, name: ts.PropertyName, at: ts.Node): Sink[] => {
      const nn = checker.getNonNullableType(s.type);
      const kts = literalKeyTypes(name);
      const named = new Set<ts.Symbol>();
      for (const k of kts) {
        if (k.isStringLiteral()) { const q = checker.getPropertyOfType(nn, k.value); if (q) named.add(q); }
        else if (k.isNumberLiteral()) { const q = checker.getPropertyOfType(nn, String(k.value)); if (q) named.add(q); }
        else if (k.flags & ts.TypeFlags.UniqueESSymbol) { const q = nn.getProperties().find((q) => q.escapedName === (k as ts.UniqueESSymbolType).escapedName); if (q) named.add(q); }
        else for (const q of nn.getProperties()) if (propKeyTypes(q).some((pk) => checker.isTypeAssignableTo(pk, k))) named.add(q);
      }
      const out: Sink[] = [...named].map((q) => ({ ...s, type: checker.getTypeOfSymbolAtLocation(q, at), decl: q.valueDeclaration }));
      for (const i of checker.getIndexInfosOfType(nn)) if (kts.some((k) => applicable(k, i.keyType))) out.push({ ...s, type: i.type, decl: i.declaration ?? s.decl });
      return out;
    };
    /** The constituents of a sink a value of type `t` can inhabit: a UNION is split, and the checker's assignability rules a constituent out (a discriminant, a missing required property); none viable ⇒ all, fail closed. */
    const inhabitable = (s: Sink, t: ts.Type): Sink[] => {
      const nn = checker.getNonNullableType(s.type);
      const parts = nn.isUnion() ? nn.types : [nn];
      const viable = parts.filter((c) => checker.isTypeAssignableTo(t, c));
      return (viable.length > 0 ? viable : parts).map((c) => ({ ...s, type: c }));
    };
    /**
     * The declared views a literal's property can land in, across `sinks` (round 12 finding 1): each sink split into
     * the constituents the literal's own type can inhabit, each constituent's views of the slot — and a CONSTITUENT
     * with no view for the property (`{}`, `any`, `unknown`) stays a view itself (round 13 finding 1: the fallback is
     * per constituent, so a viable `{}` beside a branded constituent is not lost).
     */
    const propertyViews = (sinks: readonly Sink[], lit: ts.ObjectLiteralExpression, name: ts.PropertyName, at: ts.Node): Sink[] => {
      const litType = checker.getTypeAtLocation(lit);
      return sinks.flatMap((s) => inhabitable(s, litType).flatMap((c) => { const vs = viewsOf(c, name, at); return vs.length > 0 ? vs : [c]; }));
    };
    /** Element `j` of a tuple: a fixed element by position; the rest / variadic element for every position past the fixed ones. */
    const tupleElement = (t: ts.TypeReference, j: number): ts.Type | undefined => {
      const flags = (t.target as ts.TupleType).elementFlags;
      const args = checker.getTypeArguments(t);
      const isRest = (f: ts.ElementFlags): boolean => (f & (ts.ElementFlags.Rest | ts.ElementFlags.Variadic)) !== 0;
      if (j < flags.length && !isRest(flags[j]!)) return args[j];
      const r = flags.findIndex(isRest);
      if (r < 0 || j < r) return undefined;
      const rt = args[r]!;
      return (flags[r]! & ts.ElementFlags.Variadic) && checker.isArrayType(rt) ? checker.getTypeArguments(rt as ts.TypeReference)[0] ?? rt : rt;
    };
    /**
     * The declared views an array literal's element lands in at slot `j` — exactly `j`, or every slot from `j` on
     * once a spread of unknown length precedes it: a tuple constituent's element(s), an array constituent's element
     * type; a constituent with neither stays a view itself (round 13 finding 1).
     */
    const elementViews = (sinks: readonly Sink[], lit: ts.ArrayLiteralExpression, j: number, exact: boolean): Sink[] => {
      const litType = checker.getTypeAtLocation(lit);
      return sinks.flatMap((s) => inhabitable(s, litType).flatMap((c): Sink[] => {
        if (checker.isTupleType(c.type)) {
          const n = ((c.type as ts.TypeReference).target as ts.TupleType).elementFlags.length;
          const ks = exact ? [j] : Array.from({ length: Math.max(n - j, 1) }, (_, i) => j + i);
          const vs = ks.flatMap((k) => { const e = tupleElement(c.type as ts.TypeReference, k); return e ? [{ ...c, type: e }] : []; });
          return vs.length > 0 ? vs : [c];
        }
        const e = checker.getIndexTypeOfType(c.type, ts.IndexKind.Number);
        return e ? [{ ...c, type: e }] : [c];
      }));
    };

    /**
     * One check for every value-bearing edge. `sinks` are EVERY declared VIEW the value can reach (round 12 finding 2):
     * the instantiated and the declared type of a parameter, the property and the indexes of one slot, the constituents
     * of a union a literal can inhabit, each parameter a spread can feed — with the receiving declaration (provenance
     * and name). The value meets each view ON ITS OWN: a laundering (C3) when any view lets an `any` reach a brand; an
     * erasure (C4 / C5) when ANY view is typed without the brand. Nothing is unioned, so no branded view can mask an
     * unbranded one. Literals are checked at their LEAVES — one report per erasure, never one per enclosing literal.
     */
    const checkSink = (valueNode: ts.Node, views: readonly Sink[], what: string): void => {
      if (views.length === 0) return;
      // A STRUCTURAL view reads the WHOLE value position by position (`dropped`) — a literal is not descended into it,
      // or a property behind `T extends {}` would be read as `{}` instead of staying out of reach (round 14 finding 1).
      const sinks = views.filter((s) => !s.structural);
      const structural = views.filter((s) => s.structural);
      if (structural.length > 0 && (ts.isObjectLiteralExpression(valueNode) || ts.isArrayLiteralExpression(valueNode))) checkValue(checker.getTypeAtLocation(valueNode), valueNode, structural, what);
      if (sinks.length === 0 && (ts.isObjectLiteralExpression(valueNode) || ts.isArrayLiteralExpression(valueNode))) return; // a literal with only structural views was read above; a value meets every view below
      if (ts.isObjectLiteralExpression(valueNode)) {
        for (const p of valueNode.properties) {
          if (ts.isSpreadAssignment(p)) { checkSink(p.expression, sinks, `${what} (object spread)`); continue; }
          if (!(ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p))) continue; // methods / accessors: their returns are checked against the contextual member
          checkSink(ts.isPropertyAssignment(p) ? p.initializer : p.name, propertyViews(sinks, valueNode, p.name, p), `property \`${propKey(p.name) ?? normalize(p.name.getText(sf))}\` of ${what}`);
        }
        return;
      }
      if (ts.isArrayLiteralExpression(valueNode)) {
        placeElements(valueNode, { pos: 0, exact: true }, { at: (k) => elementViews(sinks, valueNode, k, true), from: (k) => elementViews(sinks, valueNode, k, false) }, what);
        return;
      }
      checkValue(checker.getTypeAtLocation(valueNode), valueNode, views, what);
    };
    /** The leaf: a value of type `vType` (spelled at `valueNode` — the line, the debt marker) meets every one of `views`. */
    const checkValue = (vType: ts.Type, valueNode: ts.Node, views: readonly Sink[], what: string): void => {
      if (views.length === 0) return;
      const sinkSig = new Set<string>(); // brands any view carries as a value OR in a signature — what an `any` can launder through (round 5 finding 3)
      for (const s of views) for (const b of brands.withinSig(s.type, valueNode)) sinkSig.add(b);
      if (sinkSig.size > 0 && views.some((s) => anyReaches(vType, s.type, valueNode))) {
        fail("C3", rel, lineOf(sf, valueNode), `\`${checker.typeToString(vType)}\` carries any/unknown into brand-carrying ${what} (${[...sinkSig].join("|")}): ${valueNode.getText(sf).slice(0, 80)}`);
      }
      if (inClock) return;
      for (const s of views) signatureDrops(vType, s.type, valueNode, what);
      if (withinMarkedAssertion(sf, valueNode)) return;
      const vWithin = brands.within(vType, valueNode);
      // a plain view drops what it does not carry anywhere; a STRUCTURAL view (a declared generic type, a declaring owner) drops what it READS without the brand (round 14 finding 1)
      const lacking = (b: string): Sink[] => views.filter((s) => (s.structural ? dropped(vType, s.type, valueNode, s.trusted === true).has(b) : !brands.within(s.type, valueNode).has(b)));
      const erased = [...vWithin].filter(isTarget).filter((b) => lacking(b).length > 0);
      if (erased.length > 0) {
        fail("C4", rel, lineOf(sf, valueNode), `${erased.join("|")} erased into ${what} typed without it — use the clock module's operations: ${valueNode.getText(sf).slice(0, 80)}`);
      }
      if (!vWithin.has(LEGACY_BRAND)) return;
      for (const drop of lacking(LEGACY_BRAND)) {
        const decl = drop.decl ?? views.find((s) => s.decl)?.decl;
        const name = sinkName(decl);
        if (isDefaultLib(decl) && LEGACY_SINK_ALLOWLIST.has(name)) continue; // an allowlisted library terminal — the next dropping view still counts
        const marker = markerAfter(sf, valueNode);
        if (marker) { record("erasure", marker, valueNode, new Set([LEGACY_BRAND])); return; }
        const why = firstParty(decl)
          ? `first-party ${what} typed without it — an UNBRANDED SEAM`
          : drop.structural
            ? `${what} (\`${name}\`: a declared library view that reads the value without the brand — not a LIBRARY_GENERIC_TRUST declaration) — mark the value as debt; a generic that holds or passes the value by contract is trusted by its declaration`
            : `${what} (\`${name}\`, not a LEGACY_SINK_ALLOWLIST terminal) — mark the value as debt or brand the sink`;
        fail("C5", rel, lineOf(sf, valueNode), `LegacyWallDeadline flows into ${why}: ${valueNode.getText(sf).slice(0, 80)}`);
        return;
      }
    };

    /** A SLOT space — the elements of an array literal's sinks, or a call's parameters: the views at exactly slot `k`, and at every slot from `k` on. */
    interface Slots { at: (k: number) => Sink[]; from: (k: number) => Sink[] }
    /** The next slot a value lands in: exactly `pos`, or `pos` at the least once a spread of unknown length precedes it. */
    interface Place { pos: number; exact: boolean }
    /**
     * Place an array literal's elements from `at` on (round 13 finding 2 — ONE routine for a literal's elements, a call's
     * spread arguments, and every spread nested in either): an element meets its slot, exactly or every slot from the
     * least possible one on; a spread element is expanded by `placeSpread`; a hole takes a slot. Returns the place after.
     */
    const placeElements = (lit: ts.ArrayLiteralExpression, at: Place, slots: Slots, what: string): Place => {
      let p = at;
      for (const el of lit.elements) {
        if (ts.isSpreadElement(el)) { p = placeSpread(el.expression, p, slots, `${what} (array spread)`); continue; }
        if (!ts.isOmittedExpression(el)) checkSink(el, p.exact ? slots.at(p.pos) : slots.from(p.pos), `element ${p.pos}${p.exact ? "" : "+"} of ${what}`);
        p = { pos: p.pos + 1, exact: p.exact };
      }
      return p;
    };
    /**
     * Place what a spread expression yields, from `at` on: an array literal element by element (its own spreads
     * recursively); a tuple's fixed elements positionally, an optional element positionally but leaving every later
     * place inexact (it may be absent), a rest / variadic element across every slot from there on; a plain array
     * across every slot from `at` on. The spelled expression carries the line and the debt marker.
     */
    const placeSpread = (x: ts.Expression, at: Place, slots: Slots, what: string): Place => {
      if (ts.isArrayLiteralExpression(x)) return placeElements(x, at, slots, what);
      const t = checker.getTypeAtLocation(x);
      let p = at;
      if (checker.isTupleType(t)) {
        const ref = t as ts.TypeReference;
        const flags = (ref.target as ts.TupleType).elementFlags;
        checker.getTypeArguments(ref).forEach((_, j) => {
          const f = flags[j]!;
          const rest = (f & (ts.ElementFlags.Rest | ts.ElementFlags.Variadic)) !== 0;
          const e = tupleElement(ref, j);
          if (e) checkValue(e, x, p.exact && !rest ? slots.at(p.pos) : slots.from(p.pos), `element ${j} of ${what}`);
          p = rest || (f & ts.ElementFlags.Optional) ? { pos: p.pos, exact: false } : { pos: p.pos + 1, exact: p.exact };
        });
        return p;
      }
      const e = checker.isArrayType(t) ? checker.getTypeArguments(t as ts.TypeReference)[0] : checker.getIndexTypeOfType(t, ts.IndexKind.Number);
      checkValue(e ?? t, x, slots.from(p.pos), what);
      return { pos: p.pos, exact: false };
    };


    const construction = (node: ts.Node, typeNode: ts.TypeNode, what: string): void => {
      if (inClock) return;
      const b = brands.within(checker.getTypeFromTypeNode(typeNode), node);
      if (b.size === 0) return;
      const marker = markerAfter(sf, node) ?? markerAfter(sf, typeNode);
      if (!marker) { fail("C1", rel, lineOf(sf, node), `brand construction (${what}) without a debt marker: ${normalize(node.getText(sf)).slice(0, 120)}`); return; }
      record("construction", marker, node, b);
    };

    /**
     * Declared return sink of a function-like node; for arrow/function expressions
     * and object-literal methods/accessors the CONTEXTUAL one. Undefined when
     * inferred, an inference type parameter, or void. A generator's `return`
     * flows into `Generator<Y, R>`'s R.
     */
    const returnSink = (fn: ts.SignatureDeclaration): Sink | undefined => {
      if (fn.type) {
        const t = checker.getTypeFromTypeNode(fn.type);
        if ((fn as ts.FunctionLikeDeclaration).asteriskToken && isRef(t)) { const r = checker.getTypeArguments(t)[1]; return r ? { type: r, decl: fn } : undefined; }
        return { type: t, decl: fn };
      }
      let ctxType: ts.Type | undefined;
      let decl: ts.Declaration | undefined = fn;
      if (ts.isArrowFunction(fn) || ts.isFunctionExpression(fn)) ctxType = checker.getContextualType(fn);
      else if ((ts.isMethodDeclaration(fn) || ts.isGetAccessorDeclaration(fn)) && ts.isObjectLiteralExpression(fn.parent)) {
        const ctx = checker.getContextualType(fn.parent);
        if (!ctx) return undefined;
        if (isAnyish(ctx)) return { type: ctx, decl: undefined };
        const key = propKey(fn.name);
        const prop = key !== undefined ? checker.getPropertyOfType(checker.getNonNullableType(ctx), key) : undefined;
        if (!prop) return undefined;
        const pt = checker.getTypeOfSymbolAtLocation(prop, fn);
        if (ts.isGetAccessorDeclaration(fn)) return { type: pt, decl: prop.valueDeclaration };
        ctxType = pt;
        decl = prop.valueDeclaration;
      }
      if (!ctxType) return undefined;
      if (isAnyish(ctxType)) return { type: ctxType, decl: undefined };
      const sig = ctxType.getCallSignatures();
      if (sig.length !== 1) return undefined;
      const rt = sig[0]!.getReturnType();
      if ((rt.flags & ts.TypeFlags.TypeParameter) || isVoidish(rt)) return undefined;
      return { type: rt, decl: sig[0]!.declaration && ts.isFunctionLike(sig[0]!.declaration) ? sig[0]!.declaration : decl };
    };

    /**
     * The views a call argument meets (round 12 finding 2): the parameter's INSTANTIATED type (what this call site
     * sees) and, when the instantiation rewrote it, its DECLARED type — what the callee's body reads the value AS,
     * compared STRUCTURALLY (`dropped`, round 14 finding 1): a constrained type parameter reads as its constraint
     * (`flat<D extends number>(depth?: D)` consumes the depth as a number), an unconstrained one reads EVERYTHING —
     * in FIRST-PARTY code its body is audited without the brand (round 6 finding 1), in a LIBRARY its `.d.ts` proves
     * nothing about its body (round 15 finding 3) — unless the declaration is a LIBRARY_GENERIC_TRUST entry
     * (`trusted`: held or passed by contract, default-lib identity), and a brand the declaration cannot reach
     * (`Object.assign<T extends {}>` over `{ deadline }`) is not consumed. Stated policy.
     */
    const paramSinks = (p: ts.Symbol, node: ts.Node): Sink[] => {
      const inst = checker.getTypeOfSymbolAtLocation(p, node);
      const sinks: Sink[] = [{ type: inst, decl: p.valueDeclaration }];
      const d = p.valueDeclaration;
      if (d && ts.isParameter(d) && d.type) {
        const declared = checker.getTypeFromTypeNode(d.type);
        if (declared !== inst) sinks.push({ type: declared, decl: d, structural: true, trusted: isTrusted(d) });
      }
      return sinks;
    };
    /**
     * The RECEIVER of a method call — or of a tagged template's tag (round 15 finding 2) — is a value-bearing edge too
     * (round 14 finding 2): the receiver is read as the signature's explicit `this` parameter when it declares one,
     * else as the type that DECLARES the method — the declared, generic owner (`Map<K, V>`, `Array<T>`, `Number`),
     * compared structurally: a deadline held in a type argument of a LIBRARY_GENERIC_TRUST method stays a deadline;
     * a deadline READ AS `Number` (`d.toString()`, `d.valueOf()`) or through an untrusted generic (`[d].join()`)
     * does not.
     */
    const receiverSinks = (call: ts.CallLikeExpression, sig: ts.Signature | undefined): Sink[] => {
      if (sig?.thisParameter) return paramSinks(sig.thisParameter, call);
      const decl = sig?.declaration;
      if (!decl || !(ts.isMethodDeclaration(decl) || ts.isMethodSignature(decl))) return [];
      const owner = decl.parent;
      const ownerSym = ts.isInterfaceDeclaration(owner) || ts.isClassDeclaration(owner) || ts.isClassExpression(owner) ? classSymbol(owner) : undefined;
      // a STATIC method's receiver is the constructor (the static side), an instance method's is the declared instance type
      const isStatic = ts.isMethodDeclaration(decl) && (ts.getCombinedModifierFlags(decl) & ts.ModifierFlags.Static) !== 0;
      const ownerType = ownerSym ? (isStatic ? checker.getTypeOfSymbolAtLocation(ownerSym, call) : checker.getDeclaredTypeOfSymbol(ownerSym)) : ts.isTypeLiteralNode(owner) ? checker.getTypeAtLocation(owner) : undefined;
      return ownerType ? [{ type: ownerType, decl, structural: true, trusted: isTrusted(decl) }] : [];
    };
    /**
     * A receiver is read as the value it IS at runtime (round 15 finding 2): `super.m()` invokes the base method on
     * the CURRENT instance, which the checker types as the BASE class — a subclass's narrowed property would be read
     * as the base declares it — so the enclosing class's instance type is the value; any other receiver is its own
     * expression.
     */
    const checkReceiver = (expr: ts.Expression, views: readonly Sink[], what: string): void => {
      if (expr.kind === ts.SyntaxKind.SuperKeyword) {
        const cls = ts.findAncestor(expr, ts.isClassLike);
        const sym = cls ? classSymbol(cls) : undefined;
        if (cls && sym) {
          const member = ts.findAncestor(expr, (n): n is ts.ClassElement => ts.isClassElement(n) && n.parent === cls);
          const isStatic = !!member && (ts.getCombinedModifierFlags(member) & ts.ModifierFlags.Static) !== 0;
          checkValue(isStatic ? checker.getTypeOfSymbolAtLocation(sym, expr) : checker.getDeclaredTypeOfSymbol(sym), expr, views, what); // the static side is the constructor
          return;
        }
      }
      checkSink(expr, views, what);
    };
    /**
     * An implementation parameter behind a branded public parameter (round 3 finding 3).
     * `any`/`unknown` reaching the brand — declared, or INFERRED from a default
     * initializer — is a laundering: C3 (round 6). Otherwise a DECLARED parameter
     * typed without the brand is a drop: C5/C4 — a bare type parameter included
     * (round 6 finding 1: `T` carries no brand, so nothing inside the callee is a
     * seam; the implementation must declare the brand it stands behind). An
     * unannotated parameter is contextually typed from the public signature and
     * cannot be wider.
     */
    const checkParamDrop = (pubType: ts.Type, ip: ts.ParameterDeclaration, what: string): void => {
      const pubWithin = brands.withinSig(pubType, ip);
      if (pubWithin.size === 0) return;
      const implType = ip.type ? checker.getTypeFromTypeNode(ip.type) : checker.getTypeAtLocation(ip);
      if (anyReaches(implType, pubType, ip)) {
        fail("C3", rel, lineOf(sf, ip), `\`${checker.typeToString(implType)}\` parameter \`${ip.name.getText(sf)}\` of ${what} carries any/unknown where the signature carries (${[...pubWithin].join("|")})`);
        return;
      }
      if (!ip.type) return;
      const implWithin = brands.withinSig(implType, ip);
      const dropped = [...pubWithin].filter((b) => !implWithin.has(b));
      if (dropped.length === 0) return;
      fail(dropped.every(isTarget) ? "C4" : "C5", rel, lineOf(sf, ip), `${dropped.join("|")} dropped by ${what}: parameter \`${ip.name.getText(sf)}\` is declared \`${normalize(ip.type.getText(sf))}\` — an UNBRANDED SEAM behind a branded signature`);
    };
    /**
     * A COVARIANT position (a return, a redeclared property) behind a branded public
     * one. Covariance means a narrower type cannot erase a brand; the two ways it
     * drops are `any` (C3) and a brand in a PARAMETER of the type — `(): (d:
     * LegacyWallDeadline) => void` implemented by `(): (d: number) => void` — which
     * is the structural lock applied to that type.
     */
    const checkCovariant = (pubType: ts.Type, implType: ts.Type, at: ts.Node, what: string): void => {
      const pubWithin = brands.withinSig(pubType, at);
      if (pubWithin.size === 0) return;
      if (anyReaches(implType, pubType, at)) {
        fail("C3", rel, lineOf(sf, at), `\`${checker.typeToString(implType)}\` ${what} carries any/unknown where the signature carries (${[...pubWithin].join("|")})`);
        return;
      }
      signatureDrops(implType, pubType, at, what);
    };
    /**
     * The RETURN behind a public return (round 5 finding 3). An annotation is
     * compared as declared; an unannotated return as INFERRED, except where a
     * contextual return type already checks every `return` statement (object-literal members).
     */
    const checkReturnDrop = (pubReturn: ts.Type, impl: ts.SignatureDeclaration, what: string, inferred: boolean): void => {
      const implReturn = impl.type ? checker.getTypeFromTypeNode(impl.type) : inferred ? checker.getSignatureFromDeclaration(impl)?.getReturnType() : undefined;
      if (implReturn) checkCovariant(pubReturn, implReturn, impl, `returned by ${what}`);
    };
    /** An implementation's parameters, `this` AND return against the public signature it stands behind. */
    const checkImplSig = (pub: ts.Signature, impl: ts.SignatureDeclaration, at: ts.Node, what: string, inferredReturn = true): void => {
      const pp = pub.getParameters();
      impl.parameters.filter((ip) => !isThisParam(ip)).forEach((ip, i) => { const p = pp[i]; if (p) checkParamDrop(paramType(p, at), ip, what); });
      const td = impl.parameters.find(isThisParam);
      if (td && pub.thisParameter) checkParamDrop(paramType(pub.thisParameter, at), td, what);
      checkReturnDrop(pub.getReturnType(), impl, what, inferredReturn);
    };

    /**
     * STRUCTURAL lock (round 4 finding 2): the VALUE's call signatures and members are
     * compared with the SINK's, pairwise and to any depth. A value parameter DECLARED
     * wider than the branded sink parameter it will receive is a drop — method
     * bivariance let the assignment through without `implements`. Signatures are
     * paired by correspondence, and their RETURNS are compared recursively (round 5
     * findings 3–4). An `any` VALUE is not a drop but a laundering: C3, reported by
     * `anyReaches` at the same edge.
     */
    const signatureDrops = (v: ts.Type, s: ts.Type, at: ts.Node, what: string, seen = new Set<string>()): void => {
      if (isAnyish(v) || brands.withinSig(s, at).size === 0) return;
      const key = `${(v as unknown as { id: number }).id}|${(s as unknown as { id: number }).id}`;
      if (seen.has(key)) return;
      seen.add(key);
      if (v.isUnion()) { for (const c of v.types) signatureDrops(c, s, at, what, seen); return; }
      if (s.isUnion() || s.isIntersection()) { for (const c of s.types) signatureDrops(v, c, at, what, seen); return; }
      const pair = (ssigs: readonly ts.Signature[], vsigs: readonly ts.Signature[], label: string): void => {
        for (const [ss, vs] of correspond(ssigs, vsigs, at)) {
          const sp = ss.getParameters();
          const drop = (p: ts.Symbol | undefined, v: ts.Symbol | undefined): void => {
            const vd = v?.valueDeclaration;
            if (!p || !vd || !ts.isParameter(vd)) return;
            if (vd.getSourceFile() === sf) { checkParamDrop(paramType(p, at), vd, `${label} (structural assignment to ${what})`); return; }
            // A value declared ELSEWHERE — a library callable passed as a callback (`[d].map(String)`, round 15), a function
            // from another file — meets the sink at THIS edge, the one place the two signatures are paired: an `any`
            // parameter where the sink parameter carries the brand is a laundering (C3), a wider one a drop (C4 / C5).
            const pt = paramType(p, at);
            const pubWithin = brands.withinSig(pt, at);
            if (pubWithin.size === 0) return;
            const vt = paramType(v, at);
            const where = `${label} of ${what}`;
            if (anyReaches(vt, pt, at)) { fail("C3", rel, lineOf(sf, at), `\`${checker.typeToString(vt)}\` parameter \`${v.name}\` of \`${sinkName(vd)}\` carries any/unknown where ${where} carries (${[...pubWithin].join("|")}): ${at.getText(sf).slice(0, 80)}`); return; }
            const lost = [...pubWithin].filter((b) => !brands.withinSig(vt, at).has(b));
            if (lost.length > 0) fail(lost.every(isTarget) ? "C4" : "C5", rel, lineOf(sf, at), `${lost.join("|")} dropped by \`${sinkName(vd)}\`: parameter \`${v.name}\` is declared \`${checker.typeToString(vt)}\` behind ${where}: ${at.getText(sf).slice(0, 80)}`);
          };
          vs.getParameters().forEach((vp, i) => drop(sp[i], vp));
          drop(ss.thisParameter, vs.thisParameter);
          signatureDrops(vs.getReturnType(), ss.getReturnType(), at, `the return of ${label} (structural assignment to ${what})`, seen);
        }
      };
      pair(s.getCallSignatures(), v.getCallSignatures(), "a call signature");
      pair(s.getConstructSignatures(), v.getConstructSignatures(), "a construct signature");
      for (const [vt, st] of indexPairs(v, s, at)) signatureDrops(vt, st, at, `${what}[index]`, seen);
      if (isRef(v) && isRef(s)) {
        const va = checker.getTypeArguments(v);
        const sa = checker.getTypeArguments(s);
        for (let i = 0; i < Math.min(va.length, sa.length); i++) signatureDrops(va[i]!, sa[i]!, at, what, seen);
      }
      for (const sp of s.getProperties()) {
        const spt = checker.getTypeOfSymbolAtLocation(sp, at);
        if (brands.withinSig(spt, at).size === 0) continue;
        const vp = propertyOf(v, sp);
        if (vp) signatureDrops(checker.getTypeOfSymbolAtLocation(vp, at), spt, at, `${what}.${sp.name}`, seen);
      }
    };

    const visit = (node: ts.Node): void => {
      if ((ts.isParameter(node) || ts.isPropertySignature(node) || ts.isPropertyDeclaration(node) || ts.isVariableDeclaration(node)) && ts.isIdentifier(node.name)) {
        const b = brands.within(checker.getTypeAtLocation(node.name), node.name);
        if (b.size > 0) closure.push({ file: rel, line: lineOf(sf, node), kind: ts.isParameter(node) ? "parameter" : ts.isVariableDeclaration(node) ? "variable" : "property", name: node.name.text, owner: ownerOf(node), brands: [...b].sort() });
      }

      if ((ts.isAsExpression(node) || ts.isTypeAssertionExpression(node)) && !ts.isConstTypeReference(node.type)) construction(node, node.type, "assertion");
      { const jt = jsDocCastType(node); if (jt) construction(node, jt, "JSDoc cast"); }
      if (ts.isTypePredicateNode(node) && node.type) construction(node, node.type, "type predicate");
      if (ts.isVariableDeclaration(node) && node.type && isAmbient(node)) construction(node, node.type, "ambient declaration");
      if (ts.isFunctionDeclaration(node) && node.type && isAmbient(node)) construction(node, node.type, "ambient function");

      if (ts.isCallExpression(node) || ts.isNewExpression(node) || ts.isTaggedTemplateExpression(node)) { // every invocation form (round 15 finding 2)
        const sig = checker.getResolvedSignature(node);
        const params = sig?.getParameters() ?? [];
        const last = params[params.length - 1];
        const lastDecl = last?.valueDeclaration;
        const hasRest = !!lastDecl && ts.isParameter(lastDecl) && lastDecl.dotDotDotToken !== undefined;
        const restElement = (s: Sink): Sink => (checker.isArrayType(s.type) ? { ...s, type: checker.getTypeArguments(s.type as ts.TypeReference)[0] ?? s.type } : s);
        const calleeExpr = ts.isTaggedTemplateExpression(node) ? node.tag : node.expression;
        const callee = calleeExpr.getText(sf).slice(0, 40);
        if (!ts.isNewExpression(node) && (ts.isPropertyAccessExpression(calleeExpr) || ts.isElementAccessExpression(calleeExpr))) { // a call's or a tag's receiver; `new` has none
          const thisViews = receiverSinks(node, sig);
          if (thisViews.length > 0) checkReceiver(calleeExpr.expression, thisViews, `receiver of \`${callee}\``);
        }
        /** The views of the parameter at argument position `pos` (the rest parameter's element past the fixed ones). */
        const paramAt = (pos: number): Sink[] => {
          const p = pos < params.length ? params[pos]! : hasRest ? last : undefined;
          return p ? paramSinks(p, node).map((s) => (hasRest && p === last && pos >= params.length - 1 ? restElement(s) : s)) : [];
        };
        /** Every parameter from argument position `pos` on — what a value of unknown position can reach. */
        const paramsFrom = (pos: number): Sink[] => { const out: Sink[] = []; for (let k = pos; k < Math.max(params.length, pos + 1); k++) out.push(...paramAt(k)); return out; };
        const slots: Slots = { at: paramAt, from: paramsFrom };
        // Arguments land POSITIONALLY (round 12 finding 2, round 13 finding 2): a spread — an array literal, a tuple, an
        // array — is placed by the one routine every spread goes through; a later argument's place is exact until a
        // spread of unknown length precedes it, then every parameter from the least possible one on.
        // A tagged template's substitutions are its arguments from position 1 on — position 0 is the strings array (round 15 finding 2).
        const args: readonly ts.Expression[] = ts.isTaggedTemplateExpression(node) ? (ts.isTemplateExpression(node.template) ? node.template.templateSpans.map((sp) => sp.expression) : []) : (node.arguments ?? []);
        let place: Place = { pos: ts.isTaggedTemplateExpression(node) ? 1 : 0, exact: true };
        for (const arg of args) {
          if (ts.isSpreadElement(arg)) { place = placeSpread(arg.expression, place, slots, `spread argument of ${callee}`); continue; }
          const p = place.pos < params.length ? params[place.pos]! : hasRest ? last : undefined;
          const views = place.exact ? paramAt(place.pos) : paramsFrom(place.pos);
          if (views.length > 0) checkSink(arg, views, `parameter \`${p?.name ?? "?"}\` of ${callee}`);
          place = { pos: place.pos + 1, exact: place.exact };
        }
      }
      if (ts.isVariableDeclaration(node) && node.type && node.initializer) {
        checkSink(node.initializer, [{ type: checker.getTypeFromTypeNode(node.type), decl: node }], `variable \`${node.name.getText(sf)}\` annotated \`${node.type.getText(sf)}\``);
      }
      // A parameter DEFAULT and a property INITIALIZER are value-bearing edges too (round 7): the value flows into the
      // declared (or contextual) type of the parameter / property — `d: LegacyWallDeadline = someAny`, `at: number = d`.
      if ((ts.isParameter(node) || ts.isPropertyDeclaration(node)) && node.initializer) {
        const t = node.type ? checker.getTypeFromTypeNode(node.type) : checker.getTypeAtLocation(node);
        checkSink(node.initializer, [{ type: t, decl: node }], `${ts.isParameter(node) ? "default of parameter" : "initializer of property"} \`${node.name.getText(sf)}\``);
      }
      if (ts.isReturnStatement(node) && node.expression) {
        const fn = enclosingFunction(node);
        const sink = fn ? returnSink(fn) : undefined;
        if (fn && sink) checkSink(node.expression, [sink], `return of \`${(fn as ts.NamedDeclaration).name?.getText(sf) ?? "<anonymous>"}\``);
      }
      if (ts.isArrowFunction(node) && !ts.isBlock(node.body)) {
        const sink = returnSink(node);
        if (sink) checkSink(node.body, [sink], "expression body of an arrow function");
      }
      if (ts.isYieldExpression(node) && node.expression && !node.asteriskToken) {
        const fn = enclosingFunction(node);
        const t = fn?.type ? checker.getTypeFromTypeNode(fn.type) : undefined;
        const y = t && isRef(t) ? checker.getTypeArguments(t)[0] : undefined;
        if (fn && y) checkSink(node.expression, [{ type: y, decl: fn }], `yield of \`${(fn as ts.NamedDeclaration).name?.getText(sf) ?? "<anonymous>"}\``);
      }
      if (ts.isBinaryExpression(node) && [ts.SyntaxKind.EqualsToken, ts.SyntaxKind.QuestionQuestionEqualsToken, ts.SyntaxKind.BarBarEqualsToken, ts.SyntaxKind.AmpersandAmpersandEqualsToken].includes(node.operatorToken.kind)) {
        const target = ts.isPropertyAccessExpression(node.left) ? node.left.name : ts.isElementAccessExpression(node.left) ? node.left.expression : node.left;
        const lhsSym = checker.getSymbolAtLocation(target);
        checkSink(node.right, [{ type: checker.getTypeAtLocation(node.left), decl: lhsSym?.valueDeclaration }], `assignment to \`${node.left.getText(sf).slice(0, 40)}\``);
      }
      if (ts.isBinaryExpression(node) && !inClock && !withinMarkedAssertion(sf, node)) {
        const k = node.operatorToken.kind;
        if ([ts.SyntaxKind.PlusToken, ts.SyntaxKind.MinusToken, ts.SyntaxKind.AsteriskToken, ts.SyntaxKind.SlashToken, ts.SyntaxKind.PercentToken,
             ts.SyntaxKind.PlusEqualsToken, ts.SyntaxKind.MinusEqualsToken, ts.SyntaxKind.AsteriskEqualsToken, ts.SyntaxKind.SlashEqualsToken, ts.SyntaxKind.PercentEqualsToken,
             ts.SyntaxKind.LessThanToken, ts.SyntaxKind.GreaterThanToken, ts.SyntaxKind.LessThanEqualsToken, ts.SyntaxKind.GreaterThanEqualsToken].includes(k)) {
          const l = [...brands.of(checker.getTypeAtLocation(node.left))].filter(isTarget);
          const r = [...brands.of(checker.getTypeAtLocation(node.right))].filter(isTarget);
          if (l.length + r.length > 0) fail("C4", rel, lineOf(sf, node), `direct arithmetic on ${[...l, ...r].join("|")} outside the clock module: ${normalize(node.getText(sf)).slice(0, 80)}`);
        }
      }

      // ── production-boundary locks: implementations behind public signatures ──
      if ((ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node) || ts.isConstructorDeclaration(node)) && node.body) {
        const overloads: ts.SignatureDeclaration[] = ts.isConstructorDeclaration(node)
          ? node.parent.members.filter((m): m is ts.ConstructorDeclaration => ts.isConstructorDeclaration(m) && !m.body)
          : ((node.name && checker.getSymbolAtLocation(node.name)?.declarations) ?? []).filter((d): d is ts.SignatureDeclaration => d !== node && ts.isFunctionLike(d) && !(d as ts.FunctionLikeDeclaration).body);
        for (const o of overloads) { const os = checker.getSignatureFromDeclaration(o); if (os) checkImplSig(os, node, node, `the implementation behind overload \`${normalize(o.getText(sf)).slice(0, 70)}\``); }
      }
      if (ts.isClassDeclaration(node)) {
        const supers = (node.heritageClauses ?? []).flatMap((h) => h.types.map((t) => checker.getTypeAtLocation(t)));
        for (const m of node.members) {
          const key = propKey(m.name);
          const declared = ts.isPropertyDeclaration(m) && !!m.type; // a property DECLARED wider/any behind a branded member (round 6)
          if (key === undefined || !(declared || ((ts.isMethodDeclaration(m) || ts.isSetAccessorDeclaration(m) || ts.isGetAccessorDeclaration(m)) && m.body))) continue;
          for (const s of supers) {
            const prop = checker.getPropertyOfType(s, key);
            if (!prop) continue;
            const pt = checker.getTypeOfSymbolAtLocation(prop, m);
            const what = `\`${node.name?.text ?? "<class>"}.${key}\` implementing \`${checker.typeToString(s)}.${key}\``;
            if (ts.isPropertyDeclaration(m)) checkCovariant(pt, checker.getTypeFromTypeNode(m.type!), m, `declared by ${what}`);
            else if (ts.isSetAccessorDeclaration(m)) { if (m.parameters[0]) checkParamDrop(pt, m.parameters[0], what); }
            else if (ts.isGetAccessorDeclaration(m)) checkReturnDrop(pt, m, what, true);
            else for (const sig of pt.getCallSignatures()) checkImplSig(sig, m, m, what);
          }
        }
      }
      if (ts.isInterfaceDeclaration(node)) {
        // An interface that REDECLARES an inherited branded member wider — a method, a function-typed
        // property, a getter's return, a setter's parameter, or a property typed `any` (round 6 finding 3;
        // a non-any wider property does not compile) — is the seam the implementing class then honors.
        const bases = (node.heritageClauses ?? []).flatMap((h) => h.types.map((t) => checker.getTypeAtLocation(t)));
        for (const m of node.members) {
          const key = propKey(m.name);
          if (key === undefined) continue;
          for (const b of bases) {
            const prop = checker.getPropertyOfType(b, key);
            if (!prop) continue;
            const pt = checker.getTypeOfSymbolAtLocation(prop, m);
            const what = `\`${node.name.text}.${key}\` redeclaring \`${checker.typeToString(b)}.${key}\``;
            if (ts.isMethodSignature(m)) for (const sig of pt.getCallSignatures()) checkImplSig(sig, m, m, what);
            else if (ts.isPropertySignature(m) && m.type && ts.isFunctionTypeNode(m.type)) for (const sig of pt.getCallSignatures()) checkImplSig(sig, m.type, m, what);
            else if (ts.isPropertySignature(m) && m.type) checkCovariant(pt, checker.getTypeFromTypeNode(m.type), m, `declared by ${what}`);
            else if (ts.isGetAccessorDeclaration(m)) checkReturnDrop(pt, m, what, false);
            else if (ts.isSetAccessorDeclaration(m)) { if (m.parameters[0]) checkParamDrop(pt, m.parameters[0], what); }
          }
        }
      }
      if (ts.isObjectLiteralExpression(node)) {
        const ctx0 = checker.getContextualType(node);
        const ctx = ctx0 && !isAnyish(ctx0) ? checker.getNonNullableType(ctx0) : undefined;
        if (ctx) for (const p of node.properties) {
          const key = propKey(p.name);
          const prop = key !== undefined ? checker.getPropertyOfType(ctx, key) : undefined;
          if (!prop) continue;
          const pt = checker.getTypeOfSymbolAtLocation(prop, p);
          const what = `member \`${key}\` of an object literal typed \`${checker.typeToString(ctx)}\``;
          // (a function-valued PROPERTY is a leaf value: the structural lock in checkSink compares its signature;
          //  an UNANNOTATED method / getter return is checked at every `return` against the contextual member)
          if (ts.isMethodDeclaration(p)) for (const sig of pt.getCallSignatures()) checkImplSig(sig, p, p, what, false);
          else if (ts.isSetAccessorDeclaration(p)) { if (p.parameters[0]) checkParamDrop(pt, p.parameters[0], what); }
          else if (ts.isGetAccessorDeclaration(p)) checkReturnDrop(pt, p, what, false);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);

    for (const m of sf.text.matchAll(MARKER_RE)) {
      if (!attached.has(m.index!)) fail("C2", rel, sf.getLineAndCharacterOfPosition(m.index!).line + 1, `orphan marker ${m[1]} — not attached to a brand construction or a marked erasure`);
    }
  }

  for (const [id, sites] of markerSeen) if (sites.length > 1) for (const s of sites) fail("C2", s.file, 0, `duplicate marker ${id} (${sites.length} sites)`);

  const retired: AuditResult["retired"] = { entries: [], diagnostics: [] };
  const diagKey = (d: KnownDiagnostic): string => `${d.file}|${d.code}|${d.message}|${d.scope}|${d.context ?? ""}|${d.fingerprint}`;
  if (ratchet) {
    const byId = new Map(ratchet.entries.map((e) => [e.id, e]));
    for (const e of entries) {
      const b = byId.get(e.id);
      if (!b) fail("C2", e.file, 0, `marker ${e.id} has no ratchet entry — the ratchet only tightens`);
      else if (b.file !== e.file || b.scope !== e.scope) fail("C2", e.file, 0, `marker ${e.id} relocated: ${b.file}[${b.scope}] -> ${e.file}[${e.scope}]`);
      else if ((b.kind ?? "construction") !== e.kind || b.brands.join("|") !== e.brands.join("|") || b.hash !== e.hash) {
        fail("C2", e.file, 0, `marker ${e.id} changed under the same id: ${b.kind ?? "construction"}[${b.brands.join("|")}] ${b.hash} \`${b.text}\` -> ${e.kind}[${e.brands.join("|")}] ${e.hash} \`${e.text}\``);
      }
    }
    const live = new Set(entries.map((e) => e.id));
    retired.entries = ratchet.entries.filter((e) => !live.has(e.id));
    // C0 baseline is a MULTISET: each live diagnostic consumes one baselined occurrence.
    const budget = new Map<string, number>();
    for (const d of ratchet.knownDiagnostics ?? []) budget.set(diagKey(d), (budget.get(diagKey(d)) ?? 0) + 1);
    for (const d of diagnostics) {
      const left = budget.get(diagKey(d)) ?? 0;
      if (left > 0) budget.set(diagKey(d), left - 1);
      else fail("C0", d.file, 0, `TS${d.code} in ${d.scope}${d.context ? ` {${d.context}}` : ""} [${d.fingerprint}] not in the baseline (or a second occurrence of a baselined one): ${d.message.slice(0, 200)}`);
    }
    retired.diagnostics = (ratchet.knownDiagnostics ?? []).filter((d) => { const n = budget.get(diagKey(d)) ?? 0; if (n > 0) { budget.set(diagKey(d), n - 1); return true; } return false; });
  } else {
    for (const d of diagnostics) fail("C0", d.file, 0, `TS${d.code} in ${d.scope}${d.context ? ` {${d.context}}` : ""} [${d.fingerprint}]: ${d.message.slice(0, 200)}`);
  }

  entries.sort((a, b) => a.id.localeCompare(b.id));
  findings.sort((a, b) => a.check.localeCompare(b.check) || a.file.localeCompare(b.file) || a.line - b.line);
  return { findings, closure, entries, diagnostics, retired };
}

export function loadRatchet(path: string = RATCHET): SeamRatchet | null {
  return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as SeamRatchet) : null;
}

function ratchetOf(r: AuditResult): SeamRatchet {
  return {
    generated: isoNow(),
    note: "O1 brand debt (constructions + marked erasures) and the pre-existing diagnostics baseline (multiset, control-flow-contextual). One entry per debt marker (bijection). --write is retire-only. Activation requires ZERO entries.",
    entries: r.entries,
    knownDiagnostics: r.diagnostics,
  };
}

function main(): number {
  const args = new Set(process.argv.slice(2));
  const base = loadRatchet();
  const r = audit(scopedFiles(), REPO, args.has("--init") ? null : base);

  if (args.has("--json")) { console.log(JSON.stringify(r, null, 2)); return r.findings.length === 0 ? 0 : 1; }

  if (args.has("--init")) {
    if (base) { console.error(`REFUSED: ${relative(REPO, RATCHET)} exists. --init bootstraps only; use --write to retire.`); return 2; }
    const nonC0 = r.findings.filter((f) => f.check !== "C0");
    if (nonC0.length > 0) { console.error(`REFUSED: --init cannot baseline non-C0 findings:`); for (const f of nonC0) console.error(`  [${f.check}] ${f.file}:${f.line} ${f.message}`); return 1; }
    writeFileSync(RATCHET, `${JSON.stringify(ratchetOf(r), null, 2)}\n`);
    console.log(`initialized ${relative(REPO, RATCHET)} — ${r.entries.length} debt entries, ${r.diagnostics.length} baselined diagnostic(s), ${r.closure.length} closure members`);
    return 0;
  }

  if (!base) { console.error(`FAIL: no ratchet at ${relative(REPO, RATCHET)}. Bootstrap with --init.`); return 1; }

  if (args.has("--write")) {
    if (r.findings.length > 0) {
      console.error(`REFUSED: --write is retire-only; ${r.findings.length} finding(s) must be fixed first:`);
      for (const f of r.findings) console.error(`  [${f.check}] ${f.file}:${f.line} ${f.message}`);
      return 2;
    }
    writeFileSync(RATCHET, `${JSON.stringify(ratchetOf(r), null, 2)}\n`);
    console.log(`retired ${r.retired.entries.length} debt entr(ies), ${r.retired.diagnostics.length} diagnostic(s); ${r.entries.length} debt entries remain`);
    return 0;
  }

  if (r.findings.length > 0) {
    console.error(`FAIL — ${r.findings.length} finding(s):`);
    for (const f of r.findings) console.error(`  [${f.check}] ${f.file}:${f.line} ${f.message}`);
    return 1;
  }
  if (r.retired.entries.length + r.retired.diagnostics.length > 0) {
    console.log(`${r.retired.entries.length} debt entr(ies) + ${r.retired.diagnostics.length} diagnostic(s) retired since baseline — run --write to tighten.`);
  }
  const erasures = r.entries.filter((e) => e.kind === "erasure").length;
  console.log(`OK — ${scopedFiles().length} files type-gated (${r.diagnostics.length} baselined) · ${r.closure.length} branded declaration(s) · ${r.entries.length} debt entries (${r.entries.length - erasures} constructions, ${erasures} erasures), all bijective`);
  return 0;
}

if (import.meta.main) process.exit(main());
