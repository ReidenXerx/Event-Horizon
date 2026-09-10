/**
 * ──────────────────────────────────────────────────────────────────────
 * Prerequisites that are NOT Vortex mods.
 *
 * A script extender, ENB, a plugin preloader — these live in the game folder,
 * Vortex does not manage them, and no amount of installing mods produces them.
 * A collection that silently assumes they are present reproduces on the
 * curator's machine and nowhere else.
 *
 * The manifest has carried `externalDependencies` since the schema was written,
 * and the whole read side exists: the parser validates them, the resolver
 * verifies each declared file against the user's game folder, and the install
 * UI reports what is missing. The BUILD side has been emitting `[]` the entire
 * time — `externalDependencies: []`, hard-coded. The feature was plumbed end to
 * end except for the end that produces the data.
 *
 * ## Detected, not typed
 *
 * The contract wants a sha256 per file, which is not something a curator can
 * reasonably hand-write. They already have these things installed, so the
 * honest source is their own game folder: find the files, hash them, record
 * what was actually there. The version and the download URL are the only parts
 * a human has to supply, and even the URL has an obvious default per tool.
 *
 * ## Detection is evidence-based, never a guess
 *
 * A lone `d3d11.dll` could be ENB, ReShade, or a dozen other wrappers, so a
 * dependency is only reported when a CORROBORATING file is present too —
 * `enbseries.ini` beside the dll, the extender's own dll beside its loader.
 * Anything that cannot be identified confidently is left out rather than
 * declared, because a wrong prerequisite sends every user of the collection
 * chasing something the curator never had.
 *
 * ## A file the COLLECTION installs is not a prerequisite
 *
 * This is the rule that decides whether the feature helps or actively harms.
 * Finding `f4se_loader.exe` in the game folder does not mean the user must go
 * and install F4SE by hand — on the curator's own profile that file is
 * deployed by a Vortex mod, "Fallout 4 Script Extender (F4SE)-42147-...",
 * which the collection already ships. Declaring it external would send every
 * single user to silverlock.org to hand-install something they were about to
 * receive anyway.
 *
 * So a probe is skipped when any mod in the collection stages one of its
 * required files. What remains is the genuine article: things sitting in the
 * game folder that no mod accounts for.
 * ──────────────────────────────────────────────────────────────────────
 */

import * as fsp from "fs/promises";
import * as path from "path";

import { ehLog } from "../logging/ehLog";
import { hashFileSha256 } from "../archiveHashing";
import type {
  EhcollExternalDependency,
  ExternalDependencyFile,
} from "../../types/ehcoll";

/** One thing we know how to recognise in a game folder. */
type DependencyProbe = {
  id: string;
  name: string;
  category: string;
  /** Games this applies to; empty means all supported games. */
  gameIds: string[];
  /**
   * Every file listed must exist for the dependency to be reported. This is
   * the corroboration rule: one ambiguous file is never enough.
   */
  required: string[];
  /** Recorded when present, but their absence does not disprove anything. */
  optional?: string[];
  instructionsUrl: string;
  instructions: string;
  /** Pull a version out of the files found, when the naming encodes one. */
  version?: (found: string[]) => string | undefined;
};

/**
 * Script-extender loaders are named per game, and the companion dll encodes
 * the GAME version it was built against (`f4se_1_10_163.dll`) — which is
 * exactly the thing a user needs to match, so it is worth capturing.
 */
const SCRIPT_EXTENDER_VERSION = (found: string[]): string | undefined => {
  for (const f of found) {
    const m = /_(\d+)_(\d+)_(\d+)\.dll$/i.exec(f);
    if (m !== null) return `${m[1]}.${m[2]}.${m[3]}`;
  }
  return undefined;
};

