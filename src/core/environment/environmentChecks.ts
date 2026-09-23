/**
 * ──────────────────────────────────────────────────────────────────────
 * Is this machine able to run the collection at all?
 *
 * Every check here comes from a tester who did something nobody anticipated,
 * and each one decides from facts probed elsewhere — these functions do no IO,
 * so every verdict is testable and every verdict can be logged with the
 * evidence that produced it.
 *
 *  - game-managed        installed a collection without ever pressing
 *                        "Manage" on the game in Vortex
 *  - wine-prefix         ran Vortex in one Wine prefix and the game from
 *                        Heroic in another, so the game never saw what
 *                        Vortex wrote
 *  - launcher-ran        never started the game once, so the launcher never
 *                        wrote its hardware-detected `<Game>Prefs.ini`
 *  - binary-imports      "Entry Point Not Found: SteamInternal_CreateInterface"
 *                        — a GOG steam_api64.dll inside a Steam install
 *  - protected-location  game under Program Files, where tools running without
 *                        administrator rights are refused writes
 *  - synced-folder       game moved into OneDrive to get it out of Program
 *                        Files — OneDrive then uploads every file Vortex links in
 *  - owned-masters       installed all 1,746 mods of a collection, then crashed
 *                        at startup: the game had no Anniversary Upgrade, and
 *                        the plugins need its Creation Club files as masters
 *  - game-folder         leftovers from earlier setups (gameFolderScan.ts)
 *  - ini-leftovers       archive-loading INI settings from earlier setups
 *
 * `blocked` stops an install. `warning` is shown and logged. `unknown` means a
 * probe could not run — never a block, because refusing a working install on a
 * check that failed to run does more harm than the thing it guards.
 * ──────────────────────────────────────────────────────────────────────
 */

import { basenameOf, dirnameOf } from "../paths";
import type { FolderShare, PrefixSource, WinePrefixProbe } from "../proton";
import type { GameFolderScan } from "./gameFolderScan";
import { groupEntries } from "./gameFolderScan";

export type EnvironmentCheckId =
  | "game-managed"
  | "wine-prefix"
  | "protected-location"
  | "synced-folder"
  | "owned-masters"
  | "launcher-ran"
  | "binary-imports"
  | "game-folder"
  | "ini-leftovers";

/**
 * `info` is shown but does not count as a problem: the check has something the
 * user should read before clicking Install, and nothing is wrong. It exists
 * because "your game folder is not clean" was being said about Event Horizon's
 * OWN deployment — see {@link decideGameFolder}.
 */
export type EnvironmentStatus = "ok" | "blocked" | "warning" | "unknown" | "info";

export type EnvironmentCheck = {
  id: EnvironmentCheckId;
  status: EnvironmentStatus;
  /** One sentence, the verdict. */
  title: string;
  /** The evidence, in words. */
  lines: string[];
  /** What the user should do. Empty when there is nothing to do. */
  steps: string[];
};

const ok = (id: EnvironmentCheckId, title: string, lines: string[] = []): EnvironmentCheck => ({
  id,
  status: "ok",
  title,
  lines,
  steps: [],
});

const unknownCheck = (id: EnvironmentCheckId, title: string, lines: string[] = []): EnvironmentCheck => ({
  id,
  status: "unknown",
  title,
  lines,
  steps: [],
});

// ── 1. Vortex manages the game ───────────────────────────────────────────

export function decideGameManaged(input: {
  gameName: string;
  discoveredPath: string | undefined;
  executable: string | undefined;
  dirExists: boolean;
  exeExists: boolean;
}): EnvironmentCheck {
  const { gameName } = input;
  const manageSteps = [
    `In Vortex open Games, find ${gameName} and click "Manage". If Vortex cannot find it, use "Manually set location" and pick the folder that contains the game's .exe.`,
    `Make ${gameName} the active game, then load the collection again.`,
  ];
  if (input.discoveredPath === undefined) {
    return {
      id: "game-managed",
      status: "blocked",
      title: `Vortex is not managing ${gameName}.`,
      lines: [`Vortex has no install folder recorded for ${gameName}, so nothing it deploys can reach the game.`],
      steps: manageSteps,
    };
  }
  if (!input.dirExists) {
    return {
      id: "game-managed",
      status: "blocked",
      title: `The ${gameName} folder Vortex has recorded does not exist.`,
      lines: [`Recorded folder: ${input.discoveredPath}`],
      steps: manageSteps,
    };
  }
  if (input.executable === undefined) {
    return unknownCheck("game-managed", `Could not tell which executable ${gameName} uses.`, [
      `Game folder: ${input.discoveredPath}`,
    ]);
  }
  if (!input.exeExists) {
    return {
      id: "game-managed",
      status: "blocked",
      title: `${input.executable} is not in the ${gameName} folder Vortex is using.`,
      lines: [
        `Folder: ${input.discoveredPath}`,
        "Either the game is not fully installed there, or Vortex points at the wrong folder.",
      ],
      steps: manageSteps,
    };
  }
  return ok("game-managed", `Vortex manages ${gameName}.`, [
    `Folder: ${input.discoveredPath}`,
    `Executable: ${input.executable}`,
  ]);
}

