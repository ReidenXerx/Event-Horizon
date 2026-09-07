/**
 * Mod-install primitives — Phase 3 slice 6.
 *
 * Three install entry points, one per `ModResolution.decision.kind`
 * family that slice 6a supports:
 *
 *  1. {@link installNexusViaApi}            — `nexus-download`
 *  2. {@link installFromExistingDownload}   — `*-use-local-download`
 *  3. {@link installFromBundledArchive}     — `external-use-bundled`
 *
 * "Already installed" arms (`nexus-already-installed`,
 * `external-already-installed`) need no install primitive — the driver
 * just re-uses the existing Vortex mod id and enables it in the new
 * profile.
 *
 * Spec: docs/business/INSTALL_DRIVER.md (§ Mod install primitives)
 *
 * ─── EVENT WIRING ──────────────────────────────────────────────────────
 * Vortex's documented events (see vortex-api/docs/EVENTS.md):
 *
 *  • `start-install`           (archivePath, cb(err, modId))
 *      Install from an absolute archive path. Vortex copies the archive
 *      into the downloads folder, registers it, runs the installer
 *      pipeline, and dispatches the mod into the global pool.
 *
 *  • `start-install-download`  (downloadId, cb?)
 *      Install from an archive Vortex already knows about
 *      (i.e., it has an entry under `state.persistent.downloads.files`).
 *      Skips the copy step.
 *
 *  • `did-install-mod`         (gameId, archiveId, modId)
 *      Fired when an install pipeline completes. The driver uses this
 *      to learn the new modId when no synchronous callback is exposed.
 *
 *  • `nexusDownload(...)` (api.ext)
 *      Documented helper that downloads from Nexus and (with
 *      `allowInstall=true`) auto-triggers `start-install-download`.
 *      Returns the archiveId; we still listen for `did-install-mod` to
 *      learn the resulting modId.
 * ──────────────────────────────────────────────────────────────────────
 */

import * as fsp from "fs/promises";
import * as os from "os";
import * as path from "path";

import { getModArchivePath } from "../archiveHashing";

import { util } from "@nexusmods/vortex-api";
import type { types } from "@nexusmods/vortex-api";

import { adoptLocalArchive } from "./adoptLocalArchive";

import {
  installOptions,
  type VortexInstallerChoices,
} from "./installerChoices";

import { extractZipEntryToFile, listZipEntries } from "../manifest/readZip";
import { looksLikeWine } from "./checkSevenZipHealth";
import { stallBudgetMs, type StallPhase } from "./timeBudgets";
import { classifyAttempt, backoffMs } from "./downloadFailureShape";
import { ehLog } from "../logging/ehLog";

/**
 * Install completion is policed by **two** timers, not one:
 *
 *  1. {@link stallBudgetMs} — the **stall watchdog**. We reset it every
 *     time we observe a relevant progress signal (a download chunk
 *     landed, the entry's state transitioned, the mod count for our
 *     gameId mutated, etc.). If Vortex makes zero observable progress
 *     for this long we conclude the pipeline is hung and reject.
 *
 *     The claim that "it never trips on a healthy install no matter how
 *     big the archive is" was FALSE, and this is where it broke: the
 *     signals above all move during DOWNLOAD, and none of them moves
 *     while Vortex unpacks the archive. The download entry has stopped
 *     changing and the mod record does not exist yet, so a large mod on
 *     a slow prefix is silent for the whole extraction — and a flat 90s
 *     called that a hang. The window is now sized per phase, and during
 *     extraction it is proportional to the archive.
 *
 *  2. {@link INSTALL_ABSOLUTE_CAP_MS} — the **absolute cap**. Pure
 *     safety net for the pathological case where Vortex is reporting
 *     progress but is actually livelocked (e.g. retrying a network
 *     call forever). In healthy operation this never trips.
 *
 * Why not a single fixed deadline? The previous design used a 10 min
 * fixed deadline, which was simultaneously too short for slow
 * connections (a 4 GB download on 10 Mbps is ~55 min, all of it
 * Vortex working fine) and too long for diagnosing real hangs.
 * The two-timer design solves both: hangs surface in 90s; legitimate
 * long-running installs are bounded only by the 60 min absolute cap.
 *
 * ─── BOTH TIMERS PAUSE WHILE VORTEX IS ASKING THE USER SOMETHING ───────
 * They did not, and it cost a real install. A tester left the machine while
 * a FOMOD dialog was waiting for him; nothing dispatched, no progress signal
 * moved, and the watchdog concluded the pipeline was hung and aborted a
 * perfectly healthy install.
 *
 * An earlier version of this very docblock named "a stuck FOMOD dialog" as a
 * thing to catch FASTER. That was the mistake in one sentence: a dialog
 * waiting for a human is not a stall, it is the system working and waiting.
 * It cannot be told apart from a hang by watching for progress, because
 * neither one makes any — the difference is not in the timing, it is in
 * whether Vortex is currently blocked on input, and Vortex publishes that in
 * `session.base.visibleDialog`.
 *
 * So both timers now re-arm rather than fire while a dialog is up. The
 * absolute cap has to pause too: capping at 60 minutes would only have moved
 * the same failure to the user who goes to bed mid-install. What still fires
 * is silence with NO dialog on screen, which is the actual hang.
 */
// The stall window is no longer a constant — see stallBudgetMs, which sizes
// it from the phase and the archive. The absolute cap stays flat and stays
// per-mod: it is a livelock backstop, not a performance budget.
// Six hours, not one. This is a LIVELOCK BACKSTOP, not a performance budget,
// and a single mod can legitimately take a very long time: thousands of loose
// files, a slow disk, a Proton prefix, or a user who walked away mid-FOMOD.
// One hour was a cap on how patient the tool is willing to be, which is not
// ours to decide — the user's hardware decides it.
const INSTALL_ABSOLUTE_CAP_MS = 6 * 60 * 60_000;

/**
 * Is Vortex currently blocked on the user rather than working?
 *
 * THREE signals, because Vortex has more than one kind of dialog and the one
 * that matters most is not the obvious one.
 *
 * `session.base.visibleDialog` and `overlayOpen` cover Vortex's GENERIC dialog
 * surface. The FOMOD installer does not use either: it keeps its own state at
 * `session.fomod.installer.dialog.activeInstanceId`, which is exactly what
 * Vortex's own shipped code tests to answer "is a FOMOD dialog open" —
 *
 *     const activeInstanceId =
 *       state.session.fomod.installer?.dialog?.activeInstanceId;
 *     return !!activeInstanceId;
 *
 * read out of app.asar rather than guessed, the same way the CLEAR_USERLIST
 * action names were.
 *
 * Missing that third signal is not academic. A tester's run lost SIX mods to
 * the watchdog while he was answering FOMOD prompts, including a 535 KB
 * archive "stalled" after 270 seconds — a file that does not take four minutes
 * to extract. The pause was watching a key the FOMOD installer never sets.
 *
 * Deliberately fails to FALSE. If a shape ever changes, the watchdog goes back
 * to being occasionally impatient rather than never firing at all, which would
 * turn a real hang into an install that waits forever.
 */
