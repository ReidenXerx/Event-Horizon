/**
 * ──────────────────────────────────────────────────────────────────────
 * Event Horizon installs only with HARDLINK deployment.
 *
 * This used to be one line ending "(Informational.)" and the install went
 * ahead on any method. It is not informational:
 *
 *   • COPY is proven broken for us. Vortex's purge under copy deployment
 *     rewrites plugins FROM STAGING, which undoes the collection's ESL flags
 *     — the reason the Doctor has `restore-light-flags` at all. A collection
 *     needs those flags to load past 254 plugins, so the game stops starting
 *     and nothing in the install reports anything wrong.
 *   • SYMLINK is not supported or tested. Owner decision, 2026-09-18.
 *
 * The two halves that must NOT change with it: an unreadable method still
 * lets the install proceed (a setting we cannot read is not evidence of a
 * wrong one), and this is an install-time error rather than an environment
 * check, because the environment report is shared with Play and a player
 * whose collection is already deployed must still be able to start the game.
 * ──────────────────────────────────────────────────────────────────────
 */
import { describe, expect, it } from "vitest";

import { resolveInstallPlan } from "./resolveInstallPlan";
import type { EhcollManifest, VortexDeploymentMethod } from "../../types/ehcoll";

const SHA = "c".repeat(64);

function manifest(over: Partial<EhcollManifest["vortex"]> = {}): EhcollManifest {
  return {
    schemaVersion: 2,
    package: {
      id: "123e4567-e89b-12d3-a456-426614174000",
      name: "p",
      version: "1.0.0",
      createdAt: "2026-01-01T00:00:00Z",
      author: "a",
      strictMissingMods: false,
      verificationLevel: "thorough",
    },
    game: { id: "skyrimse", name: "Skyrim SE", version: "1.6.640", versionPolicy: "minimum" },
    vortex: {
      version: "2.6.0",
      deploymentMethod: "hardlink",
      requiredExtensions: [],
      ...over,
    },
    mods: [
      {
        compareKey: "nexus:116422:576517",
        name: "Dynamic Crafting Animations",
        source: {
          kind: "nexus",
          modId: 116422,
          fileId: 576517,
          sha256: SHA,
          archiveName: "dca.7z",
          gameDomain: "skyrimspecialedition",
        },
        install: { fomodSelections: [] },
        state: {},
      },
    ],
    rules: [],
    plugins: { order: [] },
    loadOrder: [],
    userlist: { plugins: [], groups: [] },
    gameIni: { files: [] },
    externalDependencies: [],
    iniTweaks: [],
  } as unknown as EhcollManifest;
}

function planWith(
  userMethod: VortexDeploymentMethod | undefined,
  vortexMeta: Partial<EhcollManifest["vortex"]> = {},
): ReturnType<typeof resolveInstallPlan> {
  return resolveInstallPlan(
    manifest(vortexMeta),
    {
      gameId: "skyrimse",
      gameVersion: "1.6.640",
      vortexVersion: "2.6.0",
      deploymentMethod: userMethod,
      enabledExtensions: [],
      activeProfileId: "p1",
      activeProfileName: "P",
      installedMods: [],
      availableDownloads: [],
      externalDependencyState: undefined,
    } as never,
    { kind: "fresh-profile", profileName: "E2E" } as never,
  );
}

const errorsOf = (m: VortexDeploymentMethod | undefined): string[] =>
  planWith(m).compatibility.errors;

describe("hardlink is required to install", () => {
  it("installs on hardlink", () => {
    expect(errorsOf("hardlink")).toEqual([]);
    expect(planWith("hardlink").compatibility.deploymentMethod.status).toBe("ok");
  });

  it("refuses copy deployment, and says what it silently breaks", () => {
    const errors = errorsOf("copy");
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/copying/);
    expect(errors[0]).toMatch(/ESL flags/);
    // The fix belongs in the message: a refusal without the settings path is
    // a dead end for the player.
    expect(errors[0]).toMatch(/Settings → Mods → Deployment Method/);
  });

  it("refuses symlink deployment", () => {
    const errors = errorsOf("symlink");
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/symlinking/);
    expect(errors[0]).toMatch(/Settings → Mods → Deployment Method/);
  });

  it("does NOT refuse when the method cannot be read", () => {
    /**
     * Fail open, like every other probe here. Vortex does not always expose
     * the activator setting, and refusing an install over a value we could
     * not read would stop people whose setup is fine.
     */
    expect(errorsOf(undefined)).toEqual([]);
    expect(planWith(undefined).compatibility.deploymentMethod.status).toBe("unknown");
  });
});

