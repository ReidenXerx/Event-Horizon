/**
 * "Clean game" means every file the game can load is accounted for by a record
 * something else wrote: the store, Vortex, the game's Creation catalogs, the
 * collection. The curator's scope is the load surface — Data and root native
 * code — and the unit tests pin that boundary and each allowance; the disk
 * tests pin the two store layouts and Vortex's per-manifest target paths.
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildDepotManifest, buildPe } from "./fixtures.testutil";
import {
  classifyGameFolder,
  groupEntries,
  isOnLoadSurface,
  loadVanillaList,
  scanGameFolder,
  walkFolder,
  type FolderEntry,
  type VanillaList,
} from "./gameFolderScan";

const e = (p: string, size = 1): FolderEntry => ({ path: p, size, mtimeMs: 0 });
const noCreations = { names: new Set<string>(), stems: new Set<string>() };

describe("isOnLoadSurface", () => {
  it("is everything under Data, and native code in the root", () => {
    expect(isOnLoadSurface("Data/Textures/x.dds")).toBe(true);
    expect(isOnLoadSurface("DATA/F4SE/Plugins/x.dll")).toBe(true);
    expect(isOnLoadSurface("dxgi.dll")).toBe(true);
    expect(isOnLoadSurface("mod.ASI")).toBe(true);
  });

  it("is not a root exe, a screenshot, or anything in another root folder", () => {
    expect(isOnLoadSurface("unins000.exe")).toBe(false);
    expect(isOnLoadSurface("ScreenShot0.png")).toBe(false);
    expect(isOnLoadSurface("Tools/xEdit/x.dll")).toBe(false);
    expect(isOnLoadSurface("Event Horizon quarantine/a/Data/x.esp")).toBe(false);
  });
});

describe("classifyGameFolder", () => {
  const vanilla: VanillaList = {
    kind: "known",
    source: "steam",
    detail: "fixture",
    files: [
      { path: "Fallout4.exe", size: 100, required: true },
      { path: "steam_api64.dll", size: 50, required: true },
      { path: "Data/Fallout4.esm", size: 300, required: true },
      { path: "Data/Video/Intro.bk2", size: 9, required: true },
      { path: "__redist/vcredist.exe", required: false },
    ],
    ownedRootPrefixes: ["goggame-1998527297."],
  };

  const run = (entries: FolderEntry[], over: Partial<Parameters<typeof classifyGameFolder>[0]> = {}) =>
    classifyGameFolder({
      entries,
      vanilla,
      deployed: new Set(["data/f4se/plugins/mod.dll", "data/fallout4.esm"]),
      creations: { names: new Set(["ccbgsfo4001-pipboy(black).esl", "cccatalog.esm"]), stems: new Set(["ccbgsfo4001-pipboy(black)"]) },
      declared: new Set(["d3dx9_42.dll"]),
      ...over,
    });

  it("leaves only what no record accounts for", () => {
    const report = run([
      e("Fallout4.exe", 100),
      e("goggame-1998527297.dll"),
      e("Data/Fallout4.esm", 999),
      e("Data/F4SE/Plugins/mod.dll"),
      e("Data/__folder_managed_by_vortex"),
      e("Data/vortex.deployment.json"),
      e("CustomControlMap.txt.vortex_backup"),
      e("d3dx9_42.dll"),
      e("Data/ccBGSFO4001-PipBoy(Black).esl"),
      e("Data/ccBGSFO4001-PipBoy(Black) - Main.ba2"),
      e("Data/cccatalog.esm"),
      e("ScreenShot3.png"),
      e("Data/F4SE/Plugins/buffout.log"),
      e("Data/F4SE/Plugins/old.dll"),
      e("Data/MCM/Settings/old.ini"),
      e("dxgi.dll"),
    ]);
    expect(report.unmanaged.map((x) => x.path)).toEqual(["Data/F4SE/Plugins/old.dll", "Data/MCM/Settings/old.ini", "dxgi.dll"]);
    expect(report.counts).toEqual({
      deployed: 2,
      vanilla: 2,
      vortex: 3,
      declared: 1,
      creation: 3,
      tool: 0,
      "not-loaded": 1,
      volatile: 1,
      unmanaged: 3,
    });
  });

  it("does not report a vanilla file Vortex deployed over as a size mismatch", () => {
    const report = run([e("Data/Fallout4.esm", 999), e("steam_api64.dll", 51)]);
    expect(report.vanillaSizeMismatch).toEqual([{ path: "steam_api64.dll", expected: 50, actual: 51 }]);
  });

  it("reports missing REQUIRED store files only", () => {
    const report = run([e("Fallout4.exe", 100)]);
    // A manifest listing a file does not put it on disk: Data/Fallout4.esm is
    // "deployed" by record and still missing.
    expect(report.vanillaMissing).toEqual(["Data/Fallout4.esm", "Data/Video/Intro.bk2", "steam_api64.dll"]);
  });

  it("without a store record, reports no unmanaged files at all — it cannot tell the game's archives from a mod's", () => {
    const report = classifyGameFolder({
      entries: [e("Data/Fallout4 - Textures1.ba2"), e("Data/F4SE/Plugins/old.dll")],
      vanilla: { kind: "unknown", reason: "no record" },
      deployed: new Set(),
      creations: noCreations,
      declared: new Set(),
    });
    expect(report.unmanaged).toEqual([]);
    expect(report.vanilla).toEqual({ kind: "unknown", reason: "no record" });
  });
});

describe("groupEntries", () => {
  it("folds Data files into their top folder and keeps root files by name", () => {
    expect(groupEntries([e("Data/F4SE/a.dll", 2), e("data/f4se/b/c.dll", 3), e("dxgi.dll", 4), e("Data/x.esp", 1)])).toEqual([
      { group: "Data/F4SE", files: 2, bytes: 5 },
      { group: "Data/x.esp", files: 1, bytes: 1 },
      { group: "dxgi.dll", files: 1, bytes: 4 },
    ]);
  });
});

// ── disk ─────────────────────────────────────────────────────────────────

let tmp: string;
const write = (full: string, content: string | Buffer = "x"): void => {
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
};

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "eh-folder-"));
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("walkFolder", () => {
  it("on the load surface, walks Data (any case) and root files, and nothing else", async () => {
    const g = path.join(tmp, "game");
    write(path.join(g, "DATA", "a.esp"));
    write(path.join(g, "root.dll"));
    write(path.join(g, "Tools", "x.dll"));
    write(path.join(g, "Event Horizon quarantine", "q", "Data", "b.esp"));
    const walk = await walkFolder(g, { loadSurfaceOnly: true });
    expect(walk.entries.map((x) => x.path)).toEqual(["DATA/a.esp", "root.dll"]);
    const all = await walkFolder(g, { loadSurfaceOnly: false });
    expect(all.entries).toHaveLength(4);
  });
});

describe("loadVanillaList", () => {
  it("reads GOG's galaxy file list", async () => {
    const g = path.join(tmp, "Fallout 4 GOTY");
    write(path.join(g, "goggame-galaxyFileList.ini"), "[1998527297]\nF0=fce49f0d98c540e33c73dbe75acc4cc7\nF1=Fallout4.exe\n");
    const list = await loadVanillaList(g);
    expect(list.kind === "known" && list.source).toBe("gog");
    expect(list.kind === "known" && list.ownedRootPrefixes).toEqual(["goggame-1998527297."]);
  });

  it("is unknown when a GOG section lists fewer entries than it declares — a truncated list", async () => {
    const g = path.join(tmp, "Fallout 4 GOTY");
    write(path.join(g, "goggame-galaxyFileList.ini"), "[1998527297]\nfiles_counter=3\nF0=fce49f0d98c540e33c73dbe75acc4cc7\nF1=Fallout4.exe\n");
    const list = await loadVanillaList(g);
    expect(list.kind).toBe("unknown");
    expect(list.kind === "unknown" ? list.reason : "").toMatch(/declares 3, lists 2/);
  });

  it("is unknown when the GOG list holds only redistributables", async () => {
    const g = path.join(tmp, "Fallout 4 GOTY");
    write(path.join(g, "goggame-galaxyFileList.ini"), "[DirectX]\nfiles_counter=1\nF0=__redist\\DirectX\\x.cab\n");
    const list = await loadVanillaList(g);
    expect(list.kind === "unknown" ? list.reason : "").toMatch(/no game product section/);
  });

  it("is unknown when the record does not list the game's own executable", async () => {
    const g = path.join(tmp, "Fallout 4 GOTY");
    write(path.join(g, "goggame-galaxyFileList.ini"), "[1946160]\nfiles_counter=2\nF0=fce49f0d98c540e33c73dbe75acc4cc7\nF1=CreationKit.exe\n");
    const list = await loadVanillaList(g, { executable: "Fallout4.exe" });
    expect(list.kind === "unknown" ? list.reason : "").toMatch(/does not list the game's executable Fallout4\.exe/);
  });

  describe("Steam", () => {
    const lib = (): { game: string; steamapps: string } => {
      const steamapps = path.join(tmp, "SteamLibrary", "steamapps");
      return { steamapps, game: path.join(steamapps, "common", "Fallout 4") };
    };
    const acf = (steamapps: string, depots: string): void =>
      write(
        path.join(steamapps, "appmanifest_377160.acf"),
        `"AppState"\n{\n "appid" "377160"\n "installdir" "Fallout 4"\n "LauncherPath" "${path
          .join(tmp, "Steam", "steam.exe")
          .split("\\")
          .join("\\\\")}"\n "InstalledDepots"\n {\n${depots}\n }\n}\n`,
      );

    it("resolves the app manifest by install folder and reads every installed depot from Steam's depotcache", async () => {
      const { game, steamapps } = lib();
      fs.mkdirSync(game, { recursive: true });
      acf(steamapps, ' "377161" { "manifest" "111" "size" "10" }\n "377163" { "manifest" "333" "size" "0" }');
      write(
        path.join(tmp, "Steam", "depotcache", "377161_111.manifest"),
        buildDepotManifest([
          { name: "Fallout4.exe", size: 100 },
          { name: "Data\\Fallout4.esm", size: 300 },
        ]),
      );
      // With a trailing separator, as a hand-set Vortex path can have. Node's
      // basename/dirname already ignore it; pinned so a hand-rolled split cannot.
      const list = await loadVanillaList(game + path.sep);
      expect(list.kind).toBe("known");
      expect(list.kind === "known" ? list.files.map((f) => [f.path, f.size]) : []).toEqual([
        ["Fallout4.exe", 100],
        ["Data/Fallout4.esm", 300],
      ]);
    });

    it("is unknown — not a partial list — when a non-empty depot's manifest is missing", async () => {
      const { game, steamapps } = lib();
      fs.mkdirSync(game, { recursive: true });
      acf(steamapps, ' "377161" { "manifest" "111" "size" "10" }\n "377162" { "manifest" "222" "size" "99" }');
      write(path.join(tmp, "Steam", "depotcache", "377161_111.manifest"), buildDepotManifest([{ name: "Fallout4.exe", size: 1 }]));
      const list = await loadVanillaList(game);
      expect(list.kind).toBe("unknown");
      expect(list.kind === "unknown" ? list.reason : "").toMatch(/377162/);
    });

    it("is unknown when the file names are encrypted", async () => {
      const { game, steamapps } = lib();
      fs.mkdirSync(game, { recursive: true });
      acf(steamapps, ' "377161" { "manifest" "111" "size" "10" }');
      write(path.join(tmp, "Steam", "depotcache", "377161_111.manifest"), buildDepotManifest([{ name: "QUJD", size: 1 }], { encrypted: true }));
      expect((await loadVanillaList(game)).kind).toBe("unknown");
    });

    it("merges every app installed into the folder — a Creation Kit's manifest must not replace the game's", async () => {
      const { game, steamapps } = lib();
      fs.mkdirSync(game, { recursive: true });
      acf(steamapps, ' "377161" { "manifest" "111" "size" "10" }');
      // The Creation Kit is its own Steam app, installed into the game's folder,
      // and its appmanifest sorts BEFORE the game's.
      write(
        path.join(steamapps, "appmanifest_1946160.acf"),
        '"AppState"\n{\n "appid" "1946160"\n "installdir" "Fallout 4"\n "InstalledDepots"\n {\n  "1946161" { "manifest" "999" "size" "10" }\n }\n}\n',
      );
      write(
        path.join(tmp, "Steam", "depotcache", "377161_111.manifest"),
        buildDepotManifest([
          { name: "Fallout4.exe", size: 100 },
          { name: "Data\\Fallout4.esm", size: 300 },
        ]),
      );
      write(path.join(steamapps, "depotcache", "1946161_999.manifest"), buildDepotManifest([{ name: "CreationKit.exe", size: 5 }]));
      const list = await loadVanillaList(game, { executable: "Fallout4.exe" });
      expect(list.kind).toBe("known");
      expect(list.kind === "known" ? list.files.map((f) => f.path).sort() : []).toEqual([
        "CreationKit.exe",
        "Data/Fallout4.esm",
        "Fallout4.exe",
      ]);
    });

    it("is unknown while Steam is updating the game", async () => {
      const { game, steamapps } = lib();
      fs.mkdirSync(game, { recursive: true });
      write(
        path.join(steamapps, "appmanifest_377160.acf"),
        '"AppState"\n{\n "appid" "377160"\n "installdir" "Fallout 4"\n "StateFlags" "1026"\n "InstalledDepots"\n {\n  "377161" { "manifest" "111" "size" "10" }\n }\n}\n',
      );
      write(path.join(steamapps, "depotcache", "377161_111.manifest"), buildDepotManifest([{ name: "Fallout4.exe", size: 1 }]));
      const list = await loadVanillaList(game);
      expect(list.kind === "unknown" ? list.reason : "").toMatch(/StateFlags 1026/);
    });

    it("prefers Steam's record when a GOG file list was copied into a Steam install", async () => {
      const { game, steamapps } = lib();
      write(path.join(game, "goggame-galaxyFileList.ini"), "[1998527297]\nF1=Fallout4.exe\n");
      acf(steamapps, ' "377161" { "manifest" "111" "size" "10" }');
      write(
        path.join(tmp, "Steam", "depotcache", "377161_111.manifest"),
        buildDepotManifest([
          { name: "Fallout4.exe", size: 1 },
          { name: "steam_api64.dll", size: 1 },
        ]),
      );
      const list = await loadVanillaList(game);
      expect(list.kind === "known" && list.source).toBe("steam");
    });
  });

  it("is unknown, with the places it looked, for any other install", async () => {
    const list = await loadVanillaList(path.join(tmp, "Games", "Fallout 4"));
    expect(list.kind).toBe("unknown");
  });
});

describe("scanGameFolder", () => {
  it("resolves each Vortex manifest against its own target path, and finds only the leftover", async () => {
    const g = path.join(tmp, "Fallout 4 GOTY");
    const local = path.join(tmp, "Local", "Fallout4");
    write(
      path.join(g, "goggame-galaxyFileList.ini"),
      "[1998527297]\nF1=Fallout4.exe\nF2=Data\\Fallout4 - Textures1.ba2\nF3=Fallout4\\Fallout4Prefs.ini\n[DirectX]\nF1=__redist\\DirectX\\x.cab\n",
    );
    write(path.join(g, "Fallout4.exe"));
    write(path.join(g, "Fallout4", "Fallout4Prefs.ini"));
    write(path.join(g, "Fallout4.ccc"), "ccTest.esl\n");
    write(path.join(g, "Data", "ccTest.esl"));
    write(path.join(g, "Data", "ccTest - Main.ba2"));
    write(path.join(local, "ContentCatalog.txt"), JSON.stringify({ "CSV2_x": { Files: ["cccatalog.esm", "cccatalog - main.ba2"] } }));
    write(path.join(g, "Data", "cccatalog.esm"));
    write(path.join(g, "Data", "cccatalog - Main.ba2"));
    write(
      path.join(g, "Data", "vortex.deployment.json"),
      JSON.stringify({ targetPath: path.join(g, "Data"), files: [{ relPath: "F4SE\\Plugins\\mod.dll" }] }),
    );
    write(path.join(g, "vortex.deployment.dinput.json"), JSON.stringify({ targetPath: g, files: [{ relPath: "dxgi.dll" }] }));
    write(path.join(g, "Data", "F4SE", "Plugins", "mod.dll"));
    write(path.join(g, "dxgi.dll"));
    write(path.join(g, "Data", "__folder_managed_by_vortex"));
    write(path.join(g, "Data", "F4SE", "Plugins", "leftover.dll"));
    write(path.join(g, "Tools", "FO4Edit", "FO4Edit.exe"));

    const scan = await scanGameFolder({ gameDir: g, localGameDir: local, declared: new Set() });
    expect(scan.report.unmanaged.map((x) => x.path)).toEqual(["Data/F4SE/Plugins/leftover.dll"]);
    expect(scan.deployedCount).toBe(2);
    expect(scan.manifests.map((m) => m.file).sort()).toEqual(["Data/vortex.deployment.json", "vortex.deployment.dinput.json"]);
    // Outside the load surface, but the store requires it: stat'd, so not "missing".
    expect(scan.report.vanillaMissing).toEqual(["Data/Fallout4 - Textures1.ba2"]);
    expect(scan.report.counts.creation).toBe(4);
  });

  it("refuses to vouch for a folder that contains a link to somewhere else", async () => {
    const g = path.join(tmp, "Fallout 4 GOTY");
    write(path.join(g, "goggame-galaxyFileList.ini"), "[1998527297]\nF1=Fallout4.exe\n");
    write(path.join(g, "Fallout4.exe"));
    write(path.join(tmp, "elsewhere", "old.dds"));
    fs.mkdirSync(path.join(g, "Data"), { recursive: true });
    fs.symlinkSync(path.join(tmp, "elsewhere"), path.join(g, "Data", "Textures"), "junction");
    const scan = await scanGameFolder({ gameDir: g, declared: new Set() });
    expect(scan.linkedDirs).toEqual(["Data/Textures"]);
    expect(scan.report.vanilla.kind).toBe("unknown");
    expect(scan.report.unmanaged).toEqual([]);
  });

  it("leaves a root DLL alone when only a tool beside the game references it — never one the game names", async () => {
    const g = path.join(tmp, "Fallout 4 GOTY");
    write(path.join(g, "goggame-galaxyFileList.ini"), "[1998527297]\nfiles_counter=2\nF0=fce49f0d98c540e33c73dbe75acc4cc7\nF1=Fallout4.exe\n");
    write(path.join(g, "Fallout4.exe"), buildPe({ imports: [{ dll: "dxgi.dll", names: ["CreateDXGIFactory"] }] }));
    // A tool that loads its DLL by name at run time, and also mentions dxgi.dll.
    write(path.join(g, "CreationKit.exe"), Buffer.concat([buildPe({}), Buffer.from("LoadLibraryW flowchartx64.dll dxgi.dll", "latin1")]));
    write(path.join(g, "flowchartx64.dll"));
    write(path.join(g, "dxgi.dll"));
    const scan = await scanGameFolder({ gameDir: g, declared: new Set(), executable: "Fallout4.exe" });
    expect(scan.toolDlls).toEqual([{ dll: "flowchartx64.dll", owners: ["CreationKit.exe"] }]);
    expect(scan.report.unmanaged.map((e) => e.path)).toEqual(["dxgi.dll"]);
  });
});
