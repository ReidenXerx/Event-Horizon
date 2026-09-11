/**
 * The I/O half of the requirements feature: Vortex's live `api.ext` surface,
 * its games cache on disk, and the plugin headers in staging. Everything
 * that decides anything lives in `core/curator/requirements.ts` and is
 * tested there; this only fetches and hands over.
 *
 * `api.ext` is the surface that exists at runtime. The `INexusAPIExtension`
 * typings on `api` itself are a decoy (see memory: nexus-is-event-based),
 * so every function here is looked up by name and reported absent rather
 * than assumed.
 */

import * as fsp from "fs/promises";
import * as path from "path";

import { selectors, util, type types } from "@nexusmods/vortex-api";

import { ehLog } from "../../../core/logging/ehLog";
import { readPluginHeader, isBaseGameMaster } from "../../../core/manifest/pluginMasters";
import { pluginCapabilityFor, type PluginCapability, type PluginHeader } from "../../../core/curator/pluginView";
import { getVortexUserDataPath } from "../../../core/paths";
import { installRootFor, stagingRootFromFolder } from "../../../core/stagingPath";
import { pluginOwners, readPluginList, type PluginEntry } from "../../../core/curator/pluginPool";
import type { CuratorMod } from "../../../core/curator/profileActions";
import {
  addMasterRequirements,
  fetchRequirements,
  nexusDomainOf,
  parseGameList,
  resolveNexusRequirements,
  reusableAnswers,
  uidsFor,
  type GameNumbers,
  type NexusFileInfo,
  type NexusModRequirements,
  type RequirementsReport,
} from "../../../core/curator/requirements";

/** The `api.ext` functions this feature uses, when Vortex provides them. */
export type NexusExt = {
  getModRequirements?: (uids: string[]) => Promise<Record<string, Partial<NexusModRequirements>>>;
  getModFiles?: (gameId: string, modId: number) => Promise<NexusFileInfo[]>;
  download?: (
    gameId: string,
    modId: number,
    fileId: number,
    fileName?: string,
    allowInstall?: boolean,
  ) => Promise<string | undefined>;
  /** Vortex ignores the call unless `source` is the literal "nexus". */
  openModPage?: (gameId: string, modId: number, source: "nexus") => void;
};

/**
 * Vortex id → Nexus domain, AS VORTEX CONVERTS IT.
 *
 * Vortex exports the converter: `util.nexusGameId(game, fallbackGameId)`
 * (vortex-api typings; present at runtime — the installed app.asar exports
 * `exports.nexusGameId = function nexusGameId(game, fallbackGameId)`, which
 * returns `game.details.nexusPageId` when set, else its own table, else the
 * id). It is asked first, with the game Vortex has for the id, so a game
 * extension Vortex knows and this code does not is converted correctly.
 * `nexusDomainOf` in the core — the same rule, with a copy of Vortex's table
 * — is only the fallback for a Vortex that does not export it.
 */
export function nexusDomainForVortexGame(vortexGameId: string): string {
  const u = util as unknown as {
    nexusGameId?: (game: unknown, fallbackGameId?: string) => unknown;
    getGame?: (id: string) => { details?: { nexusPageId?: unknown } } | undefined;
  };
  let game: { details?: { nexusPageId?: unknown } } | undefined;
  try {
    game = typeof u.getGame === "function" ? u.getGame(vortexGameId) : undefined;
  } catch {
    game = undefined; // getGame on an id Vortex does not know
  }
  if (typeof u.nexusGameId === "function") {
    try {
      const domain = u.nexusGameId(game, vortexGameId);
      if (typeof domain === "string" && domain !== "") return domain;
    } catch {
      /* fall through to the documented fallback */
    }
  }
  const pageId = game?.details?.nexusPageId;
  return nexusDomainOf(vortexGameId, typeof pageId === "string" ? pageId : undefined);
}

/**
 * Where Vortex deploys each mod type for a game: `selectors.modPathsForGame`,
 * which is `game.getModPaths(discovery.path)` — `{ "": <default mod path>,
 * <typeId>: <path> }` (read from the installed app.asar). Undefined when this
 * Vortex has no such selector, the game is not discovered, or it throws.
 */
