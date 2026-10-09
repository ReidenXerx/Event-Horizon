/**
 * These cases come from the curator's real profile: 939 mods tracked, 37
 * disabled, 123 Nexus mods spread over 304 staging folders, and 7 identity
 * collisions in which exactly one copy was enabled.
 */
import { describe, expect, it } from "vitest";

import type { AuditorMod } from "../getModsListForProfile";
import {
  describeHashedCollisions,
  describeScope,
  findHashedIdentityCollisions,
  profileFingerprint,
  scopeCollectionMods,
} from "./collectionScope";

const mod = (over: Partial<AuditorMod> & { id: string }): AuditorMod =>
  ({
    name: over.id,
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

describe("scopeCollectionMods", () => {
  it("keeps only enabled mods — a profile IS its enabled set", () => {
    const scope = scopeCollectionMods([
      mod({ id: "a" }),
      mod({ id: "b", enabled: false }),
      mod({ id: "c" }),
    ]);
    expect(scope.included.map((m) => m.id)).toEqual(["a", "c"]);
    expect(scope.excludedDisabled.map((m) => m.id)).toEqual(["b"]);
  });

  it("ships a disabled mod the curator marked optional, and only that one", () => {
    // Meridia - Handheld Settings (2026-10-09): off in the curator's own game.
    const scope = scopeCollectionMods(
      [mod({ id: "handheld", enabled: false }), mod({ id: "old", enabled: false }), mod({ id: "a" })],
      (m) => m.id === "handheld",
    );
    expect(scope.included.map((m) => m.id)).toEqual(["handheld", "a"]);
    expect(scope.includedDisabledOptional.map((m) => m.id)).toEqual(["handheld"]);
    expect(scope.excludedDisabled.map((m) => m.id)).toEqual(["old"]);
  });

  it("resolves an identity collision by scoping, with no tie-break needed", () => {
    // The real shape of all 7 build-blocking collisions: the same Nexus file
    // staged twice, the superseded copy switched off.
    const scope = scopeCollectionMods([
      mod({ id: "gne", nexusModId: 37961, nexusFileId: 363058, enabled: false }),
      mod({ id: "gne.1", nexusModId: 37961, nexusFileId: 363058 }),
    ]);
    expect(scope.included.map((m) => m.id)).toEqual(["gne.1"]);
    expect(scope.collidingIdentities).toEqual([]);
    expect(describeScope(scope)).toEqual([]);
  });

  it("REPORTS a collision that scoping cannot resolve", () => {
    // Both enabled: the manifest will reject this, so say so before the build
    // spends an hour getting there.
    const scope = scopeCollectionMods([
      mod({ id: "x", name: "Dupe", nexusModId: 1, nexusFileId: 2 }),
      mod({ id: "y", name: "Dupe", nexusModId: 1, nexusFileId: 2 }),
    ]);
    expect(scope.collidingIdentities).toHaveLength(1);
    expect(scope.collidingIdentities[0]!.key).toBe("nexus:1:2");
    expect(describeScope(scope)[0]).toMatch(/cannot contain the same mod twice/);
  });

  it("reports the SAME mod installed twice and left enabled", () => {
    const scope = scopeCollectionMods([
      mod({
        id: "vrp1", name: "VRP Shared", nexusModId: 77615, nexusFileId: 1,
        version: "1.1", installationPath: "VRP Shared-77615-1-1-1746371099",
      }),
      mod({
        id: "vrp2", name: "VRP Shared", nexusModId: 77615, nexusFileId: 2,
        version: "1.2", installationPath: "VRP Shared-77615-1-2-1756431742",
      }),
    ]);
    expect(scope.multipleInstalls).toHaveLength(1);
    expect(describeScope(scope)[0]).toMatch(/is installed 2 times/);
    expect(describeScope(scope)[0]).toMatch(/shipped as-is/);
  });

  it("does NOT flag different files that share one Nexus mod page", () => {
    // The bug this replaces: grouping by page id flagged 74 groups on the real
    // profile and every one was a false positive. A page hosts a base plus its
    // addons, four different guns, five icon packs — all meant to coexist.
    const scope = scopeCollectionMods([
      mod({
        id: "a", name: "We Are Unique - Base", nexusModId: 100245, nexusFileId: 1,
        version: "N1.0.5", installationPath: "We Are Unique - Base - RobCo-100245-1-0-1-1768649343",
      }),
      mod({
        id: "b", name: "We Are Unique - Addon", nexusModId: 100245, nexusFileId: 2,
        version: "U1.1.0", installationPath: "We Are Unique - Addon - RobCo-100245-1-0-1-1768649409",
      }),
    ]);
    expect(scope.multipleInstalls).toEqual([]);
    expect(describeScope(scope)).toEqual([]);
  });

  it("sees through Vortex's `.1` re-install suffix", () => {
    const scope = scopeCollectionMods([
      mod({
        id: "r1", name: "RDIS TagSets All in One", nexusModId: 102329, nexusFileId: 1,
        version: "1.0.2", installationPath: "RDIS TagSets All in One-102329-1-0-2-1772977728",
      }),
      mod({
        id: "r2", name: "RDIS TagSets All in One", nexusModId: 102329, nexusFileId: 2,
        version: "1.0.2", installationPath: "RDIS TagSets All in One-102329-1-0-2-1772977728.1",
      }),
    ]);
    expect(scope.multipleInstalls).toHaveLength(1);
  });

  it("does not flag one mod that simply has several files of the same version", () => {
    const scope = scopeCollectionMods([
      mod({ id: "p1", nexusModId: 5, nexusFileId: 1, version: "1.0" }),
      mod({ id: "p2", nexusModId: 5, nexusFileId: 2, version: "1.0" }),
    ]);
    expect(scope.multipleInstalls).toEqual([]);
  });

  it("leaves external mods alone — they carry no Nexus identity to collide", () => {
    const scope = scopeCollectionMods([
      mod({ id: "ext1", name: "Loose Files" }),
      mod({ id: "ext2", name: "Loose Files" }),
    ]);
    expect(scope.included).toHaveLength(2);
    expect(scope.collidingIdentities).toEqual([]);
    expect(scope.multipleInstalls).toEqual([]);
  });

  it("returns an empty scope rather than throwing when nothing is enabled", () => {
    const scope = scopeCollectionMods([mod({ id: "a", enabled: false })]);
    expect(scope.included).toEqual([]);
    expect(scope.excludedDisabled).toHaveLength(1);
  });
});

describe("findHashedIdentityCollisions", () => {
  it("catches two EXTERNAL mods installed from byte-identical archives", () => {
    // Real case: separate downloads, different archiveIds, one sha256. Only a
    // hash reveals it, so scopeCollectionMods (pre-hash) cannot.
    const groups = findHashedIdentityCollisions([
      mod({ id: "s", name: "Ivy'sPantiesSettings", archiveSha256: "fcd9eca2" }),
      mod({ id: "d", name: "Ivy'sPantiesSettings-SteamDeck", archiveSha256: "fcd9eca2" }),
    ]);
    expect(groups).toHaveLength(1);
    expect(describeHashedCollisions(groups)[0]).toMatch(/same archive/i);
    expect(describeHashedCollisions(groups)[0]).toMatch(/cannot be packaged/);
  });

  it("does not collide two external mods with different archives", () => {
    expect(
      findHashedIdentityCollisions([
        mod({ id: "a", archiveSha256: "aaa" }),
        mod({ id: "b", archiveSha256: "bbb" }),
      ]),
    ).toEqual([]);
  });

  it("ignores externals with no hash yet — those are buildManifest's to judge", () => {
    // Identity comes from stagingSetHash there, which does not exist at this
    // point in the pipeline.
    expect(
      findHashedIdentityCollisions([mod({ id: "a" }), mod({ id: "b" })]),
    ).toEqual([]);
  });
});

describe("Vortex collections in the profile", () => {
  it("leaves a collection mod out, enabled or not", () => {
    // It is a mod only by Vortex's bookkeeping. Its staging folder is other
    // mods' payloads plus its own metadata.
    const scope = scopeCollectionMods([
      mod({ id: "real-mod" }),
      mod({ id: "the-collection", modType: "collection" }),
    ]);
    expect(scope.included.map((m) => m.id)).toEqual(["real-mod"]);
    expect(scope.excludedCollections.map((m) => m.id)).toEqual(["the-collection"]);
    // Not miscounted as "disabled" — the curator did not disable it.
    expect(scope.excludedDisabled).toEqual([]);
  });

  it("does not let a disabled collection land in the disabled bucket either", () => {
    const scope = scopeCollectionMods([
      mod({ id: "the-collection", modType: "collection", enabled: false }),
    ]);
    expect(scope.excludedCollections).toHaveLength(1);
    expect(scope.excludedDisabled).toEqual([]);
  });

  it("tells the curator what was left out and that the mods still ship", () => {
    const scope = scopeCollectionMods([
      mod({ id: "c", name: "Liberty Wasteland Redux", modType: "collection" }),
    ]);
    const lines = describeScope(scope).join(" ");
    expect(lines).toMatch(/Liberty Wasteland Redux/);
    expect(lines).toMatch(/shipped them twice/);
    expect(lines).toMatch(/in their own right/);
  });
});

describe("profileFingerprint", () => {
  it("is stable across ordering — the same mods are the same collection", () => {
    const a = profileFingerprint([mod({ id: "x" }), mod({ id: "y" })]);
    const b = profileFingerprint([mod({ id: "y" }), mod({ id: "x" })]);
    expect(a).toBe(b);
  });

  it("changes when a mod is enabled", () => {
    const before = profileFingerprint([mod({ id: "x" })]);
    const after = profileFingerprint([mod({ id: "x" }), mod({ id: "y" })]);
    expect(after).not.toBe(before);
  });

  it("changes when a mod is disabled", () => {
    const before = profileFingerprint([mod({ id: "x" }), mod({ id: "y" })]);
    const after = profileFingerprint([mod({ id: "x" })]);
    expect(after).not.toBe(before);
  });

  it("cannot be fooled by ids that concatenate to the same string", () => {
    // "ab" + "c" and "a" + "bc" are the same bytes once joined naively, and
    // a collision here would show a curator "no mod changes" on a profile
    // that really did change.
    expect(profileFingerprint([mod({ id: "ab" }), mod({ id: "c" })])).not.toBe(
      profileFingerprint([mod({ id: "a" }), mod({ id: "bc" })]),
    );
  });

  it("MOVES when a mod is updated in place — same id, new version", () => {
    // The field failure: the curator updated four mods and the fingerprint did
    // not budge. Vortex keeps the mod entry and swaps version / file id /
    // staging folder underneath it, so hashing ids alone is blind to exactly
    // the event an update is usually FOR.
    const before = profileFingerprint([mod({ id: "karma", version: "1.0.0" })]);
    const after = profileFingerprint([mod({ id: "karma", version: "1.1.0" })]);
    expect(after).not.toBe(before);
  });

  it("moves when the Nexus file changes but the version string does not", () => {
    // Re-uploads happen, and they are a different download.
    const before = profileFingerprint([mod({ id: "k", version: "1.0", nexusFileId: 111 })]);
    const after = profileFingerprint([mod({ id: "k", version: "1.0", nexusFileId: 222 })]);
    expect(after).not.toBe(before);
  });

  it("moves when the staging folder is replaced", () => {
    const before = profileFingerprint([mod({ id: "k", installationPath: "k-old" })]);
    const after = profileFingerprint([mod({ id: "k", installationPath: "k-new" })]);
    expect(after).not.toBe(before);
  });

  it("does NOT move when nothing about the mods changed", () => {
    const one = [mod({ id: "a", version: "1", installationPath: "a" })];
    const two = [mod({ id: "a", version: "1", installationPath: "a" })];
    expect(profileFingerprint(one)).toBe(profileFingerprint(two));
  });

  it("cannot be fooled by fields that concatenate the same way", () => {
    expect(profileFingerprint([mod({ id: "ab", version: "c" })])).not.toBe(
      profileFingerprint([mod({ id: "a", version: "bc" })]),
    );
  });

  it("is empty-safe", () => {
    expect(profileFingerprint([])).toHaveLength(64);
  });
});
