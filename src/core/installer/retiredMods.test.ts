/**
 * The receipt remembers mods earlier revisions installed and later ones
 * dropped, so uninstall can still reach them. Only mods proven ours, only
 * while they are still in the pool, and only while the installation under
 * the id is still the one we recorded (Vortex reuses ids).
 */
import { describe, expect, it } from "vitest";

import type { InstallReceiptMod, InstallReceiptRetiredMod } from "../../types/installLedger";
import { carryRetiredMods, installTimeMs } from "./retiredMods";

const T1 = Date.parse("2026-09-01T10:00:00.000Z");
const T2 = Date.parse("2026-09-20T10:00:00.000Z");

const mod = (id: string, ownership?: "installed" | "adopted"): InstallReceiptMod =>
  ({
    vortexModId: id,
    compareKey: `nexus:${id}`,
    source: "nexus",
    name: `Mod ${id}`,
    installedAt: "2026-09-01T10:00:00.000Z",
    ...(ownership !== undefined ? { ownership } : {}),
  }) as InstallReceiptMod;

const carry = (args: Partial<Parameters<typeof carryRetiredMods>[0]>) =>
  carryRetiredMods({
    previousMods: [],
    previousRetired: [],
    currentModIds: new Set(),
    newVersion: "1.0.34",
    liveInstallTime: () => T1,
    ...args,
  });

describe("carryRetiredMods", () => {
  it("retires a mod we installed that the new revision dropped, stamped with the dropping version and its install time", () => {
    const out = carry({ previousMods: [mod("a", "installed"), mod("b", "installed")], currentModIds: new Set(["b"]) });
    expect(out).toEqual([
      { vortexModId: "a", compareKey: "nexus:a", name: "Mod a", retiredInVersion: "1.0.34", installTime: new Date(T1).toISOString() },
    ]);
  });

  it("never retires a mod the player already had, or one whose ownership was never recorded (NS-2)", () => {
    expect(carry({ previousMods: [mod("a", "adopted"), mod("b")] })).toEqual([]);
  });

  it("carries earlier retirements forward, so a mod dropped five revisions ago is still known", () => {
    const earlier: InstallReceiptRetiredMod = {
      vortexModId: "old",
      compareKey: "nexus:old",
      name: "Old",
      retiredInVersion: "1.0.29",
      installTime: new Date(T1).toISOString(),
    };
    expect(carry({ previousRetired: [earlier] })).toEqual([earlier]);
  });

  it("forgets a retired mod that came back into the collection, or that the player removed", () => {
    const earlier: InstallReceiptRetiredMod = { vortexModId: "old", compareKey: "k", name: "Old", retiredInVersion: "1", installTime: new Date(T1).toISOString() };
    expect(carry({ previousRetired: [earlier], currentModIds: new Set(["old"]) })).toEqual([]);
    expect(carry({ previousRetired: [earlier], liveInstallTime: () => undefined })).toEqual([]);
    expect(carry({ previousMods: [mod("a", "installed")], liveInstallTime: () => undefined })).toEqual([]);
  });

  // Vortex reuses mod ids: the player deleted ours and installed their own copy of the same file.
  it("forgets a retired mod whose id now holds a different installation", () => {
    const earlier: InstallReceiptRetiredMod = { vortexModId: "old", compareKey: "k", name: "Old", retiredInVersion: "1", installTime: new Date(T1).toISOString() };
    expect(carry({ previousRetired: [earlier], liveInstallTime: () => T2 })).toEqual([]);
  });

  it("carries a live mod with an unreadable install time without one, so uninstall will leave it alone", () => {
    const out = carry({ previousMods: [mod("a", "installed")], liveInstallTime: () => Number.NaN });
    expect(out).toHaveLength(1);
    expect("installTime" in out[0]!).toBe(false);
  });

  it("reads Vortex's installTime in every shape it comes in", () => {
    expect(installTimeMs(new Date(T1))).toBe(T1);
    expect(installTimeMs(new Date(T1).toISOString())).toBe(T1);
    expect(installTimeMs(T1)).toBe(T1);
    expect(installTimeMs(undefined)).toBeUndefined();
    expect(installTimeMs("not a date")).toBeUndefined();
  });
});
