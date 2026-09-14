import { describe, expect, it } from "vitest";

import type { ArchiveListing } from "./archiveContents";
import { expandFomodPlan, fomodRootOf } from "./expandFomodPlan";
import type { FomodFileSpec } from "./fomodReplay";

function listing(paths: string[]): ArchiveListing {
  const entries = paths.map((p, i) => ({ path: p, size: 100 + i, crc: `0000000${i}` }));
  return { entries, withCrc: entries.length, crcCoverage: 1 };
}

const folder = (source: string, destination?: string, priority = 0): FomodFileSpec => ({
  source, priority, isFolder: true, ...(destination !== undefined ? { destination } : {}),
});
const file = (source: string, destination?: string, priority = 0): FomodFileSpec => ({
  source, priority, isFolder: false, ...(destination !== undefined ? { destination } : {}),
});

describe("expandFomodPlan", () => {
  it("expands a folder to the mod root when destination is empty", () => {
    const r = expandFomodPlan(
      [folder("10 Core/00 Required", "")],
      listing(["10 Core/00 Required/AAF/x.xml", "10 Core/00 Required/y.esp", "other/z.txt"]),
    );
    expect(r.files.map((f) => f.path).sort()).toEqual(["AAF/x.xml", "y.esp"]);
  });

  it("treats destination \".\" as the mod root, not a folder named \".\"", () => {
    /**
     * The FOMOD Creation Tool writes `destination="."`. It used to survive
     * as a path segment, so a real Skyrim mod — Extended Cut: Saints and
     * Seducers — was predicted at `./interface/...`, never matched its own
     * staged `interface/...`, and was reported missing 115 of 120 files.
     */
    const r = expandFomodPlan(
      [folder("00 Core Files", ".")],
      listing(["00 Core Files/interface/dog/corgi.dds", "00 Core Files/ECSS.esp"]),
    );
    expect(r.files.map((f) => f.path).sort()).toEqual([
      "ECSS.esp",
      "interface/dog/corgi.dds",
    ]);
  });

  it("drops . and empty segments anywhere in a destination", () => {
    const r = expandFomodPlan(
      [folder("src", "./Textures/."), folder("more", "Meshes//a")],
      listing(["src/b.dds", "more/c.nif"]),
    );
    expect(r.files.map((f) => f.path).sort()).toEqual([
      "Meshes/a/c.nif",
      "Textures/b.dds",
    ]);
  });

  it("installs a file with destination \".\" at the root under its own name", () => {
    const r = expandFomodPlan(
      [file("opt/Patch.esp", ".")],
      listing(["opt/Patch.esp"]),
    );
    expect(r.files[0]!.path).toBe("Patch.esp");
  });

  it("matches a source written with a leading ./", () => {
    const r = expandFomodPlan(
      [folder("./00 Core Files", "")],
      listing(["00 Core Files/x.esp"]),
    );
    expect(r.unmatchedSpecs).toEqual([]);
    expect(r.files[0]!.path).toBe("x.esp");
  });

  it("expands a folder under a destination prefix", () => {
    const r = expandFomodPlan(
      [folder("src/tex", "Textures")],
      listing(["src/tex/a/b.dds"]),
    );
    expect(r.files[0].path).toBe("Textures/a/b.dds");
  });

  it("matches source paths case- and separator-insensitively", () => {
    // FOMOD authors are inconsistent and Windows does not care; a strict
    // compare would invent mismatches on a correct install.
    const r = expandFomodPlan(
      [folder("20 Bodies Patch\\00 Atomic Muscle")],
      listing(["20 bodies patch/00 atomic muscle/AAF/AM-actionData.xml"]),
    );
    expect(r.files).toHaveLength(1);
    expect(r.files[0].path).toBe("AAF/AM-actionData.xml");
  });

  it("installs a bare file spec at the root under its own name", () => {
    const r = expandFomodPlan([file("deep/nested/a.esp")], listing(["deep/nested/a.esp"]));
    expect(r.files[0].path).toBe("a.esp");
  });

  it("uses a file spec's destination as the full target path", () => {
    const r = expandFomodPlan(
      [file("src/a.esp", "Data/renamed.esp")],
      listing(["src/a.esp"]),
    );
    expect(r.files[0].path).toBe("Data/renamed.esp");
  });

  it("does NOT let two root-installing folders collide", () => {
    // The regression that collapsed a real 25-choice install to one folder.
    const r = expandFomodPlan(
      [folder("A", ""), folder("B", "")],
      listing(["A/one.txt", "B/two.txt"]),
    );
    expect(r.files.map((f) => f.path).sort()).toEqual(["one.txt", "two.txt"]);
    expect(r.contested).toBe(0);
  });

  it("resolves a genuine per-file collision by priority", () => {
    const r = expandFomodPlan(
      [folder("low", "", 0), folder("high", "", 10)],
      listing(["low/same.esp", "high/same.esp"]),
    );
    expect(r.files).toHaveLength(1);
    expect(r.files[0].entry.path).toBe("high/same.esp");
    expect(r.contested).toBe(1);
  });

  it("lets a later spec of EQUAL priority win (document order)", () => {
    const r = expandFomodPlan(
      [folder("first", "", 5), folder("second", "", 5)],
      listing(["first/same.esp", "second/same.esp"]),
    );
    expect(r.files[0].entry.path).toBe("second/same.esp");
  });

  it("keeps the higher priority even when it comes first", () => {
    const r = expandFomodPlan(
      [folder("high", "", 9), folder("low", "", 1)],
      listing(["high/same.esp", "low/same.esp"]),
    );
    expect(r.files[0].entry.path).toBe("high/same.esp");
  });

  it("reports a spec that matched nothing instead of silently predicting less", () => {
    // Script and archive disagreeing usually means our matching is wrong, not
    // that the mod is broken — the caller must be able to downgrade.
    const r = expandFomodPlan([folder("does/not/exist")], listing(["real/a.txt"]));
    expect(r.files).toHaveLength(0);
    expect(r.unmatchedSpecs).toHaveLength(1);
  });

  it("carries the supplying archive entry so content can be verified later", () => {
    const r = expandFomodPlan([folder("s")], listing(["s/a.dds"]));
    expect(r.files[0].entry.crc).toBeDefined();
    expect(r.files[0].entry.size).toBeDefined();
  });
});

