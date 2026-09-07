/**
 * Curator's profile → manifest → plan → the real install driver.
 *
 * The install side was reachable only by installing a collection by hand in
 * Vortex, which is why the FOMOD gap survived: nothing exercised the call the
 * driver makes, so "the choices are recorded" and "the choices are used" were
 * indistinguishable from outside.
 *
 * This drives `runInstall` itself against a Vortex double whose whole surface
 * is what the installer actually touches. It asserts the CALLS, because that
 * is the level where every bug this cycle lived.
 */

import { createHash } from "node:crypto";
import * as fs from "fs";
import * as path from "path";

import { afterEach, describe, expect, it } from "vitest";

import { runInstall } from "../../src/core/installer/runInstall";
import { resolveInstallPlan } from "../../src/core/resolver/resolveInstallPlan";
import { parseManifest } from "../../src/core/manifest/parseManifest";
import { buildManifest } from "../../src/core/manifest/buildManifest";
import { captureStagingFiles } from "../../src/core/manifest/captureStagingFiles";
import { scopeCollectionMods } from "../../src/core/manifest/collectionScope";
import { emitsOf, makeFakeVortex } from "./fakeVortex";
import { makeZip } from "../makeZip";
import { makeWorld, type World } from "./world";
import type { EhcollManifest } from "../../src/types/ehcoll";
import type { UserSideState } from "../../src/types/installPlan";

let world: World | undefined;
afterEach(() => {
  world?.cleanup();
  world = undefined;
});

const FOMOD_CHOICES = {
  type: "fomod",
  options: [
    {
      name: "Choose Options",
      groups: [{ name: "Patches", choices: [{ name: "AFT Plus Ivy Patch", idx: 2 }] }],
    },
  ],
};

