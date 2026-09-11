import { describe, expect, it } from "vitest";

import { livePluginList, type PluginEntry } from "./pluginPool";

describe("livePluginList", () => {
  // What the requirements read saw: Ordinator on, a plugin of a disabled mod,
  // and one of a mod that has since been enabled.
  const lastRead: PluginEntry[] = [
    { name: "Skyrim.esm", isNative: true, enabled: true, loadOrder: 0 },
    { name: "Ordinator.esp", modId: "ord", isNative: false, enabled: true, loadOrder: 5 },
    { name: "Wintersun.esp", modId: "off", isNative: false, enabled: false, fromDisabledMod: true },
    { name: "Now.esp", modId: "now", isNative: false, enabled: false, fromDisabledMod: true },
  ];

  it("takes enabled state and order from Vortex's list as it is now, not from the read", () => {
    // The curator disabled Ordinator from the Plugins view after the read.
    const live: PluginEntry[] = [
      { name: "Skyrim.esm", isNative: true, enabled: true, loadOrder: 0 },
      { name: "Ordinator.esp", modId: "ord", isNative: false, enabled: false, loadOrder: 5 },
    ];
    const out = livePluginList(live, lastRead, (id) => id === "now");
    const byName = new Map(out.map((p) => [p.name, p]));
    expect(byName.get("Ordinator.esp")!.enabled).toBe(false);
    // A disabled mod's plugin is still shown: Vortex cannot list it.
    expect(byName.get("Wintersun.esp")?.fromDisabledMod).toBe(true);
    // A mod enabled since the read is Vortex's to list now.
    expect(byName.has("Now.esp")).toBe(false);
    expect(out.map((p) => p.name)).toEqual(["Skyrim.esm", "Ordinator.esp", "Wintersun.esp"]);
  });

  it("never lists a plugin twice when Vortex has picked it up", () => {
    const live: PluginEntry[] = [{ name: "wintersun.esp", modId: "off", isNative: false, enabled: true, loadOrder: 9 }];
    expect(livePluginList(live, lastRead, () => false).filter((p) => p.name.toLowerCase() === "wintersun.esp")).toHaveLength(1);
  });

  it("is Vortex's list alone before any read", () => {
    const live: PluginEntry[] = [{ name: "A.esp", isNative: false, enabled: true }];
    expect(livePluginList(live, undefined, () => false)).toEqual(live);
  });
});
