import { describe, expect, it } from "vitest";

import { pluginOwners, readPluginList } from "./pluginPool";

describe("readPluginList", () => {
  const state = {
    session: {
      plugins: {
        pluginList: {
          // Vortex keys the list by the LOWERCASED name and never writes a
          // native plugin into loadOrder.
          "skyrim.esm": { isNative: true, filePath: "C:/game/Data/Skyrim.esm" },
          "ordinator.esp": { modId: "ord", filePath: "C:/staging/ord/Ordinator.esp" },
          "loose.esp": { filePath: "C:/game/Data/Loose.esp" },
          "noorder.esp": { modId: "x" },
        },
      },
    },
    loadOrder: {
      "ordinator.esp": { enabled: false, loadOrder: 12, name: "Ordinator.esp" },
      "loose.esp": { enabled: "yes", name: "Loose.esp" },
    },
  };

  it("joins the plugin list with the load order and applies Vortex's enabled rule", () => {
    const list = readPluginList(state);
    // Natives are enabled without a loadOrder entry; the original case comes
    // from loadOrder when there is one, else the key as Vortex stored it.
    expect(list.map((p) => p.name)).toEqual(["Ordinator.esp", "Loose.esp", "noorder.esp", "skyrim.esm"]);
    expect(list[3]).toEqual({ name: "skyrim.esm", isNative: true, filePath: "C:/game/Data/Skyrim.esm", enabled: true });
    expect(list[0]).toMatchObject({ modId: "ord", enabled: false, loadOrder: 12, isNative: false });
    // A non-boolean `enabled` is not "on": to the game that plugin is off.
    expect(list[1]!.enabled).toBe(false);
    expect(list[2]).toEqual({ name: "noorder.esp", isNative: false, modId: "x", enabled: false });
  });

  it("returns nothing, not a throw, when the plugin extension is not loaded", () => {
    expect(readPluginList({})).toEqual([]);
    expect(readPluginList(undefined)).toEqual([]);
    expect(readPluginList({ session: { plugins: { pluginList: "nope" } } })).toEqual([]);
  });

  it("produces the owners map without inventing an owner", () => {
    expect(pluginOwners(readPluginList(state))).toEqual([
      { plugin: "Ordinator.esp", modId: "ord" },
      { plugin: "Loose.esp" },
      { plugin: "noorder.esp", modId: "x" },
      { plugin: "skyrim.esm", native: true },
    ]);
  });
});
