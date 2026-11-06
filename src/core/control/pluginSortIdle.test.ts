import { describe, expect, it } from "vitest";
import { countOutOfOrder, pluginsSorting, waitForPluginSortIdle } from "./pluginSortIdle";
import { mastersAfterCount, reorderBreaksMasters } from "../doctor/pluginWipeGuard";

const sortingState = (on: boolean, loadOrder: unknown): unknown => ({
  session: { base: { activity: { plugins: on ? ["sorting"] : [] } } },
  loadOrder,
});

describe("waitForPluginSortIdle", () => {
  it("waits out a sort that is running, and its result landing after it ends", async () => {
    // Fallout-collection, 2026-11-06: a Skyrim sort ran 6 s into a switch to FO4.
    const lo1 = {};
    const lo2 = {};
    const frames = [sortingState(true, lo1), sortingState(true, lo1), sortingState(false, lo2), sortingState(false, lo2)];
    let i = 0;
    const r = await waitForPluginSortIdle(() => frames[Math.min(i, frames.length - 1)], {
      quietMs: 2,
      capMs: 100,
      stepMs: 1,
      sleep: async () => {
        i += 1;
      },
    });
    expect(r.sawSort).toBe(true);
    expect(r.timedOut).toBe(false);
    expect(i).toBeGreaterThanOrEqual(4);
  });

  it("gives up at the cap when a sort never ends", async () => {
    const s = sortingState(true, {});
    const r = await waitForPluginSortIdle(() => s, { quietMs: 2, capMs: 10, stepMs: 1, sleep: async () => undefined });
    expect(r.timedOut).toBe(true);
  });

  it("reads Vortex's sorting activity", () => {
    expect(pluginsSorting(sortingState(true, {}))).toBe(true);
    expect(pluginsSorting(sortingState(false, {}))).toBe(false);
    expect(pluginsSorting({})).toBe(false);
  });
});

describe("countOutOfOrder", () => {
  it("counts plugins of the expected order that the actual order moved", () => {
    expect(countOutOfOrder(["A.esm", "B.esp", "C.esp"], ["a.esm", "b.esp", "c.esp"])).toBe(0);
    expect(countOutOfOrder(["A.esm", "B.esp", "C.esp"], ["C.esp", "A.esm", "B.esp"])).toBe(1);
  });
});

describe("lastGood refuses a master-breaking reorder", () => {
  const masters = (n: string): string[] | undefined => ({ "patch.esp": ["Base.esm"], "addon.esp": ["Base.esm"] })[n.toLowerCase()];
  const good = [
    { name: "Base.esm", enabled: true, loadOrder: 0 },
    { name: "Patch.esp", enabled: true, loadOrder: 1 },
    { name: "Addon.esp", enabled: true, loadOrder: 2 },
  ];

  it("counts masters loading after their dependants", () => {
    expect(mastersAfterCount(["Base.esm", "Patch.esp"], masters)).toBe(0);
    expect(mastersAfterCount(["Patch.esp", "Addon.esp", "Base.esm"], masters)).toBe(2);
  });

  it("keeps an ordinary reorder, refuses one that puts many masters last", () => {
    expect(reorderBreaksMasters(good, [good[0]!, { ...good[2]!, loadOrder: 1 }, { ...good[1]!, loadOrder: 2 }], masters)).toBeUndefined();
    const many = (n: number): Array<{ name: string; enabled: boolean; loadOrder: number }> => [
      ...Array.from({ length: n }, (_, i) => ({ name: `P${i}.esp`, enabled: true, loadOrder: i })),
      { name: "Base.esm", enabled: true, loadOrder: n },
    ];
    const m = (name: string): string[] | undefined => (name.startsWith("P") ? ["Base.esm"] : undefined);
    const prev = [{ name: "Base.esm", enabled: true, loadOrder: -1 }, ...many(10).slice(0, 10)];
    expect(reorderBreaksMasters(prev, many(10), m)).toEqual({ before: 0, after: 10 });
  });
});
