/**
 * The curator's "ship this as external" override.
 *
 * It decides a mod's IDENTITY in the manifest and whether its archive may be
 * bundled — and the bug it exists to prevent is not a wrong answer but three
 * DIFFERENT answers: the flag was honoured where identity is chosen and
 * ignored by two separate bundling gates, so marking ten dead mods external
 * fixed the manifest and failed the build.
 */
import { describe, expect, it } from "vitest";

import { mayBundle, shipsAsExternal } from "./shipsAsExternal";

describe("shipsAsExternal", () => {
  it("keeps a Nexus mod on its Nexus identity", () => {
    expect(shipsAsExternal(true, undefined)).toBe(false);
    expect(shipsAsExternal(true, {})).toBe(false);
  });

  it("still treats a non-Nexus mod as external", () => {
    expect(shipsAsExternal(false, undefined)).toBe(true);
  });

  it("overrides a valid Nexus identity when the curator says so", () => {
    // The whole feature. UFO4P 2.1.5 has perfectly good ids and a file that no
    // longer exists — the ids are true and useless.
    expect(shipsAsExternal(true, { treatAsExternal: true })).toBe(true);
  });

  it("requires an explicit true, not merely a present override", () => {
    // Every external mod has a config entry. If a present entry flipped the
    // branch, the first curator to type an instruction against a Nexus mod
    // would silently change its identity.
    expect(shipsAsExternal(true, { treatAsExternal: false })).toBe(false);
    expect(shipsAsExternal(true, {} as never)).toBe(false);
  });
});

describe("mayBundle", () => {
  // The gate that actually failed, twice over: engine.resolveBundles
  // and buildPackageAction each had their own copy, and neither had heard of
  // the flag. The build died reporting "Only external (non-Nexus) mods can be
  // bundled" about mods the curator had just declared external.
  it("refuses to bundle an ordinary Nexus mod", () => {
    // Still correct, and the reason the gate exists: the user's own API key
    // fetches it, so bundling is pointless weight in the package.
    expect(mayBundle(true, undefined)).toBe(false);
  });

  it("allows bundling once the curator marks it external", () => {
    // Which is the only way anyone else gets a mod whose file Nexus deleted.
    expect(mayBundle(true, { treatAsExternal: true })).toBe(true);
  });

  it("allows bundling a mod that was external all along", () => {
    expect(mayBundle(false, undefined)).toBe(true);
  });

  it("answers identically to shipsAsExternal, by construction", () => {
    // They are the same question asked by different callers, and the bug was
    // precisely that they could disagree.
    for (const isNexus of [true, false]) {
      for (const o of [
        undefined,
        { treatAsExternal: true },
        { treatAsExternal: false },
      ]) {
        expect(mayBundle(isNexus, o)).toBe(shipsAsExternal(isNexus, o));
      }
    }
  });
});

describe("what this deliberately does NOT decide", () => {
  it("takes the caller's word for what counts as a Nexus mod", () => {
    // The first attempt at this fix shared one isNexusSourced across all three
    // callers. The suite rejected it inside a minute: buildManifest requires
    // `source === "nexus"` as well as the ids, while both bundling gates check
    // only that the ids are positive numbers. Unifying them reclassified every
    // mod carrying ids without a source — changing identities in the manifest
    // as a side effect of a bundling fix.
    //
    // So `isNexus` is a parameter. Same input, same answer, regardless of how
    // the caller decided.
    expect(shipsAsExternal(true, undefined)).toBe(false);
    expect(shipsAsExternal(false, undefined)).toBe(true);
  });
});
