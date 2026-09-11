import * as path from "path";

import { describe, expect, it } from "vitest";

import type { PluginEntry } from "./pluginPool";
import {
  buildPluginRows,
  canWriteLightFlag,
  lightFlagTargets,
  pluginCapabilityFor,
  summarizePlugins,
  type PluginHeader,
} from "./pluginView";

describe("plugin capability per game, from Vortex's plugin management", () => {
  it("offers the light flag only where the game has light plugins and the bit is the one Event Horizon writes", () => {
    expect(canWriteLightFlag(pluginCapabilityFor("skyrimse"))).toBe(true);
    expect(canWriteLightFlag(pluginCapabilityFor("fallout4"))).toBe(true);
    // Vortex's gameSupport has no supportsESL for these.
    expect(canWriteLightFlag(pluginCapabilityFor("falloutnv"))).toBe(false);
    expect(canWriteLightFlag(pluginCapabilityFor("fallout3"))).toBe(false);
    expect(canWriteLightFlag(pluginCapabilityFor("skyrimvr"))).toBe(false);
    // Light plugins, but bit 0x100 — pluginFlags writes 0x200.
    expect(canWriteLightFlag(pluginCapabilityFor("starfield"))).toBe(false);
    // Not a game Vortex's plugin management knows: nothing is offered.
    expect(canWriteLightFlag(pluginCapabilityFor("cyberpunk2077"))).toBe(false);
  });

  it("takes the regular-slot limit from Vortex's counter, per game", () => {
    expect(pluginCapabilityFor("skyrimse")?.regularSlots).toBe(254);
    expect(pluginCapabilityFor("falloutnv")?.regularSlots).toBe(255);
    expect(pluginCapabilityFor("starfield")?.regularSlots).toBe(253);
    expect(pluginCapabilityFor("cyberpunk2077")).toBeUndefined();
    // A game extension's own details win, as Vortex applies them for the VR games.
    expect(pluginCapabilityFor("skyrimvr", { supportsESL: true })).toMatchObject({ lightPlugins: true, regularSlots: 254 });
  });

  it("does not count an .esl or a light bit as light in a game without light plugins", () => {
    const plugins: PluginEntry[] = [
      { name: "A.esp", modId: "a", isNative: false, enabled: true, filePath: "a" },
      { name: "B.esl", modId: "b", isNative: false, enabled: true, filePath: "b" },
    ];
    const headers = new Map<string, PluginHeader>([
      ["A.esp", { masters: [], flags: { isLight: true, isMaster: false } }],
      ["B.esl", { masters: [], flags: { isLight: false, isMaster: false } }],
    ]);
    const fnv = pluginCapabilityFor("falloutnv");
    const rows = buildPluginRows({ plugins, headers, mods: [], isBaseGame: () => false, capability: fnv });
    expect(rows.map((r) => r.takesSlot)).toEqual([true, true]);
    const s = summarizePlugins(rows, true, fnv);
    expect(s).toMatchObject({ slotsUsed: 2, slotLimit: 255, light: 0, lightKnown: true });

    // Starfield: the header reader's bit is the wrong one, so light is unknown.
    const sf = pluginCapabilityFor("starfield");
    const sfRows = buildPluginRows({ plugins, headers, mods: [], isBaseGame: () => false, capability: sf });
    expect(sfRows[0]!.isLight).toBeUndefined();
    expect(summarizePlugins(sfRows, true, sf)).toMatchObject({ slotLimit: 253, lightKnown: false });

    // An unknown game claims no limit.
    expect(summarizePlugins(rows, true, undefined).slotLimit).toBeUndefined();
  });
});

describe("lightFlagTargets", () => {
  it("writes one file once when the listed copy is the staging copy, whatever the separators", () => {
    const dir = path.join("staging", "Some Mod");
    const listed = path.join(dir, "Plugin.esp");
    expect(lightFlagTargets(listed, dir + path.sep, "Plugin.esp")).toEqual([listed]);
  });

  it("writes both copies when they are different files", () => {
    const listed = path.join("game", "Data", "Plugin.esp");
    const staging = path.join("staging", "Some Mod");
    expect(lightFlagTargets(listed, staging, "Plugin.esp")).toEqual([listed, path.join(staging, "Plugin.esp")]);
    expect(lightFlagTargets(undefined, staging, "Plugin.esp")).toEqual([path.join(staging, "Plugin.esp")]);
  });
});
