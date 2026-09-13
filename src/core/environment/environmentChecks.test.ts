/**
 * The verdicts, from facts. Each case is a tester's machine: a game never
 * "Managed" in Vortex, a game never started, a GOG DLL in a Steam install, a
 * game under Program Files. What matters as much as blocking those is NOT
 * blocking when a probe merely could not run.
 */
import { describe, expect, it } from "vitest";

import {
  blockingChecks,
  decideBinaryImports,
  decideGameFolder,
  decideGameManaged,
  decideIniLeftovers,
  decideLauncherRan,
  decideProtectedLocation,
  decideWinePrefix,
  describeBlockedChecks,
  protectedRootOf,
} from "./environmentChecks";
import type { GameFolderScan } from "./gameFolderScan";
import type { FolderShare, WinePrefixProbe } from "./winePrefix";

const G = "Fallout 4";

describe("decideGameManaged", () => {
  const base = { gameName: G, discoveredPath: "E:/Games/Fallout 4", executable: "Fallout4.exe", dirExists: true, exeExists: true };

  it("blocks when Vortex has no folder for the game (never pressed Manage)", () => {
    const c = decideGameManaged({ ...base, discoveredPath: undefined, dirExists: false, exeExists: false });
    expect(c.status).toBe("blocked");
    expect(c.steps.join(" ")).toMatch(/Manage/);
  });

  it("blocks when the folder is gone or the executable is not in it", () => {
    expect(decideGameManaged({ ...base, dirExists: false, exeExists: false }).status).toBe("blocked");
    expect(decideGameManaged({ ...base, exeExists: false }).status).toBe("blocked");
  });

  it("does not block when the executable name cannot be determined", () => {
    expect(decideGameManaged({ ...base, executable: undefined, exeExists: false }).status).toBe("unknown");
  });

  it("passes a managed, installed game", () => {
    expect(decideGameManaged(base).status).toBe("ok");
  });
});

describe("protectedRootOf / decideProtectedLocation", () => {
  const roots = ["C:\\Program Files", "C:\\Program Files (x86)"];

  it("matches regardless of case and separator", () => {
    expect(protectedRootOf("c:/program files (x86)/Steam/steamapps/common/Fallout 4", roots)).toBe(
      "C:\\Program Files (x86)",
    );
    expect(protectedRootOf("C:\\Program Files\\Bethesda\\Fallout 4\\", roots)).toBe("C:\\Program Files");
  });

  it("does not treat a sibling with the same prefix as inside", () => {
    expect(protectedRootOf("C:\\Program Files Games\\Fallout 4", roots)).toBeUndefined();
    expect(protectedRootOf("E:\\SteamLibrary\\steamapps\\common\\Fallout 4", roots)).toBeUndefined();
  });

  it("blocks under Program Files, with store-specific steps", () => {
    const c = decideProtectedLocation({
      gameName: G,
      gameDir: "C:/Program Files (x86)/Steam/steamapps/common/Fallout 4",
      protectedRoots: roots,
      wine: false,
      store: "steam",
    });
    expect(c.status).toBe("blocked");
    expect(c.steps[0]).toMatch(/Steam → Settings → Storage/);
  });

  it("never blocks under Wine, where Windows folder protection does not exist", () => {
    const c = decideProtectedLocation({
      gameName: G,
      gameDir: "C:/Program Files (x86)/Steam/steamapps/common/Fallout 4",
      protectedRoots: roots,
      wine: true,
      store: "steam",
    });
    expect(c.status).toBe("ok");
  });

  it("ignores empty roots rather than matching everything", () => {
    expect(protectedRootOf("E:\\Games\\Fallout 4", ["", "  "])).toBeUndefined();
  });
});

describe("decideLauncherRan", () => {
  it("blocks when the launcher's Prefs file does not exist", () => {
    const c = decideLauncherRan({ gameName: G, prefsPath: "C:/Docs/My Games/Fallout4/Fallout4Prefs.ini", exists: false });
    expect(c.status).toBe("blocked");
    expect(c.lines[0]).toMatch(/Fallout4Prefs\.ini/);
  });

  it("is unknown, not blocked, when no layout is known", () => {
    expect(decideLauncherRan({ gameName: G, prefsPath: undefined, exists: false }).status).toBe("unknown");
  });

  it("passes when it exists", () => {
    expect(decideLauncherRan({ gameName: G, prefsPath: "x/Fallout4Prefs.ini", exists: true }).status).toBe("ok");
  });
});

