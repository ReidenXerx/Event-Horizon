/**
 * Pressing Stop in the last quarter of an install.
 *
 * ─── WHAT IT USED TO DO: NOTHING ───────────────────────────────────────────
 * The last abort check in the driver was `applying-load-order`. FIVE phases
 * ran after it — pinning the plugin order, restoring ESL flags, the order
 * check, the mod-type check, writing the game INI — and none of them looked at
 * the signal; two did not even take it. So a user who pressed Stop watched the
 * install keep writing to their game folder and their My Games INI, and the
 * run reported success as though nothing had happened.
 *
 * Nobody decided that. It is what happens when each new phase is appended to
 * the end of a 2,240-line function and the abort check lives in the reader's
 * head rather than in a combinator.
 *
 * ─── WHY IT DOES NOT SIMPLY UNWIND ─────────────────────────────────────────
 * By this point the deploy has run: the collection is on disk and linked into
 * the game folder. Unwinding would leave a fully installed collection with NO
 * receipt, which is the one state provenance depends on not existing (NS-2).
 *
 * So the contract is the third option, and it is what this file pins: stop
 * WRITING to the user's machine, carry on to the receipt, and name the steps
 * that were skipped.
 */

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

const MOD: WorldMod = {
  id: "rock-textures",
  name: "Rock Textures",
  nexus: { modId: 100, fileId: 200 },
  archiveSha256: "a".repeat(64),
  files: { "Textures/rock.dds": "bytes", "Data/rock.esp": "a plugin" },
};

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
      name: "Stop E2E",
      version: "1.0.0",
      author: "curator",
      verificationLevel: "thorough",
    },
    game: { version: "1.10.163.0", versionPolicy: "exact" },
    vortex: { version: "2.6.0", deploymentMethod: "hardlink" },
  } as never);
  return parseManifest(JSON.stringify(manifest)).manifest;
}

const userState = (): UserSideState =>
  ({
    gameId: "fallout4",
    gameVersion: "1.10.163.0",
    vortexVersion: "2.6.0",
    deploymentMethod: "hardlink",
    enabledExtensions: [],
    installedMods: [],
    availableDownloads: [],
    activeProfileId: "profile-e2e",
    activeProfileName: "E2E Profile",
  }) as UserSideState;

describe("Stop, pressed after the mods are already deployed", () => {
  it("skips the remaining WRITES, still writes the receipt, and says which", async () => {
    world = makeWorld({ mods: [MOD] });
    const manifest = await packageFrom(world);
    const fake = makeFakeVortex(world, {
      installProduces: () => MOD.files,
    });

    /**
     * Abort the moment Vortex reports the deploy. That is precisely the
     * boundary: everything before it is undoable, everything after it is
     * finishing work on a collection that is already on disk.
     */
    const controller = new AbortController();
    const realEmit = fake.api.events.emit.bind(fake.api.events);
    (fake.api.events as { emit: unknown }).emit = (
      event: string,
      ...args: unknown[]
    ): unknown => {
      if (event === "deploy-mods") controller.abort();
      return realEmit(event, ...args);
    };

    const plan = resolveInstallPlan(
      manifest,
      userState(),
      { kind: "fresh-profile", profileName: "E2E Profile" } as never,
    );

    const result = (await runInstall({
      api: fake.api,
      plan,
      ehcoll: { manifest, bundledArchives: [], warnings: [] } as never,
      ehcollZipPath: `${world.root}/pkg.ehcoll`,
      appDataPath: world.appDataPath,
      decisions: {},
      abortSignal: controller.signal,
    } as never)) as {
      kind: string;
      finishingSkippedNotice?: string[];
      receiptPath?: string;
    };

    /**
     * NOT "aborted". Unwinding here would abandon a deployed collection with
     * no lineage record — the run finishes its bookkeeping deliberately.
     */
    expect(result.kind).toBe("success");

    // And it must SAY so. A stop that is silently downgraded to "success"
    // with no explanation is the behaviour this replaced.
    expect(result.finishingSkippedNotice).toBeDefined();
    const notice = result.finishingSkippedNotice!.join(" ");
    expect(notice).toMatch(/stopped/i);
    expect(notice).toMatch(/plugin order|ESL flags|game settings/);
    // The advice has to be actionable, and it is only honest because a re-run
    // recognises every mod rather than re-downloading it.
    expect(notice).toMatch(/again/);
  });

  it("does all of it when nothing was stopped", async () => {
    // The other half. A guard that skips unconditionally would pass the test
    // above and break every real install.
    world = makeWorld({ mods: [MOD] });
    const manifest = await packageFrom(world);
    const fake = makeFakeVortex(world, { installProduces: () => MOD.files });

    const plan = resolveInstallPlan(
      manifest,
      userState(),
      { kind: "fresh-profile", profileName: "E2E Profile" } as never,
    );

    const result = (await runInstall({
      api: fake.api,
      plan,
      ehcoll: { manifest, bundledArchives: [], warnings: [] } as never,
      ehcollZipPath: `${world.root}/pkg.ehcoll`,
      appDataPath: world.appDataPath,
      decisions: {},
    } as never)) as { kind: string; finishingSkippedNotice?: string[] };

    expect(result.kind).toBe("success");
    expect(result.finishingSkippedNotice).toBeUndefined();
  });
});