// ── 1b. Under Wine: Vortex writes where the game reads ──────────────────

const LAUNCHER_NAME: Record<PrefixSource, string> = { heroic: "Heroic", steam: "Steam" };

/** Single-quoted for a POSIX shell. */
const shellQuote = (p: string): string => `'${p.replace(/'/g, `'\\''`)}'`;

function linkStep(f: FolderShare): string {
  if (f.vortexLinuxPath === undefined || f.gameLinuxPath === undefined) {
    return `Replace ${f.vortexDir} in Vortex's prefix with a link to ${f.gameDir}, keeping the old folder under another name.`;
  }
  const commands = [
    ...(f.gameExists ? [] : [`mkdir -p ${shellQuote(f.gameLinuxPath)}`]),
    f.vortexExists
      ? `mv ${shellQuote(f.vortexLinuxPath)} ${shellQuote(`${f.vortexLinuxPath}.before-link`)}`
      : `mkdir -p ${shellQuote(dirnameOf(f.vortexLinuxPath))}`,
    `ln -s ${shellQuote(f.gameLinuxPath)} ${shellQuote(f.vortexLinuxPath)}`,
  ];
  return `Link ${f.label} to the game's folder. In a terminal: ${commands.join(" && ")}`;
}

/**
 * Under Wine, do Vortex and the game use the same settings folders? Blocked
 * when the game's own prefix is known and a folder Vortex writes is not shared
 * with it (the curator's call: name both prefixes, say how to link them).
 * Everything short of that proof is `unknown`, never a block.
 */
export function decideWinePrefix(input: { gameName: string; probe: WinePrefixProbe }): EnvironmentCheck {
  const { gameName, probe } = input;
  const vortexLine =
    probe.host.vortexPrefix !== undefined
      ? `Vortex runs in the prefix ${probe.host.vortexPrefix}.`
      : `Vortex runs in its own prefix${probe.vortexUserDir !== undefined ? `, as ${probe.vortexUserDir}` : ""}.`;
  const game = probe.game;
  if (game === undefined) {
    return unknownCheck("wine-prefix", `Could not tell which Wine prefix ${gameName} runs in.`, [
      probe.unresolved ?? "No launcher record names one.",
      vortexLine,
      `So ${gameName}'s settings are checked in Vortex's prefix. If ${gameName} runs in a different one — from Heroic, Lutris, Bottles or Steam — the load order and INI settings Vortex writes do not reach it unless those folders are linked.`,
    ]);
  }
  const gameLine = `${gameName} runs in the prefix ${LAUNCHER_NAME[game.source]} keeps for it: ${game.linuxPath ?? game.reached} (${game.detail}).`;
  if (probe.gameUserDir === undefined) {
    return unknownCheck("wine-prefix", `Could not tell which user folder ${gameName} uses in its Wine prefix.`, [
      gameLine,
      vortexLine,
      ...(probe.unresolved !== undefined ? [probe.unresolved] : []),
    ]);
  }
  if (probe.gameStarted !== true) {
    return unknownCheck(
      "wine-prefix",
      `${gameName} has not been started in its Wine prefix yet, so whether Vortex shares its settings folders could not be checked.`,
      [gameLine, vortexLine],
    );
  }
  const folderLine = (f: FolderShare): string => `${f.label}: ${f.rel} — ${f.detail}`;
  const separate = probe.folders.filter((f) => f.state === "separate");
  if (separate.length > 0) {
    const runInPrefix =
      game.source === "steam" && game.appId !== undefined
        ? `Or, instead of linking, run Vortex inside ${gameName}'s prefix — for example with protontricks-launch --appid ${game.appId} and Vortex.exe.`
        : `Or, instead of linking, run Vortex inside ${gameName}'s prefix: add Vortex.exe to Heroic as a non-store game and set its Wine prefix to ${game.linuxPath ?? game.reached}.`;
    return {
      id: "wine-prefix",
      status: "blocked",
      title: `Vortex and ${gameName} are in different Wine prefixes, and the folders Vortex writes are not linked.`,
      lines: [
        gameLine,
        vortexLine,
        ...separate.map((f) => `Not shared — ${folderLine(f)}.`),
        `Vortex and Event Horizon write the load order and INI settings into Vortex's prefix, so ${gameName} would start without them.`,
      ],
      steps: [
        "Close Vortex.",
        ...separate.map(linkStep),
        runInPrefix,
        "Start Vortex and load the collection again. A collection installed before the folders were linked needs installing again, so its INI settings and load order are written where the game reads them.",
      ],
    };
  }
  const unprobed = probe.folders.filter((f) => f.state === "unprobed");
  if (unprobed.length > 0 || probe.folders.length === 0) {
    return unknownCheck("wine-prefix", `Could not check whether Vortex writes into the settings folders ${gameName} reads.`, [
      gameLine,
      vortexLine,
      ...unprobed.map((f) => `Not checked — ${folderLine(f)}.`),
    ]);
  }
  return ok("wine-prefix", `Vortex writes into the settings folders ${gameName} reads.`, [
    gameLine,
    vortexLine,
    ...probe.folders.map((f) => `Shared — ${folderLine(f)}.`),
  ]);
}

