/**
 * `fileOverrides` is gone from the format.
 *
 * It recorded the deployment winner of every CONTESTED file — 17,161 entries
 * on a real 1753-mod Skyrim collection — and nothing on the install side ever
 * read one. The question was whether it was a gap to close or weight to shed,
 * and it was settled by measurement rather than taste.
 *
 * ─── WHAT WAS MEASURED ─────────────────────────────────────────────────
 * The rule direction was derived from the data instead of assumed: of 16,675
 * two-provider contests, "source before reference => reference wins" matched
 * the recorded winner 16,675 times and the opposite reading 0. With that
 * settled, applied to every contested file:
 *
 *     rules reproduce the recorded winner : 17,159
 *     rules imply a DIFFERENT winner      :      0
 *     no rule covers some pair            :      2
 *
 * The two are `Readme.txt` and `FOMod/info.xml` — files the game never loads.
 * So the field carried nothing the rules do not already determine, and the
 * installer applies the rules.
 *
 * ─── AND THE PER-MOD ONE WAS EMPTY ─────────────────────────────────────
 * `ModInstallState.fileOverrides` mirrored Vortex's manual per-file winner
 * picker. On the real collection: 0 mods, 0 paths. Nobody had ever used it.
 *
 * `AuditorMod.fileOverrides` STAYS — `compareSnapshots` diffs it when telling
 * a curator what changed between two profiles, which is a different job from
 * shipping it to a stranger.
 *
 * No backward-compatibility tests here, by decision: the curator rebuilds
 * their packages rather than carrying old ones forward. The parser ignores an
 * unrecognised key anyway, so an older .ehcoll still loads — that is a
 * property of how it parses, not a promise being kept.
 */
import { describe, expect, it } from "vitest";

import { parseManifest } from "./parseManifest";
import type { EhcollManifest } from "../../types/ehcoll";

/** A minimal manifest of the shape a current build emits. */
const base = (): Record<string, unknown> => ({
  schemaVersion: 2,
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

/** A minimal mod entry the validator accepts. */
const modEntry = (): Record<string, unknown> => ({
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
});

describe("the format no longer carries fileOverrides", () => {
  it("parses a current manifest that omits it entirely", () => {
    expect(() => parseManifest(JSON.stringify(base()))).not.toThrow();
  });

  it("drops the PER-MOD one too, and no longer validates it", () => {
    // The removal stopped at the top level. `validateInstallState` went on
    // parsing `state.fileOverrides`, checking its shape, and spreading it onto
    // a `ModInstallState` that no longer declares the field — TypeScript does
    // not apply excess-property checking to a spread, so nothing objected.
    // Written as a plain key, tsc rejects it: TS2353.
    //
    // Two consequences it had: the field came back to life at runtime on any
    // package carrying it, invisible to `manifestFieldFates`; and a malformed
    // value pushed a PARSE ERROR, so a manifest could be rejected over a field
    // the format does not have.
    const m = base();
    (m.mods as unknown[]).push({
      ...modEntry(),
      state: {
        enabled: true,
        installOrder: 0,
        deploymentPriority: 0,
        fileOverrides: ["Data/whatever.esp"],
      },
    });
    const { manifest } = parseManifest(JSON.stringify(m));
    const state = manifest.mods[0]!.state as { fileOverrides?: unknown };
    expect(state.fileOverrides).toBeUndefined();
  });

  it("does not reject a manifest over a malformed dead field", () => {
    const m = base();
    (m.mods as unknown[]).push({
      ...modEntry(),
      state: {
        enabled: true,
        installOrder: 0,
        deploymentPriority: 0,
        fileOverrides: "not-an-array",
      },
    });
    expect(() => parseManifest(JSON.stringify(m))).not.toThrow();
  });

  it("does not surface it on the parsed manifest", () => {
    const { manifest } = parseManifest(JSON.stringify(base()));
    expect(
      (manifest as EhcollManifest & { fileOverrides?: unknown }).fileOverrides,
    ).toBeUndefined();
  });
});
