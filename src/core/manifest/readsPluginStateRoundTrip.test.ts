/**
 * `readsPluginState` survives the format, and is sourced onto the mod at all.
 *
 * ─── WHY BOTH HALVES ────────────────────────────────────────────────────────
 * This project has shipped a write-only manifest field five times —
 * `state.postProcessed`, `game.store`, `gameIniApplication`,
 * `fomodReplayMode`, and `plugins.order[].light`, which was written into every
 * package for the whole life of the feature and dropped by the parser on read.
 * The registry meant to prevent that could not see one level down, which is
 * why `MOD_INSTALL_SPEC_FATES` now exists alongside this test.
 *
 * A field that decides WHICH EPOCH a mod installs in has a second way to be
 * inert: it can round-trip perfectly and never be populated, because nothing
 * copies the self-check's finding onto the mod. So this checks the write, the
 * read, and the source.
 */
import { describe, expect, it } from "vitest";

import { parseManifest } from "./parseManifest";
import { MOD_INSTALL_SPEC_FATES } from "./manifestFieldFates";

/** A minimal manifest that parses, with one mod we can vary. */
const manifestWith = (install: Record<string, unknown>): string =>
  JSON.stringify({
    schemaVersion: 1,
    package: {
      id: "11111111-2222-4333-8444-555555555555",
      name: "Test Collection",
      version: "1.0.0",
      createdAt: "1970-01-01T00:00:00.000Z",
      verificationLevel: "thorough",
      author: "A Curator",
      strictMissingMods: false,
    },
    game: {
      id: "fallout4",
      version: "1.10.163.0",
      versionPolicy: "exact",
    },
    vortex: {
      version: "1.13.7",
      deploymentMethod: "hardlink",
      requiredExtensions: [],
    },
    iniTweaks: [],
    externalDependencies: [],
    mods: [
      {
        compareKey: "nexus:100:200",
        name: "A Mod",
        source: {
          kind: "nexus",
          modId: 100,
          fileId: 200,
          gameDomain: "fallout4",
          archiveName: "a-mod.7z",
          sha256: "a".repeat(64),
        },
        install,
        state: { enabled: true, installOrder: 0, deploymentPriority: 0 },
      },
    ],
    rules: [],
    plugins: { order: [] },
  });

const firstModInstall = (raw: string): Record<string, unknown> =>
  parseManifest(raw).manifest.mods[0]!.install as unknown as Record<
    string,
    unknown
  >;

describe("readsPluginState reaches the user side", () => {
  it("survives a real parse", () => {
    const install = firstModInstall(
      manifestWith({
        fomodSelections: [],
        readsPluginState: ["aaf.esm", "aaf.esp"],
      }),
    );
    expect(install.readsPluginState).toEqual(["aaf.esm", "aaf.esp"]);
  });

  it("is absent for a mod that names nothing", () => {
    // Presence is the signal. A field on every entry of a 950-mod manifest is
    // 950 lines saying nothing, and an empty array would still be truthy to a
    // careless reader.
    const install = firstModInstall(manifestWith({ fomodSelections: [] }));
    expect("readsPluginState" in install).toBe(false);
  });

  it("drops an entry that is not a plugin filename", () => {
    /**
     * It decides which epoch a mod installs in. A loose-file dependency is
     * satisfied by extraction rather than activation, so deferring a mod for
     * one would buy nothing — and a non-string would reach the installer's
     * comparison and quietly match nothing.
     */
    const install = firstModInstall(
      manifestWith({
        fomodSelections: [],
        readsPluginState: ["aaf.esm", "Scripts/foo.pex", 42, "", null],
      }),
    );
    expect(install.readsPluginState).toEqual(["aaf.esm"]);
  });

  it("drops the field entirely when nothing survives the filter", () => {
    const install = firstModInstall(
      manifestWith({
        fomodSelections: [],
        readsPluginState: ["Scripts/foo.pex"],
      }),
    );
    expect("readsPluginState" in install).toBe(false);
  });

  it("has a declared fate, which is what makes it non-optional to read it", () => {
    /**
     * `MOD_INSTALL_SPEC_FATES` is `Required<ModInstallSpec>`, so a field added
     * to the type without an entry here is a COMPILE error rather than a bug
     * report from a stranger. This table did not exist until this change —
     * `EhcollManifest`, `ModInstallState` and `EhcollPluginEntry` each had one
     * and the install spec did not, which is one of the two levels `light`
     * slipped through.
     */
    expect(MOD_INSTALL_SPEC_FATES.readsPluginState).toEqual({
      kind: "applied",
      by: "core/installer/runInstall.ts",
    });
  });
});
