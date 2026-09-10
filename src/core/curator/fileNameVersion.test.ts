/**
 * ──────────────────────────────────────────────────────────────────────
 * Stripping a version out of a file's name, without stripping a name.
 *
 * Every "must merge" case below is a real pair from the curator's download
 * folders — one file at several versions that the old comparison treated as
 * unrelated, so its old copies were never reclaimable.
 *
 * Every "must NOT merge" case is also real, and is the expensive direction:
 * two DIFFERENT files on one Nexus page that a careless strip would fuse,
 * after which the older one is offered for permanent deletion as though it
 * were a stale version of the other.
 *
 * Vortex's own `modGrouping.ts` does this with
 * `logicalFileName.replace(version, "")` — unanchored, substring, no shape
 * check. The refusals here are the entire difference between that and this.
 * ──────────────────────────────────────────────────────────────────────
 */
import { describe, expect, it } from "vitest";

import {
  nameForms,
  stripKnownVersion,
  stripTrailingVersion,
} from "./fileNameVersion";

describe("stripTrailingVersion", () => {
  it("merges one file's versions when the author put them in the name", () => {
    const cases: [string, string][] = [
      ["Addictol 1.0", "Addictol"],
      ["Addictol 1.1", "Addictol"],
      ["apocalypse 10.0.0", "apocalypse"],
      ["apocalypse 10.2.2", "apocalypse"],
      ["BodySlide and Outfit Studio - v5.7.0", "BodySlide and Outfit Studio"],
      ["BodySlide and Outfit Studio - v5.8.1", "BodySlide and Outfit Studio"],
      ["all books en v0.1", "all books en"],
      ["d.u.i. se v2.4.2", "d.u.i. se"],
      ["Backpacks of the Commonwealth 1.8.1", "Backpacks of the Commonwealth"],
      ["Misery Island 1.0.3", "Misery Island"],
      ["Faster File Copy 1.0", "Faster File Copy"],
      ["Granite Hill - Cut Content Restoration v1.6.1", "Granite Hill - Cut Content Restoration"],
    ];
    for (const [input, want] of cases) {
      expect(stripTrailingVersion(input)).toBe(want);
    }
  });

  it("REFUSES a trailing number that is part of the name", () => {
    /**
     * The expensive direction. Each of these shares a Nexus page with a
     * sibling, so fusing them makes the older one deletable as a "version"
     * of a file it has nothing to do with.
     *
     * A single trailing integer is ambiguous by nature — `Mateba Unica 6` is
     * a gun, `Addictol 1` might be a version — so it is never stripped. The
     * cost of that refusal is one archive not reclaimed; the cost of the
     * other choice is one archive destroyed.
     */
    const keep = [
      ".44 Auto-Revolver (Mateba Unica 6)",
      "HoloHUD 4PA",
      "T6M Mag-12",
      "Mod 1 - M1A1 Thompson - Pre-Nextgen-Update",
      "Mod 4 - Owen Gun - PRENEXTGEN",
      "Visitor Addon Pets",
      "Previsibines Repair Pack - Full (1.10.163)",
      "2. LP Bravo - Loose - ESL",
      "CBBE 3BA",
      "Sleipnir Beds - BOS Color Variance - Upper Class",
    ];
    for (const name of keep) {
      expect(stripTrailingVersion(name)).toBe(name);
    }
  });

  it("never returns an empty identity", () => {
    // An empty string would match every other empty string, which is the
    // same-page fallacy with no name at all.
    for (const only of ["1.0.2", "v3.1", "  2.4.1  "]) {
      expect(stripTrailingVersion(only)).not.toBe("");
    }
  });

  it("handles a name carrying two version tokens", () => {
    expect(stripTrailingVersion("Mod - v1.2 - 1.2.3")).toBe("Mod");
  });
});

describe("stripKnownVersion", () => {
  it("removes the version as a WHOLE TOKEN", () => {
    expect(stripKnownVersion("Widget 1.0.2", "1.0.2")).toBe("Widget");
    expect(stripKnownVersion("Widget v2.4", "2.4")).toBe("Widget");
  });

  it("REFUSES a version that is not at the END of the name", () => {
    /**
     * Two hazards, one rule.
     *
     * Vortex's line is `logicalFileName.replace(version, "")` — unanchored,
     * so at version "1" it turns `Mod 1 - M1A1 Thompson` into
     * `Mod  - MA Thompson`. Anchoring the token fixes that much.
     *
     * But anchoring alone still fuses unrelated files: `Fallout 4 Weapons` at
     * version "4" becomes `Fallout Weapons`, a plausible name for a DIFFERENT
     * file on the same page — and the older of the two would then be
     * deletable as a stale version of it. So the version must also be last.
     */
    for (const [name, version] of [
      ["Mod 1 - M1A1 Thompson", "1"],
      ["Fallout 4 Weapons", "4"],
      ["M1A1 Thompson Pack", "1"],
      ["BodyTalk4", "4"],
      ["2. LP Bravo - Loose - ESL", "2"],
    ] as [string, string][]) {
      expect(stripKnownVersion(name, version)).toBe(name);
    }
  });

  it("is a no-op when no version is known", () => {
    expect(stripKnownVersion("Widget 1.0.2", undefined)).toBe("Widget 1.0.2");
    expect(stripKnownVersion("Widget 1.0.2", "")).toBe("Widget 1.0.2");
  });

  it("survives a version containing regex metacharacters", () => {
    // "1.0(beta)" is a real shape, and an unescaped RegExp would throw or
    // match something else entirely.
    expect(stripKnownVersion("Widget 1.0(beta)", "1.0(beta)")).toBe("Widget");
  });

  it("never returns an empty identity", () => {
    expect(stripKnownVersion("2.4.1", "2.4.1")).toBe("2.4.1");
  });
});

describe("nameForms", () => {
  it("keeps the ORIGINAL form, so nothing that matched before stops", () => {
    const forms = nameForms("Addictol 1.1", "1.1");
    expect(forms).toContain("addictol 1.1");
    expect(forms).toContain("addictol");
  });

  it("lets two versions of one file share a form", () => {
    const a = new Set(nameForms("Addictol 1.0", "1.0"));
    const b = new Set(nameForms("Addictol 1.1", "1.1"));
    const shared = [...a].filter((f) => b.has(f));
    expect(shared).toEqual(["addictol"]);
  });

  it("leaves two DIFFERENT files on one page sharing nothing", () => {
    const a = new Set(nameForms("Visitor Addon Pets", "2.0.0"));
    const b = new Set(nameForms("Settlement Visitors", "2.2.0"));
    expect([...a].filter((f) => b.has(f))).toEqual([]);
  });

  it("returns nothing for an absent name rather than an empty string", () => {
    expect(nameForms(undefined)).toEqual([]);
    expect(nameForms("   ")).toEqual([]);
  });
});
