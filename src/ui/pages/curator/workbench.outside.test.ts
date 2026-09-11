import { describe, expect, it } from "vitest";

import type { CuratorMod } from "../../../core/curator/profileActions";
import { buildRows, outsideDataTypes, rowsForView } from "./workbench";

const mod = (id: string, modType: string): CuratorMod => ({ id, name: id, enabled: true, modType });

describe("Outside Data, from where Vortex deploys each mod type", () => {
  // The shape of selectors.modPathsForGame: "" is the game's default mod path.
  const skyrim = {
    "": "C:\\Games\\Skyrim Special Edition\\Data",
    dinput: "C:\\Games\\Skyrim Special Edition",
    enb: "C:\\Games\\Skyrim Special Edition\\",
    "skse-plugin": "C:\\Games\\Skyrim Special Edition\\data\\SKSE\\Plugins",
    reshade: "C:/Games/Skyrim Special Edition",
    "bepinex-root": "D:\\Elsewhere",
  };

  it("names every type whose path is not the Data folder or inside it — including ones no list knew", () => {
    expect([...outsideDataTypes(skyrim)!].sort()).toEqual(["bepinex-root", "dinput", "enb", "reshade"]);
  });

  it("does not call a type outside when this game deploys it into Data", () => {
    const other = { "": "C:\\G\\Data", dinput: "C:\\G\\Data\\Bin" };
    expect([...outsideDataTypes(other)!]).toEqual([]);
  });

  it("claims nothing when Vortex gives no paths (game not discovered)", () => {
    expect(outsideDataTypes(undefined)).toBeUndefined();
    expect(outsideDataTypes({ dinput: "C:\\G" })).toBeUndefined();
    const rows = buildRows([mod("a", "dinput")], undefined);
    expect(rowsForView(rows, "outside-data")).toEqual([]);
  });

  it("filters the view by those types", () => {
    const rows = buildRows([mod("inj", "dinput"), mod("shade", "reshade"), mod("plug", "skse-plugin"), mod("plain", "")], undefined);
    const ids = rowsForView(rows, "outside-data", { outsideDataTypes: outsideDataTypes(skyrim)! }).map((r) => r.mod.id);
    expect(ids).toEqual(["inj", "shade"]);
  });
});
