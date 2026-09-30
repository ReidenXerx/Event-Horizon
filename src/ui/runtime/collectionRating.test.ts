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
  TEMP_ENTRY_PREFIX,
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

  /**
   * A Vortex whose store applies addMod / removeMod / attribute writes, and
   * whose endorse handler answers like the real one: "pending" at once, then
   * Nexus's status (or "Undecided" on its error path).
   */
  const liveVortex = (opts: { activeGame?: string; answer?: string; mods?: Record<string, Record<string, any>> }) => {
    const state: any = {
      settings: { profiles: { activeProfileId: "p1" } },
      persistent: {
        profiles: { p1: { gameId: opts.activeGame ?? "skyrimse" } },
        mods: opts.mods ?? { skyrimse: {} },
      },
    };
    const sent: unknown[][] = [];
    const log: string[] = [];
    const api = {
      getState: () => state,
      store: {
        dispatch: (a: { type: string; payload: any }) => {
          const { gameId } = a.payload;
          state.persistent.mods[gameId] ??= {};
          if (a.type === "STUB_ADD_MOD") {
            state.persistent.mods[gameId][a.payload.mod.id] = a.payload.mod;
            log.push(`add ${a.payload.mod.id}`);
          }
          if (a.type === "STUB_REMOVE_MOD") {
            delete state.persistent.mods[gameId][a.payload.modId];
            log.push(`remove ${a.payload.modId}`);
          }
        },
      },
      events: {
        emit: (event: string, gameId: string, modId: string, status: string) => {
          if (event !== "endorse-mod") return;
          sent.push([event, gameId, modId, status]);
          const mod = state.persistent.mods[gameId][modId];
          mod.attributes.endorsed = "pending";
          setTimeout(() => {
            mod.attributes.endorsed = opts.answer ?? "Endorsed";
          }, 20);
        },
      },
    } as unknown as types.IExtensionApi;
    return { api, state, sent, log };
  };

  it("uses the collection's own entry when Vortex has one, handing it 'Undecided' because the handler TOGGLES", async () => {
    /**
     * The scar `core/curator/endorseOutcome.ts` already records for mods:
     * the handler maps undecided/abstained -> endorse and endorsed ->
     * abstain. Sending "Endorsed", the state we want, makes it ABSTAIN.
     */
    const v = liveVortex({ mods: { skyrimse: { "the-collection": { attributes: { collectionId: "510658" } } } } });
    const out = await endorseCollection(v.api, { gameId: "skyrimse", collectionId: 510658, name: "Meridia" });
    expect(out).toEqual({ kind: "endorsed" });
    expect(v.sent).toEqual([["endorse-mod", "skyrimse", "the-collection", "Undecided"]]);
    expect(v.log).toEqual([]);
  });

  it("endorses through a placeholder entry when EH's install left none, then removes it", async () => {
    const v = liveVortex({});
    const out = await endorseCollection(v.api, { gameId: "skyrimse", collectionId: 510658, name: "Meridia" });
    expect(out).toEqual({ kind: "endorsed" });
    expect(v.sent).toEqual([["endorse-mod", "skyrimse", `${TEMP_ENTRY_PREFIX}510658`, "Undecided"]]);
    expect(v.log).toEqual([`add ${TEMP_ENTRY_PREFIX}510658`, `remove ${TEMP_ENTRY_PREFIX}510658`]);
    expect(v.state.persistent.mods.skyrimse).toEqual({});
  });

  it("the placeholder carries what Vortex's collection branch reads: collectionId and downloadGame", async () => {
    const v = liveVortex({});
    let seen: any;
    const emit = v.api.events.emit;
    (v.api.events as any).emit = (...a: any[]) => {
      seen = v.state.persistent.mods.skyrimse[a[2]].attributes;
      return (emit as any)(...a);
    };
    await endorseCollection(v.api, { gameId: "skyrimse", collectionId: 510658, name: "Meridia" });
    expect(seen).toMatchObject({ collectionId: 510658, downloadGame: "skyrimse" });
    // No Nexus mod id: Vortex's handler would take the MOD branch instead.
    expect(seen.modId).toBeUndefined();
  });

  it("reports Nexus refusing, and still removes the placeholder", async () => {
    const v = liveVortex({ answer: "Undecided" });
    const out = await endorseCollection(v.api, { gameId: "skyrimse", collectionId: 510658, name: "Meridia" });
    expect(out.kind).toBe("failed");
    expect(v.state.persistent.mods.skyrimse).toEqual({});
  });

  it("does nothing for a game Vortex is not managing, since Vortex would not either", async () => {
    const v = liveVortex({ activeGame: "fallout4" });
    const out = await endorseCollection(v.api, { gameId: "skyrimse", collectionId: 510658, name: "Meridia" });
    expect(out).toEqual({ kind: "wrong-game", activeGameId: "fallout4" });
    expect(v.sent).toEqual([]);
    expect(v.log).toEqual([]);
  });

  it("clears a placeholder a crash left behind before adding a new one", async () => {
    const v = liveVortex({ mods: { skyrimse: { [`${TEMP_ENTRY_PREFIX}1`]: { attributes: {} } } } });
    await endorseCollection(v.api, { gameId: "skyrimse", collectionId: 510658, name: "Meridia" });
    expect(v.log[0]).toBe(`remove ${TEMP_ENTRY_PREFIX}1`);
    expect(Object.keys(v.state.persistent.mods.skyrimse)).toEqual([]);
  });

  it("builds the page URL Nexus actually uses", () => {
    expect(collectionPageUrl("fallout4", "dmt85e")).toBe(
      "https://www.nexusmods.com/games/fallout4/collections/dmt85e",
    );
  });
});
