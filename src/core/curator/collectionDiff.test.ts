/**
 * The diff a curator reads before pressing Rebuild.
 *
 * The subtle case is an UPDATE: a Nexus mod whose file id moved is not "one
 * added and one removed", and reporting it that way would make a routine
 * version bump look like the curator had swapped a mod out.
 */
import { describe, expect, it } from "vitest";

import {
  describeCollectionDiff,
  diffCollectionAgainstProfile,
  isUnchanged,
  summarizeBuiltMods,
} from "./collectionDiff";
import type { AuditorMod } from "../getModsListForProfile";
import type { BuiltModSummary } from "./collectionDiff";

const builtMod = (
  compareKey: string,
  name: string,
  over: Partial<BuiltModSummary> = {},
): BuiltModSummary => ({ compareKey, name, enabled: true, ...over });

const live = (name: string, over: Partial<AuditorMod> = {}): AuditorMod =>
  ({ id: name, name, enabled: true, modType: "", ...over }) as AuditorMod;

const nexus = (name: string, modId: number, fileId: number, over: Partial<AuditorMod> = {}) =>
  live(name, { nexusModId: modId, nexusFileId: fileId, ...over });

describe("what a rebuild would ship", () => {
  it("matches an unchanged Nexus mod exactly", () => {
    const diff = diffCollectionAgainstProfile({
      built: [builtMod("nexus:7:100", "A Mod")],
      current: [nexus("A Mod", 7, 100)],
    });
    expect(isUnchanged(diff)).toBe(true);
    expect(diff.unchanged).toBe(1);
  });

  it("reports a NEW file of an existing mod as an update, not add+remove", () => {
    // The routine case. Add+remove would make a version bump look like the
    // curator swapped a mod out.
    const diff = diffCollectionAgainstProfile({
      built: [builtMod("nexus:7:100", "A Mod", { version: "1.0" })],
      current: [nexus("A Mod", 7, 200, { version: "2.0" })],
    });
    expect(diff.updated).toEqual([
      { name: "A Mod", fromVersion: "1.0", toVersion: "2.0" },
    ]);
    expect(diff.added).toEqual([]);
    expect(diff.removed).toEqual([]);
  });

  it("reports a genuinely new mod as added", () => {
    const diff = diffCollectionAgainstProfile({
      built: [],
      current: [nexus("Newcomer", 9, 1, { version: "1.0" })],
    });
    expect(diff.added).toEqual([{ name: "Newcomer", version: "1.0" }]);
  });

  it("reports a mod no longer in the profile as removed", () => {
    const diff = diffCollectionAgainstProfile({
      built: [builtMod("nexus:7:100", "Gone")],
      current: [],
    });
    expect(diff.removed).toEqual([{ name: "Gone" }]);
  });

  it("does not report a mod as removed just because it was updated", () => {
    // The same guard from the other side: consuming the built entry is what
    // stops the old file appearing in `removed` as well.
    const diff = diffCollectionAgainstProfile({
      built: [builtMod("nexus:7:100", "A Mod")],
      current: [nexus("A Mod", 7, 200)],
    });
    expect(diff.removed).toEqual([]);
  });

  it("notices a mod switched off since the build", () => {
    const diff = diffCollectionAgainstProfile({
      built: [builtMod("nexus:7:100", "A Mod")],
      current: [nexus("A Mod", 7, 100, { enabled: false })],
    });
    expect(diff.toggled).toEqual([{ name: "A Mod", nowEnabled: false }]);
    expect(diff.unchanged).toBe(0);
  });

  it("keeps two files of the same mod apart", () => {
    // A page with a main and an optional file: both installed, both known.
    const diff = diffCollectionAgainstProfile({
      built: [builtMod("nexus:7:100", "Main"), builtMod("nexus:7:101", "Optional")],
      current: [nexus("Main", 7, 100), nexus("Optional", 7, 101)],
    });
    expect(isUnchanged(diff)).toBe(true);
    expect(diff.unchanged).toBe(2);
  });
});

