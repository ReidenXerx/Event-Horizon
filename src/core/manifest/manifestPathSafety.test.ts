/**
 * Two defects the reader had, both of the same family: what the writer emits
 * and what the reader accepts had drifted apart, and nothing compared them.
 *
 *  1. A staging path was taken verbatim from a stranger's file and joined onto
 *     a folder we own. `../../../../plugins/evil/index.js` resolved into
 *     Vortex's own extension directory, which Vortex loads on next start.
 *  2. `state.postProcessed` — the curator's "declare" answer — was written by
 *     the build and silently dropped by the parser, so every declared mod got
 *     the strict missing-file rule it had explicitly opted out of, ordered a
 *     reinstall that provably could not produce those files, and did it again
 *     on every machine.
 *
 * The existing safety net could not catch #2: `manifestFieldFates.test.ts`
 * checks that the named CONSUMER touches a field, never that the PARSER
 * carries it. So this file asserts the round trip itself.
 */
import { describe, expect, it } from "vitest";

import { parseManifest } from "./parseManifest";

const base = (): Record<string, unknown> => ({
  schemaVersion: 1,
  package: {
    id: "00000000-0000-4000-8000-000000000000",
    name: "t",
    version: "1.0.0",
    author: "a",
    createdAt: "2026-01-01T00:00:00.000Z",
    strictMissingMods: false,
  },
  game: { id: "skyrimse", version: "1.6.1179.0", versionPolicy: "exact" },
  vortex: {
    version: "2.6.3",
    deploymentMethod: "hardlink",
    requiredExtensions: [],
  },
  mods: [],
  rules: [],
  plugins: { order: [] },
  loadOrder: [],
  userlist: { plugins: [], groups: [] },
  iniTweaks: [],
  gameIni: { files: [] },
  externalDependencies: [],
});

const withMod = (state: Record<string, unknown>): string => {
  const m = base();
  (m.mods as unknown[]).push({
    name: "t",
    compareKey: "nexus:1:2",
    source: {
      kind: "nexus",
      gameDomain: "skyrimspecialedition",
      modId: 1,
      fileId: 2,
      archiveName: "t.zip",
      sha256: "a".repeat(64),
    },
    install: { fomodSelections: [] },
    state,
  });
  return JSON.stringify(m);
};

const BASE_STATE = { enabled: true, installOrder: 0, deploymentPriority: 0 };

describe("a staging path from a stranger's package", () => {
  it("REJECTS one that escapes the mod's folder", () => {
    /**
     * The live exploit. `applyMirrorPlan` does
     * `path.join(stagingRoot, ...path.split("/"))` and writes the blob the
     * package ships alongside it. Four `../` reach Vortex's plugin directory.
     *
     * The sha256 on the blob is no defence — whoever wrote the path also
     * wrote the bytes and the hash they must match.
     *
     * A rejected manifest THROWS. This is not a package with a warning on it.
     */
    expect(() =>
      parseManifest(
        withMod({
          ...BASE_STATE,
          stagingFiles: [
            {
              path: "../../../../plugins/evil/index.js",
              size: 10,
              sha256: "b".repeat(64),
            },
          ],
        }),
      ),
    ).toThrow(/relative path inside the mod/);
  });

  it("REJECTS the backslash spelling, which Windows splits the same way", () => {
    expect(() =>
      parseManifest(
        withMod({
          ...BASE_STATE,
          stagingFiles: [
            { path: "..\\..\\evil.js", size: 10, sha256: "b".repeat(64) },
          ],
        }),
      ),
    ).toThrow(/relative path inside the mod/);
  });

  it("REJECTS an absolute path", () => {
    expect(() =>
      parseManifest(
        withMod({
          ...BASE_STATE,
          stagingFiles: [
            { path: "/etc/cron.d/x", size: 10, sha256: "b".repeat(64) },
          ],
        }),
      ),
    ).toThrow(/relative path inside the mod/);
  });

  it("still ACCEPTS the ordinary paths a real capture produces", () => {
    // A containment check that rejects real content is a check nobody ships.
    // Every path here is from a real 354,819-file capture.
    const { manifest } = parseManifest(
      withMod({
        ...BASE_STATE,
        stagingFiles: [
          { path: "SKSE/Plugins/x.dll", size: 10, sha256: "b".repeat(64) },
          {
            path: "meshes/actors/character/character assets/femalebody_1.nif",
            size: 11,
            sha256: "c".repeat(64),
          },
          {
            path: "Nemesis_Engine/Lib/test/capath/0e4015b9.0",
            size: 12,
            sha256: "d".repeat(64),
          },
        ],
      }),
    );
    expect(manifest.mods[0]?.state.stagingFiles).toHaveLength(3);
  });
});

describe("state.postProcessed survives the round trip", () => {
  it("is carried through the parser, not dropped", () => {
    // The bug: the build wrote it, the package shipped it, the parser threw
    // it away, and `judgeReinstall` then applied the strict rule to the one
    // mod that had opted out of it.
    const { manifest } = parseManifest(
      withMod({ ...BASE_STATE, postProcessed: true }),
    );
    expect(manifest.mods[0]?.state.postProcessed).toBe(true);
  });

  it("stays absent when the build did not write it", () => {
    // Absent must not become `false`: the judge distinguishes "the curator
    // declared this mod" from "the curator said nothing".
    const { manifest } = parseManifest(withMod({ ...BASE_STATE }));
    expect(manifest.mods[0]?.state.postProcessed).toBeUndefined();
  });

  it("rejects a non-boolean rather than coercing it", () => {
    expect(() =>
      parseManifest(withMod({ ...BASE_STATE, postProcessed: "yes" })),
    ).toThrow(/postProcessed must be a boolean/);
  });
});