export function modPathsOf(state: unknown, gameId: string): Record<string, string> | undefined {
  try {
    const select = (selectors as unknown as { modPathsForGame?: (s: unknown, id: string) => unknown }).modPathsForGame;
    const paths = typeof select === "function" ? select(state, gameId) : undefined;
    if (paths === null || typeof paths !== "object") return undefined;
    const out: Record<string, string> = {};
    for (const [typeId, p] of Object.entries(paths as Record<string, unknown>)) if (typeof p === "string") out[typeId] = p;
    return out;
  } catch (err) {
    ehLog("warn", "curator.mod-paths.unreadable", { gameId, err });
    return undefined;
  }
}

/**
 * The game's plugin rules (light plugins, regular-slot limit), with the game
 * extension's own `details.supportsESL` applied the way Vortex's plugin
 * management applies it. Undefined for a game that extension does not know.
 */
export function pluginCapabilityForGame(gameId: string): PluginCapability | undefined {
  let details: { supportsESL?: unknown } | undefined;
  try {
    const getGame = (util as unknown as { getGame?: (id: string) => { details?: { supportsESL?: unknown } } | undefined }).getGame;
    details = typeof getGame === "function" ? getGame(gameId)?.details : undefined;
  } catch {
    details = undefined;
  }
  return pluginCapabilityFor(gameId, details);
}

/** Every game this Vortex has an extension for. */
export function knownGameIds(state: unknown): string[] {
  const known = (state as { session?: { gameMode?: { known?: unknown } } })?.session?.gameMode?.known;
  if (!Array.isArray(known)) return [];
  return known.map((g) => (g as { id?: unknown })?.id).filter((id): id is string => typeof id === "string" && id !== "");
}

const PLUGIN_FILE = /\.(esp|esm|esl)$/i;

/**
 * The plugins a DISABLED mod would ship, from its staging folder.
 *
 * Vortex's `pluginList` is built from enabled mods only, so a master
 * shipped by a mod the curator switched off is invisible to it — and a
 * requirements report that then says "missing" sends the curator to Nexus
 * for something already in the pool (NS-3). One directory listing per
 * disabled mod, top level only, which is where a plugin has to sit.
 */
export async function pluginsOfDisabledMods(
  state: types.IState,
  gameId: string,
  mods: readonly CuratorMod[],
  signal?: AbortSignal,
): Promise<PluginEntry[]> {
  const root = installRootFor(state, gameId);
  if (root === undefined) return [];
  const out: PluginEntry[] = [];
  for (const m of mods) {
    if (signal?.aborted === true) break;
    if (m.enabled || m.installationPath === undefined) continue;
    const dir = stagingRootFromFolder(root, m.installationPath);
    if (dir === undefined) continue;
    let names: string[];
    try {
      names = await fsp.readdir(dir);
    } catch {
      continue; // staging gone or unreadable: nothing to claim
    }
    for (const name of names) {
      if (!PLUGIN_FILE.test(name)) continue;
      out.push({
        name,
        modId: m.id,
        filePath: path.join(dir, name),
        isNative: false,
        enabled: false,
        fromDisabledMod: true,
      });
    }
  }
  return out;
}

export function nexusExtOf(api: types.IExtensionApi): NexusExt {
  const ext = (api as unknown as { ext?: Record<string, unknown> }).ext ?? {};
  const fn = <T>(name: string): T | undefined =>
    typeof ext[name] === "function" ? (ext[name] as T) : undefined;
  return {
    getModRequirements: fn("nexusGetModRequirements"),
    getModFiles: fn("nexusGetModFiles"),
    download: fn("nexusDownload"),
    openModPage: fn("nexusOpenModPage"),
  };
}

/** Nexus's numeric game ids, from the cache Vortex keeps beside its data. */
export async function readGameNumbers(): Promise<GameNumbers> {
  try {
    const file = path.join(getVortexUserDataPath(), "temp", "nexus_gamelist.json");
    return parseGameList(await fsp.readFile(file, "utf8"));
  } catch (err) {
    ehLog("warn", "curator.requirements.gamelist-unreadable", { err });
    return new Map();
  }
}

