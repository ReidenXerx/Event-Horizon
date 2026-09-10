/**
 * ──────────────────────────────────────────────────────────────────────
 * Is this game folder a clean game?
 *
 * Testers arrive with game folders that have lived: a previous collection's
 * leftovers, mods copied in by hand, whatever Vortex left behind after a purge.
 * Any of it can collide with what the collection installs, and none of it shows
 * up in Vortex, so the result is a setup nobody can reproduce or diagnose.
 *
 * ─── WHAT COUNTS (the curator's call) ──────────────────────────────────
 * Only files the game can LOAD: everything under `Data`, and native code
 * (`.dll`, `.asi`) sitting in the game root, where the process picks it up by
 * search order or through an ASI loader. A screenshot, a shortcut, GOG's
 * uninstaller or a Creation Kit install beside the game are never read by the
 * game and are left alone — moving the uninstaller would break the store, and
 * reporting it would teach people to ignore the report.
 *
 * ─── WHAT A FILE IS ALLOWED TO BE ──────────────────────────────────────
 * Every allowance comes from a record something else wrote, never from a list
 * typed in here:
 *   - vanilla   — the store's own install record (storeFileLists.ts)
 *   - deployed  — Vortex's deployment manifests (`vortex.deployment*.json`)
 *   - creation  — Creation Club content the game itself lists: `<Game>.ccc`
 *                 in the game root, and `ContentCatalog.txt` beside plugins.txt
 *   - declared  — the collection's own declared prerequisites
 *   - vortex    — Vortex's bookkeeping files
 *   - volatile  — logs and OS metadata (volatileFiles.ts)
 * What is left is `unmanaged`.
 *
 * With no store record the answer is `unknown`, never "everything is foreign":
 * without a vanilla list, `Fallout4 - Textures1.ba2` is indistinguishable from
 * a mod, and a check that offers to move the game's own archives aside is worse
 * than no check.
 * ──────────────────────────────────────────────────────────────────────
 */

import * as fsp from "fs/promises";
import * as path from "path";

import { ehLog } from "../logging/ehLog";
import { segmentsOf, toPosix } from "../paths";
import { isVolatileFile } from "../volatileFiles";
import {
  parseAppManifest,
  parseDepotManifest,
  parseGogFileList,
  type StoreFile,
} from "./storeFileLists";

/** One file, relative to the game root with "/" separators, original case. */
export type FolderEntry = { path: string; size: number; mtimeMs: number };

export type VanillaList =
  | {
      kind: "known";
      source: "gog" | "steam";
      /** Which record, in words — goes into the log and the snapshot. */
      detail: string;
      files: StoreFile[];
      /** Lower-case root file-name prefixes the store owns (`goggame-<id>.`). */
      ownedRootPrefixes: string[];
    }
  | { kind: "unknown"; reason: string };

export type CreationAllowlist = {
  /** Lower-case file names allowed directly under Data. */
  names: ReadonlySet<string>;
  /** Lower-case plugin stems whose `<stem>.ba2` / `<stem> - *.ba2` archives are allowed. */
  stems: ReadonlySet<string>;
};

export type FileClass =
  | "deployed"
  | "vanilla"
  | "vortex"
  | "declared"
  | "creation"
  | "not-loaded"
  | "volatile"
  | "unmanaged";

export type GameFolderReport = {
  vanilla:
    | { kind: "known"; source: "gog" | "steam"; detail: string; files: number }
    | { kind: "unknown"; reason: string };
  counts: Record<FileClass, number>;
  /** Sorted by path. Always empty when the vanilla list is unknown. */
  unmanaged: FolderEntry[];
  /** Store-recorded game files that are not on disk. */
  vanillaMissing: string[];
  /** Store-recorded game files whose size differs from the record. */
  vanillaSizeMismatch: Array<{ path: string; expected: number; actual: number }>;
};

const ROOT_NATIVE_CODE = /\.(dll|asi)$/i;
const VORTEX_MANIFEST = /^vortex\.deployment(\..+)?\.json$/i;
const VORTEX_MARKER = "__folder_managed_by_vortex";
const VORTEX_BACKUP_SUFFIX = ".vortex_backup";
const ARCHIVE = /\.(ba2|bsa)$/i;

