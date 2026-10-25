/**
 * ──────────────────────────────────────────────────────────────────────
 * The game's own INI settings — shipped, minus the ones that belong to the
 * machine rather than to the collection.
 *
 * A Creation Engine collection is not only its mods. `uGridsToLoad`,
 * `bInvalidateOlderFiles`, the Papyrus block, resource directories — these
 * change how the game loads and behaves, they are part of what the curator
 * tuned, and none of them were in the package. Measured on a real Fallout 4
 * setup: 328 settings across three files, all of them absent from every
 * `.ehcoll` built so far.
 *
 * ## Why this cannot be a straight copy
 *
 * The same files hold settings that describe the CURATOR'S HARDWARE. Copying
 * those onto somebody else is worse than shipping nothing:
 *
 *   iSize W / iSize H         their monitor, not yours (1920x1080 here)
 *   iNumHWThreads             their CPU (4 here)
 *   iMaxAllocatedMemoryBytes  their RAM
 *   bFull Screen / bBorderless / bTopMostWindow / iPresentInterval
 *                             their display and VSync preference
 *   sAudioDevice / bEnableAudio
 *                             their sound hardware
 *   fDefault*FOV              a matter of taste, and motion sickness
 *
 * So each key is owned by either the COLLECTION or the MACHINE, and only
 * collection-owned keys are applied on install. The list below is the whole
 * of that judgement, in one place, so it can be argued with.
 *
 * ## The list is a denylist, and that has a known failure mode
 *
 * Anything not named here is applied. A hardware key nobody classified will
 * therefore reach the user — so `machineOwnedKeys` errs toward including
 * things, and anything matching the shape of a display, device or thread
 * setting belongs in it even if it is rarely set.
 * ──────────────────────────────────────────────────────────────────────
 */

import { existsSync, statSync } from "fs";

import { toPosix } from "../paths";

import { ehLog } from "../logging/ehLog";
import * as fsp from "fs/promises";
import * as path from "path";

/** One `key=value`, with the section it came from. */
export type IniSetting = {
  /** Section name without brackets, e.g. `Display`. Empty for keys above any section. */
  section: string;
  key: string;
  value: string;
};

/** One INI file's parsed contents. */
export type IniFileSnapshot = {
  /** File name only, e.g. `Fallout4Prefs.ini`. Never a full path — that is the curator's disk. */
  fileName: string;
  settings: IniSetting[];
};

/**
 * INI files that make up a game's configuration, in Vortex's own load order:
 * later files override earlier ones, and `*Custom.ini` is where hand edits go.
 */
const INI_FILES_BY_GAME: Record<
  string,
  {
    folder: string;
    files: string[];
    /**
     * The game's own launcher writes the Prefs file after detecting the
     * hardware (screen size, adapter). Starfield has no launcher: the game
     * writes it, and what it contains was never measured — so it is not judged.
     */
    launcherWritesPrefs: boolean;
  }
> = {
  fallout4: {
    folder: "Fallout4",
    files: ["Fallout4.ini", "Fallout4Prefs.ini", "Fallout4Custom.ini"],
    launcherWritesPrefs: true,
  },
  skyrimse: {
    folder: "Skyrim Special Edition",
    files: ["Skyrim.ini", "SkyrimPrefs.ini", "SkyrimCustom.ini"],
    launcherWritesPrefs: true,
  },
  fallout3: { folder: "Fallout3", files: ["Fallout.ini", "FalloutPrefs.ini"], launcherWritesPrefs: true },
  falloutnv: { folder: "FalloutNV", files: ["Fallout.ini", "FalloutPrefs.ini"], launcherWritesPrefs: true },
  starfield: {
    folder: "Starfield",
    files: ["StarfieldPrefs.ini", "StarfieldCustom.ini"],
    launcherWritesPrefs: false,
  },
};

/**
 * Keys that describe the machine or the person, never the collection.
 *
 * Matched case-insensitively against the key name alone, because the same key
 * appears under different sections across games. Prefix matches are used where
 * a family shares a stem (`iSize W`, `iSize H`).
 */
