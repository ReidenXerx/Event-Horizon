/**
 * What "Uninstall this collection" removes and keeps. The rule the player
 * sees: every mod Event Horizon installed for it, in any revision, except
 * the ones another collection or the player's own profile still uses. Never
 * a mod the player already had (NS-2).
 */
import { describe, expect, it } from "vitest";

import type { InstallReceipt, InstallReceiptMod } from "../../types/installLedger";
import { planCollectionUninstall, type UninstallProfileView } from "./collectionUninstall";

const T1 = "2026-09-01T10:00:00.000Z";

const mod = (id: string, ownership?: "installed" | "adopted", extra: Partial<InstallReceiptMod> = {}): InstallReceiptMod =>
  ({
    vortexModId: id,
    compareKey: `nexus:${id}`,
    source: "nexus",
    name: `Mod ${id}`,
    installedAt: T1,
    ...(ownership !== undefined ? { ownership } : {}),
    ...extra,
  }) as InstallReceiptMod;

const receipt = (over: Partial<InstallReceipt> = {}): InstallReceipt =>
  ({
    schemaVersion: 1,
    packageId: "pkg-ivy",
    packageVersion: "1.0.34",
    packageName: "Ivy",
    gameId: "fallout4",
    installedAt: T1,
    vortexProfileId: "p-ivy-34",
    vortexProfileName: "Ivy (Event Horizon v1.0.34)",
    installTargetMode: "fresh-profile",
    mods: [],
    ...over,
  }) as InstallReceipt;

const profile = (id: string, name: string, enabled: string[] = []): UninstallProfileView => ({
  id,
  name,
  gameId: "fallout4",
  enabled: new Set(enabled),
});

const plan = (args: Partial<Parameters<typeof planCollectionUninstall>[0]> & { receipt: InstallReceipt }) =>
  planCollectionUninstall({
    otherReceipts: [],
    pool: {},
    profiles: [],
    ...args,
  });

