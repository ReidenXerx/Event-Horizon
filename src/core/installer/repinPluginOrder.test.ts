/**
 * 686 of 1,600 plugins loaded in a different order than the curator's, on an
 * install that pinned their order and then let LOOT sort on top of it. The
 * pin ran, the sort ran, and the curator's order was still not what loaded.
 *
 * These pin the merge rule: LOOT's slots for the collection's plugins get the
 * curator's sequence back, everything else stays where LOOT put it.
 */
import { describe, expect, it } from "vitest";

import { orderDiffers, repinCuratorOrder } from "./repinPluginOrder";

describe("repinCuratorOrder", () => {
  it("restores the curator's order among the collection's own plugins", () => {
    const curator = ["a.esp", "b.esp", "c.esp"];
    // LOOT reversed them.
    const actual = ["c.esp", "b.esp", "a.esp"];
    expect(repinCuratorOrder(curator, actual)).toEqual([
      "a.esp",
      "b.esp",
      "c.esp",
    ]);
  });

  it("leaves the USER's own plugins exactly where LOOT put them", () => {
    /**
     * The whole reason the sort runs. `mine.esp` is a plugin the curator never
     * had, and LOOT knows where it belongs; the merge must not move it, and
     * must not move it relative to the collection's plugins either — its slot
     * simply is not one of the ones being refilled.
     */
    const curator = ["a.esp", "b.esp"];
    const actual = ["b.esp", "mine.esp", "a.esp"];
    expect(repinCuratorOrder(curator, actual)).toEqual([
      "a.esp",
      "mine.esp",
      "b.esp",
    ]);
  });

  it("does not let a plugin the user LACKS consume a slot", () => {
    // A curator plugin that is not installed here must be skipped, not left to
    // shift every later one — that would reintroduce exactly the drift this
    // function exists to remove.
    const curator = ["a.esp", "gone.esp", "b.esp"];
    const actual = ["b.esp", "a.esp"];
    expect(repinCuratorOrder(curator, actual)).toEqual(["a.esp", "b.esp"]);
  });

  it("matches plugin names case-insensitively", () => {
    // plugins.txt carries whatever case Vortex wrote; the manifest carries the
    // curator's. Bethesda plugin names are case-insensitive and a mismatch
    // here would classify every collection plugin as the user's own.
    const curator = ["Alpha.esp", "Beta.esp"];
    const actual = ["beta.ESP", "ALPHA.esp"];
    // The names written back are the ones the CURATOR recorded, because those
    // are the ones present in `curatorOrder`; both spell the same plugin.
    expect(repinCuratorOrder(curator, actual)).toEqual([
      "Alpha.esp",
      "Beta.esp",
    ]);
  });

  it("returns the same members it was given, never more or fewer", () => {
    // The result is written back to Vortex as the whole load order. Losing a
    // member would disable a plugin; inventing one would name a file that is
    // not there.
    const curator = ["a.esp", "b.esp", "missing.esp"];
    const actual = ["x.esp", "b.esp", "y.esp", "a.esp"];
    const out = repinCuratorOrder(curator, actual);
    expect(out).toHaveLength(actual.length);
    expect([...out].sort()).toEqual([...actual].sort());
  });

  it("is a no-op when LOOT already agreed with the curator", () => {
    const curator = ["a.esp", "b.esp"];
    const actual = ["a.esp", "mine.esp", "b.esp"];
    expect(repinCuratorOrder(curator, actual)).toEqual(actual);
  });

  it("handles a collection with no plugins at all", () => {
    const actual = ["mine.esp", "theirs.esp"];
    expect(repinCuratorOrder([], actual)).toEqual(actual);
  });
});

describe("orderDiffers", () => {
  it("is false for the same order, whatever the case", () => {
    expect(orderDiffers(["A.esp", "b.ESP"], ["a.esp", "B.esp"])).toBe(false);
  });

  it("is true when anything moved, or when a member appeared", () => {
    expect(orderDiffers(["a.esp", "b.esp"], ["b.esp", "a.esp"])).toBe(true);
    expect(orderDiffers(["a.esp"], ["a.esp", "b.esp"])).toBe(true);
  });
});