export function isAwaitingUserInput(api: types.IExtensionApi): boolean {
  try {
    const session = (
      api.getState() as unknown as {
        session?: {
          base?: { visibleDialog?: unknown; overlayOpen?: unknown };
          fomod?: {
            installer?: { dialog?: { activeInstanceId?: unknown } };
          };
        };
      }
    )?.session;

    // The FOMOD installer's own dialog — the one that actually blocks a
    // 900-mod install while someone picks options.
    const fomodInstance = session?.fomod?.installer?.dialog?.activeInstanceId;
    if (fomodInstance !== undefined && fomodInstance !== null && fomodInstance !== "") {
      return true;
    }

    const base = session?.base;
    const dialog = base?.visibleDialog;
    if (typeof dialog === "string" && dialog.length > 0) return true;
    return base?.overlayOpen === true;
  } catch {
    return false;
  }
}

/**
 * Install a Nexus mod by triggering Vortex's typed `nexusDownload`
 * helper with `allowInstall=true`. Returns the new Vortex mod id once
 * Vortex's install pipeline reports completion via `did-install-mod`.
 */
export async function installNexusViaApi(
  api: types.IExtensionApi,
  args: {
    gameId: string;
    nexusModId: number;
    nexusFileId: number;
    fileName?: string;
    /**
     * Optional cancellation token. If aborted before
     * `did-install-mod` fires, the awaited promise rejects with an
     * `AbortError`. Vortex's `nexusDownload` itself cannot be
     * cancelled (the API doesn't expose a hook), but the driver
     * stops blocking immediately.
     */
    signal?: AbortSignal;
    /**
     * The curator's recorded installer answers.
     *
     * Their presence changes HOW the mod is installed, not just with what.
     * Vortex's `nexusDownload(..., allowInstall = true)` downloads and
     * installs in one step, and there is no seam in it to pass choices
     * through — so a mod with choices is downloaded WITHOUT installing and
     * then installed explicitly, which is the call that takes them.
     *
     * A mod with none takes the original single-step path untouched: this
     * feature must not change how the other 840 mods in a collection install.
     */
    choices?: VortexInstallerChoices;
    /**
     * Apply {@link choices} without showing the FOMOD dialog.
     *
     * Travels with `choices` and is meaningless without it. The user picks
     * this once before the install starts; see `fomodReplayMode.ts`.
     */
    unattended?: boolean;
  },
): Promise<{ archiveId: string; vortexModId: string }> {
  if (!api.ext?.nexusDownload) {
    throw new Error(
      "Vortex's Nexus integration is not available. Is the Nexus extension " +
        "enabled and the user logged in?",
    );
  }

  if (args.signal?.aborted) {
    throw makeAbortErrorLocal("nexus install");
  }

  const replaying = args.choices !== undefined;

  // ── retry, because not every empty answer means the file is gone ──────
  //
  // Two shapes turned up in one tester's run, and they are NOT the same
  // problem:
  //
  //   modId=98669  564ms   file pulled from Nexus — permanent, retrying is
  //                        pointless but costs one second
  //   modId=93047  55834ms fifty-six seconds and then nothing — a timeout or
  //                        a rate limit, and very likely fine on a second try
  //
  // Nothing in the response distinguishes them, so the only honest policy is
  // to try again a couple of times. A dead file fails fast each time and the
  // retries cost ~10s; a transient one gets the chance it deserves instead of
  // costing the user a mod.
  const MAX_DOWNLOAD_ATTEMPTS = 3;

  let archiveId: string | undefined;
  let completed: ReturnType<typeof waitForInstallCompletion> | undefined;
  let lastError: unknown;

  for (let attempt = 1; attempt <= MAX_DOWNLOAD_ATTEMPTS; attempt += 1) {
    if (args.signal?.aborted) throw makeAbortErrorLocal("nexus install");
    const attemptStartedAt = Date.now();

    // Subscribe BEFORE triggering — `did-install-mod` can fire before the
    // `nexusDownload` promise resolves on hot caches. Re-armed per attempt,
    // because a cancelled waiter cannot be reused. Not needed when replaying:
    // nothing installs until we say so, and installFromExistingDownload does
    // its own waiting.
    completed = replaying
      ? undefined
      : waitForInstallCompletion(api, {
          gameId: args.gameId,
          matchArchiveId: undefined, // we don't know it yet; matched below
          signal: args.signal,
        });

    try {
      const id = await api.ext.nexusDownload(
        args.gameId,
        args.nexusModId,
        args.nexusFileId,
        args.fileName,
        // Download only, when there are choices to hand the installer. The
        // one-step form gives no opportunity to supply them.
        !replaying,
      );
      if (typeof id === "string" && id.length > 0) {
        archiveId = id;
        break;
      }
      lastError = new Error(
        `Nexus download for modId=${args.nexusModId}, ` +
          `fileId=${args.nexusFileId} returned no archiveId.`,
      );
    } catch (err) {
      if (isAbortErrorLocal(err)) throw err;
      lastError = err;
    }

    // This attempt failed, so nothing will ever await `completed`. Tear it
    // down explicitly: otherwise the listener and its stall watchdog outlive
    // the attempt and fire a bogus "install stalled" long afterwards.
    if (completed !== undefined) {
      void completed.promise.catch(() => undefined);
      completed.cancel();
      completed = undefined;
    }

    if (attempt < MAX_DOWNLOAD_ATTEMPTS) {
      // How long the attempt took is the only thing separating "this file is
      // gone" from "Nexus is not answering" — see downloadFailureShape.ts. A
      // three-second wait cannot clear a rate limit, and a sixty-second one
      // wastes a minute per mod on a file that is genuinely deleted.
      const attemptMs = Date.now() - attemptStartedAt;
      const shape = classifyAttempt(attemptMs);
      ehLog("warn", "install.download.retry", {
        modId: args.nexusModId,
        fileId: args.nexusFileId,
        attempt,
        attemptMs,
        shape,
        error: lastError instanceof Error ? lastError.message : String(lastError),
      });
      await delayRespectingAbort(backoffMs(attempt, shape), args.signal);
    }
  }

  if (archiveId === undefined) {
    throw lastError instanceof Error
      ? lastError
      : new Error(String(lastError));
  }

  if (replaying) {
    const installed = await installFromExistingDownload(api, {
      gameId: args.gameId,
      archiveId,
      choices: args.choices!,
      ...(args.unattended !== undefined
        ? { unattended: args.unattended }
        : {}),
      ...(args.signal !== undefined ? { signal: args.signal } : {}),
    });
    return { archiveId, vortexModId: installed.vortexModId };
  }

  // Now narrow the listener to this specific archiveId.
  completed!.setExpectedArchiveId(archiveId);

  const result = await completed!.promise;

  return { archiveId, vortexModId: result.modId };
}

/**
 * Install from an archive Vortex already knows about (one that has an
 * entry under `state.persistent.downloads.files`).
 */
