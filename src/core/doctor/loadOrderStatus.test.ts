import { describe, expect, it } from "vitest";

import {
  activeContextFromState,
  assessLoadOrder,
  assessReceiptOrder,
  canReapply,
  currentOrderFromState,
  describeLoadOrder,
  driftSignature,
  nativeNamesFromState,
  orderOwner,
  previewRepin,
  type OrderReceipt,
} from "./loadOrderStatus";

const on = (...names: string[]): { name: string; enabled: boolean }[] => names.map((name) => ({ name, enabled: true }));

describe("assessLoadOrder", () => {
  const baseline = on("Skyrim.esm", "A.esp", "B.esp", "C.esp");
  const natives = new Set(["skyrim.esm"]);

  it("matches when the collection's plugins keep their order, whatever the user added between", () => {
    const status = assessLoadOrder({ baseline, current: on("A.esp", "Mine.esp", "B.esp", "Other.esp", "C.esp"), natives });
    expect(status).toEqual({ kind: "matches", owned: 3, extra: 2 });
    expect(describeLoadOrder(status).headline).toContain("3 collection plugin");
    expect(driftSignature(status)).toBe("");
  });

  it("drifts when two collection plugins swap, and names the pair", () => {
    const status = assessLoadOrder({ baseline, current: on("B.esp", "A.esp", "C.esp"), natives });
    expect(status.kind).toBe("drifted");
    if (status.kind !== "drifted") return;
    expect(status.drift.misordered).toEqual([{ name: "B.esp", expectedAfter: "A.esp" }]);
    expect(describeLoadOrder(status).tone).toBe("danger");
    expect(describeLoadOrder(status).headline).toContain("1 of 3");
    // The fingerprint ignores order and case, so the same drift is one event.
    expect(driftSignature(status)).toBe(driftSignature(assessLoadOrder({ baseline, current: on("b.esp", "a.esp", "C.esp"), natives })));
  });

  it("ignores natives on both sides — Vortex never writes them to loadOrder", () => {
    const status = assessLoadOrder({ baseline, current: on("A.esp", "B.esp", "C.esp", "Skyrim.esm"), natives });
    expect(status.kind).toBe("matches");
  });

  it("says why it cannot judge", () => {
    expect(assessLoadOrder({ baseline: undefined, current: on("A.esp") }).kind).toBe("no-baseline");
    expect(assessLoadOrder({ baseline: [], current: on("A.esp") }).kind).toBe("no-baseline");
    expect(assessLoadOrder({ baseline, current: undefined }).kind).toBe("not-applicable");
  });
});

describe("currentOrderFromState", () => {
  const state = {
    session: {
      plugins: {
        pluginList: {
          "skyrim.esm": { isNative: true },
          "b.esp": { modId: "b" },
          "a.esp": { modId: "a" },
          "off.esp": { modId: "o" },
        },
      },
    },
    loadOrder: {
      "a.esp": { name: "A.esp", enabled: true, loadOrder: 0 },
      "b.esp": { name: "B.esp", enabled: true, loadOrder: 1 },
    },
  };

  it("reads the non-native order Vortex holds, unplaced plugins last and off", () => {
    expect(currentOrderFromState(state)).toEqual([
      { name: "A.esp", enabled: true },
      { name: "B.esp", enabled: true },
      { name: "off.esp", enabled: false },
    ]);
    expect([...nativeNamesFromState(state)]).toEqual(["skyrim.esm"]);
    expect(currentOrderFromState({})).toBeUndefined();
  });
});

describe("previewRepin", () => {
  it("lists exactly the plugins the re-apply would move", () => {
    const baseline = on("A.esp", "B.esp", "C.esp");
    const current = on("Mine.esp", "C.esp", "A.esp", "B.esp");
    const preview = previewRepin(baseline, current);
    // Mine keeps its slot; the collection's three slots refill as A, B, C.
    expect(preview.total).toBe(4);
    expect(preview.moves).toEqual([
      { name: "A.esp", from: 2, to: 1 },
      { name: "B.esp", from: 3, to: 2 },
      { name: "C.esp", from: 1, to: 3 },
    ]);
    expect(previewRepin(baseline, on("A.esp", "B.esp", "C.esp")).moves).toEqual([]);
  });
});

/**
 * Vortex holds ONE order — the active game's active profile — and its
 * `set-plugin-list` handler takes no game and no profile. A verdict about any
 * other receipt's order is noise with a Re-apply button that writes into the
 * wrong order.
 */
