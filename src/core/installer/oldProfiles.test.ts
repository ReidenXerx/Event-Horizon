/**
 * "Remove old profiles" after a collection update: only this collection's
 * Event Horizon profiles, never the current one, and only retired mods we
 * installed that no remaining profile enables (NS-2).
 */
import { describe, expect, it } from "vitest";

import type { InstallReceipt, InstallReceiptMod } from "../../types/installLedger";
import { modsFreedBy, planOldProfiles, type OldProfileView } from "./oldProfiles";

const T1 = "2026-09-01T10:00:00.000Z";
const T2 = "2026-09-20T10:00:00.000Z";

const mod = (id: string): InstallReceiptMod =>
  ({ vortexModId: id, compareKey: `nexus:${id}`, source: "nexus", name: `Mod ${id}`, installedAt: T1, ownership: "installed" }) as InstallReceiptMod;

const retired = (id: string, installTime: string | null = T1) => ({
  vortexModId: id,
  compareKey: `nexus:${id}`,
  name: `Retired ${id}`,
  retiredInVersion: "1.0.8",
  ...(installTime !== null ? { installTime } : {}),
});

const receipt = (over: Partial<InstallReceipt> = {}): InstallReceipt =>
  ({
    schemaVersion: 1,
    packageId: "pkg-ivy",
    packageVersion: "1.0.9",
    packageName: "Ivy",
    gameId: "fallout4",
    installedAt: T1,
    vortexProfileId: "p9",
    vortexProfileName: "Ivy (Event Horizon v1.0.9)",
    installTargetMode: "fresh-profile",
    mods: [],
    ...over,
  }) as InstallReceipt;

const profile = (id: string, name: string, enabled: string[] = [], lastActivated?: number): OldProfileView => ({
  id,
  name,
  gameId: "fallout4",
  enabled: new Set(enabled),
  ...(lastActivated !== undefined ? { lastActivated } : {}),
});

const PROFILES = [
  profile("p9", "Ivy (Event Horizon v1.0.9)", ["cur"]),
  profile("p8", "Ivy (Event Horizon v1.0.8)", ["cur", "old"], 1_700_000_000_000),
  profile("p7", "Ivy (Event Horizon v1.0.7) (2)", ["old", "older"]),
  profile("mine", "Ivy (Event Horizon v1.0.6) - my tweaks", ["older"]),
  profile("other", "Meridia (Event Horizon v2.0.0)"),
];

const plan = (over: Partial<Parameters<typeof planOldProfiles>[0]> = {}) =>
  planOldProfiles({
    receipt: receipt({ mods: [mod("cur")], retiredMods: [retired("old"), retired("older")] }),
    otherReceipts: [],
    pool: { cur: { installTime: T1 }, old: { installTime: T1 }, older: { installTime: T1 } },
    profiles: PROFILES,
    ...over,
  });

describe("planOldProfiles — profiles", () => {
  it("lists only this collection's Event Horizon profiles, never the current one, a renamed one or another collection's", () => {
    const p = plan();
    expect(p.profiles.map((x) => x.id)).toEqual(["p8", "p7"]);
    expect(p.profiles[0]).toMatchObject({ version: "1.0.8", lastActivated: 1_700_000_000_000, deletable: true });
    expect(p.profiles[1]).toMatchObject({ version: "1.0.7", deletable: true });
  });

  it("lists Vortex's active and last-active profiles as not deletable, with the reason", () => {
    const p = plan({ activeProfileId: "p8", lastActiveProfileId: "p7" });
    expect(p.profiles.map((x) => [x.id, x.deletable])).toEqual([
      ["p8", false],
      ["p7", false],
    ]);
    expect(p.profiles.every((x) => (x.reason ?? "").length > 0)).toBe(true);
  });
});

describe("planOldProfiles — mods", () => {
  it("offers only retired mods we installed, never the current revision's", () => {
    expect(plan().candidates.map((m) => m.vortexModId)).toEqual(["old", "older"]);
  });

  it("leaves a retired mod whose id now holds a different installation (Vortex reuses ids)", () => {
    const p = plan({ pool: { cur: { installTime: T1 }, old: { installTime: T2 }, older: { installTime: T1 } } });
    expect(p.candidates.map((m) => m.vortexModId)).toEqual(["older"]);
  });

  it("leaves a retired mod with no recorded install time, one already gone, and one another collection uses", () => {
    const p = plan({
      receipt: receipt({ mods: [mod("cur")], retiredMods: [retired("old", null), retired("gone"), retired("older")] }),
      otherReceipts: [receipt({ packageId: "pkg-meridia", packageName: "Meridia", mods: [mod("older")] })],
    });
    expect(p.candidates).toEqual([]);
  });
});

describe("modsFreedBy", () => {
  it("frees a mod only when no remaining profile enables it — the player's own included", () => {
    const p = plan();
    expect(modsFreedBy(p, PROFILES, new Set(["p8"])).map((m) => m.vortexModId)).toEqual([]);
    expect(modsFreedBy(p, PROFILES, new Set(["p8", "p7"])).map((m) => m.vortexModId)).toEqual(["old"]);
  });

  it("keeps the mods of a profile that failed to delete", () => {
    const p = plan();
    expect(modsFreedBy(p, PROFILES, new Set(["p7"])).map((m) => m.vortexModId)).toEqual([]);
  });

  it("frees a retired mod no profile enables at all, even with nothing ticked", () => {
    const p = plan({ profiles: PROFILES.filter((x) => x.id !== "mine") });
    expect(modsFreedBy(p, PROFILES.filter((x) => x.id !== "mine"), new Set(["p7"])).map((m) => m.vortexModId)).toEqual([
      "older",
    ]);
  });
});