describe("decideBinaryImports", () => {
  const finding = {
    exe: "Fallout4Launcher.exe",
    dll: "steam_api64.dll",
    missing: ["SteamInternal_CreateInterface"],
  };

  it("blocks when a store-installed DLL lacks what a store executable imports", () => {
    const c = decideBinaryImports({ gameName: G, checked: ["Fallout4Launcher.exe"], findings: [{ ...finding, dllIsVanilla: true }] });
    expect(c.status).toBe("blocked");
    expect(c.lines[0]).toMatch(/SteamInternal_CreateInterface/);
    expect(c.steps.join(" ")).toMatch(/Verify integrity/);
  });

  it("only warns for a DLL the store did not install — a mod or tool may replace it", () => {
    const c = decideBinaryImports({ gameName: G, checked: ["Fallout4.exe"], findings: [{ ...finding, dllIsVanilla: false }] });
    expect(c.status).toBe("warning");
  });

  it("passes with no findings", () => {
    expect(decideBinaryImports({ gameName: G, checked: ["Fallout4.exe"], findings: [] }).status).toBe("ok");
  });
});

const scan = (over: Partial<GameFolderScan["report"]>, deployedCount = 0): GameFolderScan => ({
  report: {
    vanilla: { kind: "known", source: "gog", detail: "list", files: 10 },
    counts: { deployed: 0, vanilla: 10, vortex: 0, declared: 0, creation: 0, tool: 0, "not-loaded": 0, volatile: 0, unmanaged: 0 },
    unmanaged: [],
    vanillaMissing: [],
    vanillaSizeMismatch: [],
    ...over,
  },
  manifests: [],
  deployedCount,
  unreadable: [],
  linkedDirs: [],
  creationSources: [],
  toolDlls: [],
});

describe("decideGameFolder", () => {
  it("never blocks — a dirty folder is cleaned at Install, not refused", () => {
    const c = decideGameFolder({
      gameName: G,
      scan: scan({ unmanaged: [{ path: "Data/F4SE/Plugins/old.dll", size: 1, mtimeMs: 0 }] }, 12),
    });
    expect(c.status).toBe("warning");
    expect(c.lines.join("\n")).toMatch(/Data\/F4SE — 1 file/);
    expect(c.lines.join("\n")).toMatch(/12 mod files deployed/);
  });

  it("warns, with the reason, when there is no store record", () => {
    const c = decideGameFolder({ gameName: G, scan: scan({ vanilla: { kind: "unknown", reason: "no record" } }) });
    expect(c.status).toBe("warning");
    expect(c.lines).toEqual(["no record"]);
  });

  it("passes a clean game", () => {
    expect(decideGameFolder({ gameName: G, scan: scan({}) }).status).toBe("ok");
  });
});

describe("describeBlockedChecks", () => {
  it("lists only blocked checks, each with its steps", () => {
    const checks = [
      decideLauncherRan({ gameName: G, prefsPath: "x/Fallout4Prefs.ini", exists: false }),
      decideGameManaged({ gameName: G, discoveredPath: "x", executable: "Fallout4.exe", dirExists: true, exeExists: true }),
    ];
    expect(blockingChecks(checks).map((c) => c.id)).toEqual(["launcher-ran"]);
    const text = describeBlockedChecks(checks);
    expect(text).toMatch(/never been started/);
    expect(text).toMatch(/What to do:/);
    expect(text).not.toMatch(/Vortex manages/);
  });
});

describe("checks that could not run say unknown, never ok", () => {
  it("Program Files: no roots reported", () => {
    expect(
      decideProtectedLocation({ gameName: G, gameDir: "C:/Program Files/x", protectedRoots: [], wine: false, store: "steam" }).status,
    ).toBe("unknown");
  });

  it("DLL imports: no executable could be read", () => {
    const c = decideBinaryImports({ gameName: G, checked: [], findings: [], unreadable: ["Fallout4.exe"] });
    expect(c.status).toBe("unknown");
    expect(c.lines).toEqual(["Unreadable: Fallout4.exe"]);
  });
});

