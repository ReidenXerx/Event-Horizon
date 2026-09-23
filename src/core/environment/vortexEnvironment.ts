/**
 * The Vortex-facing half of the environment checks: read what Vortex knows
 * about the game into plain facts, and ask Vortex to purge. Kept thin so every
 * decision stays in modules that run without Vortex.
 */

import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { util } from "@nexusmods/vortex-api";
import type { types } from "@nexusmods/vortex-api";

import { discoveredStore, getCurrentPluginsTxtPath } from "../comparePlugins";
import { ehLog } from "../logging/ehLog";
import { iniLocationFor, launcherWritesPrefsFor, prefsIniPathFor } from "../manifest/gameIni";
import { looksLikeWine, readWineHost } from "../proton";
import { installRootFor } from "../stagingPath";
import type { EhcollExternalDependency, EhcollGameIni } from "../../types/ehcoll";
import { declaredPrerequisitePaths, type PreflightFacts } from "./preflight";
import { syncedFolderRoots } from "./syncedFolders";

export type DiscoveryView = {
  path?: string;
  store?: string;
  executable?: string;
  pathSetManually?: boolean;
};

export function readDiscovery(state: unknown, gameId: string): DiscoveryView {
  const d = (
    state as { settings?: { gameMode?: { discovered?: Record<string, Record<string, unknown>> } } }
  )?.settings?.gameMode?.discovered?.[gameId];
  const str = (v: unknown): string | undefined => (typeof v === "string" && v.length > 0 ? v : undefined);
  const out: DiscoveryView = {};
  const p = str(d?.["path"]);
  if (p !== undefined) out.path = p;
  const store = discoveredStore(state, gameId);
  if (store !== undefined) out.store = store;
  const exe = str(d?.["executable"]);
  if (exe !== undefined) out.executable = exe;
  if (typeof d?.["pathSetManually"] === "boolean") out.pathSetManually = d["pathSetManually"] as boolean;
  return out;
}

type GameLike = { name?: unknown; executable?: unknown };

function knownGame(state: unknown, gameId: string): GameLike | undefined {
  const known = (state as { session?: { gameMode?: { known?: unknown } } })?.session?.gameMode?.known;
  return Array.isArray(known) ? (known as Array<GameLike & { id?: unknown }>).find((g) => g?.id === gameId) : undefined;
}

