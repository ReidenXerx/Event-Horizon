import { describe, expect, it } from "vitest";

import {
  deploymentInProgress,
  readKnownProfiles,
  supersededEhProfiles,
} from "./profileCleanup";

/**
 * The seventeen profiles from the log bundle that prompted this, verbatim.
 * They carry the two things a tidy fixture would have lost: the collection
 * was RENAMED partway ("ivy - 2" → "ivy panties"), and several versions have
 * collision suffixes from repeated installs of one version.
 */
const REAL_PROFILES = [
  { id: "23ac02e8", name: "ivy - 2 (Event Horizon v1.0.10) (2)", gameId: "fallout4" },
  { id: "2be7648d", name: "ivy - 2 (Event Horizon v1.0.11) (5)", gameId: "fallout4" },
  { id: "36d86b22", name: "ivy panties (Event Horizon v1.0.13) (2)", gameId: "fallout4" },
  { id: "3d734eb4", name: "ivy - 2 (Event Horizon v1.0.9) (3)", gameId: "fallout4" },
  { id: "5161ae68", name: "ivy - 2 (Event Horizon v1.0.9)", gameId: "fallout4" },
  { id: "70af33c9", name: "ivy - 2 (Event Horizon v1.0.12)", gameId: "fallout4" },
  { id: "7snMynD21", name: "Default", gameId: "fallout4" },
  { id: "a9dd28e0", name: "ivy - 2 (Event Horizon v1.0.12) (2)", gameId: "fallout4" },
  { id: "c6df5ae3", name: "ivy panties (Event Horizon v1.0.13)", gameId: "fallout4" },
  { id: "af5a786a", name: "ivy panties (Event Horizon v1.0.28)", gameId: "fallout4" },
];

/** The run that just finished: v1.0.28, into af5a786a. */
const JUST_INSTALLED = "af5a786a";

const offer = (over: Partial<Parameters<typeof supersededEhProfiles>[0]> = {}) =>
  supersededEhProfiles({
    profiles: REAL_PROFILES,
    gameId: "fallout4",
    packageName: "ivy panties",
    keepProfileId: JUST_INSTALLED,
    ...over,
  });

describe("which profiles an install offers to clean up", () => {
  it("offers this collection's older profiles", () => {
    expect(offer().map((p) => p.id).sort()).toEqual(["36d86b22", "c6df5ae3"]);
  });

  it("never offers the profile the install just landed in", () => {
    // Deleting it would throw away the collection the run existed to install.
    expect(offer().map((p) => p.id)).not.toContain(JUST_INSTALLED);
  });

  it("never offers the profile Vortex is on, or the game's last-active one", () => {
    expect(
      offer({ activeProfileId: "36d86b22" }).map((p) => p.id),
    ).toEqual(["c6df5ae3"]);
    expect(
      offer({ lastActiveProfileId: "c6df5ae3" }).map((p) => p.id),
    ).toEqual(["36d86b22"]);
  });

  it("leaves a renamed collection's older profiles alone", () => {
    // "ivy - 2" is the same collection under its old name, and there are six
    // of them. Offering them would mean matching on something other than the
    // name, and the name is the only evidence there is. Missing them costs a
    // line in a list; guessing wrong costs the user a setup.
    expect(offer().map((p) => p.name).join(" ")).not.toContain("ivy - 2");
  });

  it("never offers a profile that is not this collection's", () => {
    expect(offer().map((p) => p.name)).not.toContain("Default");
  });

  it("does not match a profile the user renamed", () => {
    const mine = {
      id: "mine",
      name: "ivy panties (Event Horizon v1.0.13) - my tweaks",
      gameId: "fallout4",
    };
    expect(
      offer({ profiles: [...REAL_PROFILES, mine] }).map((p) => p.id),
    ).not.toContain("mine");
  });

  it("does not match another game's profiles", () => {
    const other = {
      id: "sse",
      name: "ivy panties (Event Horizon v1.0.13)",
      gameId: "skyrimse",
    };
    expect(
      offer({ profiles: [...REAL_PROFILES, other] }).map((p) => p.id),
    ).not.toContain("sse");
  });

  it("treats a collection name containing regex characters as literal text", () => {
    // An unescaped "Ivy (2)" builds a pattern with a capture group in it, and
    // the name is the curator's to choose.
    const profiles = [
      { id: "lit", name: "Ivy (2) (Event Horizon v1.0.1)", gameId: "fallout4" },
      { id: "sneak", name: "Ivy 2 (Event Horizon v1.0.1)", gameId: "fallout4" },
    ];
    const got = supersededEhProfiles({
      profiles,
      gameId: "fallout4",
      packageName: "Ivy (2)",
      keepProfileId: "none",
    });
    expect(got.map((p) => p.id)).toEqual(["lit"]);
  });

  it("reports the version each offered profile was built for", () => {
    expect(offer().map((p) => p.version).sort()).toEqual(["1.0.13", "1.0.13"]);
  });

  it("offers nothing on a first install", () => {
    expect(
      offer({ profiles: [REAL_PROFILES[9]!], keepProfileId: JUST_INSTALLED }),
    ).toEqual([]);
  });
});

describe("reading Vortex's state", () => {
  it("reads the profiles Vortex holds", () => {
    const state = {
      persistent: {
        profiles: {
          p1: { gameId: "fallout4", name: "One" },
          p2: { gameId: "skyrimse", name: "Two" },
        },
      },
    };
    expect(readKnownProfiles(state)).toEqual([
      { id: "p1", name: "One", gameId: "fallout4" },
      { id: "p2", name: "Two", gameId: "skyrimse" },
    ]);
  });

  it("survives a state with no profiles rather than throwing", () => {
    expect(readKnownProfiles({})).toEqual([]);
    expect(readKnownProfiles(undefined)).toEqual([]);
  });

  it("sees a deployment in progress, and its absence", () => {
    // Vortex refuses to remove a profile mid-deploy; this is the same read.
    expect(
      deploymentInProgress({ session: { base: { activity: { mods: ["deployment"] } } } }),
    ).toBe(true);
    expect(
      deploymentInProgress({ session: { base: { activity: { mods: ["installing"] } } } }),
    ).toBe(false);
    expect(deploymentInProgress({})).toBe(false);
  });
});
