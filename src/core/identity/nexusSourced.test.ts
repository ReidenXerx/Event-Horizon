/**
 * One body for "is this from Nexus", and one name per question.
 *
 * There were three functions called `isNexusMod`. Two were byte-identical —
 * `engine.ts` exported one and `buildPackageAction.ts` kept a private copy it
 * could not import, because doing so would have meant an action reaching into
 * a UI page. Both fed bundling gates. Nothing kept them in step.
 *
 * The third, in `buildManifest.ts`, is a genuinely different question: it also
 * requires `source === "nexus"`. That one is NOT a duplicate and was not
 * merged — unifying them was tried and reclassified every mod carrying ids
 * without a source. It was renamed instead, because three predicates sharing
 * one name is the hazard; three predicates is not.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { isNexusSourced } from "./nexusSourced";

const ROOT = join(__dirname, "..", "..");

describe("the predicate itself", () => {
  it("wants both ids, as positive numbers", () => {
    expect(isNexusSourced({ nexusModId: 80968, nexusFileId: 341868 })).toBe(true);
    expect(isNexusSourced({ nexusModId: 80968, nexusFileId: undefined })).toBe(false);
    expect(isNexusSourced({ nexusModId: undefined, nexusFileId: 1 })).toBe(false);
    expect(isNexusSourced({ nexusModId: 0, nexusFileId: 1 })).toBe(false);
    expect(isNexusSourced({ nexusModId: -1, nexusFileId: 1 })).toBe(false);
  });

  it("rejects ids that arrived as strings", () => {
    // AuditorMod types these `number | string` because Vortex's attributes are
    // not normalised. Sites that test `!== undefined` or coerce with Number()
    // answer TRUE here and are the reason this must be asked, not re-derived.
    expect(isNexusSourced({ nexusModId: "80968", nexusFileId: "341868" })).toBe(
      false,
    );
  });
});

describe("nobody re-implements it", () => {
  const files = [
    "ui/pages/build/engine.ts",
    "core/manifest/buildManifest.ts",
  ];

  it("finds the files it claims to check", () => {
    for (const f of files) {
      expect(readFileSync(join(ROOT, f), "utf8").length).toBeGreaterThan(0);
    }
  });

  it("has no second copy of the loose predicate", () => {
    // The exact shape that was duplicated: a typeof/positive test on both ids.
    const offenders: string[] = [];
    for (const f of files) {
      const src = readFileSync(join(ROOT, f), "utf8");
      if (
        /typeof\s+mod\.nexusModId\s*===\s*"number"/.test(src) &&
        /mod\.nexusFileId\s*>\s*0/.test(src)
      ) {
        offenders.push(f);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("keeps buildManifest's stricter question under its own name", () => {
    const src = readFileSync(join(ROOT, "core/manifest/buildManifest.ts"), "utf8");
    // Still asks about provenance...
    expect(src).toContain('mod.source === "nexus"');
    // ...but no longer under a name shared with the loose predicate.
    expect(src).toContain("isNexusSourcedForManifest");
    expect(src).not.toMatch(/function isNexusMod\b/);
  });
});
