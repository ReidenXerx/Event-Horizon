import { describe, expect, it } from "vitest";

import { describeOrphanedPlugins, findOrphanedPlugins, type PluginForMasterCheck } from "./missingMasterPlugins";

const p = (name: string, masters: string[] | undefined, extra: Partial<PluginForMasterCheck> = {}): PluginForMasterCheck => ({
  name,
  enabled: true,
  masters,
  fromCollection: true,
  ...extra,
});

describe("plugins left without their masters after an update (Meridia 1.0.25, 2026-10-02)", () => {
  it("switches off the leftover COTN patch once COTN is gone", () => {
    const found = findOrphanedPlugins([
      p("Skyrim.esm", [], { isNative: true }),
      p("Regional Merchants.esp", ["Skyrim.esm"]),
      p("Regional Merchants - COTN Dawnstar.esp", ["Skyrim.esm", "COTN - Dawnstar.esp"]),
      p("COTN - Dawnstar.esp", ["Skyrim.esm"], { enabled: false }),
    ]);
    expect(found).toEqual([{ name: "Regional Merchants - COTN Dawnstar.esp", missing: ["COTN - Dawnstar.esp"], disabled: true }]);
  });

  it("follows the chain: a patch of the orphaned patch goes too", () => {
    const found = findOrphanedPlugins([
      p("Skyrim.esm", [], { isNative: true }),
      p("Patch.esp", ["Skyrim.esm", "Gone.esp"]),
      p("PatchOfPatch.esp", ["Skyrim.esm", "Patch.esp"]),
    ]);
    expect(found.map((f) => f.name)).toEqual(["Patch.esp", "PatchOfPatch.esp"]);
  });

  it("never switches off the player's own plugin, only reports it", () => {
    const found = findOrphanedPlugins([p("Mine.esp", ["Gone.esp"], { fromCollection: false })]);
    expect(found).toEqual([{ name: "Mine.esp", missing: ["Gone.esp"], disabled: false }]);
    expect(describeOrphanedPlugins(found)[0]).toMatch(/one of your own mods/);
  });

  it("leaves alone what is fine, disabled, or unreadable — case-blind", () => {
    expect(
      findOrphanedPlugins([
        p("skyrim.esm", [], { isNative: true }),
        p("Fine.esp", ["SKYRIM.ESM"]),
        p("Off.esp", ["Gone.esp"], { enabled: false }),
        p("Unread.esp", undefined),
      ]),
    ).toEqual([]);
  });
});

describe("the driver runs the check after the plugin order is set", () => {
  it("disables only what the check marked, and hands the lines to the Done screen", async () => {
    const fs = await import("fs");
    const path = await import("path");
    const src = fs.readFileSync(path.join(__dirname, "runInstall.ts"), "utf8");
    const at = src.indexOf('"plugins.missing-masters"');
    expect(at).toBeGreaterThan(-1);
    const scope = src.slice(Math.max(0, at - 2400), at);
    expect(scope).toContain("for (const o of orphans.filter((x) => x.disabled))");
    expect(scope).toContain("fromCollection: p.modId !== undefined && ours.has(p.modId)");
    // After the order pin, before the final sweep.
    expect(at).toBeGreaterThan(src.indexOf('"plugins.order-drift"'));
    expect(src.match(/missingMasterNotice: missingMasterNotes/g)?.length).toBe(2);
  });
});