function extensionGame(gameId: string): GameLike | undefined {
  try {
    const getGame = (util as unknown as { getGame?: (id: string) => GameLike | undefined }).getGame;
    return typeof getGame === "function" ? getGame(gameId) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The executable Vortex would run for this game, relative to its folder.
 *
 * Discovery wins (it is resolved for the installed variant); then the game
 * extension, asked with the discovered path because some extensions pick the
 * executable by what is on disk; then the cached game list.
 */
export function gameExecutable(state: unknown, gameId: string, discovery: DiscoveryView): string | undefined {
  if (discovery.executable !== undefined) return discovery.executable;
  const game = extensionGame(gameId);
  if (typeof game?.executable === "function") {
    try {
      const exe = (game.executable as (p?: string) => unknown)(discovery.path);
      if (typeof exe === "string" && exe.length > 0) return exe;
    } catch {
      // Fall through to the cached value.
    }
  }
  const cached = knownGame(state, gameId)?.executable;
  return typeof cached === "string" && cached.length > 0 ? cached : undefined;
}

export function gameDisplayName(state: unknown, gameId: string): string {
  const name = extensionGame(gameId)?.name ?? knownGame(state, gameId)?.name;
  return typeof name === "string" && name.length > 0 ? name : gameId;
}

export function collectionIniKeys(gameIni: EhcollGameIni | undefined): Set<string> {
  const out = new Set<string>();
  for (const file of gameIni?.files ?? []) {
    for (const s of file.settings) out.add(`${s.section}.${s.key}`.toLowerCase());
  }
  return out;
}

export function gatherPreflightFacts(args: {
  state: unknown;
  gameId: string;
  externalDependencies?: readonly EhcollExternalDependency[];
  gameIni?: EhcollGameIni;
  /** An install's collection: `{ recorded: manifest.game.userOwnedMasters }`. */
  ownedMasters?: { recorded: readonly string[] | undefined };
}): PreflightFacts {
  const { state, gameId } = args;
  const discovery = readDiscovery(state, gameId);
  const executable = gameExecutable(state, gameId, discovery);
  let documentsPath: string | undefined;
  try {
    documentsPath = (util as unknown as { getVortexPath?: (id: string) => string }).getVortexPath?.("documents");
  } catch {
    documentsPath = undefined;
  }
  let localGameDir: string | undefined;
  try {
    localGameDir = path.dirname(getCurrentPluginsTxtPath(gameId, discovery.store));
  } catch {
    // Games without a plugins.txt Event Horizon reads have no Creations catalog either.
    localGameDir = undefined;
  }
  const haveDocuments = documentsPath !== undefined && documentsPath.length > 0;
  const prefsPath = haveDocuments ? prefsIniPathFor(gameId, documentsPath!, discovery.store) : undefined;
  const iniLocation = haveDocuments ? iniLocationFor(gameId, documentsPath!, discovery.store) : undefined;
  const hasLauncher = launcherWritesPrefsFor(gameId);
  let userProfileDir: string | undefined;
  try {
    userProfileDir = (util as unknown as { getVortexPath?: (id: string) => string }).getVortexPath?.("home");
  } catch {
    userProfileDir = undefined;
  }
  if (userProfileDir === undefined || userProfileDir.length === 0) userProfileDir = os.homedir();
  const wine = looksLikeWine();
  const wineHost = wine ? readWineHost(process.env) : undefined;
  const stagingDir = installRootFor(state as types.IState, gameId);
  const syncedRoots = syncedFolderRoots(process.env, (file) => {
    try {
      return fs.readFileSync(file, "utf8");
    } catch {
      return undefined;
    }
  });
  const facts: PreflightFacts = {
    gameId,
    gameName: gameDisplayName(state, gameId),
    ...(discovery.path !== undefined ? { discoveredPath: discovery.path } : {}),
    ...(discovery.store !== undefined ? { store: discovery.store } : {}),
    ...(executable !== undefined ? { executable } : {}),
    ...(prefsPath !== undefined ? { prefsPath } : {}),
    ...(hasLauncher !== undefined ? { hasLauncher } : {}),
    ...(iniLocation !== undefined ? { iniDir: iniLocation.dir, iniFiles: iniLocation.files } : {}),
    collectionIniKeys: collectionIniKeys(args.gameIni),
    ...(localGameDir !== undefined ? { localGameDir } : {}),
    declared: declaredPrerequisitePaths(args.externalDependencies),
    protectedRoots: [process.env["ProgramFiles"], process.env["ProgramFiles(x86)"], process.env["ProgramW6432"]].filter(
      (p): p is string => typeof p === "string" && p.length > 0,
    ),
    syncedRoots,
    ...(stagingDir !== undefined ? { stagingDir } : {}),
    ...(args.ownedMasters !== undefined ? { ownedMasters: args.ownedMasters } : {}),
    wine,
    ...(userProfileDir.length > 0 ? { userProfileDir } : {}),
    ...(wineHost !== undefined ? { wineHost } : {}),
  };
  ehLog("info", "environment.facts", {
    gameId,
    discovery,
    executable,
    prefsPath,
    hasLauncher,
    iniDir: iniLocation?.dir,
    collectionIniKeys: facts.collectionIniKeys?.size,
    localGameDir,
    documentsPath,
    declared: [...facts.declared],
    protectedRoots: facts.protectedRoots,
    syncedRoots,
    stagingDir,
    // How many Creation Club files the collection records; null when it predates the list.
    ownedMasters: args.ownedMasters === undefined ? undefined : (args.ownedMasters.recorded?.length ?? null),
    wine: facts.wine,
    userProfileDir,
    wineHost,
  });
  return facts;
}

/**
 * Vortex's own purge, for the ACTIVE game.
 *
 * Read out of Vortex's bundle (app.asar), not the typings:
 *   events.on("purge-mods", (allowFallback, callback) =>
 *     purgeMods(api).catch(err => allowFallback ? fallbackPurge(api) : reject(err))
 *       .then(() => callback(null)).catch(err => callback(err)))
 * No fallback: a purge that could not run normally should stop the install,
 * not be papered over.
 */
export function purgeGameDeployment(
  api: {
    events: { emit: (event: string, ...args: unknown[]) => unknown };
  },
  options: {
    /**
     * How long to wait for Vortex's callback before giving up.
     *
     * NOT a cap on how long a purge may legitimately take — it is sized by the
     * caller from the mod count (`deployBudgetMs`), the same budget the deploy
     * uses, because a purge unlinks what a deploy linked. Its job is to end a
     * wait for a callback that is never coming: `emit` returns nothing, so a
     * purge-mods with no listener, or a handler that throws before calling
     * back, leaves this promise pending FOREVER with no error and no UI.
     *
     * The driver's own purge has always been wrapped like this. The clean-game
     * path before an install was not, and that is the asymmetry this closes.
     */
    timeoutMs?: number;
  } = {},
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const timer =
      options.timeoutMs === undefined
        ? undefined
        : setTimeout(() => {
            if (settled) return;
            settled = true;
            reject(
              new Error(
                `Vortex did not answer the purge within ${Math.round(
                  (options.timeoutMs ?? 0) / 1000,
                )}s. Check its notifications — nothing was moved.`,
              ),
            );
          }, options.timeoutMs);
    api.events.emit("purge-mods", false, (err: unknown) => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      if (err === null || err === undefined) resolve();
      else reject(err instanceof Error ? err : new Error(String(err)));
    });
  });
}
