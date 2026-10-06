/**
 * "Keep my version" (owner poll, 2026-10-06): alasdairn swapped VTAC
 * Operative Gear's 2k file for the 4k file of the same Nexus mod.
 */
import { describe, expect, it } from "vitest";

import { evaluateHealth, type HealthObservations, type HealthReceiptView } from "../doctor/health";
import { resolveInstallPlan } from "../resolver/resolveInstallPlan";
import type { EhcollManifest } from "../../types/ehcoll";
import type { InstallReceipt } from "../../types/installLedger";
import { applyPlayerVariants, findPlayerVariants, nexusIdsOfKey } from "./playerVariants";

const VTAC = "nexus:500:2000"; // the 2k file the collection uses
const pool = [
  { vortexModId: "vtac-2k", name: "VTAC 2k", modId: 500, fileId: 2000, installTime: "2026-10-01T10:00:00.000Z" },
  { vortexModId: "vtac-4k", name: "VTAC 4k", modId: 500, fileId: 4000 },
  { vortexModId: "other", name: "Other", modId: 7, fileId: 70 },
];
const receiptMods = [
  { vortexModId: "vtac-2k", compareKey: VTAC, name: "VTAC Operative Gear" },
  { vortexModId: "other", compareKey: "nexus:7:70", name: "Other" },
];

describe("findPlayerVariants", () => {
  it("offers the 4k file when the 2k one is off and the 4k one is on", () => {
    const v = findPlayerVariants({ receiptMods, pool, enabled: new Set(["vtac-4k", "other"]) });
    expect(v).toEqual([
      {
        compareKey: VTAC,
        name: "VTAC Operative Gear",
        collectionModId: "vtac-2k",
        variant: { vortexModId: "vtac-4k", name: "VTAC 4k", modId: 500, fileId: 4000 },
      },
    ]);
  });

  it("offers nothing while the collection's own file is on, or no other file of the page is", () => {
    expect(findPlayerVariants({ receiptMods, pool, enabled: new Set(["vtac-2k", "vtac-4k", "other"]) })).toEqual([]);
    expect(findPlayerVariants({ receiptMods, pool, enabled: new Set(["other"]) })).toEqual([]);
  });

  it("reads only nexus:<mod>:<file> keys", () => {
    expect(nexusIdsOfKey("nexus:500:2000")).toEqual({ modId: 500, fileId: 2000 });
    expect(nexusIdsOfKey("external:abc")).toBeUndefined();
  });
});

describe("applyPlayerVariants", () => {
  it("makes the player's file stand for the collection's, owned by the player, and retires the 2k copy", () => {
    const receipt = {
      packageId: "ivy",
      packageVersion: "1.0.40",
      mods: [
        { vortexModId: "vtac-2k", compareKey: VTAC, name: "VTAC Operative Gear", ownership: "installed", stagingSetHash: "h" },
        { vortexModId: "other", compareKey: "nexus:7:70", name: "Other", ownership: "installed" },
      ],
    } as unknown as InstallReceipt;
    const variants = findPlayerVariants({ receiptMods, pool, enabled: new Set(["vtac-4k", "other"]) });
    const out = applyPlayerVariants(receipt, variants, pool);
    expect(out.mods[0]).toEqual({ vortexModId: "vtac-4k", compareKey: VTAC, name: "VTAC Operative Gear", ownership: "adopted" });
    expect(out.mods[1]).toEqual(receipt.mods[1]);
    expect(out.retiredMods).toEqual([
      { vortexModId: "vtac-2k", compareKey: VTAC, name: "VTAC Operative Gear", retiredInVersion: "1.0.40", installTime: "2026-10-01T10:00:00.000Z" },
    ]);
  });
});

describe("the Doctor", () => {
  const receipt: HealthReceiptView = { packageName: "Ivy", packageVersion: "1.0.40", vortexProfileId: "p", mods: receiptMods };
  const obs = (enabled: string[]): HealthObservations =>
    ({
      existingProfileIds: ["p"],
      activeProfileId: "p",
      installedModIds: pool.map((m) => m.vortexModId),
      enabledModIds: enabled,
      poolNexus: pool,
    }) as HealthObservations;

  it("offers to keep the player's version, and says nothing when there is none", () => {
    const card = evaluateHealth(receipt, obs(["vtac-4k", "other"])).find((c) => c.id === "player-variants");
    expect(card?.heal?.action).toBe("keep-player-versions");
    expect(card?.detail).toEqual(['VTAC Operative Gear: you use "VTAC 4k"']);
    expect(evaluateHealth(receipt, obs(["vtac-2k", "other"])).some((c) => c.id === "player-variants")).toBe(false);
  });
});

describe("an update after the choice", () => {
  const manifest = {
    schemaVersion: 2,
    package: { id: "ivy", name: "Ivy", version: "1.0.41", createdAt: "x", author: "a", strictMissingMods: false },
    game: { id: "fallout4", version: "1.11.191", versionPolicy: "minimum" },
    vortex: { version: "2.6.0", deploymentMethod: "hardlink", requiredExtensions: [] },
    mods: [
      {
        compareKey: VTAC,
        name: "VTAC Operative Gear",
        source: { kind: "nexus", modId: 500, fileId: 2000, sha256: "c".repeat(64), archiveName: "v.7z", gameDomain: "fallout4" },
        install: { fomodSelections: [] },
        state: {},
      },
    ],
    rules: [],
    plugins: { order: [] },
    loadOrder: [],
    userlist: { plugins: [], groups: [] },
    gameIni: { files: [] },
    externalDependencies: [],
    iniTweaks: [],
  } as unknown as EhcollManifest;
  const decide = (variantChoices?: Map<string, { nexusModId: number; nexusFileId: number }>) =>
    resolveInstallPlan(
      manifest,
      {
        gameId: "fallout4",
        gameVersion: "1.11.191",
        vortexVersion: "2.6.0",
        deploymentMethod: "hardlink",
        enabledExtensions: [],
        activeProfileId: "p",
        activeProfileName: "P",
        installedMods: [{ id: "vtac-4k", name: "VTAC 4k", nexusModId: 500, nexusFileId: 4000 }],
        availableDownloads: [],
        externalDependencyState: undefined,
        ...(variantChoices !== undefined ? { variantChoices } : {}),
      } as never,
      { kind: "fresh-profile", profileName: "Ivy 1.0.41" } as never,
    );

  it("keeps the player's file in a fresh profile, asking nothing", () => {
    const plan = decide(new Map([[VTAC, { nexusModId: 500, nexusFileId: 4000 }]]));
    expect(plan.modResolutions[0]!.decision).toMatchObject({
      kind: "nexus-version-diverged",
      existingModId: "vtac-4k",
      recommendation: "player-variant",
    });
    expect(plan.summary.needsUserConfirmation).toBe(0);
  });

  it("downloads the collection's file without a remembered choice", () => {
    expect(decide().modResolutions[0]!.decision.kind).toBe("nexus-download");
  });
});
