/**
 * What ships as a bundle is exactly what this build packed from staging
 * folders. The cases worth pinning are the two that used to fall through to an
 * archive: a mod whose packing failed, and a flagged mod that was never packed.
 * Both are refused by name, with the reason — there is no archive to fall back
 * to, and a package with one inside is quarantined by Nexus.
 */
import { describe, expect, it } from "vitest";

import type { MeasuredBundle } from "./bundleFromStaging";
import { resolveBundles, type MeasuredBundles } from "./resolveBundles";

const SHA = "a".repeat(64);

const pool = (gameId: string, ids: readonly string[]): never =>
  ({ persistent: { mods: { [gameId]: Object.fromEntries(ids.map((id) => [id, {}])) } } }) as never;

/** A hand-made mod: no Nexus ids, so bundling it needs no "ship as external" first. */
const handMade = (id: string, name = id): never => ({ id, name, archiveSha256: SHA }) as never;

const flagged = (...ids: string[]): never =>
  ({ externalMods: Object.fromEntries(ids.map((id) => [id, { name: id, bundled: true }])) }) as never;

const bundle = (modId: string): MeasuredBundle => ({
  modId,
  modName: modId,
  rootDir: `C:/staging/${modId}`,
  sha256: SHA,
  bytes: 10,
  files: 2,
});

const packed = (over: Partial<MeasuredBundles> = {}): MeasuredBundles => ({
  bundles: [],
  failures: new Map(),
  ...over,
});

describe("resolveBundles", () => {
  it("ships a packed mod as its staging folder, under the identity it was packed with", () => {
    const out = resolveBundles(
      pool("skyrimse", ["m1"]),
      "skyrimse",
      flagged("m1"),
      [handMade("m1", "Settings")],
      packed({ bundles: [bundle("m1")] }),
    );
    expect(out.errors).toEqual([]);
    expect(out.bundles).toEqual([{ rootDir: "C:/staging/m1", sha256: SHA, modName: "Settings" }]);
  });

  it("refuses a mod whose packing failed, and says why", () => {
    const out = resolveBundles(
      pool("skyrimse", ["m1"]),
      "skyrimse",
      flagged("m1"),
      [handMade("m1", "Settings")],
      packed({
        failures: new Map([
          [
            "m1",
            {
              modId: "m1",
              modName: "Settings",
              reason: "Vortex records no staging folder for it, so there are no files to pack",
            },
          ],
        ]),
      }),
    );
    expect(out.bundles).toEqual([]);
    expect(out.errors).toHaveLength(1);
    expect(out.errors[0]).toMatch(
      /"Settings" \(id="m1"\) is flagged for bundling, but Vortex records no staging folder/,
    );
    expect(out.errors[0]).toMatch(/never its archive/);
  });

  it("refuses a flagged mod that was never packed, rather than shipping anything else for it", () => {
    const out = resolveBundles(
      pool("skyrimse", ["m1"]),
      "skyrimse",
      flagged("m1"),
      [handMade("m1")],
      packed(),
    );
    expect(out.bundles).toEqual([]);
    expect(out.errors[0]).toMatch(/its files were not packed in this build/);
  });

  it("ships nothing for a packed mod the config no longer flags", () => {
    // A verdict changed away from bundling mid-build leaves a measurement
    // behind; it must not put the mod's files in the package.
    const out = resolveBundles(
      pool("skyrimse", ["m1"]),
      "skyrimse",
      { externalMods: { m1: { bundled: false } } } as never,
      [handMade("m1")],
      packed({ bundles: [bundle("m1")] }),
    );
    expect(out).toEqual({ bundles: [], errors: [], warnings: [], droppedModIds: [] });
  });

  it("leaves out a bundled mod that is switched off, keeps its answer, and builds on", () => {
    // Ivy AE, 2026-09-27: the OG-only settings mod and UFO4P were switched off
    // on purpose and refused the build 45 minutes in.
    const out = resolveBundles(
      pool("fallout4", ["Ivy'sPantiesSettings", "kept"]),
      "fallout4",
      flagged("Ivy'sPantiesSettings", "kept"),
      [handMade("kept")],
      packed({ bundles: [bundle("kept")] }),
    );
    expect(out.errors).toEqual([]);
    expect(out.bundles.map((b) => b.rootDir)).toEqual(["C:/staging/kept"]);
    expect(out.droppedModIds).toEqual([]);
    expect(out.warnings).toHaveLength(1);
    expect(out.warnings[0]).toMatch(/"Ivy'sPantiesSettings" is marked "bundle" but is switched off/);
  });

  it("drops an answer whose mod is gone from Vortex, packed or not", () => {
    const out = resolveBundles(pool("skyrimse", []), "skyrimse", flagged("gone"), [], packed());
    expect(out.errors).toEqual([]);
    expect(out.bundles).toEqual([]);
    expect(out.droppedModIds).toEqual(["gone"]);
  });
});