describe("external mods, matched only as far as is honest", () => {
  it("matches by name and says the match was approximate", () => {
    const diff = diffCollectionAgainstProfile({
      built: [builtMod("external:" + "a".repeat(64), "My Patch")],
      current: [live("My Patch")],
    });
    expect(isUnchanged(diff)).toBe(true);
    expect(diff.approximate).toBe(1);
  });

  it("reads a renamed external mod as removed plus added", () => {
    // Wrong-looking but honest: inventing a match would report the collection
    // unchanged when it is not.
    const diff = diffCollectionAgainstProfile({
      built: [builtMod("external:" + "a".repeat(64), "Old Name")],
      current: [live("New Name")],
    });
    expect(diff.added.map((a) => a.name)).toEqual(["New Name"]);
    expect(diff.removed.map((r) => r.name)).toEqual(["Old Name"]);
  });

  it("does not count an exact Nexus match as approximate", () => {
    const diff = diffCollectionAgainstProfile({
      built: [builtMod("nexus:7:100", "A Mod")],
      current: [nexus("A Mod", 7, 100)],
    });
    expect(diff.approximate).toBe(0);
  });

  it("treats a mod with only one Nexus id as external", () => {
    // `isNexusSourced` requires both ids. Half an identity is not one.
    const diff = diffCollectionAgainstProfile({
      built: [builtMod("nexus:7:100", "Half")],
      current: [live("Half", { nexusModId: 7 })],
    });
    expect(diff.approximate).toBe(1);
  });
});

describe("the line above the diff", () => {
  it("says plainly when nothing moved", () => {
    const diff = diffCollectionAgainstProfile({
      built: [builtMod("nexus:7:1", "A")],
      current: [nexus("A", 7, 1)],
    });
    expect(describeCollectionDiff(diff)).toContain("still matches the published");
  });

  it("describes what a rebuild WOULD do, not what happened", () => {
    const diff = diffCollectionAgainstProfile({
      built: [builtMod("nexus:7:1", "A")],
      current: [nexus("A", 7, 2), nexus("B", 8, 1)],
    });
    const text = describeCollectionDiff(diff);
    expect(text).toContain("Rebuilding would ship");
    expect(text).toContain("1 added");
    expect(text).toContain("1 updated");
  });

  it("warns when part of the answer rests on name matching", () => {
    const diff = diffCollectionAgainstProfile({
      built: [
        builtMod("external:" + "a".repeat(64), "Ext"),
        builtMod("nexus:7:1", "A"),
      ],
      current: [live("Ext"), nexus("A", 7, 2)],
    });
    expect(describeCollectionDiff(diff)).toContain("matched by name");
  });
});

describe("projecting the manifest down", () => {
  it("drops the HEAVY fields and keeps the installer answers", () => {
    /**
     * The rule is about weight, not about a count. `stagingFiles` is every
     * file of every mod — megabytes of React state to answer "what changed".
     * A mod's FOMOD answers are a handful of names, and without them the diff
     * cannot see a re-install through the wizard at all.
     *
     * Asserted as the PROPERTY (heavy out, answers in) rather than as an
     * exact object, which is what made this test fail on a field it was never
     * really about.
     */
    const [row] = summarizeBuiltMods([
      {
        compareKey: "nexus:7:1",
        name: "A",
        version: "1.0",
        state: { enabled: true, stagingFiles: [{ path: "x", size: 1 }] },
        install: {
          fomodSelections: [
            { name: "Step", groups: [{ name: "G", choices: [{ name: "C" }] }] },
          ],
        },
      } as never,
    ]);
    expect(row).toMatchObject({
      compareKey: "nexus:7:1",
      name: "A",
      version: "1.0",
      enabled: true,
    });
    expect(row?.fomodSelections).toHaveLength(1);
    expect(row).not.toHaveProperty("state");
    expect(JSON.stringify(row)).not.toContain("stagingFiles");
  });

  it("treats an absent enabled flag as enabled", () => {
    // The manifest omits `false` only for mods that were on, and an older
    // package may not carry the field at all.
    expect(summarizeBuiltMods([{ compareKey: "k", name: "A", state: {} } as never])[0]!.enabled)
      .toBe(true);
    expect(
      summarizeBuiltMods([
        { compareKey: "k", name: "A", state: { enabled: false } } as never,
      ])[0]!.enabled,
    ).toBe(false);
  });
});

