/**
 * Curator's profile → manifest → parsed back → install plan.
 *
 * The one path nothing covered. Every bug that reached the curator this cycle
 * passed a green unit suite and broke at a seam: a hash cache with tests and
 * an untested caller; a fingerprint that hashed the right thing at the wrong
 * granularity; a game version that was recorded correctly as "unknown" and
 * then enforced as a requirement. Units check a step. This checks that the
 * steps agree.
 *
 * Real files, real hashing, real JSON round-trip through the parser the
 * installer uses. Only the zip container is faked.
 */

import { describe, expect, it, afterEach } from "vitest";

import { captureStagingFiles } from "../../src/core/manifest/captureStagingFiles";
import { buildManifest } from "../../src/core/manifest/buildManifest";
import { parseManifest } from "../../src/core/manifest/parseManifest";
import { resolveInstallPlan } from "../../src/core/resolver/resolveInstallPlan";
import { scopeCollectionMods } from "../../src/core/manifest/collectionScope";
import { makeWorld, sha256, type World } from "./world";
import type { EhcollManifest } from "../../src/types/ehcoll";
import type { UserSideState } from "../../src/types/installPlan";

let world: World | undefined;
afterEach(() => {
  world?.cleanup();
  world = undefined;
});

const ARCHIVE_A = "a".repeat(64);
const ARCHIVE_B = "b".repeat(64);

/** The curator half: profile on disk → manifest, exactly as a build does it. */
async function buildFromWorld(w: World): Promise<{
  manifest: EhcollManifest;
  warnings: string[];
}> {
  const scope = scopeCollectionMods(w.mods);
  const enriched = await captureStagingFiles(
    w.state as never,
    w.gameId,
    scope.included,
    { level: "thorough" },
  );
  const { manifest, warnings } = buildManifest({
    snapshot: { gameId: w.gameId, mods: enriched } as never,
    package: {
      id: "00000000-0000-4000-8000-000000000000",
      name: "E2E Collection",
      version: "1.0.0",
      author: "curator",
      verificationLevel: "thorough",
    },
    game: { version: "1.10.163.0", versionPolicy: "exact" },
    vortex: { version: "2.6.0", deploymentMethod: "hardlink" },
  } as never);
  return { manifest, warnings };
}

/**
 * Round-trip through JSON and the parser the installer actually uses.
 *
 * Asserts the parser found nothing to complain about: a manifest that parses
 * WITH warnings is one the build should not have produced, and swallowing
 * them here would hide exactly the drift this test exists to catch.
 */
function roundTrip(manifest: EhcollManifest): EhcollManifest {
  const { manifest: parsed, warnings } = parseManifest(JSON.stringify(manifest));
  expect(warnings).toEqual([]);
  return parsed;
}

const userState = (over: Partial<UserSideState> = {}): UserSideState =>
  ({
    gameId: "fallout4",
    gameVersion: "1.10.163.0",
    vortexVersion: "2.6.0",
    deploymentMethod: "hardlink",
    enabledExtensions: [],
    installedMods: [],
    availableDownloads: [],
    ...over,
  }) as UserSideState;

