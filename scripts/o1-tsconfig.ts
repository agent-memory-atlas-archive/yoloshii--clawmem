/**
 * The repository's compiler contract, for the O1 audits (codex code-review
 * round 5, finding 1).
 *
 * Both audits build a `ts.Program` and treat its diagnostics (the seam audit's
 * C0) and its symbol resolution (every check) as the truth about the code
 * production runs. That is only so if the program is built under the SAME
 * options production type-checks with: `module: Preserve`, `moduleDetection:
 * force`, `noImplicitOverride`, `noFallthroughCasesInSwitch`, the `jsx`
 * flavour — hard-coding a subset made a no-import file a script in the audit
 * but a module in production, and hid whole diagnostic classes. So the options
 * are READ from `tsconfig.json`; an audit overrides only what is audit-specific
 * (`noEmit`, `allowJs`, `checkJs`, conditional `skipLibCheck`) and supplies
 * its own roots. Fixtures in temp roots reuse the repository's options too:
 * the contract under test is the repository's.
 */

import ts from "typescript";
import { join, resolve } from "node:path";

const REPO = resolve(import.meta.dir, "..");
export const REPO_TSCONFIG = join(REPO, "tsconfig.json");

/**
 * Compiler options parsed from a tsconfig file exactly as `tsc -p` would
 * (`extends`, enum names, `lib` file names all resolved). `files`/`include`
 * are NOT consulted — the audits supply their own roots — so the only
 * config-file diagnostic tolerated is "no inputs" (TS18003); anything else
 * (an unknown option, a bad value) fails loudly rather than checking under
 * a contract nobody wrote.
 */
export function compilerOptionsFrom(tsconfigPath: string): ts.CompilerOptions {
  const read = ts.readConfigFile(tsconfigPath, ts.sys.readFile);
  if (read.error) throw new Error(`${tsconfigPath}: ${ts.flattenDiagnosticMessageText(read.error.messageText, " ")}`);
  const raw = { ...(read.config as Record<string, unknown>), files: [], include: [] };
  const parsed = ts.parseJsonConfigFileContent(raw, ts.sys, resolve(tsconfigPath, ".."), undefined, tsconfigPath);
  const errors = parsed.errors.filter((e) => e.category === ts.DiagnosticCategory.Error && e.code !== 18002 && e.code !== 18003);
  if (errors.length > 0) throw new Error(`${tsconfigPath}: ${errors.map((e) => ts.flattenDiagnosticMessageText(e.messageText, " ")).join("; ")}`);
  return parsed.options;
}

let repoOptions: ts.CompilerOptions | undefined;
/** The repository's own contract, parsed once per process (the file does not change under a run). */
export function repoCompilerOptions(): ts.CompilerOptions {
  return (repoOptions ??= compilerOptionsFrom(REPO_TSCONFIG));
}