describe("decideLauncherRan — what wrote the file", () => {
  const base = { gameName: G, prefsPath: "C:/Docs/My Games/Fallout4/Fallout4Prefs.ini", exists: true };

  it("blocks when the file holds no launcher-written hardware settings", () => {
    const c = decideLauncherRan({ ...base, launcherWrote: false, hasLauncher: true, store: "steam" });
    expect(c.status).toBe("blocked");
    expect(c.title).toMatch(/not created by the game/);
    expect(c.steps[0]).toMatch(/from Steam/);
  });

  it("names the right place to start the game from, and does not ask for a launcher a game lacks", () => {
    const xbox = decideLauncherRan({ ...base, exists: false, hasLauncher: true, store: "xbox" });
    expect(xbox.steps[0]).toMatch(/from the Xbox app/);
    const starfield = decideLauncherRan({ ...base, gameName: "Starfield", exists: false, hasLauncher: false, store: "steam" });
    expect(starfield.steps[0]).toMatch(/wait for the main menu/);
    expect(starfield.steps[0]).not.toMatch(/launcher/);
  });

  it("passes when the launcher's contents cannot be judged", () => {
    expect(decideLauncherRan({ ...base, launcherWrote: undefined }).status).toBe("ok");
  });
});

describe("decideLauncherRan — under Wine", () => {
  const base = {
    gameName: G,
    prefsPath: "C:/users/steamuser/Documents/My Games/Fallout4/Fallout4Prefs.ini",
    exists: true,
    launcherWrote: false,
    hasLauncher: true,
    store: "gog",
    wine: true,
  };

  it("says the file was read in Vortex's prefix when the game's was not found, and names Heroic for a GOG game", () => {
    const c = decideLauncherRan(base);
    expect(c.status).toBe("blocked");
    expect(c.lines.join("\n")).toMatch(/the prefix Vortex runs in/);
    expect(c.steps[0]).toMatch(/from Heroic, or whichever launcher you play it with/);
  });

  it("names the launcher whose prefix it read, and does not point at Vortex's prefix", () => {
    const c = decideLauncherRan({ ...base, launcher: "heroic" });
    expect(c.steps[0]).toMatch(/once from Heroic — /);
    expect(c.lines.join("\n")).not.toMatch(/the prefix Vortex runs in/);
  });

  it("keeps GOG Galaxy's wording off Wine", () => {
    expect(decideLauncherRan({ ...base, wine: false }).steps[0]).toMatch(/from GOG Galaxy or its desktop shortcut/);
  });
});

