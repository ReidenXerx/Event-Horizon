/**
 * The service only stays a service if nobody re-grows a private copy.
 *
 * Before it existed this codebase carried six independent `toPosix`
 * implementations, two disagreeing basename idioms and three comparison keys
 * that each lowercased on their own terms — and the disagreement SHIPPED: the
 * mirror pass folded case from the day it was written while verification
 * compared verbatim, so four healthy mods were reported as broken.
 *
 * The rule this guards is narrow on purpose. It does not police every use of
 * `path`; it catches the one idiom that was duplicated, and it names the
 * replacement so the failure is actionable rather than annoying.
 */
import * as fs from "fs";
import * as path from "path";

import { describe, expect, it } from "vitest";

const SRC = path.join(__dirname, "..", "..");

/** Every .ts/.tsx under src/, except the service itself and the tests. */
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

describe("nobody re-grows a private path helper", () => {
  it("has exactly ONE definition of separator normalisation", () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(SRC)) {
      // The service is where it is allowed to live.
      if (file.includes(path.join("core", "paths"))) continue;
      const text = fs.readFileSync(file, "utf8");
      // `.replace(/\/g, "/")` in any spelling.
      if (/replace\(\s*\/\\\/g\s*,\s*["']\/["']\s*\)/.test(text)) {
        offenders.push(path.relative(SRC, file));
      }
    }
    expect(
      offenders,
      `use toPosix() from core/paths instead — see ${offenders.join(", ")}`,
    ).toEqual([]);
  });

  it("has no private split-on-either-separator", () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(SRC)) {
      if (file.includes(path.join("core", "paths"))) continue;
      const text = fs.readFileSync(file, "utf8");
      if (/split\(\s*\/\[\\\/\]\/\s*\)/.test(text)) {
        offenders.push(path.relative(SRC, file));
      }
    }
    expect(
      offenders,
      `use segmentsOf() or basenameOf() from core/paths instead — see ${offenders.join(", ")}`,
    ).toEqual([]);
  });

  it("catches its own pattern, so an empty result means something", () => {
    /**
     * A guard that cannot fire is a guard nobody can trust. This proves the
     * regex matches the idiom it is looking for, rather than passing because
     * it matches nothing at all.
     */
    const sample = 'const norm = (p) => p.replace(/\\/g, "/");';
    expect(/replace\(\s*\/\\\/g\s*,\s*["']\/["']\s*\)/.test(sample)).toBe(true);
    const sample2 = "const parts = p.split(/[\\/]/);";
    expect(/split\(\s*\/\[\\\/\]\/\s*\)/.test(sample2)).toBe(true);
  });
});