export type RequirementsLoad = {
  report: RequirementsReport;
  games: GameNumbers;
  /** Why nothing could be fetched, when that is the case. */
  unavailable?: string;
  /** How many mods Nexus was asked about, and how many answers came back. */
  asked: number;
  answered: number;
  mastersRead: number;
  mastersUnreadable: number;
  /**
   * The plugin list as it was when the headers were read: Vortex's own list
   * plus the plugins of disabled mods (marked `fromDisabledMod`).
   */
  plugins: PluginEntry[];
  /** Per plugin name: masters and flags, or why the header could not be read. */
  headers: Map<string, PluginHeader>;
  /** The curator pressed Stop: the report is partial and must not pose as whole. */
  stopped: boolean;
  /** What Nexus said, by UID, so a later read after an install asks only about the new mods. */
  fetched: Map<string, Partial<NexusModRequirements>>;
  /**
   * When each answer in `fetched` was fetched from Nexus. A reused answer
   * keeps its time: the reuse window is per answer, never per read.
   */
  fetchedAtByUid: Map<string, number>;
};

/**
 * Build the whole report for the active game: Nexus requirements for every
 * Nexus mod, then plugin masters for every plugin Vortex lists.
 */
export async function loadRequirements(args: {
  api: types.IExtensionApi;
  gameId: string;
  mods: readonly CuratorMod[];
  signal?: AbortSignal;
  onProgress?: (message: string) => void;
  /**
   * A previous load for the same game: its Nexus answers younger than
   * `maxReuseAgeMs` are reused and only the other UIDs are fetched. Plugin
   * headers are always re-read (local, and the pool may have new plugins).
   */
  previous?: RequirementsLoad;
  /** How old a reused answer may be, from its own fetch. Absent: nothing is reused. */
  maxReuseAgeMs?: number;
}): Promise<RequirementsLoad> {
  const { api, gameId, mods } = args;
  const ext = nexusExtOf(api);
  const games = await readGameNumbers();
  // Vortex ids and Nexus domains are different namespaces (skyrimse vs
  // skyrimspecialedition); everything below the edge speaks Nexus.
  const toDomain = nexusDomainForVortexGame;
  const { uidByMod, noUid } = uidsFor(mods, games, gameId, toDomain);

  let fetched = new Map<string, Partial<NexusModRequirements>>();
  const fetchedAtByUid = new Map<string, number>();
  let failed = new Set<string>();
  let unavailable: string | undefined;
  if (ext.getModRequirements === undefined) {
    unavailable =
      "This Vortex build does not expose nexusGetModRequirements, so Nexus requirements cannot be read here.";
    ehLog("warn", "curator.requirements.ext-missing");
  } else if (games.size === 0) {
    unavailable =
      "Vortex's Nexus games cache is missing, so mod pages cannot be addressed. Open the Nexus tab once and try again.";
  } else {
    // Only answers for mods STILL in the pool are carried over, or a removed
    // mod's page would count as answered and the map would grow forever; and
    // only answers young enough by THEIR OWN fetch time.
    const now = Date.now();
    const reuse =
      args.previous === undefined
        ? new Map<string, { raw: Partial<NexusModRequirements>; fetchedAt: number }>()
        : reusableAnswers({
            fetched: args.previous.fetched,
            fetchedAt: args.previous.fetchedAtByUid ?? new Map(),
            wanted: new Set(uidByMod.values()),
            now,
            maxAgeMs: args.maxReuseAgeMs ?? 0,
          });
    if (args.previous !== undefined) {
      ehLog("info", "curator.requirements.reuse", {
        previous: args.previous.fetched.size,
        reused: reuse.size,
        notReused: args.previous.fetched.size - reuse.size,
        maxAgeMs: args.maxReuseAgeMs ?? 0,
      });
    }
    const uids = [...uidByMod.values()].filter((u) => !reuse.has(u));
    if (uids.length > 0) {
      args.onProgress?.(`Asking Nexus about ${uids.length} mods…`);
      const result = await fetchRequirements({
        uids,
        fetch: ext.getModRequirements,
        signal: args.signal,
        onProgress: (done, total) => args.onProgress?.(`Asking Nexus about mods — ${done} of ${total}`),
      });
      fetched = result.byUid;
      for (const uid of fetched.keys()) fetchedAtByUid.set(uid, now);
      failed = new Set(result.failedUids);
    }
    for (const [uid, kept] of reuse) {
      if (fetched.has(uid)) continue;
      fetched.set(uid, kept.raw);
      fetchedAtByUid.set(uid, kept.fetchedAt);
    }
  }

  let report = resolveNexusRequirements({
    mods,
    activeGame: gameId,
    games,
    uidByMod,
    fetched,
    failedUids: failed,
    noUid,
    toDomain,
    knownGameIds: knownGameIds(api.getState()),
  });

  // Plugin headers: masters are hard requirements, and the light flag is
  // what decides the regular-slot count. Read from the copies Vortex lists
  // (staging for a mod's plugin, the game folder for a native one). Base-game
  // masters are never something to install.
  const listed = readPluginList(api.getState());
  const seenLower = new Set(listed.map((p) => p.name.toLowerCase()));
  // Two disabled installs of one mod ship the same plugin file: keep the
  // first, or the two rows would share an id and the master would be
  // attributed to whichever was iterated last.
  const fromDisabled: PluginEntry[] = [];
  for (const p of await pluginsOfDisabledMods(api.getState(), gameId, mods, args.signal)) {
    const key = p.name.toLowerCase();
    if (seenLower.has(key)) continue;
    seenLower.add(key);
    fromDisabled.push(p);
  }
  const plugins = [...listed, ...fromDisabled];
  const masters = new Map<string, readonly string[]>();
  const headers = new Map<string, PluginHeader>();
  let mastersRead = 0;
  let mastersUnreadable = 0;
  let n = 0;
  // The flags are decoded the way THIS game reads them; an unknown game gets
  // masters and no flags rather than a guessed bit.
  const capability = pluginCapabilityForGame(gameId);
  ehLog("debug", "curator.plugin-headers.semantics", {
    gameId,
    known: capability !== undefined,
    lightFlagBit: capability?.lightFlagBit,
    mediumFlagBit: capability?.mediumFlagBit,
  });
  for (const p of plugins) {
    if (args.signal?.aborted === true) break;
    if (p.filePath === undefined) continue;
    n += 1;
    if (n % 50 === 0) args.onProgress?.(`Reading plugin headers — ${n} of ${plugins.length}`);
    const read = await readPluginHeader(p.filePath, capability);
    const header: PluginHeader = {};
    if (read.kind === "ok") {
      header.masters = read.masters;
      if (read.flags !== undefined) header.flags = read.flags;
      if (p.modId !== undefined && !p.isNative) {
        masters.set(p.name, read.masters);
        mastersRead += 1;
      }
    } else {
      header.unreadable = read.kind === "not-found" ? `no file at ${p.filePath}` : `${read.why} (${p.filePath})`;
      if (p.modId !== undefined && !p.isNative) mastersUnreadable += 1;
    }
    headers.set(p.name, header);
  }
  if (masters.size > 0) {
    report = addMasterRequirements(report, {
      mods,
      owners: pluginOwners(plugins),
      masters,
      isBaseGame: (m) => isBaseGameMaster(m, gameId),
    });
  }

  ehLog("info", "curator.requirements.loaded", {
    gameId,
    asked: uidByMod.size,
    answered: fetched.size,
    failed: failed.size,
    noUid: noUid.length,
    mastersRead,
    mastersUnreadable,
  });

  return {
    report,
    games,
    ...(unavailable === undefined ? {} : { unavailable }),
    asked: uidByMod.size,
    answered: fetched.size,
    mastersRead,
    mastersUnreadable,
    plugins,
    headers,
    stopped: args.signal?.aborted === true,
    fetched,
    fetchedAtByUid,
  };
}
