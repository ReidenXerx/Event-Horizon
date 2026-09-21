/**
 * The two ways sending a public vote goes wrong quietly.
 *
 * Both are shapes this project has already been bitten by: an id that looks
 * like the right number and is not, and an endorsement handler that TOGGLES
 * so being handed the state you want makes it do the opposite.
 */
import { describe, expect, it, vi } from "vitest";

import type { types } from "@nexusmods/vortex-api";

import {
  collectionPageUrl,
  endorseCollection,
  findCollectionModId,
  rateRevision,
  resolveRevisionId,
} from "./collectionRating";

/** A Vortex api with only what these functions touch. */
const fakeApi = (over: {
  emitAndAwait?: (event: string, ...args: unknown[]) => Promise<unknown[]>;
  mods?: Record<string, Record<string, unknown>>;
  emit?: (...args: unknown[]) => void;
}): types.IExtensionApi =>
  ({
    emitAndAwait: over.emitAndAwait,
    events: { emit: over.emit ?? ((): void => undefined) },
    getState: () => ({ persistent: { mods: over.mods ?? {} } }),
  }) as unknown as types.IExtensionApi;

describe("the revision id is exchanged, never assumed", () => {
  it("asks Vortex for the id and votes with THAT", async () => {
    /**
     * `revisionNumber` is the human "Revision 4" a receipt records;
     * `revisionId` is Nexus's internal key. Sending the number would rate
     * some other collection's revision — publicly, on a stranger's work.
     */
    const calls: unknown[][] = [];
    const api = fakeApi({
      emitAndAwait: async (event, ...args) => {
        calls.push([event, ...args]);
        if (event === "get-nexus-collection-revision") return [{ id: 887766 }];
        return [{ success: true, averageRating: { average: 0.93 } }];
      },
    });
    const out = await rateRevision(api, { slug: "dmt85e", revisionNumber: 4, answer: "worked" });
    expect(out).toEqual({ kind: "sent", average: 0.93 });
    expect(calls[0]).toEqual(["get-nexus-collection-revision", "dmt85e", 4]);
    // The id, not the number, and Vortex's own wording for the vote.
    expect(calls[1]).toEqual(["rate-nexus-collection-revision", 887766, "positive"]);
  });

  it("maps 'it did not work' to Vortex's negative", async () => {
    const calls: unknown[][] = [];
    const api = fakeApi({
      emitAndAwait: async (event, ...args) => {
        calls.push([event, ...args]);
        if (event === "get-nexus-collection-revision") return [{ id: 1 }];
        return [{ success: true }];
      },
    });
    await rateRevision(api, { slug: "s", revisionNumber: 2, answer: "did-not-work" });
    expect(calls[1]?.[2]).toBe("negative");
  });

  it("sends NOTHING when the id cannot be resolved", async () => {
    // Offline, signed out, or the revision is gone. All of them mean the same
    // thing: do not cast a vote keyed on a number nobody confirmed.
    const rate = vi.fn();
    const api = fakeApi({
      emitAndAwait: async (event) => {
        if (event === "get-nexus-collection-revision") return [];
        rate();
        return [{ success: true }];
      },
    });
    const out = await rateRevision(api, { slug: "s", revisionNumber: 4, answer: "worked" });
    expect(out).toEqual({ kind: "no-revision" });
    expect(rate).not.toHaveBeenCalled();
  });

  it("sends nothing when this Vortex has no such event at all", async () => {
    const out = await rateRevision(fakeApi({}), {
      slug: "s",
      revisionNumber: 4,
      answer: "worked",
    });
    expect(out.kind).toBe("failed");
  });

  it("reports a refusal rather than claiming success", async () => {
    const api = fakeApi({
      emitAndAwait: async (event) =>
        event === "get-nexus-collection-revision" ? [{ id: 5 }] : [{ success: false }],
    });
    expect((await rateRevision(api, { slug: "s", revisionNumber: 1, answer: "worked" })).kind).toBe(
      "failed",
    );
  });

  it("survives the lookup throwing", async () => {
    const api = fakeApi({
      emitAndAwait: async () => {
        throw new Error("network");
      },
    });
    expect(await resolveRevisionId(api, "s", 1)).toBeUndefined();
  });
});

describe("endorsing", () => {
  const mods = {
    fallout4: {
      "some-mod": { attributes: {} },
      "the-collection": { attributes: { collectionId: "510658" } },
    },
  };

  it("finds the collection's own mod entry by its id", () => {
    // Vortex stores it as a string on some paths and a number on others.
    expect(findCollectionModId(fakeApi({ mods }), "fallout4", 510658)).toBe("the-collection");
  });

  it("does not confuse it with another collection", () => {
    expect(findCollectionModId(fakeApi({ mods }), "fallout4", 999)).toBeUndefined();
  });

  it("hands Vortex 'Undecided', because its handler TOGGLES", () => {
    /**
     * The scar `core/curator/endorseOutcome.ts` already records for mods:
     * the handler maps undecided/abstained -> endorse and endorsed ->
     * abstain. Sending "Endorsed", the state we want, makes it ABSTAIN.
     */
    const emit = vi.fn();
    const out = endorseCollection(fakeApi({ mods, emit }), {
      gameId: "fallout4",
      collectionId: 510658,
    });
    expect(out).toEqual({ kind: "endorsed" });
    expect(emit).toHaveBeenCalledWith("endorse-mod", "fallout4", "the-collection", "Undecided");
  });

  it("says so rather than pretending when there is no entry to endorse", () => {
    // EH replaces Vortex's collection installer, so the entry Vortex would
    // have made may simply not exist. The page always works instead.
    const emit = vi.fn();
    const out = endorseCollection(fakeApi({ mods: { fallout4: {} }, emit }), {
      gameId: "fallout4",
      collectionId: 510658,
    });
    expect(out).toEqual({ kind: "no-mod-entry" });
    expect(emit).not.toHaveBeenCalled();
  });

  it("builds the page URL Nexus actually uses", () => {
    expect(collectionPageUrl("fallout4", "dmt85e")).toBe(
      "https://www.nexusmods.com/games/fallout4/collections/dmt85e",
    );
  });
});
