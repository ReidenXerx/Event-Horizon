import { describe, expect, it } from "vitest";
import { modsToSwitchOff } from "./extraMods";
import { planRepairAll, REPAIR_ALL_ORDER, healNeedsConfirmation, healNeedsManifest } from "./heal";
import { evaluateHealth, type HealthObservations, type HealthReceiptView } from "./health";

// ilhamitaa24, 2026-11-06: "Make it work" added 8 mods to Ivy's profile and re-installed 2 of Ivy's own.
const receipt = {
  mods: [{ vortexModId: "ivy-auto-revolver", compareKey: "nexus:84621:337167", name: ".44 Auto-Revolver" }],
  retiredMods: [{ vortexModId: "old-ivy-mod", retiredInVersion: "1.0.50" }],
};
const pool = [
  { vortexModId: "ivy-auto-revolver", name: ".44 Auto-Revolver", modId: 84621 },
  { vortexModId: "mac11", name: ".38 Machine Pistol", modId: 80048 },
  { vortexModId: "deagle", name: ".44 Magnum Pistol", modId: 77853 },
  { vortexModId: "revolver-4k", name: ".44 Auto-Revolver 4k", modId: 84621 },
  { vortexModId: "ally-mod", name: "Ally's mod", modId: 1 },
  { vortexModId: "old-ivy-mod", name: "Old Ivy mod", modId: 2 },
  { vortexModId: "ivy-collection", name: "Ivy's Hard Reset", modType: "collection" },
];

describe("modsToSwitchOff", () => {
  it("switches off extra and curator-dropped mods, and nothing a collection or the player's own version owns", () => {
    const off = modsToSwitchOff({
      receipt,
      otherCollectionModIds: ["ally-mod"],
      pool,
      enabled: new Set(["ivy-auto-revolver", "mac11", "deagle", "revolver-4k", "ally-mod", "old-ivy-mod", "ivy-collection", "gone"]),
    });
    // By name: ".38 Machine Pistol", ".44 Magnum Pistol", "Old Ivy mod".
    expect(off.map((m) => m.vortexModId)).toEqual(["mac11", "deagle", "old-ivy-mod"]);
  });

  it("finds nothing when only the collection's mods are on", () => {
    expect(modsToSwitchOff({ receipt, otherCollectionModIds: [], pool, enabled: new Set(["ivy-auto-revolver"]) })).toEqual([]);
  });
});

describe("Repair all and extra mods", () => {
  it("switches them off before the rules and the deploy, without a dialog or the package", () => {
    const order = [...REPAIR_ALL_ORDER];
    expect(order.indexOf("disable-extra-mods")).toBeLessThan(order.indexOf("reapply-rules"));
    expect(order.indexOf("disable-extra-mods")).toBeLessThan(order.indexOf("redeploy-winners"));
    expect(healNeedsConfirmation("disable-extra-mods")).toBe(false);
    expect(healNeedsManifest("disable-extra-mods")).toBe(false);
    const plan = planRepairAll(
      [{ id: "extra-mods", status: "drifted", heal: { action: "disable-extra-mods" } }],
      () => undefined,
    );
    expect(plan).toEqual([{ action: "disable-extra-mods", checkId: "extra-mods" }]);
  });
});

describe("the extra-mods check", () => {
  const view: HealthReceiptView = { packageName: "Ivy", packageVersion: "1.0.57", vortexProfileId: "p1", ...receipt };
  const obs = (more: Partial<HealthObservations>): HealthObservations => ({
    existingProfileIds: ["p1"],
    activeProfileId: "p1",
    installedModIds: pool.map((m) => m.vortexModId),
    enabledModIds: ["ivy-auto-revolver", "mac11"],
    poolNexus: pool,
    driftedCompareKeys: undefined,
    currentPluginOrder: undefined,
    ...more,
  }) as HealthObservations;
  const card = (o: HealthObservations) => evaluateHealth(view, o).find((c) => c.id === "extra-mods");

  it("offers to switch off a mod the collection does not have", () => {
    const c = card(obs({}));
    expect(c?.status).toBe("drifted");
    expect(c?.heal?.action).toBe("disable-extra-mods");
    expect(c?.detail.join(" ")).toContain(".38 Machine Pistol");
  });

  it("stands down in a curator's build profile (Fallout-collection, 2026-11-06: queued Rev 28 mods)", () => {
    const c = card(obs({ buildSourceOf: "Ivy's Hard Reset" }));
    expect(c?.status).toBe("not-applicable");
    expect(c?.heal).toBeUndefined();
  });
});