// ── 2. Not under Program Files ───────────────────────────────────────────

const normFolder = (p: string): string => p.replace(/[\\/]+/g, "\\").replace(/\\$/, "").toLowerCase();

/** Is `dir` the folder `root` or inside it? Case-insensitive, separator-agnostic; a sibling sharing a prefix is not inside. */
function isInsideFolder(dir: string, root: string): boolean {
  if (root.trim().length === 0) return false;
  const d = normFolder(dir);
  const r = normFolder(root);
  return d === r || d.startsWith(`${r}\\`);
}

/** The protected root `gameDir` sits under, if any. Case-insensitive, separator-agnostic. */
export function protectedRootOf(gameDir: string, roots: readonly string[]): string | undefined {
  return roots.find((root) => isInsideFolder(gameDir, root));
}

/**
 * How to move a game out of a folder Event Horizon refuses.
 *
 * The new folder has to be on the drive Vortex's mods folder is on: Vortex
 * deploys by linking each mod file into the game folder, and a link cannot reach
 * another drive, so a game moved anywhere else cannot be deployed to at all.
 * These steps used to suggest D:\Games to everyone, a dead end for a player
 * whose mods are on C:.
 */
function moveSteps(gameName: string, store: string | undefined, stagingDir: string | undefined): string[] {
  const letter = /^([a-z]):/i.exec(stagingDir ?? "")?.[1];
  const drive = letter !== undefined ? `${letter.toUpperCase()}:` : undefined;
  const target = (folder: string): string => (drive !== undefined ? `a folder such as ${drive}\\${folder}` : "a normal folder");
  const s = (store ?? "").toLowerCase();
  const move =
    s === "steam"
      ? `Steam → Settings → Storage: add a library in ${target("SteamLibrary")}, select ${gameName} and click Move.`
      : s === "gog"
        ? `GOG Galaxy → ${gameName} → Manage installation → Move, to ${target("Games")}.`
        : `Move or reinstall ${gameName} to ${target("Games")} — your store's library settings can do this without re-downloading.`;
  const keep =
    drive !== undefined
      ? `Keep it on ${drive}, where your Vortex mods folder is: Vortex links mod files into the game folder, and a link cannot cross drives.`
      : "Keep it on the drive your Vortex mods folder is on (Vortex → Settings → Mods shows where that is): Vortex links mod files into the game folder, and a link cannot cross drives.";
  return [`${move} ${keep}`, `In Vortex → Games → ${gameName}, point it at the new folder, then load the collection again.`];
}