describe("whose order it is", () => {
  const receipt = (over: Partial<OrderReceipt> = {}): OrderReceipt => ({
    packageId: "pkg-ivy",
    packageName: "Ivy 2",
    packageVersion: "1.0.11",
    gameId: "skyrimse",
    vortexProfileId: "prof-ivy",
    vortexProfileName: "Ivy 2",
    installedAt: "2026-09-01T10:00:00.000Z",
    rulesApplication: { baselinePluginOrder: on("A.esp", "B.esp") },
    ...over,
  });

  /** A real-shaped Vortex state: active profile in settings, plugins in session + loadOrder. */
  const stateOn = (activeProfileId: string, order: string[]): unknown => ({
    settings: { profiles: { activeProfileId } },
    persistent: {
      profiles: {
        "prof-ivy": { gameId: "skyrimse", name: "Ivy 2" },
        default: { gameId: "skyrimse", name: "Default" },
        "prof-fo4": { gameId: "fallout4", name: "Fallout 4" },
      },
    },
    session: { plugins: { pluginList: Object.fromEntries(order.map((n) => [n.toLowerCase(), {}])) } },
    loadOrder: Object.fromEntries(order.map((n, i) => [n.toLowerCase(), { name: n, enabled: true, loadOrder: i }])),
  });

  it("reads the active game and profile from settings, not the profile object", () => {
    expect(activeContextFromState(stateOn("default", []))).toEqual({ gameId: "skyrimse", profileId: "default", profileName: "Default" });
    expect(activeContextFromState({}).gameId).toBeUndefined();
  });

  it("does not judge a receipt for another game against the active game's order", () => {
    // The same two names, swapped, in FALLOUT 4's order: compared, it is drift.
    const r = receipt();
    const status = assessReceiptOrder({ receipt: r, receipts: [r], state: stateOn("prof-fo4", ["B.esp", "A.esp"]) });
    expect(status).toEqual({ kind: "not-active-game", gameId: "skyrimse", activeGameId: "fallout4" });
    expect(canReapply(status)).toBe(false);
  });

  it("does not judge a receipt installed into another profile", () => {
    const r = receipt();
    const status = assessReceiptOrder({ receipt: r, receipts: [r], state: stateOn("default", ["B.esp", "A.esp"]) });
    expect(status).toEqual({ kind: "other-profile", profileName: "Ivy 2" });
    expect(canReapply(status)).toBe(false);
    expect(describeLoadOrder(status).headline).toMatch(/Installed in profile "Ivy 2"/);
  });

  it("judges the receipt in its own profile", () => {
    const r = receipt();
    const status = assessReceiptOrder({ receipt: r, receipts: [r], state: stateOn("prof-ivy", ["B.esp", "A.esp"]) });
    expect(status.kind).toBe("drifted");
    expect(canReapply(status)).toBe(true);
  });

  it("gives the order to the NEWEST install into the profile; the older one is superseded", () => {
    const older = receipt();
    const newer = receipt({
      packageId: "pkg-other",
      packageName: "Other",
      packageVersion: "2.0.0",
      installedAt: "2026-09-05T10:00:00.000Z",
      rulesApplication: { baselinePluginOrder: on("B.esp", "A.esp") },
    });
    const receipts = [older, newer];
    const state = stateOn("prof-ivy", ["B.esp", "A.esp"]);
    const olderStatus = assessReceiptOrder({ receipt: older, receipts, state });
    expect(olderStatus).toEqual({ kind: "superseded", by: "Other v2.0.0" });
    expect(canReapply(olderStatus)).toBe(false);
    expect(driftSignature(olderStatus)).toBe("");
    expect(assessReceiptOrder({ receipt: newer, receipts, state }).kind).toBe("matches");
    // Receipts arrive in readdir order; the owner does not depend on it.
    expect(orderOwner([newer, older], activeContextFromState(state))).toBe(newer);
    expect(orderOwner([older, newer], activeContextFromState(state))).toBe(newer);
  });

  it("does not hand the order to a newer run that never applied one", () => {
    const older = receipt();
    const stopped = receipt({ packageId: "pkg-stopped", installedAt: "2026-09-05T10:00:00.000Z", finishingSkipped: ["plugin order"] });
    const state = stateOn("prof-ivy", ["A.esp", "B.esp"]);
    expect(orderOwner([older, stopped], activeContextFromState(state))).toBe(older);
    expect(assessReceiptOrder({ receipt: stopped, receipts: [older, stopped], state }).kind).toBe("not-applied");
    expect(assessReceiptOrder({ receipt: older, receipts: [older, stopped], state }).kind).toBe("matches");
  });
});

/**
 * Settled with the user: a curator plugin switched off (or never installed),
 * with the relative order intact, is its own status — no drift notification,
 * no Re-apply offer, no wording blaming the sort.
 */
describe("a curator plugin switched off is not drift", () => {
  const baseline = on("A.esp", "B.esp", "C.esp");

  it("is its own status: nothing to re-apply, no notification signature, no blame on the sort", () => {
    const status = assessLoadOrder({
      baseline,
      current: [
        { name: "A.esp", enabled: true },
        { name: "B.esp", enabled: false },
        { name: "C.esp", enabled: true },
      ],
    });
    expect(status).toEqual({ kind: "plugins-off", owned: 2, extra: 0, missing: ["B.esp"] });
    expect(canReapply(status)).toBe(false);
    expect(driftSignature(status)).toBe("");
    const said = describeLoadOrder(status);
    expect(said.headline).toMatch(/^1 curator plugin off/);
    expect([said.headline, ...said.detail].join(" ")).not.toMatch(/sort/i);
  });

  it("does not re-announce a real drift because a plugin was also switched off", () => {
    const moved = assessLoadOrder({ baseline, current: on("B.esp", "A.esp", "C.esp") });
    const movedAndOff = assessLoadOrder({ baseline, current: [...on("B.esp", "A.esp"), { name: "C.esp", enabled: false }] });
    expect(moved.kind).toBe("drifted");
    expect(movedAndOff.kind).toBe("drifted");
    expect(driftSignature(movedAndOff)).toBe(driftSignature(moved));
  });
});
