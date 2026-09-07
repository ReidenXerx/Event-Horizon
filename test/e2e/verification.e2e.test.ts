/**
 * The verification chain, end to end: curator's profile → manifest → plan →
 * the real driver → what the user is actually told.
 *
 * ─── WHY THIS FILE EXISTS ──────────────────────────────────────────────
 * Every part of this subsystem had a green unit suite and six of them were
 * still wrong, because the unit tests each proved a primitive while the bug
 * lived in the wiring: a verdict nothing branched on, a notice nothing
 * rendered, a scanner wired into one of two pipelines. The level below the one
 * where it broke.
 *
 * These drive `runInstall` itself and assert on the RESULT the UI receives —
 * `curatorReports`, `damagedArchiveNotice`, `stagingDriftNotice` — because
 * that is the first place where "the code is correct" and "the user is told
 * the right thing" stop being the same claim.
 *
 * The knob is `installProduces`: what the install actually puts on disk.
 * Returning the curator's exact bytes is a clean install; returning different
 * bytes is a corrupted one; omitting a file is Vortex's lost-file bug.
 */

import * as fs from "fs";
import * as nodePath from "path";

import { afterEach, describe, expect, it } from "vitest";

import { runInstall } from "../../src/core/installer/runInstall";
import { parseManifest } from "../../src/core/manifest/parseManifest";
import { resolveInstallPlan } from "../../src/core/resolver/resolveInstallPlan";
import { buildManifest } from "../../src/core/manifest/buildManifest";
import { captureStagingFiles } from "../../src/core/manifest/captureStagingFiles";
import { scopeCollectionMods } from "../../src/core/manifest/collectionScope";
import { makeFakeVortex } from "./fakeVortex";
import { makeWorld, type World, type WorldMod } from "./world";
import type { EhcollManifest } from "../../src/types/ehcoll";
import type { UserSideState } from "../../src/types/installPlan";

let world: World | undefined;
afterEach(() => {
  world?.cleanup();
  world = undefined;
});

/** One Nexus mod with real bytes on the curator's disk. */
const MOD: WorldMod = {
  id: "rock-textures",
  name: "Rock Textures",
  nexus: { modId: 100, fileId: 200 },
  archiveSha256: "a".repeat(64),
  files: {
    "Textures/rock.dds": "the bytes the curator shipped",
    "Data/rock.esp": "a plugin",
  },
};

/** The archiveId the fake hands back for {@link MOD}. */
const ARCHIVE_ID = "dl-100-200";

async function packageFrom(w: World): Promise<EhcollManifest> {
  const scope = scopeCollectionMods(w.mods);
  const enriched = await captureStagingFiles(
    w.state as never,
    w.gameId,
    scope.included,
    { level: "thorough" },
  );
  const { manifest } = buildManifest({
    snapshot: { gameId: w.gameId, mods: enriched } as never,
    package: {
      id: "00000000-0000-4000-8000-000000000000",
      name: "Verification E2E",
      version: "1.0.0",
      author: "curator",
      verificationLevel: "thorough",
    },
    game: { version: "1.10.163.0", versionPolicy: "exact" },
    vortex: { version: "2.6.0", deploymentMethod: "hardlink" },
  } as never);
  return parseManifest(JSON.stringify(manifest)).manifest;
}

const userState = (installedMods: unknown[] = []): UserSideState =>
  ({
    gameId: "fallout4",
    gameVersion: "1.10.163.0",
    vortexVersion: "2.6.0",
    deploymentMethod: "hardlink",
    enabledExtensions: [],
    installedMods,
    availableDownloads: [],
    activeProfileId: "profile-e2e",
    activeProfileName: "E2E Profile",
  }) as UserSideState;

/**
 * Why a driver run was not a success.
 *
 * `expect(result.kind).toBe("success")` on a failure prints `'failed'`, which
 * names neither the phase nor the reason — and the driver's own failure result
 * carries both. Without this a flaky e2e failure is unactionable.
 */
function why(result: unknown): string {
  const r = result as {
    kind?: string;
    phase?: string;
    error?: unknown;
    message?: string;
    errors?: unknown[];
  };
  if (r?.kind === "success") return "";
  return JSON.stringify(
    { kind: r?.kind, phase: r?.phase, message: r?.message, error: r?.error, errors: r?.errors },
  ).slice(0, 900);
}