export async function installFromExistingDownload(
  api: types.IExtensionApi,
  args: {
    gameId: string;
    archiveId: string;
    /**
     * The curator's recorded installer answers. When present they are handed
     * to Vortex's installer so it does not ask the user; when absent the call
     * is byte-for-byte what it was before replay existed.
     */
    choices?: VortexInstallerChoices;
    /**
     * Apply {@link choices} without showing the FOMOD dialog.
     *
     * Travels with `choices` and is meaningless without it. The user picks
     * this once before the install starts; see `fomodReplayMode.ts`.
     */
    unattended?: boolean;
    /** Optional cancellation token; see {@link installNexusViaApi}. */
    signal?: AbortSignal;
  },
): Promise<{ vortexModId: string }> {
  if (args.signal?.aborted) {
    throw makeAbortErrorLocal("install from existing download");
  }

  const completed = waitForInstallCompletion(api, {
    gameId: args.gameId,
    matchArchiveId: args.archiveId,
    signal: args.signal,
  });

  if (args.choices === undefined) {
    api.events.emit("start-install-download", args.archiveId);
    const result = await completed.promise;
    return { vortexModId: result.modId };
  }

  // Observed signature — see installerChoices.ts. Vortex passes a callback of
  // its own, and it is the only channel for a failure: without it a refused
  // install would sit until the stall watchdog fires 90 seconds later, with
  // the real reason discarded.
  const failed = new Promise<never>((_resolve, reject) => {
    api.events.emit(
      "start-install-download",
      args.archiveId,
      installOptions(args.choices!, args.unattended),
      (err: Error | null | undefined) => {
        if (err) reject(err);
      },
    );
  });

  const result = await Promise.race([completed.promise, failed]);
  return { vortexModId: result.modId };
}

/**
 * Install from a local archive on disk that Vortex does NOT yet know
 * about. Used in two paths:
 *
 *  - `external-prompt-user` decisions where the user picked a local
 *    file via the picker (slice 6b).
 *  - As the install half of {@link installFromBundledArchive} (after
 *    extraction).
 *
 * Vortex's `start-install` event accepts an absolute path to an
 * archive on disk; it copies the archive into the downloads folder,
 * registers it, runs the installer pipeline, and dispatches the mod
 * into the global pool.
 *
 * Returns the new Vortex mod id once Vortex confirms install
 * completion. The source file is NOT removed by this function — the
 * caller owns its lifecycle.
 */
export async function installFromLocalArchive(
  api: types.IExtensionApi,
  args: {
    gameId: string;
    archivePath: string;
    /** Optional cancellation token; see {@link installNexusViaApi}. */
    signal?: AbortSignal;
    /**
     * The curator's recorded installer answers.
     *
     * When present the archive is REGISTERED as a Vortex download first and
     * installed through `start-install-download`, because that is the only
     * install call whose choices-carrying shape we have actually observed —
     * see adoptLocalArchive for the evidence and the reasoning. Passing a
     * third argument to `start-install` on a guess would install with
     * defaults and report success, which is the bug this fixes.
     *
     * When absent the call below is byte-for-byte what it was before replay
     * existed: a mod with no installer choices must not start copying
     * archives around because of a feature it does not use.
     */
    choices?: VortexInstallerChoices;
    /**
     * Apply {@link choices} without showing the FOMOD dialog.
     *
     * Travels with `choices` and is meaningless without it. The user picks
     * this once before the install starts; see `fomodReplayMode.ts`.
     */
    unattended?: boolean;
  },
): Promise<{ vortexModId: string }> {
  if (args.signal?.aborted) {
    throw makeAbortErrorLocal("install from local archive");
  }

  if (args.choices !== undefined) {
    const adopted = await adoptLocalArchive(api, {
      gameId: args.gameId,
      archivePath: args.archivePath,
    });
    return installFromExistingDownload(api, {
      gameId: args.gameId,
      archiveId: adopted.archiveId,
      choices: args.choices,
      ...(args.unattended !== undefined
        ? { unattended: args.unattended }
        : {}),
      ...(args.signal !== undefined ? { signal: args.signal } : {}),
    });
  }

  const completed = waitForInstallCompletion(api, {
    gameId: args.gameId,
    matchArchiveId: undefined,
    acceptAny: true,
    acceptIf: installedFromArchive(api, args.gameId, args.archivePath),
    signal: args.signal,
  });

  // Same dual-path race as installFromBundledArchive: synchronous
  // callback gives the modId fast; `did-install-mod` is the fallback
  // for Vortex builds that don't invoke the cb reliably (now actually
  // wired up — accepts the first did-install-mod for our gameId).
  const callbackPromise = new Promise<{ modId: string }>((resolve, reject) => {
    api.events.emit(
      "start-install",
      args.archivePath,
      (err: Error | null | undefined, modId: string) => {
        if (err) {
          reject(err);
          return;
        }
        if (!modId) {
          reject(new Error("start-install completed without a modId."));
          return;
        }
        resolve({ modId });
      },
    );
  });

  const result = await Promise.race([callbackPromise, completed.promise]);
  return { vortexModId: result.modId };
}

/**
 * Is the mod Vortex just installed the one we asked it to install?
 *
 * Compares by the archive it came from. Vortex records `archiveId` on every
 * mod it installs and `getModArchivePath` turns that into the file on disk, so
 * the comparison is against the exact archive path the caller handed to
 * `start-install` rather than against a name we hoped would match.
 *
 * Unresolvable means NO. That is deliberate and it is the safer direction:
 * this predicate only runs on the fallback leg, which is only reached when
 * Vortex's synchronous callback has already failed, so the choice is between a
 * visible timeout and silently adopting a mod we cannot identify.
 */
function installedFromArchive(
  api: types.IExtensionApi,
  gameId: string,
  archivePath: string,
): (modId: string) => boolean {
  const wanted = path.basename(archivePath).toLowerCase();
  return (modId: string): boolean => {
    try {
      const state = api.getState();
      const mod = (
        state as unknown as {
          persistent?: {
            mods?: Record<string, Record<string, { archiveId?: string }>>;
          };
        }
      )?.persistent?.mods?.[gameId]?.[modId];
      const resolved = getModArchivePath(state, mod?.archiveId, gameId);
      if (resolved === undefined) return false;
      return path.basename(resolved).toLowerCase() === wanted;
    } catch {
      return false;
    }
  };
}

/**
 * Uninstall a Vortex mod entirely — file system + state + archive
 * association. Wraps `util.removeMods` (which Vortex itself uses for
 * "Remove Mod" in the UI), so the cleanup matches the user's
 * expectation: the mod's deployed files are unlinked, the mod entry
 * disappears from `state.persistent.mods[gameId]`, and Vortex's
 * staging folder for the mod is removed.
 *
 * Used by the install driver (slice 6b) for two purposes:
 *  - Replacing the user's existing mod when the user chose
 *    `replace-existing` for a `*-diverged` decision.
 *  - Removing an orphaned mod from a previous release of the same
 *    collection when the user chose `uninstall`.
 *
 * Throws if `util.removeMods` is not available (older Vortex builds)
 * or if the underlying removal fails. The driver translates the
 * throw into a `failed` result with the failing phase.
 */
export async function uninstallMod(
  api: types.IExtensionApi,
  args: { gameId: string; modId: string },
): Promise<void> {
  const removeMods = (util as unknown as {
    removeMods?: (
      api: types.IExtensionApi,
      gameId: string,
      modIds: string[],
    ) => Promise<void>;
  }).removeMods;

  if (typeof removeMods !== "function") {
    throw new Error(
      "Vortex's util.removeMods is not available. " +
        "Cannot remove existing mod safely; please update Vortex.",
    );
  }

  await removeMods(api, args.gameId, [args.modId]);
}

