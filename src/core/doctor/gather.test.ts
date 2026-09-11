/**
 * The reader half of the doctor.
 *
 * These are shape tests, and they exist because Vortex's state shape is not
 * ours: a reader that throws takes the whole health check down over one
 * unfamiliar field, and a reader that returns a confident default is worse —
 * `0` rules present renders as "all your rules are gone", which sends someone
 * re-applying rules they never lost.
 */
import { describe, expect, it, vi } from "vitest";

/**
 * Real userlist entries, because the two counts this feeds cannot be told
 * apart by an empty one.
 *
 * This was `plugins: [{}, {}, {}]` — three entries carrying no group and no
 * rule. Every counting rule produces the same answer against it, so the
 * fixture agreed with a version of `gather` that counted ENTRIES and would
 * have agreed just as readily with any other (GP-4). The bug it could not
 * see: a collection that assigns groups and sets no ordering rules had its
 * own 501 entries reported as the user's additions.
 *
 * The three numbers are deliberately all DIFFERENT: 4 entries, 5 ordering
 * rules, 2 group assignments. A first attempt at this fixture had 4 entries
 * and 4 rules, which meant the old entry-counting code would have passed the
 * new test — the same trap one level up, and it took a mutation to notice.
 */
vi.mock("../userlist", () => ({
  captureUserlist: () => ({
    plugins: [
      { name: "a.esp", group: "Late Loaders" },
      { name: "b.esp", after: ["a.esp", "z.esp", "y.esp"] },
      { name: "c.esp", group: "Early", after: ["d.esp"], req: ["e.esp"] },
      { name: "d.esp" },
    ],
    groups: [{ name: "Early" }, { name: "Late Loaders" }],
  }),
}));
vi.mock("../installer/checkPluginOrder", () => ({
  readUserPluginsTxt: async () => [{ name: "a.esp" }, { name: "b.esp" }],
}));
vi.mock("../getModsListForProfile", () => ({
  getActiveProfileId: () => "prof-active",
}));

import { gatherObservations } from "./gather";

const api = (state: unknown): never =>
  ({ getState: () => state }) as never;

const fullState = {
  persistent: {
    profiles: {
      "prof-1": { gameId: "fallout4", modState: { m1: { enabled: true }, m2: { enabled: false } } },
      "prof-2": { gameId: "fallout4", modState: {} },
      "prof-sky": { gameId: "skyrimse", modState: {} },
    },
    mods: {
      fallout4: {
        m1: { rules: [{}, {}] },
        m2: { rules: [{}] },
        m3: {},
      },
    },
  },
};

describe("gatherObservations", () => {
  it("reads only the profiles belonging to this game", async () => {
    const obs = await gatherObservations({
      api: api(fullState),
      gameId: "fallout4",
      receiptProfileId: "prof-1",
    });
    expect([...obs.existingProfileIds].sort()).toEqual(["prof-1", "prof-2"]);
  });

  it("reads enabled mods from the RECEIPT's profile, not the active one", async () => {
    // Conflating them would report every mod as disabled the moment the user
    // switched to another profile — a false alarm on a healthy collection.
    const obs = await gatherObservations({
      api: api(fullState),
      gameId: "fallout4",
      receiptProfileId: "prof-1",
    });
    expect(obs.enabledModIds).toEqual(["m1"]);
    expect(obs.activeProfileId).toBe("prof-active");
  });

  it("counts mod rules across every mod, and tolerates mods with none", async () => {
    const obs = await gatherObservations({
      api: api(fullState),
      gameId: "fallout4",
      receiptProfileId: "prof-1",
    });
    expect(obs.currentModRuleCount).toBe(3);
  });

  it("counts ORDERING RULES, the way the install counts them", async () => {
    /**
     * `appliedRuleCount` is incremented once per rule DISPATCHED — one per
     * `after`, `req` or `inc` reference — not once per entry. This used to
     * count entries and claimed in a comment that the two matched.
     */
    const obs = await gatherObservations({
      api: api(fullState),
      gameId: "fallout4",
      receiptProfileId: "prof-1",
    });
    expect(obs.currentUserlistRuleCount).toBe(5);
  });

  it("counts GROUP ASSIGNMENTS separately, and does not confuse the two", async () => {
    /**
     * The number that matters most here is that it is NOT 4 and NOT the
     * entry count. A collection can set hundreds of group assignments and no
     * ordering rules at all — the real one this was found on had 501 and 0 —
     * and one number cannot carry both without calling a healthy install
     * drifted.
     */
    const obs = await gatherObservations({
      api: api(fullState),
      gameId: "fallout4",
      receiptProfileId: "prof-1",
    });
    expect(obs.currentUserlistGroupAssignmentCount).toBe(2);
  });

  it("leaves the deep scan undefined unless it was actually run", async () => {
    const obs = await gatherObservations({
      api: api(fullState),
      gameId: "fallout4",
      receiptProfileId: "prof-1",
    });
    // undefined, not [] — "did not look" is a much weaker claim than
    // "looked and found nothing", and only one of them may render as healthy.
    expect(obs.driftedCompareKeys).toBeUndefined();

    const scanned = await gatherObservations({
      api: api(fullState),
      gameId: "fallout4",
      receiptProfileId: "prof-1",
      driftedCompareKeys: [],
    });
    expect(scanned.driftedCompareKeys).toEqual([]);
  });

  it("survives a state shape it does not recognise", async () => {
    // The property that stops one unfamiliar field taking the feature down.
    const obs = await gatherObservations({
      api: api({ persistent: null }),
      gameId: "fallout4",
      receiptProfileId: "prof-1",
    });
    expect(obs.existingProfileIds).toEqual([]);
    expect(obs.installedModIds).toEqual([]);
    expect(obs.enabledModIds).toEqual([]);
    // undefined rather than 0: "could not read" is not "they are all gone".
    expect(obs.currentModRuleCount).toBeUndefined();
  });

  it("survives an empty state object entirely", async () => {
    const obs = await gatherObservations({
      api: api({}),
      gameId: "fallout4",
      receiptProfileId: "nope",
    });
    expect(obs.currentModRuleCount).toBeUndefined();
    expect(obs.existingProfileIds).toEqual([]);
  });

  it("records whether the receipt's load order may be judged, and the natives to drop", async () => {
    // Vortex's loadOrder is the ACTIVE profile's. A collection installed into
    // prof-1, looked at from Default, must not be compared against it.
    const state = {
      settings: { profiles: { activeProfileId: "default" } },
      persistent: {
        profiles: {
          "prof-1": { gameId: "fallout4", name: "Ivy 2" },
          default: { gameId: "fallout4", name: "Default" },
        },
      },
      session: { plugins: { pluginList: { "fallout4.esm": { isNative: true }, "a.esp": {} } } },
      loadOrder: { "a.esp": { name: "a.esp", enabled: true, loadOrder: 0 } },
    };
    const orderReceipt = {
      packageId: "pkg",
      packageName: "Ivy 2",
      gameId: "fallout4",
      vortexProfileId: "prof-1",
      vortexProfileName: "Ivy 2",
      installedAt: "2026-09-01T00:00:00.000Z",
      rulesApplication: { baselinePluginOrder: [{ name: "a.esp", enabled: true }] },
    };
    const obs = await gatherObservations({
      api: api(state),
      gameId: "fallout4",
      receiptProfileId: "prof-1",
      orderReceipt,
      receipts: [orderReceipt],
    });
    expect(obs.loadOrderStanding).toEqual({ kind: "other-profile", profileName: "Ivy 2" });
    expect(obs.nativePluginNames).toEqual(["fallout4.esm"]);
  });
});
