/**
 * ──────────────────────────────────────────────────────────────────────
 * Install ONE requirement of a "Make it work" plan, and know when it landed.
 *
 * Vortex downloads directly for Premium accounts only; everyone else is
 * guided — the page opens, the user presses "Mod manager download", and the
 * step waits for whatever file of that page Vortex installs (settled: one
 * page at a time). The wait itself is `updateOneAndWait`, which matches the
 * finished install on the Nexus identity Vortex recorded.
 *
 * ─── A REFUSAL BECOMES THE GUIDED WAIT, NOT A LONGER DIRECT ONE ────────
 * `nexusDownload` swallows its own refusals (not Premium, logged out, an
 * expired login) into a notification and resolves undefined. The page opens
 * then — and from that moment the user is choosing the file, so the wait
 * must accept any file of the page and run on the guided clock. It used to
 * keep waiting for the exact planned file on the fifteen-minute direct
 * clock, so a user who picked another file, or took longer than what was
 * left of fifteen minutes, was reported as a failure while Vortex installed
 * it.
 *
 * ─── STOP MEANS "AFTER THIS ONE" ───────────────────────────────────────
 * Vortex has no way to cancel an install from outside, and it loses files
 * when two run at once. So once something for this step is running — a
 * download this step asked for, or one the user started from the page —
 * Stop does not end the wait: the step keeps waiting for the install to
 * land, and the run stays busy until it does. Only a guided wait with
 * nothing started yet ends at once, because there is nothing to wait for.
 * ──────────────────────────────────────────────────────────────────────
 */

import { ehLog } from "../logging/ehLog";
import { updateOneAndWait, type InstallEvents, type UpdateOneInput } from "./updateOneMod";

/** How long a guided step waits for the user to fetch the file by hand. */
export const GUIDED_WAIT_MS = 60 * 60 * 1000;

export type RequirementStepVia = "download" | "guided";

export type RequirementStepInput = {
  events: InstallEvents;
  /** The managed game `did-install-mod` is matched on. */
  gameId: string;
  /** The game the page is downloaded for (Vortex's id). */
  vortexGameId: string;
  name: string;
  nexusModId: number;
  /** The planned file. */
  file: { file_id: number; file_name?: string };
  /** Whether Vortex will download directly for this account. */
  premium: boolean;
  readInstalled: UpdateOneInput["readInstalled"];
  /** Vortex's `nexusDownload`: resolves a download id, or undefined when it refused. */
  download: (
    vortexGameId: string,
    nexusModId: number,
    fileId: number,
    fileName: string | undefined,
    allowInstall: boolean,
  ) => PromiseLike<string | undefined>;
  /** Open the page for a hand download and say so. */
  openPage: () => void;
  /** Download ids Vortex currently records for this page. */
  pageDownloadIds: () => readonly string[];
  /** The run's Stop. See the header: it does not abandon a running install. */
  signal: AbortSignal;
  /** Direct-download clock; `updateOneAndWait`'s default when absent. */
  premiumTimeoutMs?: number;
  guidedTimeoutMs?: number;
};

export type RequirementStepResult =
  | { ok: true; newModId: string; via: RequirementStepVia }
  | {
      ok: false;
      why: string;
      /** Vortex refused the direct download and the guided wait did not see an install either. */
      refused: boolean;
      /** Stop ended the wait while nothing for this step was running. */
      stopped: boolean;
      via: RequirementStepVia;
    };

export async function installRequirementStep(input: RequirementStepInput): Promise<RequirementStepResult> {
  const { events, gameId, vortexGameId, name, nexusModId, file, readInstalled, download, openPage, pageDownloadIds, signal } =
    input;
  const guidedTimeoutMs = input.guidedTimeoutMs ?? GUIDED_WAIT_MS;
  let via: RequirementStepVia = input.premium ? "download" : "guided";
  let refused = false;
  let ourRequestRunning = false;

  if (signal.aborted) {
    return { ok: false, why: "stopped before it started", refused: false, stopped: true, via };
  }

  // A download for this page that was not there when the step began is the
  // user's hand download (or ours) — something Vortex will go on to install.
  const pageBefore = new Set(pageDownloadIds());
  const somethingRunning = (): boolean => ourRequestRunning || pageDownloadIds().some((id) => !pageBefore.has(id));

  const wait = new AbortController();
  let stopRequested = false;
  const endIfIdle = (): void => {
    if (somethingRunning()) {
      ehLog("info", "curator.requirement.install.stop-deferred", {
        mod: name,
        nexusModId,
        via,
        why: "an install for this step is running; Vortex cannot cancel it and must not get a second one on top",
      });
      return;
    }
    ehLog("info", "curator.requirement.install.stopped", { mod: name, nexusModId, via });
    wait.abort();
  };
  const onStop = (): void => {
    stopRequested = true;
    endIfIdle();
  };
  signal.addEventListener("abort", onStop);

  ehLog("info", "curator.requirement.install.start", {
    mod: name,
    nexusModId,
    fileId: file.file_id,
    game: vortexGameId,
    via,
  });

  try {
    const newModId = await updateOneAndWait({
      events,
      gameId,
      nexusModId,
      toFileId: file.file_id,
      anyFile: via === "guided",
      ...(via === "guided" ? { timeoutMs: guidedTimeoutMs } : input.premiumTimeoutMs === undefined ? {} : { timeoutMs: input.premiumTimeoutMs }),
      readInstalled,
      signal: wait.signal,
      start: (controls) => {
        if (via === "guided") {
          openPage();
          return;
        }
        const fallBack = (why: string): void => {
          refused = true;
          ourRequestRunning = false;
          via = "guided";
          controls.widen({ anyFile: true, timeoutMs: guidedTimeoutMs });
          ehLog("info", "curator.requirement.install.refused-guided", { mod: name, nexusModId, why, timeoutMs: guidedTimeoutMs });
          if (stopRequested) {
            // Stop was deferred for OUR download, which just turned out not
            // to exist. Unless the user has started one, nothing is running.
            endIfIdle();
            if (wait.signal.aborted) return;
          }
          openPage();
        };
        ourRequestRunning = true;
        Promise.resolve(download(vortexGameId, nexusModId, file.file_id, file.file_name, true)).then(
          (dlId) => {
            ehLog("info", "curator.requirement.install.downloaded", { mod: name, nexusModId, dlId: dlId ?? null });
            if (dlId === undefined) fallBack("Vortex resolved no download; its notification says why");
          },
          (err: unknown) => {
            ehLog("error", "curator.requirement.install.download-error", { mod: name, nexusModId, err });
            fallBack(err instanceof Error ? err.message : String(err));
          },
        );
      },
    });
    ehLog("info", "curator.requirement.install.done", { mod: name, nexusModId, newModId, via, refused });
    return { ok: true, newModId, via };
  } catch (err) {
    const stopped = wait.signal.aborted;
    const why = stopped
      ? "stopped while nothing for it was downloading"
      : err instanceof Error
        ? err.message
        : String(err);
    ehLog("warn", "curator.requirement.install.fail", { mod: name, nexusModId, fileId: file.file_id, via, refused, stopped, why });
    return { ok: false, why, refused, stopped, via };
  } finally {
    signal.removeEventListener("abort", onStop);
  }
}
