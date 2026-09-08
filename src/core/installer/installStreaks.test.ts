/**
 * The streak rule, which is all that is left of `runAccumulator.ts`.
 *
 * Its other two describes — "proven-state bookkeeping" and "the report
 * collectors" — tested a SHADOW: the driver kept its own copies of that state
 * and those are the ones the receipt reads, so five green tests covered code
 * production never called while the live locals had none (GP-2). They went
 * with the shadow.
 */
import { describe, expect, it } from "vitest";

import { InstallStreaks } from "./installStreaks";

describe("the failure streak rule", () => {
  /**
   * The only piece of this state with logic rather than storage, and it lived
   * as three assignments forty lines apart in a 2,240-line function. A streak
   * is what tells the driver the cause is not this mod — so getting the reset
   * wrong means either giving up on a healthy collection or reporting nine
   * hundred identical failures.
   */
  it("counts failures and resets BOTH streaks on a success", () => {
    const run = new InstallStreaks();
    run.noteModFailed("timed-out");
    run.noteModFailed("timed-out");
    expect(run.consecutiveFailures).toBe(2);
    expect(run.consecutiveTimeouts).toBe(2);

    run.noteModSucceeded();
    expect(run.consecutiveFailures).toBe(0);
    expect(run.consecutiveTimeouts).toBe(0);
  });

  it("does not let a `gone` failure extend the TIMEOUT streak", () => {
    // The narrower two-value alias I first wrote would have made this a type
    // error rather than a decision. `gone` means Nexus answered fast and empty
    // — the collection references a file that no longer exists — which is a
    // fact about the package, not a sign that Vortex is wedged. Counting it as
    // a timeout stops a perfectly recoverable run for the wrong reason.
    const run = new InstallStreaks();
    run.noteModFailed("timed-out");
    run.noteModFailed("gone");
    run.noteModFailed("gone");
    expect(run.consecutiveFailures).toBe(3);
    expect(run.consecutiveTimeouts).toBe(0);
  });

  it("ends the TIMEOUT streak on a non-timeout failure, but not the failure streak", () => {
    // "Eight failures in a row" and "four timeouts in a row" are different
    // diagnoses, and only the second one means Vortex is wedged. A single
    // ordinary failure between two timeouts must not read as three timeouts.
    const run = new InstallStreaks();
    run.noteModFailed("timed-out");
    run.noteModFailed("unclear");
    run.noteModFailed("timed-out");
    expect(run.consecutiveFailures).toBe(3);
    expect(run.consecutiveTimeouts).toBe(1);
  });
});
