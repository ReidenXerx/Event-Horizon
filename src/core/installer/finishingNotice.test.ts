/**
 * The one function that survived `runPhase.ts`.
 *
 * The combinator it lived beside — `runPhase`, `runFinishing`, `isAbort` — had
 * zero production call sites while nine of that file's eleven tests exercised
 * it. Green tests over code nothing runs are the failure GP-2 names, and they
 * were wearing 225 lines of well-written test. This is the remaining two.
 */
import { describe, expect, it } from "vitest";

import { describeSkippedFinishing } from "./finishingNotice";

describe("what the user is told after stopping past the deploy", () => {
  it("names the skipped steps and how to finish them", () => {
    const msg = describeSkippedFinishing(["plugin order", "game settings"]);
    expect(msg).toContain("plugin order");
    expect(msg).toContain("game settings");
    expect(msg).toMatch(/again/);
    // The reason re-running is cheap is the reason this advice is honest.
    expect(msg).toMatch(/recognised rather than re-downloaded/);
  });

  it("explains why the run reported success at all", () => {
    // A stop that produces a receipt looks like the tool ignored the stop.
    // It did not: abandoning a deployed collection leaves one with no record
    // of itself, which is the state provenance depends on not existing (NS-2).
    const msg = describeSkippedFinishing(["ESL flags"]);
    expect(msg).toMatch(/already deployed/);
    expect(msg).toMatch(/rather than leaving you with none/);
  });
});
