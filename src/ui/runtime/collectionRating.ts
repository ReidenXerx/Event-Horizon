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
 * installer creates. Event Horizon replaces that installer, so the entry may
 * not exist, and that is a fact about the machine rather than something this
 * module can fix. When no entry carries the id, the honest outcome is
 * "cannot from here" and the player is sent to the page, which always works.
 * ──────────────────────────────────────────────────────────────────────
 */

import type { types } from "@nexusmods/vortex-api";

import { ehLog } from "../../core/logging/ehLog";

export type RateOutcome =
  | { kind: "sent"; average?: number }
  | { kind: "not-logged-in" }
  | { kind: "no-revision" }
  | { kind: "failed"; why: string };

export type EndorseOutcome =
  | { kind: "endorsed" }
  | { kind: "no-mod-entry" }
  | { kind: "failed"; why: string };

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

/**
 * Endorse the collection.
 *
 * `"Undecided"` is what Vortex must be HANDED to make it endorse — its
 * handler takes the current status and toggles. The same trap the bulk mod
 * endorse already documents in `core/curator/endorseOutcome.ts`: sending
 * "Endorsed", the state we want, makes it abstain instead.
 */
export function endorseCollection(
  api: types.IExtensionApi,
  args: { gameId: string; collectionId: number },
): EndorseOutcome {
  const modId = findCollectionModId(api, args.gameId, args.collectionId);
  if (modId === undefined) return { kind: "no-mod-entry" };
  try {
    api.events.emit("endorse-mod", args.gameId, modId, "Undecided");
    ehLog("info", "collection-endorse.sent", { ...args, modId });
    return { kind: "endorsed" };
  } catch (err) {
    return { kind: "failed", why: err instanceof Error ? err.message : String(err) };
  }
}

/** The page, for when endorsing from here is not possible. */
export const collectionPageUrl = (gameDomain: string, slug: string): string =>
  `https://www.nexusmods.com/games/${gameDomain}/collections/${slug}`;
