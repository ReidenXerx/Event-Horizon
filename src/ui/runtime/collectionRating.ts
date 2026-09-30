/**
 * ──────────────────────────────────────────────────────────────────────
 * Sending the vote and the endorsement to Nexus, through Vortex.
 *
 * Read out of Vortex's own bundle rather than guessed, because none of this
 * is in the published typings in a usable form and the typed `api.ext.*`
 * methods are `undefined` at runtime on a real install — the events are the
 * door that actually exists.
 *
 *   emitAndAwait("get-nexus-collection-revision", slug, revisionNumber)
 *       -> IRevision, whose `id` is what the vote needs
 *   emitAndAwait("rate-nexus-collection-revision", revisionId, vote)
 *       -> [{ success, averageRating }]
 *   events.emit("endorse-mod", gameId, modId, status)
 *       -> endorseThing, which branches on mod.attributes.collectionId
 *
 * ─── THE ID TRAP ───────────────────────────────────────────────────────
 * `revisionId` is NOT `revisionNumber`. The number is the human one on the
 * page ("Revision 4") and is what a receipt records; the id is Nexus's
 * internal key and is what the vote is keyed on. Sending the number would
 * rate SOME OTHER collection's revision — a public vote, on a stranger's
 * work. So the number is always exchanged for the id first, and a failure to
 * exchange it means no vote is sent at all.
 *
 * This is the same shape as the endorsement scar already recorded on this
 * project: "endorse takes a different id from update".
 *
 * ─── ENDORSING NEEDS A MOD ENTRY ───────────────────────────────────────
 * Vortex has no collection-endorsement event. `endorse-mod` reaches
 * `endorseThing`, which endorses a COLLECTION when the mod it is handed
 * carries `attributes.collectionId` — the entry Vortex's own collection
 * installer creates. Event Horizon replaces that installer, so the entry
 * usually does not exist. Then Event Horizon adds a placeholder entry for the
 * collection (never enabled, no files), hands it to Vortex, waits for Nexus's
 * answer on it, and removes it again (owner poll, 2026-09-30). The endorsement
 * goes out with the player's own Vortex login, as if they had pressed the
 * button in Vortex's collection view.
 *
 * The game passed here is VORTEX'S id ("skyrimse"), not the Nexus domain
 * ("skyrimspecialedition"): Vortex keys its mod pool by its own id, and the
 * lookup by domain found nothing on every Skyrim install.
 * ──────────────────────────────────────────────────────────────────────
 */

import { actions } from "@nexusmods/vortex-api";
import type { types } from "@nexusmods/vortex-api";

import { statusToSend, waitForEndorseOutcome } from "../../core/curator/endorseOutcome";
import { readNexusAccount } from "../../core/installer/checkNexusAccount";
import { ehLog } from "../../core/logging/ehLog";

export type RateOutcome =
  | { kind: "sent"; average?: number }
  | { kind: "not-logged-in" }
  | { kind: "no-revision" }
  | { kind: "failed"; why: string };

export type EndorseOutcome =
  | { kind: "endorsed" }
  /** Vortex endorses only for the game it is managing right now. */
  | { kind: "wrong-game"; activeGameId?: string }
  | { kind: "not-logged-in" }
  | { kind: "failed"; why: string };

/** Placeholder entries are named so a leftover can always be recognised and removed. */
export const TEMP_ENTRY_PREFIX = "eh-endorse-collection-";

/** Vortex's own wording for the two votes; anything else is rejected there. */
const VOTE = { worked: "positive", "did-not-work": "negative" } as const;

type AnyApi = types.IExtensionApi & {
  emitAndAwait?: (event: string, ...args: unknown[]) => Promise<unknown[]>;
};

/**
 * Turn the revision NUMBER a receipt carries into the id a vote needs.
 *
 * `undefined` rather than a guess when Vortex cannot answer: no id means no
 * vote, which is the only safe direction for a public rating.
 */
export async function resolveRevisionId(
  api: types.IExtensionApi,
  slug: string,
  revisionNumber: number,
): Promise<number | undefined> {
  const emit = (api as AnyApi).emitAndAwait;
  if (typeof emit !== "function") return undefined;
  try {
    const results = await emit.call(
      api,
      "get-nexus-collection-revision",
      slug,
      revisionNumber,
    );
    for (const r of results ?? []) {
      const id = (r as { id?: unknown } | undefined)?.id;
      if (typeof id === "number" && Number.isFinite(id)) return id;
    }
    return undefined;
  } catch (err) {
    ehLog("info", "collection-rating.revision-lookup-failed", {
      slug,
      revisionNumber,
      err,
    });
    return undefined;
  }
}

