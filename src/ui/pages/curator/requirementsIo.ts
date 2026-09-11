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

import type { types } from "@nexusmods/vortex-api";

import { ehLog } from "../../../core/logging/ehLog";
import { readPluginMasters, isBaseGameMaster } from "../../../core/manifest/pluginMasters";
import { getVortexUserDataPath } from "../../../core/paths";
import { pluginOwners, readPluginList } from "../../../core/curator/pluginPool";
import type { CuratorMod } from "../../../core/curator/profileActions";
import {
  addMasterRequirements,
  fetchRequirements,
  parseGameList,
  resolveNexusRequirements,
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
  openModPage?: (gameId: string, modId: number, source?: string) => void;
};

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
}): Promise<RequirementsLoad> {
  const { api, gameId, mods } = args;
  const ext = nexusExtOf(api);
  const games = await readGameNumbers();
  const { uidByMod, noUid } = uidsFor(mods, games, gameId);

  let fetched = new Map<string, Partial<NexusModRequirements>>();
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
    const uids = [...uidByMod.values()];
    args.onProgress?.(`Asking Nexus about ${uids.length} mods…`);
    const result = await fetchRequirements({
      uids,
      fetch: ext.getModRequirements,
      signal: args.signal,
      onProgress: (done, total) => args.onProgress?.(`Asking Nexus about mods — ${done} of ${total}`),
    });
    fetched = result.byUid;
    failed = new Set(result.failedUids);
  }

  let report = resolveNexusRequirements({
    mods,
    activeGame: gameId,
    games,
    uidByMod,
    fetched,
    failedUids: failed,
    noUid,
  });

  // Plugin masters: hard requirements, read from the staging copies Vortex
  // lists. Base-game masters are never something to install.
  const plugins = readPluginList(api.getState());
  const masters = new Map<string, readonly string[]>();
  let mastersRead = 0;
  let mastersUnreadable = 0;
  for (const p of plugins) {
    if (args.signal?.aborted === true) break;
    if (p.isNative || p.filePath === undefined || p.modId === undefined) continue;
    const read = await readPluginMasters(p.filePath);
    if (read.kind === "ok") {
      masters.set(p.name, read.masters);
      mastersRead += 1;
    } else {
      mastersUnreadable += 1;
    }
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
  };
}
