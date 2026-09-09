/**
 * "Was this an abort?" has one definition, and nobody re-grows a private copy.
 *
 * ─── WHY THIS EXISTS ────────────────────────────────────────────────────────
 * `abortError.ts` documented the convention — "we rely on `(err as
 * Error).name === 'AbortError'` checks at abort-handling sites" — and then
 * exported no way to perform one. So the predicate was hand-written at 27
 * sites, in shapes that are NOT equivalent:
 *
 *   (err as Error)?.name === "AbortError"
 *   err instanceof AbortError                      ← misses a DOMException
 *   err instanceof Error && err.name === "..."     ← same miss
 *   ... || ctx.abortSignal?.aborted === true       ← catches a different case
 *
 * The second and third MISS a native AbortSignal's DOMException, which is what
 * `fs.promises` throws when a signal fires and the exact shape the class
 * documents being interchangeable with. In `modInstall` that meant a cancelled
 * install was retried twice more with ~11 seconds of backoff — the "I pressed
 * stop and nothing happened" complaint, caused by the check rather than by the
 * cancellation.
 *
 * Same shape as `noInlinePathHelpers`, and for the same reason: six private
 * `toPosix` copies disagreed and the disagreement shipped.
 *
 * The rule is narrow on purpose. It catches the one idiom that was duplicated
 * and names the replacement, so a failure here is actionable rather than
 * annoying.
 */
import * as fs from "fs";
import * as path from "path";

import { describe, expect, it } from "vitest";

const SRC = path.join(__dirname, "..");

/** Every .ts/.tsx under src/, tests excluded. */
function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      sourceFiles(full, out);
    } else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

/** Comments describe the convention; only CODE has to follow it. */
function codeOnly(text: string): string {
  return text
    .split("\n")
    .filter((l) => !/^\s*(\*|\/\/)/.test(l))
    .join("\n");
}

const NAME_CHECK = /\.name\s*===\s*"AbortError"/;

describe("nobody re-grows a private abort predicate", () => {
  it("catches its own pattern, so an empty result means something", () => {
    /**
     * GP-7. A scan that silently stops matching reports a clean codebase for
     * ever. This proves the regex still finds the thing it is looking for.
     */
    expect(NAME_CHECK.test('if (err.name === "AbortError") return true;')).toBe(
      true,
    );
    expect(NAME_CHECK.test("if (isAbort(err)) return true;")).toBe(false);
  });

  it("finds the module it points people at", () => {
    // A failure message naming a function that does not exist is worse than
    // no failure message.
    const home = fs.readFileSync(path.join(__dirname, "abortError.ts"), "utf8");
    expect(home).toContain("export function isAbort(");
  });

  it("has exactly ONE definition of the name check", () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(SRC)) {
      // `abortError.ts` is where it is allowed to live.
      if (file.endsWith(path.join("utils", "abortError.ts"))) continue;
      /**
       * `nexusAvailability` is a deliberate exception and says so: it also
       * matches `/abort/i` against the MESSAGE, because the Nexus client
       * rejects with a plain Error whose name is not set. Broader on purpose
       * is not the same as a private copy, and flattening it would report a
       * cancelled lookup as a network failure.
       */
      if (file.endsWith(path.join("build", "nexusAvailability.ts"))) continue;

      if (NAME_CHECK.test(codeOnly(fs.readFileSync(file, "utf8")))) {
        offenders.push(path.relative(SRC, file));
      }
    }

    expect(
      offenders,
      `These files hand-roll the abort check. Use \`isAbort(err, signal?)\` ` +
        `from utils/abortError instead — the hand-rolled forms disagree about ` +
        `a DOMException from a native AbortSignal, which is what fs.promises ` +
        `throws.`,
    ).toEqual([]);
  });
});