async function install(
  rawManifest: EhcollManifest,
  fake: ReturnType<typeof makeFakeVortex>,
  /** Mods the user already has, for the `*-already-installed` arms. */
  installedMods: unknown[] = [],
  /** Override the install target, for the resume-profile cases. */
  installTarget?: unknown,
) {
  /**
   * ─── THROUGH THE REAL FORMAT, NOT AROUND IT ─────────────────────────
   * These tests used to hand the manifest OBJECT straight to the driver,
   * which skips the one step every real install performs: serialize to
   * `.ehcoll`, read it back, parse it.
   *
   * That gap hid the worst bug this project has had. `parseManifest` never
   * read `plugins.order[].light`, so every ESL flag a curator captured was
   * silently dropped on the user's machine — and all four light-flag tests
   * below passed throughout, because they never went through the parser. A
   * profile that fits 817 plugins only because 573 are light installed with
   * every one of them regular against a limit of 254, and the game did not
   * start.
   *
   * Round-tripping here means an e2e test now fails when a field stops
   * surviving the format, which is what "end to end" was supposed to mean.
   */
  const manifest = parseManifest(JSON.stringify(rawManifest)).manifest;

  const plan = resolveInstallPlan(
    manifest,
    userState(installedMods),
    (installTarget ?? {
      kind: "fresh-profile",
      profileName: "E2E Profile",
    }) as never,
  );
  const running = runInstall({
    api: fake.api,
    plan,
    ehcoll: { manifest, bundledArchives: [], warnings: [] } as never,
    // Per-world, not a shared absolute path. See World.appDataPath.
    ehcollZipPath: `${world!.root}/pkg.ehcoll`,
    appDataPath: world!.appDataPath,
    decisions: {},
  } as never);

  const stalled = new Promise<never>((_r, reject) =>
    setTimeout(
      () =>
        reject(
          new Error(
            `driver stalled. emits=[${fake.emits.map((e) => e.event).join(" | ")}]`,
          ),
        ),
      5000,
    ),
  );
  return Promise.race([running, stalled]);
}

/**
 * The ESL / "light" flag, curator's disk → package → user's disk.
 *
 * The collection this was built for fits 817 plugins under a 254 limit only
 * because 579 are light. The flag lives INSIDE the plugin file, so the archive
 * a user installs from does not carry a flag the curator added afterwards —
 * and nothing else in the pipeline can rescue it: verification sees different
 * bytes, the archive check finds the user's copy matches the archive exactly,
 * and it is accepted as curator divergence. Correct for every other
 * difference; fatal for this one.
 *
 * These drive the REAL header reader and writer against real files, because
 * the whole feature is four bytes at offset 8 and a fixture that only模 the
 * shape would prove nothing about them.
 */
describe("the curator's ESL flags reach the user", () => {
  const TES4 = (flags: number): Buffer => {
    const buf = Buffer.alloc(24);
    buf.write("TES4", 0, "latin1");
    buf.writeUInt32LE(12, 4);
    buf.writeUInt32LE(flags, 8);
    return buf;
  };
  const FLAG_LIGHT = 0x200;

  /** A game folder with a Data dir holding the given plugins. */
  const makeGameDir = (
    root: string,
    plugins: Record<string, number>,
  ): string => {
    const gameDir = nodePath.join(root, "game");
    const data = nodePath.join(gameDir, "Data");
    fs.mkdirSync(data, { recursive: true });
    for (const [name, flags] of Object.entries(plugins)) {
      fs.writeFileSync(nodePath.join(data, name), TES4(flags));
    }
    return gameDir;
  };

  it("captures a light flag from the curator's deployed plugin", async () => {
    // The build half, against a real file rather than a mocked reader.
    const { capturePluginFlags } = await import(
      "../../src/core/manifest/capturePluginFlags"
    );
    world = makeWorld({ mods: [MOD] });
    const gameDir = makeGameDir(world.root, {
      "Light.esp": FLAG_LIGHT,
      "Regular.esp": 0,
    });

    const captured = await capturePluginFlags({
      pluginNames: ["Light.esp", "Regular.esp", "NotThere.esp"],
      dataDir: nodePath.join(gameDir, "Data"),
    });

    expect(captured.light).toEqual({ "light.esp": true, "regular.esp": false });
    expect(captured.lightCount).toBe(1);
    // Absent, not false — the installer must leave an unreadable plugin alone
    // rather than clear a flag the user legitimately has.
    expect(captured.light["notthere.esp"]).toBeUndefined();
    expect(captured.unreadable).toEqual(["NotThere.esp"]);
  });

  it("restores the flag on the user's unflagged copy, through the real driver", async () => {
    // The whole mosaic piece: the curator marked it light, the archive did
    // not carry that, and the user's copy comes out of the install without it.
    world = makeWorld({ mods: [MOD] });
    const gameDir = makeGameDir(world.root, {
      "Light.esp": 0, // the USER's copy — flag missing, as the archive gave it
      "Regular.esp": 0,
    });
    const dataDir = nodePath.join(gameDir, "Data");

    const manifest = await packageFrom(world);
    // What the build would have recorded from the curator's machine.
    (manifest.plugins as { order: unknown[] }).order = [
      { name: "Light.esp", enabled: true, light: true },
      { name: "Regular.esp", enabled: true, light: false },
    ];

    const fake = makeFakeVortex({
      gameId: world.gameId,
      stagingRoot: world.stagingRoot,
      gamePath: gameDir,
      installProduces: (id) => (id === ARCHIVE_ID ? MOD.files : undefined),
    });

    const result = (await install(manifest, fake)) as {
      kind: string;
      pluginFlagNotice?: string[];
    };
    expect(result.kind, why(result)).toBe("success");

    // The four bytes that decide whether this collection can load.
    expect(fs.readFileSync(nodePath.join(dataDir, "Light.esp")).readUInt32LE(8) & FLAG_LIGHT)
      .toBe(FLAG_LIGHT);
    // …and the one the curator left regular is untouched.
    expect(fs.readFileSync(nodePath.join(dataDir, "Regular.esp")).readUInt32LE(8) & FLAG_LIGHT)
      .toBe(0);

    expect((result.pluginFlagNotice ?? []).join(" ")).toMatch(/1 plugin/);
  });

  it("says nothing when every flag already matches", async () => {
    // The common case — the mod author shipped it light. Announcing "restored
    // 0 flags" on every install is how a notice teaches people to ignore it.
    world = makeWorld({ mods: [MOD] });
    const gameDir = makeGameDir(world.root, { "Light.esp": FLAG_LIGHT });

    const manifest = await packageFrom(world);
    (manifest.plugins as { order: unknown[] }).order = [
      { name: "Light.esp", enabled: true, light: true },
    ];

    const fake = makeFakeVortex({
      gameId: world.gameId,
      stagingRoot: world.stagingRoot,
      gamePath: gameDir,
      installProduces: (id) => (id === ARCHIVE_ID ? MOD.files : undefined),
    });

    const result = (await install(manifest, fake)) as {
      kind: string;
      pluginFlagNotice?: string[];
    };
    expect(result.kind, why(result)).toBe("success");
    expect(result.pluginFlagNotice).toBeUndefined();
  });

  it("leaves a plugin alone when the package records no flag for it", async () => {
    // An older .ehcoll, or a header the build could not read. Absent means
    // UNKNOWN; clearing the user's flag on that basis is how you break a game
    // with a package that predates the feature.
    world = makeWorld({ mods: [MOD] });
    const gameDir = makeGameDir(world.root, { "Light.esp": FLAG_LIGHT });
    const dataDir = nodePath.join(gameDir, "Data");

    const manifest = await packageFrom(world);
    (manifest.plugins as { order: unknown[] }).order = [
      { name: "Light.esp", enabled: true }, // no `light` key at all
    ];

    const fake = makeFakeVortex({
      gameId: world.gameId,
      stagingRoot: world.stagingRoot,
      gamePath: gameDir,
      installProduces: (id) => (id === ARCHIVE_ID ? MOD.files : undefined),
    });
    await install(manifest, fake);

    expect(fs.readFileSync(nodePath.join(dataDir, "Light.esp")).readUInt32LE(8) & FLAG_LIGHT)
      .toBe(FLAG_LIGHT);
  });
});

