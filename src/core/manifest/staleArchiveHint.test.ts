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
  type StagedFileTime,
} from "./staleArchiveHint";

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

  it("says it is a sample when it only looked at some", () => {
    expect(describeStaleArchive("m", hint)).toContain("checked 6 of them");
  });

  it("says why it is worth checking BEFORE answering the decision", () => {
    // The consequence that makes this more than tidiness: the manifest
    // records this file's checksum as the one a player's download is held to.
    const msg = describeStaleArchive("m", hint);
    expect(msg).toMatch(/told it is wrong/);
  });
});
