/**
 * The second half of the game-version soft block (owner poll, 2026-09-22).
 *
 * A mismatch no longer makes `canProceed` false — that is what lets a player
 * on another version through at all. So the driver itself must refuse a run
 * nobody acknowledged: the preview's checkbox is one route in, and any other
 * route would otherwise install on the wrong version without a word.
 */
import { describe, expect, it } from "vitest";

import { preflight } from "./runInstall";

const mismatch = { required: "1.6.1179.0", installed: "1.6.1170.0" };

const plan = (versionMismatch?: typeof mismatch): never =>
  ({
    summary: { canProceed: true },
    compatibility: { gameMatches: true, ...(versionMismatch ? { versionMismatch } : {}) },
    modResolutions: [],
    orphanedMods: [],
    installTarget: { kind: "current-profile" },
  }) as never;

describe("installing on another game version", () => {
  it("refuses when nobody acknowledged the mismatch", () => {
    expect(preflight(plan(mismatch), {})).toMatch(/1\.6\.1179\.0.*1\.6\.1170\.0/);
  });

  it("proceeds once the same pair is acknowledged", () => {
    expect(preflight(plan(mismatch), { versionMismatchAcknowledged: { ...mismatch } })).toBeUndefined();
  });

  it("refuses an acknowledgement given for a different installed version", () => {
    // The game updated between preview and install: a different question.
    const refusal = preflight(plan(mismatch), {
      versionMismatchAcknowledged: { required: "1.6.1179.0", installed: "1.6.1130.0" },
    });
    expect(refusal).toBeDefined();
  });

  it("asks nothing when the versions match", () => {
    expect(preflight(plan(), {})).toBeUndefined();
  });
});