/** Would the game load this file? See the module docblock. */
export function isOnLoadSurface(relPath: string): boolean {
  const lower = relPath.toLowerCase();
  if (lower.startsWith("data/")) return true;
  if (lower.includes("/")) return false;
  return ROOT_NATIVE_CODE.test(lower);
}

export function isVortexArtifact(relPath: string): boolean {
  const name = (relPath.split("/").pop() ?? "").toLowerCase();
  return (
    name === VORTEX_MARKER ||
    VORTEX_MANIFEST.test(name) ||
    name.endsWith(VORTEX_BACKUP_SUFFIX)
  );
}

function isCreation(lower: string, creations: CreationAllowlist): boolean {
  if (!lower.startsWith("data/")) return false;
  const name = lower.slice(5);
  if (name.includes("/")) return false;
  if (creations.names.has(name)) return true;
  if (!ARCHIVE.test(name)) return false;
  const stem = name.replace(ARCHIVE, "");
  if (creations.stems.has(stem)) return true;
  const dash = stem.indexOf(" - ");
  return dash > 0 && creations.stems.has(stem.slice(0, dash));
}

export function classifyGameFolder(input: {
  entries: readonly FolderEntry[];
  vanilla: VanillaList;
  deployed: ReadonlySet<string>;
  creations: CreationAllowlist;
  declared: ReadonlySet<string>;
}): GameFolderReport {
  const { entries, vanilla, deployed, creations, declared } = input;
  const counts: Record<FileClass, number> = {
    deployed: 0,
    vanilla: 0,
    vortex: 0,
    declared: 0,
    creation: 0,
    "not-loaded": 0,
    volatile: 0,
    unmanaged: 0,
  };

  const vanillaByKey = new Map<string, StoreFile>();
  if (vanilla.kind === "known") {
    for (const f of vanilla.files) vanillaByKey.set(f.path.toLowerCase(), f);
  }
  const ownedPrefixes = vanilla.kind === "known" ? vanilla.ownedRootPrefixes : [];

  const present = new Map<string, FolderEntry>();
  const unmanaged: FolderEntry[] = [];
  for (const entry of entries) {
    const lower = entry.path.toLowerCase();
    present.set(lower, entry);
    let cls: FileClass;
    if (deployed.has(lower)) cls = "deployed";
    else if (vanillaByKey.has(lower)) cls = "vanilla";
    else if (!lower.includes("/") && ownedPrefixes.some((p) => lower.startsWith(p))) cls = "vanilla";
    else if (isVortexArtifact(lower)) cls = "vortex";
    else if (declared.has(lower)) cls = "declared";
    else if (isCreation(lower, creations)) cls = "creation";
    else if (!isOnLoadSurface(lower)) cls = "not-loaded";
    else if (isVolatileFile(lower)) cls = "volatile";
    else cls = "unmanaged";

    if (cls === "unmanaged" && vanilla.kind !== "known") {
      // Cannot tell the game's own archives from a mod's. Say nothing rather
      // than something wrong — the report carries the reason instead.
      continue;
    }
    counts[cls] += 1;
    if (cls === "unmanaged") unmanaged.push(entry);
  }

  const vanillaMissing: string[] = [];
  const vanillaSizeMismatch: GameFolderReport["vanillaSizeMismatch"] = [];
  if (vanilla.kind === "known") {
    for (const [key, file] of vanillaByKey) {
      const found = present.get(key);
      if (found === undefined) {
        if (file.required) vanillaMissing.push(file.path);
        continue;
      }
      // A file Vortex deployed over the game's own is a mod's by definition.
      if (deployed.has(key)) continue;
      if (file.size !== undefined && found.size !== file.size) {
        vanillaSizeMismatch.push({ path: found.path, expected: file.size, actual: found.size });
      }
    }
  }

  unmanaged.sort((a, b) => a.path.localeCompare(b.path));
  vanillaMissing.sort((a, b) => a.localeCompare(b));
  vanillaSizeMismatch.sort((a, b) => a.path.localeCompare(b.path));

  return {
    vanilla:
      vanilla.kind === "known"
        ? { kind: "known", source: vanilla.source, detail: vanilla.detail, files: vanilla.files.length }
        : { kind: "unknown", reason: vanilla.reason },
    counts,
    unmanaged,
    vanillaMissing,
    vanillaSizeMismatch,
  };
}

