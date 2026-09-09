/**
 * There is ONE bundle-resolution implementation, and both build paths call it.
 *
 * ─── WHAT THIS TEST USED TO BE ──────────────────────────────────────────────
 * A regex over the two build files asserting that each of their private
 * `resolveBundledArchives` loops asked `mayBundle` rather than a bare
 * `isNexusMod`. It was written because both copies had stopped asking: the
 * `treatAsExternal` flag was taught to the identity branch, both bundling
 * gates kept their own Nexus rejection, and the build failed with "Only
 * external (non-Nexus) mods can be bundled" about ten mods the curator had
 * just declared external.
 *
 * It was one of SIX files in this repo whose entire subject was "did the two
 * build paths diverge again", each named after a rule that diverged once
 * already. That approach does not hold, and it was proven not to: the
 * missing-masters gate landed on the build page only and the legacy action
 * shipped unchecked packages, because a regex over source text can only police
 * the rules somebody remembered to enumerate — and nobody enumerated that one.
 *
 * The loop now lives in `core/manifest/resolveBundledArchives.ts` and both
 * doors call it, so `mayBundle` has exactly one caller and cannot be bypassed
 * by one path. What is worth guarding is no longer the rule inside the loop —
 * the unit tests own that — but the thing that made the rule breakable: a
 * SECOND copy of the loop appearing.
 *
 * A source-text test should name the abstraction whose absence it compensates
 * for, so it becomes deletable evidence rather than permanent infrastructure.
 * This one names its own: it exists until someone writes a third build path.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { mayBundle } from "./shipsAsExternal";
import { resolveBundledArchives } from "./resolveBundledArchives";

const ROOT = join(__dirname, "..", "..");

/**
 * Every path that can produce an `.ehcoll`.
 *
 * There is ONE now. The legacy toolbar action was the second, and deleting it
 * is what this file was really asking for: a regex over source text can only
 * police the rules somebody remembered to enumerate, and by the time it went
 * the action was missing five gates nobody had enumerated here.
 *
 * The list stays a list on purpose. If a second build entry point is ever
 * added, adding it here is how it inherits every assertion below — and the
 * "no second copy of the resolver" check keeps its meaning either way, since
 * a private copy inside the one remaining path is still a private copy.
 */
const BUILD_PATHS = [join(ROOT, "ui", "pages", "build", "engine.ts")];

const SHARED = join(ROOT, "core", "manifest", "resolveBundledArchives.ts");

describe("bundle resolution has one home", () => {
  const sources = BUILD_PATHS.map((f) => ({
    file: f,
    text: readFileSync(f, "utf8"),
  }));

  it("finds the files it claims to check", () => {
    // Guards every assertion below from passing because a path went stale — an
    // empty offender list would then look exactly like success.
    for (const s of sources) {
      expect(s.text.length).toBeGreaterThan(0);
      expect(s.text).toContain("resolveBundledArchives");
    }
    expect(readFileSync(SHARED, "utf8")).toContain("entry.bundled !== true");
  });

  it("keeps the resolution loop out of both build paths", () => {
    /**
     * `entry.bundled !== true` is the first line of the loop body. Its presence
     * in a build path means a private copy has grown back, which is how the
     * two diverged twice — once on the `mayBundle` rule and once on the error
     * text a curator actually reads.
     */
    const offenders = sources
      .filter(({ text }) => text.includes("entry.bundled !== true"))
      .map(({ file }) => `${file}: has its own bundle-resolution loop again`);
    expect(offenders).toEqual([]);
  });

  it("has every build path calling the shared one", () => {
    const offenders = sources
      .filter(({ text }) => !text.includes("resolveBundledArchives("))
      .map(({ file }) => `${file}: does not call resolveBundledArchives`);
    expect(offenders).toEqual([]);
  });

  it("routes the Nexus decision through mayBundle, in that one place", () => {
    // The rule itself, asserted where it now lives rather than in two regexes.
    const shared = readFileSync(SHARED, "utf8");
    expect(shared).toContain("mayBundle(");
    // And not by a bare Nexus rejection, which is the shape that broke.
    expect(shared).not.toMatch(/if\s*\(\s*isNexusSourced\([a-zA-Z.]+\)\s*\)\s*\{/);
  });

  it("actually rejects a Nexus mod that was not declared external", () => {
    /**
     * The behavioural half. Every assertion above is about source text, and
     * source text can be arranged to satisfy them while the function does the
     * wrong thing — so the function is called for real.
     */
    const mod = {
      id: "m1",
      name: "Some Nexus Mod",
      archiveSha256: "a".repeat(64),
      // The real shape `isNexusSourced` reads. Writing `attributes.source`
      // instead sailed straight past the gate and failed two checks later —
      // a fixture that tested the case that cannot fail (GP-4), caught here
      // only because this assertion is behavioural rather than textual.
      nexusModId: 5,
      nexusFileId: 9,
    };
    const result = resolveBundledArchives(
      { persistent: { mods: { skyrimse: { m1: {} } } } } as never,
      "skyrimse",
      { externalMods: { m1: { name: "Some Nexus Mod", bundled: true } } } as never,
      [mod] as never,
    );
    expect(result.bundledArchives).toEqual([]);
    expect(result.errors.join(" ")).toMatch(/not marked as an external dependency/);
    // And the predicate agrees, so the two cannot drift apart silently.
    expect(mayBundle(true, { bundled: true } as never)).toBe(false);
  });
});
