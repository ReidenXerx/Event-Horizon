/**
 * ──────────────────────────────────────────────────────────────────────
 * An update must recognise the copy the previous update put there, even
 * when nothing on the player's disk can prove it any more.
 *
 * leadsheet, Ivy 1.0.50 (2026-10-17): the bundled "Knockout - Player KO
 * Balanced" is a single MCM settings ini, byte-identical in every manifest
 * from 1.0.33 to 1.0.50, and the update installed a second copy beside the
 * first. Archive sha needs the archive (gone from downloads); the staging-set
 * hash leaves player settings out, so a settings-only mod has none. The
 * receipt of the previous install names the pool mod for that compareKey.
 * ──────────────────────────────────────────────────────────────────────
 */
import { describe, expect, it } from "vitest";

import { resolveInstallPlan } from "./resolveInstallPlan";
import type { EhcollManifest } from "../../types/ehcoll";

const PKG = "123e4567-e89b-12d3-a456-426614174000";
const SHA = "f98a82de2eaf83e3362343cdf78868dec445640e28a6e7b0273c56fa6c3e485f";
const KEY = `external:${SHA}`;

function manifest(): EhcollManifest {
  return {
    schemaVersion: 2,
    package: {
      id: PKG,
      name: "Ivy's Panties",
      version: "1.0.50",
      createdAt: "2026-10-16T00:27:00Z",
      author: "a",
      strictMissingMods: false,
      verificationLevel: "thorough",
    },
    game: { id: "fallout4", name: "Fallout 4", version: "1.10.984", versionPolicy: "minimum" },
    vortex: { version: "2.6.0", deploymentMethod: "hardlink", requiredExtensions: [] },
    mods: [
      {
        compareKey: KEY,
        name: "Knockout - Player KO Balanced",
        source: { kind: "external", sha256: SHA, expectedFilename: "Knockout - Player KO Balanced.zip", bundled: true },
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

const tag = (extra: Record<string, unknown> = {}) => ({
  collectionPackageId: PKG,
  collectionVersion: "1.0.49",
  originalCompareKey: KEY,
  installedAt: "2026-10-01T10:00:00Z",
  ownership: "installed",
  ...extra,
});

function decide(installed: unknown[]): { kind: string; existingModId?: string } {
  const plan = resolveInstallPlan(
    manifest(),
    {
      gameId: "fallout4",
      gameVersion: "1.10.984",
      vortexVersion: "2.6.0",
      deploymentMethod: "hardlink",
      enabledExtensions: [],
      activeProfileId: "p1",
      activeProfileName: "Ivy 1.0.49",
      installedMods: installed,
      availableDownloads: [],
      externalDependencyState: undefined,
      previousInstall: { packageId: PKG, packageVersion: "1.0.49", installedAt: "2026-10-01T10:00:00Z", modCount: 1 },
    } as never,
    { kind: "fresh-profile", profileName: "Ivy 1.0.50" } as never,
  );
  return plan.modResolutions[0]!.decision as never;
}

// The real-world shape: no archive hash (download deleted), no staging hash (settings only).
const OLD_COPY = {
  id: "Knockout - Player KO Balanced",
  name: "Knockout - Player KO Balanced",
  enabled: true,
  installTime: "2026-10-01T09:59:30Z",
};

describe("recognising our own copy by the previous install's receipt", () => {
  it("adopts the copy the receipt names instead of installing a second one beside it", () => {
    expect(decide([{ ...OLD_COPY, eventHorizonInstall: tag() }])).toEqual({
      kind: "external-already-installed",
      existingModId: "Knockout - Player KO Balanced",
    });
  });

  it("without the receipt it cannot know, and installs from the bundle (the bug's path)", () => {
    expect(decide([OLD_COPY]).kind).toBe("external-use-bundled");
  });

  it("does not adopt a mod installed again at that id after the receipt was written", () => {
    expect(decide([{ ...OLD_COPY, installTime: "2026-10-05T00:00:00Z", eventHorizonInstall: tag() }]).kind).toBe(
      "external-use-bundled",
    );
  });

  it("does not adopt another collection's record, or another compareKey", () => {
    expect(decide([{ ...OLD_COPY, eventHorizonInstall: tag({ collectionPackageId: "other" }) }]).kind).toBe("external-use-bundled");
    expect(decide([{ ...OLD_COPY, eventHorizonInstall: tag({ originalCompareKey: "external:" + "0".repeat(64) }) }]).kind).toBe(
      "external-use-bundled",
    );
  });

  it("of two recorded copies (a twin an older update left), takes the enabled one", () => {
    const twin = { ...OLD_COPY, id: "Knockout twin", enabled: false, installTime: "2026-10-01T09:59:50Z", eventHorizonInstall: tag() };
    expect(decide([twin, { ...OLD_COPY, eventHorizonInstall: tag() }]).existingModId).toBe("Knockout - Player KO Balanced");
  });
});
