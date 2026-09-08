/**
 * Does this filesystem think `Scripts/` and `scripts/` are the same folder?
 *
 * ─── WHY THIS IS A QUESTION AND NOT A CONSTANT ──────────────────────────────
 * Verification used to compare staging paths verbatim, which produced four
 * false "this mod could not be reproduced" reports on a real 1,755-mod install
 * because a FOMOD had written `Scripts/` where the curator recorded
 * `scripts/`. The fix was to fold case — and folding case unconditionally is
 * correct on NTFS and actively dangerous everywhere else.
 *
 * Vortex runs under Proton for a growing number of people. On ext4,
 * `Scripts/a.pex` and `scripts/a.pex` are two different files that can both
 * exist in the same folder. Fold them together there and verification passes
 * on a file that is not the one the curator shipped, and `planMirror` — which
 * DELETES what the curator's listing does not mention — can be pointed at the
 * wrong one. A cosmetic fix on Windows becomes data loss on Linux.
 *
 * ─── SO IT IS PROBED ────────────────────────────────────────────────────────
 * Not inferred from `process.platform`, because that gets it wrong in both
 * directions that matter: a Wine prefix on ext4 reports `win32` to us while
 * the directory underneath is case-sensitive, and macOS reports `darwin` while
 * APFS is usually case-INsensitive. The only reliable answer comes from asking
 * the directory itself, and it costs one file create and one stat, once.
 *
 * ─── WHEN THE PROBE CANNOT RUN ──────────────────────────────────────────────
 * The fallback is by platform, and the direction is deliberate. Guessing
 * "insensitive" on a sensitive filesystem merges two real files — the failure
 * that loses data. Guessing "sensitive" on an insensitive one brings back the
 * cosmetic false positives, which are noisy and harmless. So: `win32` falls
 * back to insensitive (it is right essentially always), and everything else
 * falls back to sensitive.
 */

import * as fsp from "fs/promises";
import * as path from "path";

import { ehLog } from "../logging/ehLog";

import type { CaseMode } from "./modPath";

/**
 * Answers are cached per directory for the life of the session.
 *
 * A staging root does not change filesystem mid-install, and the probe runs on
 * a path that is about to be walked thousands of times.
 */
const cache = new Map<string, CaseMode>();

/** What we assume when the directory cannot be asked. See the header. */
function fallbackFor(platform: string): CaseMode {
  return platform === "win32" ? "insensitive" : "sensitive";
}

/**
 * Probe `dir` and report how it treats case.
 *
 * Never throws: a directory we cannot write to is not a reason to fail an
 * install, and the fallback is the safe direction.
 */
export async function detectCaseSensitivity(
  dir: string,
  platform: string = process.platform,
): Promise<CaseMode> {
  const cached = cache.get(dir);
  if (cached !== undefined) return cached;

  /**
   * A name nothing else will collide with, in mixed case, so the lowercase
   * lookup below is a real question. The suffix keeps two concurrent probes of
   * one directory from deleting each other's file.
   */
  const stamp = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  const probe = path.join(dir, `EhCaseProbe-${stamp}.tmp`);
  const lowered = path.join(dir, `ehcaseprobe-${stamp}.tmp`);

  let mode: CaseMode;
  try {
    /**
     * The directory must ALREADY EXIST. This used to `mkdir(dir, {recursive:
     * true})`, which meant asking "how does this folder treat case" CREATED
     * the folder — including a mod's staging folder that was legitimately
     * gone, materialising an empty directory inside Vortex's staging area for
     * a mod that had none.
     *
     * A folder that is not there cannot be probed; that is an honest unknown,
     * not something to manufacture an answer for.
     */
    const stats = await fsp.stat(dir);
    if (!stats.isDirectory()) {
      throw Object.assign(new Error(`${dir} is not a directory`), {
        code: "ENOTDIR",
      });
    }
    await fsp.writeFile(probe, "");
    try {
      await fsp.stat(lowered);
      // The lowercase name found the mixed-case file: one file, two spellings.
      mode = "insensitive";
    } catch (statErr) {
      /**
       * ─── ONLY ENOENT MEANS "SENSITIVE" ────────────────────────────────
       * This used to be a bare `catch {}`, so ANY failure of the lookup was
       * read as proof of case-sensitivity — including EPERM or EBUSY from a
       * filter driver (Defender, OneDrive placeholder sync, a backup agent)
       * holding the handle on a file created microseconds earlier. On NTFS
       * that is the wrong direction, it emitted no log line at all, and it is
       * upstream of the mirror: a wrongly-"sensitive" mode is what made one
       * physical file both a restore and a delete.
       *
       * ENOENT is the only code that answers the question. Anything else
       * means the probe did not run, and an inconclusive probe falls back
       * like any other failure — loudly.
       */
      const statCode = (statErr as NodeJS.ErrnoException).code;
      if (statCode === "ENOENT") {
        mode = "sensitive";
      } else {
        throw statErr;
      }
    }
  } catch (err) {
    mode = fallbackFor(platform);
    ehLog("warn", "paths.case-probe.failed", {
      dir,
      platform,
      assumed: mode,
      why:
        mode === "sensitive"
          ? "assuming case-SENSITIVE, which is the direction that cannot merge two real files"
          : "assuming case-insensitive, which is right for NTFS",
      err,
    });
  } finally {
    /**
     * `force` swallows ENOENT, but an EPERM/EBUSY from the same filter driver
     * REJECTS — and this used to discard that silently. A leaked
     * `EhCaseProbe-*.tmp` sitting in a curator's staging folder gets captured
     * into `stagingFiles` on the next build and shipped, and then every user
     * gets a permanent `missingFiles` entry for a file no archive can
     * produce. `volatileFiles` also knows the name now, as a second line of
     * defence.
     */
    await fsp.rm(probe, { force: true }).catch((err: unknown) => {
      ehLog("warn", "paths.case-probe.cleanup-failed", {
        probe,
        err,
        consequence:
          "a probe file was left behind; it is treated as volatile so a " +
          "build will not capture it, but it should not be there",
      });
    });
  }

  cache.set(dir, mode);
  ehLog("info", "paths.case-sensitivity", { dir, mode, platform });
  return mode;
}

/** Test seam: forget every probed answer. */
export function __resetCaseSensitivityCache(): void {
  cache.clear();
}
