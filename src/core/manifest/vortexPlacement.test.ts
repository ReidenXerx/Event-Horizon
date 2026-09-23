/**
 * The rule is Vortex's, so every case here is one Vortex decides a particular
 * way — see the module header for the source. The first case is the archive
 * that shipped in Meridia 1.0.23 and reached every player one folder too deep.
 */
import { describe, expect, it } from "vitest";

import { hasInstallerScript, predictBasicPlacement } from "./vortexPlacement";

const placed = (paths: string[], gameId = "skyrimse"): Record<string, string> => {
  const p = predictBasicPlacement(paths, gameId);
  if (p === undefined) throw new Error(`no stop patterns for ${gameId}`);
  return Object.fromEntries(p.destinations);
};

describe("predictBasicPlacement", () => {
  it("strips nothing when nothing in the archive looks like game data — the grass cache", () => {
    // `grass` is not a stop pattern and neither is `data`, so the MO2-style
    // wrapper survives and the cache lands where the game never reads it.
    const p = predictBasicPlacement(
      [
        "Grass_Cache_Default/README.txt",
        "Grass_Cache_Default/meta.ini",
        "Grass_Cache_Default/Data/Grass/AlftandWorldx-001y-001.cgid",
      ],
      "skyrimse",
    )!;
    expect(p.prefix).toBe("");
    expect(p.orderDependent).toBe(false);
    expect(p.destinations.get("Grass_Cache_Default/Data/Grass/AlftandWorldx-001y-001.cgid")).toBe(
      "Grass_Cache_Default/Data/Grass/AlftandWorldx-001y-001.cgid",
    );
  });

  it("strips the same wrapper as soon as one plugin inside it matches", () => {
    // The control for the case above: one .esp is enough to move the whole
    // archive up — which is why most wrapped archives install fine.
    expect(
      placed([
        "Grass_Cache_Default/Data/Grass/A.cgid",
        "Grass_Cache_Default/Data/Patch.esp",
      ]),
    ).toEqual({
      "Grass_Cache_Default/Data/Grass/A.cgid": "Grass/A.cgid",
      "Grass_Cache_Default/Data/Patch.esp": "Patch.esp",
    });
  });

  it("drops a top-level Data folder even when nothing matched (the pluginPath rule)", () => {
    expect(placed(["Data/Grass/A.cgid"])).toEqual({ "Data/Grass/A.cgid": "Grass/A.cgid" });
  });

  it("keeps Data when the prefix left a separator in front of it — Vortex checks the raw path", () => {
    // Prefix `Wrapper` (from `Wrapper/textures/`) leaves `/Data/readme.txt`,
    // which does not START with `Data/`, so the folder stays.
    expect(placed(["Wrapper/textures/a.dds", "Wrapper/Data/readme.txt"])).toEqual({
      "Wrapper/textures/a.dds": "textures/a.dds",
      "Wrapper/Data/readme.txt": "Data/readme.txt",
    });
  });

  it("leaves a file outside the stripped prefix where the archive put it", () => {
    expect(placed(["Main/Textures/a.dds", "readme.txt"])).toEqual({
      "Main/Textures/a.dds": "Textures/a.dds",
      "readme.txt": "readme.txt",
    });
  });

  it("matches folder names whatever their case", () => {
    expect(placed(["01 Main/TEXTURES/a.dds"])).toEqual({ "01 Main/TEXTURES/a.dds": "TEXTURES/a.dds" });
  });

  it("uses each game's own script-extender folder", () => {
    const archive = ["Wrapper/SKSE/Plugins/x.dll"];
    expect(placed(archive, "skyrimse")).toEqual({ "Wrapper/SKSE/Plugins/x.dll": "SKSE/Plugins/x.dll" });
    // Fallout 4's list has f4se, not skse: the same archive keeps its wrapper.
    expect(placed(archive, "fallout4")).toEqual({
      "Wrapper/SKSE/Plugins/x.dll": "Wrapper/SKSE/Plugins/x.dll",
    });
  });

  it("ignores __MACOSX, as Vortex does", () => {
    expect(placed(["__MACOSX/textures/._a.dds", "Pack/Grass/a.cgid"])).toEqual({
      "__MACOSX/textures/._a.dds": "__MACOSX/textures/._a.dds",
      "Pack/Grass/a.cgid": "Pack/Grass/a.cgid",
    });
  });

  it("calls two different wrappers order-dependent instead of guessing which Vortex meets first", () => {
    const p = predictBasicPlacement(["A/textures/x.dds", "B/meshes/y.nif"], "skyrimse")!;
    expect(p.orderDependent).toBe(true);
  });

  it("is not fooled by two spellings of one prefix", () => {
    // `Data` from `Data/textures/`, `Data/` from `Data/Mod.esp`: same layout.
    const p = predictBasicPlacement(["Data/textures/a.dds", "Data/Mod.esp"], "fallout4")!;
    expect(p.orderDependent).toBe(false);
    expect(Object.fromEntries(p.destinations)).toEqual({
      "Data/textures/a.dds": "textures/a.dds",
      "Data/Mod.esp": "Mod.esp",
    });
  });

  it("answers nothing for a game whose stop patterns are not known here", () => {
    expect(predictBasicPlacement(["Wrapper/a.txt"], "witcher3")).toBeUndefined();
  });
});

describe("hasInstallerScript", () => {
  it("sees an XML or C# FOMOD script at any depth and in any case", () => {
    expect(hasInstallerScript(["Main/FOMOD/ModuleConfig.xml", "a.esp"])).toBe(true);
    expect(hasInstallerScript(["fomod/script.cs"])).toBe(true);
    expect(hasInstallerScript(["fomod/info.xml", "a.esp"])).toBe(false);
  });
});