describe("the curator's plugin order is pinned, then sorted", () => {
  it("emits pin → sort → write through the real driver", async () => {
    // Unit tests cover the module; this proves runInstall actually calls it,
    // after deploying, with the manifest's order.
    world = makeWorld({ mods: [MOD] });
    const manifest = await packageFrom(world);
    (manifest.plugins as { order: unknown[] }).order = [
      { name: "A.esp", enabled: true },
      { name: "B.esp", enabled: true },
    ];

    const fake = makeFakeVortex({
      gameId: world.gameId,
      stagingRoot: world.stagingRoot,
      installProduces: (id) => (id === ARCHIVE_ID ? MOD.files : undefined),
    });

    const result = (await install(manifest, fake)) as { kind: string };
    expect(result.kind, why(result)).toBe("success");

    const seq = fake.emits.map((e) => e.event);
    const pin = seq.indexOf("set-plugin-list");
    const sort = seq.indexOf("autosort-plugins");
    const write = seq.indexOf("collection-postprocess-complete");
    expect(pin).toBeGreaterThan(-1);
    expect(pin).toBeLessThan(sort);
    expect(sort).toBeLessThan(write);

    // The curator's names, and setEnabled FALSE — true would disable every
    // plugin the user added themselves.
    const pinArgs = fake.emits.find((e) => e.event === "set-plugin-list")!.args;
    expect(pinArgs[0]).toEqual(["A.esp", "B.esp"]);
    expect(pinArgs[1]).toBe(false);

    // Deployed BEFORE the order was set: Vortex only knows a plugin exists
    // once its mod is on disk.
    expect(seq.indexOf("deploy-mods")).toBeLessThan(pin);
  });

  it("still writes the order when LOOT refuses to sort", async () => {
    // A rule cycle is the expected failure, and the reason pinning comes
    // first: the curator's order is already in the hive and still reaches disk.
    world = makeWorld({ mods: [MOD] });
    const manifest = await packageFrom(world);
    (manifest.plugins as { order: unknown[] }).order = [
      { name: "A.esp", enabled: true },
    ];

    const fake = makeFakeVortex({
      gameId: world.gameId,
      stagingRoot: world.stagingRoot,
      sortBehaviour: { error: "Cyclic interaction detected" },
      installProduces: (id) => (id === ARCHIVE_ID ? MOD.files : undefined),
    });

    const result = (await install(manifest, fake)) as {
      kind: string;
      pluginOrderNotApplied?: string[];
    };
    expect(result.kind, why(result)).toBe("success");
    expect(
      fake.emits.some((e) => e.event === "collection-postprocess-complete"),
    ).toBe(true);
    expect((result.pluginOrderNotApplied ?? []).join(" ")).toMatch(
      /load after the collection/i,
    );
  });
});

