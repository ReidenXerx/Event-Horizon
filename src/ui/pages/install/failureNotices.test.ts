/**
 * A failure result carries what the run DID, and the failure card renders it.
 *
 * ─── WHY THIS IS A TEST ─────────────────────────────────────────────────────
 * A failure used to mean "nothing happened", so `InstallFailed` carried almost
 * no notices and `FailureBody` accepted one. That stopped being true when a
 * partial run started writing a receipt: 978 of 979 mods can be installed,
 * deployed and load-ordered, and the run still returns `failed`.
 *
 * The driver computed every notice on that path and dropped them at the
 * return. The docblock beside it claimed the opposite — that the fix had
 * restored "all of the notices describing that work" — while the object
 * literal restored three of eleven. A comment asserting a property the code
 * does not have is worse than none, and it is exactly what this file exists
 * to stop.
 *
 * The worst omission was `finishingSkippedNotice`. Stop after the deploy with
 * a failed mod and the screen said "source the missing ones and run this
 * again", never that the plugin order was not applied or the ESL flags not
 * restored — and without the flags, a profile that fits only because most of
 * its plugins are light does not start.
 *
 * FIXTURE-DEBT: a behavioural test needs a driver run that both stops after
 * the deploy AND leaves a mod failed, then a rendered card to read. The
 * `stopAfterDeploy` e2e covers the first half only. Until it covers both,
 * this asserts the wiring, and every anchor it locates is proven to exist.
 */
import * as fs from "fs";
import * as path from "path";

import { describe, expect, it } from "vitest";

const read = (rel: string): string =>
  fs.readFileSync(path.join(__dirname, rel), "utf8");

const driver = fs.readFileSync(
  path.join(__dirname, "..", "..", "..", "core", "installer", "runInstall.ts"),
  "utf8",
);
const types = fs.readFileSync(
  path.join(__dirname, "..", "..", "..", "types", "installDriver.ts"),
  "utf8",
);
const steps = read("steps.tsx");

/**
 * The notices a partial run can produce. Every one describes work the driver
 * really did on the failing path — a deletion, a rewrite inside the game
 * folder, or a phase it deliberately skipped.
 */
const NOTICES = [
  "finishingSkippedNotice",
  "pluginFlagNotice",
  "mirrorNotice",
  "damagedArchiveNotice",
  "curatorReports",
  "rulesPurgeNotice",
];

describe("what a partial install reports", () => {
  it("has the anchors it locates, so a rename cannot make this vacuous", () => {
    // GP-7. A source-text test that stops matching goes green for ever and
    // reports coverage it does not have.
    expect(types).toContain("export type InstallFailed");
    expect(driver).toContain("const deferredFailure");
    expect(steps).toContain("function FailureBody(props: {");
  });

  it("declares every notice on InstallFailed, not only on InstallSuccess", () => {
    const failed = types.slice(
      types.indexOf("export type InstallFailed"),
      types.indexOf("export type FailedModReportEntry"),
    );
    expect(failed.length).toBeGreaterThan(0);
    for (const notice of NOTICES) {
      expect(failed, notice).toContain(`${notice}?:`);
    }
  });

  it("populates them where the partial-failure result is built", () => {
    const start = driver.indexOf("const deferredFailure");
    expect(start).toBeGreaterThan(-1);
    // The closure ends at the receipt build that follows it.
    const end = driver.indexOf("const receipt = buildReceipt(", start);
    expect(end).toBeGreaterThan(start);
    const body = driver.slice(start, end);
    for (const notice of NOTICES) {
      expect(body, notice).toContain(notice);
    }
    // And the receipt path, so a partial install is findable at all.
    expect(body).toContain("receiptPath");
  });

  it("renders them on the failure card", () => {
    const start = steps.indexOf("function FailureBody(props: {");
    const body = steps.slice(start);
    for (const notice of NOTICES) {
      expect(body, notice).toContain(`props.${notice}`);
    }
  });

  it("forwards them from the failed branch of the Done step", () => {
    /**
     * The gap that shipped: the fields existed on the result and the card
     * could have rendered them, and the branch that constructs the card
     * passed exactly one.
     */
    const branch = steps.slice(
      steps.indexOf('headline = "Install failed"'),
      steps.indexOf("return (", steps.indexOf('headline = "Install failed"')),
    );
    expect(branch.length).toBeGreaterThan(0);
    for (const notice of NOTICES) {
      expect(branch, notice).toContain(`result.${notice}`);
    }
  });
});
