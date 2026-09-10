/**
 * The store's own record of a game install is the only honest definition of
 * "vanilla". These parsers read three formats nobody documents for us, so the
 * fixtures are built from the real layouts measured on this machine: GOG FO4's
 * galaxyFileList (F0 is a hash, redistributable sections are deleted after
 * install), a Steam appmanifest, and a depot manifest's length-prefixed
 * protobuf.
 */
import { describe, expect, it } from "vitest";

import {
  parseAppManifest,
  parseDepotManifest,
  parseGogFileList,
  parseVdf,
} from "./storeFileLists";
import { buildDepotManifest } from "./fixtures.testutil";

describe("parseGogFileList", () => {
  const text = [
    "[1998527297]",
    "files_counter=4",
    "F0=fce49f0d98c540e33c73dbe75acc4cc7",
    "F1=Fallout4.exe",
    "F2=Data\\Fallout4 - Textures1.ba2",
    "F3=Fallout4\\Fallout4Prefs.ini",
    "[DirectX]",
    "files_counter=2",
    "F0=0123456789abcdef0123456789abcdef",
    "F1=__redist\\DirectX\\Apr2005_d3dx9_25_x64.cab",
    "",
  ].join("\r\n");

  it("skips the per-section content hash and keeps every path", () => {
    const parsed = parseGogFileList(text);
    expect(parsed.files.map((f) => f.path)).toEqual([
      "Fallout4.exe",
      "Data/Fallout4 - Textures1.ba2",
      "Fallout4/Fallout4Prefs.ini",
      "__redist/DirectX/Apr2005_d3dx9_25_x64.cab",
    ]);
  });

  it("marks product files required and redistributables not", () => {
    const parsed = parseGogFileList(text);
    expect(parsed.productIds).toEqual(["1998527297"]);
    expect(parsed.files.filter((f) => f.required).map((f) => f.path)).toEqual([
      "Fallout4.exe",
      "Data/Fallout4 - Textures1.ba2",
      "Fallout4/Fallout4Prefs.ini",
    ]);
  });

  it("ignores entries before any section", () => {
    expect(parseGogFileList("F1=stray.dll\n").files).toEqual([]);
  });
});

describe("parseVdf / parseAppManifest", () => {
  const acf = `"AppState"
{
	"appid"		"377160"
	"installdir"		"Fallout 4"
	"LauncherPath"		"C:\\\\Program Files (x86)\\\\Steam\\\\steam.exe"
	"InstalledDepots"
	{
		"377161"
		{
			"manifest"		"7497069378349273908"
			"size"		"61234"
		}
		"377163"
		{
			"manifest"		"5847529232406005096"
			"size"		"0"
		}
	}
}`;

  it("reads installdir, Steam's launcher path and every installed depot", () => {
    const app = parseAppManifest(acf);
    expect(app).toEqual({
      appId: "377160",
      installDir: "Fallout 4",
      launcherPath: "C:\\Program Files (x86)\\Steam\\steam.exe",
      depots: [
        { depotId: "377161", manifestId: "7497069378349273908", size: 61234 },
        { depotId: "377163", manifestId: "5847529232406005096", size: 0 },
      ],
    });
  });

  it("keeps manifest ids as strings — they exceed 2^53", () => {
    // 7497069378349273908 as a Number is 7497069378349274000: the file name
    // built from it would not exist.
    expect(parseAppManifest(acf)?.depots[0]?.manifestId).toBe("7497069378349273908");
  });

  it("refuses unbalanced input instead of returning half an object", () => {
    expect(parseVdf('"AppState" { "appid" "1"')).toBeUndefined();
    expect(parseVdf('"a" }')).toBeUndefined();
    expect(parseAppManifest('"Other" { }')).toBeUndefined();
  });
});

describe("parseDepotManifest", () => {
  it("reads names and sizes, skipping directories", () => {
    const buf = buildDepotManifest([
      { name: "Data", size: 0, flags: 0x40 },
      { name: "Data\\Fallout4 - Textures1.ba2", size: 5_368_709_120 },
      { name: "steam_api64.dll", size: 298_384 },
    ]);
    expect(parseDepotManifest(buf)).toEqual({
      filenamesEncrypted: false,
      files: [
        // 5 GiB: past 2^32, where a bit-shifting varint silently wraps.
        { path: "Data/Fallout4 - Textures1.ba2", size: 5_368_709_120, required: true },
        { path: "steam_api64.dll", size: 298_384, required: true },
      ],
    });
  });

  it("reports encrypted file names so the caller does not trust them", () => {
    const buf = buildDepotManifest([{ name: "AAAA", size: 1 }], { encrypted: true });
    expect(parseDepotManifest(buf)?.filenamesEncrypted).toBe(true);
  });

  it("returns undefined for a truncated or foreign file, never a partial list", () => {
    const buf = buildDepotManifest([{ name: "Fallout4.exe", size: 100 }]);
    expect(parseDepotManifest(buf.subarray(0, 20))).toBeUndefined();
    expect(parseDepotManifest(Buffer.from("not a manifest at all"))).toBeUndefined();
  });
});
