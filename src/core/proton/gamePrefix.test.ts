/**
 * The tester's machine, rebuilt in a temp folder: a Linux root (what Wine
 * shows as Z:) holding Heroic's settings and the game's prefix, and a separate
 * user folder standing for Vortex's own prefix. Pinned: the prefix comes from
 * the launcher's own record; a record that may be stale, or only names a
 * default, is not trusted; and "shared" is proven by a write — a link passes,
 * an identical copy does not, and the test file never stays behind.
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { probeWinePrefix } from "./gamePrefix";
import type { WineHost } from "./host";

let tmp: string;
/** The Linux root, "/". */
let root: string;
/** The GOG game folder, as Vortex reaches it. */
let game: string;
/** C:\users\steamuser in Vortex's prefix. */
let vortexUser: string;
let host: WineHost;

const HEROIC = "/home/deck/.config/heroic";
const PREFIX = "/home/deck/Games/Heroic/Prefixes/default/Fallout 4 GOTY";
const GAME_USER = `${PREFIX}/pfx/drive_c/users/steamuser`;

const write = (full: string, content: string | Buffer = "x"): void => {
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
};
/** A Linux path inside the fake root. */
const onLinux = (p: string): string => path.join(root, ...p.split("/").filter((s) => s.length > 0));

const heroicInstalled = (over: Record<string, unknown> = {}): void =>
  write(
    onLinux(`${HEROIC}/gog_store/installed.json`),
    JSON.stringify({ installed: [{ appName: "1998527297", install_path: "/home/deck/Games/Heroic/Fallout 4 GOTY", ...over }] }),
  );
const heroicGameConfig = (settings: Record<string, unknown>): void =>
  write(onLinux(`${HEROIC}/GamesConfig/1998527297.json`), JSON.stringify({ "1998527297": settings, version: "v0.1", explicit: true }));

const probe = () =>
  probeWinePrefix({
    gameDir: game,
    host,
    vortexUserDir: vortexUser,
    folders: [
      { label: "the INI files", vortexDir: path.join(vortexUser, "Documents", "My Games", "Fallout4") },
      { label: "plugins.txt, the load order", vortexDir: path.join(vortexUser, "AppData", "Local", "Fallout4") },
    ],
  });

/** What a Linux user does: replace Vortex's folder with a link to the game's. A junction needs no elevation on Windows. */
const linkToGame = (rel: string): void => {
  const mine = path.join(vortexUser, ...rel.split("/"));
  fs.rmSync(mine, { recursive: true, force: true });
  fs.symlinkSync(onLinux(`${GAME_USER}/${rel}`), mine, "junction");
};