describe("the collection's rules are the ONLY rules", () => {
  it("clears the user's own mod rules and LOOT list, through the real driver", async () => {
    // A merged rule set exists on nobody's machine but this user's, and it
    // changes what the game loads while failing nothing — every file verifies
    // and the game still behaves differently from the curator's. So the
    // collection's rules replace rather than join.
    world = makeWorld({ mods: [MOD] });
    const manifest = await packageFrom(world);
    const fake = makeFakeVortex({
      gameId: world.gameId,
      stagingRoot: world.stagingRoot,
      installProduces: (id) => (id === ARCHIVE_ID ? MOD.files : undefined),
    });

    // The user's own opinions, of the kind this feature exists to overrule.
    const persistent = (fake.state as { persistent: Record<string, unknown> })
      .persistent as { mods: Record<string, Record<string, unknown>> };
    persistent.mods[world.gameId]["their-old-mod"] = {
      id: "their-old-mod",
      rules: [{ type: "after", reference: { id: "something-else" } }],
    };
    (fake.state as Record<string, unknown>).userlist = {
      plugins: [{ name: "TheirTweak.esp", group: "Late Loaders" }],
      groups: [],
    };

    const result = (await install(manifest, fake)) as {
      kind: string;
      rulesPurgeNotice?: string[];
    };

    expect(result.kind, why(result)).toBe("success");

    // Their mod rule was removed...
    const removals = fake.dispatched.filter(
      (d) => (d as { type?: string })?.type === "STUB_REMOVE_MOD_RULE",
    );
    expect(removals.length).toBeGreaterThan(0);
    // ...and the LOOT userlist was cleared with Vortex's own action.
    expect(
      fake.dispatched.some(
        (d) => (d as { type?: string })?.type === "CLEAR_USERLIST",
      ),
    ).toBe(true);

    // And the user is TOLD, with somewhere to recover from.
    const notice = (result.rulesPurgeNotice ?? []).join(" ");
    expect(notice).toMatch(/only ones in place/i);
    expect(notice).toMatch(/rule-backups/);
  });

  it("leaves a backup file on disk before deleting anything", async () => {
    world = makeWorld({ mods: [MOD] });
    const manifest = await packageFrom(world);
    const fake = makeFakeVortex({
      gameId: world.gameId,
      stagingRoot: world.stagingRoot,
      installProduces: (id) => (id === ARCHIVE_ID ? MOD.files : undefined),
    });
    const persistent = (fake.state as { persistent: Record<string, unknown> })
      .persistent as { mods: Record<string, Record<string, unknown>> };
    persistent.mods[world.gameId]["their-old-mod"] = {
      id: "their-old-mod",
      rules: [{ type: "after", reference: { id: "something-else" } }],
    };

    await install(manifest, fake);

    const fsm = await import("fs");
    const pathm = await import("path");
    const dir = pathm.join(world.appDataPath, "event-horizon", "rule-backups");
    const files = fsm.readdirSync(dir);
    expect(files).toHaveLength(1);
    const saved = JSON.parse(
      fsm.readFileSync(pathm.join(dir, files[0]), "utf8"),
    ) as { modRules: Array<{ modId: string }> };
    // The backup has to contain the thing that was deleted, or it is theatre.
    expect(saved.modRules.map((r) => r.modId)).toContain("their-old-mod");
  });
});

describe("verification is reachable end to end", () => {
  it("a clean install passes verification and records what it left", async () => {
    // The foundational check. Until the fake registered a mod record and wrote
    // bytes, `verifyModInstall` could not resolve a staging folder and every
    // assertion below would have held for a driver that verified NOTHING.
    world = makeWorld({ mods: [MOD] });
    const manifest = await packageFrom(world);
    const fake = makeFakeVortex({
      gameId: world.gameId,
      stagingRoot: world.stagingRoot,
      installProduces: (id) => (id === ARCHIVE_ID ? MOD.files : undefined),
    });

    const result = (await install(manifest, fake)) as {
      kind: string;
      verifications?: Array<{ kind: string; verifiedFileCount?: number }>;
      curatorReports?: string[];
      damagedArchiveNotice?: string[];
    };

    expect(result.kind, why(result)).toBe("success");
    const verifications = result.verifications ?? [];
    expect(verifications).toHaveLength(1);
    expect(verifications[0].kind).toBe("ok");
    // Both files, actually read and hashed — not a verification that resolved
    // an empty folder and called it agreement.
    expect(verifications[0].verifiedFileCount).toBe(2);
    expect(result.curatorReports).toBeUndefined();
    expect(result.damagedArchiveNotice).toBeUndefined();
  });

  it("a MISSING file is caught — the bug this project exists for", async () => {
    // Vortex silently drops files during bulk installs. A verification that
    // cannot see that is the whole promise failing quietly, so this is the one
    // case that must never be explained away by any later refinement.
    world = makeWorld({ mods: [MOD] });
    const manifest = await packageFrom(world);
    const fake = makeFakeVortex({
      gameId: world.gameId,
      stagingRoot: world.stagingRoot,
      installProduces: (id) =>
        id === ARCHIVE_ID
          ? { "Textures/rock.dds": MOD.files["Textures/rock.dds"] } // .esp lost
          : undefined,
    });

    const result = (await install(manifest, fake)) as {
      kind: string;
      verifications?: Array<{
        kind: string;
        missingFileCount?: number;
        retryAttempted?: boolean;
        examples?: Array<{ bucket: string; path: string }>;
      }>;
    };

    expect(result.kind, why(result)).toBe("success");
    const failed = (result.verifications ?? []).filter((v) => v.kind === "fail");
    expect(failed).toHaveLength(1);
    expect(failed[0].missingFileCount).toBe(1);
    // Named, not merely counted: "1 file missing" is not a bug report.
    expect(failed[0].examples).toContainEqual({
      bucket: "missing",
      path: "Data/rock.esp",
    });
    // A missing file ALWAYS earns a reinstall attempt — judgeReinstall refuses
    // to explain absence away, because content mutation cannot remove a file.
    expect(failed[0].retryAttempted).toBe(true);
  });
});

