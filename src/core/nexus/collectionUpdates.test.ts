/**
 * Which installed collections have a newer revision on Nexus.
 *
 * `emitAndAwait` is faked the way Vortex 2.6.3 implements it: it resolves to
 * the array of non-null handler results, and a failing handler becomes an
 * empty array rather than a rejection.
 */
import { describe, expect, it, vi } from "vitest";

import { findCollectionUpdates, latestPublishedRevision } from "./collectionUpdates";
import type { InstallReceipt } from "../../types/installLedger";

const LOGGED_IN = { persistent: { nexus: { userInfo: { name: "player" } } } };

function receipt(packageId: string, nexusCollection?: InstallReceipt["nexusCollection"]): InstallReceipt {
  return {
    schemaVersion: 1,
    packageId,
    packageVersion: "1.0.29",
    packageName: `Collection ${packageId}`,
    gameId: "fallout4",
    installedAt: "2026-09-16T00:00:00.000Z",
    vortexProfileId: "p",
    vortexProfileName: "P",
    installTargetMode: "fresh-profile",
    mods: [],
    ...(nexusCollection !== undefined ? { nexusCollection } : {}),
  } as InstallReceipt;
}

function apiWith(latestBySlug: Record<string, number | undefined>, state: unknown = LOGGED_IN) {
  const asked: string[] = [];
  const emitAndAwait = vi.fn(async (event: string, slug: unknown) => {
    if (event !== "get-nexus-collection") return [];
    asked.push(slug as string);
    const latest = latestBySlug[slug as string];
    return latest === undefined ? [] : [{ slug, latestPublishedRevision: { id: 1, revisionNumber: latest } }];
  });
  return { api: { getState: () => state, emitAndAwait } as never, asked };
}

const rev = (slug: string, revisionNumber: number) => ({ slug, revisionNumber, gameDomain: "fallout4" });

describe("finding collection updates", () => {
  it("offers the newer published revision of a collection installed from its page", async () => {
    const { api } = apiWith({ tumkz9: 13 });
    const { updates } = await findCollectionUpdates(api, [receipt("a", rev("tumkz9", 12))]);
    expect(updates).toEqual([
      {
        packageId: "a",
        packageName: "Collection a",
        gameId: "fallout4",
        installed: rev("tumkz9", 12),
        latestRevision: 13,
      },
    ]);
  });

  it("offers nothing when the installed revision is the latest, or newer than it", async () => {
    // Newer happens when the curator retracts the revision the player has.
    const { api } = apiWith({ tumkz9: 12, kqrokq: 3 });
    const { updates } = await findCollectionUpdates(api, [receipt("a", rev("tumkz9", 12)), receipt("b", rev("kqrokq", 4))]);
    expect(updates).toEqual([]);
  });

  it("never asks Nexus about a file install, which has no revision to compare", async () => {
    const { api, asked } = apiWith({ tumkz9: 13 });
    expect((await findCollectionUpdates(api, [receipt("a")])).updates).toEqual([]);
    expect(asked).toEqual([]);
  });

  it("asks nothing while Vortex is logged out, so a startup check cannot raise Vortex's error notifications", async () => {
    const { api, asked } = apiWith({ tumkz9: 13 }, { persistent: { nexus: {} } });
    expect((await findCollectionUpdates(api, [receipt("a", rev("tumkz9", 12))])).updates).toEqual([]);
    expect(asked).toEqual([]);
  });

  it("asks once per collection, however many receipts point at it", async () => {
    const { api, asked } = apiWith({ tumkz9: 13 });
    await findCollectionUpdates(api, [receipt("a", rev("tumkz9", 12)), receipt("b", rev("tumkz9", 11))]);
    expect(asked).toEqual(["tumkz9"]);
  });

  it("offers nothing when Nexus gives no answer", async () => {
    const { api } = apiWith({});
    expect((await findCollectionUpdates(api, [receipt("a", rev("tumkz9", 12))])).updates).toEqual([]);
  });

  /**
   * An empty update list is two different answers, and the caller has to be
   * able to tell them apart: "Nexus says you are current" and "Nexus could
   * not be asked" both produce no updates, and treating the second as the
   * first is how a re-check that failed silently removed an Update button a
   * successful check had put there.
   */
  it("says nothing was ANSWERED when Nexus gave no answer", async () => {
    const { api } = apiWith({});
    const check = await findCollectionUpdates(api, [receipt("a", rev("tumkz9", 12))]);
    expect([...check.answeredSlugs]).toEqual([]);
  });

  it("says the slug WAS answered when Nexus says it is current", async () => {
    const { api } = apiWith({ tumkz9: 12 });
    const check = await findCollectionUpdates(api, [receipt("a", rev("tumkz9", 12))]);
    expect(check.updates).toEqual([]);
    expect([...check.answeredSlugs]).toEqual(["tumkz9"]);
  });

  it("answers for nothing while logged out — asking is what did not happen", async () => {
    const { api } = apiWith({ tumkz9: 13 }, { persistent: { nexus: {} } });
    const check = await findCollectionUpdates(api, [receipt("a", rev("tumkz9", 12))]);
    expect([...check.answeredSlugs]).toEqual([]);
  });

  it("reads the latest PUBLISHED revision, not a number from anywhere else", async () => {
    const api = {
      getState: () => LOGGED_IN,
      emitAndAwait: async () => [{ revisionNumber: 99, latestPublishedRevision: { revisionNumber: 13 } }],
    } as never;
    expect(await latestPublishedRevision(api, "tumkz9")).toBe(13);
  });
});
