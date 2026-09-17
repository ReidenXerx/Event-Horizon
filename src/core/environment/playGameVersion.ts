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
import type { InstallReceipt, InstallReceiptGameVersion } from "../../types/installLedger";

export type PlayVersionRefusal = { title: string; lines: string[]; steps: string[] };

/** Whether the game at `installed` may be started for a collection that requires `required`. */
export function decidePlayGameVersion(input: {
  gameId: string;
  gameName: string;
  collectionName: string;
  requirement: InstallReceiptGameVersion;
  installed: string | undefined;
  store?: string;
}): PlayVersionRefusal | undefined {
  const { installed } = input;
  const { required, policy } = input.requirement;
  if (installed === undefined || installed.trim() === "" || required.trim() === "" || required === "unknown") {
    return undefined;
  }
  const cmp = compareVersions(installed, required);
  // Trailing zeros are the same build ("1.10.163" is "1.10.163.0"); a version
  // that cannot be compared is only refused when it is not the same text.
  const fits = policy === "exact" ? (cmp === undefined ? installed.trim() === required.trim() : cmp === 0) : cmp === undefined || cmp >= 0;
  if (fits) return undefined;
  return {
    title: `${input.gameName} is version ${installed}, but ${input.collectionName} was built for ${required}${policy === "minimum" ? " or newer" : ""}.`,
    lines: [
      "The script extender and the collection's plugins only work with the game version the collection was built for, so the game would close or crash on start.",
      ...gameVersionGuidance({ gameId: input.gameId, required, installed, retry: "press Play again" }),
    ],
    steps: [
      `Move ${input.gameName} to ${required}, then press Play again.`,
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

async function readInstalledGameVersion(state: types.IState, gameId: string): Promise<string | undefined> {
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
  });
  ehLog(refusal !== undefined ? "warn" : "info", "play.game-version", {
    gameId: args.gameId,
    collection: receipt.packageName,
    required: receipt.gameVersion.required,
    policy: receipt.gameVersion.policy,
    installed: installed ?? "unknown",
    verdict: refusal !== undefined ? "refused" : installed === undefined ? "unknown" : "ok",
  });
  return refusal;
}
