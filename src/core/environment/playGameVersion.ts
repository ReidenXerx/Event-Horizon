/**
 * ──────────────────────────────────────────────────────────────────────
 * Play checks the game's version before starting it (owner poll, 2026-09-17).
 *
 * A player's first Play after Steam moved Fallout 4 to next-gen started F4SE,
 * which exited with code 1 eleven seconds later, and nothing said why: a script
 * extender is built for one executable, and Steam had replaced it. The install
 * refuses a mismatched version, but the game can change after the install, and
 * Play is the moment it matters.
 *
 * The requirement is the active collection's, recorded in its receipt
 * (`InstallReceipt.gameVersion`). The version is read from the executable when
 * the game extension can, because Vortex records one at discovery and Steam
 * can update the game after that; otherwise from what Vortex recorded. An
 * unknown on either side never blocks.
 * ──────────────────────────────────────────────────────────────────────
 */

import { util } from "@nexusmods/vortex-api";
import type { types } from "@nexusmods/vortex-api";

import { listReceipts } from "../installLedger";
import { ehLog } from "../logging/ehLog";
import { resolveGameVersion } from "../resolver/userState";
import { compareVersions, gameVersionGuidance } from "../resolver/gameVersionGuidance";
import { STORE_BUILDS, storeTwinsOf } from "./storeBuilds";
import type { InstallReceipt, InstallReceiptGameVersion } from "../../types/installLedger";

export type PlayVersionRefusal = {
  title: string;
  lines: string[];
  steps: string[];
  /**
   * The player ticked "I understand" for exactly this version pair when they
   * installed (owner poll, 2026-09-28): Play warns and offers "Start anyway"
   * instead of refusing. A game that changed AFTER the install is not this
   * case and stays refused.
   */
  acknowledged?: true;
  /** The collection it is about, for remembering a "Start anyway". Set by checkPlayGameVersion. */
  packageId?: string;
  /**
   * The game is the same release on another store (Steam 1.6.1170 for a GOG
   * 1.6.1179 build, `storeTwinsOf`): never refused on the number. Play still
   * checks the game folder for DLLs made for another version, and starts
   * without a word when there are none.
   */
  sameRelease?: true;
};

/** Whether the game at `installed` may be started for a collection that requires `required`. */
export function decidePlayGameVersion(input: {
  gameId: string;
  gameName: string;
  collectionName: string;
  requirement: InstallReceiptGameVersion;
  installed: string | undefined;
  store?: string;
  /** The version pair the player accepted at install (`InstallReceipt.installedOnMismatchedVersion`). */
  acknowledgedAtInstall?: { required: string; installed: string };
}): PlayVersionRefusal | undefined {
  const { installed } = input;
  const { required, policy } = input.requirement;
  if (installed === undefined || installed.trim() === "" || required.trim() === "" || required === "unknown") {
    return undefined;
  }
  // Trailing zeros are the same build ("1.10.163" is "1.10.163.0"); a version
  // that cannot be compared is only refused when it is not the same text.
  const fitsOne = (target: string): boolean => {
    const cmp = compareVersions(installed, target);
    return policy === "exact" ? (cmp === undefined ? installed.trim() === target.trim() : cmp === 0) : cmp === undefined || cmp >= 0;
  };
  if (fitsOne(required)) return undefined;
  // One release, numbered apart per store (kaleidfang21, Meridia Rev 18, Steam
  // 1.6.1170 on a GOG 1.6.1179 build): the collection-update hold has treated
  // these as one game since 0.2.77, and Play told him to move to a build Steam
  // never shipped.
  const twins = storeTwinsOf(input.gameId, required);
  if (twins.some(fitsOne)) {
    return {
      sameRelease: true,
      title: `${input.gameName} ${installed} is the same release as ${required}, which ${input.collectionName} was built on, but some files in your game folder are for another game version.`,
      lines: [],
      steps: [],
    };
  }
  // The build to move to is the player's store's number for that release.
  const storeTarget = input.store !== undefined && twins.length > 0 ? STORE_BUILDS[input.gameId]?.[input.store.toLowerCase()] : undefined;
  const target = storeTarget ?? required;
  const ack = input.acknowledgedAtInstall;
  const acknowledged =
    ack !== undefined &&
    compareVersions(ack.required, required) === 0 &&
    compareVersions(ack.installed, installed) === 0;
  return {
    ...(acknowledged ? { acknowledged: true as const } : {}),
    title: `${input.gameName} is version ${installed}, but ${input.collectionName} was built for ${target}${policy === "minimum" ? " or newer" : ""}.`,
    lines: [
      "The script extender and the collection's plugins only work with the game version the collection was built for, so the game would close or crash on start.",
      ...gameVersionGuidance({ gameId: input.gameId, required: target, installed, retry: "press Play again" }),
    ],
    steps: [
      `Move ${input.gameName} to ${target}, then press Play again.`,
      ...(input.store === "steam"
        ? [
            `Stop Steam updating it again: right-click ${input.gameName} → Properties → Updates → "Only update this game when I launch it", and start the game from Event Horizon's Play.`,
          ]
        : []),
    ],
  };
}

