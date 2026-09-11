import { describe, expect, it } from "vitest";

import type { PluginEntry } from "./pluginPool";
import {
  buildPluginRows,
  describeMastersCell,
  describePluginKind,
  pluginRowsForView,
  pluginViewCounts,
  summarizePlugins,
  type PluginHeader,
} from "./pluginView";
import type { CuratorMod } from "./profileActions";

const mods: CuratorMod[] = [
  { id: "ord", name: "Ordinator", enabled: true, modType: "" },
  { id: "apo", name: "Apocalypse", enabled: true, modType: "" },
  { id: "off", name: "Wintersun", enabled: false, modType: "" },
];

const plugins: PluginEntry[] = [
  { name: "Skyrim.esm", isNative: true, enabled: true, loadOrder: 0 },
  { name: "Ordinator.esp", isNative: false, modId: "ord", enabled: true, loadOrder: 10, filePath: "s/ord/Ordinator.esp" },
  { name: "Wintersun.esp", isNative: false, modId: "off", enabled: false, loadOrder: 11, filePath: "s/off/Wintersun.esp" },
  { name: "Apocalypse.esp", isNative: false, modId: "apo", enabled: true, loadOrder: 12, filePath: "s/apo/Apocalypse.esp" },
  { name: "Patch.esp", isNative: false, modId: "apo", enabled: true, loadOrder: 13, filePath: "s/apo/Patch.esp" },
  { name: "Broken.esp", isNative: false, modId: "apo", enabled: true, loadOrder: 14, filePath: "s/apo/Broken.esp" },
];

const headers = new Map<string, PluginHeader>([
  ["Skyrim.esm", { masters: [], flags: { isLight: false, isMaster: true } }],
  ["Ordinator.esp", { masters: ["Skyrim.esm", "Update.esm"], flags: { isLight: false, isMaster: false } }],
  ["Wintersun.esp", { masters: ["Skyrim.esm"], flags: { isLight: false, isMaster: false } }],
  // Case differs from the list on purpose: headers name masters as the
  // author typed them, and the game does not care.
  ["Apocalypse.esp", { masters: ["skyrim.esm", "ORDINATOR.esp"], flags: { isLight: true, isMaster: false } }],
  ["Patch.esp", { masters: ["Wintersun.esp", "Gone.esm"], flags: { isLight: true, isMaster: false } }],
  ["Broken.esp", { unreadable: "EBUSY: locked" }],
]);

const isBaseGame = (m: string): boolean => /^(skyrim|update)\.esm$/i.test(m);

describe("plugin rows", () => {
  const rows = buildPluginRows({ plugins, headers, mods, isBaseGame });
  const byName = new Map(rows.map((r) => [r.plugin.name, r]));

  it("resolves masters against the list, case-insensitively, and knows base-game ones", () => {
    expect(byName.get("Ordinator.esp")!.masters.map((m) => m.state)).toEqual(["ok", "ok"]);
    expect(byName.get("Ordinator.esp")!.masters[1]).toEqual({ name: "Update.esm", state: "ok", baseGame: true });
    expect(byName.get("Apocalypse.esp")!.masters.map((m) => m.state)).toEqual(["ok", "ok"]);
  });

  it("tells a missing master from a disabled one", () => {
    const patch = byName.get("Patch.esp")!;
    expect(patch.disabled).toEqual(["Wintersun.esp"]);
    expect(patch.missing).toEqual(["Gone.esm"]);
    expect(describeMastersCell(patch)).toBe("1 missing · 1 disabled");
    expect(describeMastersCell(byName.get("Ordinator.esp")!)).toBe("2 ok");
    expect(describeMastersCell(byName.get("Skyrim.esm")!)).toBe("");
  });

  it("keeps an unreadable header as a fact, not an empty list", () => {
    const broken = byName.get("Broken.esp")!;
    expect(broken.unreadable).toBe("EBUSY: locked");
    expect(broken.masters).toEqual([]);
    expect(describeMastersCell(broken)).toBe("unreadable");
    // Unknown flags: assumed to take a slot, because that is the safe count.
    expect(broken.takesSlot).toBe(true);
    expect(describePluginKind(broken)).toBe("");
  });

  it("names the owning mod and the header kind", () => {
    expect(byName.get("Ordinator.esp")!.owner?.name).toBe("Ordinator");
    expect(byName.get("Skyrim.esm")!.owner).toBeUndefined();
    expect(describePluginKind(byName.get("Skyrim.esm")!)).toBe("base game");
    expect(describePluginKind(byName.get("Apocalypse.esp")!)).toBe("light");
    expect(describePluginKind(byName.get("Ordinator.esp")!)).toBe("regular");
  });

  it("counts regular slots as enabled and not light", () => {
    const s = summarizePlugins(rows, true);
    // Skyrim.esm, Ordinator, Broken (unknown flags) take slots; Wintersun is
    // disabled; Apocalypse and Patch are light.
    expect(s.slotsUsed).toBe(3);
    expect(s.slotLimit).toBe(254);
    expect(s.light).toBe(2);
    expect(s.enabled).toBe(5);
    expect(s.withMissing).toBe(1);
    expect(s.withDisabled).toBe(1);
    expect(s.unreadable).toBe(1);
  });

  it("filters each view from the same rows", () => {
    const names = (v: Parameters<typeof pluginRowsForView>[1]): string[] =>
      pluginRowsForView(rows, v).map((r) => r.plugin.name);
    expect(names("problems")).toEqual(["Patch.esp"]);
    expect(names("regular")).toEqual(["Skyrim.esm", "Ordinator.esp", "Broken.esp"]);
    expect(names("light")).toEqual(["Apocalypse.esp", "Patch.esp"]);
    expect(names("disabled")).toEqual(["Wintersun.esp"]);
    expect(pluginViewCounts(rows).all).toBe(6);
  });

  it("is honest with no headers at all", () => {
    const bare = buildPluginRows({ plugins, headers: new Map(), mods, isBaseGame });
    expect(bare.every((r) => r.masters.length === 0 && r.isLight === undefined)).toBe(true);
    expect(summarizePlugins(bare, false).headersRead).toBe(false);
  });
});