describe("curator profile → package → install plan", () => {
  it("carries real file hashes from disk into a plan the installer can act on", async () => {
    world = makeWorld({
      mods: [
        {
          id: "nexus-mod",
          name: "A Nexus Mod",
          nexus: { modId: 111, fileId: 222 },
          archiveSha256: ARCHIVE_A,
          files: { "Data/thing.esp": "esp bytes", "Data/textures/t.dds": "dds bytes" },
        },
        {
          id: "external-mod",
          name: "An External Mod",
          archiveSha256: ARCHIVE_B,
          files: { "Data/other.esp": "other bytes" },
        },
      ],
    });

    const { manifest } = await buildFromWorld(world);
    const parsed = roundTrip(manifest);

    expect(parsed.mods).toHaveLength(2);

    // The hashes are of bytes that really existed on disk, not fixtures.
    const nexus = parsed.mods.find((m) => m.name === "A Nexus Mod")!;
    const esp = nexus.state.stagingFiles!.find((f) => f.path.endsWith("thing.esp"))!;
    expect(esp.sha256).toBe(sha256("esp bytes"));
    expect(esp.size).toBe(Buffer.byteLength("esp bytes"));

    // A user who has nothing installed is told to download the Nexus mod and
    // asked to supply the external one.
    const plan = resolveInstallPlan(parsed, userState(), { kind: "fresh-profile" } as never);
    const kinds = plan.modResolutions.map((r) => r.decision.kind).sort();
    expect(kinds).toEqual(["external-prompt-user", "nexus-download"]);
    expect(plan.compatibility.errors).toEqual([]);
  });

  it("recognises a mod the user already has, byte for byte", async () => {
    world = makeWorld({
      mods: [
        {
          id: "nexus-mod",
          nexus: { modId: 111, fileId: 222 },
          archiveSha256: ARCHIVE_A,
          files: { "Data/thing.esp": "esp bytes" },
        },
      ],
    });
    const parsed = roundTrip((await buildFromWorld(world)).manifest);

    const plan = resolveInstallPlan(
      parsed,
      userState({
        installedMods: [
          {
            id: "local-copy",
            nexusModId: 111,
            nexusFileId: 222,
            archiveSha256: ARCHIVE_A,
          },
        ] as never,
      }),
      { kind: "fresh-profile" } as never,
    );
    expect(plan.modResolutions[0]!.decision.kind).toBe("nexus-already-installed");
  });

  it("does not ship a disabled mod, and the plan never mentions it", async () => {
    // The SteamDeck case: a mod switched off in the profile must not reach a
    // user, and the check has to hold all the way through the package.
    world = makeWorld({
      mods: [
        { id: "on", nexus: { modId: 1, fileId: 1 }, archiveSha256: ARCHIVE_A, files: { "a.esp": "a" } },
        { id: "off", enabled: false, archiveSha256: ARCHIVE_B, files: { "b.esp": "b" } },
      ],
    });
    const parsed = roundTrip((await buildFromWorld(world)).manifest);
    expect(parsed.mods.map((m) => m.name)).toEqual(["on"]);

    const plan = resolveInstallPlan(parsed, userState(), { kind: "fresh-profile" } as never);
    expect(JSON.stringify(plan)).not.toContain("off");
  });

  it("leaves a Vortex collection out of the package entirely", async () => {
    // A collection installed in the profile carries other mods' payloads.
    // Shipping it duplicated every one of them and re-shipped a disabled mod.
    world = makeWorld({
      mods: [
        { id: "real", nexus: { modId: 1, fileId: 1 }, archiveSha256: ARCHIVE_A, files: { "a.esp": "a" } },
        {
          id: "vortex_collection_x",
          name: "Someone's Collection",
          modType: "collection",
          files: { "bundled/Bundled - real.7z/a.esp": "a" },
        },
      ],
    });
    const parsed = roundTrip((await buildFromWorld(world)).manifest);
    expect(parsed.mods.map((m) => m.name)).toEqual(["real"]);
  });

  it("carries the curator's FOMOD answers through intact, type and all", async () => {
    // Replay is not built yet, but it will consume exactly this structure.
    // Vortex's `IChoiceType` is `{ type, options }` and the capture kept only
    // `options` — a manifest that looked complete and could only ever hand
    // the installer half of what it needs.
    world = makeWorld({
      mods: [
        {
          id: "fomod-mod",
          name: "A FOMOD Mod",
          nexus: { modId: 5, fileId: 6 },
          archiveSha256: ARCHIVE_A,
          files: { "Data/chosen.esp": "chosen" },
          installerChoices: {
            type: "fomod",
            options: [
              {
                name: "Choose Options",
                groups: [
                  { name: "Patches", choices: [{ name: "AFT Plus Ivy Patch", idx: 2 }] },
                ],
              },
            ],
          },
        },
      ],
    });
    const parsed = roundTrip((await buildFromWorld(world)).manifest);
    const spec = parsed.mods[0]!.install;

    expect(spec.installerChoicesType).toBe("fomod");
    expect(spec.fomodSelections).toHaveLength(1);
    expect(spec.fomodSelections[0]!.groups[0]!.choices[0]).toEqual({
      name: "AFT Plus Ivy Patch",
      idx: 2,
    });
  });

  it("does not invent a choice type for a mod that recorded none", async () => {
    world = makeWorld({
      mods: [{ id: "plain", nexus: { modId: 1, fileId: 1 }, archiveSha256: ARCHIVE_A, files: { "a.esp": "a" } }],
    });
    const parsed = roundTrip((await buildFromWorld(world)).manifest);
    expect(parsed.mods[0]!.install.installerChoicesType).toBeUndefined();
    expect(parsed.mods[0]!.install.fomodSelections).toEqual([]);
  });

  it("blocks nobody when the curator's game version could not be detected", async () => {
    // Shipped for four releases: version "unknown" under an exact policy,
    // which no real install can satisfy.
    world = makeWorld({
      mods: [{ id: "m", nexus: { modId: 1, fileId: 1 }, archiveSha256: ARCHIVE_A, files: { "a.esp": "a" } }],
    });
    const { manifest } = await buildFromWorld(world);
    const unknownVersion = roundTrip({
      ...manifest,
      game: { ...manifest.game, version: "unknown", versionPolicy: "exact" },
    });

    const plan = resolveInstallPlan(
      unknownVersion,
      userState({ gameVersion: "1.10.984.0" }),
      { kind: "fresh-profile" } as never,
    );
    expect(plan.compatibility.errors).toEqual([]);
    expect(plan.compatibility.gameVersion.status).toBe("unknown");
  });

  // A soft block since the owner poll of 2026-09-22: reported, not an error;
  // the preview and the driver both hold the install until it is acknowledged.
  it("still reports a real game-version mismatch, as a soft block", async () => {
    world = makeWorld({
      mods: [{ id: "m", nexus: { modId: 1, fileId: 1 }, archiveSha256: ARCHIVE_A, files: { "a.esp": "a" } }],
    });
    const parsed = roundTrip((await buildFromWorld(world)).manifest);
    const plan = resolveInstallPlan(
      parsed,
      userState({ gameVersion: "1.10.984.0" }),
      { kind: "fresh-profile" } as never,
    );
    expect(plan.compatibility.errors).toEqual([]);
    expect(plan.compatibility.gameVersion.status).toBe("mismatch");
    expect(plan.compatibility.versionMismatch).toMatchObject({ installed: "1.10.984.0" });
  });
});