describe("when the two sides identify a mod differently", () => {
  // Straight off the curator's real package: 29 of 1,757 mods came out as
  // `external:staging:<hash>` because Event Horizon could not tie them to
  // Nexus at build time. Vortex has since filled in their attributes, so the
  // live profile reads the very same mods as `nexus:<modId>:<fileId>`.
  const NAME = "Vampire Armors and Weapons Retexture SE-96855-1-0-1690493003";
  const HASH = "external:staging:1b1c183fe9c9d4ca7bb8b088b7036f20f17bc641";

  it("matches a mod that was external then and Nexus-keyed now", () => {
    const diff = diffCollectionAgainstProfile({
      built: [builtMod(HASH, NAME)],
      current: [nexus(NAME, 96855, 400123)],
    });
    expect(diff.added).toEqual([]);
    expect(diff.removed).toEqual([]);
    expect(diff.unchanged).toBe(1);
    // Matched by name, which a rename would defeat — so it is counted as
    // approximate rather than presented as certainty.
    expect(diff.approximate).toBe(1);
  });

  it("matches the other way round too", () => {
    // Built as Nexus, now unidentifiable. Same bridge, same answer.
    const diff = diffCollectionAgainstProfile({
      built: [builtMod("nexus:96855:400123", NAME)],
      current: [live(NAME)],
    });
    expect(diff.added).toEqual([]);
    expect(diff.removed).toEqual([]);
    expect(diff.unchanged).toBe(1);
  });

  it("never reports one name as BOTH added and removed", () => {
    // The invariant the curator spotted on screen: 20 added and 20 removed,
    // the same twenty names, none of which they had touched. A name on both
    // sides is a failure to match — it is never a change.
    const names = Array.from({ length: 20 }, (_, i) => `Mod ${i}-${1000 + i}-1-0`);
    const diff = diffCollectionAgainstProfile({
      built: names.map((n, i) => builtMod(`external:staging:${"a".repeat(8)}${i}`, n)),
      current: names.map((n, i) => nexus(n, 1000 + i, 500 + i)),
    });
    const both = diff.added
      .map((a) => a.name)
      .filter((n) => diff.removed.some((r) => r.name === n));
    expect(both).toEqual([]);
    expect(diff.unchanged).toBe(20);
  });

  it("still calls a genuine update an update, not a name match", () => {
    // Both sides Nexus-keyed and the file id moved. If name matching were
    // allowed to run here it would swallow the version change whenever an
    // author kept the file name.
    const diff = diffCollectionAgainstProfile({
      built: [builtMod("nexus:7:100", "Stable Name", { version: "1.0" })],
      current: [nexus("Stable Name", 7, 200, { version: "2.0" })],
    });
    expect(diff.updated).toHaveLength(1);
    expect(diff.unchanged).toBe(0);
  });

  it("does not bridge two genuinely different mods that share a name", () => {
    // Both Nexus-keyed, different pages. The name is a coincidence, and the
    // key comparison is the one that can actually tell them apart.
    const diff = diffCollectionAgainstProfile({
      built: [builtMod("nexus:7:100", "Ambiguous")],
      current: [nexus("Ambiguous", 999, 100)],
    });
    expect(diff.added).toHaveLength(1);
    expect(diff.removed).toHaveLength(1);
  });

  it("notices a toggle across the bridge", () => {
    const diff = diffCollectionAgainstProfile({
      built: [builtMod(HASH, NAME, { enabled: true })],
      current: [nexus(NAME, 96855, 1, { enabled: false })],
    });
    expect(diff.toggled).toEqual([{ name: NAME, nowEnabled: false }]);
  });

  it("claims each built entry at most once", () => {
    // Two installs sharing a name must not both match the single built one,
    // or the second would silently vanish from the report.
    const diff = diffCollectionAgainstProfile({
      built: [builtMod(HASH, "Twin")],
      current: [live("Twin"), live("Twin")],
    });
    expect(diff.unchanged).toBe(1);
    expect(diff.added).toHaveLength(1);
  });
});

