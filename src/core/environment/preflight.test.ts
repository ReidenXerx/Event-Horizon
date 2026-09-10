/**
 * The preflight end to end, on a real folder: the tester's Steam launcher with
 * a GOG steam_api64.dll must block; the same launcher with the right DLL must
 * not; a mismatched DLL the store did not install only warns; a Prefs file the
 * launcher did not write blocks; archive-loading INI leftovers warn; and a game
 * Vortex has no folder for stops before anything touches the disk.
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildPe } from "./fixtures.testutil";
import { declaredPrerequisitePaths, runEnvironmentPreflight, type PreflightFacts } from "./preflight";

let tmp: string;
let game: string;
let prefs: string;
let iniDir: string;

const write = (full: string, content: string | Buffer = "x"): void => {
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
};

const facts = (over: Partial<PreflightFacts> = {}): PreflightFacts => ({
  gameId: "fallout4",
  gameName: "Fallout 4",
  discoveredPath: game,
  store: "steam",
  executable: "Fallout4.exe",
  prefsPath: prefs,
  hasLauncher: true,
  iniDir,
  iniFiles: ["Fallout4.ini", "Fallout4Prefs.ini", "Fallout4Custom.ini"],
  collectionIniKeys: new Set(),
  declared: new Set(),
  protectedRoots: ["C:\\Program Files", "C:\\Program Files (x86)"],
  wine: false,
  ...over,
});

const statusOf = async (f: PreflightFacts, scanFolder = true): Promise<Record<string, string>> => {
  const report = await runEnvironmentPreflight(f, { scanFolder, context: "test" });
  return Object.fromEntries(report.checks.map((c) => [c.id, c.status]));
};

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "eh-preflight-"));
  game = path.join(tmp, "Fallout 4");
  iniDir = path.join(tmp, "Documents", "My Games", "Fallout4");
  prefs = path.join(iniDir, "Fallout4Prefs.ini");
  write(
    path.join(game, "goggame-galaxyFileList.ini"),
    "[1998527297]\nfiles_counter=5\nF0=fce49f0d98c540e33c73dbe75acc4cc7\nF1=Fallout4.exe\nF2=Fallout4Launcher.exe\nF3=steam_api64.dll\nF4=Data\\Fallout4.esm\n",
  );
  write(path.join(game, "Fallout4.exe"), buildPe({ imports: [{ dll: "steam_api64.dll", names: ["SteamAPI_Init"] }] }));
  write(
    path.join(game, "Fallout4Launcher.exe"),
    buildPe({ imports: [{ dll: "steam_api64.dll", names: ["SteamAPI_Init", "SteamInternal_CreateInterface"] }] }),
  );
  write(path.join(game, "steam_api64.dll"), buildPe({ exports: ["SteamAPI_Init", "SteamInternal_CreateInterface"] }));
  write(path.join(game, "Data", "Fallout4.esm"));
  write(path.join(game, "Fallout4_Default.ini"), "[Archive]\nsResourceDataDirsFinal=STRINGS\\\nbInvalidateOlderFiles=0\n");
  // What the launcher writes: hardware settings.
  write(prefs, "[Display]\niSize W=1920\niSize H=1080\n");
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("runEnvironmentPreflight", () => {
  it("passes a clean, set-up game", async () => {
    expect(await statusOf(facts())).toEqual({
      "game-managed": "ok",
      "launcher-ran": "ok",
      "protected-location": "ok",
      "binary-imports": "ok",
      "ini-leftovers": "ok",
      "game-folder": "ok",
    });
  });

  it("blocks the tester's case: a store DLL without the export the store's launcher imports", async () => {
    write(path.join(game, "steam_api64.dll"), buildPe({ exports: ["SteamAPI_Init", "SteamAPI_Shutdown"] }));
    const report = await runEnvironmentPreflight(facts(), { scanFolder: false, context: "test" });
    const check = report.checks.find((c) => c.id === "binary-imports");
    expect(check?.status).toBe("blocked");
    expect(check?.title).toMatch(/Fallout4Launcher\.exe cannot start: steam_api64\.dll/);
    expect(report.imports?.findings).toEqual([
      { exe: "Fallout4Launcher.exe", dll: "steam_api64.dll", missing: ["SteamInternal_CreateInterface"], dllIsVanilla: true },
    ]);
  });

  it("only warns when the mismatched DLL is not one the store installed", async () => {
    write(path.join(game, "Fallout4.exe"), buildPe({ imports: [{ dll: "tbb.dll", names: ["scalable_malloc"] }] }));
    write(path.join(game, "tbb.dll"), buildPe({ exports: ["something_else"] }));
    expect((await statusOf(facts(), false))["binary-imports"]).toBe("warning");
  });

  it("blocks a game that was never started, and one Vortex has no folder for", async () => {
    fs.unlinkSync(prefs);
    expect((await statusOf(facts(), false))["launcher-ran"]).toBe("blocked");
    const report = await runEnvironmentPreflight(facts({ discoveredPath: undefined }), { scanFolder: true, context: "test" });
    expect(report.checks.map((c) => c.id)).toEqual(["game-managed", "launcher-ran"]);
    expect(report.checks[0]?.status).toBe("blocked");
    expect(report.folder).toBeUndefined();
  });

  it("blocks a Prefs file without hardware settings — a tool wrote it, not the launcher", async () => {
    write(prefs, "[Archive]\nbInvalidateOlderFiles=1\n");
    expect((await statusOf(facts(), false))["launcher-ran"]).toBe("blocked");
  });

  it("does not judge the Prefs contents of a game without a launcher", async () => {
    write(prefs, "[General]\nuGridsToLoad=5\n");
    expect((await statusOf(facts({ hasLauncher: false }), false))["launcher-ran"]).toBe("ok");
  });

  it("warns about archive-loading INI settings that neither the game nor the collection set", async () => {
    write(path.join(iniDir, "Fallout4Custom.ini"), "[Archive]\nsResourceDataDirsFinal=\nbInvalidateOlderFiles=1\nsResourceArchive2List=Old - Textures.ba2\n");
    const report = await runEnvironmentPreflight(facts({ collectionIniKeys: new Set(["archive.binvalidateolderfiles"]) }), {
      scanFolder: false,
      context: "test",
    });
    const check = report.checks.find((c) => c.id === "ini-leftovers");
    expect(check?.status).toBe("warning");
    expect(check?.lines).toEqual([
      "Fallout4Custom.ini: sResourceDataDirsFinal= (game default: STRINGS\\)",
      "Fallout4Custom.ini: sResourceArchive2List=Old - Textures.ba2 (game default: not set)",
    ]);
  });

  it("finds a leftover in the load surface as a warning", async () => {
    write(path.join(game, "Data", "F4SE", "Plugins", "old.dll"));
    const report = await runEnvironmentPreflight(facts(), { scanFolder: true, context: "test" });
    expect(report.checks.find((c) => c.id === "game-folder")?.status).toBe("warning");
    expect(report.folder?.report.unmanaged.map((x) => x.path)).toEqual(["Data/F4SE/Plugins/old.dll"]);
  });

  it("allows a collection's declared prerequisite in the game root", async () => {
    write(path.join(game, "d3dx9_42.dll"));
    const report = await runEnvironmentPreflight(facts({ declared: new Set(["d3dx9_42.dll"]) }), { scanFolder: true, context: "test" });
    expect(report.folder?.report.unmanaged).toEqual([]);
  });
});

describe("declaredPrerequisitePaths", () => {
  it("resolves each destination token to a game-root-relative key", () => {
    const paths = declaredPrerequisitePaths([
      { id: "a", name: "A", category: "loader", version: "1", destination: "<gameDir>", files: [{ relPath: "D3DX9_42.dll", sha256: "x" }], instructions: "" },
      { id: "b", name: "B", category: "x", version: "1", destination: "<dataDir>", files: [{ relPath: "F4SE\\Plugins\\b.dll", sha256: "x" }], instructions: "" },
      { id: "c", name: "C", category: "x", version: "1", destination: "<scripts>", files: [{ relPath: "c.pex", sha256: "x" }], instructions: "" },
    ]);
    expect([...paths]).toEqual(["d3dx9_42.dll", "data/f4se/plugins/b.dll", "data/scripts/c.pex"]);
    expect(declaredPrerequisitePaths(undefined).size).toBe(0);
  });

  it("allows every file the prerequisite consists of, not only the ones the curator's detection recorded", () => {
    const paths = declaredPrerequisitePaths([
      { id: "enb", name: "ENBSeries", category: "enb", version: "1", destination: "<gameDir>", files: [{ relPath: "d3d11.dll", sha256: "x" }], instructions: "" },
    ]);
    expect(paths.has("d3dcompiler_46e.dll")).toBe(true);
    expect(paths.has("enbseries.ini")).toBe(true);
  });
});
