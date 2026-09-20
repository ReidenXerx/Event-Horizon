/**
 * The stale "771 archives are missing" line.
 *
 * A curator re-downloaded 771 archives, watched them arrive, pressed Build, and
 * was told 771 Nexus mods still could not be packaged — with the true count, 1,
 * sitting on the line directly below it. The external warning was doubled the
 * same way.
 *
 * The cause was a hand-copied substring. "Re-download archives" replaces these
 * warnings with freshly computed ones, and to do that it first has to drop the
 * old ones. It looked for "no source archive in Vortex's download cache" — a
 * phrase that reads perfectly and appears NOWHERE, because it is a blend of the
 * two sentences that replaced the single one it was copied from. So the filter
 * removed nothing, and every fresh warning landed beside its stale predecessor.
 *
 * Nothing failed. The recovery worked; only the report lied about it — and it
 * lied in the direction that makes a curator redo an hour of downloads.
 *
 * So the test that matters here is not "does the filter remove this one string".
 * It is that the producer and the matcher CANNOT disagree: every sentence
 * `describeMissingArchives` is able to emit must be recognised. Reword a message
 * without touching the constant and this fails.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { describeMissingArchives, isMissingArchiveWarning } from "./engine";
import type { AuditorMod } from "../../../core/getModsListForProfile";

const mod = (id: string, over: Partial<AuditorMod> = {}): AuditorMod =>
  ({
    id,
    name: id,
    enabled: true,
    collectionIds: [],
    hasInstallerChoices: false,
    hasDetailedInstallerChoices: false,
    fomodSelections: [],
    rules: [],
    modType: "",
    fileOverrides: [],
    enabledINITweaks: [],
    installOrder: 0,
    ...over,
  }) as AuditorMod;

const nexus = (id: string): AuditorMod =>
  mod(id, { nexusModId: 4321, nexusFileId: 8765 });

/** No Nexus ids: identified by its staged files, so it ships anyway. */
const external = (id: string): AuditorMod => mod(id);

describe("who the external half is about", () => {
  /**
   * The warning is about mods the PLAYER will be asked to supply, and its
   * whole point is that the pick cannot be checked. A mod whose files the
   * package carries is not one of those — and bundling was treated as the
   * only way that happens.
   *
   * Told about a mirrored mod, it said the build "will refuse until each one
   * has an archive here", which the gate does not do, and recommended
   * bundling, which takes the author's download away (NS-5). A curator who
   * had already answered "mirror" was sent to re-download a mod they had
   * solved.
   */
  const ctx = (bundled: string[], mirrored: string[]) => ({
    isExternal: () => true,
    isBundled: (m: AuditorMod) => bundled.includes(m.id),
    isMirrored: (m: AuditorMod) => mirrored.includes(m.id),
  });

  it("says nothing about a mod answered MIRROR", () => {
    expect(
      describeMissingArchives([external("porcPubes")], ctx([], ["porcPubes"])),
    ).toEqual([]);
  });

  it("says nothing about a mod answered BUNDLE", () => {
    expect(
      describeMissingArchives([external("porcPubes")], ctx(["porcPubes"], [])),
    ).toEqual([]);
  });

  it("still speaks up for a mod with no answer at all", () => {
    const lines = describeMissingArchives([external("porcPubes")], ctx([], []));
    expect(lines.join(" ")).toMatch(/porcPubes|asked to supply/i);
  });

  it("offers mirror alongside bundle, and says what separates them", () => {
    const lines = describeMissingArchives([external("x")], ctx([], [])).join(" ");
    expect(lines).toMatch(/"mirror"/i);
    expect(lines).toMatch(/"Bundle"/i);
    expect(lines).toMatch(/still download from the author/i);
  });
});

describe("recognising the missing-archive warnings", () => {
  it("matches every sentence the producer can emit", () => {
    // Both halves, together and apart — the producer branches on which kinds
    // of mod are present, so each branch has to be exercised.
    const cases = [
      [nexus("a")],
      [external("b")],
      [nexus("a"), external("b")],
      // Singular/plural take different code paths through the same sentence.
      [nexus("a"), nexus("c")],
      [external("b"), external("d")],
    ];

    for (const missing of cases) {
      const lines = describeMissingArchives(missing);
      expect(lines.length).toBeGreaterThan(0);
      for (const line of lines) {
        expect(
          isMissingArchiveWarning(line),
          `not recognised: ${line}`,
        ).toBe(true);
      }
    }
  });

  it("leaves every other build warning alone", () => {
    // Real warnings from the same report, one of which is deliberately about
    // archives too — being on the same subject must not be enough to match.
    const others = [
      "772 mod(s) could not be checked against their archive (archive missing from disk, or unreadable).",
      '1 archive(s) could not be re-downloaded (e.g. "High_Poly_Head": Nexus returned no download id.)',
      "435 mod rule(s) reference 265 mod(s) that are not in this collection.",
      "25 mod(s) have 2623 staged file(s) that differ from their archives.",
    ];
    for (const line of others) {
      expect(isMissingArchiveWarning(line), `wrongly matched: ${line}`).toBe(
        false,
      );
    }
  });

  it("replaces rather than doubles when a recovery shrinks the list", () => {
    // The exact regression, in the shape the curator hit it: 771 Nexus mods
    // and 1 external, re-downloaded down to 1 and 1.
    const before = describeMissingArchives([
      ...Array.from({ length: 771 }, (_, i) => nexus(`n${i}`)),
      external("x"),
    ]);
    expect(before).toHaveLength(2);

    const after = [
      ...before.filter((w) => !isMissingArchiveWarning(w)),
      ...describeMissingArchives([nexus("n0"), external("x")]),
    ];

    expect(after).toHaveLength(2);
    expect(after.join("\n")).toContain("1 Nexus mod cannot be packaged");
    expect(after.join("\n")).not.toContain("771");
  });
});

describe("the recovery still routes through the shared matcher", () => {
  // A unit test cannot catch a caller that stops calling. The bug was one
  // filter drifting away from one producer, so the guard has to be that the
  // filter is not re-hand-rolled — same shape as locatePackage.test.ts.
  const file = join(__dirname, "buildSession.ts");
  const text = readFileSync(file, "utf8");

  it("finds the file it claims to check", () => {
    expect(text).toContain("scopeWarnings");
  });

  it("filters with the predicate, not a copied phrase", () => {
    expect(text).toContain("isMissingArchiveWarning");
    // The literal that was wrong, and any attempt to describe the sentence
    // in-place again rather than asking the module that produces it.
    expect(text).not.toContain("download cache\"");
  });
});