/**
 * The ~11% case, end to end.
 *
 * On a real 993-mod profile about eleven percent of mods have staged files
 * that legitimately differ from the archive they came from — BA2 repacking,
 * plugin cleaning, runtime-generated config. The curator ships those
 * post-processed bytes as the reference, so every user's correct install
 * "fails" against them, gets uninstalled, reinstalled from the archive,
 * compared against the same reference, fails again, and is recorded broken.
 *
 * The archive is the one reference no one's extraction can corrupt. These
 * tests put a REAL archive on disk and check the driver actually consults it.
 */
describe("the archive is consulted before a reinstall is spent", () => {
  /** What a clean extract of the archive produces. */
  const ARCHIVE_BYTES = "the original bytes as shipped by the mod author";
  /** What the curator has on disk after their own post-processing. */
  const CURATOR_BYTES = "the same file after the curator repacked it";

  const divergedMod: WorldMod = {
    ...MOD,
    files: {
      "Textures/rock.dds": CURATOR_BYTES,
      "Data/rock.esp": "a plugin",
    },
  };

  /** Put a real ZIP in the download folder and tell Vortex about it. */
  const withArchive = async (
    w: World,
    entries: Array<{ name: string; body: string }>,
  ): Promise<Record<string, string>> => {
    const { writeStoredZip } = await import(
      "../../src/core/manifest/storedZip.testutil"
    );
    const pathm = await import("path");
    const fsm = await import("fs");
    writeStoredZip(pathm.join(w.downloadRoot, "mod.zip"), entries);
    // The .ehcoll the driver was launched from. It exists during a real
    // install, and the curator report hashes it to identify the build.
    fsm.writeFileSync(
      pathm.join(w.root, "pkg.ehcoll"),
      "the collection package bytes",
    );
    return { [ARCHIVE_ID]: "mod.zip" };
  };

  it("does NOT reinstall when the user's files match the archive", async () => {
    // The user installed correctly. Their bytes differ from the CURATOR's
    // because the curator post-processed theirs — so a reinstall would
    // reproduce exactly what is already on disk. Pure cost, twice.
    world = makeWorld({ mods: [divergedMod] });
    const manifest = await packageFrom(world);
    const downloads = await withArchive(world, [
      { name: "Textures/rock.dds", body: ARCHIVE_BYTES },
      { name: "Data/rock.esp", body: "a plugin" },
    ]);
    const fake = makeFakeVortex({
      gameId: world.gameId,
      downloads,
      stagingRoot: world.stagingRoot,
      installProduces: (id) =>
        id === ARCHIVE_ID
          ? { "Textures/rock.dds": ARCHIVE_BYTES, "Data/rock.esp": "a plugin" }
          : undefined,
    });

    const result = (await install(manifest, fake)) as {
      kind: string;
      verifications?: Array<{ kind: string; retryAttempted?: boolean }>;
      curatorReports?: string[];
    };

    expect(result.kind, why(result)).toBe("success");
    // THE assertion: exactly one install. A second entry means the driver
    // spent a reinstall on files that were already right.
    expect(fake.installed).toHaveLength(1);
    expect(result.verifications?.[0]?.kind).toBe("ok");
    expect(result.verifications?.[0]?.retryAttempted).toBeFalsy();
    // Nothing to tell the curator: their staging diverging from their own
    // archive is normal and not this user's problem.
    expect(result.curatorReports).toBeUndefined();
  });

  it("DOES reinstall when the user's files match neither side", async () => {
    // The other half. If "consult the archive" degenerated into "never
    // reinstall", it would suppress the real corruption this project exists to
    // catch — so a mod whose bytes are in neither the manifest nor the archive
    // must still be retried.
    world = makeWorld({ mods: [divergedMod] });
    const manifest = await packageFrom(world);
    const downloads = await withArchive(world, [
      { name: "Textures/rock.dds", body: ARCHIVE_BYTES },
      { name: "Data/rock.esp", body: "a plugin" },
    ]);
    const fake = makeFakeVortex({
      gameId: world.gameId,
      downloads,
      stagingRoot: world.stagingRoot,
      installProduces: () => ({
        "Textures/rock.dds": "corrupted on the way to disk",
        "Data/rock.esp": "a plugin",
      }),
    });

    const result = (await install(manifest, fake)) as {
      kind: string;
      verifications?: Array<{ kind: string; retryAttempted?: boolean }>;
      curatorReports?: string[];
    };

    expect(result.kind, why(result)).toBe("success");
    expect(fake.installed.length).toBeGreaterThan(1); // it tried again
    expect(result.verifications?.[0]?.kind).toBe("fail");
    // Survived a reinstall AND the archive check: worth the curator's time.
    expect(result.curatorReports?.length).toBe(1);
    const report = result.curatorReports![0];
    expect(report).toContain("Rock Textures");

    // The archive WAS read here, so the report is entitled to say so.
    expect(report).toMatch(/do not match its archive either/i);

    // And it must carry the package's own hash. `packageSha256` existed on the
    // report type from the start, documented as the thing that tells a curator
    // WHICH build they are looking at — and no caller ever passed it, so it
    // never once appeared in a real report while its unit test, which supplies
    // it directly, stayed green.
    const fsm = await import("fs");
    const crypto = await import("crypto");
    const expected = crypto
      .createHash("sha256")
      .update(fsm.readFileSync(`${world.root}/pkg.ehcoll`))
      .digest("hex");
    expect(report).toContain(expected);
  });

  it("blames the DOWNLOAD, not the curator, when the archive is damaged", async () => {
    // A hash mismatch has two causes: the mod was re-uploaded under the same
    // file id, or this user's download is truncated. Only the second is fixed
    // by downloading again, and only the first is worth a curator's time.
    // Reporting a corrupt download to the curator sends them hunting a mod
    // they never changed — and at scale it is how the report channel stops
    // being read.
    world = makeWorld({ mods: [divergedMod] });
    const manifest = await packageFrom(world);

    const { buildStoredZip } = await import(
      "../../src/core/manifest/storedZip.testutil"
    );
    const fsm = await import("fs");
    const pathm = await import("path");
    const whole = buildStoredZip([
      { name: "Textures/rock.dds", body: ARCHIVE_BYTES },
    ]);
    // Half a zip: no end-of-central-directory, so no reader can open it. This
    // is what an interrupted download leaves behind.
    fsm.writeFileSync(
      pathm.join(world.downloadRoot, "mod.zip"),
      whole.subarray(0, Math.floor(whole.length / 2)),
    );

    const fake = makeFakeVortex({
      gameId: world.gameId,
      downloads: { [ARCHIVE_ID]: "mod.zip" },
      stagingRoot: world.stagingRoot,
      installProduces: () => ({
        "Textures/rock.dds": "whatever a broken archive yields",
        "Data/rock.esp": "a plugin",
      }),
    });

    const result = (await install(manifest, fake)) as {
      kind: string;
      curatorReports?: string[];
      damagedArchiveNotice?: string[];
    };

    expect(result.kind, why(result)).toBe("success");
    // The whole point of the split.
    expect(result.damagedArchiveNotice?.length).toBe(1);
    expect(result.damagedArchiveNotice?.[0]).toContain("Rock Textures");
    expect(result.damagedArchiveNotice?.[0]).toMatch(/damaged/i);
    // …and NOT a message accusing the curator of a re-upload.
    expect(result.curatorReports).toBeUndefined();
    expect(result.damagedArchiveNotice?.[0]).not.toMatch(/re-uploaded/i);
  });
});

