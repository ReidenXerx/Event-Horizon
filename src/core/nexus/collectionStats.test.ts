/**
 * The curator cockpit's numbers, read through Vortex.
 *
 * Every one of these guards the same property: a figure Nexus did not give us
 * must arrive as `undefined` and render as "—". A zero download count or a 0%
 * success rating shown for a collection nobody has rated is a statement about
 * the curator's work that the data does not support.
 */
import { beforeEach, describe, expect, it } from "vitest";

import {
  __clearCollectionStatsCache,
  collectionStats,
  readCollectionStats,
  toCollectionStats,
} from "./collectionStats";

/** What `get-nexus-collection` really answers with (Vortex's FULL_COLLECTION_INFO). */
const collection = {
  id: 510746,
  slug: "ecb76c",
  name: "Meridia's Panties - Event Horizon",
  endorsements: 0,
  overallRating: "33.3",
  overallRatingCount: 3,
  latestPublishedRevision: { id: 1, revisionNumber: 5 },
  tileImage: { url: "https://media.nexusmods.com/tile.png" },
};

/** `get-my-collections` answers with revisions, each carrying its collection. */
const myRevisions = [
  { revisionNumber: 2, modCount: 1746, rating: { average: 33.3, total: 3 }, createdAt: "2026-09-17T00:00:00Z", collection: { slug: "ecb76c" } },
  { revisionNumber: 1, modCount: 1740, rating: { average: 0, total: 0 }, createdAt: "2026-09-16T00:00:00Z", collection: { slug: "ecb76c" } },
  { revisionNumber: 9, modCount: 964, rating: { average: 0, total: 0 }, createdAt: "2026-09-20T00:00:00Z", collection: { slug: "other" } },
];

describe("shaping what Vortex answers", () => {
  it("reads the numbers, including the ones Nexus sends as strings", () => {
    const s = toCollectionStats({ slug: "ecb76c", collection, myRevisions, listed: { slug: "ecb76c", totalDownloads: 303 }, now: 42 });
    expect(s).toMatchObject({
      slug: "ecb76c",
      endorsements: 0,
      ratingPercent: 33.3,
      ratingCount: 3,
      latestRevision: 5,
      totalDownloads: 303,
      fetchedAt: 42,
    });
    // Oldest first, and only this collection's revisions.
    expect(s.revisions.map((r) => r.revisionNumber)).toEqual([1, 2]);
    expect(s.revisions[1].modCount).toBe(1746);
  });

  it("reports no rating as unknown, not as 0%", () => {
    const s = toCollectionStats({
      slug: "x",
      collection: { ...collection, overallRating: "0", overallRatingCount: 0 },
      now: 0,
    });
    expect(s.ratingPercent).toBeUndefined();
    expect(s.ratingCount).toBe(0);
  });

  it("reports downloads as unknown when the listing did not carry this collection", () => {
    // Vortex's per-collection query does not include downloads at all; only
    // the game-wide listing does. Absent must not become 0.
    const s = toCollectionStats({ slug: "ecb76c", collection, now: 0 });
    expect(s.totalDownloads).toBeUndefined();
  });

  it("survives an answer with nothing in it", () => {
    const s = toCollectionStats({ slug: "ecb76c", collection: {}, now: 0 });
    expect(s.slug).toBe("ecb76c");
    expect(s.endorsements).toBeUndefined();
    expect(s.latestRevision).toBeUndefined();
    expect(s.revisions).toEqual([]);
  });
});

describe("asking Vortex", () => {
  beforeEach(() => __clearCollectionStatsCache());

  const api = (answers: Record<string, unknown>) => ({
    emitAndAwait: (event: string): Promise<unknown[]> =>
      Promise.resolve(event in answers ? [answers[event]] : []),
  });

  it("asks the three events and merges them", async () => {
    const asked: string[] = [];
    const s = await readCollectionStats({
      api: {
        emitAndAwait: (event: string): Promise<unknown[]> => {
          asked.push(event);
          if (event === "get-nexus-collection") return Promise.resolve([collection]);
          if (event === "get-my-collections") return Promise.resolve([myRevisions]);
          return Promise.resolve([[{ slug: "ecb76c", totalDownloads: 303 }]]);
        },
      },
      slug: "ecb76c",
      gameDomain: "skyrimspecialedition",
      now: () => 7,
    });
    expect(asked).toContain("get-nexus-collection");
    expect(s?.totalDownloads).toBe(303);
    expect(s?.revisions).toHaveLength(2);
  });

  it("gives up quietly when Vortex cannot answer at all", async () => {
    expect(await readCollectionStats({ api: api({}), slug: "ecb76c" })).toBeUndefined();
    expect(await readCollectionStats({ api: {}, slug: "ecb76c" })).toBeUndefined();
  });

  it("never rejects when the event throws", async () => {
    const s = await readCollectionStats({
      api: {
        emitAndAwait: (): Promise<unknown[]> => Promise.reject(new Error("offline")),
      },
      slug: "ecb76c",
    });
    expect(s).toBeUndefined();
  });

  it("keeps the previous answer when a refresh fails, rather than blanking the panel", async () => {
    let answer: unknown = collection;
    const flaky = {
      emitAndAwait: (event: string): Promise<unknown[]> =>
        event === "get-nexus-collection" && answer !== undefined ? Promise.resolve([answer]) : Promise.resolve([]),
    };
    const first = await collectionStats({ api: flaky, slug: "ecb76c" });
    expect(first?.latestRevision).toBe(5);
    answer = undefined; // Nexus stops answering.
    const second = await collectionStats({ api: flaky, slug: "ecb76c", refresh: true });
    expect(second?.latestRevision).toBe(5);
    expect(second?.fetchedAt).toBe(first?.fetchedAt);
  });

  it("serves the cache until a refresh is asked for", async () => {
    let calls = 0;
    const counting = {
      emitAndAwait: (event: string): Promise<unknown[]> => {
        if (event === "get-nexus-collection") calls += 1;
        return Promise.resolve([collection]);
      },
    };
    await collectionStats({ api: counting, slug: "ecb76c" });
    await collectionStats({ api: counting, slug: "ecb76c" });
    expect(calls).toBe(1);
    await collectionStats({ api: counting, slug: "ecb76c", refresh: true });
    expect(calls).toBe(2);
  });
});
