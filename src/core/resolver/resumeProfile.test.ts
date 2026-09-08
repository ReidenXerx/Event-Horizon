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

const VERSION = "1.0.10";

const attempt = (over: Record<string, unknown> = {}) => ({
  packageId: PACKAGE_ID,
  packageVersion: VERSION,
  profileId: PROFILE_ID,
  ...over,
});

const skyrimProfiles = {
  [PROFILE_ID]: { gameId: "skyrimse", name: "Meridia Panties (Event Horizon v1.0.10)" },
};

describe("an unusable candidate must not hide a usable one behind it", () => {
  /**
   * `resumeCandidates` deliberately ranks every ATTEMPT ahead of every
   * MARKER, and this function used to implement that preference as
   * `attempts.find(a => a.packageId === packageId)` — the first record with a
   * matching packageId, then a verdict from that record alone.
   *
   * Preference implemented as exclusion. `packageId` is per-COLLECTION, not
   * per-release, and attempts are cleared only on success, so a stale
   * unusable record sits in front of a perfectly good one and the good one is
   * never looked at. Both refusal arms are reachable this way, and each ends
   * in a forked profile where the user's already-installed mods read
   * "Disabled" — the exact failure markers exist to prevent.
   *
   * The old tests could not see it: every "both records exist" case used an
   * attempt that was itself fully usable, so the first match was always the
   * right one (GP-4).
   */
  it("resumes past a STALE-VERSION attempt into the marker behind it", () => {
    const markerProfile = "aaaaaaaa-0000-4000-8000-000000000000";
    const result = resumableProfileFromAttempts(
      stateWith({
        ...skyrimProfiles,
        [markerProfile]: { gameId: "skyrimse", name: "Marker profile" },
      }),
      "skyrimse",
      PACKAGE_ID,
      VERSION,
      [
        // A failed install of an OLDER release, never cleared.
        attempt({ packageVersion: "0.9.0", profileId: PROFILE_ID }),
        // The killed run of the CURRENT release, holding the real work.
        attempt({ packageVersion: VERSION, profileId: markerProfile }),
      ],
    );
    expect(result).toEqual({
      kind: "resume",
      id: markerProfile,
      name: "Marker profile",
    });
  });

  it("resumes past a PROFILE-LESS attempt into the marker behind it", () => {
    // A run cancelled at preflight records an attempt with no profile at all.
    const result = resumableProfileFromAttempts(
      stateWith(skyrimProfiles),
      "skyrimse",
      PACKAGE_ID,
      VERSION,
      [attempt({ profileId: undefined }), attempt()],
    );
    expect(result.kind).toBe("resume");
  });

  it("still refuses when NO candidate qualifies, and says why", () => {
    // The preference must not become "resume anything". With every candidate
    // unusable the answer is still a refusal, and it is the most specific one
    // available — from the highest-ranked candidate.
    const result = resumableProfileFromAttempts(
      stateWith(skyrimProfiles),
      "skyrimse",
      PACKAGE_ID,
      VERSION,
      [
        attempt({ packageVersion: "0.9.0" }),
        attempt({ packageVersion: "0.8.0" }),
      ],
    );
    expect(result).toEqual({ kind: "refused", why: "version-changed" });
  });
});