const PROBES: DependencyProbe[] = [
  {
    id: "f4se",
    name: "Fallout 4 Script Extender (F4SE)",
    category: "script-extender",
    gameIds: ["fallout4"],
    required: ["f4se_loader.exe"],
    optional: ["f4se_1_10_163.dll", "f4se_1_10_984.dll", "f4se_steam_loader.dll"],
    instructionsUrl: "https://f4se.silverlock.org/",
    instructions:
      "Download the F4SE build that matches your Fallout 4 version and extract " +
      "its files into the game folder, next to Fallout4.exe. Launch the game " +
      "through f4se_loader.exe — mods that need it will not load otherwise.",
    version: SCRIPT_EXTENDER_VERSION,
  },
  {
    id: "skse64",
    name: "Skyrim Script Extender (SKSE64)",
    category: "script-extender",
    gameIds: ["skyrimse"],
    required: ["skse64_loader.exe"],
    optional: ["skse64_steam_loader.dll"],
    instructionsUrl: "https://skse.silverlock.org/",
    instructions:
      "Download the SKSE64 build matching your Skyrim Special Edition version " +
      "and extract it into the game folder. Launch through skse64_loader.exe.",
    version: SCRIPT_EXTENDER_VERSION,
  },
  {
    id: "sfse",
    name: "Starfield Script Extender (SFSE)",
    category: "script-extender",
    gameIds: ["starfield"],
    required: ["sfse_loader.exe"],
    instructionsUrl: "https://github.com/ianpatt/sfse",
    instructions:
      "Download the SFSE build matching your Starfield version and extract it " +
      "into the game folder. Launch through sfse_loader.exe.",
    version: SCRIPT_EXTENDER_VERSION,
  },
  {
    id: "nvse",
    name: "New Vegas Script Extender (NVSE)",
    category: "script-extender",
    gameIds: ["falloutnv"],
    required: ["nvse_loader.exe"],
    instructionsUrl: "https://github.com/xNVSE/NVSE",
    instructions:
      "Extract NVSE into the game folder and launch through nvse_loader.exe.",
    version: SCRIPT_EXTENDER_VERSION,
  },
  {
    id: "fose",
    name: "Fallout Script Extender (FOSE)",
    category: "script-extender",
    gameIds: ["fallout3"],
    required: ["fose_loader.exe"],
    instructionsUrl: "https://fose.silverlock.org/",
    instructions:
      "Extract FOSE into the game folder and launch through fose_loader.exe.",
    version: SCRIPT_EXTENDER_VERSION,
  },
  {
    id: "sse-engine-fixes-part2",
    name: "SSE Engine Fixes (Part 2)",
    category: "engine-injector",
    gameIds: ["skyrimse"],
    // ─── THE ONE THE CURATOR CANNOT SHIP ─────────────────────────────
    // Engine Fixes comes in two halves that install completely differently.
    // Part 1 is an ordinary SKSE plugin, so Vortex handles it and it rides in
    // the collection like any other mod. Part 2 is a set of loose binaries
    // that must sit next to the game executable, and Vortex CANNOT install it
    // — the mod page says to copy the files in by hand, which is why it is
    // not a mod on anybody's machine and why nothing in a collection accounts
    // for it.
    //
    // The failure that follows is quiet. Part 1 ships, installs, verifies, and
    // then does nothing, because the preloader proxy that is supposed to load
    // it is absent. Measured on the real 1753-mod Skyrim collection: Part 1
    // present as "Engine Fixes - Main File" staging SKSE/Plugins/EngineFixes.dll
    // and EngineFixes_preload.txt, Part 2's three binaries sitting loose in the
    // game root, and externalDependencies shipping as [].
    //
    // ONE file, verified from the mod itself rather than assumed.
    //
    // This first required d3dx9_42.dll AND tbb.dll, on my belief that Part 2
    // shipped both. It does not. Read out of the installed mod's staging
    // folder: "Engine Fixes - SKSE64 Preloader" contains exactly
    // `d3dx9_42.dll`, 86.5 KB, and nothing else. The tbb.dll and tbbmalloc.dll
    // in that curator's game root came from something unrelated.
    //
    // The pair was not merely redundant, it was a silent false NEGATIVE: on
    // any machine with Part 2 and no tbb.dll — the normal case — the probe
    // could never fire. It appeared to work only because that one machine
    // happened to have both.
    //
    // A lone d3dx9_42.dll is weaker evidence than the corroborated pairs
    // below, and it is accepted here because Skyrim Special Edition is a
    // DirectX 11 game: it neither ships nor loads a DX9 redistributable, and
    // the whole trick of the preloader is to take a name the game will load
    // anyway. In that folder the file is not there by accident. A false
    // positive costs someone re-installing a mod they have; the false negative
    // costs a collection that ships Part 1 alone and loads nothing.
    required: ["d3dx9_42.dll"],
    instructionsUrl: "https://www.nexusmods.com/skyrimspecialedition/mods/17230",
    instructions:
      "Download the \"Part 2\" file from the Engine Fixes page and extract it " +
      "into the game folder, beside SkyrimSE.exe — NOT into Data, and not " +
      "through Vortex, which cannot install it. Part 1 is already in this " +
      "collection; on its own it loads nothing, so skipping this leaves you " +
      "with a mod that is installed and inert.",
  },
  {
    id: "enb",
    name: "ENBSeries",
    category: "enb",
    gameIds: [],
    // d3d11.dll alone proves nothing — ReShade and other wrappers use the same
    // name. The .ini beside it is what makes this ENB.
    required: ["d3d11.dll", "enbseries.ini"],
    optional: ["enblocal.ini", "enbhost.exe"],
    instructionsUrl: "http://enbdev.com/",
    instructions:
      "Download the ENBSeries binaries for this game from enbdev.com and copy " +
      "d3d11.dll and d3dcompiler_46e.dll into the game folder, then add the " +
      "preset's files. ENB is a graphics wrapper, not a mod — Vortex does not " +
      "install it.",
  },
  {
    id: "xse-plugin-preloader",
    name: "xSE PluginPreloader",
    category: "loader",
    gameIds: [],
    required: ["IpHlpAPI.dll", "xSE PluginPreloader.xml"],
    instructionsUrl: "https://www.nexusmods.com/fallout4/mods/33946",
    instructions:
      "Copy IpHlpAPI.dll and xSE PluginPreloader.xml into the game folder. " +
      "Some F4SE plugins will not load without it.",
  },
];

