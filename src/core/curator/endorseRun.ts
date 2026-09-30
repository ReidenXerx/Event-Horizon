/**
 * Endorse a list of mods through Vortex, one at a time, reading each answer
 * back off the mod's `endorsed` attribute before the next is sent.
 *
 * Shared by the curator page's "Endorse all" and the player's "endorse the
 * mods of the collection you play" (2026-09-30), so both keep the same
 * checks: the refusals Vortex's own handler would make are named instead of
 * sent, the status handed over is the CURRENT one (Vortex toggles, so sending
 * "Endorsed" would abstain), and Nexus's rate limit is respected by pacing.
 */

import type { types } from "@nexusmods/vortex-api";

import { readNexusAccount } from "../installer/checkNexusAccount";
import { ehLog } from "../logging/ehLog";
import { endorseRefusal, pendingGameFor, statusToSend, waitForEndorseOutcome, type EndorseRun } from "./endorseOutcome";
import { ENDORSE_PACE_MS } from "./endorsePace";

type ModsByGame = Record<string, Record<string, { attributes?: Record<string, unknown> }> | undefined>;

export async function runEndorsements(
  api: types.IExtensionApi,
  gameId: string,
  targets: ReadonlyArray<{ id: string; name: string; nexusModId?: number }>,
  opts: { signal?: AbortSignal; onProgress?: (text: string) => void; paceMs?: number; logEvent?: string } = {},
): Promise<EndorseRun> {
  const run: EndorseRun = { endorsed: 0, failed: [], timedOut: [], unreadable: [], notSent: [], sent: 0 };
  const event = opts.logEvent ?? "curator.endorse";
  const pool = (): ModsByGame | undefined =>
    (api.getState() as unknown as { persistent?: { mods?: ModsByGame } })?.persistent?.mods;
  const statusUnder = (g: string, id: string): string | undefined =>
    pool()?.[g]?.[id]?.attributes?.endorsed as string | undefined;
  // Vortex's activeGameId is the active profile's game; its handler looks the
  // mod up there, not under the game the caller was working on.
  const activeGameNow = (): string | undefined => {
    const s = api.getState() as unknown as {
      settings?: { profiles?: { activeProfileId?: string } };
      persistent?: { profiles?: Record<string, { gameId?: string }> };
    };
    const profileId = s?.settings?.profiles?.activeProfileId;
    return profileId === undefined ? undefined : s?.persistent?.profiles?.[profileId]?.gameId;
  };
  // Only a definite "logged-out" refuses; an account state Vortex does not
  // describe is not reported as logged out.
  const account = readNexusAccount(api as never).kind;
  for (const mod of targets) {
    if (opts.signal?.aborted === true) break;
    const attributes = pool()?.[gameId]?.[mod.id]?.attributes;
    const why = endorseRefusal({ account, activeGameId: activeGameNow(), gameId, attributes });
    if (why !== undefined) {
      run.notSent.push({ name: mod.name, why });
      ehLog("debug", `${event}.not-sent`, { modId: mod.id, why });
      continue;
    }
    // "pending" lands under downloadGame, and only when the mod is in that
    // game's pool; the answer lands under the active game.
    const markerGame = pendingGameFor(pool(), attributes?.downloadGame, mod.id);
    const before = statusUnder(gameId, mod.id);
    api.events.emit("endorse-mod", gameId, mod.id, statusToSend(before));
    run.sent += 1;
    opts.onProgress?.(`Endorsing ${run.sent} of ${targets.length} — ${mod.name}`);
    const result = await waitForEndorseOutcome({
      read: () => statusUnder(gameId, mod.id),
      ...(markerGame === undefined ? {} : { readPending: () => statusUnder(markerGame, mod.id) }),
      before,
      timeoutMs: 15_000,
    });
    ehLog("debug", `${event}.result`, {
      modId: mod.id,
      nexusModId: mod.nexusModId ?? null,
      result,
      markerGame: markerGame ?? null,
    });
    if (result === "not-sent") {
      run.sent -= 1;
      run.notSent.push({ name: mod.name, why: "Vortex did not start the request (its notification, if any, says why)" });
      continue;
    }
    if (result === "endorsed") run.endorsed += 1;
    else if (result === "timeout") (markerGame === undefined ? run.unreadable : run.timedOut).push(mod.name);
    else run.failed.push(mod.name);
    // Nexus rate-limits; a short gap between answered requests is enough.
    await new Promise((r) => setTimeout(r, opts.paceMs ?? ENDORSE_PACE_MS));
  }
  ehLog("info", `${event}.done`, {
    asked: targets.length,
    sent: run.sent,
    endorsed: run.endorsed,
    failed: run.failed.length,
    timedOut: run.timedOut.length,
    unreadable: run.unreadable.length,
    notSent: run.notSent.reduce<Record<string, number>>((acc, n) => {
      acc[n.why] = (acc[n.why] ?? 0) + 1;
      return acc;
    }, {}),
    account,
    stopped: opts.signal?.aborted === true,
  });
  return run;
}

/**
 * The mods of one collection, as installed in this game, that can be
 * endorsed: from Nexus, with a version, and not answered yet.
 */
export function endorsableCollectionMods(
  api: types.IExtensionApi,
  gameId: string,
  modIds: readonly string[],
): Array<{ id: string; name: string; nexusModId?: number }> {
  const mods = (api.getState() as unknown as { persistent?: { mods?: ModsByGame } })?.persistent?.mods?.[gameId] ?? {};
  const out: Array<{ id: string; name: string; nexusModId?: number }> = [];
  for (const id of new Set(modIds)) {
    const a = mods[id]?.attributes;
    if (a === undefined) continue;
    const nexusModId = Number(a["modId"]);
    const version = a["version"] ?? a["modVersion"];
    const endorsed = a["endorsed"];
    if (!Number.isFinite(nexusModId) || nexusModId <= 0) continue;
    if (version === undefined || version === "") continue;
    if (endorsed !== undefined && endorsed !== "Undecided") continue;
    out.push({ id, name: String(a["customFileName"] ?? a["logicalFileName"] ?? a["name"] ?? id), nexusModId });
  }
  return out;
}
