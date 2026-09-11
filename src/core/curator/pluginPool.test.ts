import { describe, expect, it } from "vitest";

import { pluginOwners, readPluginList } from "./pluginPool";

describe("readPluginList", () => {
  const state = {
    session: {
      plugins: {
        pluginList: {
          "Skyrim.esm": { isNative: true, filePath: "C:/game/Data/Skyrim.esm" },
          "Ordinator.esp": { modId: "ord", filePath: "C:/staging/ord/Ordinator.esp" },
          "Loose.esp": { filePath: "C:/game/Data/Loose.esp" },
          "NoOrder.esp": { modId: "x" },
        },
      },
    },
    loadOrder: {
      "skyrim.esm": { enabled: true, loadOrder: 0 },
      "Ordinator.esp": { enabled: false, loadOrder: 12 },
      "Loose.esp": { enabled: "yes" },
    },
  };

  it("joins the plugin list with the load order, case-insensitively, and keeps unknowns unknown", () => {
    const list = readPluginList(state);
    expect(list.map((p) => p.name)).toEqual(["Skyrim.esm", "Ordinator.esp", "Loose.esp", "NoOrder.esp"]);
    expect(list[0]).toEqual({ name: "Skyrim.esm", isNative: true, filePath: "C:/game/Data/Skyrim.esm", enabled: true, loadOrder: 0 });
    expect(list[1]).toMatchObject({ modId: "ord", enabled: false, loadOrder: 12, isNative: false });
    // A non-boolean `enabled` is not a boolean: absent, not false.
    expect(list[2]!.enabled).toBeUndefined();
    expect(list[3]).toEqual({ name: "NoOrder.esp", isNative: false, modId: "x" });
  });

  it("returns nothing, not a throw, when the plugin extension is not loaded", () => {
    expect(readPluginList({})).toEqual([]);
    expect(readPluginList(undefined)).toEqual([]);
    expect(readPluginList({ session: { plugins: { pluginList: "nope" } } })).toEqual([]);
  });

  it("produces the owners map without inventing an owner", () => {
    expect(pluginOwners(readPluginList(state))).toEqual([
      { plugin: "Skyrim.esm" },
      { plugin: "Ordinator.esp", modId: "ord" },
      { plugin: "Loose.esp" },
      { plugin: "NoOrder.esp", modId: "x" },
    ]);
  });
});