async function packageFrom(w: World): Promise<EhcollManifest> {
  const scope = scopeCollectionMods(w.mods);
  const enriched = await captureStagingFiles(w.state as never, w.gameId, scope.included, {
    level: "thorough",
  });
  const { manifest } = buildManifest({
    snapshot: { gameId: w.gameId, mods: enriched } as never,
    package: {
      id: "00000000-0000-4000-8000-000000000000",
      name: "Driver E2E",
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
    // REQUIRED on UserSideState, and previously absent — the cast hid it, and
    // tests were never typechecked so nothing objected. An end-to-end fixture
    // missing required fields is not the state the driver actually receives.
    activeProfileId: "profile-e2e",
    activeProfileName: "E2E Profile",
  }) as UserSideState;

/**
 * Drive the real driver, and if it stops making progress say WHERE.
 *
 * A driver that hangs produces a bare test timeout, which names the test and
 * not the phase. The phase list turns that into a diagnosis.
 */
async function install(
  manifest: EhcollManifest,
  fake: ReturnType<typeof makeFakeVortex>,
  previousInstall?: { packageVersion: string; gameIniApplication?: unknown },
  /**
   * What the user chose on the decisions screen. An external mod that is not
   * bundled resolves to `external-prompt-user`, and the driver REFUSES to run
   * without a matching choice — so reaching that path at all means supplying
   * one here.
   */
  decisions: unknown = {},
) {
  const phases: string[] = [];
  // A first install. `current-profile` is a different mode with its own
  // invariant (it requires a previous install from the ledger), so it belongs
  // in its own case rather than being faked here.
  const plan = resolveInstallPlan(manifest, userState(), {
    kind: "fresh-profile",
    profileName: "E2E Profile",
  } as never);
  if (previousInstall !== undefined) {
    (plan as { previousInstall?: unknown }).previousInstall = previousInstall;
  }
  const running = runInstall({
    api: fake.api,
    plan,
    ehcoll: { manifest, bundledArchives: [], warnings: [] } as never,
    // Per-world, not a shared absolute path: the old `C:/nowhere/appdata` was
    // real, written to the drive root, and shared by every e2e file — which
    // made parallel runs race on one receipt path. See World.appDataPath.
    ehcollZipPath: `${world!.root}/pkg.ehcoll`,
    appDataPath: world!.appDataPath,
    decisions,
  } as never);

  const stalled = new Promise<never>((_r, reject) =>
    setTimeout(
      () =>
        reject(
          new Error(
            `driver stalled. phases=[${phases.join(" | ")}] ` +
              `emits=[${fake.emits.map((e) => e.event).join(" | ")}] ` +
              `dispatched=[${fake.dispatched.map((d) => (d as { type?: string })?.type).join(" | ")}]`,
          ),
        ),
      3000,
    ),
  );
  return Promise.race([running, stalled]);
}

describe("install driver, end to end", () => {
  it("replays the curator's FOMOD choices instead of letting Vortex ask", async () => {
    world = makeWorld({
      mods: [
        {
          id: "fomod-mod",
          name: "A FOMOD Mod",
          nexus: { modId: 111, fileId: 222 },
          archiveSha256: "a".repeat(64),
          files: { "Data/chosen.esp": "chosen" },
          installerChoices: FOMOD_CHOICES,
        },
      ],
    });
    const manifest = await packageFrom(world);
    const fake = makeFakeVortex({ gameId: "fallout4" });

    await install(manifest, fake);

    const call = emitsOf(fake, "start-install-download")[0];
    expect(call, "the driver never asked Vortex to install").toBeDefined();
    // The whole point: the options bag carries the curator's answers.
    expect(call!.args[1]).toEqual({
      allowAutoEnable: true,
      choices: FOMOD_CHOICES,
      // Bypasses the FOMOD dialog. Vortex's installer requires all three:
      // choices present, choices.type === "fomod", unattended === true.
      unattended: true,
    });
  });

  it("replays the curator's choices for an archive the USER supplied by hand", async () => {
    // The gap this closes: an external mod is fetched by the user and pointed
    // at with "Pick a local file". That path emitted `start-install`, which
    // has no argument for installer answers — so a FOMOD supplied by hand
    // installed with DEFAULT options while the collection promised the
    // curator's. Every file present, every file correct, and the wrong ones.
    //
    // The fix registers the picked archive as a Vortex download and installs
    // it through `start-install-download`, the ONLY choices-carrying install
    // call whose shape has actually been observed on a real Vortex. This
    // asserts that call, because "it adopts the archive" and "the choices
    // reach the installer" are otherwise indistinguishable from outside.
    world = makeWorld({
      mods: [
        {
          id: "hand-supplied",
          name: "A Hand-Supplied FOMOD",
          // No `nexus` ⇒ external.
          archiveSha256: "c".repeat(64),
          files: { "Data/handpicked.esp": "handpicked" },
          installerChoices: FOMOD_CHOICES,
        },
      ],
    });
    const manifest = await packageFrom(world);
    const fake = makeFakeVortex({ gameId: "fallout4" });

    const entry = manifest.mods[0]!;
    // The archive the user "downloaded" and picked, somewhere outside Vortex.
    const picked = path.join(world.root, "user-downloads", "HandSupplied.7z");
    fs.mkdirSync(path.dirname(picked), { recursive: true });
    fs.writeFileSync(picked, Buffer.alloc(64, 7));

    await install(manifest, fake, undefined, {
      conflictChoices: {
        [entry.compareKey]: { kind: "use-local-file", localPath: picked },
      },
    });

    const call = emitsOf(fake, "start-install-download")[0];
    expect(
      call,
      "a hand-picked archive never reached the choices-carrying install call",
    ).toBeDefined();
    expect(call!.args[1]).toEqual({
      allowAutoEnable: true,
      choices: FOMOD_CHOICES,
      // Bypasses the FOMOD dialog. Vortex's installer requires all three:
      // choices present, choices.type === "fomod", unattended === true.
      unattended: true,
    });
    // And NOT through the call that cannot carry them.
    expect(emitsOf(fake, "start-install")).toEqual([]);
  });

  it("forgets a previous failure once the install succeeds", async () => {
    // A panel that keeps warning about a problem the user has just fixed
    // teaches them to ignore it.
    world = makeWorld({
      mods: [
        {
          id: "ok-mod",
          nexus: { modId: 9, fileId: 9 },
          archiveSha256: "d".repeat(64),
          files: { "Data/ok.esp": "ok" },
        },
      ],
    });
    const manifest = await packageFrom(world);
    const { listInstallAttempts, writeInstallAttempt } = await import(
      "../../src/core/installer/attemptRecord"
    );
    await writeInstallAttempt(world.appDataPath, {
      packageId: manifest.package.id,
      packageName: manifest.package.name,
      packageVersion: manifest.package.version,
      gameId: "fallout4",
      endedAt: new Date().toISOString(),
      outcome: "failed",
      phase: "installing-mods",
      installedCount: 1,
      totalMods: 1,
    });
    expect(await listInstallAttempts(world.appDataPath)).toHaveLength(1);

    const result = await install(manifest, makeFakeVortex({ gameId: "fallout4" }));
    expect((result as { kind: string }).kind).toBe("success");
    expect(await listInstallAttempts(world.appDataPath)).toEqual([]);
  });

  it("leaves a mod with no recorded choices on the original one-step path", async () => {
    // Replay must not change how the other 840 mods in a collection install.
    // A mod without choices is downloaded AND installed by Vortex in one go,
    // so the driver never emits start-install-download at all.
    world = makeWorld({
      mods: [
        {
          id: "plain",
          nexus: { modId: 333, fileId: 444 },
          archiveSha256: "b".repeat(64),
          files: { "Data/plain.esp": "plain" },
        },
      ],
    });
    // The install must actually put the mod's files on disk, or verification
    // fails and the driver correctly spends a reinstall — which would make the
    // count below 2 for a reason that has nothing to do with the one-step path
    // this test is about.
    const fake = makeFakeVortex({
      gameId: "fallout4",
      stagingRoot: world.stagingRoot,
      installProduces: () => ({ "Data/plain.esp": "plain" }),
    });

    await install(await packageFrom(world), fake);

    expect(emitsOf(fake, "start-install-download")).toEqual([]);
    expect(fake.installed).toHaveLength(1);
  });

  it("reports a refused install rather than hanging on it", async () => {
    world = makeWorld({
      mods: [
        {
          id: "fomod-mod",
          nexus: { modId: 111, fileId: 222 },
          archiveSha256: "a".repeat(64),
          files: { "Data/chosen.esp": "chosen" },
          installerChoices: FOMOD_CHOICES,
        },
      ],
    });
    const manifest = await packageFrom(world);
    const fake = makeFakeVortex({ gameId: "fallout4" });
    fake.failNextInstall("installer said no");

    const result = await install(manifest, fake);
    // However the driver classifies it, the refusal must reach the result and
    // the run must end. Silence here is a 90-second stall in the real app.
    expect(JSON.stringify(result)).toMatch(/installer said no/);
  });

  it("stops the whole run when Vortex cannot deploy, instead of grinding on", async () => {
    // A tester hit "No deployment method active" at mod 489 of 967. The driver
    // treated it as one bad mod, carried on for another 478, and died at the
    // end with no receipt — seventy minutes, and the answer was in the first
    // failure. It is a property of the MACHINE: mod 490 fails exactly as 489
    // did, and so does the nine hundredth.
    //
    // The fake fails only the FIRST install, so a driver that carries on would
    // successfully install the other two. That is the discriminator.
    world = makeWorld({
      mods: [
        { id: "a", nexus: { modId: 1, fileId: 1 }, archiveSha256: "a".repeat(64), files: { "Data/a.esp": "a" }, installerChoices: FOMOD_CHOICES },
        { id: "b", nexus: { modId: 2, fileId: 2 }, archiveSha256: "b".repeat(64), files: { "Data/b.esp": "b" }, installerChoices: FOMOD_CHOICES },
        { id: "c", nexus: { modId: 3, fileId: 3 }, archiveSha256: "c".repeat(64), files: { "Data/c.esp": "c" }, installerChoices: FOMOD_CHOICES },
      ],
    });
    const manifest = await packageFrom(world);
    const fake = makeFakeVortex({ gameId: "fallout4" });
    fake.failNextInstall("No deployment method active");

    const result = await install(manifest, fake);

    // It stopped: the two mods that WOULD have installed never did.
    expect(fake.installed).toHaveLength(0);

    // And it left a RECORD. Seven of the driver's eight failure paths return
    // before the receipt is written, so without this the run is invisible:
    // a tester had 963 mods staged and an empty "My Collections".
    const { listInstallAttempts } = await import(
      "../../src/core/installer/attemptRecord"
    );
    const attempts = await listInstallAttempts(world!.appDataPath);
    expect(attempts).toHaveLength(1);
    expect(attempts[0]?.outcome).toBe("failed");
    expect(attempts[0]?.phase).toBe("installing-mods");
    expect(attempts[0]?.error).toContain("deployment method");
    // And it said the useful thing rather than blaming the mod or the user.
    const text = JSON.stringify(result);
    expect(text).toContain("Every remaining mod would fail the same way");
    expect(text).toContain("Settings → Mods → Deployment Method");
    expect(text).toContain("nobody cancelled anything");
  });

  it("writes the collection's game settings and TELLS the user", async () => {
    // The user must hear that their configuration changed. Applying it
    // silently is not acceptable even when it is correct.
    const fs = await import("fs");
    const os = await import("os");
    const path = await import("path");
    const docs = fs.mkdtempSync(path.join(os.tmpdir(), "eh-drv-ini-"));
    const iniDir = path.join(docs, "My Games", "Fallout4");
    fs.mkdirSync(iniDir, { recursive: true });
    fs.writeFileSync(
      path.join(iniDir, "Fallout4.ini"),
      ["[General]", "uGridsToLoad=5", ""].join("\n"),
    );
    const { __testPaths } = await import("../stubs/vortex-api");
    const previousDocs = __testPaths.documentsPath;
    __testPaths.documentsPath = docs;

    world = makeWorld({
      mods: [
        { id: "m", nexus: { modId: 1, fileId: 1 }, archiveSha256: "a".repeat(64), files: { "a.esp": "a" } },
      ],
    });
    const manifest = await packageFrom(world);
    const withIni: EhcollManifest = {
      ...manifest,
      gameIni: {
        files: [
          {
            fileName: "Fallout4.ini",
            settings: [{ section: "General", key: "uGridsToLoad", value: "7" }],
          },
        ],
      },
    };

    const result = await install(withIni, makeFakeVortex({ gameId: "fallout4" }));

    expect(fs.readFileSync(path.join(iniDir, "Fallout4.ini"), "utf8")).toContain("uGridsToLoad=7");
    const notice = ((result as { gameIniNotice?: string[] }).gameIniNotice ?? []).join(" ");
    expect(notice).toMatch(/set 1 game setting/);
    expect(notice).toMatch(/uGridsToLoad: 5 → 7/);
    expect(notice).toMatch(/never re-applied/);

    __testPaths.documentsPath = previousDocs;
    fs.rmSync(docs, { recursive: true, force: true });
  });

  it("does NOT touch settings again for a version already applied", async () => {
    // The user is free to change anything afterwards; a second apply would
    // silently revert it.
    const fs = await import("fs");
    const os = await import("os");
    const path = await import("path");
    const docs = fs.mkdtempSync(path.join(os.tmpdir(), "eh-drv-ini2-"));
    const iniDir = path.join(docs, "My Games", "Fallout4");
    fs.mkdirSync(iniDir, { recursive: true });
    // The user set it back to 5 after the first install.
    fs.writeFileSync(
      path.join(iniDir, "Fallout4.ini"),
      ["[General]", "uGridsToLoad=5", ""].join("\n"),
    );
    const { __testPaths } = await import("../stubs/vortex-api");
    const previousDocs = __testPaths.documentsPath;
    __testPaths.documentsPath = docs;

    world = makeWorld({
      mods: [
        { id: "m", nexus: { modId: 1, fileId: 1 }, archiveSha256: "a".repeat(64), files: { "a.esp": "a" } },
      ],
    });
    const manifest = await packageFrom(world);
    const withIni: EhcollManifest = {
      ...manifest,
      gameIni: {
        files: [
          {
            fileName: "Fallout4.ini",
            settings: [{ section: "General", key: "uGridsToLoad", value: "7" }],
          },
        ],
      },
    };

    const result = await install(withIni, makeFakeVortex({ gameId: "fallout4" }), {
      packageVersion: withIni.package.version,
      gameIniApplication: { appliedCount: 1 },
    });

    expect(fs.readFileSync(path.join(iniDir, "Fallout4.ini"), "utf8")).toContain("uGridsToLoad=5");
    expect((result as { gameIniNotice?: string[] }).gameIniNotice).toBeUndefined();

    __testPaths.documentsPath = previousDocs;
    fs.rmSync(docs, { recursive: true, force: true });
  });
});

describe("mirroring, through the real driver", () => {
  /**
   * The gap this closes: step 6c of `runInstall` was reachable only by
   * installing a mirrored collection by hand. Every part around it was
   * covered — the plan, the applier, the proof condition — and the WIRING
   * between them was not, which is precisely the shape of the two crashes
   * that cost releases this cycle.
   *
   * So this drives the driver. The curator's folder is real bytes on disk,
   * the archive produces DIFFERENT bytes on the user's machine, and the
   * package is a real zip the real reader opens.
   */
  const sha = (s: string): string =>
    createHash("sha256").update(Buffer.from(s)).digest("hex");

  const CURATOR = {
    "Data/Cleaned.esp": "curator's cleaned plugin",
    "Data/MyPatch.ini": "a patch the curator dropped in",
  };

  /** What Vortex's install of the Nexus archive actually produces. */
  const FROM_ARCHIVE = {
    "Data/Cleaned.esp": "the uncleaned plugin from the archive",
    "Data/Leftover.txt": "in the archive, not in the curator's folder",
  };

  async function mirroredWorld() {
    world = makeWorld({
      mods: [
        {
          id: "mirrored-mod",
          nexus: { modId: 900, fileId: 901 },
          archiveSha256: "c".repeat(64),
          files: CURATOR,
        },
      ],
    });
    const manifest = await packageFrom(world!);
    // The curator answered "mirror" for this mod.
    (manifest.mods[0]!.state as { mirrored?: boolean }).mirrored = true;

    // A real package carrying the curator's bytes, content-addressed.
    fs.writeFileSync(
      `${world!.root}/pkg.ehcoll`,
      makeZip(
        Object.values(CURATOR).map((contents) => ({
          name: `mirror/${sha(contents)}`,
          data: Buffer.from(contents),
        })),
      ),
    );
    return manifest;
  }

  it("leaves the user's folder byte-identical to the curator's", async () => {
    const manifest = await mirroredWorld();
    const fake = makeFakeVortex({
      gameId: "fallout4",
      stagingRoot: world!.stagingRoot,
      installProduces: () => FROM_ARCHIVE,
    });

    await install(manifest, fake);

    /**
     * The LAST install, not the first. A mod that fails verification is
     * uninstalled and reinstalled, which gives it a NEW Vortex mod id — and a
     * mirrored mod fails verification by construction, because its staging
     * deliberately differs from the archive it came from.
     *
     * Reading the first id passed only while the driver kept pointing at the
     * mod it had just deleted. It no longer does, so the mirror follows the
     * mod that actually exists — which is the point of that fix.
     */
    const finalModId = fake.installed[fake.installed.length - 1]!.vortexModId;
    const dir = path.join(world!.stagingRoot, finalModId);
    const read = (rel: string): string =>
      fs.readFileSync(path.join(dir, ...rel.split("/")), "utf8");

    // Changed by the curator — the archive's version must not survive.
    expect(read("Data/Cleaned.esp")).toBe(CURATOR["Data/Cleaned.esp"]);
    // Added by the curator — the archive cannot produce it at all.
    expect(read("Data/MyPatch.ini")).toBe(CURATOR["Data/MyPatch.ini"]);
    // In the archive but not the curator's folder — removed.
    expect(fs.existsSync(path.join(dir, "Data", "Leftover.txt"))).toBe(false);
  });

  it("does not touch a mod the curator did not mark", async () => {
    // Mirroring is opt-in per mod. A driver that reconciled everything would
    // pass the test above and quietly rewrite 900 other mods.
    const manifest = await mirroredWorld();
    (manifest.mods[0]!.state as { mirrored?: boolean }).mirrored = false;

    const fake = makeFakeVortex({
      gameId: "fallout4",
      stagingRoot: world!.stagingRoot,
      installProduces: () => FROM_ARCHIVE,
    });
    await install(manifest, fake);

    const dir = path.join(world!.stagingRoot, fake.installed[0]!.vortexModId);
    expect(fs.readFileSync(path.join(dir, "Data", "Cleaned.esp"), "utf8")).toBe(
      FROM_ARCHIVE["Data/Cleaned.esp"],
    );
    expect(fs.existsSync(path.join(dir, "Data", "Leftover.txt"))).toBe(true);
  });

  it("survives a package that carries none of the bytes", async () => {
    // The install must still finish. A mod that cannot be mirrored is a mod
    // that does not match the curator — not a failed installation.
    const manifest = await mirroredWorld();
    fs.writeFileSync(
      `${world!.root}/pkg.ehcoll`,
      makeZip([{ name: "mirror/nothing-useful", data: Buffer.from("x") }]),
    );

    const fake = makeFakeVortex({
      gameId: "fallout4",
      stagingRoot: world!.stagingRoot,
      installProduces: () => FROM_ARCHIVE,
    });
    const result = await install(manifest, fake);

    expect((result as { kind?: string }).kind).not.toBe("failed");
  });
});
