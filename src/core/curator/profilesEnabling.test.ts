/**
 * "Uninstall it" on an orphan calls Vortex's game-scoped `removeMods`, so it
 * takes the mod out of every profile the player has (NS-3: a mod lives in one
 * pool per game; a profile only records which are enabled). The prompt said
 * "Destructive" and never said that, so a player who reads "orphaned" as "no
 * longer part of this collection" was not agreeing to what happened.
 */
import { describe, expect, it } from "vitest";

import { profilesEnabling } from "./profilesEnabling";

const state = (profiles: Record<string, unknown>) => ({
  persistent: { profiles },
});

describe("which profiles have this mod switched on", () => {
  it("names the player's own profile, not just the collection's", () => {
    const out = profilesEnabling({
      state: state({
        collection: {
          gameId: "skyrimse",
          name: "Meridia (Event Horizon v1.0.10)",
          modState: { "mod-1": { enabled: true } },
        },
        mine: {
          gameId: "skyrimse",
          name: "My Skyrim",
          modState: { "mod-1": { enabled: true } },
        },
      }),
      gameId: "skyrimse",
      modId: "mod-1",
      excludeProfileId: "collection",
    });
    expect(out).toEqual(["My Skyrim"]);
  });

  it("ignores a profile where the mod is switched OFF", () => {
    // Vortex writes `enabled: false` rather than deleting the entry, so
    // presence is not enablement.
    expect(
      profilesEnabling({
        state: state({
          mine: { gameId: "skyrimse", name: "My Skyrim", modState: { "mod-1": { enabled: false } } },
        }),
        gameId: "skyrimse",
        modId: "mod-1",
      }),
    ).toEqual([]);
  });

  it("ignores another game's profiles", () => {
    expect(
      profilesEnabling({
        state: state({
          fo4: { gameId: "fallout4", name: "Ivy", modState: { "mod-1": { enabled: true } } },
        }),
        gameId: "skyrimse",
        modId: "mod-1",
      }),
    ).toEqual([]);
  });

  it("falls back to the id when a profile has no name", () => {
    // Never silently dropped from a count the player is meant to weigh.
    expect(
      profilesEnabling({
        state: state({
          "abc-123": { gameId: "skyrimse", modState: { "mod-1": { enabled: true } } },
        }),
        gameId: "skyrimse",
        modId: "mod-1",
      }),
    ).toEqual(["abc-123"]);
  });

  it("survives state Vortex has not filled in", () => {
    for (const s of [undefined, null, {}, { persistent: {} }, { persistent: { profiles: null } }]) {
      expect(profilesEnabling({ state: s, gameId: "skyrimse", modId: "m" })).toEqual([]);
    }
    expect(
      profilesEnabling({
        state: state({ p: { gameId: "skyrimse" } }),
        gameId: "skyrimse",
        modId: "m",
      }),
    ).toEqual([]);
  });
});