/**
 * Unmanaged files folded into the folders a person would recognise:
 * `Data/F4SE — 305 files`, not 305 lines.
 */
export function groupEntries(
  entries: readonly FolderEntry[],
): Array<{ group: string; files: number; bytes: number }> {
  const groups = new Map<string, { group: string; files: number; bytes: number }>();
  for (const e of entries) {
    const parts = e.path.split("/");
    const group =
      parts.length > 2 && parts[0]!.toLowerCase() === "data"
        ? `${parts[0]}/${parts[1]}`
        : e.path;
    const key = group.toLowerCase();
    const g = groups.get(key) ?? { group, files: 0, bytes: 0 };
    g.files += 1;
    g.bytes += e.size;
    groups.set(key, g);
  }
  return [...groups.values()].sort((a, b) => b.files - a.files || a.group.localeCompare(b.group));
}

// ── IO ───────────────────────────────────────────────────────────────────

export type WalkResult = { entries: FolderEntry[]; unreadable: string[] };

/**
 * Every file under `root`, relative, "/"-separated.
 *
 * `loadSurfaceOnly` walks `Data` and the root's own files and skips every other
 * root sub-folder — which is also what keeps Event Horizon's quarantine folder,
 * a root sub-folder, out of its own scan.
 */
export async function walkFolder(
  root: string,
  options: { loadSurfaceOnly: boolean; signal?: AbortSignal },
): Promise<WalkResult> {
  const entries: FolderEntry[] = [];
  const unreadable: string[] = [];
  const stack: string[] = [""];
  while (stack.length > 0) {
    if (options.signal?.aborted) throw new Error("Scan cancelled");
    const rel = stack.pop()!;
    let dirents: import("fs").Dirent[];
    try {
      dirents = await fsp.readdir(path.join(root, rel), { withFileTypes: true });
    } catch (err) {
      unreadable.push(rel === "" ? "." : rel);
      ehLog("warn", "environment.walk.unreadable", { root, dir: rel, error: String(err) });
      continue;
    }
    for (const d of dirents) {
      const childRel = rel === "" ? d.name : `${rel}/${d.name}`;
      if (d.isDirectory()) {
        if (options.loadSurfaceOnly && rel === "" && d.name.toLowerCase() !== "data") continue;
        stack.push(childRel);
        continue;
      }
      if (!d.isFile() && !d.isSymbolicLink()) continue;
      try {
        const st = await fsp.lstat(path.join(root, childRel));
        entries.push({ path: childRel, size: st.size, mtimeMs: Math.round(st.mtimeMs) });
      } catch (err) {
        unreadable.push(childRel);
        ehLog("warn", "environment.walk.stat-failed", { root, file: childRel, error: String(err) });
      }
    }
  }
  entries.sort((a, b) => a.path.localeCompare(b.path));
  return { entries, unreadable };
}

export type DeploymentManifestSummary = {
  /** Relative to the game root. */
  file: string;
  targetPath?: string;
  deploymentMethod?: string;
  files: number;
};

/**
 * What Vortex has linked into the game folder, from its own manifests.
 *
 * `files[].relPath` is relative to the manifest's `targetPath`, which for the
 * default mod type is `Data` and for `dinput` is the game root — so it is
 * resolved per manifest rather than assumed.
 */
