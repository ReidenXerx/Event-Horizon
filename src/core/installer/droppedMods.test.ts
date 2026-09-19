/**
 * A version-changing update installs into a fresh profile, so a mod the
 * curator dropped is not removed, not disabled, and used to be mentioned
 * nowhere at all. The behaviour is right — NS-2 forbids destroying it — and
 * the silence was not: a player's disk fills up one revision at a time with
 * mods nothing will ever name again.
 */
import { describe, expect, it } from "vitest";

import { describeDroppedMods, findDroppedMods } from "./droppedMods";
import type { InstallReceiptMod } from "../../types/installLedger";

const mod = (
  compareKey: string,
  over: Partial<InstallReceiptMod> = {},
): InstallReceiptMod =>
  ({
    vortexModId: `vid-${compareKey}`,
    compareKey,
    source: "nexus",
    name: `Mod ${compareKey}`,
    installedAt: "1970-01-01T00:00:00.000Z",
    ownership: "installed",
    ...over,
  }) as InstallReceiptMod;

describe("which mods the new version no longer contains", () => {
  it("names a mod that is gone from the manifest", () => {
    const out = findDroppedMods({
      previousMods: [mod("nexus:1:1"), mod("nexus:2:1")],
      currentCompareKeys: new Set(["nexus:1:1"]),
    });
    expect(out.map((m) => m.compareKey)).toEqual(["nexus:2:1"]);
  });

  it("does not count a mod that merely got a NEW FILE in this version", () => {
    // The routine version bump. Its compareKey changes, but the mod is still
    // in the collection — reporting it as dropped would fire on every upgrade.
    const out = findDroppedMods({
      previousMods: [mod("nexus:1:1")],
      currentCompareKeys: new Set(["nexus:1:2", "nexus:1:1"]),
    });
    expect(out).toEqual([]);
  });

  it("stays silent about a mod the player brought themselves", () => {
    // `adopted` means we recognised it, never that we installed it. Telling
    // someone "this version no longer includes" their own mod is wrong and
    // alarming (NS-2 in spirit).
    const out = findDroppedMods({
      previousMods: [mod("nexus:2:1", { ownership: "adopted" })],
      currentCompareKeys: new Set(),
    });
    expect(out).toEqual([]);
  });

  it("stays silent about one with no recorded ownership at all", () => {
    // Older receipts. Unknown is not ours — the same rule the mirror and the
    // repair already apply.
    const out = findDroppedMods({
      previousMods: [mod("nexus:2:1", { ownership: undefined })],
      currentCompareKeys: new Set(),
    });
    expect(out).toEqual([]);
  });

  it("skips one the player has already removed", () => {
    const out = findDroppedMods({
      previousMods: [mod("nexus:2:1"), mod("nexus:3:1")],
      currentCompareKeys: new Set(),
      stillInstalled: new Set(["vid-nexus:3:1"]),
    });
    expect(out.map((m) => m.compareKey)).toEqual(["nexus:3:1"]);
  });
});

describe("what the player is told", () => {
  const dropped = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      vortexModId: `v${i}`,
      compareKey: `nexus:${i}:1`,
      name: `Mod ${i}`,
    }));

  it("says nothing when nothing was dropped", () => {
    expect(describeDroppedMods([], "Old Profile")).toEqual([]);
  });

  it("names them, and says where they are still switched on", () => {
    const lines = describeDroppedMods(dropped(2), "Ivy (Event Horizon v1.0.27)");
    expect(lines.join(" ")).toContain("Mod 0, Mod 1");
    expect(lines.join(" ")).toContain("Ivy (Event Horizon v1.0.27)");
    // It must never read as though something was deleted.
    expect(lines.join(" ")).toContain("Nothing was removed");
  });

  it("caps the names and counts the rest", () => {
    const lines = describeDroppedMods(dropped(20), "P");
    expect(lines[0]).toContain("Mod 7");
    expect(lines[0]).not.toContain("Mod 8");
    expect(lines[0]).toContain("and 12 more");
    expect(lines[0]).toContain("20 mods");
  });

  it("still works when the previous profile cannot be named", () => {
    const lines = describeDroppedMods(dropped(1), undefined);
    expect(lines.join(" ")).toContain("the profile you were using before");
    expect(lines.join(" ")).toContain("1 mod from the version you had");
  });
});
