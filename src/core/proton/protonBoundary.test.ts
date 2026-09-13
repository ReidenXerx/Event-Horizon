/**
 * The Proton service only stays a service if nothing else probes the machine
 * for Wine behind its back.
 *
 * Before it existed there were two copies of "is this Wine?" — in the 7-Zip
 * preflight and in the Collections page's error report, probing different
 * paths — and a Heroic/Steam prefix locator inside the environment checks.
 * The patterns below are what looking for Wine yourself looks like in code;
 * outside src/core/proton each one means a feature went looking on its own.
 */
import * as fs from "fs";
import * as path from "path";

import { describe, expect, it } from "vitest";

const SRC = path.join(__dirname, "..", "..");
const SERVICE = `${path.sep}${path.join("core", "proton")}${path.sep}`;

/** Every .ts/.tsx under src/, except tests and test helpers. */
function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      sourceFiles(full, out);
    } else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) && !/\.testutil\.ts$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

const PROBES: ReadonlyArray<{ what: string; pattern: RegExp; example: string }> = [
  { what: "a probe of the Z: drive Wine maps to /", pattern: /["'`]Z:\\\\/, example: 'fs.existsSync("Z:\\\\usr")' },
  { what: "winemenubuilder", pattern: /winemenubuilder\.exe/i, example: '"C:\\\\windows\\\\system32\\\\winemenubuilder.exe"' },
  { what: "Wine's environment variables", pattern: /\bWINE(?:HOMEDIR|CONFIGDIR|_HOST_)/, example: 'env["WINEHOMEDIR"]' },
  { what: "a launcher's prefix records", pattern: /compatdata|heroicgameslauncher|GamesConfig\//, example: '"steamapps/compatdata/377160"' },
];

describe("nothing outside the Proton service probes for Wine", () => {
  it("recognises every probe it guards against", () => {
    // GP-4: a guard only ever fed the idiom already removed cannot fail.
    for (const p of PROBES) expect(p.pattern.test(p.example), p.what).toBe(true);
  });

  it("is walking the real source tree", () => {
    // A guard looking in the wrong folder passes on nothing.
    const files = sourceFiles(SRC);
    expect(files.some((f) => f.includes(SERVICE))).toBe(true);
    expect(files.length).toBeGreaterThan(100);
  });

  it("finds each of them only in src/core/proton", () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(SRC)) {
      if (file.includes(SERVICE)) continue;
      const text = fs.readFileSync(file, "utf8");
      for (const p of PROBES) if (p.pattern.test(text)) offenders.push(`${path.relative(SRC, file)}: ${p.what}`);
    }
    expect(offenders, `ask src/core/proton instead — ${offenders.join("; ")}`).toEqual([]);
  });
});