const MACHINE_OWNED = [
  // Display and window
  "isize w",
  "isize h",
  "bfull screen",
  "bfullscreen",
  "bborderless",
  "btopmostwindow",
  "bmaximizewindow",
  "ipresentinterval", // VSync
  "ilocation", // window position (iLocation X/Y): a curator's 0,0 put the game on another screen
  "imultisample", // MSAA level: Ivy 1.0.56 shipped 16x, a fresh player crashed seconds in
  "iadapter",
  "sd3ddevice",
  "uidisplay",
  "benablefilewatcher",
  // Field of view — taste, and a motion-sickness trigger
  "fdefaultworldfov",
  "fdefault1stpersonfov",
  "fdefaultfov",
  // CPU / memory
  "inumhwthreads",
  "imaxallocatedmemorybytes",
  "busethreadedai",
  "inumthreads",
  // Audio hardware
  "saudiodevice",
  "benableaudio",
  "imaxdesired",
  // Language / locale
  "slanguage",
  // Personal counters and session state — not settings at all. Shipping a
  // screenshot index tells the user how many screenshots the curator took and
  // then renumbers theirs.
  "iscreenshotindex",
  "sscreenshotbasename",
] as const;

/** Is this key the user's business rather than the collection's? */
export function isMachineOwned(key: string): boolean {
  const k = key.trim().toLowerCase();
  return MACHINE_OWNED.some((owned) => k === owned || k.startsWith(`${owned} `));
}

/** The machine-owned keys, for surfacing to a curator or a user. */
export function machineOwnedKeys(): readonly string[] {
  return MACHINE_OWNED;
}

/**
 * ─── THE PLAYER'S OWN PREFERENCES ──────────────────────────────────────
 * Not hardware, and still not the collection's: how loud, how hard, what
 * colour, which buttons. Ivy Rev 26 (alasdairn, 2026-10-25) set 15 of a
 * player's Fallout4Prefs.ini values to the curator's — difficulty, crosshair,
 * every volume slider — and `bFreebiesSeen 1→0`, which brings back the
 * Creations "free items" box at the main menu.
 *
 * Unlike the machine list these are judged by SECTION as well as key, because
 * the names alone are not distinctive (`fVal7`, `uID7`). `key: "*"` is the
 * whole section; a trailing `*` is a prefix.
 *
 * {@link PERSONAL_RULES_VERSION} goes into every package built with this list,
 * so an install knows the build already applied it — and applies it itself to
 * packages built before it existed.
 */
const PERSONAL: ReadonlyArray<{ section: string; key: string }> = [
  // Volume sliders and their ids
  { section: "audiomenu", key: "*" },
  // Launcher, Bethesda.net account ids, the Creations menu
  { section: "launcher", key: "*" },
  { section: "bethesda.net", key: "*" },
  { section: "creationsmenu", key: "*" },
  // Mouse, gamepad, run, invert, rumble
  { section: "controls", key: "*" },
  { section: "gameplay", key: "idifficulty" },
  { section: "gameplay", key: "bshowfloatingquestmarkers" },
  { section: "gameplay", key: "bshowquestmarkers" },
  { section: "main", key: "bcrosshairenabled" },
  { section: "main", key: "fhudopacity" },
  { section: "main", key: "bsaveon*" },
  { section: "savegame", key: "fautosaveeveryxmins" },
  // Seen-it flags and store state: shipping 0 brings the popups back
  { section: "general", key: "bfreebiesseen" },
  { section: "general", key: "bincludedcontentmessageseen" },
  { section: "general", key: "bupsellowned" },
  { section: "general", key: "uimarketplaceupdatedhash" },
  { section: "general", key: "bshowdownloadanniversarycontent" },
  { section: "general", key: "bgamepadenable" },
  { section: "general", key: "bpipboycompanionenabled" },
  // HUD, subtitles, Pip-Boy and VATS colours
  { section: "interface", key: "ihudcolor*" },
  { section: "interface", key: "fhudopacity" },
  { section: "interface", key: "bdialoguesubtitles" },
  { section: "interface", key: "bgeneralsubtitles" },
  { section: "interface", key: "bdialoguecameraenable" },
  { section: "interface", key: "bshowcompass" },
  { section: "interface", key: "uhudactiveeffectwidget" },
  { section: "pipboy", key: "fpipboyeffectcolor*" },
  { section: "vats", key: "fmodmenueffect*" },
];

/** Bumped whenever {@link PERSONAL} changes meaning. */
export const PERSONAL_RULES_VERSION = 1;

const ruleMatches = (rule: string, value: string): boolean =>
  rule === "*" || (rule.endsWith("*") ? value.startsWith(rule.slice(0, -1)) : value === rule);

