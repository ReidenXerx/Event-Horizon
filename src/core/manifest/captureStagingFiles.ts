import * as path from "path";
import type { ArchiveHashLookup } from "../archiveHashCache";

import { selectors } from "@nexusmods/vortex-api";
import type { types } from "@nexusmods/vortex-api";

import type { AuditorMod } from "../getModsListForProfile";
import type { EhcollStagingFile, VerificationLevel } from "../../types/ehcoll";
import { AbortError } from "../../utils/abortError";
import { ehLog } from "../logging/ehLog";
import { installRootFor, installationPathFromState, stagingRootFromFolder } from "../stagingPath";
import {
  getDefaultHashConcurrency,
  hashStagingFiles,
  walkStagingFolder,
} from "./stagingFileWalker";

/**
 * Captures the curator's staging-folder file list for each mod, used by
 * the user-side {@link verifyModInstall} check to detect Vortex's "lost
 * file" / truncation / corruption bugs after the user installs the mod.
 *
 * What we capture:
 *  - The full file tree under `<install-path>/<mod.installationPath>`
 *    on the curator's machine (post-Vortex-extraction, post-FOMOD-
 *    resolution).
 *  - For each file: POSIX-style relative path + size in bytes.
 *  - Optionally (when `level === "thorough"`): SHA-256 of file contents.
 *
 * What we do NOT capture:
 *  - The raw archive contents. The curator's deployed file set already
 *    reflects FOMOD selections, so this side-steps the "user picks
 *    different FOMOD answers" false-positive problem entirely.
 *  - Files outside the mod's staging root (Vortex never installs there).
 *
 * Failure handling:
 *  - Mods missing `installationPath` (rare — typically pre-Vortex-1.x or
 *    placeholder entries) pass through unchanged. The user-side verifier
 *    will skip them with a warning rather than fail the install.
 *  - I/O errors on individual files (locked, permission denied, etc.)
 *    surface as a captured `EhcollStagingFile` with `size: 0` and a
 *    diagnostic warning emitted via `onWarn`. The user-side check will
 *    ignore size=0 entries (they can't be meaningfully verified).
 *  - Aborts via `AbortSignal` propagate as `AbortError` exactly like
 *    `enrichModsWithArchiveHashes` — partial work is discarded.
 *
 * Concurrency:
 *  - Mods are walked one-at-a-time (outer loop) but files within each
 *    mod hash in parallel via {@link pMap}. The default worker count
 *    is cpu-aware (see {@link getDefaultHashConcurrency}) — typically
 *    `min(8, max(2, cpus-1))`. This keeps memory bounded for huge
 *    mods (BodySlide presets, voice packs) while still saturating
 *    SSD bandwidth on multi-core boxes and leaving one core free for
 *    the Vortex UI thread.
 */
export type CaptureStagingOptions = {
  level: VerificationLevel;
  /**
   * Defaults to {@link getDefaultHashConcurrency} (cpu-aware: typically
   * `min(8, max(2, cpus-1))`). Earlier versions hard-coded 4; the
   * adaptive default scales with the curator's machine while keeping
   * one core free for the UI thread.
   */
  hashConcurrency?: number;
  /**
   * Per-mod progress callback. Fires once after each mod is processed
   * (success, skipped, or partial). Used by the build engine to drive
   * the `inspecting-mods` progress bar.
   */
  onProgress?: (done: number, total: number, mod: AuditorMod) => void;
  /**
   * Diagnostic warnings (e.g. unreadable files) — non-fatal. Caller can
   * surface these in the build summary. Distinct from hard errors,
   * which throw.
   */
  onWarn?: (mod: AuditorMod, message: string) => void;
  signal?: AbortSignal;
  /**
   * Optional hash cache. Omitting it re-reads every staged file, which is what
   * a "re-verify everything" run wants and what the install side always does.
   */
  hashCache?: ArchiveHashLookup;
};

/**
 * Output type — same shape as `AuditorMod` plus `installationPath` and
 * `stagingFiles`. Both are optional because:
 *  - `installationPath` may be absent on legacy mod records.
 *  - `stagingFiles` is only populated when `level !== "none"`.
 */