const probeFilesLeft = (): string[] => {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name.startsWith(".event-horizon-prefix-probe-")) out.push(path.join(dir, e.name));
      else if (e.isDirectory()) walk(path.join(dir, e.name));
    }
  };
  walk(tmp);
  return out;
};

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "eh-wine-"));
  root = path.join(tmp, "root");
  game = path.join(tmp, "X", "Games", "Heroic", "Fallout 4 GOTY");
  vortexUser = path.join(tmp, "vortex-prefix", "drive_c", "users", "steamuser");
  host = { unixRoot: root, homes: ["/home/deck"] };
  write(path.join(game, "goggame-1998527297.info"), "{}");
  write(path.join(game, "Fallout4.exe"));
  // Vortex's own copies: what Vortex and an earlier INI apply wrote.
  write(path.join(vortexUser, "Documents", "My Games", "Fallout4", "Fallout4Prefs.ini"), "[Archive]\nbInvalidateOlderFiles=1\n");
  write(path.join(vortexUser, "AppData", "Local", "Fallout4", "plugins.txt"), "*Unofficial Fallout 4 Patch.esp\n");
  // The game's, in Heroic's prefix, where its launcher ran.
  write(onLinux(`${GAME_USER}/Documents/My Games/Fallout4/Fallout4Prefs.ini`), "[Display]\niSize W=1920\n");
  write(onLinux(`${GAME_USER}/AppData/Local/Fallout4/plugins.txt`), "");
  fs.mkdirSync(onLinux(`${PREFIX}/pfx/drive_c/users/Public`), { recursive: true });
  heroicInstalled();
  heroicGameConfig({ winePrefix: PREFIX, wineVersion: { type: "proton" } });
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("probeWinePrefix", () => {
  it("finds the tester's case: Heroic's prefix for the GOG game, and neither folder shared with Vortex's", async () => {
    const p = await probe();
    expect(p.game?.source).toBe("heroic");
    expect(p.game?.linuxPath).toBe(PREFIX);
    expect(p.game?.detail).toMatch(/GamesConfig\/1998527297\.json → winePrefix$/);
    expect(p.gameUserDir).toBe(onLinux(GAME_USER));
    expect(p.gameStarted).toBe(true);
    expect(p.folders.map((f) => [f.rel, f.state])).toEqual([
      ["Documents/My Games/Fallout4", "separate"],
      ["AppData/Local/Fallout4", "separate"],
    ]);
    expect(p.folders[0]?.detail).toMatch(/did not appear/);
    expect(p.folders[0]?.gameLinuxPath).toBe(`${GAME_USER}/Documents/My Games/Fallout4`);
    expect(probeFilesLeft()).toEqual([]);
  });

  it("passes folders linked to the game's — a file written on Vortex's side appears on the game's", async () => {
    linkToGame("Documents/My Games/Fallout4");
    linkToGame("AppData/Local/Fallout4");
    const p = await probe();
    expect(p.folders.map((f) => f.state)).toEqual(["shared", "shared"]);
    expect(p.folders[0]?.detail).toMatch(/appeared in the game's/);
    expect(probeFilesLeft()).toEqual([]);
  });

  it("does not take an identical copy for a shared folder", async () => {
    fs.copyFileSync(
      onLinux(`${GAME_USER}/Documents/My Games/Fallout4/Fallout4Prefs.ini`),
      path.join(vortexUser, "Documents", "My Games", "Fallout4", "Fallout4Prefs.ini"),
    );
    expect((await probe()).folders[0]?.state).toBe("separate");
  });

  it("calls a folder only one prefix has separate", async () => {
    fs.rmSync(onLinux(`${GAME_USER}/AppData/Local/Fallout4`), { recursive: true });
    expect((await probe()).folders[1]).toMatchObject({
      state: "separate",
      detail: "only Vortex's prefix has it",
      vortexExists: true,
      gameExists: false,
    });
  });

  it("decides a folder neither prefix has yet by the nearest parent both have", async () => {
    fs.rmSync(path.join(vortexUser, "AppData", "Local", "Fallout4"), { recursive: true });
    fs.rmSync(onLinux(`${GAME_USER}/AppData/Local/Fallout4`), { recursive: true });
    expect((await probe()).folders[1]).toMatchObject({
      state: "separate",
      detail: expect.stringMatching(/AppData\/Local is not shared/) as unknown as string,
    });
    // Linking the parent instead: whatever is created inside lands in the game's.
    fs.rmSync(path.join(vortexUser, "AppData", "Local"), { recursive: true });
    fs.symlinkSync(onLinux(`${GAME_USER}/AppData/Local`), path.join(vortexUser, "AppData", "Local"), "junction");
    expect((await probe()).folders[1]).toMatchObject({
      state: "shared",
      detail: expect.stringMatching(/where it will be created, is shared/) as unknown as string,
    });
    expect(probeFilesLeft()).toEqual([]);
  });

  it("does not probe for a game that has never been started in its prefix", async () => {
    fs.rmSync(onLinux(`${GAME_USER}/Documents/My Games`), { recursive: true });
    const p = await probe();
    expect(p.game?.linuxPath).toBe(PREFIX);
    expect(p.gameStarted).toBe(false);
    expect(p.folders).toEqual([]);
  });

  it("finds Heroic's Flatpak settings, expands ~, and reads a Wine prefix with drive_c at its top", async () => {
    fs.rmSync(onLinux("/home/deck/.config"), { recursive: true });
    const flatpak = "/home/deck/.var/app/com.heroicgameslauncher.hgl/config/heroic";
    write(
      onLinux(`${flatpak}/gog_store/installed.json`),
      JSON.stringify({ installed: [{ appName: "1998527297", install_path: "/home/deck/Games/Heroic/Fallout 4 GOTY" }] }),
    );
    write(onLinux(`${flatpak}/GamesConfig/1998527297.json`), JSON.stringify({ "1998527297": { winePrefix: "~/Wine/fo4" } }));
    write(onLinux("/home/deck/Wine/fo4/drive_c/users/deck/Documents/My Games/Fallout4/Fallout4Prefs.ini"), "[Display]\n");
    const p = await probe();
    expect(p.game?.linuxPath).toBe("/home/deck/Wine/fo4");
    expect(p.gameUserDir).toBe(onLinux("/home/deck/Wine/fo4/drive_c/users/deck"));
  });

  it("ignores a Heroic record for a game Heroic does not list as installed, or installed in another folder", async () => {
    heroicInstalled({ appName: "1207658924" });
    let p = await probe();
    expect(p.game).toBeUndefined();
    expect(p.looked.join("\n")).toMatch(/1998527297 is not installed through Heroic/);
    heroicInstalled({ install_path: "/home/deck/Games/Other/Fallout 4" });
    p = await probe();
    expect(p.game).toBeUndefined();
    expect(p.looked.join("\n")).toMatch(/not in the folder Vortex manages/);
  });

  it("trusts Heroic's default prefix only when it holds the game's settings", async () => {
    heroicGameConfig({});
    write(onLinux(`${HEROIC}/config.json`), JSON.stringify({ defaultSettings: { winePrefix: PREFIX }, version: "v0" }));
    expect((await probe()).game).toMatchObject({ linuxPath: PREFIX, explicit: false });
    fs.rmSync(onLinux(`${GAME_USER}/Documents/My Games`), { recursive: true });
    const p = await probe();
    expect(p.game).toBeUndefined();
    expect(p.unresolved).toMatch(/^Only a default prefix is recorded/);
  });

  it("finds a Steam game's Proton prefix in its library's compatdata", async () => {
    const steamapps = onLinux("/home/deck/.local/share/Steam/steamapps");
    game = path.join(steamapps, "common", "Fallout 4");
    write(path.join(game, "Fallout4.exe"));
    write(path.join(steamapps, "appmanifest_377160.acf"), '"AppState"\n{\n "appid" "377160"\n "installdir" "Fallout 4"\n}\n');
    const user = path.join(steamapps, "compatdata", "377160", "pfx", "drive_c", "users", "steamuser");
    write(path.join(user, "Documents", "My Games", "Fallout4", "Fallout4Prefs.ini"), "[Display]\n");
    const p = await probe();
    expect(p.game).toMatchObject({
      source: "steam",
      appId: "377160",
      linuxPath: "/home/deck/.local/share/Steam/steamapps/compatdata/377160",
    });
    expect(p.gameUserDir).toBe(user);
  });

  it("picks the user folder that holds the game's settings, not the one named like Vortex's", async () => {
    fs.rmSync(onLinux(`${GAME_USER}/Documents/My Games`), { recursive: true });
    write(onLinux(`${PREFIX}/pfx/drive_c/users/deck/Documents/My Games/Fallout4/Fallout4Prefs.ini`), "[Display]\n");
    expect((await probe()).gameUserDir).toBe(onLinux(`${PREFIX}/pfx/drive_c/users/deck`));
  });

  it("says why it found nothing, and where it looked", async () => {
    fs.rmSync(path.join(game, "goggame-1998527297.info"));
    const p = await probe();
    expect(p.game).toBeUndefined();
    expect(p.unresolved).toBe("No Heroic or Steam record names a prefix for this game.");
    expect(p.looked.join("\n")).toMatch(/no goggame-<id>\.info/);
  });

  it("finds the home under /home when Wine did not name it", async () => {
    host = { unixRoot: root, homes: [] };
    expect((await probe()).game?.linuxPath).toBe(PREFIX);
  });
});
