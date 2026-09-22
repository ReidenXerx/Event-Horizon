/**
 * The real case, and the one that must stay quiet.
 *
 * `bodyslides_f4_sd` compared September staging against a July archive and
 * reported 1,176 files "its archive cannot produce". True of the file on the
 * curator's disk; false of the file players download, which had been
 * re-uploaded. The numbers below are that build's: archive 2026-07-13,
 * staging regenerated 2026-09-18, 1,130 changed at identical sizes plus 46
 * new = the 1,176 reported.
 */
import { describe, expect, it } from "vitest";

import {
  describeStaleArchive,
  detectStaleArchive,
  type StagedFileTime, toolWrittenConfig } from "./staleArchiveHint";

const JULY = Date.parse("2026-07-13T00:16:38Z");
const SEPT = Date.parse("2026-09-18T20:03:57Z");

const files = (n: number, at: number): StagedFileTime[] =>
  Array.from({ length: n }, (_, i) => ({ path: `Meshes/f${i}.nif`, mtimeMs: at + i }));

describe("detectStaleArchive", () => {
  it("fires when every diverging file was written after the archive", () => {
    const hint = detectStaleArchive({
      archiveMtimeMs: JULY,
      diverging: files(6, SEPT),
      divergingTotal: 1176,
    });
    expect(hint).toBeDefined();
    expect(hint?.newerCount).toBe(6);
    expect(hint?.sampled).toBe(6);
    expect(hint?.diverging).toBe(1176);
  });

  it("stays quiet when the archive is the newer one", () => {
    // The ordinary shape: the curator edited files, then rebuilt the archive.
    expect(
      detectStaleArchive({ archiveMtimeMs: SEPT, diverging: files(6, JULY) }),
    ).toBeUndefined();
  });

  it("stays quiet when only SOME diverging files are newer", () => {
    /**
     * The honesty test. A regeneration rewrites the whole output in one run,
     * so a stale archive shows up as all of them. A mix is a curator who
     * edited a few files by hand — a real divergence with a real decision
     * behind it — and telling them to re-download would send them to replace
     * an archive that was never the problem.
     */
    const mixed = [...files(3, SEPT), ...files(3, JULY)];
    expect(
      detectStaleArchive({ archiveMtimeMs: JULY, diverging: mixed }),
    ).toBeUndefined();
  });

  it("stays quiet with nothing to look at", () => {
    expect(
      detectStaleArchive({ archiveMtimeMs: JULY, diverging: [] }),
    ).toBeUndefined();
  });

  it("ignores a difference inside the slack", () => {
    // Filesystem granularity and a clock that drifted a little are not a
    // regeneration. The real case is two months apart.
    expect(
      detectStaleArchive({
        archiveMtimeMs: JULY,
        diverging: files(3, JULY + 30_000),
      }),
    ).toBeUndefined();
  });
});