describe("planCollectionUninstall — mods", () => {
  it("removes the mods we installed and counts the ones the player already had", () => {
    const p = plan({
      receipt: receipt({ mods: [mod("a", "installed"), mod("b", "adopted"), mod("c")] }),
      pool: { a: {}, b: {}, c: {} },
    });
    expect(p.remove.map((m) => m.vortexModId)).toEqual(["a"]);
    expect(p.notOursCount).toBe(2);
  });

  it("reaches mods earlier revisions installed, while the recorded installation is still the one in the pool", () => {
    const p = plan({
      receipt: receipt({
        retiredMods: [
          { vortexModId: "old", compareKey: "k1", name: "Old", retiredInVersion: "1.0.33", installTime: T1 },
          { vortexModId: "reinstalled", compareKey: "k2", name: "Reinstalled", retiredInVersion: "1.0.33", installTime: T1 },
          { vortexModId: "untimed", compareKey: "k3", name: "Untimed", retiredInVersion: "1.0.33" },
        ],
      }),
      pool: { old: { installTime: T1 }, reinstalled: { installTime: "2026-09-20T10:00:00.000Z" }, untimed: { installTime: T1 } },
    });
    expect(p.remove).toEqual([{ vortexModId: "old", name: "Old", from: "retired" }]);
    expect(p.keep.map((k) => [k.vortexModId, k.reason.kind])).toEqual([
      ["reinstalled", "unproven"],
      ["untimed", "unproven"],
    ]);
  });

  it("counts, and does not list, ours that the player has removed already", () => {
    const p = plan({ receipt: receipt({ mods: [mod("gone", "installed")] }), pool: {} });
    expect(p.remove).toEqual([]);
    expect(p.alreadyGoneCount).toBe(1);
  });

  it("keeps a mod another installed collection still uses, naming it", () => {
    const other = receipt({ packageId: "pkg-meridia", packageName: "Other FO4 List", mods: [mod("shared", "adopted")] });
    const p = plan({ receipt: receipt({ mods: [mod("shared", "installed")] }), otherReceipts: [other], pool: { shared: {} } });
    expect(p.keep).toEqual([{ vortexModId: "shared", name: "Mod shared", reason: { kind: "other-collection", collections: ["Other FO4 List"] } }]);
  });

  it("ignores another collection for a different game", () => {
    const other = receipt({ packageId: "pkg-x", packageName: "Skyrim One", gameId: "skyrimse", mods: [mod("a", "installed")] });
    const p = plan({ receipt: receipt({ mods: [mod("a", "installed")] }), otherReceipts: [other], pool: { a: {} } });
    expect(p.remove.map((m) => m.vortexModId)).toEqual(["a"]);
  });

  it("keeps a mod the player enabled in one of their own profiles, but not for being enabled in the collection's", () => {
    const p = plan({
      receipt: receipt({ mods: [mod("liked", "installed"), mod("plain", "installed")] }),
      pool: { liked: {}, plain: {} },
      profiles: [
        profile("p-ivy-34", "Ivy (Event Horizon v1.0.34)", ["liked", "plain"]),
        profile("p-ivy-33", "Ivy (Event Horizon v1.0.33)", ["plain"]),
        profile("p-mine", "My Playthrough", ["liked"]),
      ],
    });
    expect(p.remove.map((m) => m.vortexModId)).toEqual(["plain"]);
    expect(p.keep).toEqual([{ vortexModId: "liked", name: "Mod liked", reason: { kind: "your-profile", profiles: ["My Playthrough"] } }]);
  });

  it("does not keep a mod for being enabled in the player's profile the collection was installed INTO", () => {
    const p = plan({
      receipt: receipt({ installTargetMode: "current-profile", vortexProfileId: "p-mine", vortexProfileName: "My Playthrough", mods: [mod("a", "installed")] }),
      pool: { a: {} },
      profiles: [profile("p-mine", "My Playthrough", ["a"])],
    });
    expect(p.remove.map((m) => m.vortexModId)).toEqual(["a"]);
  });
});

describe("planCollectionUninstall — profiles", () => {
  const profiles = [
    profile("p-ivy-34", "Ivy (Event Horizon v1.0.34)"),
    profile("p-ivy-33", "Ivy (Event Horizon v1.0.33)"),
    profile("p-ivy-33b", "Ivy (Event Horizon v1.0.33) (2)"),
    profile("p-renamed", "Ivy (Event Horizon v1.0.30) - my tweaks"),
    profile("p-other", "Ivy Remix (Event Horizon v1.0.1)"),
    profile("p-mine", "My Playthrough"),
  ];

  it("offers every profile an install of this collection created, and no other", () => {
    const p = plan({ receipt: receipt(), profiles });
    expect(p.profiles.map((x) => x.id).sort()).toEqual(["p-ivy-33", "p-ivy-33b", "p-ivy-34"]);
    expect(p.profiles.every((x) => x.deletable)).toBe(true);
  });

  it("will not delete the active or last-active profile, and says why", () => {
    const p = plan({ receipt: receipt(), profiles, activeProfileId: "p-ivy-34", lastActiveProfileId: "p-ivy-33" });
    const byId = Object.fromEntries(p.profiles.map((x) => [x.id, x]));
    expect(byId["p-ivy-34"]).toMatchObject({ deletable: false, reason: expect.stringMatching(/using it right now/) });
    expect(byId["p-ivy-33"]).toMatchObject({ deletable: false, reason: expect.stringMatching(/last profile/) });
    expect(byId["p-ivy-33b"]!.deletable).toBe(true);
  });

  it("never offers the player's own profile a current-profile install went into", () => {
    const p = plan({
      receipt: receipt({ installTargetMode: "current-profile", vortexProfileId: "p-mine", vortexProfileName: "My Playthrough" }),
      profiles,
    });
    expect(p.profiles.some((x) => x.id === "p-mine")).toBe(false);
  });
});