describe("decideWinePrefix", () => {
  const HEROIC_PREFIX = "/home/deck/Games/Heroic/Prefixes/default/Fallout 4 GOTY";
  const VORTEX_PREFIX = "/home/deck/Vortex/pfx";
  const folder = (over: Partial<FolderShare> = {}): FolderShare => ({
    label: "the INI files",
    rel: "Documents/My Games/Fallout4",
    vortexDir: "C:\\users\\steamuser\\Documents\\My Games\\Fallout4",
    gameDir: "Z:\\home\\deck\\Games\\Heroic\\Prefixes\\default\\Fallout 4 GOTY\\pfx\\drive_c\\users\\steamuser\\Documents\\My Games\\Fallout4",
    vortexExists: true,
    gameExists: true,
    vortexLinuxPath: `${VORTEX_PREFIX}/drive_c/users/steamuser/Documents/My Games/Fallout4`,
    gameLinuxPath: `${HEROIC_PREFIX}/pfx/drive_c/users/steamuser/Documents/My Games/Fallout4`,
    state: "separate",
    detail: "a test file written into Vortex's copy did not appear in the game's",
    ...over,
  });
  const plugins = folder({
    label: "plugins.txt, the load order",
    rel: "AppData/Local/Fallout4",
    vortexLinuxPath: `${VORTEX_PREFIX}/drive_c/users/steamuser/AppData/Local/Fallout4`,
    gameLinuxPath: `${HEROIC_PREFIX}/pfx/drive_c/users/steamuser/AppData/Local/Fallout4`,
    gameExists: false,
    detail: "only Vortex's prefix has it",
  });
  const probe = (over: Partial<WinePrefixProbe> = {}): WinePrefixProbe => ({
    host: { unixRoot: "Z:\\", homes: ["/home/deck"], vortexPrefix: VORTEX_PREFIX },
    looked: [],
    candidates: [],
    game: {
      source: "heroic",
      detail: "/home/deck/.config/heroic/GamesConfig/1998527297.json → winePrefix",
      reached: "Z:\\home\\deck\\Games\\Heroic\\Prefixes\\default\\Fallout 4 GOTY",
      linuxPath: HEROIC_PREFIX,
      explicit: true,
      driveC: "Z:\\home\\deck\\Games\\Heroic\\Prefixes\\default\\Fallout 4 GOTY\\pfx\\drive_c",
    },
    vortexUserDir: "C:\\users\\steamuser",
    gameUserDir: "Z:\\home\\deck\\Games\\Heroic\\Prefixes\\default\\Fallout 4 GOTY\\pfx\\drive_c\\users\\steamuser",
    gameStarted: true,
    folders: [folder(), plugins],
    ...over,
  });

  it("blocks the tester's case, naming both prefixes and each folder that is not shared", () => {
    const c = decideWinePrefix({ gameName: G, probe: probe() });
    expect(c.status).toBe("blocked");
    expect(c.lines.slice(0, 2)).toEqual([
      `Fallout 4 runs in the prefix Heroic keeps for it: ${HEROIC_PREFIX} (/home/deck/.config/heroic/GamesConfig/1998527297.json → winePrefix).`,
      `Vortex runs in the prefix ${VORTEX_PREFIX}.`,
    ]);
    expect(c.lines.filter((l) => l.startsWith("Not shared — "))).toHaveLength(2);
  });

  it("gives link commands that keep Vortex's old folder, and create the game's when it does not exist yet", () => {
    const [close, ini, load] = decideWinePrefix({ gameName: G, probe: probe() }).steps;
    expect(close).toBe("Close Vortex.");
    expect(ini).toBe(
      "Link the INI files to the game's folder. In a terminal: " +
        `mv '${VORTEX_PREFIX}/drive_c/users/steamuser/Documents/My Games/Fallout4' '${VORTEX_PREFIX}/drive_c/users/steamuser/Documents/My Games/Fallout4.before-link'` +
        ` && ln -s '${HEROIC_PREFIX}/pfx/drive_c/users/steamuser/Documents/My Games/Fallout4' '${VORTEX_PREFIX}/drive_c/users/steamuser/Documents/My Games/Fallout4'`,
    );
    expect(load).toMatch(
      new RegExp(`^Link plugins\\.txt, the load order to the game's folder\\. In a terminal: mkdir -p '${HEROIC_PREFIX}/pfx/drive_c/users/steamuser/AppData/Local/Fallout4' && mv `),
    );
  });

  it("quotes an apostrophe in a path for the shell", () => {
    const c = decideWinePrefix({ gameName: G, probe: probe({ folders: [folder({ gameLinuxPath: "/home/deck/Bob's Games/Fallout4" })] }) });
    expect(c.steps[1]).toContain("ln -s '/home/deck/Bob'\\''s Games/Fallout4' ");
  });

  it("offers running Vortex inside the game's prefix instead of linking — Heroic's or Steam's way", () => {
    expect(decideWinePrefix({ gameName: G, probe: probe() }).steps.join("\n")).toContain(`set its Wine prefix to ${HEROIC_PREFIX}.`);
    const steam = probe({
      game: { source: "steam", detail: "appmanifest", reached: "Z:\\s\\compatdata\\377160", explicit: true, appId: "377160", driveC: "Z:\\s" },
    });
    expect(decideWinePrefix({ gameName: G, probe: steam }).steps.join("\n")).toContain("protontricks-launch --appid 377160");
  });

  it("without Linux paths, still says which folder to replace with a link to which", () => {
    const { vortexLinuxPath: _dropped, ...noLinux } = folder();
    const c = decideWinePrefix({ gameName: G, probe: probe({ folders: [noLinux] }) });
    expect(c.steps[1]).toBe(
      "Replace C:\\users\\steamuser\\Documents\\My Games\\Fallout4 in Vortex's prefix with a link to Z:\\home\\deck\\Games\\Heroic\\Prefixes\\default\\Fallout 4 GOTY\\pfx\\drive_c\\users\\steamuser\\Documents\\My Games\\Fallout4, keeping the old folder under another name.",
    );
  });

  it("passes when every folder is shared", () => {
    const shared = folder({ state: "shared", detail: "a test file written into Vortex's copy appeared in the game's" });
    const c = decideWinePrefix({ gameName: G, probe: probe({ folders: [shared, { ...shared, rel: "AppData/Local/Fallout4" }] }) });
    expect(c.status).toBe("ok");
    expect(c.lines.slice(2)).toEqual([
      "Shared — the INI files: Documents/My Games/Fallout4 — a test file written into Vortex's copy appeared in the game's.",
      "Shared — the INI files: AppData/Local/Fallout4 — a test file written into Vortex's copy appeared in the game's.",
    ]);
  });

  it("never blocks on what it could not establish", () => {
    const { game: _game, ...noGame } = probe();
    const notFound = decideWinePrefix({ gameName: G, probe: { ...noGame, unresolved: "No Heroic or Steam record names a prefix for this game." } });
    expect(notFound.status).toBe("unknown");
    expect(notFound.lines[0]).toBe("No Heroic or Steam record names a prefix for this game.");
    const { gameUserDir: _user, ...noUser } = probe();
    expect(decideWinePrefix({ gameName: G, probe: noUser }).status).toBe("unknown");
    expect(decideWinePrefix({ gameName: G, probe: probe({ gameStarted: false, folders: [] }) }).status).toBe("unknown");
    expect(decideWinePrefix({ gameName: G, probe: probe({ folders: [folder({ state: "unprobed", detail: "EACCES" })] }) }).status).toBe(
      "unknown",
    );
    expect(decideWinePrefix({ gameName: G, probe: probe({ folders: [] }) }).status).toBe("unknown");
  });
});