/** Is this setting the player's own preference rather than the collection's? */
export function isPersonalSetting(section: string, key: string): boolean {
  const s = section.trim().toLowerCase();
  const k = key.trim().toLowerCase();
  return PERSONAL.some((r) => r.section.toLowerCase() === s && ruleMatches(r.key, k));
}

/**
 * The curator's own trim, from the collection config: `File:Section:Key`
 * patterns, `*` matching anything, case-insensitive
 * (`Fallout4Prefs.ini:AudioMenu:*`, `*:General:bFreebiesSeen`).
 *
 * `exclude` leaves a setting out. `include` ships a setting the personal list
 * would leave out. Exclude wins over include, and nothing ships a
 * machine-owned key.
 */
export type GameIniFilter = { exclude?: string[]; include?: string[] };

/** Why a pattern is not usable, or undefined when it is. */
export function iniPatternProblem(pattern: string): string | undefined {
  const parts = pattern.split(":");
  if (parts.length !== 3 || parts.some((p) => p.trim() === "")) {
    return `"${pattern}" is not File:Section:Key (use * for any part)`;
  }
  return undefined;
}

export function matchesIniPattern(pattern: string, fileName: string, section: string, key: string): boolean {
  const parts = pattern.split(":");
  if (parts.length !== 3) return false;
  const glob = (p: string, v: string): boolean => {
    const re = new RegExp(
      `^${p.trim().toLowerCase().split("*").map((x) => x.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`,
    );
    return re.test(v.trim().toLowerCase());
  };
  return glob(parts[0]!, fileName) && glob(parts[1]!, section) && glob(parts[2]!, key);
}

/**
 * Parse INI text into ordered settings.
 *
 * Deliberately lossy in one direction and lossless in the other: comments and
 * blank lines are dropped because nothing consumes them, while duplicate keys
 * are KEPT in order, since the game itself takes the last one and dropping
 * earlier duplicates would silently change which value wins.
 */
export function parseIni(text: string): IniSetting[] {
  const out: IniSetting[] = [];
  let section = "";
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.length === 0) continue;
    if (line.startsWith(";") || line.startsWith("#")) continue;
    if (line.startsWith("[")) {
      const close = line.indexOf("]");
      section = close > 0 ? line.slice(1, close).trim() : line.slice(1).trim();
      continue;
    }
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    out.push({
      section,
      key: line.slice(0, eq).trim(),
      // Values keep their spacing and case: a path or a device name is not
      // ours to normalise.
      value: line.slice(eq + 1).trim(),
    });
  }
  return out;
}

/**
 * ─── My Games IS STORE-SPECIFIC TOO ────────────────────────────────────
 * The same trap as `%LOCALAPPDATA%`, one folder over, and copied from the
 * same authority: Vortex's `iniFiles` table is overlaid by store, so a GOG
 * Skyrim SE keeps its INIs in `My Games/Skyrim Special Edition GOG`.
 *
 * Worse here than for plugins.txt, because the Steam folder usually still
 * EXISTS — left behind by an earlier install — so the capture does not come
 * back empty, it comes back with someone's stale settings from months ago and
 * ships them as the curator's. Measured on the machine this was found on: the
 * GOG folder had been written that day, the Steam folder a month earlier, and
 * both held three INIs.
 *
 * Note this table is NOT the same as the plugins.txt one — GOG has no
 * Fallout 4 entry, Epic and Xbox do. Transcribed rather than derived.
 */
const STORE_MYGAMES_OVERRIDES: Record<string, Record<string, string>> = {
  gog: {
    skyrimse: "Skyrim Special Edition GOG",
    enderalspecialedition: "Enderal Special Edition GOG",
  },
  epic: {
    skyrimse: "Skyrim Special Edition EPIC",
    fallout4: "Fallout4 EPIC",
  },
  xbox: {
    skyrimse: "Skyrim Special Edition MS",
    fallout4: "Fallout4 MS",
  },
};

/**
 * Every My Games folder this game could be using, most specific first.
 *
 * A KNOWN store is authoritative — override or not — because Steam and any
 * store that does not relocate both use the base name and there is nothing to
 * look for. Only "we do not know" justifies probing.
 */
