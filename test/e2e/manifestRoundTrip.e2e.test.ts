/**
 * Does parseManifest preserve everything buildManifest emits?
 *
 * Every validator in the parser constructs a FRESH object from known fields
 * and discards the rest — 36 of them. So a field can be added to the manifest
 * type, written by the builder, and silently dropped on the way in, with the
 * compiler happy and nothing failing. That is not hypothetical: the same shape
 * ate `url` and `mode` in the collection config, and `gameIniApplication` in
 * the install receipt.
 *
 * A real build through the real parser, deep-compared. It is a net, not a
 * proof — it only covers fields this fixture populates — so it is worth
 * extending whenever the manifest grows.
 */
import { describe, expect, it, afterEach } from "vitest";

import { buildManifest } from "../../src/core/manifest/buildManifest";
import { parseManifest } from "../../src/core/manifest/parseManifest";
import { captureStagingFiles } from "../../src/core/manifest/captureStagingFiles";
import { scopeCollectionMods } from "../../src/core/manifest/collectionScope";
import { makeWorld, type World } from "./world";

let world: World | undefined;
afterEach(() => {
  world?.cleanup();
  world = undefined;
});

describe("manifest round-trip", () => {
  it("parse preserves everything build emits", async () => {
    world = makeWorld({
      mods: [
        {
          id: "nexus-mod",
          name: "Nexus Mod",
          nexus: { modId: 111, fileId: 222 },
          archiveSha256: "a".repeat(64),
          files: { "Data/a.esp": "a" },
          installerChoices: {
            type: "fomod",
            options: [
              { name: "Step", groups: [{ name: "G", choices: [{ name: "C", idx: 1 }] }] },
            ],
          },
          modType: "dinput",
          version: "1.2.3",
        },
        {
          id: "ext-mod",
          name: "External Mod",
          archiveSha256: "b".repeat(64),
          files: { "Data/b.esp": "b" },
        },
      ],
    });
    // A mod rule, so `rules` is not compared empty-to-empty. Pointing at a
    // mod that IS in the collection, or buildRules drops it as unresolvable.
    (world.mods[0] as { rules?: unknown[] }).rules = [
      { type: "after", reference: { id: "ext-mod" } },
    ];
    const scope = scopeCollectionMods(world.mods);
    const enriched = await captureStagingFiles(
      world.state as never, world.gameId, scope.included, { level: "thorough" },
    );
    const { manifest } = buildManifest({
      /**
       * ─── EVERY SHIPPED AREA, POPULATED ──────────────────────────────
       * This deep-compares build output against parse output, so it guards
       * exactly the fields the fixture happens to fill — and it said so in
       * its own header while `plugins.order` sat empty and `light` was
       * dropped for the whole life of the ESL feature.
       *
       * userlist, loadOrder, gameIni and externalDependencies were all
       * unpopulated too. Each is parsed by its own validator that builds a
       * FRESH object from known fields and discards the rest, so any of them
       * could lose a field exactly the same way. Filling them is what turns
       * this from a test of one area into a test of the format.
       */
      snapshot: {
        gameId: world.gameId,
        mods: enriched,
        loadOrder: [
          { modId: "nexus-mod", pos: 0, enabled: true },
          { modId: "ext-mod", pos: 1, enabled: false, locked: true },
        ],
        userlist: {
          plugins: [
            // Every optional edge kind, and a group-only entry — the shape
            // that dominates a real profile (501 of 501 on the reference
            // package were group assignments with no edges).
            { name: "Light.esp", group: "Early" },
            { name: "Regular.esp", after: ["Light.esp"], req: ["Light.esp"], inc: ["Unrecorded.esp"] },
          ],
          groups: [{ name: "Early", after: ["default"] }],
        },
      } as never,
      package: {
        id: "00000000-0000-4000-8000-000000000000",
        name: "RT", version: "1.0.0", author: "a", verificationLevel: "thorough",
        description: "d",
      },
      game: { version: "1.10.163.0", versionPolicy: "exact" },
      vortex: { version: "2.6.0", deploymentMethod: "hardlink" },
      /**
       * ─── THE FIXTURE HAS TO POPULATE THE FIELD TO PROTECT IT ─────────
       * This test's own docblock says it is "a net, not a proof — it only
       * covers fields this fixture populates", and that turned out to be
       * exactly right: `plugins.order` was empty here, so nothing compared
       * the plugin entries, and `parseManifest` silently dropped `light` for
       * the entire life of the ESL feature. Every flag a curator captured
       * died on the user's machine and this test stayed green.
       *
       * All three states are covered on purpose. `false` and ABSENT are
       * different instructions — clear the flag versus leave it alone — and
       * a round-trip that collapsed them would be worse than none.
       */
      pluginsTxtContent: ["*Light.esp", "*Regular.esp", "*Unrecorded.esp"].join(
        String.fromCharCode(10),
      ),
      pluginLightFlags: { "light.esp": true, "regular.esp": false },
      gameIni: {
        files: [
          {
            fileName: "Fallout4Custom.ini",
            settings: [
              { section: "Archive", key: "bInvalidateOlderFiles", value: "1" },
            ],
          },
        ],
      },
      externalDependencies: [
        {
          id: "f4se",
          name: "Fallout 4 Script Extender",
          category: "script-extender",
          version: "0.6.23",
          destination: "<gameDir>",
          files: [{ relPath: "f4se_loader.exe", sha256: "b".repeat(64) }],
          instructions: "Download the build matching your game version.",
          instructionsUrl: "https://f4se.silverlock.org/",
        },
      ],
      externalMods: {
        "ext-mod": {
          instructions: "Get it here",
          url: "https://example.com/p",
          mode: "browse",
          bundled: false,
        },
      },
    } as never);

    /**
     * The fixture must actually exercise what it claims to protect: an empty
     * list compares equal to an empty list, which is how this test missed
     * `light` in the first place. Every area is asserted non-empty BEFORE
     * the deep compare, so a builder change that silently stops emitting one
     * fails here rather than passing vacuously.
     */
    expect(manifest.plugins.order).toHaveLength(3);
    expect(manifest.plugins.order.filter((p) => p.light !== undefined)).toHaveLength(2);
    expect(manifest.userlist.plugins.length).toBeGreaterThan(0);
    expect(manifest.userlist.groups.length).toBeGreaterThan(0);
    expect(manifest.loadOrder.length).toBeGreaterThan(0);
    expect(manifest.gameIni?.files.length ?? 0).toBeGreaterThan(0);
    expect(manifest.externalDependencies.length).toBeGreaterThan(0);
    expect(manifest.rules.length).toBeGreaterThan(0);

    const parsed = parseManifest(JSON.stringify(manifest)).manifest;
    // The real assertion: nothing the builder produced was eaten on the way in.
    expect(parsed).toEqual(JSON.parse(JSON.stringify(manifest)));
  });
});
