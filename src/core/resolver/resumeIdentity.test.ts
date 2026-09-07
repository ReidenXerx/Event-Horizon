/**
 * ──────────────────────────────────────────────────────────────────────
 * Resuming an interrupted install must not reinstall what it already did.
 *
 * A tester restarted a 1,755-mod install several times and was met with
 * Vortex's "X is already installed on your system — replace the existing mod,
 * or install as a variant?" dialog, hundreds of times, each needing a click.
 *
 * `findInstalledByNexusExact` demanded that the installed mod carry an
 * `archiveSha256` equal to the manifest's. Vortex does not reliably keep one
 * on an INSTALLED mod — it is enriched from the download record, and a
 * download that was cleaned up or never hashed leaves it missing. So a mod
 * Event Horizon had installed itself minutes earlier failed its own identity
 * check and was queued for download again.
 *
 * The type had already written down the correct rule and the code did the
 * opposite: "Optional because un-enriched snapshots may lack it; absence is
 * treated as 'byte-identity unknown' not 'different bytes'."
 *
 * From the tester's log: 1,993 install starts across 1,107 distinct mods,
 * only 95 recognised as already installed. On the last resume 754 were
 * reinstalled and 89 recognised — and one mod was recognised in run 4 and
 * reinstalled in run 5, which is what proves this is identity, not state.
 * ──────────────────────────────────────────────────────────────────────
 */
import { describe, expect, it } from "vitest";

import { resolveInstallPlan } from "./resolveInstallPlan";
import type { EhcollManifest } from "../../types/ehcoll";

const SHA = "c".repeat(64);

/** One Nexus mod, the shape a resume has to recognise. */
function manifest(): EhcollManifest {
  return {
    schemaVersion: 1,
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
    vortex: { version: "2.6.0", deploymentMethod: "hardlink", requiredExtensions: [] },
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

function decide(installed: unknown[], downloads: unknown[] = []): string {
  const plan = resolveInstallPlan(
    manifest(),
    {
      gameId: "skyrimse",
      gameVersion: "1.6.640",
      vortexVersion: "2.6.0",
      deploymentMethod: "hardlink",
      enabledExtensions: [],
      activeProfileId: "p1",
      activeProfileName: "P",
      installedMods: installed,
      availableDownloads: downloads,
      externalDependencyState: undefined,
    } as never,
    { kind: "fresh-profile", profileName: "E2E" } as never,
  );
  return plan.modResolutions[0]!.decision.kind;
}

const INSTALLED_NO_HASH = {
  id: "dca-mod",
  name: "Dynamic Crafting Animations",
  nexusModId: 116422,
  nexusFileId: 576517,
  // archiveSha256 deliberately absent — the real-world shape.
};

describe("recognising a mod this tool installed a moment ago", () => {
  it("matches on modId + fileId when no hash was ever recorded", () => {
    /**
     * The whole bug. Nexus file ids are immutable and refer to exactly one
     * uploaded file, so this pair IS the identity; the hash only adds proof
     * that the local bytes were not swapped.
     */
    expect(decide([INSTALLED_NO_HASH])).toBe("nexus-already-installed");
  });

  it("still matches when the hash IS recorded and agrees", () => {
    expect(
      decide([{ ...INSTALLED_NO_HASH, archiveSha256: SHA }]),
    ).toBe("nexus-already-installed");
  });

  it("REFUSES when a recorded hash disagrees", () => {
    /**
     * The half that must not be relaxed. A hash we have and that differs is
     * positive evidence of different bytes — someone replaced the archive —
     * and treating that as the same mod would install the wrong thing and
     * call it correct.
     */
    expect(
      decide([{ ...INSTALLED_NO_HASH, archiveSha256: "d".repeat(64) }]),
    ).not.toBe("nexus-already-installed");
  });

  it("does not match a different file of the same mod", () => {
    // A newer file on the same page is a different install, not this one.
    expect(
      decide([{ ...INSTALLED_NO_HASH, nexusFileId: 999999 }]),
    ).not.toBe("nexus-already-installed");
  });

  it("does not match a different mod that shares a file id", () => {
    expect(
      decide([{ ...INSTALLED_NO_HASH, nexusModId: 999 }]),
    ).not.toBe("nexus-already-installed");
  });

  it("prefers being already installed over re-using a local download", () => {
    /**
     * The exact decision the tester's log recorded 754 times on one resume:
     * `nexus-use-local-download` for mods that were already installed. The
     * archive was in Downloads, so the fallback rung matched and the mod was
     * installed a second time.
     */
    expect(
      decide([INSTALLED_NO_HASH], [
        { archiveId: "a1", localPath: "C:/dl/dca.7z", sha256: SHA },
      ]),
    ).toBe("nexus-already-installed");
  });
});