export async function readDeployedFiles(
  gameDir: string,
  entries: readonly FolderEntry[],
): Promise<{ deployed: Set<string>; manifests: DeploymentManifestSummary[]; unreadable: string[] }> {
  const deployed = new Set<string>();
  const manifests: DeploymentManifestSummary[] = [];
  const unreadable: string[] = [];
  for (const entry of entries) {
    const name = entry.path.split("/").pop() ?? "";
    if (!VORTEX_MANIFEST.test(name)) continue;
    const full = path.join(gameDir, entry.path);
    try {
      const json = JSON.parse(await fsp.readFile(full, "utf8")) as {
        targetPath?: unknown;
        deploymentMethod?: unknown;
        files?: Array<{ relPath?: unknown }>;
      };
      const manifestDir = path.dirname(full);
      const target = typeof json.targetPath === "string" && json.targetPath.length > 0 ? json.targetPath : manifestDir;
      let base = path.relative(gameDir, target);
      if (base.startsWith("..") || path.isAbsolute(base)) base = path.relative(gameDir, manifestDir);
      const basePosix = toPosix(base).replace(/^\.$/, "");
      const files = Array.isArray(json.files) ? json.files : [];
      for (const f of files) {
        if (typeof f.relPath !== "string") continue;
        const rel = segmentsOf(f.relPath).join("/");
        deployed.add((basePosix === "" ? rel : `${basePosix}/${rel}`).toLowerCase());
      }
      manifests.push({
        file: entry.path,
        ...(typeof json.targetPath === "string" ? { targetPath: json.targetPath } : {}),
        ...(typeof json.deploymentMethod === "string" ? { deploymentMethod: json.deploymentMethod } : {}),
        files: files.length,
      });
    } catch (err) {
      unreadable.push(entry.path);
      ehLog("warn", "environment.deployment-manifest.unreadable", { file: entry.path, error: String(err) });
    }
  }
  return { deployed, manifests, unreadable };
}

/** The store's record of this install, or why there is none. */
export async function loadVanillaList(gameDir: string): Promise<VanillaList> {
  const tried: string[] = [];

  // GOG
  const gogList = path.join(gameDir, "goggame-galaxyFileList.ini");
  tried.push(gogList);
  try {
    const parsed = parseGogFileList(await fsp.readFile(gogList, "utf8"));
    if (parsed.files.length > 0) {
      return {
        kind: "known",
        source: "gog",
        detail: `${gogList} (products ${parsed.productIds.join(", ") || "none"})`,
        files: parsed.files,
        ownedRootPrefixes: parsed.productIds.map((id) => `goggame-${id}.`),
      };
    }
  } catch {
    // Not a GOG Galaxy install — try Steam.
  }

  // Steam: <library>/steamapps/common/<installdir>
  const commonDir = path.dirname(gameDir);
  const steamapps = path.dirname(commonDir);
  if (path.basename(commonDir).toLowerCase() === "common" && path.basename(steamapps).toLowerCase() === "steamapps") {
    let names: string[] = [];
    try {
      names = await fsp.readdir(steamapps);
    } catch {
      names = [];
    }
    const folder = path.basename(gameDir).toLowerCase();
    for (const name of names) {
      if (!/^appmanifest_\d+\.acf$/i.test(name)) continue;
      const acfPath = path.join(steamapps, name);
      let app: ReturnType<typeof parseAppManifest>;
      try {
        app = parseAppManifest(await fsp.readFile(acfPath, "utf8"));
      } catch {
        continue;
      }
      if (app === undefined || app.installDir.toLowerCase() !== folder) continue;
      tried.push(acfPath);

      const cacheDirs = [
        ...(app.launcherPath !== undefined ? [path.join(path.dirname(app.launcherPath), "depotcache")] : []),
        path.join(path.dirname(steamapps), "depotcache"),
        path.join(steamapps, "depotcache"),
      ];
      const files: StoreFile[] = [];
      const used: string[] = [];
      for (const depot of app.depots) {
        const fileName = `${depot.depotId}_${depot.manifestId}.manifest`;
        let found: Buffer | undefined;
        for (const dir of cacheDirs) {
          try {
            found = await fsp.readFile(path.join(dir, fileName));
            used.push(path.join(dir, fileName));
            break;
          } catch {
            tried.push(path.join(dir, fileName));
          }
        }
        if (found === undefined) {
          if (depot.size === 0) continue;
          return {
            kind: "unknown",
            reason: `Steam's record for depot ${depot.depotId} (${fileName}) is not in depotcache — a partial list would call the game's own files foreign.`,
          };
        }
        const manifest = parseDepotManifest(found);
        if (manifest === undefined || manifest.filenamesEncrypted) {
          return {
            kind: "unknown",
            reason: `Steam's depot manifest ${fileName} could not be read${manifest?.filenamesEncrypted === true ? " (file names are encrypted)" : ""}.`,
          };
        }
        files.push(...manifest.files);
      }
      if (files.length === 0) {
        return { kind: "unknown", reason: `Steam app ${app.appId} lists no readable depots.` };
      }
      return {
        kind: "known",
        source: "steam",
        detail: `${acfPath} → ${used.join(", ")}`,
        files,
        ownedRootPrefixes: [],
      };
    }
  }

  return {
    kind: "unknown",
    reason:
      "No store install record was found (no GOG Galaxy file list, and the game is not in a Steam library with its depot manifests). " +
      `Looked for: ${tried.join("; ")}`,
  };
}