/**
 * Install from a `.ehcoll`'s bundled archive. The bundled archive is
 * extracted from the package ZIP into a temp directory, then handed to
 * Vortex's `start-install` which takes care of the rest (installer
 * pipeline, FOMOD UI if applicable, mod-pool dispatch).
 *
 * The temp file is left in place after install — Vortex copies it into
 * the downloads folder during `start-install`, so it's safe to delete.
 * The driver's caller is responsible for cleanup at the end of the
 * install run via {@link safeRmTempDir} on `tempDir`.
 *
 * Failure modes that own cleanup here (rather than the driver):
 *  - 7z extraction fails before we can hand the file to Vortex →
 *    {@link extractBundledFromEhcoll} cleans up its own tempDir.
 *  - `start-install` rejects (synchronous callback path) before
 *    Vortex copies the archive into its downloads folder → we
 *    cleanup tempDir here. The driver's cleanup list never sees it.
 *
 * @returns the resulting Vortex mod id, the extracted path on disk,
 *   and the temp directory the caller must remove once Vortex has
 *   finished with the archive.
 */
export async function installFromBundledArchive(
  api: types.IExtensionApi,
  args: {
    gameId: string;
    ehcollZipPath: string;
    bundledZipEntry: string; // e.g. "bundled/abc...123.zip"
    /** Optional cancellation token; see {@link installNexusViaApi}. */
    signal?: AbortSignal;
    /**
     * Optional pre-extracted bundle from
     * {@link BundledPrefetchPool.take}. When supplied, skips the 7z
     * extraction step and uses the supplied paths directly. The
     * caller transfers tempDir ownership to this function — we keep
     * the same on-failure cleanup contract as the cold path
     * (cleanup tempDir if start-install rejects) and the same
     * happy-path contract (return tempDir, caller schedules
     * cleanup after Vortex consumes the archive).
     */
    preExtracted?: { extractedPath: string; tempDir: string };
    /**
     * The curator's mod name. Becomes the extracted archive's file name and
     * therefore what Vortex calls the installed mod — see
     * {@link bundledArchiveFileName} for why that is load-bearing and not
     * cosmetic. Ignored when `preExtracted` is supplied, because the pool
     * has already named the file.
     */
    preferredName?: string;
    /**
     * The curator's recorded installer answers.
     *
     * Bundling a mod must not lose them. `start-install` — the call this
     * function otherwise makes — has no argument for choices, so a bundled
     * FOMOD installed with DEFAULT options while the collection claimed to
     * reproduce the curator's build. Exactly the gap that existed on the
     * hand-picked path, in a third place.
     *
     * When present the extracted archive is registered as a Vortex download
     * and installed through `start-install-download`, the only choices-
     * carrying install call whose shape has been OBSERVED on a real Vortex.
     * See adoptLocalArchive for that evidence.
     */
    choices?: VortexInstallerChoices;
    /**
     * Apply {@link choices} without showing the FOMOD dialog.
     *
     * Travels with `choices` and is meaningless without it. The user picks
     * this once before the install starts; see `fomodReplayMode.ts`.
     */
    unattended?: boolean;
  },
): Promise<{
  vortexModId: string;
  extractedPath: string;
  tempDir: string;
}> {
  // No `resolveSevenZip()` here any more, and that is the point: it THROWS
  // when `util.SevenZip` is missing, so merely reaching this line used to be
  // enough to fail an install on a prefix where 7z is unavailable — before
  // anything had tried to read a single byte.
  if (args.signal?.aborted) {
    throw makeAbortErrorLocal("install from bundled archive");
  }

  const { extractedPath, tempDir } =
    args.preExtracted ??
    (await extractBundledFromEhcoll(
      args.ehcollZipPath,
      args.bundledZipEntry,
      args.preferredName,
    ));

  try {
    if (args.signal?.aborted) {
      // User aborted between extraction and start-install; skip the
      // start-install dispatch entirely. The catch below cleans up
      // tempDir.
      throw makeAbortErrorLocal("install from bundled archive");
    }

    if (args.choices !== undefined) {
      // Same route as a hand-picked archive: register the extracted bundle as
      // a download so it can be installed through the call that carries the
      // curator's answers. The temp copy is still cleaned up by the caller —
      // Vortex now has its own copy in the download folder.
      const adopted = await adoptLocalArchive(api, {
        gameId: args.gameId,
        archivePath: extractedPath,
      });
      const installed = await installFromExistingDownload(api, {
        gameId: args.gameId,
        archiveId: adopted.archiveId,
        choices: args.choices,
        ...(args.unattended !== undefined
          ? { unattended: args.unattended }
          : {}),
        ...(args.signal !== undefined ? { signal: args.signal } : {}),
      });
      return { vortexModId: installed.vortexModId, extractedPath, tempDir };
    }

    const completed = waitForInstallCompletion(api, {
      gameId: args.gameId,
      // start-install registers a NEW archiveId we cannot know in
      // advance. acceptAny: true makes the did-install-mod listener a
      // real fallback for Vortex builds where the synchronous callback
      // below isn't invoked reliably — gated on identity, because
      // "any install for this game" includes one the user started.
      matchArchiveId: undefined,
      acceptAny: true,
      acceptIf: installedFromArchive(api, args.gameId, extractedPath),
      signal: args.signal,
    });

    // `start-install` accepts a callback `(err, modId) => void`. We use
    // both: the callback gives us the most precise modId (Vortex resolves
    // it synchronously after install), and `did-install-mod` is a fallback
    // for older Vortex builds that don't invoke the cb reliably.
    const callbackPromise = new Promise<{ modId: string }>(
      (resolve, reject) => {
        api.events.emit(
          "start-install",
          extractedPath,
          (err: Error | null | undefined, modId: string) => {
            if (err) {
              reject(err);
              return;
            }
            if (!modId) {
              reject(new Error("start-install completed without a modId."));
              return;
            }
            resolve({ modId });
          },
        );
      },
    );

    // Whichever resolves first wins. The other settles silently.
    const result = await Promise.race([callbackPromise, completed.promise]);

    return { vortexModId: result.modId, extractedPath, tempDir };
  } catch (err) {
    // start-install rejected before Vortex took ownership of the
    // archive — no copy was made into the downloads folder, so we
    // own the tempDir and must clean it up here. Otherwise it leaks
    // until OS temp GC.
    await safeRmTempDir(tempDir);
    throw err;
  }
}

// ===========================================================================
// Helpers
// ===========================================================================

/**
 * Subscribe to Vortex's `did-install-mod` event and wrap it in a
 * promise. The listener auto-removes after a successful match or
 * timeout.
 *
 * Two matching modes:
 *
 *  - **exact**: only `did-install-mod` with `archiveId === matchArchiveId`
 *    resolves the promise. Used by Nexus and existing-download flows
 *    where the archiveId is known up-front (or set later via
 *    {@link setExpectedArchiveId}).
 *  - **any-after-start**: the first `did-install-mod` for our gameId
 *    that fires AFTER the listener is registered resolves the promise.
 *    Used by `installFromBundledArchive` / `installFromLocalArchive`
 *    where Vortex's `start-install` allocates a new archiveId we
 *    cannot know in advance. Combined with the synchronous
 *    `start-install` callback via `Promise.race`, this gives us a
 *    real fallback if the callback is unreliable on a given Vortex
 *    build.
 *
 * The historical "buffer events until expectedArchiveId is set"
 * behavior is preserved for the exact-mode flow (it covers the
 * `nexusDownload` race where `did-install-mod` can fire before the
 * promise from `nexusDownload` resolves).
 */
