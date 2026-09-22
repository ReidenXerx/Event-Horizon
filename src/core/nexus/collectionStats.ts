/**
 * What Nexus knows about a collection its curator published — read THROUGH
 * VORTEX, never with the user's key.
 *
 * ─── WHY NOT CALL THE API DIRECTLY ──────────────────────────────────────
 * The v2 GraphQL endpoint answers all of this in one request, and Event
 * Horizon's own scripts use it. Inside Vortex it must not: the key lives in
 * `state.confidential.account.nexus`, which is exactly the state this
 * extension does not read. Vortex already holds the session and exposes it as
 * events, so the events are the door.
 *
 * ─── WHAT THAT COSTS, STATED PLAINLY ────────────────────────────────────
 * Vortex asks for a fixed field set, so what it can answer is fixed too:
 *
 *   `get-nexus-collection`  → endorsements, overallRating (+count),
 *                             recentRating (+count), latest revision, tile
 *   `get-my-collections`    → each revision's number, modCount, rating, dates
 *   `get-nexus-collections` → a game-wide listing that DOES carry
 *                             totalDownloads, matched back by slug
 *
 * Downloads therefore arrive only when the listing answers; `undefined` means
 * "Vortex could not tell us", which the panel says, rather than a zero that
 * would read as "nobody downloaded it".
 */

import type { types } from "@nexusmods/vortex-api";

import { ehLog } from "../logging/ehLog";

type NexusApi = {
  emitAndAwait?: (event: string, ...args: unknown[]) => PromiseLike<unknown>;
};

export interface CollectionRevisionStat {
  revisionNumber: number;
  modCount: number | undefined;
  /** Success rating for that revision, 0..100. */
  ratingAverage: number | undefined;
  createdAt: string | undefined;
}

export interface CollectionStats {
  slug: string;
  name: string | undefined;
  endorsements: number | undefined;
  /** Overall success rating 0..100. `undefined` when nobody has rated it. */
  ratingPercent: number | undefined;
  ratingCount: number;
  latestRevision: number | undefined;
  /** Total downloads, when the game listing carried this collection. */
  totalDownloads: number | undefined;
  /** Oldest revision first, so a sparkline reads left to right. */
  revisions: CollectionRevisionStat[];
  tileUrl: string | undefined;
  /** When this was read. The panel shows its age: these are not live numbers. */
  fetchedAt: number;
}

const num = (v: unknown): number | undefined => {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  // Nexus returns several of these as strings ("33.3", "70235164558").
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
};
const str = (v: unknown): string | undefined => (typeof v === "string" && v !== "" ? v : undefined);

/** Pure: shape Vortex's answers into one record. Exported for tests. */
export function toCollectionStats(args: {
  slug: string;
  collection: unknown;
  myRevisions?: unknown;
  listed?: unknown;
  now: number;
}): CollectionStats {
  const c = (args.collection ?? {}) as Record<string, unknown>;
  const ratingCount = num(c.overallRatingCount) ?? 0;
  /**
   * `get-my-collections` answers with EVERY revision of every collection the
   * curator owns for that game, each carrying its own collection. Filtering
   * belongs here rather than in the caller: a revision list attributed to the
   * wrong collection is a sparkline that silently describes someone else's
   * work, and nothing downstream could tell.
   */
  const revisionsRaw = (Array.isArray(args.myRevisions) ? (args.myRevisions as Record<string, unknown>[]) : []).filter(
    (r) => {
      const owner = (r.collection ?? {}) as Record<string, unknown>;
      return owner.slug === undefined || owner.slug === args.slug;
    },
  );
  const revisions = revisionsRaw
    .map((r) => ({
      revisionNumber: num(r.revisionNumber) ?? 0,
      modCount: num(r.modCount),
      ratingAverage: num((r.rating as Record<string, unknown> | undefined)?.average),
      createdAt: str(r.createdAt),
    }))
    .filter((r) => r.revisionNumber > 0)
    .sort((a, b) => a.revisionNumber - b.revisionNumber);
  const listed = (args.listed ?? undefined) as Record<string, unknown> | undefined;

  return {
    slug: str(c.slug) ?? args.slug,
    name: str(c.name),
    endorsements: num(c.endorsements),
    /**
     * No votes is not 0%. A red "0%" on the curator's own dashboard for a
     * collection nobody has rated is a statement about their work that the
     * data does not support.
     */
    ratingPercent: ratingCount > 0 ? num(c.overallRating) : undefined,
    ratingCount,
    latestRevision: num((c.latestPublishedRevision as Record<string, unknown> | undefined)?.revisionNumber),
    totalDownloads: listed !== undefined ? num(listed.totalDownloads) : undefined,
    revisions,
    tileUrl: str((c.tileImage as Record<string, unknown> | undefined)?.url),
    fetchedAt: args.now,
  };
}

