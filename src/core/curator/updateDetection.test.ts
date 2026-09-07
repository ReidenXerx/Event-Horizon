/**
 * ──────────────────────────────────────────────────────────────────────
 * Our update list must never be narrower than Vortex's own filter.
 *
 * The curator checks our Updates table against Vortex's Mods table filtered by
 * "Update available". A mod in theirs and not ours reads as us being broken —
 * and twice now, we were.
 *
 * Vortex's `updateState`, read out of the shipped bundle:
 *
 *     newestFileId === "unknown"
 *  || (truthy(newestFileId) && truthy(fileId)
 *      && newestFileId.toString() !== fileId.toString())
 *  || versionClean(newestVersion) !== versionClean(version)
 *
 * THREE signals, ORed. We read only the second, and read it as a NUMBER —
 * so `Number("unknown")` became NaN became `undefined`, and a mod Vortex was
 * actively flagging arrived looking like a mod with no update at all.
 *
 * On a real Fallout 4 profile that filter showed 20 of 1,007 mods, several
 * carrying the go-to-the-site icon that IS the "unknown" state.
 * ──────────────────────────────────────────────────────────────────────
 */
import { describe, expect, it } from "vitest";

import {
  findManualUpdates,
  findUpdatable,
  vortexReportsUpdate,
  type CuratorMod,
} from "./profileActions";

const mod = (over: Partial<CuratorMod> = {}): CuratorMod =>
  ({
    id: "m1",
    name: "A Mod",
    enabled: true,
    modType: "",
    nexusModId: 100,
    nexusFileId: 200,
    version: "1.0.0",
    downloadGame: "fallout4",
    ...over,
  }) as CuratorMod;

describe("vortexReportsUpdate — each of Vortex's three signals", () => {
  it("1. newestFileId is the literal string \"unknown\"", () => {
    // Vortex tests this FIRST. It is an assertion that an update exists, not
    // an absence of information — and it is the one we destroyed on the way
    // in by coercing the attribute to a number.
    expect(vortexReportsUpdate(mod({ newestFileUnknown: true }))).toBe(true);
  });

  it("2. a different file id", () => {
    expect(vortexReportsUpdate(mod({ newestFileId: 999 }))).toBe(true);
  });

  it("3. a different version string", () => {
    expect(vortexReportsUpdate(mod({ newestVersion: "1.1.0" }))).toBe(true);
  });

  it("says no when every signal is quiet", () => {
    // The other half: a mod with nothing to report must not appear, or the
    // list becomes 1,007 rows and stops being read at all.
    expect(
      vortexReportsUpdate(
        mod({ newestFileId: 200, newestVersion: "1.0.0" }),
      ),
    ).toBe(false);
  });

  it("ignores a version that differs only in case", () => {
    // "1.0A" and "1.0a" are one release. Reporting that on every refresh is
    // noise, and noise is how a real update gets scrolled past.
    expect(
      vortexReportsUpdate(mod({ version: "1.0a", newestVersion: "1.0A" })),
    ).toBe(false);
  });
});

describe("the two lists together cover Vortex's filter", () => {
  const inEither = (m: CuratorMod): boolean =>
    findUpdatable([m]).length > 0 || findManualUpdates([m]).length > 0;

  it("an \"unknown\" newest file reaches the MANUAL list", () => {
    /**
     * The bug in one assertion. Vortex renders these with the go-to-the-site
     * icon — it knows there is an update and cannot name the file — which is
     * precisely what a manual update is. It appeared in neither list.
     */
    const m = mod({ newestFileUnknown: true });
    expect(findUpdatable([m])).toHaveLength(0); // nothing to automate
    expect(findManualUpdates([m])).toHaveLength(1);
    expect(findManualUpdates([m])[0]!.url).toBe(
      "https://www.nexusmods.com/fallout4/mods/100",
    );
  });

  it("says the version is unknown rather than inventing one", () => {
    // "unknown" means Vortex does not know the version either. A made-up
    // number in that column would be a claim nobody can check.
    expect(findManualUpdates([mod({ newestFileUnknown: true })])[0]!.toVersion)
      .toBe("unknown");
  });

  it("still routes a real newer file to the AUTOMATED list", () => {
    // Unchanged behaviour, asserted so the fix cannot quietly move mods from
    // the list that can update them to the list that cannot.
    const m = mod({ newestFileId: 999 });
    expect(findUpdatable([m])).toHaveLength(1);
    expect(findManualUpdates([m])).toHaveLength(0);
  });

  it("covers a mod Vortex flags for ANY of the three reasons", () => {
    for (const over of [
      { newestFileUnknown: true },
      { newestFileId: 999 },
      { newestVersion: "2.0" },
    ]) {
      const m = mod(over);
      expect(vortexReportsUpdate(m), JSON.stringify(over)).toBe(true);
      expect(inEither(m), JSON.stringify(over)).toBe(true);
    }
  });

  it("leaves a frozen mod out of both, whatever Vortex says", () => {
    // The curator pinned it deliberately. That outranks Nexus having a newer
    // file, and it is ours to honour — Vortex has no such concept.
    const m = mod({ newestFileUnknown: true, frozenAtVersion: "1.0.0" });
    expect(inEither(m)).toBe(false);
  });
});
