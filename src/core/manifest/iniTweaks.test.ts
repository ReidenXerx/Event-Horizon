/**
 * The build must NOT claim that INI tweaks go unapplied.
 *
 * This file used to assert the opposite, and it was wrong — while
 * `applyIniTweaks.test.ts` sat in the same repo with nine tests proving the
 * tweaks ARE applied. Two test files, one question, opposite answers.
 *
 * `applyIniTweaks.ts` reads `state.enabledINITweaks` and dispatches
 * `setINITweakEnabled(gameId, modId, tweak, true)` for each one, called from
 * `runInstallImpl`. The build's warning predated it and was never retired, so
 * curators were told to tell their testers to go and tick by hand what the
 * driver had already ticked — and anyone who complied could no longer tell
 * their own ticks from the collection's.
 *
 * A test can lock in a false claim exactly as well as a true one. This is what
 * that looks like when it happens.
 */import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { buildManifest } from "./buildManifest";
import type { AuditorMod } from "../getModsListForProfile";

const mod = (over: Partial<AuditorMod> & { id: string }): AuditorMod =>
  ({
    name: over.id,
    enabled: true,
    collectionIds: [],
    hasInstallerChoices: false,
    hasDetailedInstallerChoices: false,
    fomodSelections: [],
    rules: [],
    modType: "",
    fileOverrides: [],
    enabledINITweaks: [],
    installOrder: 0,
    nexusModId: 1,
    nexusFileId: 1,
    archiveSha256: "a".repeat(64),
    ...over,
  }) as AuditorMod;

function build(mods: AuditorMod[]): { warnings: string[]; manifest: unknown } {
  return buildManifest({
    snapshot: { gameId: "fallout4", mods } as never,
    package: {
      id: "00000000-0000-4000-8000-000000000000",
      name: "t",
      version: "1.0.0",
      author: "a",
    },
    game: { version: "1.10.163" },
    vortex: { version: "2.6.0", deploymentMethod: "hardlink" },
  } as never) as never;
}

const iniWarnings = (warnings: string[]): string[] =>
  warnings.filter((w) => w.includes("INI tweak"));

const fomodWarnings = (warnings: string[]): string[] =>
  warnings.filter((w) => w.includes("FOMOD"));

describe("enabled INI tweaks", () => {
  it("says nothing about INI tweaks, because they are applied", () => {
    const { warnings } = build([
      mod({
        id: "settings",
        name: "Ivy'sPantiesSettings",
        nexusModId: undefined,
        nexusFileId: undefined,
        enabledINITweaks: ["Fallout4Custom-Ivy-PC-Tuning.ini"],
      }),
    ]);
    expect(iniWarnings(warnings)).toEqual([]);
  });

  it("still says nothing when many mods carry many tweaks", () => {
    const { warnings } = build([
      mod({ id: "a", archiveSha256: "a".repeat(64), enabledINITweaks: ["one.ini", "two.ini"] }),
      mod({ id: "b", archiveSha256: "b".repeat(64), enabledINITweaks: ["three.ini"] }),
    ]);
    expect(iniWarnings(warnings)).toEqual([]);
  });

  it("has retired the sentence itself, not just stopped emitting it", () => {
    // The wording is the thing that misled someone, so it must be gone from
    // the source rather than merely unreachable.
    const src = readFileSync(join(__dirname, "buildManifest.ts"), "utf8");
    expect(src).not.toContain("does not apply INI tweaks yet");
    expect(src).not.toContain("enable them by hand in Vortex");
  });

  it("keeps an applier to be right about", () => {
    // If applyIniTweaks were ever deleted, the warning above would become true
    // again and its absence would become the bug. Tie the two together.
    const applier = readFileSync(
      join(__dirname, "..", "installer", "applyIniTweaks.ts"),
      "utf8",
    );
    expect(applier).toContain("state.enabledINITweaks");
    expect(applier).toContain("setINITweakEnabled");
    const driver = readFileSync(
      join(__dirname, "..", "installer", "runInstall.ts"),
      "utf8",
    );
    expect(driver).toContain("applyIniTweaks({");
  });

  it("says nothing when no tweak is enabled", () => {
    // The common case, and the one that must stay quiet: a mod can carry an
    // INI Tweaks folder without any of it being switched on.
    const { warnings } = build([mod({ id: "a", enabledINITweaks: [] })]);
    expect(iniWarnings(warnings)).toEqual([]);
  });
});

describe("recorded FOMOD choices", () => {
  // REPLAY EXISTS. `choicesFor` reads `install.fomodSelections` and
  // `runInstall` passes the result to both install paths, so the curator's
  // answers are sent to Vortex instead of the user being asked.
  //
  // These tests previously asserted the opposite — that the options "will not
  // be replayed" — and stayed green for the whole life of the replay feature,
  // because they pinned the MESSAGE rather than the behaviour. Measured on the
  // real 963-mod build: 112 of 115 replay, and the warning told the curator
  // that none did, sending them to write instructions for 115 mods that need
  // none.
  //
  // A step answered with nothing ticked is replayed too — `choicesFor` sends
  // the empty answer — so it needs no warning either.
  const unanswered = (id: string, count: number): AuditorMod =>
    mod({
      id,
      archiveSha256: id.padEnd(64, "0"),
      fomodSelections: Array.from({ length: count }, (_, i) => ({
        name: `step${i}`,
        groups: [],
      })) as never,
    });

  const answered = (id: string): AuditorMod =>
    mod({
      id,
      archiveSha256: id.padEnd(64, "0"),
      fomodSelections: [
        {
          name: "Choose Options",
          groups: [
            { name: "Patches", choices: [{ name: "AFT Plus Ivy Patch", idx: 2 }] },
          ],
        },
      ] as never,
    });

  it("says NOTHING about mods whose choices will be replayed", () => {
    // The case that matters most, and the one the old tests could not express.
    // A curator told to write instructions for a mod that already replays
    // correctly is being sent to do pointless work.
    const { warnings } = build([answered("aft")]);
    expect(fomodWarnings(warnings)).toEqual([]);
  });

  it("says nothing about steps answered with nothing ticked — those are replayed too", () => {
    // It used to warn that users would be asked to choose for these, and they
    // are not: `choicesFor` sends the empty answer and the install runs
    // unattended. A curator told otherwise writes instructions nobody needs.
    const { warnings } = build([unanswered("a", 1), unanswered("b", 8), answered("c")]);
    expect(fomodWarnings(warnings)).toEqual([]);
  });

  it("stays quiet for a collection with no recorded choices", () => {
    // Most mods report installerType "fomod" without a script or a choice.
    const { warnings } = build([mod({ id: "plain", fomodSelections: [] })]);
    expect(fomodWarnings(warnings)).toEqual([]);
  });
});
