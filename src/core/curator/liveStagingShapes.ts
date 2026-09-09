/**
 * Walk every mod's staging folder and fingerprint what is in it, by stat.
 *
 * The live half of {@link stagingShapeOf}. The built half comes free out of
 * the manifest; this one costs a directory walk per mod, which is why it is a
 * separate module the diff takes as an OPTIONAL input rather than something
 * `diffCollectionAgainstProfile` does for itself. That function is pure and
 * stays pure.
 *
 * ─── STAT, NEVER READ ───────────────────────────────────────────────────────
 * `walkStagingFolder` returns names and sizes. Nothing here opens a file. On a
 * 1,755-mod collection that is a few hundred thousand directory entries —
 * seconds, against the minutes that hashing the same bytes would take, and the
 * reason this can run when the page opens instead of behind a button.
 *
 * ─── A FOLDER THAT CANNOT BE WALKED IS OMITTED, NOT EMPTY ───────────────────
 * If the walk fails, or the mod has no `installationPath`, or the folder is
 * gone, the mod is left OUT of the returned map. `compareShapes` reads a
 * missing entry as `unknown` and the diff counts it. Recording an empty shape
 * instead would mean "this mod stages nothing", which for a mod whose folder
 * merely could not be read is a fabricated finding — and one that would report
 * every such mod as changed.
 */

import {
  installRootFor,
  installationPathFromState,
  stagingRootFromFolder,
} from "../stagingPath";
import { stagingShapeOf } from "./stagingShape";
import { walkStagingFolder } from "../manifest/stagingFileWalker";
import { ehLog } from "../logging/ehLog";

import type { types } from "@nexusmods/vortex-api";

/**
 * Vortex mod id → stat-only shape, for every mod whose folder could be read.
 *
 * `signal` aborts the walk between mods; a diff the curator has navigated away
 * from must not keep the disk busy.
 */
export async function liveStagingShapes(
  state: types.IState,
  gameId: string,
  modIds: readonly string[],
  signal?: AbortSignal,
): Promise<Map<string, string>> {
  const shapes = new Map<string, string>();
  let unreadable = 0;
  const startedAt = Date.now();

  // Resolved once: it is the same folder for every mod of this game, and
  // asking Vortex per mod would be a thousand identical selector calls.
  const installRoot = installRootFor(state, gameId);

  for (const modId of modIds) {
    if (signal?.aborted === true) break;

    const folder = installationPathFromState(state, gameId, modId);
    if (folder === undefined) {
      unreadable += 1;
      continue;
    }
    const root = stagingRootFromFolder(installRoot, folder);
    if (root === undefined) {
      unreadable += 1;
      continue;
    }

    try {
      /**
       * ─── A PARTIAL LISTING IS AN ABSENCE, NOT A SHORTER FOLDER ────────
       * `walkStagingFolder` reports every path it had to skip through
       * `onUnreadable`, and its own docblock says why: "a file we never saw
       * leaves no trace, and that was load-bearing... incompleteness is now
       * REPORTED rather than inferred from an absence."
       *
       * This dropped the callback, so a subtree the walk could not list — a
       * OneDrive placeholder, a path over MAX_PATH, an antivirus filter
       * holding a handle — simply produced a shorter file list. The shape
       * then differed from the manifest's and the dashboard told the curator
       * they had edited a staging folder they had not touched.
       *
       * A skipped path does not throw, so the `catch` below never saw it.
       */
      let skipped = 0;
      const files = await walkStagingFolder(root, signal, () => {
        skipped += 1;
      });
      if (skipped > 0) {
        unreadable += 1;
        ehLog("warn", "curator.staging-shapes.partial", {
          modId,
          skipped,
          why:
            "the walk could not list part of this folder, so its file list " +
            "is short — recording a shape from it would report an edit the " +
            "curator did not make",
        });
        continue;
      }
      // An EMPTY walk of a folder that exists is a real answer — the mod
      // stages nothing — and differs from a folder that could not be read.
      shapes.set(
        modId,
        stagingShapeOf(files.map((f) => ({ path: f.relativePath, size: f.size }))),
      );
    } catch {
      unreadable += 1;
    }
  }

  ehLog("info", "curator.staging-shapes", {
    asked: modIds.length,
    shaped: shapes.size,
    unreadable,
    ms: Date.now() - startedAt,
    aborted: signal?.aborted === true,
    note: "stat only — no file contents were read",
  });
  return shapes;
}
