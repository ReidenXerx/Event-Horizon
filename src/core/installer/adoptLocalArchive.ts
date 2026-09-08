/**
 * ──────────────────────────────────────────────────────────────────────
 * Make a file the user picked look like a download Vortex made.
 *
 * When a mod is not on Nexus, the user fetches it themselves and points us at
 * the archive. That file then installed through `start-install`, which we emit
 * as `(archivePath, cb)` — with no way to pass the curator's installer
 * answers. So every FOMOD the user supplied by hand was installed with DEFAULT
 * options while the collection promised to reproduce the curator's choices.
 * Files all present, all correct, and the wrong ones.
 *
 * ── Why not just add a third argument to `start-install`? ──
 * Because an EventEmitter ignores arguments its listener does not declare, so
 * a wrong guess does not throw — it installs with defaults and reports
 * success. That is the exact failure this would be fixing.
 *
 * And we have no evidence for that signature. The passive probe
 * (probeInstallerApi) has been recording every real installer call on this
 * machine, and across four days of logs `start-install` appears ZERO times.
 * `start-install-download` appears with the shape we rely on:
 *
 *     ["string(len 36)", "object{allowAutoEnable,choices}", "function/2"]
 *
 * So route through the call we have observed rather than guessing at one we
 * have not: register the picked file as a local download, then install it the
 * same way an already-downloaded mod installs. `addLocalDownload` exists for
 * exactly this — "a file that has been found on disk but where we weren't
 * involved in the download".
 *
 * ── The cost ──
 * Vortex resolves a download's `localPath` relative to the game's download
 * folder, so a file outside it has to be copied in. That is a real copy of a
 * real archive. It is also what Vortex itself does when you drop a file into
 * its download pane, and it buys the archive being retained for next time.
 * ──────────────────────────────────────────────────────────────────────
 */

import { createHash } from "crypto";
import * as fsp from "fs/promises";
import * as path from "path";

import { actions, selectors } from "@nexusmods/vortex-api";
import type { types } from "@nexusmods/vortex-api";

import { ehLog } from "../logging/ehLog";
import { detectCaseSensitivity, isInside } from "../paths";

export type AdoptedArchive = {
  /** The download id Vortex now knows this archive by. */
  archiveId: string;
  /** Absolute path of the archive inside the download folder. */
  localPath: string;
  /** True when the file had to be copied in. */
  copied: boolean;
};

/**
 * Register `archivePath` with Vortex as a local download.
 *
 * Idempotent-ish by content: the download id is derived from the file's path
 * and size rather than randomly, so adopting the same archive twice in one
 * install produces the same id instead of two entries pointing at one file.
 */
export async function adoptLocalArchive(
  api: types.IExtensionApi,
  args: { gameId: string; archivePath: string },
): Promise<AdoptedArchive> {
  const downloadDir = downloadFolder(api, args.gameId);
  if (downloadDir === undefined) {
    throw new Error(
      "Vortex's download folder for this game could not be resolved, so the " +
        "picked archive cannot be registered.",
    );
  }

  const stat = await fsp.stat(args.archivePath);
  const fileName = path.basename(args.archivePath);

  // Already inside the download folder? Then there is nothing to copy, and
  // copying would produce a second identical archive next to the first.
  /**
   * PROBED, not assumed.
   *
   * The old comment said an assumption was fine here because "being wrong
   * costs a redundant copy of an archive". That accounts for one of the two
   * directions. A false NEGATIVE costs a redundant copy; a false POSITIVE —
   * concluding the file is already inside the download folder when it is not
   * — skips the copy entirely, leaves `destination` as the user's own path,
   * and then registers `path.basename(destination)` relative to a folder that
   * does not contain it. Vortex looks for a file that is not there and the
   * install stalls.
   *
   * It is reachable: under Proton `process.platform` reports `win32` while
   * the volume is ext4, so a platform ASSUMPTION answers "insensitive"
   * and `/home/u/downloads/Foo.7z` matches a download folder at
   * `/home/u/Downloads`. And the premise — "before anything has been written"
   * — does not hold either: `copyIn` mkdirs and writes into this very folder
   * moments later, so probing it costs nothing that was not about to happen.
   */
  const inFolder = isInside(
    downloadDir,
    args.archivePath,
    await detectCaseSensitivity(downloadDir),
  );
  const destination = inFolder
    ? args.archivePath
    : await copyIn(downloadDir, args.archivePath, fileName);

  const archiveId = deriveId(destination, stat.size);

  /**
   * Registering the download IS this function. `api.store?.dispatch` made it
   * optional: with no store the dispatch vanished, the log still said
   * `installer.adopted-local-archive`, and the caller went on to
   * `start-install-download` with an id Vortex had never heard of — surfacing
   * ten minutes later as a stall, with the real cause nowhere in the log.
   * Same shape as the download-folder check above: refuse, do not pretend.
   */
  const store = api.store;
  if (store === undefined) {
    throw new Error(
      "Vortex's store is unavailable, so the picked archive cannot be " +
        "registered as a download.",
    );
  }

  store.dispatch(
    (
      actions as unknown as {
        addLocalDownload: (
          id: string,
          game: string,
          localPath: string,
          size: number,
        ) => unknown;
      }
    ).addLocalDownload(
      archiveId,
      args.gameId,
      // Vortex stores this RELATIVE to the download folder; an absolute path
      // here produces an entry it cannot later find.
      path.basename(destination),
      stat.size,
    ),
  );

  ehLog("info", "installer.adopted-local-archive", {
    archiveId,
    copied: !inFolder,
    bytes: stat.size,
  });

  return { archiveId, localPath: destination, copied: !inFolder };
}