describe("paths relative to the folder that holds fomod/", () => {
  // INVB_OverlayFramework v2.483 keeps everything under a wrapper folder, and its
  // specs name "INVB_OverlayFramework - Main.ba2", not the wrapped path. Matched
  // from the archive root, not one spec matched and the self-check gave up.
  const wrapped = listing([
    "INVB v2/fomod/ModuleConfig.xml",
    "INVB v2/Main.ba2",
    "INVB v2/MCM Options/0. General/MCM/config.json",
    "Unrelated/Main.ba2",
  ]);

  it("finds the root of a script at the top or inside folders", () => {
    expect(fomodRootOf("fomod/ModuleConfig.xml")).toBe("");
    expect(fomodRootOf("INVB v2/fomod/ModuleConfig.xml")).toBe("INVB v2");
    expect(fomodRootOf("A/B/FOMOD/ModuleConfig.xml")).toBe("A/B");
    expect(fomodRootOf("A\\fomod\\ModuleConfig.xml")).toBe("A");
  });

  it("expands specs against that root", () => {
    const r = expandFomodPlan(
      [file("Main.ba2"), folder("MCM Options\\0. General\\MCM", "MCM")],
      wrapped,
      fomodRootOf("INVB v2/fomod/ModuleConfig.xml"),
    );
    expect(r.unmatchedSpecs).toEqual([]);
    expect(r.files.map((f) => f.path).sort()).toEqual(["MCM/config.json", "Main.ba2"]);
  });

  it("keeps the archive entry each file comes from", () => {
    const r = expandFomodPlan([file("Main.ba2")], wrapped, "INVB v2");
    expect(r.files.map((f) => f.entry.path)).toEqual(["INVB v2/Main.ba2"]);
  });

  it("matches the root whatever its case", () => {
    const r = expandFomodPlan([file("Main.ba2")], wrapped, "invb V2");
    expect(r.files.map((f) => f.path)).toEqual(["Main.ba2"]);
  });

  it("does not reach outside the root for a file the root lacks", () => {
    const r = expandFomodPlan(
      [file("Other.esp")],
      listing(["Wrap/fomod/ModuleConfig.xml", "Other/Other.esp"]),
      "Wrap",
    );
    expect(r.files).toEqual([]);
    expect(r.unmatchedSpecs).toHaveLength(1);
  });

  it("matches nothing from the archive root when the script sits in a folder", () => {
    // What every such mod got before the root was passed.
    const r = expandFomodPlan([file("Main.ba2")], wrapped);
    expect(r.unmatchedSpecs).toHaveLength(1);
  });
});