describe("what the manifest says the curator used", () => {
  it("says nothing when the build only ASSUMED the curator's method", () => {
    /**
     * The build used to default to "hardlink" whenever Vortex's setting was
     * unreadable, so a guess became a fact in the manifest and could produce
     * a mismatch line nobody had observed. It now records the assumption
     * beside the value, and this comparison stands down.
     */
    const plan = planWith("hardlink", {
      deploymentMethod: "copy",
      deploymentMethodAssumed: true,
    });
    expect(plan.compatibility.deploymentMethod.status).toBe("unknown");
    expect(plan.compatibility.warnings.filter((w) => /Deployment method differs/.test(w))).toEqual(
      [],
    );
  });

  it("still mentions a real difference the build did observe", () => {
    // Not assumed: the curator's Vortex really said copy. The player is on
    // hardlink, so the install proceeds and the difference is worth a line.
    const plan = planWith("hardlink", { deploymentMethod: "copy" });
    expect(plan.compatibility.errors).toEqual([]);
    expect(
      plan.compatibility.warnings.some((w) => /Deployment method differs/.test(w)),
    ).toBe(true);
  });
});

describe("the assumed flag survives a package round trip", () => {
  /**
   * The manifest parser is a WHITELIST: a field it has no branch for is
   * dropped silently, so a new one that is never read back is worse than
   * useless — it looks recorded and is not.
   *
   * It is also why this is an optional sibling field rather than a new
   * "unknown" value in the deploymentMethod enum: an older Event Horizon
   * rejects an enum member it does not know and fails the WHOLE manifest,
   * which would make a package unreadable by every client already in the
   * wild. An unknown KEY is ignored by those same parsers.
   */
  /** The minimal shape a current build emits, as parseManifest demands it. */
  const raw = (vortex: Record<string, unknown>): string =>
    JSON.stringify({
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
      vortex,
      mods: [],
      rules: [],
      plugins: { order: [] },
      loadOrder: [],
      userlist: { plugins: [], groups: [] },
      iniTweaks: [],
      gameIni: { files: [] },
      externalDependencies: [],
    });

  it("keeps the flag when the build could not read the method", async () => {
    const { parseManifest } = await import("../manifest/parseManifest");
    const parsed = parseManifest(
      raw({
        version: "2.6.3",
        deploymentMethod: "hardlink",
        deploymentMethodAssumed: true,
        requiredExtensions: [],
      }),
    ).manifest;
    expect(parsed.vortex.deploymentMethodAssumed).toBe(true);
  });

  it("leaves it absent when the build read a real answer", async () => {
    const { parseManifest } = await import("../manifest/parseManifest");
    const parsed = parseManifest(
      raw({ version: "2.6.3", deploymentMethod: "copy", requiredExtensions: [] }),
    ).manifest;
    expect(parsed.vortex.deploymentMethodAssumed).toBeUndefined();
    expect(parsed.vortex.deploymentMethod).toBe("copy");
  });

  it("still reads a manifest built before the flag existed", async () => {
    // Every package already published. Nothing about them changes.
    const { parseManifest } = await import("../manifest/parseManifest");
    const parsed = parseManifest(
      raw({ version: "2.6.3", deploymentMethod: "hardlink", requiredExtensions: [] }),
    ).manifest;
    expect(parsed.vortex.deploymentMethod).toBe("hardlink");
    expect(parsed.vortex.deploymentMethodAssumed).toBeUndefined();
  });
});