/**
 * ──────────────────────────────────────────────────────────────────────
 * A mod we SKIPPED because it was already installed can still be broken.
 *
 * Identity and integrity are two questions. The resolver answers the first —
 * "is this the same mod?" — and a match means no download and no install. The
 * verification pass answers the second, "did the right bytes land?", and it
 * has always run over already-installed mods too.
 *
 * What it did NOT do was repair them. `tryRecoverFailedMod` refused anything
 * whose decision ended in `already-installed`, on the reasoning that we never
 * installed it so the mismatch might be the user's own edit.
 *
 * That reasoning aged badly. On a RESUME — a 1,755-mod install interrupted and
 * restarted, which is the case a tester actually hit — "already installed"
 * overwhelmingly means "we installed it ourselves and got interrupted", which
 * is exactly where a half-extracted mod lives. So the tool detected the
 * failure it exists to detect and then declined to fix it.
 * ──────────────────────────────────────────────────────────────────────
 */
describe("a broken mod is repaired even when we skipped installing it", () => {
  /** The mod id the user's pre-existing copy lives under. */
  const EXISTING_ID = "user-had-this-already";

  /**
   * The user's copy, as an interrupted install leaves it: registered with
   * Vortex, present on disk, and MISSING a file the curator recorded.
   *
   * Missing rather than merely different on purpose — `judgeReinstall` excuses
   * differing files the archive explains, and absence is the one thing it
   * never excuses, so this is the shape that must reach the repair.
   */
  function seedHalfInstalled(w: World, fake: ReturnType<typeof makeFakeVortex>) {
    const dir = nodePath.join(w.stagingRoot, EXISTING_ID);
    fs.mkdirSync(nodePath.join(dir, "Data"), { recursive: true });
    // "Textures/rock.dds" is deliberately absent — the lost-file bug.
    fs.writeFileSync(nodePath.join(dir, "Data", "rock.esp"), "a plugin");

    const mods = (
      fake.api.getState().persistent as {
        mods: Record<string, Record<string, unknown>>;
      }
    ).mods[w.gameId]!;
    mods[EXISTING_ID] = {
      id: EXISTING_ID,
      installationPath: EXISTING_ID,
      type: "",
      archiveId: ARCHIVE_ID,
      attributes: { name: "Rock Textures", version: "1.0.0" },
    };
  }

  /**
   * The user state that makes the resolver say "already installed".
   *
   * No `archiveSha256`, which is the real-world shape: Vortex enriches it from
   * the download record and an install does not reliably keep one.
   */
  const alreadyInstalled = [
    {
      id: EXISTING_ID,
      name: "Rock Textures",
      nexusModId: 100,
      nexusFileId: 200,
    },
  ];

  /**
   * Record that a previous run of this collection installed this mod, the way
   * an interrupted run would have. Without this the mod is, correctly,
   * somebody else's and must not be touched.
   */
  async function journalOurs(w: World, compareKey: string) {
    const { appendJournalEntry } = await import(
      "../../src/core/installer/installJournal"
    );
    await appendJournalEntry(
      w.appDataPath,
      "00000000-0000-4000-8000-000000000000",
      {
        compareKey,
        vortexModId: EXISTING_ID,
        decision: "nexus-download",
        at: new Date().toISOString(),
      },
    );
  }

  it("reinstalls it, rather than reporting it and moving on", async () => {
    world = makeWorld({ mods: [MOD] });
    const manifest = await packageFrom(world);
    const fake = makeFakeVortex({
      gameId: world.gameId,
      downloads: { [ARCHIVE_ID]: "mod.zip" },
      stagingRoot: world.stagingRoot,
      // The repair downloads again and this time everything lands.
      installProduces: () => ({
        "Textures/rock.dds": "the bytes the curator shipped",
        "Data/rock.esp": "a plugin",
      }),
    });
    seedHalfInstalled(world, fake);
    // An earlier run of this collection put it here — so it is ours to fix.
    await journalOurs(world, manifest.mods[0]!.compareKey);

    const result = (await install(manifest, fake, alreadyInstalled)) as {
      kind: string;
      verifications?: Array<{ kind: string; retryAttempted?: boolean }>;
    };

    expect(result.kind, why(result)).toBe("success");

    // THE assertion. Before this change the plan installed nothing at all
    // (the mod was already there) and the driver left the broken copy alone,
    // so `installed` was empty and the receipt said "fail".
    expect(fake.installed).toHaveLength(1);
    expect(result.verifications?.[0]?.kind).toBe("ok");
    expect(result.verifications?.[0]?.retryAttempted).toBe(true);
  });

  it("does NOT touch one whose files are all present and correct", async () => {
    // The other half, and the reason the old guard existed: a mod that is
    // genuinely fine must not be reinstalled just because we did not install
    // it. Without this the change trades one wasted-work bug for another.
    world = makeWorld({ mods: [MOD] });
    const manifest = await packageFrom(world);
    const fake = makeFakeVortex({
      gameId: world.gameId,
      downloads: { [ARCHIVE_ID]: "mod.zip" },
      stagingRoot: world.stagingRoot,
    });

    const dir = nodePath.join(world.stagingRoot, EXISTING_ID);
    fs.mkdirSync(nodePath.join(dir, "Textures"), { recursive: true });
    fs.mkdirSync(nodePath.join(dir, "Data"), { recursive: true });
    fs.writeFileSync(
      nodePath.join(dir, "Textures", "rock.dds"),
      "the bytes the curator shipped",
    );
    fs.writeFileSync(nodePath.join(dir, "Data", "rock.esp"), "a plugin");
    const mods = (
      fake.api.getState().persistent as {
        mods: Record<string, Record<string, unknown>>;
      }
    ).mods[world.gameId]!;
    mods[EXISTING_ID] = {
      id: EXISTING_ID,
      installationPath: EXISTING_ID,
      type: "",
      archiveId: ARCHIVE_ID,
      attributes: { name: "Rock Textures", version: "1.0.0" },
    };

    const result = (await install(manifest, fake, alreadyInstalled)) as {
      kind: string;
      verifications?: Array<{ kind: string; retryAttempted?: boolean }>;
    };

    expect(result.kind, why(result)).toBe("success");
    expect(fake.installed).toHaveLength(0);
    expect(result.verifications?.[0]?.kind).toBe("ok");
    expect(result.verifications?.[0]?.retryAttempted).toBeFalsy();
  });
});

