/**
 * alasdairn's PC, 11-28 (Skyrim-collection): diagnose.setup said "OSize.esp
 * loads before its master OStim.esp" while plugins.txt had OStim.esp at 607
 * and OSize.esp (ESL flag only) at 2009.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { loadPositions, loadsBeforeMaster } from "./masterOrder";

const notMaster = (): boolean => false;

describe("where diagnose.setup says a plugin loads", () => {
  it("follows plugins.txt, not a loadOrder -1 that Vortex left on a plugin enabled before it was listed", () => {
    const enabled = [
      { name: "Skyrim.esm", isNative: true, loadOrder: 0 },
      { name: "OStim.esp", loadOrder: 607 },
      { name: "OSize.esp", loadOrder: -1 },
    ];
    const file = [{ name: "OStim.esp" }, { name: "Other.esp" }, { name: "OSize.esp" }];
    const position = loadPositions(enabled, file);
    expect(loadsBeforeMaster("OSize.esp", "OStim.esp", position, notMaster)).toBe(false);
    // Without the file, -1 still sorts last rather than first.
    expect(loadsBeforeMaster("OSize.esp", "OStim.esp", loadPositions(enabled, undefined), notMaster)).toBe(false);
  });

  it("still reports a dependant listed above its master", () => {
    const position = loadPositions([{ name: "A.esp" }, { name: "B.esp" }], [{ name: "B.esp" }, { name: "A.esp" }]);
    expect(loadsBeforeMaster("B.esp", "A.esp", position, notMaster)).toBe(true);
  });

  it("lets a master file listed lower load first, but not an ESL-flagged .esp", () => {
    const position = loadPositions([{ name: "Dep.esp" }, { name: "Mast.esp" }], [{ name: "Dep.esp" }, { name: "Mast.esp" }]);
    expect(loadsBeforeMaster("Dep.esp", "Mast.esp", position, (n) => n === "Mast.esp")).toBe(false); // ESM flag
    expect(loadsBeforeMaster("Dep.esp", "Mast.esp", position, notMaster)).toBe(true); // light flag only = no move
    const byName = loadPositions([{ name: "Dep.esp" }, { name: "Mast.esm" }], [{ name: "Dep.esp" }, { name: "Mast.esm" }]);
    expect(loadsBeforeMaster("Dep.esp", "Mast.esm", byName, () => undefined)).toBe(false);
  });

  it("reports a master file that needs a non-master, wherever they are listed", () => {
    const position = loadPositions([{ name: "Plain.esp" }, { name: "Big.esm" }], [{ name: "Plain.esp" }, { name: "Big.esm" }]);
    expect(loadsBeforeMaster("Big.esm", "Plain.esp", position, (n) => n === "Big.esm")).toBe(true);
  });

  it("is what diagnose.setup uses", () => {
    const verbs = readFileSync(new URL("./verbs.ts", import.meta.url), "utf8");
    expect(verbs).toContain("loadPositions(enabled, await readUserPluginsTxt(");
    expect(verbs).toContain("loadsBeforeMaster(p.name, m, position,");
  });
});
