/**
 * ──────────────────────────────────────────────────────────────────────
 * A resumed install continues its profile; it does not fork a new one.
 *
 * An interrupted run writes no receipt — correctly, a half-finished install
 * has not earned the claim that the collection is installed — so the next run
 * takes fresh-profile mode again and used to create ANOTHER profile. One
 * tester's log carries five `install.start` lines with five different
 * `profileId`s, for one collection, in one day.
 *
 * The consequence is not cosmetic. Enablement is per-profile, so every mod
 * the earlier runs installed reads "Disabled" in the newest profile, and
 * Vortex reopens on whichever profile was last active — so the user is
 * usually looking at a different profile than the one filling up. They
 * reported that Event Horizon installs mods disabled. It does not: the same
 * log shows `{"inProfile":1106,"enabled":1106}` for the profile the run was
 * actually using.
 * ──────────────────────────────────────────────────────────────────────
 */
import { describe, expect, it } from "vitest";

import {
  pickInstallTarget,
  resumableProfileFromAttempts,
} from "./userState";
import type { EhcollManifest } from "../../types/ehcoll";
import type { InstallReceipt } from "../../types/installLedger";

const PACKAGE_ID = "f1f38ae9-f2ea-4f27-808c-3486b9e15ec9";
const PROFILE_ID = "77cd6d77-fb99-4780-8d9e-a35c2bd94f5c";

const manifest = {
  package: { id: PACKAGE_ID, name: "Meridia Panties", version: "1.0.10" },
  game: { id: "skyrimse" },
} as unknown as EhcollManifest;

const stateWith = (
  profiles: Record<string, { gameId: string; name: string }>,
): never => ({ persistent: { profiles } }) as never;

const attempt = (over: Record<string, unknown> = {}) => ({
  packageId: PACKAGE_ID,
  profileId: PROFILE_ID,
  ...over,
});

const skyrimProfiles = {
  [PROFILE_ID]: { gameId: "skyrimse", name: "Meridia Panties (Event Horizon v1.0.10)" },
};

describe("resumableProfileFromAttempts", () => {
  it("finds the profile the interrupted attempt was filling", () => {
    expect(
      resumableProfileFromAttempts(
        stateWith(skyrimProfiles),
        "skyrimse",
        PACKAGE_ID,
        [attempt()],
      ),
    ).toEqual({
      id: PROFILE_ID,
      name: "Meridia Panties (Event Horizon v1.0.10)",
    });
  });

  it("ignores an attempt at a DIFFERENT collection", () => {
    // Attempts are keyed per package; resuming into another collection's
    // half-built profile would merge two collections silently.
    expect(
      resumableProfileFromAttempts(
        stateWith(skyrimProfiles),
        "skyrimse",
        PACKAGE_ID,
        [attempt({ packageId: "some-other-package" })],
      ),
    ).toBeUndefined();
  });

  it("gives up when the user deleted the profile", () => {
    // Deleting it is a decision. A fresh profile is the right answer, and a
    // dangling id would send every enable dispatch into a profile that is
    // not there — invisible, and indistinguishable from installing disabled.
    expect(
      resumableProfileFromAttempts(stateWith({}), "skyrimse", PACKAGE_ID, [
        attempt(),
      ]),
    ).toBeUndefined();
  });

  it("refuses a profile belonging to another game", () => {
    expect(
      resumableProfileFromAttempts(
        stateWith({ [PROFILE_ID]: { gameId: "fallout4", name: "FO4" } }),
        "skyrimse",
        PACKAGE_ID,
        [attempt()],
      ),
    ).toBeUndefined();
  });

  it("handles an attempt that stopped before it made a profile", () => {
    // `profileId` is optional on the record — a run that failed in preflight
    // never got one.
    expect(
      resumableProfileFromAttempts(
        stateWith(skyrimProfiles),
        "skyrimse",
        PACKAGE_ID,
        [attempt({ profileId: undefined })],
      ),
    ).toBeUndefined();
  });

  it("handles no attempts at all — the first install", () => {
    expect(
      resumableProfileFromAttempts(
        stateWith(skyrimProfiles),
        "skyrimse",
        PACKAGE_ID,
        [],
      ),
    ).toBeUndefined();
  });
});

describe("pickInstallTarget with a resumable profile", () => {
  it("stays fresh-profile mode, but names the profile to continue", () => {
    /**
     * The mode must NOT become `current-profile`. That kind means a previous
     * RELEASE of this collection is installed, and it is what turns on orphan
     * detection and `previousInstall` — neither of which is true of a run
     * that never finished. The resolver enforces that pairing and would
     * throw. This says WHERE, not WHAT.
     */
    const target = pickInstallTarget(manifest, undefined, "active-1", "Active", {
      id: PROFILE_ID,
      name: "Meridia Panties (Event Horizon v1.0.10)",
    });

    expect(target.kind).toBe("fresh-profile");
    expect(target).toMatchObject({
      resumeProfileId: PROFILE_ID,
      resumeProfileName: "Meridia Panties (Event Horizon v1.0.10)",
    });
  });

  it("omits the field entirely when there is nothing to resume", () => {
    // Not `undefined` — omitted. `exactOptionalPropertyTypes` makes that a
    // real distinction, and the driver branches on presence.
    const target = pickInstallTarget(manifest, undefined, "active-1", "Active");

    expect(target.kind).toBe("fresh-profile");
    expect("resumeProfileId" in target).toBe(false);
  });

  it("a receipt still wins — that is an upgrade, not a resume", () => {
    // A finished previous install goes into the ACTIVE profile as before.
    // Letting a stale attempt record override that would move a user's
    // upgrade into an abandoned profile.
    const target = pickInstallTarget(
      manifest,
      { packageId: PACKAGE_ID } as InstallReceipt,
      "active-1",
      "Active",
      { id: PROFILE_ID, name: "Old attempt" },
    );

    expect(target).toEqual({
      kind: "current-profile",
      profileId: "active-1",
      profileName: "Active",
    });
  });
});
