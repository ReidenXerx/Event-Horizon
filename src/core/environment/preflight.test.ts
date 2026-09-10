/**
 * The preflight end to end, on a real folder: the tester's Steam launcher with
 * a GOG steam_api64.dll must block; the same launcher with the right DLL must
 * not; a mismatched DLL the store did not install only warns; and a game
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
  prefs = path.join(tmp, "Documents", "My Games", "Fallout4", "Fallout4Prefs.ini");
  write(
    path.join(game, "goggame-galaxyFileList.ini"),
    "[1998527297]\nF1=Fallout4.exe\nF2=Fallout4Launcher.exe\nF3=steam_api64.dll\nF4=Data\\Fallout4.esm\n",
  );
  write(path.join(game, "Fallout4.exe"), buildPe({ imports: [{ dll: "steam_api64.dll", names: ["SteamAPI_Init"] }] }));
  write(
    path.join(game, "Fallout4Launcher.exe"),
    buildPe({ imports: [{ dll: "steam_api64.dll", names: ["SteamAPI_Init", "SteamInternal_CreateInterface"] }] }),
  );
  write(path.join(game, "steam_api64.dll"), buildPe({ exports: ["SteamAPI_Init", "SteamInternal_CreateInterface"] }));
  write(path.join(game, "Data", "Fallout4.esm"));
  write(prefs, "[Display]\n");
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
    // Nothing that needs the folder runs without one.
    expect(report.checks.map((c) => c.id)).toEqual(["game-managed", "launcher-ran"]);
    expect(report.checks[0]?.status).toBe("blocked");
    expect(report.folder).toBeUndefined();
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
});