function waitForInstallCompletion(
  api: types.IExtensionApi,
  opts: {
    gameId: string;
    /**
     * For exact-mode: the archiveId to match. Undefined ⇒ "match
     * mode is exact, but we don't know the id yet; the caller will
     * call setExpectedArchiveId later." For any-after-start mode,
     * leave undefined and pass `acceptAny: true`.
     */
    matchArchiveId: string | undefined;
    /**
     * Size of the archive being installed, when the caller knows it.
     *
     * Only used to size the stall watchdog's silence window during the
     * extraction phase, where nothing observable moves and the right amount
     * of quiet is proportional to how much there is to unpack. Omitting it
     * costs a more generous default, never a shorter one — the bundled path
     * knows the size, the Nexus path learns it from the download entry.
     */
    archiveBytes?: number;
    /**
     * When true, the listener resolves on the FIRST `did-install-mod`
     * for `opts.gameId` regardless of archiveId. Cannot be combined
     * with `matchArchiveId`.
     *
     * SAFETY: on its own this mode resolves on ANY install finishing for
     * `opts.gameId`, including one Vortex is performing for somebody else —
     * whereupon the caller is handed a modId for a mod it never installed.
     *
     * This note used to say the danger was covered because EHRuntime
     * "serializes EH's build/install pipelines". It does not. EHRuntime is two
     * booleans and a listener set — no lock, no queue — and its own header
     * says concurrent operations are deliberately NOT forbidden, only
     * discouraged with a banner and a disabled button the user can dismiss. A
     * safety argument naming a guarantee that does not exist is worse than no
     * note, because the next caller extends this mode on the strength of it.
     *
     * The real protection is {@link acceptIf}: pass a predicate that confirms
     * the installed mod is the one you asked for. The driver's own sequencing
     * still means EH cannot race ITSELF; the predicate covers the user
     * starting an install in Vortex's UI while ours runs.
     */
    acceptAny?: boolean;
    /**
     * With `acceptAny`, decide whether a finished install is really ours.
     *
     * Called with the modId Vortex just installed. Returning false ignores the
     * event and keeps waiting — a foreign install must not settle our promise.
     *
     * Returning false for everything ends in a timeout, which is the intended
     * shape: this mode is already the FALLBACK leg of a race against Vortex's
     * synchronous callback, so reaching it at all means the fast path failed.
     * A visible timeout beats silently adopting the wrong mod.
     */
    acceptIf?: (modId: string, archiveId: string) => boolean;
    /**
     * If provided, the promise rejects with an `AbortError` as soon
     * as the signal aborts. The synchronous `start-install` callback
     * in {@link installFromBundledArchive} / {@link installFromLocalArchive}
     * cannot itself be cancelled (Vortex's API doesn't expose that),
     * but at least the *driver* stops blocking on this promise so
     * the rest of the abort cleanup can proceed. Vortex's pipeline
     * eventually completes or errors on its own.
     */
    signal?: AbortSignal;
  },
): {
  promise: Promise<{ modId: string; archiveId: string }>;
  setExpectedArchiveId: (archiveId: string) => void;
  /**
   * Tear the wait down without ever having awaited it.
   *
   * cleanup() otherwise runs only when the promise settles, so a caller that
   * arms this and then throws before awaiting leaks the `did-install-mod`
   * listener AND both timers - permanently. Observed in a real run: a mod
   * failed at 13:57:52 and the orphaned watchdog logged install.stalled at
   * 14:12:51, exactly 900s after it was armed and 15 minutes after the run
   * had already ended. The leaked listener is the worse half: it stays
   * subscribed and can match a LATER install's event.
   */
  cancel: () => void;
} {
  if (opts.acceptAny && opts.matchArchiveId !== undefined) {
    throw new Error(
      "waitForInstallCompletion: cannot combine acceptAny with matchArchiveId.",
    );
  }

  let expectedArchiveId = opts.matchArchiveId;
  const acceptAny = opts.acceptAny === true;
  /**
   * Buffered events that arrived before `expectedArchiveId` was set.
   * Only used in exact-mode — in any-after-start mode the first
   * matching event resolves the promise immediately.
   */
  const buffer: Array<{
    gameId: string;
    archiveId: string;
    modId: string;
  }> = [];

  let resolveFn: (v: { modId: string; archiveId: string }) => void;
  let rejectFn: (err: Error) => void;
  let settled = false;

  const promise = new Promise<{ modId: string; archiveId: string }>(
    (resolve, reject) => {
      resolveFn = resolve;
      rejectFn = reject;
    },
  );

  // ── Two-timer watchdog (see header for rationale) ────────────────
  let stallTimer: ReturnType<typeof setTimeout> | undefined;
  let absoluteCapTimer: ReturnType<typeof setTimeout> | undefined;
  let storeUnsubscribe: (() => void) | undefined;
  let lastProgressAt = Date.now();
  /** Time spent with a dialog on screen, for the log. Not a deadline. */
  let blockedOnUserMs = 0;

  /**
   * Snapshot of the download entry under
   * `state.persistent.downloads.files[expectedArchiveId]` from the
   * last time we observed it. We detect "progress" as any change in
   * `received` (download chunk landed), `state` (lifecycle
   * transition), or `size` (Vortex learned the total bytes).
   */
  let lastDownloadSnapshot:
    | { received: number; state: string; size: number }
    | undefined;
  /**
   * Mod count for our gameId at the last observation. Used as a
   * coarse-grained progress signal when archiveId isn't known yet
   * (Nexus path before nexusDownload returns) or when the install
   * pipeline phase doesn't update download.received (post-extract,
   * pre-deploy).
   */
  let lastModCount = -1;

  // Probed once: looksLikeWine touches the filesystem, and the watchdog
  // re-arms on every progress signal.
  const budgetEnv = { wine: looksLikeWine() };

  /**
   * Which phase the install is in, for sizing the silence window.
   *
   * This matters because the two phases are observably different. While bytes
   * are arriving we see `received` move on every chunk, so silence really is
   * suspicious. Once the archive is complete, Vortex unpacks it and NOTHING
   * we watch moves — the download entry has stopped changing and the mod
   * record does not exist until the install finishes. A flat window declares
   * that legitimate work a hang, which is what a 90s constant did to a large
   * mod under Wine.
   */
  const currentStallPhase = (): StallPhase => {
    const snap = lastDownloadSnapshot;
    if (snap !== undefined && snap.size > 0) {
      return snap.received >= snap.size
        ? { phase: "extracting", bytes: snap.size }
        : { phase: "downloading" };
    }
    // No usable download entry: the bundled path, or a Nexus download that
    // has not started yet. Size unknown, so take the generous window — it is
    // still never shorter than the constant this replaced.
    return { phase: "extracting", bytes: opts.archiveBytes };
  };

  const armStallWatchdog = (): void => {
    if (stallTimer !== undefined) clearTimeout(stallTimer);
    const phase = currentStallPhase();
    const budgetMs = stallBudgetMs(phase, budgetEnv);
    stallTimer = setTimeout(() => {
      if (settled) return;

      // Vortex is showing a dialog: a FOMOD page, a confirmation, an error
      // notification. It is not hung, it is waiting for a person — and a
      // person who has walked away produces exactly the same silence as a
      // hang. Re-arm and keep waiting; the dialog is its own prompt.
      if (isAwaitingUserInput(api)) {
        blockedOnUserMs += budgetMs;
        ehLog("info", "install.waiting-on-user", {
          totalBlockedSec: Math.round(blockedOnUserMs / 1000),
          gameId: opts.gameId,
          archiveId: expectedArchiveId,
        });
        lastProgressAt = Date.now();
        armStallWatchdog();
        return;
      }

      settled = true;
      cleanup();
      const idleSec = Math.round((Date.now() - lastProgressAt) / 1000);
      // A timeout the user reports is useless without the numbers behind it:
      // which phase we thought we were in, what budget was in force, and how
      // that budget was arrived at. Without this, "it timed out" cannot be
      // told from "the budget was too small", which is the distinction that
      // decides whether to fix the code or the collection.
      ehLog("warn", "install.stalled", {
        phase: phase.phase,
        archiveBytes: phase.phase === "extracting" ? phase.bytes : undefined,
        budgetMs,
        idleSec,
        wine: budgetEnv.wine,
        gameId: opts.gameId,
        archiveId: expectedArchiveId,
      });
      rejectFn(
        new Error(
          `Mod install stalled — Vortex made no observable progress for ` +
            `${idleSec}s while ${phase.phase}. The install pipeline may be ` +
            `waiting on a stuck dialog (FOMOD prompt, error notification) or ` +
            `be hung. Check Vortex's notification panel and try again.`,
        ),
      );
    }, budgetMs);
  };

  const noteProgress = (): void => {
    lastProgressAt = Date.now();
    armStallWatchdog();
  };

  /**
   * Redux store listener. Fires after every action — we filter to
   * just the slices that move during a healthy install: the download
   * entry for our archive, and the mod pool for our gameId.
   *
   * Cost: ~O(1) state-tree walks per redux action. setTimeout
   * arm/disarm is similarly cheap. This is fine even during the
   * "100 progress events per second" early phase of a fast download.
   */
  const onStoreChange = (): void => {
    if (settled) return;

    // api.getState() is vortex-api's typed accessor; the underlying
    // ThunkStore exposes getState/subscribe but its TypeScript surface
    // doesn't, so we go through api.getState() for reads and cast for
    // the subscribe handle below.
    const state = api.getState() as unknown as
      | {
          persistent?: {
            downloads?: {
              files?: Record<
                string,
                {
                  received?: number;
                  state?: string;
                  size?: number;
                }
              >;
            };
            mods?: Record<string, Record<string, unknown>>;
          };
        }
      | undefined;
    if (!state) return;

    // Signal 1: the specific download entry we expect (Nexus &
    // existing-download paths). expectedArchiveId starts undefined
    // for the Nexus flow and gets filled in by setExpectedArchiveId.
    if (expectedArchiveId !== undefined) {
      const entry = state?.persistent?.downloads?.files?.[expectedArchiveId];
      if (entry) {
        const snap = {
          received: entry.received ?? 0,
          state: entry.state ?? "",
          size: entry.size ?? 0,
        };
        if (
          lastDownloadSnapshot === undefined ||
          lastDownloadSnapshot.received !== snap.received ||
          lastDownloadSnapshot.state !== snap.state ||
          lastDownloadSnapshot.size !== snap.size
        ) {
          lastDownloadSnapshot = snap;
          noteProgress();
          return;
        }
      }
    }

    // Signal 2: total mod count for our gameId (covers bundled-archive
    // and any phase the download entry doesn't move during). One mod
    // appearing or disappearing is enough to reset the watchdog —
    // Vortex's install pipeline mutates this slice on completion and
    // the action handler's middleware also touches it during failure
    // recovery.
    const modsForGame = state?.persistent?.mods?.[opts.gameId];
    const modCount =
      modsForGame !== undefined ? Object.keys(modsForGame).length : 0;
    if (lastModCount === -1) {
      lastModCount = modCount;
    } else if (modCount !== lastModCount) {
      lastModCount = modCount;
      noteProgress();
    }
  };

  const onDidInstall = (
    gameId: string,
    archiveId: string,
    modId: string,
  ): void => {
    if (settled) return;
    if (gameId !== opts.gameId) return;

    // did-install-mod is by definition a progress signal; reset the
    // watchdog before deciding whether to settle (covers the case
    // where the event is for a different archiveId in exact-mode).
    noteProgress();

    if (acceptAny) {
      // Identity gate. Without it "the first install to finish" can be a mod
      // the user started in Vortex's own UI, and the caller would verify and
      // record somebody else's mod as the one it just installed.
      if (opts.acceptIf !== undefined && !opts.acceptIf(modId, archiveId)) {
        return;
      }
      settled = true;
      cleanup();
      resolveFn({ modId, archiveId });
      return;
    }

    if (expectedArchiveId === undefined) {
      buffer.push({ gameId, archiveId, modId });
      return;
    }

    if (archiveId !== expectedArchiveId) return;

    settled = true;
    cleanup();
    resolveFn({ modId, archiveId });
  };

  api.events.on("did-install-mod", onDidInstall);

  // Subscribe to the store if available. In test/mock environments
  // where api.store is undefined, the watchdog still works — it just
  // can't observe download progress, so the stall timer effectively
  // becomes a fixed deadline. did-install-mod still resolves the
  // promise on the happy path.
  //
  // vortex-api's ThunkStore<any> typing doesn't expose .subscribe but
  // the runtime object is a Redux store and definitely has it; cast.
  const storeWithSubscribe = api.store as unknown as
    | { subscribe?: (listener: () => void) => () => void }
    | undefined;
  const subscribeFn = storeWithSubscribe?.subscribe;
  if (typeof subscribeFn === "function") {
    storeUnsubscribe = subscribeFn(onStoreChange);
    // Seed the snapshots so the next mutation is detected as a delta.
    onStoreChange();
  }

  // Arm both timers.
  armStallWatchdog();
  const armAbsoluteCap = (): void => {
    if (absoluteCapTimer !== undefined) clearTimeout(absoluteCapTimer);
    absoluteCapTimer = setTimeout(() => {
      if (settled) return;

      // Same reasoning as the stall watchdog, and it matters more here: an
      // hour is exactly the scale of "went to make dinner". Capping a
      // dialog-blocked install would just move the lost install from the
      // tester who stepped out to the one who went to bed.
      if (isAwaitingUserInput(api)) {
        ehLog("info", "install.cap-deferred-waiting-on-user", {
          totalBlockedSec: Math.round(blockedOnUserMs / 1000),
          gameId: opts.gameId,
        });
        armAbsoluteCap();
        return;
      }

      settled = true;
      cleanup();
      rejectFn(
        new Error(
          `Mod install exceeded the absolute time cap of ` +
            `${INSTALL_ABSOLUTE_CAP_MS / 60_000} min. Vortex was reporting ` +
            `progress but never completed — assuming the pipeline is ` +
            `livelocked.`,
        ),
      );
    }, INSTALL_ABSOLUTE_CAP_MS);
  };
  armAbsoluteCap();

  // Wire abort. If the signal is already aborted, settle synchronously
  // — but defer the rejection a microtask so cleanup runs on a fully-
  // constructed promise (avoids "leaks" of un-awaited cleanup).
  let abortListener: (() => void) | undefined;
  if (opts.signal) {
    if (opts.signal.aborted) {
      // Use a microtask so the caller has a chance to attach .catch
      // before the rejection lands. (Without this, a synchronous
      // throw here would surface before await.)
      Promise.resolve().then(() => {
        if (settled) return;
        settled = true;
        cleanup();
        rejectFn(makeAbortErrorLocal("install"));
      });
    } else {
      abortListener = (): void => {
        if (settled) return;
        settled = true;
        cleanup();
        rejectFn(makeAbortErrorLocal("install"));
      };
      opts.signal.addEventListener("abort", abortListener);
    }
  }

  function cleanup(): void {
    api.events.removeListener("did-install-mod", onDidInstall);
    if (stallTimer !== undefined) clearTimeout(stallTimer);
    if (absoluteCapTimer !== undefined) clearTimeout(absoluteCapTimer);
    if (storeUnsubscribe !== undefined) {
      try {
        storeUnsubscribe();
      } catch {
        // Vortex's store occasionally throws during teardown; we
        // don't care, the listener is dropped either way.
      }
    }
    if (abortListener !== undefined && opts.signal) {
      opts.signal.removeEventListener("abort", abortListener);
    }
  }

  return {
    promise,
    cancel: (): void => {
      if (settled) return;
      settled = true;
      cleanup();
      // Settle so nothing can await this forever. Callers that cancel are by
      // definition not awaiting, so they attach a catch first.
      rejectFn(makeAbortErrorLocal("install wait cancelled"));
    },
    setExpectedArchiveId: (archiveId: string) => {
      expectedArchiveId = archiveId;
      // Reset the download snapshot so the next store tick captures
      // the entry for the *new* archiveId as fresh progress.
      lastDownloadSnapshot = undefined;
      // Also count "we now know the archiveId" itself as progress —
      // it means nexusDownload resolved, which definitionally means
      // Vortex made forward progress.
      noteProgress();

      // Drain the buffer for any events we got before we knew the id.
      const match = buffer.find((entry) => entry.archiveId === archiveId);
      if (match && !settled) {
        settled = true;
        cleanup();
        resolveFn({ modId: match.modId, archiveId: match.archiveId });
      }
    },
  };
}