/**
 * Creation Club content the GAME knows about. `.ccc` lists plugin names;
 * `ContentCatalog.txt` (JSON, beside plugins.txt) lists every file of every
 * Creation the player downloaded in-game.
 */
export async function loadCreationAllowlist(
  gameDir: string,
  localGameDir: string | undefined,
): Promise<CreationAllowlist & { sources: string[] }> {
  const names = new Set<string>();
  const stems = new Set<string>();
  const sources: string[] = [];
  try {
    for (const name of await fsp.readdir(gameDir)) {
      if (!name.toLowerCase().endsWith(".ccc")) continue;
      const text = await fsp.readFile(path.join(gameDir, name), "utf8");
      sources.push(name);
      for (const line of text.split(/\r?\n/)) {
        const plugin = line.trim().toLowerCase();
        if (plugin.length === 0) continue;
        names.add(plugin);
        stems.add(plugin.replace(/\.[^.]+$/, ""));
      }
    }
  } catch {
    // No readable root: nothing to allow.
  }
  if (localGameDir !== undefined) {
    const catalog = path.join(localGameDir, "ContentCatalog.txt");
    try {
      const json = JSON.parse(await fsp.readFile(catalog, "utf8")) as Record<string, { Files?: unknown }>;
      sources.push(catalog);
      for (const item of Object.values(json)) {
        if (!Array.isArray(item?.Files)) continue;
        for (const f of item.Files) {
          if (typeof f !== "string") continue;
          const lower = f.trim().toLowerCase();
          names.add(lower);
          if (!ARCHIVE.test(lower)) stems.add(lower.replace(/\.[^.]+$/, ""));
        }
      }
    } catch {
      // Absent or unparseable: nothing downloaded in-game that we can vouch for.
    }
  }
  return { names, stems, sources };
}

export type GameFolderScan = {
  report: GameFolderReport;
  manifests: DeploymentManifestSummary[];
  /** Files Vortex currently has deployed, per its manifests. */
  deployedCount: number;
  unreadable: string[];
  creationSources: string[];
};

export async function scanGameFolder(args: {
  gameDir: string;
  localGameDir?: string;
  /** Lower-case paths, relative to the game root, of declared prerequisites. */
  declared: ReadonlySet<string>;
  /** Already loaded by the caller; read from disk when absent. */
  vanilla?: VanillaList;
  signal?: AbortSignal;
}): Promise<GameFolderScan> {
  const { gameDir } = args;
  const walk = await walkFolder(gameDir, {
    loadSurfaceOnly: true,
    ...(args.signal !== undefined ? { signal: args.signal } : {}),
  });
  const [vanilla, deployment, creations] = await Promise.all([
    args.vanilla ?? loadVanillaList(gameDir),
    readDeployedFiles(gameDir, walk.entries),
    loadCreationAllowlist(gameDir, args.localGameDir),
  ]);

  // The store records files outside the load surface too (`Fallout4/Fallout4Prefs.ini`).
  // Stat just those, so "missing" is not reported for files the walk never visited.
  const entries = [...walk.entries];
  if (vanilla.kind === "known") {
    for (const f of vanilla.files) {
      if (f.path.toLowerCase().startsWith("data/") || !f.path.includes("/")) continue;
      try {
        const st = await fsp.lstat(path.join(gameDir, f.path));
        if (st.isFile() || st.isSymbolicLink()) {
          entries.push({ path: f.path, size: st.size, mtimeMs: Math.round(st.mtimeMs) });
        }
      } catch {
        // Missing — classifyGameFolder reports it if the store requires it.
      }
    }
  }

  const report = classifyGameFolder({
    entries,
    vanilla,
    deployed: deployment.deployed,
    creations,
    declared: args.declared,
  });
  return {
    report,
    manifests: deployment.manifests,
    deployedCount: deployment.manifests.reduce((n, m) => n + m.files, 0),
    unreadable: [...walk.unreadable, ...deployment.unreadable],
    creationSources: creations.sources,
  };
}
