/**
 * The four choices map onto two stored fields that predate each other, and
 * getting the collapse wrong is silent: a config still loads, the form still
 * renders, and the collection ships telling someone to open a page that does
 * not exist.
 */
import { describe, expect, it } from "vitest";

import {
  describeSourceKind,
  sourceKindOf,
  sourcePatch,
  sourceProblem,
} from "./externalSource";

describe("sourceKindOf", () => {
  it("lets bundled win over any recorded mode", () => {
    // The bytes ship, so no fetch happens and the mode describes nothing.
    expect(sourceKindOf({ bundled: true, mode: "browse", url: "https://e.com" })).toBe(
      "bundled",
    );
  });

  it("reads back each explicit mode", () => {
    expect(sourceKindOf({ mode: "direct" })).toBe("direct");
    expect(sourceKindOf({ mode: "browse" })).toBe("browse");
    expect(sourceKindOf({ mode: "manual" })).toBe("manual");
  });

  it("defaults an unmoded entry by whether it has a link", () => {
    // Every config written before `mode` existed lands here.
    expect(sourceKindOf({ url: "https://example.com/mods/1" })).toBe("browse");
    expect(sourceKindOf({})).toBe("manual");
    expect(sourceKindOf({ url: "   " })).toBe("manual");
  });
});

describe("sourcePatch", () => {
  it("writes bundled explicitly when switching away from it", () => {
    // An absent boolean and a false one read the same here but not to the
    // rest of the config, and switching away has to actually switch away.
    expect(sourcePatch("browse")).toEqual({ bundled: false, mode: "browse" });
    expect(sourcePatch("manual")).toEqual({ bundled: false, mode: "manual" });
    expect(sourcePatch("bundled")).toEqual({ bundled: true });
  });

  it("never clears the link", () => {
    // Toggling to Bundled and back must not eat what the curator typed.
    for (const kind of ["bundled", "direct", "browse", "manual"] as const) {
      expect(sourcePatch(kind)).not.toHaveProperty("url");
    }
  });

  it("round-trips through sourceKindOf", () => {
    for (const kind of ["bundled", "direct", "browse", "manual"] as const) {
      expect(sourceKindOf(sourcePatch(kind))).toBe(kind);
    }
  });
});

describe("sourceProblem", () => {
  it("catches a link-based choice with no link", () => {
    // The user-side screen offers "open the page" — with no page.
    expect(
      sourceProblem({ mode: "browse" }, { hasStagingFolder: true }),
    ).toMatch(/link to the mod's page/);
    expect(
      sourceProblem({ mode: "direct" }, { hasStagingFolder: true }),
    ).toMatch(/link to the file/);
  });

  it("is happy with manual and no link — that is what manual means", () => {
    expect(sourceProblem({ mode: "manual" }, { hasStagingFolder: true })).toBeUndefined();
  });

  it("catches bundled with no staging folder to pack", () => {
    // NOT gated on the archive: measureBundledMods packs the STAGING
    // folder and re-keys the mod to the new archive hash, which is the whole
    // reason a hand-made mod Vortex never downloaded can still be bundled.
    const said = sourceProblem({ bundled: true }, { hasStagingFolder: false });
    expect(said).toMatch(/no staging folder/);
  });

  it("allows bundling a mod with no original archive", () => {
    // The regression this pins: gating on the archive would block bundling
    // for exactly the hand-made mods the feature exists for.
    expect(
      sourceProblem({ bundled: true }, { hasStagingFolder: true }),
    ).toBeUndefined();
  });

  it("says nothing about a well-formed choice", () => {
    expect(
      sourceProblem({ mode: "browse", url: "https://e.com/p" }, { hasStagingFolder: false }),
    ).toBeUndefined();
    expect(sourceProblem({ bundled: true }, { hasStagingFolder: true })).toBeUndefined();
  });
});

describe("describeSourceKind", () => {
  it("distinguishes direct from browse in what the user will DO", () => {
    // Getting these backwards sends someone hunting a page that never appears,
    // or waiting on a download that never starts.
    expect(describeSourceKind("direct").hint).toMatch(/starts the download/);
    expect(describeSourceKind("browse").hint).toMatch(/find the file on it/);
    expect(describeSourceKind("bundled").hint).toMatch(/Nothing to download/);
    expect(describeSourceKind("manual").hint).toMatch(/No link/);
  });

  it("labels every kind", () => {
    for (const kind of ["bundled", "direct", "browse", "manual"] as const) {
      expect(describeSourceKind(kind).label.length).toBeGreaterThan(0);
    }
  });
});