/**
 * Extract a single bundled archive entry out of a `.ehcoll` package
 * into a uniquely-named temp directory. Returns both the extracted
 * file's absolute path and the temp directory that contains it — the
 * caller must use the temp directory (not the file's parent) when
 * cleaning up, because cherry-picked entries can have nested paths
 * (e.g. `bundled/abc.zip` lands at `<tempDir>/bundled/abc.zip` and
 * `path.dirname` would only delete `<tempDir>/bundled`, leaking the
 * outer mkdtemp dir).
 *
 * The extraction directory is deliberately fresh per-call (mkdtemp's
 * 6-char random suffix makes it unique even within the same ms) so
 * two concurrent extractions can't trample each other.
 *
 * On extraction failure or post-extract sanity-check failure the temp
 * dir is removed before the error propagates — extraction owns its own
 * cleanup until it successfully returns.
 *
 * ─── WHY THIS NO LONGER SPAWNS 7z ──────────────────────────────────────
 * Pulling an entry out of a `.ehcoll` is a ZIP read of OUR OWN FORMAT, and
 * it used to go through Vortex's bundled 7z — a Windows executable spawned
 * as a child process. Under Wine/Proton that spawn is the fragile step: an
 * alpha tester could not open a package proven byte-identical to the
 * curator's, and node-7z could not say why (`list` resolves with an empty
 * spec and discards `{code, errors}`).
 *
 * `readEhcoll` was moved off 7z first; this was the OTHER half, and leaving
 * it behind meant an install would clear the manifest and then die on the
 * first bundled mod with the identical error.
 *
 * 7z keeps the job it actually earns: the extracted file may be a `.7z` or
 * `.rar`, and unpacking THAT is Vortex's installer's work, through Vortex's
 * own 7z. We just hand it the archive.
 */
