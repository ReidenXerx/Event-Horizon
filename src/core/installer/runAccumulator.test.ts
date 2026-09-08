import { describe, expect, it } from "vitest";

import { RunAccumulator } from "./runAccumulator";

describe("the failure streak rule", () => {
  /**
   * The only piece of this state with logic rather than storage, and it lived
   * as three assignments forty lines apart in a 2,240-line function. A streak
   * is what tells the driver the cause is not this mod — so getting the reset
   * wrong means either giving up on a healthy collection or reporting nine
   * hundred identical failures.
   */
  it("counts failures and resets BOTH streaks on a success", () => {
    const run = new RunAccumulator();
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
    const run = new RunAccumulator();
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
    const run = new RunAccumulator();
    run.noteModFailed("timed-out");
    run.noteModFailed("unclear");
    run.noteModFailed("timed-out");
    expect(run.consecutiveFailures).toBe(3);
    expect(run.consecutiveTimeouts).toBe(1);
  });
});

describe("proven-state bookkeeping", () => {
  it("records a mod whose files were proven", () => {
    const run = new RunAccumulator();
    const files = [{ path: "a.esp", size: 1, sha256: "b".repeat(64) }];
    run.noteVerifiedOk("nexus:1:2", files as never);
    expect(run.verifiedOkKeys.has("nexus:1:2")).toBe(true);
    expect(run.expectedFilesByCompareKey.get("nexus:1:2")).toEqual(files);
  });

  it("refuses to record a proof over NO files", () => {
    // A "proof" covering an empty set is not a proof. It would earn the mod a
    // drift reference in the receipt, and every later drift check would then
    // compare against a fiction.
    const run = new RunAccumulator();
    run.noteVerifiedOk("nexus:1:2", []);
    run.noteVerifiedOk("nexus:3:4", undefined);
    expect(run.verifiedOkKeys.size).toBe(0);
    expect(run.expectedFilesByCompareKey.size).toBe(0);
  });
});

describe("the report collectors", () => {
  it("keeps the three notice channels apart", () => {
    /**
     * They are not interchangeable and the difference is the whole point: a
     * curator report asks someone to fix their collection, an external-archive
     * notice tells the user where to get a file, and a damaged archive is
     * broken on THIS machine and is nobody's fault but the download's.
     * Collapsing them sends a user to bother a curator about a bad download.
     */
    const run = new RunAccumulator();
    run.reportToCurator("mod X diverged");
    run.noteExternalArchive("get Y from here");
    run.noteDamagedArchive("Z is truncated");

    expect(run.curatorReports).toEqual(["mod X diverged"]);
    expect(run.externalNotices).toEqual(["get Y from here"]);
    expect(run.damagedArchives).toEqual(["Z is truncated"]);
  });

  it("preserves order, because the receipt is read as a sequence", () => {
    const run = new RunAccumulator();
    run.verification({ kind: "ok", name: "first" } as never);
    run.verification({ kind: "fail", name: "second" } as never);
    expect(run.verifications.map((v) => (v as { name: string }).name)).toEqual([
      "first",
      "second",
    ]);
  });

  it("starts empty, so an untouched run reports nothing rather than undefined", () => {
    const run = new RunAccumulator();
    expect(run.failedMods).toEqual([]);
    expect(run.skippedMods).toEqual([]);
    expect(run.removedMods).toEqual([]);
    expect(run.carriedMods).toEqual([]);
    expect(run.verifications).toEqual([]);
    expect(run.curatorReports).toEqual([]);
  });
});
