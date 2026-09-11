import { describe, expect, it } from "vitest";

import {
  assessLoadOrder,
  currentOrderFromState,
  describeLoadOrder,
  driftSignature,
  nativeNamesFromState,
  previewRepin,
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
