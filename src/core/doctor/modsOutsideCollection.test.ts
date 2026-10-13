import { describe, expect, it } from "vitest";

import { describeModsOutsideCollection, modsOutsideCollection } from "./modsOutsideCollection";
import type { InstallReceipt } from "../../types/installLedger";

const rmod = (vortexModId: string, compareKey: string, name: string) =>
  ({ vortexModId, compareKey, source: "nexus", name, installedAt: "t" }) as InstallReceipt["mods"][number];

const receipt = {
  mods: [rmod("ours-1", "nexus:100:1", "Collection Mod"), rmod("ours-2", "external:abc", "Bundled Patch")],
  retiredMods: [{ vortexModId: "old-1", compareKey: "nexus:300:3", name: "Old Mod", retiredInVersion: "1.0.20" }],
};

const mods = {
  "ours-1": { attributes: { modId: 100, logicalFileName: "Collection Mod" } },
  "ours-2": { attributes: {} },
  "kept-1": { attributes: { modId: 100, customFileName: "Collection Mod 2.0" } },
  "extra-b": { attributes: { modId: 555, logicalFileName: "Zeta Leftover" } },
  "extra-a": { attributes: { name: "alpha manual" } },
  "old-1": { attributes: { modId: 300, logicalFileName: "Old Mod" } },
  "off-1": { attributes: { modId: 777, logicalFileName: "Disabled One" } },
  "other-coll": { attributes: { modId: 900, logicalFileName: "Ally Mod" } },
  "coll-entry": { type: "collection", attributes: { name: "Meridia" } },
};

const on = { enabled: true };
const modState = {
  "ours-1": on,
  "ours-2": on,
  "kept-1": on,
  "extra-b": on,
  "extra-a": on,
  "old-1": on,
  "off-1": { enabled: false },
  "other-coll": on,
  "coll-entry": on,
  "gone-from-pool": on,
};

describe("mods outside the collection", () => {
  const found = modsOutsideCollection({
    receipt,
    otherReceipts: [{ mods: [rmod("other-coll", "nexus:900:9", "Ally Mod")] }],
    mods,
    modState,
  });

  it("lists enabled mods the collection did not install, by name", () => {
    expect(found.extra.map((m) => m.name)).toEqual(["alpha manual", "Zeta Leftover"]);
    expect(found.extra[1]!.nexusModId).toBe(555);
  });

  it("names another file of a collection mod's page beside the collection's own", () => {
    expect(found.otherFiles).toEqual([
      { vortexModId: "kept-1", name: "Collection Mod 2.0", nexusModId: 100, collectionMod: "Collection Mod" },
    ]);
  });

  it("names mods the curator dropped that are still enabled", () => {
    expect(found.dropped).toEqual([{ vortexModId: "old-1", name: "Old Mod", droppedIn: "1.0.20" }]);
  });

  it("leaves out disabled mods, other collections' mods, the collection entry and mods gone from Vortex", () => {
    const all = [...found.extra, ...found.otherFiles, ...found.dropped].map((m) => m.vortexModId);
    for (const id of ["off-1", "other-coll", "coll-entry", "gone-from-pool", "ours-1", "ours-2"]) expect(all).not.toContain(id);
  });

  it("copies as plain text with Nexus ids", () => {
    const text = describeModsOutsideCollection("Meridia", found);
    expect(text).toContain("Not in the collection (2):");
    expect(text).toContain("- Zeta Leftover (Nexus 555)");
    expect(text).toContain("- Collection Mod 2.0 (Nexus 100), collection has Collection Mod");
    expect(text).toContain("- Old Mod, dropped in 1.0.20");
  });
});
