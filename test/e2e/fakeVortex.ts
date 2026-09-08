/**
 * A Vortex that installs, for driving the real install driver in tests.
 *
 * The install side is 5,600 lines and, until now, was reachable only by
 * installing a collection by hand in Vortex. That is a slow loop and a
 * one-shot one: the interesting cases (a refused install, a mod whose bytes
 * diverge, a FOMOD whose choices must be replayed) are awkward to stage on a
 * real machine and trivial to stage here.
 *
 * The whole surface the installer touches is small — measured across
 * `src/core/installer`: `getState`, `store.dispatch`, `events`, and
 * `ext.nexusDownload`. That is what this implements, with Vortex's real
 * semantics rather than placeholders:
 *
 *  - `nexusDownload` returns an archiveId, and only installs when
 *    `allowInstall` is true, which is the flag the replay path turns off.
 *  - `start-install-download` and `start-install` complete asynchronously by
 *    emitting `did-install-mod`, because that is the order the driver depends
 *    on: it subscribes, emits, and waits.
 *  - every emit is recorded, so a test can assert the CALL and not just the
 *    outcome — the level at which this project's bugs have actually lived.
 */

import { EventEmitter } from "events";
import * as fs from "fs";
import * as path from "path";

import type { types } from "@nexusmods/vortex-api";

export type RecordedEmit = { event: string; args: unknown[] };

export type FakeVortex = {
  api: types.IExtensionApi;
  emits: RecordedEmit[];
  dispatched: unknown[];
  /** Mods the fake "installed", in order, keyed by the id it handed back. */
  installed: Array<{ vortexModId: string; archiveId: string }>;
  /** Make the next install fail through Vortex's callback. */
  failNextInstall: (message: string) => void;
  /** Make deployment fail — the step after every mod is installed. */
  failDeployment: (message: string) => void;
  state: Record<string, unknown>;
};