/**
 * ──────────────────────────────────────────────────────────────────────
 * A resume continues its profile instead of forking a new one.
 *
 * Five restarts produced five profiles in one tester's log, because an
 * interrupted run leaves no receipt and so picks fresh-profile mode again.
 * Enablement is per-profile, so the mods from the earlier runs read
 * "Disabled" in the newest profile — which is what the user saw and
 * reasonably reported as "Event Horizon installs mods disabled".
 * ──────────────────────────────────────────────────────────────────────
 */
describe("resuming an interrupted install", () => {
  const RESUME_PROFILE = "profile-from-the-last-attempt";

  /** Every `setModEnabled` this run dispatched, as (profileId, modId). */
  function enablesFrom(
    fake: ReturnType<typeof makeFakeVortex>,
  ): Array<{ profileId: string; modId: string; enabled: boolean }> {
    return fake.dispatched
      .filter(
        (a): a is { type: string; payload: { profileId: string; modId: string; enabled: boolean } } =>
          (a as { type?: string })?.type === "STUB_SET_MOD_ENABLED",
      )
      .map((a) => a.payload);
  }

  it("installs into the named profile and creates none", async () => {
    world = makeWorld({ mods: [MOD] });
    const manifest = await packageFrom(world);
    const fake = makeFakeVortex({
      gameId: world.gameId,
      downloads: { [ARCHIVE_ID]: "mod.zip" },
      stagingRoot: world.stagingRoot,
      installProduces: () => ({
        "Textures/rock.dds": "the bytes the curator shipped",
        "Data/rock.esp": "a plugin",
      }),
    });
    // The profile the interrupted attempt was filling, still present.
    (
      fake.api.getState().persistent as {
        profiles: Record<string, unknown>;
      }
    ).profiles[RESUME_PROFILE] = {
      id: RESUME_PROFILE,
      gameId: world.gameId,
      name: "Verification E2E (Event Horizon v1.0.0)",
      modState: {},
    };

    const result = (await install(manifest, fake, [], {
      kind: "fresh-profile",
      suggestedProfileName: "Verification E2E (Event Horizon v1.0.0)",
      resumeProfileId: RESUME_PROFILE,
      resumeProfileName: "Verification E2E (Event Horizon v1.0.0)",
    })) as { kind: string };

    expect(result.kind, why(result)).toBe("success");

    // No new profile. This is the whole fix: five restarts used to mean five.
    expect(
      fake.dispatched.filter(
        (a) => (a as { type?: string })?.type === "STUB_SET_PROFILE",
      ),
    ).toHaveLength(0);

    // And the mod is enabled IN THAT PROFILE — enabling it in a profile the
    // user is not looking at is indistinguishable from not enabling it.
    const enables = enablesFrom(fake);
    expect(enables.length).toBeGreaterThan(0);
    for (const e of enables) {
      expect(e.profileId).toBe(RESUME_PROFILE);
      expect(e.enabled).toBe(true);
    }
  });

  it("creates one when there is nothing to resume", async () => {
    // The unchanged first-install path. Without this the fix could silently
    // stop creating profiles altogether.
    world = makeWorld({ mods: [MOD] });
    const manifest = await packageFrom(world);
    const fake = makeFakeVortex({
      gameId: world.gameId,
      downloads: { [ARCHIVE_ID]: "mod.zip" },
      stagingRoot: world.stagingRoot,
      installProduces: () => ({
        "Textures/rock.dds": "the bytes the curator shipped",
        "Data/rock.esp": "a plugin",
      }),
    });

    const result = (await install(manifest, fake)) as { kind: string };

    expect(result.kind, why(result)).toBe("success");
    expect(
      fake.dispatched.filter(
        (a) => (a as { type?: string })?.type === "STUB_SET_PROFILE",
      ).length,
    ).toBe(1);
  });
});

