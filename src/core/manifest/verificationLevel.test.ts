/**
 * "fast" verification records a file list with sizes and reads nothing, so a
 * file with the right name and the right size but DIFFERENT BYTES verifies as
 * correct — the shape of failure that looks like success. It also withholds
 * the stagingSetHash that an archive-less external mod needs to be
 * identifiable at all, which makes buildManifest hard-block those mods and
 * tell the curator to rebuild thorough.
 *
 * So nothing new is built with it. But this file exists mostly for the OTHER
 * half of that sentence, which is much easier to get wrong:
 *
 *   Packages already in the wild recorded "fast" or "none". That is a FACT
 *   ABOUT THEM, not a setting to migrate. A tidy-up that removes "fast" from
 *   the parser's accepted values makes every one of those packages
 *   unopenable — the check pushes a hard error, so the collection does not
 *   degrade, it fails to load at all.
 *
 * At the time this was written an alpha tester was mid-install on a package
 * built with "fast".
 */
import { describe, expect, it } from "vitest";

import { parseManifest } from "./parseManifest";

const manifestWith = (level: string | undefined): string => {
  const pkg: Record<string, unknown> = {
    id: "11111111-2222-4333-8444-555555555555",
    name: "Test",
    version: "1.0.0",
    author: "someone",
    createdAt: "2026-01-01T00:00:00.000Z",
    strictMissingMods: false,
  };
  if (level !== undefined) pkg.verificationLevel = level;
  return JSON.stringify({
    schemaVersion: 1,
    package: pkg,
    game: { id: "fallout4", version: "1.10.163.0", versionPolicy: "exact" },
    vortex: { version: "1.9.0", deploymentMethod: "hardlink", requiredExtensions: [] },
    mods: [],
    rules: [],
    fileOverrides: [],
    plugins: { order: [], enabled: [] },
    loadOrder: [],
    iniTweaks: [],
    externalDependencies: [],
  });
};

describe("packages already in the wild must keep opening", () => {
  it('still reads a manifest that recorded "fast"', () => {
    // The one that matters. Removing "fast" from the parser is a one-line
    // "cleanup" that bricks every package built before this change.
    const { manifest } = parseManifest(manifestWith("fast"));
    expect(manifest.package.verificationLevel).toBe("fast");
  });

  it('still reads a manifest that recorded "none"', () => {
    const { manifest } = parseManifest(manifestWith("none"));
    expect(manifest.package.verificationLevel).toBe("none");
  });

  it('still reads "thorough"', () => {
    const { manifest } = parseManifest(manifestWith("thorough"));
    expect(manifest.package.verificationLevel).toBe("thorough");
  });

  it("still back-fills a manifest that recorded nothing", () => {
    // Pre-dates the field entirely. Absence means "no evidence was captured",
    // which is "none" — NOT the new default, because back-filling "thorough"
    // would claim per-file hashes that were never taken.
    const { manifest } = parseManifest(manifestWith(undefined));
    expect(manifest.package.verificationLevel).toBe("none");
  });

  it("still rejects a value that is not one of the three", () => {
    // The permissiveness above is for HISTORY, not for anything goes.
    expect(() => parseManifest(manifestWith("paranoid"))).toThrow(
      /verificationLevel/,
    );
  });
});

describe("nothing new is built with the weak level", () => {
  // Source assertions: the build paths need a live Vortex. Both write sites
  // must agree with each other, because a manifest recording a level its
  // capture did not perform is a manifest lying about its own evidence.
  const read = async (rel: string): Promise<string> => {
    const fs = await import("fs");
    const path = await import("path");
    return fs.readFileSync(path.join(__dirname, rel), "utf8");
  };

  it("buildManifest defaults to thorough, not fast", async () => {
    const src = await read("buildManifest.ts");
    expect(src).toMatch(/verificationLevel:\s*pkg\.verificationLevel \?\? "thorough"/);
  });

  /**
   * The toolbar-action case is gone with the action. It was the second door
   * into the build, and every rule added since — this one included — had to be
   * ported into it by hand; twice nobody did, and by the time it was deleted
   * it was missing five gates the page has. One door now.
   *
   * The page's own assertion is below and is unchanged.
   */

  it("the build UI does not offer the weak level as a choice", async () => {
    const src = await read("../../ui/pages/build/buildSession.ts");
    const code = src
      .split("\n")
      .filter((l) => !/^\s*(\*|\/\/)/.test(l))
      .join("\n");
    expect(code).toMatch(/verificationLevel:\s*"thorough"/);
    expect(code).not.toMatch(/verificationLevel:\s*"fast"/);
  });
});
