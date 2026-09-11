/**
 * The per-game table every plugin header reader and writer takes its bits
 * from, and the judgement that decides whether recorded light flags may be
 * written at all.
 *
 * Checked against what the installed Vortex's gamebryo-plugin-management says
 * (see the header of pluginCapability.ts for the quoted source).
 */
import { describe, expect, it } from "vitest";

import {
  LEGACY_LIGHT_FLAG_BIT,
  decodePluginFlags,
  judgeRecordedLightFlags,
  pluginCapabilityFor,
} from "./pluginCapability";

describe("the bits, per game", () => {
  it("gives Starfield 0x100 for light and 0x400 for medium, and 253 regular slots", () => {
    expect(pluginCapabilityFor("starfield")).toMatchObject({
      lightPlugins: true,
      mediumPlugins: true,
      lightFlagBit: 0x100,
      mediumFlagBit: 0x400,
      regularSlots: 253,
    });
  });

  it("gives Skyrim SE and Fallout 4 0x200, no medium, 254 slots", () => {
    for (const id of ["skyrimse", "fallout4"]) {
      expect(pluginCapabilityFor(id)).toMatchObject({
        lightFlagBit: 0x200,
        mediumFlagBit: undefined,
        regularSlots: 254,
      });
    }
  });

  it("assumes no bit for a game it does not know", () => {
    expect(pluginCapabilityFor("cyberpunk2077")).toBeUndefined();
  });

  it("decodes the same word differently in Starfield and Skyrim SE", () => {
    const sf = pluginCapabilityFor("starfield")!;
    const sse = pluginCapabilityFor("skyrimse")!;
    expect(decodePluginFlags(0x200, sf)).toEqual({ isLight: false, isMaster: false, isMedium: false });
    expect(decodePluginFlags(0x200, sse)).toEqual({ isLight: true, isMaster: false, isMedium: false });
    expect(decodePluginFlags(0x101, sf)).toEqual({ isLight: true, isMaster: true, isMedium: false });
    expect(decodePluginFlags(0x100, sse)).toEqual({ isLight: false, isMaster: false, isMedium: false });
  });
});

describe("whether recorded light flags may be written", () => {
  it("accepts values read from the game's own bit", () => {
    expect(judgeRecordedLightFlags("starfield", 0x100)).toMatchObject({ usable: true });
    expect(judgeRecordedLightFlags("skyrimse", 0x200)).toMatchObject({ usable: true });
  });

  it("treats a package without the marker as 0x200 — fine for Skyrim SE", () => {
    expect(LEGACY_LIGHT_FLAG_BIT).toBe(0x200);
    expect(judgeRecordedLightFlags("skyrimse", undefined)).toMatchObject({ usable: true });
    expect(judgeRecordedLightFlags("fallout4", undefined)).toMatchObject({ usable: true });
  });

  it("refuses a Starfield package without the marker: its values came from 0x200", () => {
    const v = judgeRecordedLightFlags("starfield", undefined);
    expect(v).toMatchObject({ usable: false, code: "bit-mismatch" });
    expect(!v.usable && v.reason).toMatch(/0x200/);
    expect(!v.usable && v.reason).toMatch(/0x100/);
    expect(!v.usable && v.reason).toMatch(/before flags were read per game/);
  });

  it("refuses any explicit bit that is not the game's", () => {
    expect(judgeRecordedLightFlags("starfield", 0x200)).toMatchObject({ usable: false, code: "bit-mismatch" });
    expect(judgeRecordedLightFlags("skyrimse", 0x100)).toMatchObject({ usable: false, code: "bit-mismatch" });
  });

  it("refuses an unknown game and a game without light plugins, saying which", () => {
    expect(judgeRecordedLightFlags("cyberpunk2077", 0x200)).toMatchObject({ usable: false, code: "unknown-game" });
    expect(judgeRecordedLightFlags("falloutnv", undefined)).toMatchObject({ usable: false, code: "no-light-plugins" });
  });
});
