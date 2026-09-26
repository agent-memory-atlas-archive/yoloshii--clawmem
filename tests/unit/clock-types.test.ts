import { describe, it, expect } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

/**
 * Compiles the O1 brand negatives fixture and asserts it is clean.
 *
 * The fixture is a wall of `@ts-expect-error` + deliberate misuse. That inverts
 * the assertion: a clean compile means every misuse IS still a type error. If a
 * brand is weakened so that (say) a raw `number` becomes an acceptable budget,
 * the directive above it goes unused and tsc fails here.
 *
 * The second test guards the guard. A fixture of nothing but `@ts-expect-error`
 * would also compile clean if the compiler flags were wrong and NOTHING was
 * being checked — so we mutate a copy, removing one directive, and require that
 * tsc then reports an error. If that mutation does not fail, this harness is
 * vacuous and the first test proves nothing.
 */

const REPO = resolve(import.meta.dir, "../..");
const TSC = join(REPO, "node_modules/.bin/tsc");
const FIXTURE = join(REPO, "tests/unit/clock-type-negatives.ts");

const TSC_ARGS = [
  "--noEmit",
  "--strict",
  "--target", "esnext",
  "--moduleResolution", "bundler",
  "--allowImportingTsExtensions",
  "--lib", "esnext,dom",
];

function typecheck(file: string): { code: number; out: string } {
  const r = spawnSync(TSC, [...TSC_ARGS, file], { cwd: REPO, encoding: "utf8" });
  return { code: r.status ?? -1, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

describe("clock brand negatives", () => {
  it("every documented misuse is rejected by the type system", () => {
    const { code, out } = typecheck(FIXTURE);
    // A non-zero exit means either a misuse started compiling (unused directive)
    // or a positive-case line broke. Both are real regressions.
    expect(out).toBe("");
    expect(code).toBe(0);
  });

  it("the harness is not vacuous: removing one directive makes tsc fail", () => {
    const src = readFileSync(FIXTURE, "utf8");
    const marker = "// @ts-expect-error\ndeadlineAfter(monoNow(), 8000);";
    // Anchor check — if the fixture is edited, this test must be updated with it
    // rather than silently degrading into a no-op.
    expect(src).toContain(marker);

    const dir = mkdtempSync(join(tmpdir(), "clawmem-clock-guard-"));
    try {
      const mutated = join(dir, "mutated.ts");
      // Absolute import so the copy still resolves src/clock.ts from /tmp.
      writeFileSync(
        mutated,
        src
          .replace(marker, "deadlineAfter(monoNow(), 8000);")
          .replaceAll("../../src/clock.ts", join(REPO, "src/clock.ts")),
      );
      const { code, out } = typecheck(mutated);
      expect(code).not.toBe(0);
      // And it fails for the RIGHT reason: the raw number is rejected.
      expect(out).toMatch(/not assignable to parameter of type 'DurationMs'/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