export function myGamesFolderCandidates(
  gameId: string,
  store?: string,
): string[] {
  const base = INI_FILES_BY_GAME[gameId]?.folder;
  if (base === undefined) return [];
  if (store !== undefined) {
    return [STORE_MYGAMES_OVERRIDES[store.toLowerCase()]?.[gameId] ?? base];
  }
  const variants = Object.values(STORE_MYGAMES_OVERRIDES)
    .map((byGame) => byGame[gameId])
    .filter((f): f is string => f !== undefined);
  return [base, ...variants.filter((f) => f !== base)];
}

/**
 * Where the game's launcher writes `<Game>Prefs.ini`, for this store.
 *
 * The launcher writes it the first time it runs, after detecting the hardware;
 * its absence means the game has never been started on this machine. Derived
 * from the INI table rather than named per game.
 */
export function prefsIniPathFor(
  gameId: string,
  documentsPath: string,
  store?: string,
): string | undefined {
  const location = iniLocationFor(gameId, documentsPath, store);
  const file = location?.files.find((f) => /prefs\.ini$/i.test(f));
  return location === undefined || file === undefined ? undefined : `${location.dir}/${file}`;
}

/** Whether this game's launcher writes its Prefs file. `undefined` for an unknown game. */
export function launcherWritesPrefsFor(gameId: string): boolean | undefined {
  return INI_FILES_BY_GAME[gameId]?.launcherWritesPrefs;
}

/** Which files this game keeps its settings in, and where. */
export function iniLocationFor(
  gameId: string,
  documentsPath: string,
  /** Vortex's discovered store. See myGamesFolderCandidates. */
  store?: string,
): { dir: string; files: string[] } | undefined {
  const spec = INI_FILES_BY_GAME[gameId];
  if (spec === undefined) return undefined;

  const candidates = myGamesFolderCandidates(gameId, store);
  const dirFor = (folder: string): string =>
    toPosix(`${documentsPath}/My Games/${folder}`);

  if (store !== undefined || candidates.length === 1) {
    return { dir: dirFor(candidates[0] ?? spec.folder), files: spec.files };
  }

  /**
   * Store unknown, so let the disk decide — and prefer a folder that actually
   * holds one of this game's INIs over one that merely exists. A leftover
   * Steam directory with no INIs in it must not win over the live one.
   */
  const withIni = candidates.filter((folder) =>
    spec.files.some((f) => existsSync(`${dirFor(folder)}/${f}`)),
  );
  if (withIni.length === 1) {
    return { dir: dirFor(withIni[0]!), files: spec.files };
  }
  if (withIni.length > 1) {
    // Both a Steam and a store folder hold INIs — someone changed editions.
    // Newest wins, because that is the one the game has been writing to, and
    // saying so beats silently shipping month-old settings.
    const newest = withIni
      .map((folder) => ({
        folder,
        at: spec.files.reduce((max, f) => {
          try {
            return Math.max(max, statSync(`${dirFor(folder)}/${f}`).mtimeMs);
          } catch {
            return max;
          }
        }, 0),
      }))
      .sort((a, b) => b.at - a.at);
    ehLog("warn", "game-ini.ambiguous-store", {
      gameId,
      candidates: newest.map((c) => c.folder),
      chose: newest[0]?.folder,
    });
    return { dir: dirFor(newest[0]!.folder), files: spec.files };
  }

  ehLog("warn", "game-ini.no-folder-found", { gameId, tried: candidates });
  return { dir: dirFor(spec.folder), files: spec.files };
}

/**
 * Split a captured snapshot into what the collection ships and what stays the
 * user's.
 *
 * Both halves are returned because the second is worth SAYING: a curator who
 * tuned their FOV should be told it will not travel, rather than discovering
 * it did not.
 */
export function splitByOwnership(
  settings: readonly IniSetting[],
  /** The file these came from and the curator's trim; without them only hardware is judged. */
  scope?: { fileName: string; filter?: GameIniFilter },
): {
  collection: IniSetting[];
  machine: IniSetting[];
  /** The player's own preferences (difficulty, volume, HUD colours…). */
  personal: IniSetting[];
  /** Left out by the curator's `exclude`. */
  excluded: IniSetting[];
} {
  const collection: IniSetting[] = [];
  const machine: IniSetting[] = [];
  const personal: IniSetting[] = [];
  const excluded: IniSetting[] = [];
  const matches = (patterns: string[] | undefined, s: IniSetting): boolean =>
    scope !== undefined && (patterns ?? []).some((p) => matchesIniPattern(p, scope.fileName, s.section, s.key));
  for (const setting of settings) {
    if (isMachineOwned(setting.key)) machine.push(setting);
    else if (matches(scope?.filter?.exclude, setting)) excluded.push(setting);
    else if (scope !== undefined && isPersonalSetting(setting.section, setting.key) && !matches(scope.filter?.include, setting)) {
      personal.push(setting);
    } else collection.push(setting);
  }
  return { collection, machine, personal, excluded };
}