export function decideProtectedLocation(input: {
  gameName: string;
  gameDir: string;
  protectedRoots: readonly string[];
  wine: boolean;
  store: string | undefined;
  /** Vortex's mods folder for this game; the steps name its drive. */
  stagingDir?: string | undefined;
}): EnvironmentCheck {
  if (input.wine) {
    return ok("protected-location", "Running under Wine/Proton — Windows folder protection does not apply.");
  }
  if (input.protectedRoots.every((r) => r.trim().length === 0)) {
    return unknownCheck("protected-location", "Windows did not report its Program Files folders, so this could not be checked.");
  }
  const root = protectedRootOf(input.gameDir, input.protectedRoots);
  if (root === undefined) {
    return ok("protected-location", `${input.gameName} is outside Windows' protected folders.`, [
      `Folder: ${input.gameDir}`,
    ]);
  }
  return {
    id: "protected-location",
    status: "blocked",
    title: `${input.gameName} is installed under ${root}.`,
    lines: [
      `Folder: ${input.gameDir}`,
      "Windows only lets programs running as administrator write there. Vortex, xEdit, BodySlide and script-extender plugins normally do not run as administrator, so some of their writes into the game folder are refused — and which ones depends on how each tool was started, so the setup cannot be reproduced.",
    ],
    steps: moveSteps(input.gameName, input.store, input.stagingDir),
  };
}

// ── 2b. Not inside a folder a cloud client uploads ──────────────────────

/** A folder a cloud client uploads everything from, as this machine reports it. */
export type SyncedRoot = { service: "OneDrive" | "Dropbox"; path: string };

/**
 * Is the game inside OneDrive or Dropbox? Blocked, like Program Files (owner
 * poll, 2026-09-23): a player refused under Program Files moved the game into
 * the OneDrive folder, and Vortex then linked about 339,000 mod files into a
 * folder OneDrive uploads. Their crash turned out to have another cause, but
 * the upload, the locks and the online-only placeholders are real either way.
 */
export function decideSyncedFolder(input: {
  gameName: string;
  gameDir: string;
  syncedRoots: readonly SyncedRoot[];
  store: string | undefined;
  /** Vortex's mods folder for this game; the steps name its drive. */
  stagingDir?: string | undefined;
}): EnvironmentCheck {
  const root = input.syncedRoots.find((r) => isInsideFolder(input.gameDir, r.path));
  if (root === undefined) {
    return ok("synced-folder", `${input.gameName} is not inside a OneDrive or Dropbox folder.`, [
      `Folder: ${input.gameDir}`,
      ...(input.syncedRoots.length > 0
        ? input.syncedRoots.map((r) => `${r.service} folder: ${r.path}`)
        : ["This machine reports no OneDrive or Dropbox folder."]),
    ]);
  }
  const service = root.service;
  return {
    id: "synced-folder",
    status: "blocked",
    title: `${input.gameName} is inside your ${service} folder.`,
    lines: [
      `Folder: ${input.gameDir}`,
      `${service} folder: ${root.path}`,
      `${service} uploads everything in its folder, and Vortex links every file of every mod into the game folder — hundreds of thousands of files for a large collection. While it uploads, ${service} can lock files Vortex and the game need, and to free space it can replace files with online-only placeholders that have to download again before the game can read them.`,
    ],
    steps: moveSteps(input.gameName, input.store, input.stagingDir),
  };
}

// ── 2c. The Creation Club files the collection needs are in the game ────

const NAMES_SHOWN = 12;

/** Where the missing files come from, per game — Skyrim's are almost all in one upgrade. */
function ownedMasterSteps(gameId: string, gameName: string, store: string | undefined): string[] {
  const s = (store ?? "").toLowerCase();
  if (gameId === "skyrimse") {
    const upgrade =
      s === "gog"
        ? `GOG Galaxy → ${gameName} → Manage installation → Configure: tick the Anniversary Upgrade under DLC. If it is not listed, it is not on your GOG account, which sells it as a DLC for ${gameName}.`
        : s === "steam"
          ? `On Steam, buy the Skyrim Anniversary Upgrade. Then start the game and download its content from the Creations menu.`
          : `Install the Anniversary Upgrade from the store you bought ${gameName} from.`;
    return [
      `Most Creation Club files come with the Anniversary Upgrade. ${upgrade}`,
      "Anything still missing after that is a separate Creation: buy and download it in the game's Creations menu.",
      "Then load the collection again.",
    ];
  }
  return [
    "Creation Club content is owned per account: download it in the game's Creations menu (the Creation Club, in older versions of the game), or install it from your store if the store sells it.",
    "Then load the collection again.",
  ];
}

