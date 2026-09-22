/**
 * ──────────────────────────────────────────────────────────────────────
 * PRESSING STOP IS NOT A CRASH, AND IS NOT A FAILED INSTALL.
 *
 * `tryRecoverFailedMod` and `tryInstallAlongside` deliberately rethrow on
 * abort — and their calls in the verify/repair/alongside phase sit in no
 * `try`, because `runInstallImpl` wraps that region in none. So pressing Stop
 * during "Verifying 979 mods…", while one of the failing mods is being
 * repaired or alongside-installed (a download plus an extraction: minutes, and
 * exactly when someone gives up), sends an `AbortError` straight out of the
 * driver.
 *
 * It landed in `runInstall`'s catch, which had no abort arm. The attempt was
 * recorded `outcome: "failed", phase: "failed"`, so `describeInstallAttempt`
 * told the player *"The last install of X failed during 'failed'"*; the throw
 * then reached `installSession`, whose one async catch that did not check
 * `isAbortError` first showed "Install driver crashed" with a copy-out report
 * and logged `install.wizard.failed`. The user's own Stop, presented as a
 * crash, in both the record and the modal.
 *
 * Resume survived either way — the `escaped` hatch carries the profile and the
 * installed list — so this was never data loss. It was a false claim about
 * what happened, which is the kind this project treats as a defect.
 * ──────────────────────────────────────────────────────────────────────
 */
import * as fs from "fs";
import * as path from "path";

import { describe, expect, it } from "vitest";

import { buildAbortedResult } from "./runInstall";

const driver = fs.readFileSync(path.join(__dirname, "runInstall.ts"), "utf8");
const session = fs.readFileSync(
  path.join(__dirname, "..", "..", "ui", "pages", "install", "installSession.ts"),
  "utf8",
);

describe("the driver reports an escaped abort as an abort", () => {
  it("has its anchors, so this cannot go vacuous", () => {
    // GP-7.
    expect(driver).toContain("    result = await runInstallImpl(ctx);");
    expect(driver).toContain('      kind: "failed",');
  });

  it("checks for an abort BEFORE recording the attempt as failed", () => {
    const call = driver.indexOf("    result = await runInstallImpl(ctx);");
    const abortArm = driver.indexOf("if (isAbort(err, ctx.abortSignal)) {", call);
    const failedArm = driver.indexOf('      kind: "failed",', call);
    expect(abortArm).toBeGreaterThan(call);
    expect(failedArm).toBeGreaterThan(abortArm);
  });

  it("routes it through the one abort builder, not a hand-rolled result", () => {
    const call = driver.indexOf("    result = await runInstallImpl(ctx);");
    const abortArm = driver.indexOf("if (isAbort(err, ctx.abortSignal)) {", call);
    const arm = driver.slice(abortArm, abortArm + 700);
    expect(arm).toContain("buildAbortedResult({");
    // What reached disk before the Stop is carried out, not dropped: how far a
    // run got is what decides what the user does next.
    expect(arm).toContain("escaped.installed.map");
    expect(arm).toContain("escaped.profileId");
  });

  it("produces a result the attempt record stores as aborted, not failed", () => {
    // `recordAttemptOutcome` reads `result.kind`, so the shape is the claim.
    const aborted = buildAbortedResult({
      phase: "verifying-mods",
      reason: "Stopped during verification.",
      partialProfileId: "prof-1",
      installedMods: [{ vortexModId: "a" }, { vortexModId: "b" }],
    });
    expect(aborted.kind).toBe("aborted");
    expect(aborted.phase).toBe("verifying-mods");
    expect(aborted.partialProfileId).toBe("prof-1");
    expect(aborted.installedSoFar).toEqual(["a", "b"]);
  });
});

describe("the install session does not call a Stop a crash", () => {
  it("checks isAbortError before the driver-crashed modal", () => {
    const crash = session.indexOf('title: "Install driver crashed",');
    expect(crash).toBeGreaterThan(-1);
    // The guard sits in the same catch, above the modal.
    const catchAt = session.lastIndexOf("      } catch (err) {", crash);
    expect(catchAt).toBeGreaterThan(-1);
    const body = session.slice(catchAt, crash);
    expect(body).toContain("if (isAbortError(err)) {");
    expect(body).toContain('kind: "aborted"');
  });
});
