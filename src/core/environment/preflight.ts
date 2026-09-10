/**
 * ──────────────────────────────────────────────────────────────────────
 * The environment preflight: probe, decide, log.
 *
 * Runs while a collection loads (so the preview can say it), again when
 * Install is clicked (the machine may have changed in between), and before
 * Play. Every probe here is IO and every verdict comes from
 * environmentChecks.ts, so what the user sees and what the log records are the
 * same decision.
 *
 * The log is the point for remote testers: each check is written with its
 * evidence — the folder Vortex has, the Prefs path looked for, which DLL lacks
 * which export, where the vanilla list came from and what did not match it — so
 * a tester's log alone says why an install was refused.
 * ──────────────────────────────────────────────────────────────────────
 */

import * as fsp from "fs/promises";
import * as path from "path";

import { ehLog } from "../logging/ehLog";
import { probeFilesFor } from "../manifest/externalDependencies";
import { isMachineOwned, parseIni } from "../manifest/gameIni";
import { segmentsOf } from "../paths";
import type { EhcollExternalDependency } from "../../types/ehcoll";
import { probeImportMismatches, type ImportProbe } from "./binaryImports";
import {
  decideBinaryImports,
  decideGameFolder,
  decideGameManaged,
  decideIniLeftovers,
  decideLauncherRan,
  decideProtectedLocation,
  type EnvironmentCheck,
  type IniLeftover,
} from "./environmentChecks";
import {
  groupEntries,
  loadVanillaList,
  scanGameFolder,
  type GameFolderScan,
} from "./gameFolderScan";

/** Everything the preflight needs from Vortex and the OS, read once. */
export type PreflightFacts = {
  gameId: string;
  gameName: string;
  discoveredPath?: string;
  store?: string;
  /** The game's executable, relative to its folder. */
  executable?: string;
  /** Where the launcher writes `<Game>Prefs.ini` for this store. */
  prefsPath?: string;
  /** Whether the game's own launcher writes the Prefs file (false: the game does). */
  hasLauncher?: boolean;
  /** The store-correct My Games folder and this game's INI file names. */
  iniDir?: string;
  iniFiles?: string[];
  /** `section.key`, lower-case, of every INI setting the collection ships. */
  collectionIniKeys?: ReadonlySet<string>;
  /** `%LOCALAPPDATA%\<game folder>` — plugins.txt and ContentCatalog.txt. */
  localGameDir?: string;
  /** Lower-case paths, relative to the game root, of the collection's declared prerequisites. */
  declared: ReadonlySet<string>;
  protectedRoots: string[];
  wine: boolean;
};

export type EnvironmentReport = {
  gameId: string;
  gameName: string;
  gameDir?: string;
  store?: string;
  executable?: string;
  checks: EnvironmentCheck[];
  imports?: ImportProbe;
  folder?: GameFolderScan;
};

const DESTINATION_PREFIX: Record<string, string> = {
  "<gameDir>": "",
  "<dataDir>": "data/",
  "<scripts>": "data/scripts/",
};

/**
 * The files a collection declares as prerequisites, as game-root-relative keys.
 *
 * The manifest records only the files the curator's detection FOUND; the
 * prerequisite's own probe knows every file it consists of (ENB's instructions
 * copy d3dcompiler_46e.dll too), so both are allowed — otherwise cleaning moves
 * half of a prerequisite the user was told to install.
 */
export function declaredPrerequisitePaths(
  deps: readonly EhcollExternalDependency[] | undefined,
): Set<string> {
  const out = new Set<string>();
  for (const dep of deps ?? []) {
    const prefix = DESTINATION_PREFIX[dep.destination] ?? "";
    for (const f of dep.files) {
      out.add(`${prefix}${segmentsOf(f.relPath).join("/")}`.toLowerCase());
    }
    for (const name of probeFilesFor(dep.id)) out.add(name.toLowerCase());
  }
  return out;
}

async function isDirectory(p: string): Promise<boolean> {
  try {
    return (await fsp.stat(p)).isDirectory();
  } catch {
    return false;
  }
}

async function isFile(p: string): Promise<boolean> {
  try {
    return (await fsp.stat(p)).isFile();
  } catch {
    return false;
  }
}

