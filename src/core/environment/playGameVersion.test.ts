/**
 * Play stops before starting a game whose version no longer fits the active
 * collection (owner poll, 2026-09-17). A player's F4SE exited with code 1 right
 * after Steam moved Fallout 4 to next-gen, and nothing said why.
 */
import { describe, expect, it } from "vitest";

import { activeCollectionReceipt, decidePlayGameVersion } from "./playGameVersion";
import type { InstallReceipt } from "../../types/installLedger";

const decide = (installed: string | undefined, required = "1.10.163.0", policy: "exact" | "minimum" = "exact", store = "steam") =>
  decidePlayGameVersion({
    gameId: "fallout4",
    gameName: "Fallout 4",
    collectionName: "Ivy's Panties - Event Horizon",
    requirement: { required, policy },
    installed,
    store,
  });

describe("the game version at Play", () => {
  it("refuses a next-gen game for a collection built on 1.10.163, and says how to go back", () => {
    const refusal = decide("1.10.984.0");
    expect(refusal?.title).toBe("Fallout 4 is version 1.10.984.0, but Ivy's Panties - Event Horizon was built for 1.10.163.0.");
    expect(refusal?.lines.join(" ")).toMatch(/Simple Fallout 4 Downgrader/);
    expect(refusal?.lines.join(" ")).toMatch(/press Play again/);
    expect(refusal?.lines.join(" ")).not.toMatch(/re-run this install/);
    expect(refusal?.steps.join(" ")).toMatch(/Only update this game when I launch it/);
  });

  it("names the Steam update setting only for a Steam game", () => {
    expect(decide("1.10.984.0", "1.10.163.0", "exact", "gog")?.steps.join(" ")).not.toMatch(/Steam/);
  });

  it("lets the right version through, whatever its trailing zeros", () => {
    expect(decide("1.10.163.0")).toBeUndefined();
    expect(decide("1.10.163")).toBeUndefined();
  });

  it("never blocks on a version nobody could read", () => {
    expect(decide(undefined)).toBeUndefined();
    expect(decide("")).toBeUndefined();
    expect(decide("1.10.984.0", "unknown")).toBeUndefined();
  });

  it("holds a minimum requirement as a minimum", () => {
    expect(decide("1.6.1179.0", "1.6.640.0", "minimum")).toBeUndefined();
    const older = decide("1.5.97.0", "1.6.640.0", "minimum");
    expect(older?.title).toMatch(/was built for 1\.6\.640\.0 or newer/);
  });
});

const receipt = (over: Partial<InstallReceipt>): InstallReceipt =>
  ({
    schemaVersion: 1,
    packageId: "11111111-2222-4333-8444-555555555555",
    packageVersion: "1.0.32",
    packageName: "Ivy's Panties - Event Horizon",
    gameId: "fallout4",
    installedAt: "2026-09-17T00:00:00.000Z",
    vortexProfileId: "profile-new",
    vortexProfileName: "Ivy",
    installTargetMode: "fresh-profile",
    mods: [],
    gameVersion: { required: "1.10.163.0", policy: "exact" },
    ...over,
  }) as InstallReceipt;

describe("which collection Play checks", () => {
  it("takes the newest install on the profile Vortex is on, for this game", () => {
    const receipts = [
      receipt({ vortexProfileId: "profile-old", packageName: "ivy panties" }),
      receipt({ installedAt: "2026-09-16T00:00:00.000Z", packageName: "older on this profile" }),
      receipt({ packageName: "newest on this profile", installedAt: "2026-09-17T05:00:00.000Z" }),
      receipt({ gameId: "skyrimse", packageName: "other game", installedAt: "2026-09-18T00:00:00.000Z" }),
    ];
    expect(activeCollectionReceipt(receipts, "fallout4", "profile-new")?.packageName).toBe("newest on this profile");
  });

  it("checks nothing for a receipt written before versions were recorded, or with no active profile", () => {
    const { gameVersion: _dropped, ...old } = receipt({});
    expect(activeCollectionReceipt([old as InstallReceipt], "fallout4", "profile-new")).toBeUndefined();
    expect(activeCollectionReceipt([receipt({})], "fallout4", undefined)).toBeUndefined();
  });
});