describe("resumableProfileFromAttempts", () => {
  it("finds the profile the interrupted attempt was filling", () => {
    expect(
      resumableProfileFromAttempts(
        stateWith(skyrimProfiles),
        "skyrimse",
        PACKAGE_ID,
        VERSION,
        [attempt()],
      ),
    ).toEqual({
      kind: "resume",
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
        VERSION,
        [attempt({ packageId: "some-other-package" })],
      ),
    ).toEqual({ kind: "refused", why: "no-attempt" });
  });

  it("gives up when the user deleted the profile", () => {
    // Deleting it is a decision. A fresh profile is the right answer, and a
    // dangling id would send every enable dispatch into a profile that is
    // not there — invisible, and indistinguishable from installing disabled.
    expect(
      resumableProfileFromAttempts(stateWith({}), "skyrimse", PACKAGE_ID, VERSION, [
        attempt(),
      ]),
    ).toEqual({
      kind: "refused",
      why: "profile-deleted",
      // Names the profile it went looking for. Without it the claim is
      // unfalsifiable from a log: a tester forked a fourth profile and we
      // could not tell "they deleted it" from "we looked for the wrong id".
      attemptProfileId: PROFILE_ID,
    });
  });

  it("refuses a profile belonging to another game", () => {
    expect(
      resumableProfileFromAttempts(
        stateWith({ [PROFILE_ID]: { gameId: "fallout4", name: "FO4" } }),
        "skyrimse",
        PACKAGE_ID,
        VERSION,
        [attempt()],
      ),
    ).toEqual({
      kind: "refused",
      why: "profile-other-game",
      attemptProfileId: PROFILE_ID,
    });
  });

  it("handles an attempt that stopped before it made a profile", () => {
    // `profileId` is optional on the record — a run that failed in preflight
    // never got one.
    expect(
      resumableProfileFromAttempts(
        stateWith(skyrimProfiles),
        "skyrimse",
        PACKAGE_ID,
        VERSION,
        [attempt({ profileId: undefined })],
      ),
    ).toEqual({ kind: "refused", why: "attempt-has-no-profile" });
  });

  it("REFUSES a different release — that is not a resume", () => {
    /**
     * The attempt record carried `packageVersion` all along and this ignored
     * it, matching on `packageId` alone. So a failed v1.0.0 install made
     * v1.0.1 resume into v1.0.0's profile — where orphan detection is off by
     * construction and nothing ever dispatches `enabled: false`. Every mod
     * v1.0.1 dropped would stay installed AND enabled, and the receipt would
     * then claim an exact reproduction of a profile that is a superset of it.
     *
     * For a tool whose product is a reproducible profile, that is a silent
     * correctness failure, not untidiness.
     */
    expect(
      resumableProfileFromAttempts(
        stateWith(skyrimProfiles),
        "skyrimse",
        PACKAGE_ID,
        "1.0.11",
        [attempt()],
      ),
    ).toEqual({ kind: "refused", why: "version-changed" });
  });

  it("carries the refusal reason into the plan, so the log can say why", () => {
    // Five distinct reasons used to be the same silence, which made "the
    // attempt had no profile id" indistinguishable from "this build does not
    // have the fix" in a tester's log.
    const target = pickInstallTarget(manifest, undefined, "a", "A", {
      kind: "refused",
      why: "profile-deleted",
      attemptProfileId: PROFILE_ID,
    });
    expect(target).toMatchObject({
      resumeRefusedWhy: "profile-deleted",
      resumeRefusedProfileId: PROFILE_ID,
    });
    expect("resumeProfileId" in target).toBe(false);
  });

  it("handles no attempts at all — the first install", () => {
    expect(
      resumableProfileFromAttempts(
        stateWith(skyrimProfiles),
        "skyrimse",
        PACKAGE_ID,
        VERSION,
        [],
      ),
    ).toEqual({ kind: "refused", why: "no-attempt" });
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
      kind: "resume",
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

  it("a receipt for the SAME release wins — in place, not a resume", () => {
    // Re-running the release you already have is a repair, and it happens in
    // the profile you are on. Letting a stale attempt record override that
    // would move a user's re-run into an abandoned profile.
    const target = pickInstallTarget(
      manifest,
      { packageId: PACKAGE_ID, packageVersion: "1.0.10" } as InstallReceipt,
      "active-1",
      "Active",
      { kind: "resume", id: PROFILE_ID, name: "Old attempt" },
    );

    expect(target).toEqual({
      kind: "current-profile",
      profileId: "active-1",
      profileName: "Active",
    });
  });

  it("a receipt for a DIFFERENT release gets its own profile", () => {
    /**
     * The user's rule, in one assertion: "new profile we create only if its
     * new revision of collection in new ehcoll."
     *
     * It is also the fix for a real hazard. `current-profile` installs into
     * the ACTIVE profile, never the one the receipt names — so upgrading
     * while sitting on a vanilla profile merged 1,700 mods, a rules purge and
     * a plugins.txt rewrite into it. A new profile per revision sidesteps
     * that and leaves the working release switchable.
     */
    const target = pickInstallTarget(
      manifest,
      { packageId: PACKAGE_ID, packageVersion: "1.0.9" } as InstallReceipt,
      "active-1",
      "Active",
    );

    expect(target).toMatchObject({
      kind: "fresh-profile",
      // Named for the release being installed, so the two are told apart in
      // Vortex's profile list.
      suggestedProfileName: "Meridia Panties (Event Horizon v1.0.10)",
      resumeRefusedWhy: "version-changed",
    });
  });
});
