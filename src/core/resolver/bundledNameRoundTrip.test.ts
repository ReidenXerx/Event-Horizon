/**
 * ──────────────────────────────────────────────────────────────────────
 * The property the bundled-name fix actually depends on.
 *
 * A bundled external mod is recognised on a resume only if the name Vortex
 * ends up giving it matches a name this matcher is looking for. The chain is:
 *
 *   curator mod name
 *     -> bundledArchiveFileName()   (sanitised, extension added)
 *     -> Vortex drops the extension -> the installed mod's name
 *     -> normalizeName()            -> compared against the manifest name
 *
 * The first test written for that fix asserted the SANITISING happened. That
 * is testing the case that cannot fail: it proves the mangling works, not
 * that the mangling is survivable. Every transform the sanitiser applies —
 * a colon, a pipe, a 120-char truncation — silently put the mod back into
 * `candidates: 0`, which is the exact bug the fix was written to close.
 *
 * This asserts the round trip instead, on names that actually break it.
 * ──────────────────────────────────────────────────────────────────────
 */
import { describe, expect, it } from "vitest";

import { bundledArchiveFileName } from "../installer/modInstall";
import { collectStagingSetHashTargetsForTest } from "./enrichStagingSetHashes";
import type { EhcollManifest } from "../../types/ehcoll";

/** Vortex's own derivation: the file name without its extension. */
function vortexModName(fileName: string): string {
  const lastDot = fileName.lastIndexOf(".");
  return lastDot <= 0 ? fileName : fileName.slice(0, lastDot);
}

function manifestWith(names: string[]): EhcollManifest {
  return {
    mods: names.map((name, i) => ({
      compareKey: `external:sha:${String(i).repeat(64).slice(0, 64)}`,
      name,
      source: {
        kind: "external",
        sha256: "a".repeat(64),
        stagingSetHash: "b".repeat(64),
        expectedFilename: `${name}.zip`,
        bundled: true,
      },
    })),
  } as unknown as EhcollManifest;
}

/**
 * Names that each broke the round trip. Every one is ordinary in a Skyrim or
 * Fallout load order — colons and pipes appear in real mod titles constantly.
 */
const HOSTILE = [
  "High Poly Head-80968",
  "Skyrim: Special Edition Patch",
  "A|B Compatibility",
  "Weapons/Armour Rebalance",
  "IDE WHITERUN-149724-1-1746902603.1",
  "Cool Mod.zip",
  "x".repeat(200),
  'Quote"Mod',
  "Trailing dot.",
];

describe("a bundled mod is recognisable after Vortex renames it", () => {
  it.each(HOSTILE)("survives the round trip: %s", (name) => {
    const targets = collectStagingSetHashTargetsForTest(manifestWith([name]));

    // What the mod will actually be called once installed.
    const installed = vortexModName(
      bundledArchiveFileName("bundled/deadbeef.zip", name),
    );

    // The matcher must be looking for exactly that.
    expect(
      targets.has(installed.trim().toLowerCase().replace(/\s+/g, " ")),
    ).toBe(true);
  });

  it("still matches a mod the user installed under the curator's raw name", () => {
    // The other half: a mod that was NOT installed from our bundle keeps its
    // original name, and must still be a candidate. Registering the sanitised
    // spelling must ADD to the target set, never replace it.
    const targets = collectStagingSetHashTargetsForTest(
      manifestWith(["Skyrim: Special Edition Patch"]),
    );
    expect(targets.has("skyrim: special edition patch")).toBe(true);
  });
});