/** Did the game's launcher write this Prefs file? `undefined` when that cannot be judged. */
async function launcherWrotePrefs(prefsPath: string, hasLauncher: boolean | undefined): Promise<boolean | undefined> {
  if (hasLauncher !== true) return undefined;
  try {
    return parseIni(await fsp.readFile(prefsPath, "utf8")).some((s) => isMachineOwned(s.key));
  } catch {
    return undefined;
  }
}

/** `[Archive]` settings in the user's INIs that differ from the game's `<Game>_Default.ini`. */
async function findIniLeftovers(facts: PreflightFacts, gameDir: string): Promise<{ defaultsFile?: string; leftovers: IniLeftover[] }> {
  if (facts.iniDir === undefined || facts.iniFiles === undefined) return { leftovers: [] };
  let names: string[];
  try {
    names = await fsp.readdir(gameDir);
  } catch {
    return { leftovers: [] };
  }
  const defaultsFile = names.find((n) => /^[^_]+_default\.ini$/i.test(n));
  if (defaultsFile === undefined) return { leftovers: [] };
  let defaults: Map<string, string>;
  try {
    defaults = new Map(
      parseIni(await fsp.readFile(path.join(gameDir, defaultsFile), "utf8"))
        .filter((s) => s.section.toLowerCase() === "archive")
        .map((s) => [s.key.toLowerCase(), s.value]),
    );
  } catch {
    return { leftovers: [] };
  }
  const leftovers: IniLeftover[] = [];
  for (const file of facts.iniFiles) {
    let text: string;
    try {
      text = await fsp.readFile(path.join(facts.iniDir, file), "utf8");
    } catch {
      continue;
    }
    for (const s of parseIni(text)) {
      if (s.section.toLowerCase() !== "archive") continue;
      const key = s.key.toLowerCase();
      if (facts.collectionIniKeys?.has(`archive.${key}`) === true) continue;
      const dflt = defaults.get(key);
      if (dflt === s.value) continue;
      leftovers.push({ file, key: s.key, value: s.value, ...(dflt !== undefined ? { defaultValue: dflt } : {}) });
    }
  }
  return { defaultsFile, leftovers };
}

