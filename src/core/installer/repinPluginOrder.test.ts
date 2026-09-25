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

describe("a duplicated entry in plugins.txt", () => {
  /**
   * `parsePluginsTxt` trims and drops blanks and comments but never dedupes,
   * so a hand-edited or MO2-migrated plugins.txt reaches the merge with the
   * same name twice.
   *
   * That used to LOSE a member and INVENT another: `owned` and `present` are
   * Sets, so multiplicity was erased while slots were still counted per
   * position — three owned slots against a two-entry queue, the third read
   * landing past the end and falling back to the slot name. Written back to
   * Vortex that is a plugin dropped from the load order and another listed
   * twice.
   *
   * The old test asserted member preservation on a duplicate-free fixture:
   * the case that cannot fail (GP-4).
   */
  it("never drops or invents a plugin", () => {
    const merged = repinCuratorOrder(["B.esp", "A.esp"], ["A.esp", "A.esp", "B.esp"]);
    // Every name that came in is still there, exactly once.
    expect([...merged].sort()).toEqual(["A.esp", "B.esp"]);
    // And the curator's relative order won in the slots it owns.
    expect(merged).toEqual(["B.esp", "A.esp"]);
  });

  it("tolerates a duplicate on the CURATOR side too", () => {
    const merged = repinCuratorOrder(["B.esp", "B.esp", "A.esp"], ["A.esp", "B.esp"]);
    expect([...merged].sort()).toEqual(["A.esp", "B.esp"]);
    expect(merged).toEqual(["B.esp", "A.esp"]);
  });
});

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

describe("a user's patch for a collection plugin", () => {
  /**
   * The tester's case, 2026-09-25: LOOT put a one-record patch right under
   * llamaCompanionHeatherv2.esp; the refill then moved Heather to a LATER
   * collection slot, and the patch loaded before its own master, so Heather's
   * record won and the patch did nothing.
   */
  const curator = ["a.esp", "b.esp", "heather.esp"];
  const afterLoot = ["a.esp", "heather.esp", "patch.esp", "b.esp"];

  it("used to land above its master (the bug, without masters)", () => {
    expect(repinCuratorOrder(curator, afterLoot)).toEqual(["a.esp", "b.esp", "patch.esp", "heather.esp"]);
  });

  it("moves below its master when its masters are known", () => {
    const out = repinCuratorOrder(curator, afterLoot, { "patch.esp": ["Fallout4.esm", "Heather.esp"] });
    expect(out).toEqual(["a.esp", "b.esp", "heather.esp", "patch.esp"]);
  });

  it("never moves the collection's own plugins to make room", () => {
    const out = repinCuratorOrder(curator, afterLoot, { "patch.esp": ["heather.esp"] });
    expect(out.filter((n) => curator.includes(n))).toEqual(curator);
  });

  it("lands under the LAST of several masters", () => {
    const actual = ["heather.esp", "patch.esp", "a.esp", "b.esp"];
    const out = repinCuratorOrder(curator, actual, { "patch.esp": ["heather.esp", "b.esp"] });
    // Curator refill: a, b, heather into slots 0, 2, 3 → [a, patch, b, heather]; patch needs both.
    expect(out).toEqual(["a.esp", "b.esp", "heather.esp", "patch.esp"]);
  });

  it("settles a chain: a patch of the user's patch follows it down", () => {
    const out = repinCuratorOrder(curator, ["a.esp", "heather.esp", "patch.esp", "patch2.esp", "b.esp"], {
      "patch.esp": ["heather.esp"],
      "patch2.esp": ["patch.esp"],
    });
    const at = (n: string) => out.indexOf(n);
    expect(at("patch.esp")).toBeGreaterThan(at("heather.esp"));
    expect(at("patch2.esp")).toBeGreaterThan(at("patch.esp"));
    expect([...out].sort()).toEqual(["a.esp", "b.esp", "heather.esp", "patch.esp", "patch2.esp"]);
  });

  it("leaves a plugin whose masters are already above it exactly where LOOT put it", () => {
    const actual = ["a.esp", "b.esp", "heather.esp", "patch.esp"];
    expect(repinCuratorOrder(curator, actual, { "patch.esp": ["heather.esp"] })).toEqual(actual);
  });

  it("ignores a master that is not in the load order at all", () => {
    const out = repinCuratorOrder(curator, afterLoot, { "patch.esp": ["notinstalled.esp"] });
    expect(out).toEqual(repinCuratorOrder(curator, afterLoot));
  });

  it("terminates on a master cycle and loses nobody", () => {
    const out = repinCuratorOrder(curator, ["x.esp", "y.esp", ...curator], { "x.esp": ["y.esp"], "y.esp": ["x.esp"] });
    expect([...out].sort()).toEqual(["a.esp", "b.esp", "heather.esp", "x.esp", "y.esp"]);
  });
});