const first = async (api: NexusApi, event: string, ...args: unknown[]): Promise<unknown> => {
  if (api.emitAndAwait === undefined) return undefined;
  try {
    const results = (await api.emitAndAwait(event, ...args)) as unknown[] | undefined;
    return results?.[0];
  } catch (err) {
    ehLog("warn", "dashboard.collection-stats.event-failed", { event, err });
    return undefined;
  }
};

/**
 * Everything Vortex can tell us about one collection.
 *
 * Never throws and never rejects: a dashboard panel is not worth an error
 * dialog, and each field is independently `undefined` when unanswered.
 */
export async function readCollectionStats(args: {
  api: NexusApi;
  slug: string;
  /** The Nexus game domain, for the listing that carries download counts. */
  gameDomain?: string;
  now?: () => number;
}): Promise<CollectionStats | undefined> {
  const collection = await first(args.api, "get-nexus-collection", args.slug);
  if (collection === undefined) return undefined;

  const gameDomain = args.gameDomain;
  const [mine, listing] = await Promise.all([
    first(args.api, "get-my-collections", gameDomain),
    gameDomain !== undefined ? first(args.api, "get-nexus-collections", gameDomain) : Promise.resolve(undefined),
  ]);

  // `get-my-collections` answers with revisions, each carrying its collection.
  const myRevisions = Array.isArray(mine)
    ? (mine as Record<string, unknown>[]).filter(
        (r) => ((r.collection ?? {}) as Record<string, unknown>).slug === args.slug,
      )
    : undefined;
  const listed = Array.isArray(listing)
    ? (listing as Record<string, unknown>[]).find((c) => c.slug === args.slug)
    : undefined;

  return toCollectionStats({
    slug: args.slug,
    collection,
    ...(myRevisions !== undefined ? { myRevisions } : {}),
    ...(listed !== undefined ? { listed } : {}),
    now: (args.now ?? Date.now)(),
  });
}

/**
 * A process-lifetime cache, so switching tabs does not re-ask Nexus. Refresh
 * is a button, not a timer: these numbers change when the curator publishes
 * or a player votes, and a dashboard that polls a public API on a schedule is
 * how an extension gets rate-limited.
 */
const cache = new Map<string, CollectionStats>();

export function cachedCollectionStats(slug: string): CollectionStats | undefined {
  return cache.get(slug);
}

export async function collectionStats(args: {
  api: types.IExtensionApi | NexusApi;
  slug: string;
  gameDomain?: string;
  refresh?: boolean;
}): Promise<CollectionStats | undefined> {
  if (args.refresh !== true) {
    const hit = cache.get(args.slug);
    if (hit !== undefined) return hit;
  }
  const fresh = await readCollectionStats({
    api: args.api as NexusApi,
    slug: args.slug,
    ...(args.gameDomain !== undefined ? { gameDomain: args.gameDomain } : {}),
  });
  // A failed refresh keeps what we had rather than blanking the panel; its
  // `fetchedAt` is what tells the reader they are looking at the older answer.
  if (fresh !== undefined) cache.set(args.slug, fresh);
  return fresh ?? cache.get(args.slug);
}

/** The cache is process-wide, so tests must be able to clear it. */
export function __clearCollectionStatsCache(): void {
  cache.clear();
}