/**
 * Does the game have every Creation Club file the collection's plugins need?
 * Blocked when one is missing (owner poll, 2026-09-23): the game closes at
 * startup without it, after an install of every mod has already run.
 *
 * `recorded` undefined is a package built before the list existed. It says so
 * and never blocks: an old package was never asked, and refusing it on a check
 * it predates would be the check's fault, not the player's.
 */
export function decideOwnedMasters(input: {
  gameId: string;
  gameName: string;
  store: string | undefined;
  /** `manifest.game.userOwnedMasters`. */
  recorded: readonly string[] | undefined;
  dataDir: string | undefined;
  /** Lower-case names in the Data folder; undefined when it could not be read. */
  present: ReadonlySet<string> | undefined;
}): EnvironmentCheck {
  const { gameName } = input;
  if (input.recorded === undefined) {
    return unknownCheck(
      "owned-masters",
      "This collection was built before Event Horizon recorded which Creation Club files it needs, so they were not checked.",
    );
  }
  const needed = input.recorded.filter((f) => f.trim().length > 0);
  if (needed.length === 0) return ok("owned-masters", "This collection needs no Creation Club files.");
  const files = `${needed.length} Creation Club file${needed.length === 1 ? "" : "s"}`;
  if (input.present === undefined) {
    return unknownCheck("owned-masters", `Could not read ${gameName}'s Data folder, so the ${files} this collection needs were not checked.`, [
      ...(input.dataDir !== undefined ? [`Folder: ${input.dataDir}`] : []),
    ]);
  }
  const present = input.present;
  const missing = needed.filter((f) => !present.has(f.trim().toLowerCase()));
  if (missing.length === 0) {
    return ok("owned-masters", `${gameName} has all ${files} this collection needs.`, [
      ...(input.dataDir !== undefined ? [`Folder: ${input.dataDir}`] : []),
    ]);
  }
  const more = missing.length > NAMES_SHOWN ? `, and ${missing.length - NAMES_SHOWN} more` : "";
  return {
    id: "owned-masters",
    status: "blocked",
    title: `${gameName} is missing ${missing.length} of the ${files} this collection needs.`,
    lines: [
      `Missing: ${missing.slice(0, NAMES_SHOWN).join(", ")}${more}.`,
      "The collection's plugins need them as masters. Without them the game closes while it loads, with no error message.",
      ...(input.dataDir !== undefined ? [`Looked in: ${input.dataDir}`] : []),
    ],
    steps: ownedMasterSteps(input.gameId, gameName, input.store),
  };
}

// ── 3. The launcher has run once ─────────────────────────────────────────

function startOnceStep(
  gameName: string,
  store: string | undefined,
  hasLauncher: boolean | undefined,
  wine: boolean,
  launcher: PrefixSource | undefined,
): string {
  const s = (store ?? "").toLowerCase();
  const where =
    launcher !== undefined
      ? `from ${LAUNCHER_NAME[launcher]}`
      : s === "steam"
        ? "from Steam"
        : wine && (s === "gog" || s === "epic")
          ? "from Heroic, or whichever launcher you play it with"
          : s === "gog"
            ? "from GOG Galaxy or its desktop shortcut"
            : s === "epic"
              ? "from the Epic Games Launcher"
              : s === "xbox"
                ? "from the Xbox app"
                : wine
                  ? "from the launcher you play it with"
                  : "from your store";
  return hasLauncher === false
    ? `Start ${gameName} once ${where} and wait for the main menu, then quit.`
    : `Start ${gameName} once ${where} — its own launcher, not Vortex or a script extender — and let it detect your hardware, then close it. You do not need to play.`;
}