export async function runEnvironmentPreflight(
  facts: PreflightFacts,
  options: { scanFolder: boolean; context: string; signal?: AbortSignal },
): Promise<EnvironmentReport> {
  const startedAt = Date.now();
  const gameDir = facts.discoveredPath;
  const dirExists = gameDir !== undefined && (await isDirectory(gameDir));
  const exeExists =
    dirExists && facts.executable !== undefined && (await isFile(path.join(gameDir!, facts.executable)));

  const report: EnvironmentReport = {
    gameId: facts.gameId,
    gameName: facts.gameName,
    ...(gameDir !== undefined ? { gameDir } : {}),
    ...(facts.store !== undefined ? { store: facts.store } : {}),
    ...(facts.executable !== undefined ? { executable: facts.executable } : {}),
    checks: [],
  };

  report.checks.push(
    decideGameManaged({
      gameName: facts.gameName,
      discoveredPath: gameDir,
      executable: facts.executable,
      dirExists,
      exeExists,
    }),
  );
  const prefsExists = facts.prefsPath !== undefined && (await isFile(facts.prefsPath));
  report.checks.push(
    decideLauncherRan({
      gameName: facts.gameName,
      prefsPath: facts.prefsPath,
      exists: prefsExists,
      launcherWrote: prefsExists ? await launcherWrotePrefs(facts.prefsPath!, facts.hasLauncher) : undefined,
      hasLauncher: facts.hasLauncher,
      store: facts.store,
    }),
  );

  if (gameDir === undefined || !dirExists) {
    logEnvironmentReport(report, options.context, Date.now() - startedAt);
    return report;
  }

  report.checks.push(
    decideProtectedLocation({
      gameName: facts.gameName,
      gameDir,
      protectedRoots: facts.protectedRoots,
      wine: facts.wine,
      store: facts.store,
    }),
  );

  const vanilla = await loadVanillaList(gameDir, facts.executable !== undefined ? { executable: facts.executable } : {});
  const vanillaRootNames = new Set(
    vanilla.kind === "known"
      ? vanilla.files.filter((f) => !f.path.includes("/")).map((f) => f.path.toLowerCase())
      : [],
  );
  // Which executables to hold to the loader check. With a store record: the
  // store's own, because a stray tool beside the game (GOG's Creation Kit is a
  // Steam build) legitimately mismatches. Without one: every root executable,
  // and nothing it finds can block — it cannot tell a game file from a tool.
  let exeNames: string[];
  if (vanilla.kind === "known") {
    exeNames = [...vanillaRootNames].filter((n) => n.endsWith(".exe"));
  } else {
    try {
      exeNames = (await fsp.readdir(gameDir)).filter((n) => n.toLowerCase().endsWith(".exe"));
    } catch {
      exeNames = [];
    }
  }
  if (facts.executable !== undefined && !facts.executable.includes("/") && !facts.executable.includes("\\")) {
    exeNames.push(facts.executable);
  }
  report.imports = await probeImportMismatches({ gameDir, exeNames, vanillaRootNames });
  report.checks.push(
    decideBinaryImports({
      gameName: facts.gameName,
      checked: report.imports.checked,
      findings: report.imports.findings,
      unreadable: report.imports.unreadable,
    }),
  );

  const ini = await findIniLeftovers(facts, gameDir);
  report.checks.push(decideIniLeftovers({ gameName: facts.gameName, defaultsFile: ini.defaultsFile, leftovers: ini.leftovers }));

  if (options.scanFolder) {
    report.folder = await scanGameFolder({
      gameDir,
      ...(facts.localGameDir !== undefined ? { localGameDir: facts.localGameDir } : {}),
      declared: facts.declared,
      ...(facts.executable !== undefined ? { executable: facts.executable } : {}),
      vanilla,
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
    });
    report.checks.push(decideGameFolder({ gameName: facts.gameName, scan: report.folder }));
  }

  logEnvironmentReport(report, options.context, Date.now() - startedAt);
  return report;
}

/** One line per check with its evidence, then the folder and import detail. */
export function logEnvironmentReport(report: EnvironmentReport, context: string, elapsedMs?: number): void {
  for (const c of report.checks) {
    ehLog(c.status === "ok" ? "info" : "warn", "environment.check", {
      context,
      gameId: report.gameId,
      id: c.id,
      status: c.status,
      title: c.title,
      lines: c.lines,
      steps: c.steps,
    });
  }
  if (report.imports !== undefined) {
    ehLog(report.imports.findings.length > 0 ? "warn" : "info", "environment.imports", {
      context,
      checked: report.imports.checked,
      findings: report.imports.findings,
      unreadable: report.imports.unreadable,
    });
  }
  if (report.folder !== undefined) {
    const { report: f } = report.folder;
    ehLog(f.unmanaged.length > 0 || f.vanilla.kind === "unknown" ? "warn" : "info", "environment.game-folder", {
      context,
      gameDir: report.gameDir,
      vanilla: f.vanilla,
      counts: f.counts,
      deployedCount: report.folder.deployedCount,
      manifests: report.folder.manifests,
      creationSources: report.folder.creationSources,
      toolDlls: report.folder.toolDlls,
      linkedDirs: report.folder.linkedDirs,
      unmanaged: f.unmanaged.length,
      groups: groupEntries(f.unmanaged).slice(0, 60),
      unmanagedSample: f.unmanaged.slice(0, 400).map((e) => e.path),
      vanillaMissing: f.vanillaMissing.slice(0, 100),
      vanillaMissingCount: f.vanillaMissing.length,
      vanillaSizeMismatch: f.vanillaSizeMismatch.slice(0, 100),
      unreadable: report.folder.unreadable.slice(0, 50),
    });
  }
  ehLog("info", "environment.preflight.done", {
    context,
    gameId: report.gameId,
    gameDir: report.gameDir,
    store: report.store,
    executable: report.executable,
    verdicts: Object.fromEntries(report.checks.map((c) => [c.id, c.status])),
    ...(elapsedMs !== undefined ? { elapsedMs } : {}),
  });
}
