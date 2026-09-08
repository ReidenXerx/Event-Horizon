/**
 * A curator edits an external mod's staging folder by hand — that is ordinary
 * practice for a mod they maintain themselves, not an accident — and none of
 * the identity axes can see it. Nor can the installer-answer axis: nothing ran
 * an installer.
 *
 * This is the cheap check that closes it: a hash over "path size" for every
 * staged file, which both sides can produce without reading a byte.
 */
import { describe, expect, it } from "vitest";

import { compareShapes, stagingShapeOf } from "./stagingShape";
import {
  diffCollectionAgainstProfile,
  summarizeBuiltMods,
} from "./collectionDiff";

const f = (path: string, size: number) => ({ path, size });

describe("the shape of a staging folder", () => {
  it("changes when a file is EDITED to a different length", () => {
    const before = stagingShapeOf([f("meshes/a.nif", 100)]);
    const after = stagingShapeOf([f("meshes/a.nif", 120)]);
    expect(before).not.toBe(after);
  });

  it("changes when a file is ADDED or REMOVED", () => {
    const base = [f("a.esp", 10), f("b.esp", 20)];
    expect(stagingShapeOf(base)).not.toBe(
      stagingShapeOf([...base, f("c.esp", 30)]),
    );
    expect(stagingShapeOf(base)).not.toBe(stagingShapeOf([f("a.esp", 10)]));
  });

  it("changes when a file is RENAMED at the same size", () => {
    // Total bytes and file count are both identical here, which is why the
    // shape is a hash over paths rather than a pair of counters.
    expect(stagingShapeOf([f("a.esp", 10)])).not.toBe(
      stagingShapeOf([f("b.esp", 10)]),
    );
  });

  it("does NOT change when the walk returns files in another order", () => {
    // Directory order is an implementation detail of the walk. Reporting it as
    // a change would make the signal fire at random.
    expect(stagingShapeOf([f("a", 1), f("b", 2)])).toBe(
      stagingShapeOf([f("b", 2), f("a", 1)]),
    );
  });

  it("does NOT change when only separators differ", () => {
    // The manifest carries "/" and a Windows walk produces "\". Comparing
    // those raw would report every single mod as changed.
    expect(stagingShapeOf([f("meshes/x/a.nif", 5)])).toBe(
      stagingShapeOf([f("meshes\\x\\a.nif", 5)]),
    );
  });

  it("IGNORES a runtime log appearing in the folder", () => {
    /**
     * The one that decides whether this feature is usable. A script extender
     * writes a log into a mod's folder every time the game runs; without this
     * exclusion the curator would see most of their collection reported as
     * changed after a single play session, and a signal that fires constantly
     * is one they stop reading.
     */
    const clean = stagingShapeOf([f("SKSE/Plugins/x.dll", 100)]);
    const played = stagingShapeOf([
      f("SKSE/Plugins/x.dll", 100),
      f("SKSE/Plugins/x.log", 4096),
    ]);
    expect(played).toBe(clean);
  });

  it("pairs each surviving path with its OWN size after exclusions", () => {
    /**
     * The bug this file caught while it was being written: filtering a list of
     * paths and then indexing the original array by position pairs each
     * remaining path with a different file's size. It only shows up once
     * something is excluded — which, given the log rule above, is most mods.
     */
    const withLog = stagingShapeOf([
      f("a.log", 999),
      f("b.esp", 10),
      f("c.esp", 20),
    ]);
    const withoutLog = stagingShapeOf([f("b.esp", 10), f("c.esp", 20)]);
    expect(withLog).toBe(withoutLog);
  });

  it("does not fold case — two files on ext4 are two files (NS-4)", () => {
    expect(stagingShapeOf([f("Scripts/A.pex", 1)])).not.toBe(
      stagingShapeOf([f("scripts/a.pex", 1)]),
    );
  });
});

describe("comparing shapes", () => {
  it("is unknown when either side is missing, never 'same'", () => {
    // A folder that could not be walked is an absence. Reporting it as a match
    // is the confident zero this project keeps having to unlearn.
    expect(compareShapes(undefined, "abc")).toBe("unknown");
    expect(compareShapes("abc", undefined)).toBe("unknown");
    expect(compareShapes(undefined, undefined)).toBe("unknown");
  });

  it("compares plainly when both are known", () => {
    expect(compareShapes("abc", "abc")).toBe("same");
    expect(compareShapes("abc", "def")).toBe("differ");
  });
});

describe("through the whole diff", () => {
  const shipped = (files: { path: string; size: number }[]) => [
    {
      compareKey: "external:staging:aaa",
      name: "My Config Pack",
      version: "1.0",
      state: { enabled: true, stagingFiles: files },
      install: { fomodSelections: [] },
    },
  ];
  const live = [
    {
      id: "m1",
      name: "My Config Pack",
      version: "1.0",
      enabled: true,
      fomodSelections: [],
    },
  ] as never;

  const built = (files: { path: string; size: number }[]) =>
    // Round-trips through the REAL projection, so the built shape is derived
    // the way production derives it rather than hand-written to match.
    summarizeBuiltMods(shipped(files) as never);

  it("reports an edited staging folder as a change", () => {
    const diff = diffCollectionAgainstProfile({
      built: built([f("config.ini", 100)]),
      current: live,
      liveShapes: new Map([["m1", stagingShapeOf([f("config.ini", 250)])]]),
    });
    expect(diff.added).toEqual([]);
    expect(diff.removed).toEqual([]);
    expect(diff.updated).toEqual([]);
    expect(diff.toggled).toEqual([]);
    expect(diff.reconfigured).toEqual([
      { name: "My Config Pack", version: "1.0", reason: "staged-files" },
    ]);
    expect(diff.unchanged).toBe(0);
  });

  it("says nothing when the folder is untouched", () => {
    const files = [f("config.ini", 100)];
    const diff = diffCollectionAgainstProfile({
      built: built(files),
      current: live,
      liveShapes: new Map([["m1", stagingShapeOf(files)]]),
    });
    expect(diff.reconfigured).toEqual([]);
    expect(diff.unchanged).toBe(1);
  });

  it("does not run the axis at all when no shapes were supplied", () => {
    // Walking a thousand folders is the caller's cost to choose. Omitted, the
    // axis must not silently report those mods as matching.
    const diff = diffCollectionAgainstProfile({
      built: built([f("config.ini", 100)]),
      current: live,
    });
    expect(diff.reconfigured).toEqual([]);
    expect(diff.stagingUnknown).toBe(0);
  });

  it("counts a folder it could not read rather than calling it a match", () => {
    const diff = diffCollectionAgainstProfile({
      built: built([f("config.ini", 100)]),
      current: live,
      // The mod is absent from the map: its folder could not be walked.
      liveShapes: new Map(),
    });
    expect(diff.reconfigured).toEqual([]);
    expect(diff.stagingUnknown).toBe(1);
  });
});
