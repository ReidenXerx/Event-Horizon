/**
 * The preflight end to end, on a real folder: a store DLL the game executable
 * or the script extender's loader cannot load must block, one only the launcher
 * cannot load only warns (Play never starts the launcher); a mismatched DLL the store did not install only warns; a Prefs file the
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
  syncedRoots: [],
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
      "synced-folder": "ok",
      "binary-imports": "ok",
      "ini-leftovers": "ok",
      "game-folder": "ok",
    });
  });

  it("blocks a game inside the OneDrive folder, and names the mods folder's drive as the place to move it", async () => {
    const report = await runEnvironmentPreflight(
      facts({ syncedRoots: [{ service: "OneDrive", path: tmp }], stagingDir: "E:\\Vortex Mods\\fallout4", store: "gog" }),
      { scanFolder: false, context: "test" },
    );
    const check = report.checks.find((c) => c.id === "synced-folder");
    expect(check?.status).toBe("blocked");
    expect(check?.title).toBe("Fallout 4 is inside your OneDrive folder.");
    expect(check?.steps[0]).toMatch(/^GOG Galaxy → Fallout 4 → Manage installation → Move, to a folder such as E:\\Games\. Keep it on E:/);
  });

  // The rule changed on 2026-09-17 (owner poll): only what Event Horizon starts can block. A Steam game moved back
  // with Simple Fallout 4 Downgrader keeps the next-gen launcher beside the old steam_api64.dll; the launcher cannot
  // open, the game and its script extender can, and Play never starts the launcher.
  it("only warns when the launcher, which Play never starts, cannot load a store DLL", async () => {
    write(path.join(game, "steam_api64.dll"), buildPe({ exports: ["SteamAPI_Init", "SteamAPI_Shutdown"] }));
    const report = await runEnvironmentPreflight(facts(), { scanFolder: false, context: "test" });
    const check = report.checks.find((c) => c.id === "binary-imports");
    expect(check?.status).toBe("warning");
    expect(check?.title).toMatch(/Fallout4Launcher\.exe cannot open with this steam_api64\.dll, but Event Horizon does not start it/);
    expect(report.imports?.findings).toEqual([
      { exe: "Fallout4Launcher.exe", dll: "steam_api64.dll", missing: ["SteamInternal_CreateInterface"], dllIsVanilla: true },
    ]);
  });

  it("blocks when the game executable itself cannot load a store DLL", async () => {
    write(path.join(game, "Fallout4.exe"), buildPe({ imports: [{ dll: "steam_api64.dll", names: ["SteamAPI_Init", "SteamAPI_RunCallbacks"] }] }));
    const report = await runEnvironmentPreflight(facts(), { scanFolder: false, context: "test" });
    const check = report.checks.find((c) => c.id === "binary-imports");
    expect(check?.status).toBe("blocked");
    expect(check?.title).toMatch(/Fallout4\.exe cannot start: steam_api64\.dll is the wrong version/);
  });

  it("checks the script extender's loader too, and blocks when it cannot load a store DLL", async () => {
    write(path.join(game, "f4se_loader.exe"), buildPe({ imports: [{ dll: "steam_api64.dll", names: ["SteamAPI_Missing"] }] }));
    const report = await runEnvironmentPreflight(facts(), { scanFolder: false, context: "test" });
    expect(report.imports?.checked).toContain("f4se_loader.exe");
    expect(report.checks.find((c) => c.id === "binary-imports")?.status).toBe("blocked");
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

describe("runEnvironmentPreflight — under Wine, with the game in Heroic's prefix", () => {
  let root: string;
  let vortexUser: string;
  const PREFIX = "/home/deck/Games/Heroic/Prefixes/default/Fallout 4 GOTY";
  const gameUser = (): string =>
    path.join(root, "home", "deck", "Games", "Heroic", "Prefixes", "default", "Fallout 4 GOTY", "pfx", "drive_c", "users", "steamuser");
  const SETTINGS = [
    ["Documents", "My Games", "Fallout4"],
    ["AppData", "Local", "Fallout4"],
  ];

  beforeEach(() => {
    root = path.join(tmp, "root");
    vortexUser = path.join(tmp, "vortex", "drive_c", "users", "steamuser");
    write(path.join(game, "goggame-1998527297.info"), "{}");
    const heroic = path.join(root, "home", "deck", ".config", "heroic");
    write(
      path.join(heroic, "gog_store", "installed.json"),
      JSON.stringify({ installed: [{ appName: "1998527297", install_path: "/home/deck/Games/Heroic/Fallout 4" }] }),
    );
    write(path.join(heroic, "GamesConfig", "1998527297.json"), JSON.stringify({ "1998527297": { winePrefix: PREFIX } }));
    // Vortex's prefix: a Prefs file an earlier INI apply created — no hardware settings, and an archive leftover.
    write(path.join(vortexUser, "Documents", "My Games", "Fallout4", "Fallout4Prefs.ini"), "[Archive]\nbInvalidateOlderFiles=1\n");
    write(path.join(vortexUser, "AppData", "Local", "Fallout4", "plugins.txt"), "");
    // The game's prefix, where its launcher ran.
    write(path.join(gameUser(), "Documents", "My Games", "Fallout4", "Fallout4Prefs.ini"), "[Display]\niSize W=1920\niSize H=1080\n");
    write(path.join(gameUser(), "AppData", "Local", "Fallout4", "plugins.txt"), "");
  });

  const wineFacts = (): PreflightFacts =>
    facts({
      store: "gog",
      wine: true,
      wineHost: { unixRoot: root, homes: ["/home/deck"] },
      userProfileDir: vortexUser,
      prefsPath: path.join(vortexUser, "Documents", "My Games", "Fallout4", "Fallout4Prefs.ini"),
      iniDir: path.join(vortexUser, "Documents", "My Games", "Fallout4"),
      localGameDir: path.join(vortexUser, "AppData", "Local", "Fallout4"),
    });

  it("blocks on the split prefix alone: the launcher did run — in the game's prefix, which is where its settings are read", async () => {
    const report = await runEnvironmentPreflight(wineFacts(), { scanFolder: false, context: "test" });
    expect(report.checks.map((c) => [c.id, c.status])).toEqual([
      ["game-managed", "ok"],
      ["wine-prefix", "blocked"],
      ["launcher-ran", "ok"],
      ["protected-location", "ok"],
      ["synced-folder", "ok"],
      ["binary-imports", "ok"],
      ["ini-leftovers", "ok"],
    ]);
    expect(report.checks.find((c) => c.id === "launcher-ran")?.lines[0]).toBe(
      `Found: ${path.join(gameUser(), "Documents", "My Games", "Fallout4", "Fallout4Prefs.ini")}`,
    );
  });

  it("passes once Vortex's folders are links to the game's", async () => {
    for (const rel of SETTINGS) {
      fs.rmSync(path.join(vortexUser, ...rel), { recursive: true });
      fs.symlinkSync(path.join(gameUser(), ...rel), path.join(vortexUser, ...rel), "junction");
    }
    const verdicts = await statusOf(wineFacts(), false);
    expect([verdicts["wine-prefix"], verdicts["launcher-ran"]]).toEqual(["ok", "ok"]);
  });

  it("names Heroic as the place to start the game when its own prefix holds no launcher-written settings", async () => {
    write(path.join(gameUser(), "Documents", "My Games", "Fallout4", "Fallout4Prefs.ini"), "[Archive]\nbInvalidateOlderFiles=0\n");
    const report = await runEnvironmentPreflight(wineFacts(), { scanFolder: false, context: "test" });
    const launcher = report.checks.find((c) => c.id === "launcher-ran");
    expect(launcher?.status).toBe("blocked");
    expect(launcher?.steps[0]).toMatch(/^Start Fallout 4 once from Heroic — /);
    expect(launcher?.lines.join("\n")).not.toMatch(/the prefix Vortex runs in/);
  });

  it("without a record of the game's prefix, reads Vortex's prefix and says so", async () => {
    fs.rmSync(path.join(game, "goggame-1998527297.info"));
    const report = await runEnvironmentPreflight(wineFacts(), { scanFolder: false, context: "test" });
    expect(report.checks.find((c) => c.id === "wine-prefix")?.status).toBe("unknown");
    const launcher = report.checks.find((c) => c.id === "launcher-ran");
    expect(launcher?.status).toBe("blocked");
    expect(launcher?.lines.join("\n")).toMatch(/the prefix Vortex runs in/);
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
