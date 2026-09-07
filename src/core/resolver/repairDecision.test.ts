/**
 * ──────────────────────────────────────────────────────────────────────
 * How do you reinstall a mod whose decision said "it is already installed"?
 *
 * You cannot re-execute that decision. `*-already-installed` carries one
 * thing — the id of the existing mod — so re-running it hands back the id of
 * the very mod the repair just uninstalled, and the driver would "recover"
 * onto a mod that no longer exists.
 *
 * So a repair rebuilds the install decision from the MANIFEST: the one the
 * resolver would have produced had it never found a match.
 * ──────────────────────────────────────────────────────────────────────
 */
import { describe, expect, it } from "vitest";

import { repairDecisionFor } from "./resolveInstallPlan";
import type { EhcollMod } from "../../types/ehcoll";

const SHA = "e".repeat(64);

const nexusMod = {
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
} as unknown as EhcollMod;

const externalMod = (over: Record<string, unknown> = {}) =>
  ({
    compareKey: `external:sha:${SHA}`,
    name: "High_Poly_Head_v1.4_(SE)-80968",
    source: {
      kind: "external",
      sha256: SHA,
      expectedFilename: "High Poly Head.7z",
      instructions: "Download it from the mod page.",
      bundled: true,
      ...over,
    },
    install: { fomodSelections: [] },
    state: {},
  }) as unknown as EhcollMod;

describe("repairDecisionFor", () => {
  it("sends a Nexus mod back to the download it came from", () => {
    expect(repairDecisionFor(nexusMod)).toEqual({
      kind: "nexus-download",
      gameDomain: "skyrimspecialedition",
      modId: 116422,
      fileId: 576517,
      expectedSha256: SHA,
      archiveName: "dca.7z",
    });
  });

  it("sends a bundled external mod back to the package", () => {
    /**
     * The zip path must be rebuilt by the same convention the packager
     * writes, because nothing else in the repair knows where the archive
     * lives. `expectedFilename` decides the extension exactly as the
     * resolver's own bundled rung does — and when it guesses wrong, the
     * extractor recovers by sha.
     */
    expect(repairDecisionFor(externalMod())).toEqual({
      kind: "external-use-bundled",
      sha256: SHA,
      zipPath: `bundled/${SHA}.7z`,
    });
  });

  it("refuses an external mod with no bundled archive", () => {
    /**
     * The honest answer, and the reason this returns `undefined` rather than
     * a decision that fails later: there is no archive on this machine and no
     * way to fetch one, so the repair must stop BEFORE the uninstall. A
     * decision here would delete the user's only copy of the mod and then
     * discover it had nothing to install.
     */
    expect(repairDecisionFor(externalMod({ bundled: false }))).toBeUndefined();
  });

  it("refuses a bundled external mod with no hash", () => {
    // The schema forbids this pairing, but the repair path is one uninstall
    // away from destroying a mod, so it checks rather than asserting.
    expect(
      repairDecisionFor(externalMod({ sha256: undefined })),
    ).toBeUndefined();
  });
});