export function makeFakeVortex(args: {
  gameId: string;
  /** Downloads Vortex already knows about: archiveId → local path. */
  downloads?: Record<string, string>;
  /**
   * Where installed mods land. Pass the world's `stagingRoot`.
   *
   * Without this the fake acknowledged installs but left no mod record and no
   * bytes, so `verifyModInstall` and `findDriftedMods` could not resolve a
   * staging folder and quietly did nothing. Every verification path — the
   * curator-diverged case, the damaged archive, drift on update — was
   * therefore unreachable end to end, which is precisely the layer this
   * project's bugs live at.
   */
  stagingRoot?: string;
  /**
   * What an install actually PUTS ON DISK, by archiveId (`dl-<modId>-<fileId>`
   * for a Nexus mod, `from-path:<path>` for a local archive).
   *
   * This is the knob the interesting tests turn. Returning the manifest's exact
   * bytes models a clean install; returning different bytes models a corrupted
   * one; omitting a file models Vortex's lost-file bug. Returning `undefined`
   * writes nothing, which is the old behaviour.
   */
  installProduces?: (archiveId: string) => Record<string, string> | undefined;
  /**
   * The discovered game directory, so `getGameDirectory` resolves.
   *
   * Without it the driver cannot find the Data folder and the ESL-flag pass
   * has nothing to read — it would report "could not locate" and every
   * assertion about flags would hold vacuously.
   */
  gamePath?: string;
  /**
   * How the LOOT sort behaves: call back cleanly (default), report a cycle, or
   * never answer.
   *
   * It MUST answer by default. The real extension always calls back, and a
   * double that stays silent makes every install wait out applyPluginOrder's
   * ten-minute sort timeout.
   */
  sortBehaviour?: "ok" | { error: string } | "never";
}): FakeVortex {
  const events = new EventEmitter();
  const emits: RecordedEmit[] = [];
  const dispatched: unknown[] = [];
  const installed: Array<{ vortexModId: string; archiveId: string }> = [];
  let failure: string | undefined;
  let deployFailure: string | undefined;
  let modSeq = 0;

  const state: Record<string, unknown> = {
    settings: {
      profiles: { activeProfileId: "profile-1", activeGameId: args.gameId },
      ...(args.gamePath !== undefined
        ? { gameMode: { discovered: { [args.gameId]: { path: args.gamePath } } } }
        : {}),
    },
    // The driver reads session.base to tell "Vortex is asking the user
    // something" from "Vortex is hung". Absent would read as no dialog, which
    // is what we want by default — but it has to exist for the shape to match.
    session: { base: { visibleDialog: "", overlayOpen: false } },
    persistent: {
      profiles: { "profile-1": { gameId: args.gameId, modState: {} } },
      mods: { [args.gameId]: {} },
      downloads: {
        files: Object.fromEntries(
          Object.entries(args.downloads ?? {}).map(([id, localPath]) => [
            id,
            { localPath, state: "finished", received: 1, size: 1 },
          ]),
        ),
      },
    },
  };

  const realEmit = events.emit.bind(events);
  const complete = (archiveId: string, cb?: unknown): void => {
    // Asynchronous on purpose: the driver subscribes, emits, then awaits.
    // Completing synchronously would let a driver that never subscribed pass.
    setTimeout(() => {
      if (failure !== undefined) {
        const message = failure;
        failure = undefined;
        if (typeof cb === "function") (cb as (e: Error) => void)(new Error(message));
        return;
      }
      const vortexModId = `installed-${++modSeq}`;
      installed.push({ vortexModId, archiveId });

      // Vortex registers the mod and writes its files BEFORE announcing the
      // install. Anything that reads staging off the back of `did-install-mod`
      // — verification, drift, the staging-set hash — depends on that order,
      // so a double that emits first would let a driver reading too early pass.
      const files = args.installProduces?.(archiveId);
      if (args.stagingRoot !== undefined && files !== undefined) {
        const dir = path.join(args.stagingRoot, vortexModId);
        for (const [rel, contents] of Object.entries(files)) {
          const full = path.join(dir, ...rel.split("/"));
          fs.mkdirSync(path.dirname(full), { recursive: true });
          fs.writeFileSync(full, contents);
        }
      }
      const mods = (state.persistent as { mods: Record<string, Record<string, unknown>> })
        .mods[args.gameId];
      mods[vortexModId] = {
        id: vortexModId,
        installationPath: vortexModId,
        type: "",
        // Vortex records which download a mod came from, and it is the ONLY
        // route back to the archive on disk. Without it every archive-based
        // check — the reinstall judge, the identity check — degrades to "no
        // archive" and silently reinstalls instead.
        archiveId,
        attributes: { name: vortexModId, version: "1.0.0" },
      };

      realEmit("did-install-mod", args.gameId, archiveId, vortexModId);
    }, 0);
  };

  (events as unknown as { emit: (e: string, ...a: unknown[]) => boolean }).emit = (
    event: string,
    ...rest: unknown[]
  ): boolean => {
    emits.push({ event, args: rest });
    if (event === "start-install-download") {
      // (downloadId, options?, cb?) — the shape Vortex was observed to use.
      complete(rest[0] as string, rest[2] ?? rest[1]);
    } else if (event === "start-install") {
      complete(`from-path:${String(rest[0])}`, rest[1]);
    } else if (event === "autosort-plugins") {
      // (force, callback). The real extension always calls back — a double
      // that stays silent would make every install sit out applyPluginOrder's
      // ten-minute sort timeout, turning a wiring bug into a slow test.
      const behaviour = args.sortBehaviour ?? "ok";
      const cb = rest[1];
      if (typeof cb === "function" && behaviour !== "never") {
        setTimeout(() => {
          (cb as (e: Error | null) => void)(
            behaviour === "ok" ? null : new Error(behaviour.error),
          );
        }, 0);
      }
    } else if (event === "deploy-mods") {
      /**
       * ─── THE REAL SIGNATURE, NOT OURS ──────────────────────────────────
       * Vortex registers this, verbatim from `app.asar`:
       *
       *   events.on("deploy-mods",
       *     (callback, profileId, progressCB, deployOptions) =>
       *       callback.called || deploymentTimer.runNow(callback, ...))
       *
       * The CALLBACK IS FIRST. This double used to read `rest[0]` as the
       * profile id and `rest[1]` as the callback — modelling the driver's
       * call rather than Vortex's contract — so it agreed with a bug instead
       * of catching it. The driver passed the profile id where the callback
       * belonged, Vortex's debouncer stored the string and later ran
       * `cb(err)` on it, and two testers got "TypeError: cb is not a
       * function" thirty seconds after a successful install.
       *
       * So the double now enforces the contract rather than tolerating it: a
       * non-function first argument throws HERE, loudly and synchronously,
       * instead of quietly hanging until the deploy budget expires.
       */
      const cb = rest[0];
      const profileId = rest[1];
      if (typeof cb !== "function") {
        throw new TypeError(
          `deploy-mods expects the callback FIRST — got ${typeof cb}. ` +
            `Vortex would store this and later call it, throwing ` +
            `"cb is not a function" once the deployment settled.`,
        );
      }
      setTimeout(() => {
        if (deployFailure !== undefined) {
          const message = deployFailure;
          deployFailure = undefined;
          (cb as (e: Error) => void)(new Error(message));
          return;
        }
        realEmit("did-deploy", profileId);
        // Vortex calls the callback with `null` when the deployment settles,
        // as well as emitting the event. Both, because the driver accepts
        // either and a double that models only one hides a dependence.
        (cb as (e: null) => void)(null);
      }, 0);
    }
    return realEmit(event, ...rest);
  };

  const api = {
    events,
    getState: () => state,
    store: {
      dispatch: (action: unknown): void => {
        dispatched.push(action);
        const a = action as { type?: string; payload?: unknown };
        if (a?.type === "STUB_SET_PROFILE") {
          // Vortex would put the new profile in state; the driver reads it
          // back when reconciling, so a double that only records is a double
          // that deadlocks.
          const profile = a.payload as { id: string; gameId: string };
          const profiles = (state.persistent as { profiles: Record<string, unknown> })
            .profiles;
          profiles[profile.id] = { ...profile, modState: {} };
        }
        if (a?.type === "STUB_SET_NEXT_PROFILE") {
          // The switch is asynchronous in Vortex and the driver waits on the
          // event, not the dispatch.
          const id = a.payload as string;
          setTimeout(() => {
            (
              (state.settings as { profiles: Record<string, unknown> }).profiles as {
                activeProfileId?: string;
              }
            ).activeProfileId = id;
            realEmit("profile-did-change", id);
          }, 0);
        }
      },
    },
    ext: {
      nexusDownload: async (
        _gameId: string,
        modId: number,
        fileId: number,
        _fileName?: string,
        allowInstall?: boolean,
      ): Promise<string> => {
        const archiveId = `dl-${modId}-${fileId}`;
        // The one-step path: Vortex downloads AND installs. The replay path
        // passes false precisely to get between the two.
        if (allowInstall === true) complete(archiveId);
        return archiveId;
      },
    },
  } as unknown as types.IExtensionApi;

  return {
    api,
    emits,
    dispatched,
    installed,
    state,
    failNextInstall: (message: string): void => {
      failure = message;
    },
    failDeployment: (message: string): void => {
      deployFailure = message;
    },
  };
}

/** Every emit of one event, in order. */
export function emitsOf(fake: FakeVortex, event: string): RecordedEmit[] {
  return fake.emits.filter((e) => e.event === event);
}
