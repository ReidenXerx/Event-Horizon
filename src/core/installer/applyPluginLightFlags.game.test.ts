/**
 * ──────────────────────────────────────────────────────────────────────
 * The installer writes the GAME's light bit into the user's plugins, or
 * nothing at all.
 *
 * This is the only step of an install that edits bytes inside the user's
 * game folder, and it used 0x200 for every game. On Starfield light is 0x100
 * and 0x200 is another flag — so a Starfield collection had that other flag
 * flipped on plugins Event Horizon did not write (NS-2). Real files, real
 * bytes: every assertion below reads the header back off disk.
 * ──────────────────────────────────────────────────────────────────────
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { applyPluginLightFlags, describePluginFlagRepair } from "./applyPluginLightFlags";

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "eh-apply-light-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const writePlugin = (name: string, flags: number): void => {
  const buf = Buffer.alloc(24);
  buf.write("TES4", 0, "latin1");
  buf.writeUInt32LE(12, 4);
  buf.writeUInt32LE(flags, 8);
  fs.writeFileSync(path.join(dir, name), buf);
};
const flagsOf = (name: string): number => fs.readFileSync(path.join(dir, name)).readUInt32LE(8);

describe("Starfield, with a package that records its bit", () => {
  it("sets 0x100 and leaves 0x200 — a different flag there — as it was", async () => {
    writePlugin("Outpost.esm", 0x200);
    const r = await applyPluginLightFlags({
      order: [{ name: "Outpost.esm", enabled: true, light: true }],
      dataDir: dir,
      gameId: "starfield",
      recordedLightFlagBit: 0x100,
    });
    expect(r.refused).toBeUndefined();
    expect(r).toMatchObject({ set: 1, corrected: 1, lightFlagBit: 0x100, regularLimit: 253 });
    expect(flagsOf("Outpost.esm")).toBe(0x300);
  });

  it("does not read 0x200 as light, so a regular plugin that carries it is left alone", async () => {
    // With 0x200 read as light, this plugin looked light, the manifest said
    // it is not, and the installer CLEARED 0x200 on the user's file.
    writePlugin("NotLight.esm", 0x200);
    const r = await applyPluginLightFlags({
      order: [{ name: "NotLight.esm", enabled: true, light: false }],
      dataDir: dir,
      gameId: "starfield",
      recordedLightFlagBit: 0x100,
    });
    expect(r).toMatchObject({ corrected: 0, alreadyCorrect: 1, regularAfter: 1 });
    expect(flagsOf("NotLight.esm")).toBe(0x200);
  });

  it("reads 0x100 as light, so a light plugin is already correct and takes no slot", async () => {
    writePlugin("Light.esm", 0x100);
    const r = await applyPluginLightFlags({
      order: [{ name: "Light.esm", enabled: true, light: true }],
      dataDir: dir,
      gameId: "starfield",
      recordedLightFlagBit: 0x100,
    });
    expect(r).toMatchObject({ corrected: 0, alreadyCorrect: 1, regularAfter: 0 });
    expect(flagsOf("Light.esm")).toBe(0x100);
  });

  it("does not count a medium plugin against the regular slots", async () => {
    writePlugin("Medium.esm", 0x400);
    writePlugin("Regular.esm", 0);
    const r = await applyPluginLightFlags({
      order: [
        { name: "Medium.esm", enabled: true, light: false },
        { name: "Regular.esm", enabled: true, light: false },
      ],
      dataDir: dir,
      gameId: "starfield",
      recordedLightFlagBit: 0x100,
    });
    expect(r.regularAfter).toBe(1);
    expect(flagsOf("Medium.esm")).toBe(0x400);
  });
});

describe("refusing, rather than guessing", () => {
  it("refuses a Starfield package built before flags were per game, and touches nothing", async () => {
    // The old build read 0x200 as light. Its `light: false` here means "0x200
    // was clear", which says nothing about Starfield's light bit.
    writePlugin("Outpost.esm", 0x200);
    writePlugin("Other.esm", 0x100);
    const r = await applyPluginLightFlags({
      order: [
        { name: "Outpost.esm", enabled: true, light: false },
        { name: "Other.esm", enabled: true, light: false },
      ],
      dataDir: dir,
      gameId: "starfield",
      recordedLightFlagBit: undefined,
    });
    expect(r.refused?.code).toBe("bit-mismatch");
    expect(r.corrected).toBe(0);
    expect(flagsOf("Outpost.esm")).toBe(0x200);
    expect(flagsOf("Other.esm")).toBe(0x100);
    // And the user is told, with the reason, not handed silence.
    expect((describePluginFlagRepair(r) ?? []).join(" ")).toMatch(/not applied.*0x200.*0x100/);
  });

  it("refuses a game Vortex's plugin management does not know", async () => {
    writePlugin("Mod.esp", 0);
    const r = await applyPluginLightFlags({
      order: [{ name: "Mod.esp", enabled: true, light: true }],
      dataDir: dir,
      gameId: "cyberpunk2077",
      recordedLightFlagBit: 0x200,
    });
    expect(r.refused?.code).toBe("unknown-game");
    expect(flagsOf("Mod.esp")).toBe(0);
    expect((describePluginFlagRepair(r) ?? []).join(" ")).toMatch(/will not guess/);
  });

  it("writes nothing in a game with no light plugins, and says nothing about it", async () => {
    writePlugin("Old.esp", 0);
    const r = await applyPluginLightFlags({
      order: [{ name: "Old.esp", enabled: true, light: true }],
      dataDir: dir,
      gameId: "falloutnv",
      recordedLightFlagBit: undefined,
    });
    expect(r.refused?.code).toBe("no-light-plugins");
    expect(flagsOf("Old.esp")).toBe(0);
    expect(describePluginFlagRepair(r)).toBeUndefined();
  });
});

describe("Skyrim SE is unchanged", () => {
  it("still applies 0x200 from a package that predates the marker", async () => {
    writePlugin("Heavy.esp", 0x100);
    const r = await applyPluginLightFlags({
      order: [{ name: "Heavy.esp", enabled: true, light: true }],
      dataDir: dir,
      gameId: "skyrimse",
      recordedLightFlagBit: undefined,
    });
    expect(r).toMatchObject({ set: 1, lightFlagBit: 0x200, regularLimit: 254 });
    expect(flagsOf("Heavy.esp")).toBe(0x300);
  });
});