/** What a build captured from the curator's INI files. */
export type GameIniCapture = {
  files: IniFileSnapshot[];
  /** Settings deliberately left behind, for telling the curator. */
  machineKept: IniSetting[];
  /** The curator's own preferences, left behind the same way. */
  personalKept?: IniSetting[];
  /** How many settings the curator's `exclude` left out. */
  curatorExcluded?: number;
  /** Files that were expected but absent — normal for `*Custom.ini`. */
  missing: string[];
};

/**
 * Read the curator's INI files and keep only what the collection owns.
 *
 * The split happens HERE rather than at install time so the curator's
 * hardware never enters the package at all: no monitor size, no CPU count, no
 * GPU model string. A package that cannot leak it is better than one that
 * carries it and promises not to apply it.
 *
 * Never throws. A missing `*Custom.ini` is the normal case, not an error, and
 * a collection that failed to build because a settings file was absent would
 * be a worse trade than one shipping without it.
 */
export async function captureGameIni(args: {
  gameId: string;
  documentsPath: string;
  /** Vortex's discovered store — My Games is store-specific. */
  store?: string;
  /** The curator's trim from the collection config. */
  filter?: GameIniFilter;
}): Promise<GameIniCapture> {
  const empty: GameIniCapture = { files: [], machineKept: [], missing: [] };
  const location = iniLocationFor(args.gameId, args.documentsPath, args.store);
  if (location === undefined) return empty;

  const files: IniFileSnapshot[] = [];
  const machineKept: IniSetting[] = [];
  const personalKept: IniSetting[] = [];
  let curatorExcluded = 0;
  const missing: string[] = [];

  for (const fileName of location.files) {
    let text: string;
    try {
      text = await fsp.readFile(path.join(location.dir, fileName), "utf8");
    } catch {
      missing.push(fileName);
      continue;
    }
    const { collection, machine, personal, excluded } = splitByOwnership(parseIni(text), {
      fileName,
      ...(args.filter !== undefined ? { filter: args.filter } : {}),
    });
    machineKept.push(...machine);
    personalKept.push(...personal);
    curatorExcluded += excluded.length;
    // A file whose settings are ALL machine-owned still counts as read; an
    // empty entry says "we looked and there was nothing to ship", which is
    // different from the file being absent.
    files.push({ fileName, settings: collection });
  }

  ehLog("info", "game-ini.captured-split", {
    machine: machineKept.length,
    personal: personalKept.length,
    curatorExcluded,
    filter: args.filter ?? null,
  });
  return { files, machineKept, personalKept, curatorExcluded, missing };
}

/** One line telling the curator what did not travel, or nothing to say. */
export function describeMachineKept(capture: GameIniCapture): string[] {
  const out: string[] = [];
  const list = (settings: readonly IniSetting[]): string => {
    const names = [...new Set(settings.map((s) => s.section === "" ? s.key : `[${s.section}] ${s.key}`))].sort();
    return `${names.slice(0, 8).join(", ")}${names.length > 8 ? `, and ${names.length - 8} more` : ""}`;
  };
  if (capture.machineKept.length > 0) {
    out.push(
      `${capture.machineKept.length} INI setting(s) describe your machine rather ` +
        `than this collection and were NOT shipped: ${list(capture.machineKept)}. ` +
        `Whoever installs this keeps their own screen resolution, CPU thread ` +
        `count, audio device and field of view.`,
    );
  }
  const personal = capture.personalKept ?? [];
  if (personal.length > 0) {
    out.push(
      `${personal.length} INI setting(s) are your own preferences and were NOT shipped: ${list(personal)}. ` +
        `Players keep their own difficulty, volume, controls and HUD colours. To ship one anyway, ` +
        `add "File:Section:Key" to gameIni.include in the collection's config.`,
    );
  }
  if ((capture.curatorExcluded ?? 0) > 0) {
    out.push(`${capture.curatorExcluded} INI setting(s) were left out by the collection's gameIni.exclude list.`);
  }
  return out;
}
