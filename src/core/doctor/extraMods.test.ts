import { describe, expect, it } from "vitest";
import { findExtraMods } from "./extraMods";
import { planRepairAll, REPAIR_ALL_ORDER, healNeedsConfirmation, healNeedsManifest } from "./heal";

// ilhamitaa24, 2026-11-06: "Make it work" added 8 mods to Ivy's profile and re-installed 2 of Ivy's own.
const pool = [
  { vortexModId: "ivy-auto-revolver", name: ".44 Auto-Revolver" },
  { vortexModId: "mac11", name: ".38 Machine Pistol" },
  { vortexModId: "deagle", name: ".44 Magnum Pistol" },
  { vortexModId: "my-4k", name: "My 4k textures" },
  { vortexModId: "ivy-collection", name: "Ivy's Hard Reset", modType: "collection" },
];

describe("findExtraMods", () => {
  it("lists only enabled mods the collection does not have", () => {
    const extra = findExtraMods({
      collectionModIds: new Set(["ivy-auto-revolver"]),
      enabled: new Set(["ivy-auto-revolver", "mac11", "deagle", "my-4k", "ivy-collection", "gone"]),
      pool,
      variantModIds: new Set(["my-4k"]),
    });
    // Not the collection's own mod (even freshly re-installed), not the player's version of one,
    // not Vortex's collection entry, not an id enabled in the profile with no mod behind it.
    expect(extra.map((m) => m.vortexModId)).toEqual(["mac11", "deagle"]);
  });

  it("finds nothing when only the collection's mods are on", () => {
    expect(
      findExtraMods({ collectionModIds: new Set(["mac11"]), enabled: new Set(["mac11"]), pool, variantModIds: new Set() }),
    ).toEqual([]);
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