/**
 * The bundled entry whose sha256 matches, whatever extension it carries.
 *
 * `undefined` when the package genuinely does not hold that archive — which
 * is a real failure and must stay one. Only the EXTENSION is forgiven here;
 * the sha still has to match exactly, so this cannot silently substitute a
 * different archive.
 */
async function findBundledEntryBySha(
  ehcollZipPath: string,
  askedFor: string,
): Promise<string | undefined> {
  const m = /^bundled\/([0-9a-f]{64})(?:\.|$)/i.exec(askedFor);
  if (m === null) return undefined;
  const sha = m[1]!.toLowerCase();
  try {
    const entries = await listZipEntries(ehcollZipPath);
    const prefix = `bundled/${sha}`;
    const hit = entries.find((e) => {
      const name = e.name.toLowerCase();
      // `bundled/<sha>` exactly, or `bundled/<sha>.<anything>`. Never a
      // longer sha that merely starts with this one.
      return name === prefix || name.startsWith(`${prefix}.`);
    });
    return hit?.name;
  } catch {
    // A package we cannot list is a package we cannot recover from; the
    // caller's original error is the honest one to report.
    return undefined;
  }
}

/**
 * Windows-safe file name for the archive we hand to Vortex.
 *
 * ─── THE FILE NAME BECOMES THE MOD NAME ────────────────────────────────
 * Vortex derives a mod's name — and therefore its staging FOLDER — from the
 * archive it installed. A bundled entry is called `bundled/<sha256>.zip`
 * because the sha is its identity inside the package, so extracting it under
 * that name gave the user mod folders called `b3d8853c…`, and a tester
 * reasonably asked what they were.
 *
 * That is the cosmetic half. The expensive half: `enrichInstalledModsWithStagingSetHashes`
 * only hashes installed mods whose NAME matches an external manifest entry,
 * and a mod called `b3d8853c…` matches nothing. So no staging-set hash was
 * ever computed, the resolver's second identity rung could never fire, and
 * every bundled external mod was reinstalled on every resume. From the
 * tester's log, on a run with 1,105 mods already installed:
 *
 *     resolver.staging-hashes.done {"wanted":29,"candidates":0,"enriched":0}
 *
 * Twenty-nine external mods, zero candidates, every single run.
 *
 * So the extracted file takes the curator's mod name. The name is only a
 * cheap CANDIDATE filter — identity is still decided by hashing the staging
 * folder — which is why borrowing it here is sound rather than a guess.
 *
 * Falls back to the entry's own basename when there is no usable name, so a
 * caller that passes nothing behaves exactly as before.
 */