/**
 * The script extender that starts this game, from the same probe table the
 * build uses to recognise one — one place names each loader.
 */
export function scriptExtenderFor(
  gameId: string,
): { name: string; loader: string; instructionsUrl: string } | undefined {
  const probe = PROBES.find(
    (p) => p.category === "script-extender" && p.gameIds.includes(gameId),
  );
  const loader = probe?.required[0];
  return probe === undefined || loader === undefined
    ? undefined
    : { name: probe.name, loader, instructionsUrl: probe.instructionsUrl };
}

/**
 * The game's install root, from Vortex's own discovery record.
 *
 * Reads state only. Returns undefined when the game was never discovered,
 * which is a "cannot check" and must not be reported as "nothing installed".
 */
export function getGameDirectory(
  state: unknown,
  gameId: string,
): string | undefined {
  const discovered = (
    state as {
      settings?: { gameMode?: { discovered?: Record<string, { path?: string }> } };
    }
  )?.settings?.gameMode?.discovered?.[gameId];
  const p = discovered?.path;
  if (typeof p === "string" && p.length > 0) return p;
  ehLog("debug", "external-deps.game-dir.unresolved", { gameId });
  return undefined;
}

async function findFile(
  gameDir: string,
  relPath: string,
): Promise<string | undefined> {
  try {
    const full = path.join(gameDir, relPath);
    const stat = await fsp.stat(full);
    return stat.isFile() ? full : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Executable code sitting directly in the game folder.
 *
 * Knows nothing about SKSE, ENB or Engine Fixes — it is a directory listing
 * filtered to .dll and .exe. That is the point: the PROBES above encode what I
 * believe about specific mods, and a belief that is wrong fails silently
 * everywhere. One of them required `tbb.dll` as part of Engine Fixes Part 2, on
 * no better evidence than it being in the same folder, and so could never fire
 * on a machine that did not also happen to have it.
 *
 * This cannot be wrong in that direction. It reports what is there; whether any
 * of it matters is a question only the curator can answer, and they are not
 * asked to — the list is informational.
 *
 * Top level only. Recursing would pull in Data/ and every mod in it.
 */
export async function listRootBinaries(gameDir: string): Promise<string[]> {
  try {
    const entries = await fsp.readdir(gameDir, { withFileTypes: true });
    return entries
      .filter((e) => e.isFile() && /\.(dll|exe)$/i.test(e.name))
      .map((e) => e.name)
      .sort((a, b) => a.localeCompare(b));
  } catch {
    // An unreadable game folder is not a finding.
    return [];
  }
}

export type DetectOptions = {
  signal?: AbortSignal;
  /** Reported per dependency so a slow hash is not a silent hang. */
  onProgress?: (name: string) => void;
  /**
   * Lower-cased basenames the collection's own mods install. A probe whose
   * required file appears here is a managed mod, not a prerequisite, and is
   * skipped. See the docblock — this is the rule that keeps the feature from
   * doing harm.
   */
  providedByMods?: ReadonlySet<string>;
};

/**
 * Every file a MOD deployed into the game folder, by lower-cased basename.
 *
 * Vortex's own deployment manifest answers "which mod owns this file" directly
 * and in one read, which beats walking 955 staging folders and is authoritative
 * rather than inferred — it also accounts for merged files. Preferred over
 * {@link filesProvidedByMods} wherever the manifests are available, which is
 * everywhere the build looks, and early enough that the curator can see the
 * result before starting a build.
 */
export function filesProvidedByDeployment(
  manifests: ReadonlyArray<{
    files: ReadonlyArray<{ relPath: string; source?: string }>;
  }>,
): Set<string> {
  const out = new Set<string>();
  for (const manifest of manifests) {
    for (const entry of manifest.files) {
      const norm = entry.relPath.split("\\").join("/");
      const slash = norm.lastIndexOf("/");
      out.add((slash === -1 ? norm : norm.slice(slash + 1)).toLowerCase());
    }
  }
  ehLog("debug", "external-deps.deployed-files", {
    manifests: manifests.length,
    files: out.size,
  });
  return out;
}

/**
 * Every file the collection itself installs, by lower-cased basename.
 *
 * Basename rather than full path on purpose: a prerequisite is identified by
 * the file the game loads (`f4se_loader.exe`), and a mod may stage it at a
 * different relative depth than the game folder expects.
 */
export function filesProvidedByMods(
  mods: ReadonlyArray<{ stagingFiles?: ReadonlyArray<{ path: string }> }>,
): Set<string> {
  const out = new Set<string>();
  for (const mod of mods) {
    for (const file of mod.stagingFiles ?? []) {
      const slash = file.path.lastIndexOf("/");
      out.add((slash === -1 ? file.path : file.path.slice(slash + 1)).toLowerCase());
    }
  }
  ehLog("debug", "external-deps.mod-files", {
    mods: mods.length,
    files: out.size,
  });
  return out;
}

/**
 * Look for known prerequisites in the curator's game folder and describe what
 * is actually there, with real hashes.
 *
 * Never throws for a per-probe problem: an unreadable file drops that file, and
 * a probe whose required set is incomplete is simply not reported.
 */
export const ENGINE_FIXES_PART2_ID = "sse-engine-fixes-part2";

/** The whole of Part 2, lowercased for basename matching. */
const ENGINE_FIXES_PART2_FILE = "d3dx9_42.dll";

/**
 * The collection ships half of Engine Fixes and cannot say where the other
 * half went.
 *
 * The probe above finds Part 2 in the CURATOR's game folder and declares it, so
 * users are told to install it. This is the case the probe cannot help with:
 * the curator does not have Part 2 either.
 *
 * That is not a hypothetical. Part 2 is hand-installed, so it survives nothing
 * — a game reinstall, a move to another drive, a verify-files pass. The
 * curator ends up running Part 1 alone, which loads nothing and reports
 * nothing, and the collection then ships that same silence to everybody.
 *
 * Nothing else notices. Part 1 installs, stages and verifies perfectly; the
 * mod is present and correct and inert. So this is the only place the pairing
 * can be observed, and it is worth one line.
 */
export function describeMissingEngineFixesPart2(args: {
  gameId: string;
  declared: readonly EhcollExternalDependency[];
  /** Lowercase basenames of every file the collection's mods deploy. */
  deployedFiles: ReadonlySet<string>;
}): string | undefined {
  if (args.gameId !== "skyrimse") return undefined;

  // Part 1's own marker. `EngineFixes_preload.txt` is the file that ASKS to be
  // preloaded, so its presence is the mod stating the dependency itself —
  // stronger evidence than matching on a mod name a curator may have renamed.
  const shipsPartOne =
    args.deployedFiles.has("enginefixes_preload.txt") ||
    args.deployedFiles.has("enginefixes.dll");
  if (!shipsPartOne) return undefined;

  if (args.declared.some((d) => d.id === ENGINE_FIXES_PART2_ID)) return undefined;

  // A mod in the collection can supply Part 2, and that is the BEST outcome —
  // it ships with the collection and the user does nothing. The curator who
  // hit this had just achieved it: they installed Part 2 as a Vortex mod with
  // the engine-injector type, so the probe correctly stopped calling it a
  // prerequisite, and this check then announced it was missing from their game
  // folder. It fired BECAUSE they fixed it.
  if (args.deployedFiles.has(ENGINE_FIXES_PART2_FILE)) return undefined;

  ehLog("warn", "external-deps.engine-fixes-part2.missing", {
    gameId: args.gameId,
    declaredCount: args.declared.length,
  });

  return (
    `This collection installs SSE Engine Fixes Part 1, but Part 2 is not in ` +
    `your game folder, so it cannot be shipped as a prerequisite either. Part ` +
    `1 is an SKSE plugin and it does nothing on its own: Part 2's d3dx9_42.dll ` +
    `sits next to SkyrimSE.exe and is what loads it. Your own game is almost ` +
    `certainly running without it too. Install Part 2 by hand from ` +
    `https://www.nexusmods.com/skyrimspecialedition/mods/17230 — Vortex ` +
    `cannot — then build again so users are told to do the same.`
  );
}

export async function detectExternalDependencies(
  gameDir: string,
  gameId: string,
  options: DetectOptions = {},
): Promise<EhcollExternalDependency[]> {
  const startedAt = Date.now();
  ehLog("info", "external-deps.detect.start", {
    gameId,
    probes: PROBES.length,
  });
  const out: EhcollExternalDependency[] = [];

  for (const probe of PROBES) {
    if (options.signal?.aborted === true) {
      ehLog("debug", "external-deps.detect.aborted", { gameId, probe: probe.id });
      break;
    }
    if (probe.gameIds.length > 0 && !probe.gameIds.includes(gameId)) continue;

    // The collection already installs it -> not a prerequisite.
    //
    // EVERY, not SOME. A prerequisite the collection covers only PARTLY is
    // still a prerequisite, and suppressing the whole probe because one of its
    // files happened to be provided hides the rest. That is not hypothetical:
    // it is how a curator who correctly started shipping one half of a
    // dependency got told the other half was missing from their game folder,
    // by a check downstream that saw nothing declared.
    if (
      probe.required.every((rel) =>
        options.providedByMods?.has(path.basename(rel).toLowerCase()) === true,
      )
    ) {
      ehLog("debug", "external-deps.detect.provided-by-mod", { probe: probe.id });
      continue;
    }

    const requiredPaths = await Promise.all(
      probe.required.map(async (rel) => ({ rel, full: await findFile(gameDir, rel) })),
    );
    if (requiredPaths.some((r) => r.full === undefined)) {
      ehLog("debug", "external-deps.detect.probe-absent", { probe: probe.id });
      continue;
    }

    options.onProgress?.(probe.name);

    const optionalPaths = await Promise.all(
      (probe.optional ?? []).map(async (rel) => ({
        rel,
        full: await findFile(gameDir, rel),
      })),
    );

    const files: ExternalDependencyFile[] = [];
    for (const entry of [...requiredPaths, ...optionalPaths]) {
      if (entry.full === undefined) continue;
      try {
        files.push({
          relPath: entry.rel,
          sha256: await hashFileSha256(entry.full, options.signal),
        });
      } catch (err) {
        // A file we cannot read is a file we cannot vouch for. Recording it
        // without a hash is not an option — the type requires one — and
        // guessing is worse than omitting. Log it: this is exactly the kind
        // of swallowed catch that used to leave a bug report unanswerable.
        ehLog("warn", "external-deps.detect.hash-fail", {
          probe: probe.id,
          file: entry.rel,
          err,
        });
      }
    }
    if (files.length === 0) {
      ehLog("warn", "external-deps.detect.probe-empty", { probe: probe.id });
      continue;
    }

    const version = probe.version?.(files.map((f) => f.relPath)) ?? "unknown";
    out.push({
      id: probe.id,
      name: probe.name,
      category: probe.category,
      version,
      destination: "<gameDir>",
      files,
      instructionsUrl: probe.instructionsUrl,
      instructions: probe.instructions,
    });
    ehLog("info", "external-deps.detect.found", {
      probe: probe.id,
      category: probe.category,
      version,
      files: files.length,
    });
  }

  ehLog("info", "external-deps.detect.ok", {
    gameId,
    found: out.length,
    ms: Date.now() - startedAt,
  });

  return out;
}

/**
 * Apply the curator's decisions to what was detected.
 *
 * Detection proposes; the curator disposes. An entry they excluded is dropped,
 * and instructions they wrote replace the generic default — theirs will say
 * which build to get, which the default cannot know.
 */
export type ExternalDependencyOverride = {
  included?: boolean;
  instructions?: string;
  instructionsUrl?: string;
  version?: string;
};

export function applyDependencyOverrides(
  detected: EhcollExternalDependency[],
  overrides: Record<string, ExternalDependencyOverride> | undefined,
): EhcollExternalDependency[] {
  if (overrides === undefined) return detected;
  const out: EhcollExternalDependency[] = [];
  let excluded = 0;
  for (const dep of detected) {
    const o = overrides[dep.id];
    if (o?.included === false) {
      excluded += 1;
      continue;
    }
    out.push({
      ...dep,
      ...(o?.version !== undefined && o.version.length > 0
        ? { version: o.version }
        : {}),
      ...(o?.instructions !== undefined && o.instructions.trim().length > 0
        ? { instructions: o.instructions }
        : {}),
      ...(o?.instructionsUrl !== undefined && o.instructionsUrl.trim().length > 0
        ? { instructionsUrl: o.instructionsUrl }
        : {}),
    });
  }
  ehLog("info", "external-deps.overrides.applied", {
    detected: detected.length,
    excluded,
    result: out.length,
  });
  return out;
}