/** The receipt of the collection whose profile Vortex is on, when it records a game version. */
export function activeCollectionReceipt(
  receipts: readonly InstallReceipt[],
  gameId: string,
  activeProfileId: string | undefined,
): InstallReceipt | undefined {
  if (activeProfileId === undefined) return undefined;
  return receipts
    .filter((r) => r.vortexProfileId === activeProfileId && r.gameId === gameId && r.gameVersion !== undefined)
    .sort((a, b) => (a.installedAt < b.installedAt ? 1 : a.installedAt > b.installedAt ? -1 : 0))[0];
}

export async function readInstalledGameVersion(state: types.IState, gameId: string): Promise<string | undefined> {
  try {
    const discovery = (state as unknown as {
      settings?: { gameMode?: { discovered?: Record<string, unknown> } };
    }).settings?.gameMode?.discovered?.[gameId];
    const game = (util as unknown as {
      getGame?: (id: string) => { getInstalledVersion?: (d: unknown) => PromiseLike<string> } | undefined;
    }).getGame?.(gameId);
    if (discovery !== undefined && game?.getInstalledVersion !== undefined) {
      const fromExe = await game.getInstalledVersion(discovery);
      if (typeof fromExe === "string" && fromExe.trim() !== "") return fromExe.trim();
    }
  } catch {
    // A game extension that cannot answer falls back to what Vortex recorded.
  }
  return resolveGameVersion(state, gameId);
}

/** The refusal Play shows when the game's version does not fit the active collection, or `undefined` to go on. */
export async function checkPlayGameVersion(args: {
  api: types.IExtensionApi;
  gameId: string;
  gameName: string;
  store?: string;
  appDataPath: string;
}): Promise<PlayVersionRefusal | undefined> {
  const state = args.api.getState();
  const activeProfileId = (state as unknown as { settings?: { profiles?: { activeProfileId?: string } } }).settings
    ?.profiles?.activeProfileId;
  if (activeProfileId === undefined) {
    ehLog("info", "play.game-version.skipped", { gameId: args.gameId, reason: "no active profile" });
    return undefined;
  }
  let receipts: InstallReceipt[];
  try {
    receipts = await listReceipts(args.appDataPath);
  } catch (err) {
    ehLog("warn", "play.game-version.receipts-unreadable", { gameId: args.gameId, err });
    return undefined;
  }
  const receipt = activeCollectionReceipt(receipts, args.gameId, activeProfileId);
  if (receipt?.gameVersion === undefined) {
    ehLog("info", "play.game-version.skipped", { gameId: args.gameId, reason: "no collection on this profile records a game version" });
    return undefined;
  }
  const installed = await readInstalledGameVersion(state, args.gameId);
  const refusal = decidePlayGameVersion({
    gameId: args.gameId,
    gameName: args.gameName,
    collectionName: receipt.packageName,
    requirement: receipt.gameVersion,
    installed,
    ...(args.store !== undefined ? { store: args.store } : {}),
    ...(receipt.installedOnMismatchedVersion !== undefined
      ? { acknowledgedAtInstall: receipt.installedOnMismatchedVersion }
      : {}),
  });
  if (refusal !== undefined) refusal.packageId = receipt.packageId;
  ehLog(refusal !== undefined ? "warn" : "info", "play.game-version", {
    gameId: args.gameId,
    collection: receipt.packageName,
    required: receipt.gameVersion.required,
    policy: receipt.gameVersion.policy,
    installed: installed ?? "unknown",
    verdict:
      refusal?.sameRelease === true ? "same-release" : refusal !== undefined ? "refused" : installed === undefined ? "unknown" : "ok",
  });
  return refusal;
}
