import { describe, expect, it } from "vitest";

import { guardGameClosed, guardKnownMods, guardSetGamePath, samePath } from "./guards";
import { parseTasklist } from "./gameProcess";

describe("guardGameClosed", () => {
  it("refuses while the game runs, even when told to assume it is closed", () => {
    const r = guardGameClosed({ running: true, exeName: "Fallout4.exe", assumeGameClosed: true });
    expect(r).toMatchObject({ ok: false, code: "game-running" });
  });
  it("refuses an unknown state unless the caller vouches for it", () => {
    expect(guardGameClosed({ running: undefined, exeName: "Fallout4.exe" })).toMatchObject({
      ok: false,
      code: "game-state-unknown",
    });
    expect(guardGameClosed({ running: undefined, exeName: "Fallout4.exe", assumeGameClosed: true }).ok).toBe(true);
  });
  it("passes a closed game", () => {
    expect(guardGameClosed({ running: false, exeName: "Fallout4.exe" }).ok).toBe(true);
  });
});

describe("guardSetGamePath", () => {
  const base = {
    deployedFiles: 0,
    newPath: "D:\\SteamLibrary\\steamapps\\common\\Fallout 4 AE",
    newPathExists: true,
    missingRequiredFiles: [] as string[],
    currentPath: "D:\\GOGGames\\Fallout 4 GOTY",
  };
  it("refuses while anything is still deployed", () => {
    expect(guardSetGamePath({ ...base, deployedFiles: 12 })).toMatchObject({ ok: false, code: "not-purged" });
  });
  it("refuses when the manifests could not be read", () => {
    expect(guardSetGamePath({ ...base, deployedFiles: undefined })).toMatchObject({
      ok: false,
      code: "deployment-unknown",
    });
  });
  it("refuses a folder that is missing or is not the game", () => {
    expect(guardSetGamePath({ ...base, newPathExists: false })).toMatchObject({ code: "path-missing" });
    expect(guardSetGamePath({ ...base, missingRequiredFiles: ["Fallout4.exe"] })).toMatchObject({
      code: "not-a-game-folder",
    });
  });
  it("refuses the folder it already points at, spelled differently", () => {
    expect(guardSetGamePath({ ...base, newPath: "d:/gOGGames/Fallout 4 GOTY/" })).toMatchObject({
      code: "same-path",
    });
  });
  it("passes a purged switch to a real game folder", () => {
    expect(guardSetGamePath(base).ok).toBe(true);
  });
});

describe("guardKnownMods", () => {
  const pool = new Set(["a", "b", "c"]);
  it("removes nothing when any id is unknown", () => {
    expect(guardKnownMods({ requested: ["a", "zz"], pool })).toMatchObject({ ok: false, code: "unknown-mods" });
  });
  it("refuses an empty request", () => {
    expect(guardKnownMods({ requested: [], pool })).toMatchObject({ code: "no-mods" });
  });
  it("passes ids that are all in the pool", () => {
    expect(guardKnownMods({ requested: ["a", "c"], pool }).ok).toBe(true);
  });
});

describe("samePath", () => {
  it("ignores case, slash direction and a trailing separator", () => {
    expect(samePath("D:\\Games\\FO4\\", "d:/games/fo4")).toBe(true);
    expect(samePath("D:\\Games\\FO4", "D:\\Games\\FO4 AE")).toBe(false);
  });
});

describe("parseTasklist", () => {
  it("finds the image name in CSV output", () => {
    const out = '"Fallout4.exe","1234","Console","1","1,234,567 K"\r\n';
    expect(parseTasklist(out, "fallout4.exe")).toBe(true);
  });
  it("reads tasklist's no-match line as not running", () => {
    expect(parseTasklist("INFO: No tasks are running which match the specified criteria.\r\n", "Fallout4.exe")).toBe(
      false,
    );
  });
  it("does not match a longer name that starts the same", () => {
    expect(parseTasklist('"Fallout4Launcher.exe","99","Console","1","10 K"', "Fallout4.exe")).toBe(false);
  });
});
