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
 *  - launcher-ran        never started the game once, so the launcher never
 *                        wrote its hardware-detected `<Game>Prefs.ini`
 *  - binary-imports      "Entry Point Not Found: SteamInternal_CreateInterface"
 *                        — a GOG steam_api64.dll inside a Steam install
 *  - protected-location  game under Program Files, where tools running without
 *                        administrator rights are refused writes
 *  - game-folder         leftovers from earlier setups (gameFolderScan.ts)
 *  - ini-leftovers       archive-loading INI settings from earlier setups
 *
 * `blocked` stops an install. `warning` is shown and logged. `unknown` means a
 * probe could not run — never a block, because refusing a working install on a
 * check that failed to run does more harm than the thing it guards.
 * ──────────────────────────────────────────────────────────────────────
 */

import { basenameOf } from "../paths";
import type { GameFolderScan } from "./gameFolderScan";
import { groupEntries } from "./gameFolderScan";

export type EnvironmentCheckId =
  | "game-managed"
  | "protected-location"
  | "launcher-ran"
  | "binary-imports"
  | "game-folder"
  | "ini-leftovers";

export type EnvironmentStatus = "ok" | "blocked" | "warning" | "unknown";

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

// ── 2. Not under Program Files ───────────────────────────────────────────

/** The protected root `gameDir` sits under, if any. Case-insensitive, separator-agnostic. */
export function protectedRootOf(gameDir: string, roots: readonly string[]): string | undefined {
  const norm = (p: string): string => p.replace(/[\\/]+/g, "\\").replace(/\\$/, "").toLowerCase();
  const dir = norm(gameDir);
  for (const root of roots) {
    if (root.trim().length === 0) continue;
    const r = norm(root);
    if (dir === r || dir.startsWith(`${r}\\`)) return root;
  }
  return undefined;
}

export function decideProtectedLocation(input: {
  gameName: string;
  gameDir: string;
  protectedRoots: readonly string[];
  wine: boolean;
  store: string | undefined;
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
  const store = (input.store ?? "").toLowerCase();
  const moveSteps =
    store === "steam"
      ? [`Steam → Settings → Storage: add a library on a normal folder (for example D:\\SteamLibrary), select ${input.gameName} and click Move.`]
      : store === "gog"
        ? [`GOG Galaxy → ${input.gameName} → Manage installation → Move, to a normal folder such as D:\\Games.`]
        : [`Move or reinstall ${input.gameName} to a normal folder such as D:\\Games — your store's library settings can do this without re-downloading.`];
  return {
    id: "protected-location",
    status: "blocked",
    title: `${input.gameName} is installed under ${root}.`,
    lines: [
      `Folder: ${input.gameDir}`,
      "Windows only lets programs running as administrator write there. Vortex, xEdit, BodySlide and script-extender plugins normally do not run as administrator, so some of their writes into the game folder are refused — and which ones depends on how each tool was started, so the setup cannot be reproduced.",
    ],
    steps: [
      ...moveSteps,
      `In Vortex → Games → ${input.gameName}, point it at the new folder, then load the collection again.`,
    ],
  };
}

// ── 3. The launcher has run once ─────────────────────────────────────────

function startOnceStep(gameName: string, store: string | undefined, hasLauncher: boolean | undefined): string {
  const s = (store ?? "").toLowerCase();
  const where =
    s === "steam"
      ? "from Steam"
      : s === "gog"
        ? "from GOG Galaxy or its desktop shortcut"
        : s === "epic"
          ? "from the Epic Games Launcher"
          : s === "xbox"
            ? "from the Xbox app"
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
}): EnvironmentCheck {
  if (input.prefsPath === undefined) {
    return unknownCheck("launcher-ran", `No settings-file layout is known for ${input.gameName}.`);
  }
  const file = basenameOf(input.prefsPath) || input.prefsPath;
  const steps = [startOnceStep(input.gameName, input.store, input.hasLauncher), "Load the collection again."];
  if (!input.exists) {
    return {
      id: "launcher-ran",
      status: "blocked",
      title: `${input.gameName} has never been started on this PC.`,
      lines: [
        `${file} is missing: ${input.prefsPath}`,
        "The game writes it the first time it runs, after detecting your hardware. Without it the game starts with wrong video settings, and the collection's settings are written into a folder the game has not set up.",
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

export function decideBinaryImports(input: {
  gameName: string;
  checked: readonly string[];
  findings: readonly ImportMismatch[];
  unreadable?: readonly string[];
}): EnvironmentCheck {
  const describe = (f: ImportMismatch): string =>
    `${f.exe} needs ${f.missing.slice(0, 3).join(", ")}${f.missing.length > 3 ? ` (+${f.missing.length - 3} more)` : ""} from ${f.dll}, and the ${f.dll} in the game folder does not have ${f.missing.length === 1 ? "it" : "them"}.`;
  const hard = input.findings.filter((f) => f.dllIsVanilla);
  const soft = input.findings.filter((f) => !f.dllIsVanilla);
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