describe("describeStaleArchive", () => {
  const hint = detectStaleArchive({
    archiveMtimeMs: JULY,
    diverging: files(6, SEPT),
    divergingTotal: 1176,
  })!;

  it("gives both dates, the count, and what to do", () => {
    const msg = describeStaleArchive("bodyslides_f4_sd", hint);
    expect(msg).toContain("2026-07-13");
    expect(msg).toContain("2026-09-18");
    expect(msg).toContain("1176");
    expect(msg).toMatch(/Replace the copy in Vortex's download folder/);
  });

  it("names the link when there is one to name", () => {
    // "Re-download it" is not actionable without saying from where.
    const msg = describeStaleArchive("bodyslides_f4_sd", hint, "https://pixeldrain.com/api/file/C7dYdpsV?download");
    expect(msg).toContain("https://pixeldrain.com/api/file/C7dYdpsV?download");
  });

  it("makes the sample the CLAIM, not a parenthetical after a universal one", () => {
    /**
     * The main clause read "every one of the 1,176 differing file(s)", with
     * the sample size appended after it — and the gate that makes this hint
     * mean anything insists on EVERY sampled file precisely because "a mix is
     * a curator who edited some files by hand". The sample is not random: it
     * is the first N in verdict order, i.e. the alphabetically-earliest paths
     * (GP-4), so a regeneration that touched `textures/` and not `meshes/`
     * reads as total — under a recommendation of "there is nothing to
     * decide".
     */
    const msg = describeStaleArchive("m", hint);
    expect(msg).toContain("all 6 of the 1176 differing file(s) we checked");
    expect(msg).not.toContain("every one of the");
  });

  it("still says `every one` when the sample WAS the whole divergence", () => {
    // Hedging a complete measurement is its own kind of wrong.
    const whole = describeStaleArchive("m", { ...hint, sampled: 1176 });
    expect(whole).toContain("every one of the 1176 differing file(s)");
    expect(whole).not.toContain("we checked");
  });

  it("says why it is worth checking BEFORE answering the decision", () => {
    // The consequence that makes this more than tidiness: the manifest
    // records this file's checksum as the one a player's download is held to.
    const msg = describeStaleArchive("m", hint);
    expect(msg).toMatch(/told it is wrong/);
  });
});

/**
 * The same timestamps, the opposite cause.
 *
 * Both of these fired on the curator's real Skyrim profile while building
 * Meridia 1.0.23, and the message told them a third-party mod had been
 * "regenerated and re-uploaded". Nobody re-uploaded anything: BodySlide
 * rewrote its own Config.xml, and MCM wrote a settings file in-game.
 */
describe("a settings file a tool on this machine rewrote", () => {
  const archive = Date.parse("2025-09-28T00:00:00Z");
  const later = Date.parse("2026-09-21T03:01:00Z");

  it("recognises BodySlide's own config and MCM's settings", () => {
    expect(toolWrittenConfig("CalienteTools/BodySlide/Config.xml")).toBeDefined();
    // Windows separators: a staging walk hands these back with backslashes.
    expect(toolWrittenConfig("calientetools\\bodyslide\\config.xml")).toBeDefined();
    expect(toolWrittenConfig("MCM/Config/AchievementInjector/settings.ini")).toBeDefined();
    expect(toolWrittenConfig("MCM/Settings/SomeMod.ini")).toBeDefined();
    // Narrow on purpose: a broad rule would silence the real stale-archive case.
    expect(toolWrittenConfig("SKSE/Plugins/EngineFixes.ini")).toBeUndefined();
    expect(toolWrittenConfig("meshes/armor/body_0.nif")).toBeUndefined();
  });

  it("says it is your settings, not a re-upload", () => {
    const hint = detectStaleArchive({
      archiveMtimeMs: archive,
      diverging: [{ path: "MCM/Config/AchievementInjector/settings.ini", mtimeMs: later }],
    });
    expect(hint?.allToolWritten).toBe(true);
    const text = describeStaleArchive("Achievement Injector", hint!);
    expect(text).toMatch(/settings a tool on this machine rewrites/);
    expect(text).not.toMatch(/regenerated and re-uploaded/);
  });

  it("still blames the stale archive when one ordinary file diverges too", () => {
    // A mix is not "just settings" — the real stale case must survive.
    const hint = detectStaleArchive({
      archiveMtimeMs: archive,
      diverging: [
        { path: "CalienteTools/BodySlide/Config.xml", mtimeMs: later },
        { path: "meshes/armor/body_0.nif", mtimeMs: later },
      ],
    });
    expect(hint?.allToolWritten).toBe(false);
    expect(describeStaleArchive("A mod", hint!)).toMatch(/regenerated and re-uploaded/);
  });

  it("never reassures from a SAMPLE, because the unseen files could be anything", () => {
    const hint = detectStaleArchive({
      archiveMtimeMs: archive,
      diverging: [{ path: "MCM/Settings/X.ini", mtimeMs: later }],
      divergingTotal: 1176,
    });
    expect(hint?.allToolWritten).toBe(false);
  });
});