export function decideLauncherRan(input: {
  gameName: string;
  prefsPath: string | undefined;
  exists: boolean;
  /**
   * Whether the file carries the hardware settings only the game's launcher
   * writes. `undefined` when that cannot be judged (the game has no launcher,
   * or the file could not be read).
   */
  launcherWrote?: boolean | undefined;
  hasLauncher?: boolean | undefined;
  store?: string | undefined;
  /** Running under Wine/Proton. */
  wine?: boolean | undefined;
  /**
   * Under Wine: the launcher whose prefix the file was read from. Absent when
   * the game's own prefix was not found and the file was read from Vortex's.
   */
  launcher?: PrefixSource | undefined;
}): EnvironmentCheck {
  if (input.prefsPath === undefined) {
    return unknownCheck("launcher-ran", `No settings-file layout is known for ${input.gameName}.`);
  }
  const file = basenameOf(input.prefsPath) || input.prefsPath;
  const wine = input.wine === true;
  const steps = [startOnceStep(input.gameName, input.store, input.hasLauncher, wine, input.launcher), "Load the collection again."];
  const readFromVortexPrefix =
    wine && input.launcher === undefined
      ? [
          `Under Wine/Proton this is the file in the prefix Vortex runs in. If you start ${input.gameName} from a launcher with its own prefix, the file it wrote is there instead — see the Wine prefix check.`,
        ]
      : [];
  if (!input.exists) {
    return {
      id: "launcher-ran",
      status: "blocked",
      title: `${input.gameName} has never been started on this PC.`,
      lines: [
        `${file} is missing: ${input.prefsPath}`,
        "The game writes it the first time it runs, after detecting your hardware. Without it the game starts with wrong video settings, and the collection's settings are written into a folder the game has not set up.",
        ...readFromVortexPrefix,
      ],
      steps,
    };
  }
  if (input.launcherWrote === false) {
    return {
      id: "launcher-ran",
      status: "blocked",
      title: `${input.gameName}'s settings file was not created by the game.`,
      lines: [
        `${file} exists but holds none of the hardware settings (screen size, display adapter) the game's launcher writes: ${input.prefsPath}`,
        "A mod tool — possibly an earlier install — created it, so the launcher's hardware detection has never run on this PC.",
        ...readFromVortexPrefix,
      ],
      steps,
    };
  }
  return ok("launcher-ran", `${input.gameName} has been set up on this PC.`, [`Found: ${input.prefsPath}`]);
}

// ── 4. Executables can load their DLLs ───────────────────────────────────

export type ImportMismatch = {
  exe: string;
  dll: string;
  missing: string[];
  /** The DLL is one the store installed — so the copy on disk is the wrong one. */
  dllIsVanilla: boolean;
};

/**
 * Only what Event Horizon STARTS can block (owner poll, 2026-09-17).
 *
 * A player on Steam ran Simple Fallout 4 Downgrader, as Ivy's page tells them
 * to. It moves Fallout4.exe and steam_api64.dll back to 1.10.163 and leaves the
 * next-gen Fallout4Launcher.exe, which needs SteamInternal_CreateInterface and
 * SteamInternal_ContextInit, two functions the old DLL does not have. The
 * launcher cannot open, the game can, and Play starts the game through the
 * script extender. Blocking on the launcher refused a working game, and the
 * player started swapping DLLs to get past it. A mismatch in a program Event
 * Horizon never starts is now a warning.
 */
export function decideBinaryImports(input: {
  gameName: string;
  checked: readonly string[];
  findings: readonly ImportMismatch[];
  /** The programs Event Horizon starts: the script extender loader and the game executable. */
  started: readonly string[];
  unreadable?: readonly string[];
}): EnvironmentCheck {
  const describe = (f: ImportMismatch): string =>
    `${f.exe} needs ${f.missing.slice(0, 3).join(", ")}${f.missing.length > 3 ? ` (+${f.missing.length - 3} more)` : ""} from ${f.dll}, and the ${f.dll} in the game folder does not have ${f.missing.length === 1 ? "it" : "them"}.`;
  const started = new Set(input.started.map((n) => n.toLowerCase()));
  const isStarted = (f: ImportMismatch): boolean => started.has(f.exe.toLowerCase());
  const hard = input.findings.filter((f) => f.dllIsVanilla && isStarted(f));
  const notStarted = input.findings.filter((f) => f.dllIsVanilla && !isStarted(f));
  const soft = input.findings.filter((f) => !f.dllIsVanilla);
  if (hard.length === 0 && notStarted.length > 0) {
    const f = notStarted[0]!;
    return {
      id: "binary-imports",
      status: "warning",
      title: `${f.exe} cannot open with this ${f.dll}, but Event Horizon does not start it.`,
      lines: [
        ...input.findings.map(describe),
        `Event Horizon starts the game through ${input.started.join(" and ")}, which ${input.started.length === 1 ? "is" : "are"} checked on ${input.started.length === 1 ? "its" : "their"} own. ` +
          `A downgrade tool that moves the game and ${f.dll} back but not ${f.exe} leaves exactly this (Simple Fallout 4 Downgrader does), and it does not stop the game.`,
      ],
      steps: [
        "Nothing to do if you downgraded the game on purpose. Do not swap DLLs to make this go away.",
        `Otherwise verify the game files in your store, then load the collection again.`,
      ],
    };
  }
  if (hard.length > 0) {
    return {
      id: "binary-imports",
      status: "blocked",
      title: `${hard[0]!.exe} cannot start: ${hard[0]!.dll} is the wrong version.`,
      lines: [
        ...input.findings.map(describe),
        "Windows refuses to start a program in this state (\"Entry Point Not Found\"). It happens when a game file comes from a different copy of the game — a GOG file in a Steam install, or a patched/emulated DLL.",
      ],
      steps: [
        `Steam: right-click ${input.gameName} → Properties → Installed Files → Verify integrity of game files.`,
        `GOG Galaxy: ${input.gameName} → Manage installation → Verify / Repair.`,
        "Never copy game files between a Steam and a GOG install. Then load the collection again.",
      ],
    };
  }
  if (soft.length > 0) {
    return {
      id: "binary-imports",
      status: "warning",
      title: `A DLL in the ${input.gameName} folder does not match the program that loads it.`,
      lines: soft.map(describe),
      steps: ["If the game fails to start, remove or update the DLL named above."],
    };
  }
  if (input.checked.length === 0) {
    return unknownCheck(
      "binary-imports",
      "No game executable could be read, so DLL compatibility was not checked.",
      input.unreadable !== undefined && input.unreadable.length > 0 ? [`Unreadable: ${input.unreadable.join(", ")}`] : [],
    );
  }
  return ok("binary-imports", "Game executables and their DLLs match.", [`Checked: ${input.checked.join(", ")}`]);
}