export function bundledArchiveFileName(
  bundledZipEntry: string,
  preferredName: string | undefined,
): string {
  const fallback = bundledZipEntry.split("/").pop() ?? bundledZipEntry;
  if (preferredName === undefined) return fallback;

  // Reserved on Windows, plus control characters. These names came off the
  // curator's own filesystem so they are already legal, but this file is
  // written to disk on a machine we have never seen.
  const cleaned = preferredName
    .replace(/[/\\:*?"<>|]/g, "_")
    // Trailing dots and spaces are silently dropped by Win32, which would
    // make the path we return differ from the path that exists.
    .replace(/[\s.]+$/, "")
    .trim();
  // A name with no letter or digit left in it identifies nothing — `___` is a
  // legal file name and a useless one. The entry's sha at least identifies the
  // bytes, so fall back to it rather than to noise.
  if (!/[\p{L}\p{N}]/u.test(cleaned)) return fallback;

  // The extension decides which extractor Vortex reaches for, so it is taken
  // from the entry name — never from the mod name, which routinely ends in
  // something like "-149724-1-1746902603.1" that is a Vortex disambiguator
  // rather than a file type.
  const ext = archiveExtensionOf(fallback);
  const base = cleaned.toLowerCase().endsWith(ext.toLowerCase())
    ? cleaned
    : `${cleaned}${ext}`;

  // Win32 MAX_PATH leaves little room once the temp dir and `bundled/` are
  // spent, and a curator mod name can be long. Truncate the stem, never the
  // extension.
  const MAX_STEM = 120;
  const stem = base.slice(0, base.length - ext.length);
  return stem.length > MAX_STEM ? `${stem.slice(0, MAX_STEM)}${ext}` : base;
}

/**
 * The archive extension of a bundled entry's file name, `""` when it has none.
 *
 * Mirrors the packager's own convention, multi-part extensions included — it
 * writes `.tar.gz` whole, so splitting on the last dot would name the file
 * `.gz` and hand Vortex an archive it unpacks one layer short.
 */
function archiveExtensionOf(fileName: string): string {
  const lower = fileName.toLowerCase();
  for (const multi of [".tar.gz", ".tar.bz2", ".tar.xz"]) {
    if (lower.endsWith(multi)) return fileName.slice(-multi.length);
  }
  const lastDot = fileName.lastIndexOf(".");
  return lastDot <= 0 ? "" : fileName.slice(lastDot);
}

export async function extractBundledFromEhcoll(
  ehcollZipPath: string,
  bundledZipEntry: string,
  /**
   * The curator's mod name, when the caller knows it. Decides the extracted
   * file's name and therefore what Vortex calls the mod — see
   * {@link bundledArchiveFileName}.
   */
  preferredName?: string,
): Promise<{ extractedPath: string; tempDir: string }> {
  const tempDir = await fsp.mkdtemp(
    path.join(os.tmpdir(), "event-horizon-install-"),
  );

  try {
    // The entry's DIRECTORY is preserved inside `tempDir`, matching what 7z's
    // `extractFull` did — callers and cleanup both depend on that shape. Only
    // the file NAME is ours to choose.
    const dir = path.join(tempDir, ...bundledZipEntry.split("/").slice(0, -1));
    const pathFor = (entry: string): string =>
      path.join(dir, bundledArchiveFileName(entry, preferredName));

    let extractedPath = pathFor(bundledZipEntry);

    try {
      await extractZipEntryToFile(ehcollZipPath, bundledZipEntry, extractedPath);
    } catch (err) {
      /**
       * ─── THE IDENTITY IS THE SHA, NOT THE FILENAME ──────────────────
       * The entry name is `bundled/<sha256><ext>`, and the two sides derived
       * `<ext>` from DIFFERENT strings: the packager from the archive it
       * actually wrote (always the repacked `.zip`), the resolver from the
       * mod's `expectedFilename`. Those agree only by luck.
       *
       * They stop agreeing the moment Vortex has had to disambiguate a mod
       * name, because it appends `.1`, `.2`… — so a mod called
       * "IDE WHITERUN-149724-1-1746902603.1" made the resolver ask for
       * `bundled/<sha>.1` while the package held `bundled/<sha>.zip`. The
       * install died on the first such mod with "contains no entry named",
       * and on a large profile there is almost always one.
       *
       * The sha IS the identity — it is why the file is named that — so the
       * fallback finds the entry by it. Doing this here rather than in the
       * resolver is deliberate: it also repairs packages already built and
       * downloaded, which for a 10 GB collection is the difference between a
       * fix and a re-download.
       */
      const recovered = await findBundledEntryBySha(
        ehcollZipPath,
        bundledZipEntry,
      );
      if (recovered === undefined) {
        throw new Error(
          `Could not extract "${bundledZipEntry}" from "${ehcollZipPath}": ` +
            `${(err as Error).message}`,
        );
      }
      ehLog("warn", "bundled.entry-name-mismatch", {
        asked: bundledZipEntry,
        found: recovered,
      });
      // Name the file after the entry we FOUND. The whole reason we are here
      // is that the extension we asked for was wrong, so reusing it would
      // write a zip called `<name>.1` and leave Vortex to guess the format.
      extractedPath = pathFor(recovered);
      await extractZipEntryToFile(ehcollZipPath, recovered, extractedPath);
    }

    // Sanity-check: confirm the file actually landed.
    await fsp.access(extractedPath);

    return { extractedPath, tempDir };
  } catch (err) {
    // Extraction never succeeded — clean up the empty/partial tempDir
    // here so the caller doesn't have to learn about it just to drop it.
    await safeRmTempDir(tempDir);
    throw err;
  }
}

/**
 * Best-effort cleanup of a temp directory created by
 * {@link extractBundledFromEhcoll}. Pass the **directory** returned
 * by extraction (not the extracted file's path) — cherry-picked
 * entries can have nested paths inside the temp dir, so deriving the
 * dir from `path.dirname(extractedPath)` would leak the outer
 * mkdtemp dir.
 *
 * Errors are swallowed — the OS temp GC will eventually reclaim any
 * leftovers and we don't want install-driver cleanup to mask a real
 * failure earlier in the pipeline.
 */
export async function safeRmTempDir(tempDir: string): Promise<void> {
  try {
    await fsp.rm(tempDir, { recursive: true, force: true });
  } catch {
    // ignore
  }
}

/**
 * AbortError that matches the DOM AbortError shape (name === "AbortError")
 * so it survives the same `err.name === "AbortError"` checks the rest of
 * the codebase uses (see useErrorReporter, runInstall.checkAbort).
 *
 * Local copy rather than importing from profile.ts to avoid a circular
 * import — profile.ts has its own version with the same shape.
 */
function makeAbortErrorLocal(operation: string): Error {
  const err = new Error(`${operation} aborted by user`);
  err.name = "AbortError";
  return err;
}

/**
 * A user cancel must never be swallowed by the download retry.
 *
 * Retrying an abort would keep a cancelled install running for another two
 * attempts and ~11 seconds of backoff, which is exactly the "I pressed stop
 * and nothing happened" complaint.
 */
function isAbortErrorLocal(err: unknown): boolean {
  return err instanceof Error && err.name === "AbortError";
}

/**
 * Sleep, but wake immediately if the install is cancelled.
 *
 * A plain setTimeout would hold a cancelled install open for the full backoff.
 * The listener is removed on both paths so a long install cannot accumulate
 * one abort listener per retry.
 */
function delayRespectingAbort(
  ms: number,
  signal: AbortSignal | undefined,
): Promise<void> {
  if (signal?.aborted === true) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const done = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener("abort", done, { once: true });
  });
}