describe("decideIniLeftovers", () => {
  it("is unknown without the game's defaults to compare against", () => {
    expect(decideIniLeftovers({ gameName: G, defaultsFile: undefined, leftovers: [] }).status).toBe("unknown");
  });

  it("passes with nothing left over, and warns — never blocks — otherwise", () => {
    expect(decideIniLeftovers({ gameName: G, defaultsFile: "Fallout4_Default.ini", leftovers: [] }).status).toBe("ok");
    const c = decideIniLeftovers({
      gameName: G,
      defaultsFile: "Fallout4_Default.ini",
      leftovers: [
        { file: "Fallout4Custom.ini", key: "sResourceDataDirsFinal", value: "", defaultValue: "STRINGS\\" },
        { file: "Fallout4.ini", key: "sResourceArchive2List", value: "Old.ba2" },
      ],
    });
    expect(c.status).toBe("warning");
    expect(c.lines).toEqual([
      "Fallout4Custom.ini: sResourceDataDirsFinal= (game default: STRINGS\\)",
      "Fallout4.ini: sResourceArchive2List=Old.ba2 (game default: not set)",
    ]);
  });
});

describe("decideGameFolder — what it did not check, and what it left alone", () => {
  it("says a GOG record is presence-only, and names tool DLLs it leaves alone", () => {
    const s = scan({});
    s.toolDlls = [{ dll: "flowchartx64.dll", owners: ["CreationKit.exe"] }];
    const c = decideGameFolder({ gameName: G, scan: s });
    expect(c.status).toBe("ok");
    expect(c.lines.join("\n")).toMatch(/presence, not content/);
    expect(c.lines.join("\n")).toMatch(/flowchartx64\.dll \(CreationKit\.exe\)/);
  });
});