/**
 * A stable id for this archive.
 *
 * Not random: the same picked file must not accumulate a new download entry on
 * every retry. Path plus size is enough to be stable within a machine, and the
 * id never leaves it.
 *
 * ─── NOT CASE-FOLDED ────────────────────────────────────────────────────────
 * This used to digest `absolutePath.toLowerCase()`. On a case-sensitive
 * filesystem `/home/u/mods/Patch.7z` and `/home/u/mods/patch.7z` are two
 * different archives — a common shape, two variants of one patch — and with
 * the same byte count they produced the SAME id, so adopting the second was
 * registered as the first and Vortex installed the wrong file.
 *
 * An identity function in a project whose whole premise is content-addressed
 * archive identity (NS-4) has no business inventing collisions. The path as
 * the OS reports it is already the stable key: on NTFS the same file is always
 * handed to us with the same spelling, because it comes from a file picker or
 * from Vortex's own state, not from a user typing it twice.
 */
function deriveId(absolutePath: string, size: number): string {
  const digest = createHash("sha256")
    .update(`${absolutePath}|${String(size)}`)
    .digest("hex");
  // Vortex's own download ids are 36 characters (a UUID). Matching the shape
  // keeps anything that assumes that length working.
  return [
    digest.slice(0, 8),
    digest.slice(8, 12),
    digest.slice(12, 16),
    digest.slice(16, 20),
    digest.slice(20, 32),
  ].join("-");
}

/**
 * Copy the archive in, without overwriting an unrelated file that happens to
 * share its name — the user's Downloads folder and Vortex's are both full of
 * `Patch.7z`.
 */
async function copyIn(
  downloadDir: string,
  source: string,
  fileName: string,
): Promise<string> {
  await fsp.mkdir(downloadDir, { recursive: true });
  const ext = path.extname(fileName);
  const stem = path.basename(fileName, ext);

  for (let attempt = 0; attempt < 100; attempt += 1) {
    const candidate = path.join(
      downloadDir,
      attempt === 0 ? fileName : `${stem} (${String(attempt)})${ext}`,
    );
    try {
      // `wx` fails if the destination exists, which is the point: it is a
      // check and a claim in one, with no window between them.
      await fsp.copyFile(source, candidate, fsp.constants.COPYFILE_EXCL);
      return candidate;
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code !== "EEXIST") throw err;
      // Same bytes already sitting there? Then it IS our file; reuse it.
      if (await sameSize(candidate, source)) return candidate;
    }
  }
  throw new Error(
    `Could not find a free name for "${fileName}" in Vortex's download folder.`,
  );
}

async function sameSize(a: string, b: string): Promise<boolean> {
  try {
    const [sa, sb] = await Promise.all([fsp.stat(a), fsp.stat(b)]);
    return sa.size === sb.size;
  } catch {
    return false;
  }
}

/**
 * Moved to the path service.
 *
 * It said "Case-insensitive: this is Windows", which was true of the machines
 * it was written on and false under Proton, where `/home/u/Downloads` and
 * `/home/u/downloads` are two directories. The service takes the case mode as
 * an argument instead of assuming one.
 *
 * Re-exported because this module's own tests address it here.
 */
export { isInside } from "../paths";

function downloadFolder(
  api: types.IExtensionApi,
  gameId: string,
): string | undefined {
  try {
    const dir = (
      selectors as unknown as {
        downloadPathForGame?: (state: unknown, game: string) => unknown;
      }
    ).downloadPathForGame?.(api.getState(), gameId);
    return typeof dir === "string" && dir.length > 0 ? dir : undefined;
  } catch {
    return undefined;
  }
}