export type StagingEnrichedAuditorMod = AuditorMod & {
  installationPath?: string;
  stagingFiles?: EhcollStagingFile[];
  /**
   * Part of this mod's staging folder could not be read, so `stagingFiles` is
   * a SHORT list rather than a wrong one.
   *
   * The distinction matters to exactly one consumer and matters enormously
   * there: mirroring deletes a user's files that the curator's listing does
   * not mention. An incomplete listing turns that into deleting files the
   * curator does have and simply could not see.
   */
  stagingCaptureIncomplete?: boolean;
};

export async function captureStagingFiles(
  state: types.IState,
  gameId: string,
  mods: AuditorMod[],
  options: CaptureStagingOptions,
): Promise<StagingEnrichedAuditorMod[]> {
  const {
    level,
    hashConcurrency,
    onProgress,
    onWarn,
    signal,
    hashCache,
  } = options;
  const workers = hashConcurrency ?? getDefaultHashConcurrency();

  if (level === "none") {
    onProgress?.(mods.length, mods.length, mods[mods.length - 1]!);
    return mods.map((m) => ({ ...m }));
  }

  if (signal?.aborted) {
    throw new AbortError();
  }

  const installRoot = installRootFor(state, gameId);
  if (installRoot === undefined) {
    if (onWarn !== undefined && mods.length > 0) {
      onWarn(
        mods[0]!,
        `Could not resolve Vortex install path for game "${gameId}". ` +
          "Skipping staging-file capture for this build.",
      );
    }
    return mods.map((m) => ({ ...m }));
  }

  const out: StagingEnrichedAuditorMod[] = new Array(mods.length);
  let done = 0;

  for (let i = 0; i < mods.length; i++) {
    if (signal?.aborted) throw new AbortError();
    const mod = mods[i]!;
    const enriched: StagingEnrichedAuditorMod = { ...mod };

    const installationPath = installationPathFromState(state, gameId, mod.id);
    if (installationPath !== undefined) {
      enriched.installationPath = installationPath;
    }

    if (enriched.installationPath === undefined) {
      onWarn?.(
        mod,
        `Mod "${mod.name}" has no installationPath in Vortex state. ` +
          "Skipping staging-file capture for this mod (user-side " +
          "integrity check will be best-effort).",
      );
      out[i] = enriched;
      done += 1;
      onProgress?.(done, mods.length, mod);
      continue;
    }

    const stagingRoot = stagingRootFromFolder(
      installRoot,
      enriched.installationPath,
    );
    if (stagingRoot === undefined) {
      out[i] = enriched;
      done += 1;
      onProgress?.(done, mods.length, mod);
      continue;
    }

    try {
      /**
       * ─── DID WE SEE THE WHOLE FOLDER? ─────────────────────────────────
       * The walk skips what it cannot read, and a skipped subtree leaves no
       * entry at all — so its absence is indistinguishable from "the curator
       * does not have that file". Downstream, `planMirror` DELETES the user's
       * files that this listing does not mention, on the reasoning that the
       * listing is complete. It has to be told when it is not.
       */
      const unreadable: string[] = [];
      const files = await walkStagingFolder(stagingRoot, signal, (entry) => {
        unreadable.push(`${entry.kind} ${entry.path}: ${entry.why}`);
      });
      const stagingFiles = await hashStagingFiles(
        stagingRoot,
        files,
        level,
        workers,
        signal,
        (relPath, err) => onWarn?.(mod, `${relPath}: ${err.message}`),
        hashCache,
      );
      enriched.stagingFiles = stagingFiles;
      if (unreadable.length > 0) {
        enriched.stagingCaptureIncomplete = true;
        ehLog("warn", "capture.staging.incomplete", {
          mod: mod.name,
          unreadable: unreadable.length,
          examples: unreadable.slice(0, 5),
        });
        onWarn?.(
          mod,
          `${unreadable.length} path(s) under this mod's staging folder ` +
            `could not be read, so its file list is incomplete. It will not ` +
            `be offered for mirroring, and nothing will be deleted from a ` +
            `user's copy on its behalf. First: ${unreadable[0]}`,
        );
      }
    } catch (err) {
      if (err instanceof AbortError) throw err;
      onWarn?.(
        mod,
        `Failed to walk staging folder for "${mod.name}": ${
          (err as Error).message
        }. User-side integrity check will skip this mod.`,
      );
    }

    out[i] = enriched;
    done += 1;
    onProgress?.(done, mods.length, mod);
  }

  return out;
}
