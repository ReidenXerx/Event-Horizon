/**
 * The Windows loader's own check, reproduced: what an executable imports must
 * be what the DLL beside it exports. The fixture is the tester's case — a
 * launcher importing SteamInternal_CreateInterface from a steam_api64.dll that
 * only has the older GOG exports.
 */
import { describe, expect, it } from "vitest";

import { buildPe } from "./fixtures.testutil";
import { missingImports, parsePeImage } from "./peImage";

const GOG_STEAM_API = ["SteamAPI_Init", "SteamAPI_RunCallbacks", "SteamAPI_Shutdown", "SteamUser"];

describe("parsePeImage", () => {
  it("reads exports and static imports of a 64-bit image", () => {
    const img = parsePeImage(
      buildPe({
        exports: GOG_STEAM_API,
        imports: [
          { dll: "KERNEL32.dll", names: ["CreateFileW", "ReadFile"] },
          { dll: "steam_api64.dll", names: ["SteamAPI_Init"], ordinals: [7] },
        ],
      }),
    );
    expect(img?.is64).toBe(true);
    expect([...(img?.exports ?? [])]).toEqual(GOG_STEAM_API);
    expect([...(img?.exportOrdinals ?? [])]).toEqual([1, 2, 3, 4]);
    expect(img?.imports.get("kernel32.dll")).toEqual({ names: ["CreateFileW", "ReadFile"], ordinals: [] });
    expect(img?.imports.get("steam_api64.dll")).toEqual({ names: ["SteamAPI_Init"], ordinals: [7] });
  });

  it("reads 32-bit images too (Fallout 3 and New Vegas are 32-bit)", () => {
    const img = parsePeImage(buildPe({ is64: false, imports: [{ dll: "steam_api.dll", names: ["SteamAPI_Init"], ordinals: [3] }] }));
    expect(img?.is64).toBe(false);
    expect(img?.imports.get("steam_api.dll")).toEqual({ names: ["SteamAPI_Init"], ordinals: [3] });
  });

  it("returns undefined for anything that is not a well-formed image — never a guess", () => {
    const good = buildPe({ exports: ["A"], imports: [{ dll: "x.dll", names: ["B"] }] });
    expect(parsePeImage(Buffer.from("this is a text file pretending to be an exe"))).toBeUndefined();
    expect(parsePeImage(good.subarray(0, 0x150))).toBeUndefined();
    const badMagic = Buffer.from(good);
    badMagic.write("XX", 0x40, "latin1");
    expect(parsePeImage(badMagic)).toBeUndefined();
  });
});

describe("missingImports", () => {
  const launcher = parsePeImage(
    buildPe({ imports: [{ dll: "steam_api64.dll", names: ["SteamAPI_Init", "SteamInternal_CreateInterface"] }] }),
  )!;

  it("names the symbol the tester's launcher could not find", () => {
    const gogDll = parsePeImage(buildPe({ exports: GOG_STEAM_API }))!;
    expect(missingImports(launcher, "STEAM_API64.DLL", gogDll)).toEqual(["SteamInternal_CreateInterface"]);
  });

  it("is empty when the DLL provides everything", () => {
    const steamDll = parsePeImage(buildPe({ exports: [...GOG_STEAM_API, "SteamInternal_CreateInterface"] }))!;
    expect(missingImports(launcher, "steam_api64.dll", steamDll)).toEqual([]);
  });

  it("checks ordinal imports against the export ordinal range", () => {
    const exe = parsePeImage(buildPe({ imports: [{ dll: "a.dll", ordinals: [2, 9] }] }))!;
    const dll = parsePeImage(buildPe({ exports: ["X", "Y", "Z"], exportBase: 1 }))!;
    expect(missingImports(exe, "a.dll", dll)).toEqual(["#9"]);
  });

  it("is empty for a DLL the executable does not import from", () => {
    const dll = parsePeImage(buildPe({ exports: [] }))!;
    expect(missingImports(launcher, "other.dll", dll)).toEqual([]);
  });
});
