/**
 * `state.nativePlugins` survives the format.
 *
 * This project has shipped a write-only manifest field five times — each one
 * written into every package and silently dropped by this whitelist parser on
 * read (`postProcessed`, `game.store`, `gameIniApplication`,
 * `fomodReplayMode`, `plugins.order[].light`). The version soft block depends
 * on this field reaching the player; if it is dropped, every player on another
 * game version is told nothing, with no error anywhere.
 *
 * And the other direction matters as much: this field is ADVISORY, so it is
 * read leniently. A newer build's unfamiliar entry must be skipped, never
 * allowed to make the whole package unopenable on an older Event Horizon.
 */
import { describe, expect, it } from "vitest";

import { parseManifest } from "./parseManifest";

const manifestWith = (state: Record<string, unknown>): string =>
  JSON.stringify({
    schemaVersion: 2,
    package: {
      id: "11111111-2222-4333-8444-555555555555",
      name: "Test Collection",
      version: "1.0.0",
      createdAt: "1970-01-01T00:00:00.000Z",
      verificationLevel: "thorough",
      author: "A Curator",
      strictMissingMods: false,
    },
    game: { id: "skyrimse", version: "1.6.1179.0", versionPolicy: "exact" },
    vortex: { version: "1.13.7", deploymentMethod: "hardlink", requiredExtensions: [] },
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
          gameDomain: "skyrimspecialedition",
          archiveName: "a-mod.7z",
          sha256: "a".repeat(64),
        },
        install: { fomodSelections: [] },
        state: { enabled: true, installOrder: 0, deploymentPriority: 0, ...state },
      },
    ],
    rules: [],
    plugins: { order: [] },
  });

const firstModState = (raw: string): Record<string, unknown> => {
  const parsed = parseManifest(raw);
  return parsed.manifest.mods[0]!.state as unknown as Record<string, unknown>;
};

const PINNED = {
  path: "SKSE/Plugins/fiss.dll",
  extender: "skse",
  kind: "declares",
  versionIndependent: false,
  runtimes: ["1.6.640"],
  hasQuery: false,
};

describe("nativePlugins reaches the player", () => {
  it("survives a real parse, every field intact", () => {
    const query = { path: "F4SE/Plugins/old.dll", extender: "f4se", kind: "query-only" };
    const state = firstModState(manifestWith({ nativePlugins: [PINNED, query] }));
    expect(state.nativePlugins).toEqual([PINNED, query]);
  });

  it("is absent for a mod with no script-extender plugins", () => {
    // Presence is the signal; an empty list on 1,500 mods says nothing.
    expect("nativePlugins" in firstModState(manifestWith({}))).toBe(false);
    expect("nativePlugins" in firstModState(manifestWith({ nativePlugins: [] }))).toBe(false);
  });
});

describe("read leniently, because it only advises", () => {
  it("skips an entry of a kind from a NEWER build, and still opens the package", () => {
    /**
     * A new enum value strands every older client — an optional key does
     * not. If this rejected unknown kinds, a curator's next build with any
     * new kind would make the collection unopenable for everyone still on
     * this version.
     */
    const future = { path: "SKSE/Plugins/new.dll", extender: "skse", kind: "something-newer" };
    const parsed = parseManifest(manifestWith({ nativePlugins: [future, PINNED] }));
    expect(parsed.manifest.mods[0]!.state.nativePlugins).toEqual([PINNED]);
  });

  it("skips malformed entries one at a time, without an error", () => {
    const state = firstModState(
      manifestWith({
        nativePlugins: [
          null,
          "not an object",
          { path: "", extender: "skse", kind: "declares" },
          { path: "x.dll", extender: "nvse", kind: "declares" },
          PINNED,
        ],
      }),
    );
    expect(state.nativePlugins).toEqual([PINNED]);
  });

  it("drops a badly typed optional field rather than the whole entry", () => {
    const state = firstModState(
      manifestWith({ nativePlugins: [{ ...PINNED, runtimes: "1.6.640", hasQuery: "yes" }] }),
    );
    expect(state.nativePlugins).toEqual([
      { path: PINNED.path, extender: "skse", kind: "declares", versionIndependent: false },
    ]);
  });

  it("does not make a package unopenable when the whole field is garbage", () => {
    expect(() => parseManifest(manifestWith({ nativePlugins: "garbage" }))).not.toThrow();
  });
});
