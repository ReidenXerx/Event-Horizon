/**
 * ──────────────────────────────────────────────────────────────────────
 * The curator page's running state, kept where a tab switch cannot reach it.
 *
 * `RouteOutlet` keys every page on the route, so clicking another tab
 * UNMOUNTS this one — "cheap, because pages are tiny". The pages are; the
 * work is not. A bulk update over forty mods runs for many minutes, and it
 * lived in `useState` on the component: `busy`, `progress`, and `lines` —
 * the report, including the LOST lines that are the entire product of
 * verifying each mod before starting the next.
 *
 * Tab away mid-run and all three died with the component. The sequential loop
 * kept going, invisibly, against staging folders a build might be about to
 * hash; the buttons came back enabled, so a second bulk update could be
 * started on top of the first — the exact concurrency this feature exists to
 * eliminate. And the report was gone, so a curator whose mods DID lose files
 * had no record of which. The expected bug report is "I clicked Update, went
 * to look at something else, came back, and it said nothing happened."
 *
 * ─── THIRD TIME THIS PROBLEM HAS BEEN SOLVED HERE ──────────────────────
 * `buildSession` says it outright: "Vortex unmounts a page on a tab switch,
 * and a promise parked in component state dies with it." Build has a session
 * registry, install has `installSession`. This is the same shape, deliberately
 * kept small: only the state that must OUTLIVE the component moves here. The
 * effects stay on the page, where they can read `api` and the profile.
 *
 * ─── AND IT TELLS THE REST OF THE APP IT IS WORKING ────────────────────
 * `setInstallBusy` while a run is in flight, so `ConcurrentOpBanner` warns and
 * the build page knows something is rewriting staging. Nothing did that
 * before, which is why a build could start mid-update and hash a folder being
 * written underneath it.
 * ──────────────────────────────────────────────────────────────────────
 */

import { getEHRuntime } from "../../runtime/ehRuntime";

/** Which long action is running. `undefined` means the page is idle. */
export type CuratorBusy =
  | "update"
  | "reinstall"
  | "cleanup"
  | "endorse"
  | "refresh"
  | "requirements"
  | "install-requirement"
  | undefined;

/**
 * The requirements report, kept here so it outlives the page: fetching it
 * asks Nexus about every mod, and a tab switch must not throw that away.
 */
export type RequirementsCache = {
  gameId: string;
  fetchedAt: number;
  load: import("./requirementsIo").RequirementsLoad;
};

export type CuratorSnapshot = {
  busy: CuratorBusy;
  /** The live "Updating 3 of 40 — X" line. */
  progress?: string;
  /** The finished report. Survives leaving the page; cleared when a run starts. */
  lines: string[];
  /** A one-off note, e.g. the result of a Nexus re-check. */
  note?: string;
  requirements?: RequirementsCache;
};

export type CuratorListener = (snap: CuratorSnapshot) => void;

const IDLE: CuratorSnapshot = { busy: undefined, lines: [] };

class CuratorSession {
  private state: CuratorSnapshot = IDLE;
  private readonly listeners = new Set<CuratorListener>();
  /**
   * The live run's abort handle.
   *
   * Held here rather than in a component ref for the same reason as the rest:
   * a ref dies on unmount, and the run it was going to stop does not.
   */
  private controller?: AbortController;

  getSnapshot(): CuratorSnapshot {
    return this.state;
  }

  subscribe(listener: CuratorListener): () => void {
    this.listeners.add(listener);
    return (): void => {
      this.listeners.delete(listener);
    };
  }

  /** True while a long action is running — including from another mount. */
  isBusy(): boolean {
    return this.state.busy !== undefined;
  }

  /**
   * Begin a run and hand back the signal it must honour.
   *
   * Refuses if something is already running, which is what stops a remounted
   * page starting a second bulk update on top of a live one.
   */
  begin(
    busy: NonNullable<CuratorBusy>,
    opts?: {
      /**
       * Leave the last run's report on screen.
       *
       * For runs that produce a NOTE rather than a report — re-checking Nexus,
       * endorsing. Clearing on those threw away the LOST lines from the update
       * run just before, which are the one thing on this page a curator has to
       * act on, and re-checking Nexus is the natural next click after an
       * update. The report is only replaced by a run that has one of its own.
       */
      keepReport?: boolean;
    },
  ): AbortSignal | undefined {
    if (this.state.busy !== undefined) return undefined;
    this.controller = new AbortController();
    // The rest of the app has no other way to know staging is being rewritten.
    getEHRuntime().setInstallBusy(true);
    this.set({
      busy,
      lines: opts?.keepReport === true ? this.state.lines : [],
      progress: undefined,
      note: undefined,
    });
    return this.controller.signal;
  }

  progress(message: string | undefined): void {
    if (this.state.busy === undefined) return;
    this.set({ ...this.state, ...(message === undefined ? {} : { progress: message }) });
  }

  /**
   * Finish a run. The report is kept — it is the reason the run happened.
   *
   * Pass `undefined` for `lines` to leave the standing report untouched: a
   * note-only run (a Nexus re-check) must not erase the report of the update
   * run before it.
   */
  finish(lines: string[] | undefined, note?: string): void {
    this.controller = undefined;
    getEHRuntime().setInstallBusy(false);
    this.set({
      busy: undefined,
      lines: lines ?? this.state.lines,
      ...(note === undefined ? {} : { note }),
    });
  }

  /** A note with no run behind it, e.g. "Nexus re-checked". */
  say(note: string | undefined): void {
    this.set({ ...this.state, ...(note === undefined ? {} : { note }) });
  }

  setRequirements(cache: RequirementsCache | undefined): void {
    const { requirements: _drop, ...rest } = this.state;
    this.set(cache === undefined ? rest : { ...rest, requirements: cache });
  }

  /** Ask the running action to stop at its next checkpoint. */
  cancel(): void {
    this.controller?.abort();
    this.progress("Stopping after the current mod...");
  }

  /** Clear a finished report once the curator has read it. */
  dismiss(): void {
    if (this.state.busy !== undefined) return;
    // The report goes; the requirements survive — they cost a Nexus round.
    this.set({
      ...IDLE,
      ...(this.state.requirements === undefined ? {} : { requirements: this.state.requirements }),
    });
  }

  private set(next: CuratorSnapshot): void {
    this.state = next;
    for (const listener of this.listeners) {
      try {
        listener(next);
      } catch {
        /* one bad subscriber must not poison the others */
      }
    }
  }
}

let singleton: CuratorSession | undefined;

export function getCuratorSession(): CuratorSession {
  if (singleton === undefined) singleton = new CuratorSession();
  return singleton;
}
