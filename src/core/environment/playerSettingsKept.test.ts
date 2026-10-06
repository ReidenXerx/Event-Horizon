/**
 * alasdairn (Ivy, 2026-10-06): every update wiped his MCM keybinds. EH's own
 * clean-folder step quarantined MCM's settings as unmanaged files, and a
 * mod's shipped settings file edited in-game failed verification. Owner poll:
 * keep them on an update of the SAME collection.
 */
import { describe, expect, it } from "vitest";

import { classifyGameFolder, type FolderEntry, type VanillaList } from "./gameFolderScan";
import { isPlayerSettingsFile, isVolatileFile, skipsVerification } from "../volatileFiles";

const e = (p: string): FolderEntry => ({ path: p, size: 1, mtimeMs: 0 });
const vanilla: VanillaList = {
  kind: "known",
  source: "steam",
  detail: "fixture",
  files: [{ path: "Fallout4.exe", size: 1, required: true }],
  ownedRootPrefixes: [],
};
const entries = [e("Data/MCM/Settings/Keybinds.json"), e("Data/MCM/Settings/IvyPanties.ini"), e("Data/Stray.esp")];
const run = (keepPlayerSettings: boolean) =>
  classifyGameFolder({
    entries,
    vanilla,
    deployed: new Set(),
    creations: { names: new Set(), stems: new Set() },
    declared: new Set(),
    keepPlayerSettings,
  }).unmanaged.map((x) => x.path);

describe("MCM player settings", () => {
  it("are recognised with or without Data/, including MCM Helper's settings.ini", () => {
    expect(isPlayerSettingsFile("Data/MCM/Settings/Keybinds.json")).toBe(true);
    expect(isPlayerSettingsFile("MCM/Settings/Mod.ini")).toBe(true);
    expect(isPlayerSettingsFile("MCM\\Config\\Mod\\settings.ini")).toBe(true);
    expect(isPlayerSettingsFile("MCM/Config/Mod/config.json")).toBe(false);
    expect(isPlayerSettingsFile("Data/Stray.esp")).toBe(false);
  });

  it("are never a verification failure, yet still ship in bundles and mirrors", () => {
    expect(skipsVerification("MCM/Settings/Mod.ini")).toBe(true);
    // A curator's tuned settings must keep shipping: bundling and mirroring skip only volatile files.
    expect(isVolatileFile("MCM/Settings/Mod.ini")).toBe(false);
  });

  it("stay put on an update of the same collection, and are still offered for cleaning otherwise", () => {
    expect(run(true)).toEqual(["Data/Stray.esp"]);
    expect([...run(false)].sort()).toEqual(["Data/MCM/Settings/IvyPanties.ini", "Data/MCM/Settings/Keybinds.json", "Data/Stray.esp"]);
  });
});