// ── 5. The game folder is clean ──────────────────────────────────────────

export function decideGameFolder(input: {
  gameName: string;
  scan: GameFolderScan;
}): EnvironmentCheck {
  const { report, deployedCount } = input.scan;
  const toolDlls = input.scan.toolDlls ?? [];
  const toolLines =
    toolDlls.length > 0
      ? [
          `Left alone — they belong to tools beside the game: ${toolDlls.map((t) => `${t.dll} (${t.owners.join(", ")})`).join("; ")}.`,
        ]
      : [];
  if (report.vanilla.kind === "unknown") {
    return {
      id: "game-folder",
      status: "warning",
      title: `Could not verify the ${input.gameName} folder is clean.`,
      lines: [report.vanilla.reason],
      steps: [
        "Nothing will be purged or moved. Files left in the game folder by earlier mod setups can collide with this collection; if the game misbehaves, verify the game files in your store and remove anything you added by hand.",
      ],
    };
  }
  const lines: string[] = [];
  const unmanaged = report.unmanaged;
  if (unmanaged.length > 0) {
    lines.push(
      `${unmanaged.length} file${unmanaged.length === 1 ? "" : "s"} the game would load ${unmanaged.length === 1 ? "is" : "are"} not part of ${input.gameName}, Vortex's deployment or this collection:`,
    );
    for (const g of groupEntries(unmanaged).slice(0, 8)) {
      lines.push(`  ${g.group} — ${g.files} file${g.files === 1 ? "" : "s"}`);
    }
  }
  if (deployedCount > 0) {
    lines.push(`Vortex has ${deployedCount} mod file${deployedCount === 1 ? "" : "s"} deployed into the game folder.`);
  }
  if (report.vanillaMissing.length > 0) {
    lines.push(
      `${report.vanillaMissing.length} game file${report.vanillaMissing.length === 1 ? " is" : "s are"} missing (${report.vanillaMissing.slice(0, 3).join(", ")}${report.vanillaMissing.length > 3 ? ", …" : ""}).`,
    );
  }
  if (report.vanillaSizeMismatch.length > 0) {
    lines.push(
      `${report.vanillaSizeMismatch.length} game file${report.vanillaSizeMismatch.length === 1 ? " differs" : "s differ"} from the store's copy (${report.vanillaSizeMismatch.slice(0, 3).map((m) => m.path).join(", ")}${report.vanillaSizeMismatch.length > 3 ? ", …" : ""}).`,
    );
  }
  const presenceOnly =
    report.vanilla.source === "gog"
      ? ["GOG's record has no file sizes, so the game's own files were checked for presence, not content."]
      : [];
  if (lines.length === 0) {
    return ok("game-folder", `The ${input.gameName} folder is a clean game.`, [
      `Checked against ${report.vanilla.detail}`,
      ...presenceOnly,
      ...toolLines,
    ]);
  }
  const steps: string[] = [];
  if (unmanaged.length > 0 || deployedCount > 0) {
    steps.push(
      "When you click Install, Event Horizon purges Vortex's deployment and moves the files above into a quarantine folder beside the game folder — nothing is deleted, and the Doctor page can put every file back.",
    );
  }
  /**
   * ─── VORTEX'S OWN DEPLOYMENT IS NOT AN UNCLEAN GAME ────────────────────
   * Nothing foreign is here: no unmanaged files, no missing or altered game
   * files. What is here is a deployment — usually the collection the player
   * just finished installing, which is the state this tool PUT the folder in.
   *
   * A tester finished a 3,236-mod install and every later preview greeted him
   * with "The Skyrim Special Edition folder is not a clean game", over 540,730
   * files that were all Vortex's, with `unmanaged: 0`. He read it as a loop he
   * could not get out of, and he was right to: nothing he could do would make
   * that warning go away, because nothing was wrong.
   *
   * Still SHOWN, and the purge step stays: on a fresh install those files are
   * about to be purged and quarantined, which is a real thing to know before
   * clicking. It is the severity that was the lie, not the text.
   */
  if (unmanaged.length === 0 && report.vanillaMissing.length === 0 && report.vanillaSizeMismatch.length === 0) {
    return {
      id: "game-folder",
      status: "info",
      title: `The ${input.gameName} folder holds a Vortex deployment and nothing foreign.`,
      lines: [
        ...lines,
        `Checked against ${report.vanilla.detail}`,
        ...presenceOnly,
        ...toolLines,
      ],
      steps,
    };
  }
  if (report.vanillaMissing.length > 0 || report.vanillaSizeMismatch.length > 0) {
    steps.push("Verify the game files in your store (Steam: Verify integrity; GOG Galaxy: Verify / Repair).");
  }
  return {
    id: "game-folder",
    status: "warning",
    title: `The ${input.gameName} folder is not a clean game.`,
    lines: [...lines, ...presenceOnly, ...toolLines],
    steps,
  };
}