/**
 * ──────────────────────────────────────────────────────────────────────
 * A mod the USER installed is never uninstalled to make it match.
 *
 * Two changes combined into data loss. Relaxing the Nexus match so an absent
 * archive hash still counts widened "already installed" from the mods we
 * installed to every mod whose Vortex attributes CLAIM those ids — attributes
 * an importer or a hand edit can set. Making already-installed mods eligible
 * for repair then pointed `util.removeMods` at that population.
 *
 * The path is short: the user's copy carries their OWN FOMOD answers, the
 * resolver adopts it without replaying the curator's, verification fails
 * because the curator's answers selected files this copy does not have, and
 * `judgeReinstall` returns `reinstall` for missing files before it even opens
 * the archive. Then we delete the mod — staging folder and all — from a
 * profile `installPlan.ts` promises is "byte-untouched".
 *
 * The install journal is what makes the question answerable from evidence
 * rather than from base rates.
 * ──────────────────────────────────────────────────────────────────────
 */
describe("a mod we did not install is never destroyed to repair it", () => {
  const THEIR_ID = "a-mod-the-user-installed-themselves";

  it("reports the mismatch and leaves the mod alone", async () => {
    world = makeWorld({ mods: [MOD] });
    const manifest = await packageFrom(world);
    const fake = makeFakeVortex({
      gameId: world.gameId,
      downloads: { [ARCHIVE_ID]: "mod.zip" },
      stagingRoot: world.stagingRoot,
    });

    // Their copy: the curator's plugin, but missing a file the curator has —
    // the shape a different FOMOD answer produces, and the one judgeReinstall
    // refuses to excuse.
    const dir = nodePath.join(world.stagingRoot, THEIR_ID);
    fs.mkdirSync(nodePath.join(dir, "Data"), { recursive: true });
    fs.writeFileSync(nodePath.join(dir, "Data", "rock.esp"), "a plugin");
    const mods = (
      fake.api.getState().persistent as {
        mods: Record<string, Record<string, unknown>>;
      }
    ).mods[world.gameId]!;
    mods[THEIR_ID] = {
      id: THEIR_ID,
      installationPath: THEIR_ID,
      type: "",
      archiveId: ARCHIVE_ID,
      attributes: { name: "Rock Textures", version: "1.0.0" },
    };

    // NO journal entry — we have no record of ever installing this.
    const result = (await install(manifest, fake, [
      { id: THEIR_ID, name: "Rock Textures", nexusModId: 100, nexusFileId: 200 },
    ])) as {
      kind: string;
      verifications?: Array<{ kind: string; retryAttempted?: boolean }>;
    };

    expect(result.kind, why(result)).toBe("success");

    // THE assertion: nothing was installed, so nothing was uninstalled. With
    // the guard removed this ran a full uninstall + reinstall cycle.
    expect(fake.installed).toHaveLength(0);

    // Their file is still on disk, exactly as they left it.
    expect(fs.existsSync(nodePath.join(dir, "Data", "rock.esp"))).toBe(true);

    // And the finding is still REPORTED — refusing to destroy their work is
    // not the same as pretending the mod matches.
    expect(result.verifications?.[0]?.kind).toBe("fail");
    expect(result.verifications?.[0]?.retryAttempted).toBeFalsy();
  });
});