/** Send the worked / did-not-work vote for one revision. */
export async function rateRevision(
  api: types.IExtensionApi,
  args: { slug: string; revisionNumber: number; answer: keyof typeof VOTE },
): Promise<RateOutcome> {
  const emit = (api as AnyApi).emitAndAwait;
  if (typeof emit !== "function") {
    return { kind: "failed", why: "this Vortex cannot send collection ratings" };
  }
  const revisionId = await resolveRevisionId(api, args.slug, args.revisionNumber);
  if (revisionId === undefined) {
    // Not logged in, offline, or the revision is gone. All of them mean the
    // same thing here: do not send a vote keyed on a number we did not check.
    return { kind: "no-revision" };
  }
  try {
    const results = await emit.call(
      api,
      "rate-nexus-collection-revision",
      revisionId,
      VOTE[args.answer],
    );
    const first = (results ?? [])[0] as
      | { success?: boolean; averageRating?: { average?: number } }
      | undefined;
    if (first?.success !== true) {
      return { kind: "failed", why: "Nexus did not accept the rating" };
    }
    ehLog("info", "collection-rating.sent", {
      slug: args.slug,
      revisionNumber: args.revisionNumber,
      revisionId,
      vote: VOTE[args.answer],
    });
    return {
      kind: "sent",
      ...(typeof first.averageRating?.average === "number"
        ? { average: first.averageRating.average }
        : {}),
    };
  } catch (err) {
    ehLog("info", "collection-rating.failed", { slug: args.slug, err });
    return { kind: "failed", why: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * The Vortex mod entry that represents this collection, if there is one.
 *
 * Exported because "is endorsing possible at all here" is a question the UI
 * has to answer before it offers a button that cannot work.
 */
export function findCollectionModId(
  api: types.IExtensionApi,
  gameId: string,
  collectionId: number,
): string | undefined {
  try {
    const mods = (api.getState() as unknown as {
      persistent?: { mods?: Record<string, Record<string, types.IMod>> };
    })?.persistent?.mods?.[gameId];
    for (const [id, mod] of Object.entries(mods ?? {})) {
      const attrs = mod.attributes as { collectionId?: unknown } | undefined;
      if (attrs?.collectionId === undefined) continue;
      if (Number.parseInt(String(attrs.collectionId), 10) === collectionId) {
        return id;
      }
    }
    return undefined;
  } catch {
    return undefined;
  }
}

type ModsByGame = Record<string, Record<string, { attributes?: Record<string, unknown> }> | undefined>;

const modsOf = (api: types.IExtensionApi): ModsByGame | undefined =>
  (api.getState() as unknown as { persistent?: { mods?: ModsByGame } })?.persistent?.mods;

function activeGameOf(api: types.IExtensionApi): string | undefined {
  const s = api.getState() as unknown as {
    settings?: { profiles?: { activeProfileId?: string } };
    persistent?: { profiles?: Record<string, { gameId?: string }> };
  };
  const profileId = s?.settings?.profiles?.activeProfileId;
  return profileId === undefined ? undefined : s?.persistent?.profiles?.[profileId]?.gameId;
}

/** Removes placeholder entries a crash or a late answer left behind. */
export function removeLeftoverPlaceholders(api: types.IExtensionApi, gameId: string): number {
  const ids = Object.keys(modsOf(api)?.[gameId] ?? {}).filter((id) => id.startsWith(TEMP_ENTRY_PREFIX));
  for (const id of ids) api.store?.dispatch(actions.removeMod(gameId, id));
  return ids.length;
}

/**
 * Endorse the collection, with the player's Vortex login.
 *
 * `"Undecided"` (or whatever the entry holds now) is what Vortex must be
 * HANDED to make it endorse: its handler takes the current status and
 * toggles. The same trap the bulk mod endorse documents in
 * `core/curator/endorseOutcome.ts`: sending "Endorsed" makes it abstain.
 */
export async function endorseCollection(
  api: types.IExtensionApi,
  args: { gameId: string; collectionId: number; name: string; timeoutMs?: number },
): Promise<EndorseOutcome> {
  const active = activeGameOf(api);
  if (active !== undefined && active !== args.gameId) return { kind: "wrong-game", activeGameId: active };
  if (readNexusAccount(api as never).kind === "logged-out") return { kind: "not-logged-in" };
  removeLeftoverPlaceholders(api, args.gameId);

  const existing = findCollectionModId(api, args.gameId, args.collectionId);
  const modId = existing ?? `${TEMP_ENTRY_PREFIX}${args.collectionId}`;
  if (existing === undefined) {
    api.store?.dispatch(
      actions.addMod(args.gameId, {
        id: modId,
        state: "installed",
        type: "",
        installationPath: modId,
        attributes: {
          name: args.name,
          logicalFileName: args.name,
          collectionId: args.collectionId,
          downloadGame: args.gameId,
          source: "nexus",
          endorsed: "Undecided",
        },
      } as never),
    );
    if (modsOf(api)?.[args.gameId]?.[modId] === undefined) {
      return { kind: "failed", why: "Vortex did not take the collection's placeholder entry" };
    }
  }
  const read = (): string | undefined => modsOf(api)?.[args.gameId]?.[modId]?.attributes?.["endorsed"] as string | undefined;
  const before = read();
  let result: Awaited<ReturnType<typeof waitForEndorseOutcome>> = "not-sent";
  try {
    api.events.emit("endorse-mod", args.gameId, modId, statusToSend(before));
    result = await waitForEndorseOutcome({ read, readPending: read, before, timeoutMs: args.timeoutMs ?? 20_000 });
  } finally {
    if (existing === undefined) {
      // A late answer written to a removed entry would leave a half-entry behind,
      // so a request still in flight gets another minute before the entry goes.
      const remove = (): void => void removeLeftoverPlaceholders(api, args.gameId);
      if (result === "timeout") setTimeout(remove, 60_000);
      else remove();
    }
  }
  ehLog("info", "collection-endorse.result", { ...args, modId, placeholder: existing === undefined, result });
  if (result === "endorsed") return { kind: "endorsed" };
  return {
    kind: "failed",
    why:
      result === "abstained"
        ? "Nexus recorded it as withdrawn"
        : result === "timeout"
          ? "Nexus has not answered yet"
          : result === "not-sent"
            ? "Vortex did not send the request"
            : "Nexus refused it (Vortex's notification says why)",
  };
}

/** The page, for when endorsing from here is not possible. */
export const collectionPageUrl = (gameDomain: string, slug: string): string =>
  `https://www.nexusmods.com/games/${gameDomain}/collections/${slug}`;