/**
 * ─── ONE NEXUS PAGE, SEVERAL INSTALLS ──────────────────────────────────
 * The ordinary shape on a real profile: a main file and its variants share a
 * mod id. "The first entry from that page" is then whichever the manifest
 * happened to list first, which is not an answer.
 */
describe("a mod page with more than one install on it", () => {
  it("pairs each install with its own name, not with whichever came first", () => {
    // Both updated. Matching by position would report CBBE's old version as
    // Male's from-version and vice versa — an update that never happened,
    // with numbers the curator cannot reconcile against anything.
    const diff = diffCollectionAgainstProfile({
      built: [
        builtMod("nexus:7:100", "Bodypaints - CBBE", { version: "1.0" }),
        builtMod("nexus:7:200", "Bodypaints - Male", { version: "3.0" }),
      ],
      current: [
        nexus("Bodypaints - Male", 7, 201, { version: "3.1" }),
        nexus("Bodypaints - CBBE", 7, 101, { version: "1.1" }),
      ],
    });

    expect(diff.added).toEqual([]);
    expect(diff.removed).toEqual([]);
    const male = diff.updated.find((u) => u.name === "Bodypaints - Male");
    const cbbe = diff.updated.find((u) => u.name === "Bodypaints - CBBE");
    expect(male).toEqual({
      name: "Bodypaints - Male",
      fromVersion: "3.0",
      toVersion: "3.1",
    });
    expect(cbbe).toEqual({
      name: "Bodypaints - CBBE",
      fromVersion: "1.0",
      toVersion: "1.1",
    });
  });

  it("still pairs by page when the author renamed the file", () => {
    // The fallback has to survive: a rename with no same-name candidate is
    // still an update, not an add plus a remove.
    const diff = diffCollectionAgainstProfile({
      built: [builtMod("nexus:7:100", "Old Name", { version: "1.0" })],
      current: [nexus("New Name", 7, 101, { version: "1.1" })],
    });
    expect(diff.updated).toHaveLength(1);
    expect(diff.added).toEqual([]);
    expect(diff.removed).toEqual([]);
  });
});

describe("the name bridge picks a candidate it can actually bridge to", () => {
  it("does not report a bridgeable mod as added because a namesake was in front", () => {
    /**
     * Two built entries share a name: one Nexus-keyed (a DIFFERENT page, so
     * pass 2 never touches it) and one external. The live mod is Nexus-keyed,
     * so it can only bridge to the external entry.
     *
     * Testing only the first candidate found it blocked by the unclaimed
     * Nexus namesake and gave up: the mod was reported as ADDED and the
     * external entry it plainly corresponds to as REMOVED — two changes
     * standing in for a mod the curator had merely reinstalled from Nexus.
     */
    const diff = diffCollectionAgainstProfile({
      built: [
        builtMod("nexus:9:500", "Shared Name"),
        builtMod("external:abc123", "Shared Name"),
      ],
      current: [nexus("Shared Name", 42, 700)],
    });

    expect(diff.added).toEqual([]);
    expect(diff.approximate).toBe(1);
    // The other built entry IS gone, and is still reported as such.
    expect(diff.removed.map((r) => r.name)).toEqual(["Shared Name"]);
  });

  it("still refuses to bridge when BOTH sides carry a Nexus key", () => {
    // The rule the bridge must not erode: two real keys that disagree are an
    // add and a remove, never a name match, or a genuine swap disappears.
    const diff = diffCollectionAgainstProfile({
      built: [builtMod("nexus:9:500", "Shared Name")],
      current: [nexus("Shared Name", 42, 700)],
    });
    expect(diff.added).toHaveLength(1);
    expect(diff.removed).toHaveLength(1);
    expect(diff.approximate).toBe(0);
  });
});