// ── 6. INI leftovers ─────────────────────────────────────────────────────

export type IniLeftover = { file: string; key: string; value: string; defaultValue?: string };

/**
 * Archive-loading settings in the user's INIs that neither the game's own
 * defaults nor this collection set. Warn only (the curator's call): they
 * change which archives and loose files the game loads, and they are the
 * user's to keep or remove.
 */
export function decideIniLeftovers(input: {
  gameName: string;
  defaultsFile: string | undefined;
  leftovers: readonly IniLeftover[];
}): EnvironmentCheck {
  if (input.defaultsFile === undefined) {
    return unknownCheck("ini-leftovers", `No default INI in the ${input.gameName} folder to compare the archive settings against.`);
  }
  if (input.leftovers.length === 0) {
    return ok("ini-leftovers", "No archive-loading settings from earlier setups in the game's INI files.", [
      `Compared against ${input.defaultsFile}`,
    ]);
  }
  return {
    id: "ini-leftovers",
    status: "warning",
    title: `${input.gameName}'s INI files carry archive-loading settings this collection does not set.`,
    lines: input.leftovers.map(
      (l) => `${l.file}: ${l.key}=${l.value} (game default: ${l.defaultValue === undefined ? "not set" : l.defaultValue === "" ? "empty" : l.defaultValue})`,
    ),
    steps: [
      "They change which archives and loose files the game loads, and probably come from an earlier mod setup. Keep them if you set them on purpose; otherwise remove them from the file named, or reset the INIs with a tool like BethINI.",
    ],
  };
}

export function blockingChecks(checks: readonly EnvironmentCheck[]): EnvironmentCheck[] {
  return checks.filter((c) => c.status === "blocked");
}

/** Plain text for a dialog: every blocked check, its evidence and its steps. */
export function describeBlockedChecks(checks: readonly EnvironmentCheck[]): string {
  return blockingChecks(checks)
    .map((c) =>
      [
        c.title,
        ...c.lines.map((l) => `  ${l}`),
        ...(c.steps.length > 0 ? ["  What to do:", ...c.steps.map((s, i) => `   ${i + 1}. ${s}`)] : []),
      ].join("\n"),
    )
    .join("\n\n");
}
