/**
 * ──────────────────────────────────────────────────────────────────────
 * From the curator's click to the built manifest — the seam nothing covered.
 *
 * Answering "mirror this mod" travels a long way: the button writes an
 * override into the collection config, a LATER build reads that file back,
 * overlays it onto the profile's mods, emits it into the manifest, and uses it
 * to decide which bytes to pack. Every step had tests. The chain did not, and
 * a chain of tested steps is exactly what both crashes this project shipped
 * were made of.
 *
 * The specific risk this closes: `mirrored` is a NEW field on
 * `ExternalModConfigEntry`. The config's reader is protected by a compile-time
 * table — adding a field without a reader is a build error — but nothing
 * equivalent guards the WRITER. A serializer that whitelisted known keys would
 * drop the answer on save, the curator would tick the box, and the next build
 * would find nothing. The failure would be invisible: no error, just a
 * collection that quietly does not mirror.
 * ──────────────────────────────────────────────────────────────────────
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  loadOrCreateCollectionConfig,
  saveCollectionConfig,
  type CollectionConfig,
} from "../../../core/manifest/collectionConfig";
import { overrideForChoice } from "./postProcessingDecision";
import {
  applyPostProcessedDeclarations,
  collectMirrorPayload,
} from "./engine";
import type { AuditorMod } from "../../../core/getModsListForProfile";
import type { types } from "@nexusmods/vortex-api";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "eh-chain-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const SLUG = "my-collection";

/** Write one curator answer the way the panel does, then read it back. */
async function roundTrip(
  modId: string,
  patch: Record<string, unknown>,
): Promise<CollectionConfig> {
  const { config } = await loadOrCreateCollectionConfig({
    configDir: dir,
    slug: SLUG,
  });
  await saveCollectionConfig({
    configDir: dir,
    slug: SLUG,
    config: {
      ...config,
      externalMods: {
        ...config.externalMods,
        [modId]: { ...config.externalMods[modId], ...patch },
      },
    },
  });
  const reloaded = await loadOrCreateCollectionConfig({
    configDir: dir,
    slug: SLUG,
  });
  return reloaded.config;
}

const mod = (id: string, over: Partial<AuditorMod> = {}): AuditorMod =>
  ({
    id,
    name: id,
    enabled: true,
    modType: "",
    rules: [],
    fileOverrides: [],
    enabledINITweaks: [],
    hasInstallerChoices: false,
    hasDetailedInstallerChoices: false,
    ...over,
  }) as AuditorMod;

describe("the curator's answer survives being written down", () => {
  it("carries `mirrored` through save and load", async () => {
    // The compile-time table guards the READER. Nothing guards the writer, so
    // a whitelisting serializer would silently drop this and the next build
    // would find nothing — no error, just a collection that does not mirror.
    const patch = overrideForChoice("mirror", { isNexusMod: true });
    // The other two verdicts are explicitly cleared, because this patch is
    // merged onto whatever the entry already carried.
    expect(patch).toMatchObject({ mirrored: true });

    const config = await roundTrip("apocalypse", patch);
    expect(config.externalMods.apocalypse?.mirrored).toBe(true);
  });

  it("does not lose an answer the curator gave earlier", async () => {
    // The panel merges rather than replaces: a mod may already carry a URL or
    // instructions typed into the build form.
    await roundTrip("apocalypse", { url: "https://example.invalid" });
    const config = await roundTrip("apocalypse", { mirrored: true });
    expect(config.externalMods.apocalypse).toMatchObject({
      url: "https://example.invalid",
      mirrored: true,
    });
  });

  it("keeps declaring and mirroring apart", async () => {
    const config = await roundTrip(
      "xlodgen",
      overrideForChoice("declare", { isNexusMod: true }),
    );
    expect(config.externalMods.xlodgen?.postProcessed).toBe(true);
    // Written as an explicit false by the exclusive patch; what matters is
    // that it is not mirroring.
    expect(config.externalMods.xlodgen?.mirrored).not.toBe(true);
  });
});

describe("and reaches the build that comes after it", () => {
  it("overlays onto the mod the next build reads", async () => {
    const config = await roundTrip("apocalypse", { mirrored: true });
    const [overlaid] = applyPostProcessedDeclarations(
      [mod("apocalypse"), mod("untouched")],
      config,
    );
    expect(overlaid!.mirrored).toBe(true);
  });

  it("leaves every other mod alone", async () => {
    const config = await roundTrip("apocalypse", { mirrored: true });
    const mods = applyPostProcessedDeclarations(
      [mod("apocalypse"), mod("untouched")],
      config,
    );
    expect(mods[1]!.mirrored).not.toBe(true);
  });

  it("carries BOTH answers when a mod has both", async () => {
    // They are not exclusive: a mod can be declared post-processed AND
    // mirrored, and an overlay that handled one would silently drop the other.
    await roundTrip("both", { postProcessed: true });
    const config = await roundTrip("both", { mirrored: true });
    const [m] = applyPostProcessedDeclarations([mod("both")], config);
    expect(m).toMatchObject({ postProcessed: true, mirrored: true });
  });

  it("drops a mirror answer that a later bundle answer outranks", async () => {
    // The build form's source picker sets "bundle" without clearing "mirror".
    // The payload collector follows the bundle answer and collects nothing, so
    // a mod still marked mirrored was refused by the packager for files it had
    // been told not to collect.
    await roundTrip("switched", { mirrored: true, postProcessed: true });
    const config = await roundTrip("switched", { bundled: true });
    const [m] = applyPostProcessedDeclarations([mod("switched")], config);
    expect(m!.mirrored).not.toBe(true);
    expect(m!.postProcessed).toBe(true);
  });

  it("makes the payload collector pick that mod up", async () => {
    // The far end of the chain: a mod nobody marked contributes nothing, and
    // the marked one is what the package would carry.
    const config = await roundTrip("apocalypse", { mirrored: true });
    const mods = applyPostProcessedDeclarations(
      [
        mod("apocalypse", {
          installationPath: "apocalypse",
          stagingFiles: [{ path: "Data/a.esp", size: 10, sha256: "a".repeat(64) }],
        } as never),
        mod("untouched", {
          installationPath: "untouched",
          stagingFiles: [{ path: "Data/b.esp", size: 10, sha256: "b".repeat(64) }],
        } as never),
      ],
      config,
    );

    const state = {
      settings: { mods: { installPath: { skyrimse: dir } } },
    } as unknown as types.IState;
    const payload = collectMirrorPayload(state, "skyrimse", mods);

    expect(payload.map((p) => p.sha256)).toEqual(["a".repeat(64)]);
  });

  it("leaves out the files the mod's own archive provides", () => {
    // The payload step names them in `mirrorFromArchive`. Carrying them anyway
    // re-hosted the author's unchanged files, executables included, and got a
    // real package quarantined.
    const mods = [
      mod("apocalypse", {
        mirrored: true,
        installationPath: "apocalypse",
        stagingFiles: [
          { path: "Data/a.esp", size: 10, sha256: "a".repeat(64) },
          { path: "Tools/Author.exe", size: 10, sha256: "b".repeat(64) },
        ],
        mirrorFromArchive: ["Tools/Author.exe"],
      }),
    ];
    const state = {
      settings: { mods: { installPath: { skyrimse: dir } } },
    } as unknown as types.IState;

    expect(collectMirrorPayload(state, "skyrimse", mods).map((p) => p.sha256)).toEqual([
      "a".repeat(64),
    ]);
  });
});
