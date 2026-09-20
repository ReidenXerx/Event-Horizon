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

/**
 * ─────────────────────────────────────────────────────────────────────────
 * Both bounded loops must fail CLOSED.
 *
 * The parser caps the import descriptor and thunk loops so a malformed file
 * cannot spin forever. Reaching a cap used to just stop reading, which hands
 * the caller a SHORTER import list — and `missingImports` turns a shorter
 * import list into FEWER missing symbols, which is a launcher gate saying the
 * install is fine about a file it only partly read.
 *
 * Wrong direction for a check whose job is refusing to start a game that
 * cannot start. A cap now means `undefined`: "cannot say", which is what this
 * module already returns for every other unreadable structure.
 * ─────────────────────────────────────────────────────────────────────────
 */
describe("the loop bounds", () => {
  it("returns undefined when the descriptor table never terminates", () => {
    // 4,097 descriptors: the 4,096-iteration cap is reached one short of the
    // terminator, so the table was read in part.
    const imports = Array.from({ length: 4097 }, (_, i) => ({
      dll: `d${i}.dll`,
      names: ["F"],
    }));
    expect(parsePeImage(buildPe({ imports }))).toBeUndefined();
  });

  it("reads a descriptor table that terminates inside the cap", () => {
    // The control, and it earned its place: at 4,096 DLLs the cap is spent on
    // the last real descriptor and the terminator is never reached, so the
    // largest table this can read is 4,095. Without this test the one above
    // would have passed while measuring nothing in particular.
    const imports = Array.from({ length: 4095 }, (_, i) => ({
      dll: `d${i}.dll`,
      names: ["F"],
    }));
    const img = parsePeImage(buildPe({ imports }));
    expect(img?.imports.size).toBe(4095);
  });

  it("returns undefined when one DLL's thunk list never terminates", () => {
    const names = Array.from({ length: (1 << 16) + 1 }, (_, i) => `F${i}`);
    expect(parsePeImage(buildPe({ imports: [{ dll: "x.dll", names }] }))).toBeUndefined();
  });

  it("reads a thunk list that terminates inside the cap", () => {
    // Same control, same reason: one under the cap must still parse, or the
    // test above proves only that a large fixture broke somewhere.
    const names = Array.from({ length: (1 << 16) - 1 }, (_, i) => `F${i}`);
    const img = parsePeImage(buildPe({ imports: [{ dll: "x.dll", names }] }));
    expect(img?.imports.get("x.dll")?.names.length).toBe((1 << 16) - 1);
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
