/**
 * ──────────────────────────────────────────────────────────────────────
 * A SKIPPED MOD HAS TO BE NAMED, NOT COUNTED.
 *
 * `selfcheck.done` used to log `exampleSkipped` — ONE mod, with its notes —
 * beside a count. On the curator's own machine that is enough: the staging
 * folder and the download folder are right there to compare.
 *
 * Event Horizon ships to testers whose machines nobody can inspect, and for
 * them the log IS the machine. "6 mods could not be verified, here is one of
 * them" names a problem and withholds the only thing needed to act on it —
 * and the remedy for this particular problem is per-mod (rescan the download,
 * or re-fetch that archive), so a count cannot be acted on at all.
 *
 * Measured on the real build this was found in: 6 skipped, 1 named.
 *
 * Source text rather than behaviour, because `runSelfChecks` needs a live
 * Vortex state, a staging tree and real archives to reach this line.
 * FIXTURE-DEBT, recorded rather than papered over: this proves the log SAYS
 * the names, not that a real run produced them.
 * ──────────────────────────────────────────────────────────────────────
 */
import * as fs from "fs";
import * as path from "path";

import { describe, expect, it } from "vitest";

const src = fs.readFileSync(
  path.join(__dirname, "runSelfChecks.ts"),
  "utf8",
);

describe("the self-check log names every mod it skipped", () => {
  it("collects ALL the skipped reports, not the first one", () => {
    expect(src).toContain(
      'const skippedReports = reports.filter((r) => r.depth === "skipped")',
    );
    // The old shape, gone. `find` returns one mod and that was the bug.
    expect(src).not.toContain(
      'const firstSkipped = reports.find((r) => r.depth === "skipped")',
    );
  });

  it("puts their names in the log line", () => {
    expect(src).toContain("skippedMods: skippedReports");
  });

  it("caps the list and says how many it did not print", () => {
    /**
     * A collection where everything is unverifiable would otherwise write a
     * thousand names into a log nobody reads. The cap is fine; a cap that
     * hides its own existence is not — that is a silent truncation, and the
     * count it replaces is the thing a reader would trust.
     */
    expect(src).toContain("skippedReports.slice(0, 50)");
    expect(src).toContain("skippedNotListed: skippedReports.length - 50");
  });

  it("still carries one full example, with its notes", () => {
    // The names say WHICH; the example says WHY, and the reason string is
    // where the remedy lives ("a Downloads-tab rescan fixes it").
    expect(src).toContain("exampleSkipped");
    expect(src).toContain("notes: skippedReports[0]!.notes");
  });
});
