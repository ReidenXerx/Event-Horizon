/**
 * Ruinfan, Meridia on Steam Skyrim 1.6.1170 (built on GOG 1.6.1179), swapped
 * the mods the install listed and forgot the Address Library. The Doctor now
 * reads the game folder and lists what is still for another game version.
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { describe, expect, it } from "vitest";

import { buildPe } from "../environment/fixtures.testutil";
import { addressLibraryStem, assessNativeOnDisk, gatherNativeOnDisk } from "./nativeOnDisk";

const pack = (a: number, b: number, c: number): number => ((a << 24) | (b << 16) | (c << 4)) >>> 0;

/** An SKSE plugin DLL declaring only one runtime (no Address Library). */
const pinnedSksePlugin = (runtime: number): Buffer => {
  const block = Buffer.alloc(848);
  block.writeUInt32LE(1, 0);
  block.write("Pinned", 8, "latin1");
  block.writeUInt32LE(0, 776);
  block.writeUInt32LE(runtime, 780);
  return buildPe({ exportData: { SKSEPlugin_Version: block } });
};

function skyrim(files: Record<string, Buffer | string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "eh-native-"));
  for (const [rel, content] of Object.entries(files)) {
    const p = path.join(dir, ...rel.split("/"));
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
  }
  return dir;
}

describe("the script-extender side of the game folder, for the version installed now", () => {
  it("names the Address Library a Steam 1.6.1170 player forgot to swap (Ruinfan)", () => {
    const gameDir = skyrim({
      "skse64_1_6_1170.dll": "x",
      "Data/SKSE/Plugins/versionlib-1-6-1179-0.bin": "x",
    });
    const o = gatherNativeOnDisk({ gameId: "skyrimse", gameDir, gameVersion: "1.6.1170.0", store: "steam" })!;
    expect(o.extender).toMatchObject({ expected: "skse64_1_6_1170.dll", present: true });
    expect(o.addressLibrary).toEqual({ expected: "versionlib-1-6-1170-0.bin", present: false, needed: true });
    const card = assessNativeOnDisk(o);
    expect(card.status).toBe("broken");
    expect(card.detail).toEqual([expect.stringMatching(/^Address Library for 1\.6\.1170 is missing/)]);
  });

  it("names a script extender left from the other game version", () => {
    const gameDir = skyrim({ "skse64_1_6_1179.dll": "x" });
    const card = assessNativeOnDisk(gatherNativeOnDisk({ gameId: "skyrimse", gameDir, gameVersion: "1.6.1170.0", store: "steam" })!);
    expect(card.detail[0]).toMatch(/SKSE for 1\.6\.1170 is missing \(skse64_1_6_1170\.dll\)\. Installed: skse64_1_6_1179\.dll/);
  });

  it("names a deployed plugin built only for another version, by the mod that deployed it", () => {
    const gameDir = skyrim({
      "skse64_1_6_1170.dll": "x",
      "Data/SKSE/Plugins/GogOnly.dll": pinnedSksePlugin(pack(1, 6, 1179)),
      "Data/SKSE/Plugins/SteamBuild.dll": pinnedSksePlugin(pack(1, 6, 1170)),
    });
    const o = gatherNativeOnDisk({
      gameId: "skyrimse",
      gameDir,
      gameVersion: "1.6.1170.0",
      store: "steam",
      deployedBy: (rel) => (rel === "SKSE/Plugins/GogOnly.dll" ? "Some Fix (GOG)" : undefined),
    })!;
    expect(o.cannotLoad).toEqual([{ file: "GogOnly.dll", mod: "Some Fix (GOG)", why: expect.stringContaining("1.6.1179") }]);
  });

  it("is healthy when everything matches, including a variant Address Library name", () => {
    const gameDir = skyrim({
      "skse64_1_6_1170.dll": "x",
      "Data/SKSE/Plugins/versionlib-1-6-1170-0-1.bin": "x",
    });
    const card = assessNativeOnDisk(gatherNativeOnDisk({ gameId: "skyrimse", gameDir, gameVersion: "1.6.1170.0", store: "steam" })!);
    expect(card).toMatchObject({ status: "healthy", affectedCount: 0 });
  });

  it("knows each game's Address Library naming", () => {
    expect(addressLibraryStem("skyrimse", "1.6.1170.0")).toBe("versionlib-1-6-1170-0");
    expect(addressLibraryStem("skyrimse", "1.5.97.0")).toBe("version-1-5-97-0");
    expect(addressLibraryStem("fallout4", "1.11.240.0")).toBe("version-1-11-240-0");
    expect(addressLibraryStem("oblivion", "1.2.0")).toBeUndefined();
  });
});
