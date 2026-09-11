/**
 * InstallSession — module-scope state machine for the install wizard.
 *
 * Why this exists: same bug we hit on the build side. Vortex remounts
 * main pages on every tab switch, so the install wizard's React-local
 * `useReducer` + `loadAbortRef` were silently aborting and resetting
 * the user's hashing pipeline whenever they peeked at another tab.
 * Worse, the long `installing` phase (which has no abort affordance)
 * would keep running orphaned with no UI handle, so a return to the
 * tab could double-trigger.
 *
 * Hoisting the state into a module-level singleton keeps:
 *   • Hashing alive in the background while the user looks at other
 *     parts of Vortex; tab switch back picks the live state right up.
 *   • `installing` in flight without a stale React cleanup killing
 *     its reference. The component that comes back in just observes
 *     a "still installing" snapshot and renders progress.
 *
 * Pairs with `BuildSession` (same shape, same lifecycle rules). Read
 * `buildSession.ts` for the design rationale; this file mirrors it.
 *
 * What's different from BuildSession:
 *   • Decisions / conflicts / orphans live mid-flow, so the public
 *     API has more methods (one per user-visible interaction).
 *   • There is intentionally NO AbortController for the `installing`
 *     phase: the install driver mutates Vortex state (mods/, downloads,
 *     deployment) and aborting in the middle would leave it in a
 *     half-applied state. The driver is therefore non-cancellable
 *     after the user clicks Install on the confirm step. We surface
 *     that contract to the UI so users aren't shown a fake "Cancel"
 *     button during installing.
 */

import { isAbort } from "../../../utils/abortError";
import type { types } from "@nexusmods/vortex-api";

import { AbortError } from "../../../core/archiveHashing";
import { ehLog as logFailure } from "../../../core/logging/ehLog";
import { runInstall } from "../../../core/installer/runInstall";
import { getEHRuntime } from "../../runtime/ehRuntime";
import {
  formatError,
  type FormattedError,
} from "../../errors";
import {
  runLoadingPipeline,
  runLoadingPipelineWithReceipt,
} from "./engine";
import { fetchLink } from "./fetchLink";
import { parseInstallLink } from "../../../core/installer/installLink";
import type { ConflictChoice, OrphanChoice } from "../../../types/installDriver";
import type { FomodReplayMode } from "../../../core/installer/fomodReplayMode";
import { blocksInstall as autoDeployBlocks } from "../../../core/installer/autoDeploy";
import { blocksInstall as autoSortBlocks } from "../../../core/installer/autoSort";
import { probeDeploymentMethod } from "../../../core/installer/probeDeployment";
import {
  fillDefaultConflictChoices,
  fillDefaultOrphanChoices,
  initialWizardState,
  wizardReducer,
  type PreviewBundle,
  type WizardAction,
  type WizardState,
} from "./state";

// ───────────────────────────────────────────────────────────────────────
// Types
// ───────────────────────────────────────────────────────────────────────

/**
 * What subscribers see. We expose `errorSeq` separately from the
 * wizard state so the React layer can fire `reportError` exactly once
 * per failure, even when the component remounts into an already-errored
 * session and re-runs the toast / modal effect.
 */
export interface InstallSessionSnapshot {
  state: WizardState;
  errorSeq: number;
}

export type InstallSessionListener = (snapshot: InstallSessionSnapshot) => void;

export type StaleReceiptResolution = "delete" | "keep" | "cancel";

// ───────────────────────────────────────────────────────────────────────
// Implementation
// ───────────────────────────────────────────────────────────────────────

class InstallSession {
  private state: WizardState = initialWizardState;
  private errorSeq = 0;
  private readonly listeners = new Set<InstallSessionListener>();

  /** Active controller for the loading pipeline (and stale-resume). */
  private loadingController: AbortController | undefined;
  /**
   * Set true while runInstall is in flight. Used to reject re-entry
   * from a duplicate "Install" click on a remounted component.
   */
  private installInFlight = false;
  /** Abort handle for the in-flight install; undefined when none is running. */
  private installController: AbortController | undefined;

  getSnapshot(): InstallSessionSnapshot {
    return { state: this.state, errorSeq: this.errorSeq };
  }

  subscribe(listener: InstallSessionListener): () => void {
    this.listeners.add(listener);
    return (): void => {
      this.listeners.delete(listener);
    };
  }

  // ── Phase: pick → loading ────────────────────────────────────────

  /**
   * User picked a `.ehcoll` file. Aborts any previous in-flight load
   * (e.g. the user picked a different file mid-stream) and kicks off
   * the loading pipeline. Hashing progress is reported via state
   * mutations; subscribers re-render automatically.
   */
  pickFile(api: types.IExtensionApi, zipPath: string): void {
    // Replace any existing controller — if the user picked one file,
    // looked at another tab while it hashed, came back and picked a
    // different file, we want the second pick to win.
    this.loadingController?.abort();
    const controller = new AbortController();
    this.loadingController = controller;

    this.dispatch({ type: "pick-file", zipPath });

    void (async (): Promise<void> => {
      try {
        const outcome = await runLoadingPipeline({
          api,
          zipPath,
          signal: controller.signal,
          events: {
            onPhase: (phase, hashCount): void => {
              if (this.loadingController !== controller) return;
              this.dispatch({ type: "loading-phase", phase, hashCount });
            },
            onHashProgress: (done, total, currentItem): void => {
              if (this.loadingController !== controller) return;
              this.dispatch({
                type: "hash-progress",
                done,
                total,
                currentItem,
              });
            },
          },
        });
        if (this.loadingController !== controller) return;
        this.loadingController = undefined;

        if (outcome.kind === "stale-receipt") {
          this.dispatch({
            type: "needs-stale-resolution",
            zipPath,
            ehcoll: outcome.ehcoll,
            receipt: outcome.receipt,
            appDataPath: outcome.appDataPath,
          });
          return;
        }

        this.dispatch({
          type: "plan-ready",
          bundle: {
            zipPath,
            ehcoll: outcome.ehcoll,
            receipt: outcome.receipt,
            plan: outcome.plan,
            appDataPath: outcome.appDataPath,
            // Forwarded explicitly. The bundle is built field-by-field, so a
            // new field on PreviewBundle is silently dropped unless it is
            // named here — which is how a declared-but-never-populated field
            // gets into this codebase.
            ...(outcome.extractorBlocked !== undefined
              ? { extractorBlocked: outcome.extractorBlocked }
              : {}),
            ...(outcome.runtimeFindings !== undefined
              ? { runtimeFindings: outcome.runtimeFindings }
              : {}),
            ...(outcome.environment !== undefined
              ? { environment: outcome.environment }
              : {}),
          },
        });
      } catch (err) {
        if (this.loadingController !== controller) return;
        this.loadingController = undefined;
        if (isAbortError(err)) {
          // User-initiated cancel. Send them back to the picker with
          // no error modal — they know what they did.
          this.dispatch({ type: "reset" });
          return;
        }
        this.failWith(err, {
          title: "Couldn't prepare the install",
          context: { step: "loading", zipPath },
        });
      }
    })();
  }

  cancelLoading(): void {
    if (this.state.kind !== "loading") return;
    this.loadingController?.abort();
  }

  // ── Phase: pick → link-fetching → loading ─────────────────────────

  /**
   * User pasted a link instead of picking a file. Nexus mod pages go
   * through Vortex's Nexus integration, direct links are fetched by Event
   * Horizon; either way the outcome is a path handed to {@link pickFile},
   * or a "download it yourself" screen when Nexus will not issue a link to
   * this account. A bad link is reported without leaving the picker.
   */
  installFromLink(api: types.IExtensionApi, input: string): void {
    const link = parseInstallLink(input);
    if (link.kind === "invalid") {
      this.failWith(new Error(link.why), {
        title: "That link can't be used",
        context: { step: "link", input: input.trim().slice(0, 200) },
      });
      return;
    }
    this.loadingController?.abort();
    const controller = new AbortController();
    this.loadingController = controller;
    const trimmed = input.trim();
    this.dispatch({ type: "link-start", link: trimmed, source: link.kind });
    void (async (): Promise<void> => {
      try {
        const outcome = await fetchLink(api, link, controller.signal, {
          onPhase: (phase, detail): void => {
            if (this.loadingController !== controller) return;
            this.dispatch({ type: "link-progress", phase, ...detail });
          },
        });
        if (this.loadingController !== controller) return;
        this.loadingController = undefined;
        if (outcome.kind === "manual") {
          this.dispatch({
            type: "link-manual",
            link: trimmed,
            pageUrl: outcome.pageUrl,
            fileName: outcome.fileName,
            ...(outcome.size !== undefined ? { size: outcome.size } : {}),
            ...(outcome.version !== undefined ? { version: outcome.version } : {}),
            why: outcome.why,
          });
          return;
        }
        this.pickFile(api, outcome.zipPath);
      } catch (err) {
        if (this.loadingController !== controller) return;
        this.loadingController = undefined;
        if (isAbortError(err)) {
          this.dispatch({ type: "reset" });
          return;
        }
        this.failWith(err, {
          title: "Couldn't fetch the collection",
          context: { step: "link", link: trimmed.slice(0, 200) },
        });
      }
    })();
  }

  /**
   * Stop waiting for a link. A direct download is cut and its part kept
   * for next time; a download Vortex is running is left to Vortex.
   */
  cancelLink(): void {
    if (this.state.kind !== "link-fetching") return;
    this.loadingController?.abort();
  }

  /** From the "download it yourself" screen: the ordinary picker, then the ordinary flow. */
  pickDownloadedFile(api: types.IExtensionApi): void {
    if (this.state.kind !== "link-manual") return;
    void (async (): Promise<void> => {
      try {
        const { pickEhcollFile } = await import("../../../utils/utils");
        const file = await pickEhcollFile(api);
        if (file !== undefined) this.pickFile(api, file);
      } catch (err) {
        this.failWith(err, { title: "Couldn't open file picker", context: { step: "link-manual" } });
      }
    })();
  }

  // ── Phase: stale-receipt → resume loading ────────────────────────

  /**
   * Resolve a stale-receipt prompt. `keep` and `delete` re-run the
   * second half of the loading pipeline with an explicit receipt
   * choice. `cancel` returns the user to the picker.
   */
  resolveStaleReceipt(
    api: types.IExtensionApi,
    choice: StaleReceiptResolution,
  ): void {
    if (this.state.kind !== "stale-receipt") return;
    if (choice === "cancel") {
      this.dispatch({ type: "reset" });
      return;
    }

    const carry = this.state;
    this.loadingController?.abort();
    const controller = new AbortController();
    this.loadingController = controller;

    // Visual: drop back into the loading skeleton — we're about to
    // re-run the resolver with the user's choice baked in.
    this.dispatch({ type: "pick-file", zipPath: carry.zipPath });

    void (async (): Promise<void> => {
      try {
        const outcome = await runLoadingPipelineWithReceipt({
          api,
          zipPath: carry.zipPath,
          ehcoll: carry.ehcoll,
          receipt: choice === "keep" ? carry.receipt : undefined,
          appDataPath: carry.appDataPath,
          events: {
            onPhase: (phase, hashCount): void => {
              if (this.loadingController !== controller) return;
              this.dispatch({ type: "loading-phase", phase, hashCount });
            },
            onHashProgress: (done, total, currentItem): void => {
              if (this.loadingController !== controller) return;
              this.dispatch({
                type: "hash-progress",
                done,
                total,
                currentItem,
              });
            },
          },
        });
        if (this.loadingController !== controller) return;
        this.loadingController = undefined;
        this.dispatch({
          type: "plan-ready",
          bundle: {
            zipPath: carry.zipPath,
            ehcoll: outcome.ehcoll,
            receipt: outcome.receipt,
            plan: outcome.plan,
            appDataPath: outcome.appDataPath,
            ...(outcome.extractorBlocked !== undefined
              ? { extractorBlocked: outcome.extractorBlocked }
              : {}),
            ...(outcome.runtimeFindings !== undefined
              ? { runtimeFindings: outcome.runtimeFindings }
              : {}),
            ...(outcome.environment !== undefined
              ? { environment: outcome.environment }
              : {}),
          },
        });
      } catch (err) {
        if (this.loadingController !== controller) return;
        this.loadingController = undefined;
        if (isAbortError(err)) {
          this.dispatch({ type: "reset" });
          return;
        }
        this.failWith(err, {
          title: "Couldn't prepare the install",
          context: { step: "stale-resume", zipPath: carry.zipPath },
        });
      }
    })();
  }

  // ── Phase: preview → decisions → confirm ─────────────────────────

  /**
   * preview → decisions. Conflict and orphan choices start empty;
   * defaults are applied lazily on `openConfirm`.
   */
  openDecisionsFromPreview(): void {
    if (this.state.kind !== "preview") return;
    const bundle = this.state.bundle;
    this.dispatch({
      type: "open-decisions",
      bundle,
      conflictChoices: {},
      orphanChoices: {},
    });

    // Pre-fill the answers this collection was given last time, for the files
    // that are STILL THERE. Checked rather than trusted: a stale path fails
    // silently, pre-filling an answer nobody re-confirms and installing from a
    // file that has moved or changed. A missing one is simply asked again.
    void (async (): Promise<void> => {
      const { readSourceMemory, usableSources } = await import(
        "../../../core/installer/sourceMemory"
      );
      const remembered = await usableSources(
        await readSourceMemory(
          bundle.appDataPath,
          bundle.plan.manifest.package.id,
        ),
      );
      if (this.state.kind !== "decisions") return;
      for (const [compareKey, source] of Object.entries(remembered)) {
        // Never overwrite something the user has already touched on this
        // screen — they may have started answering before this resolved.
        if (this.state.conflictChoices[compareKey] !== undefined) continue;
        this.dispatch({
          type: "set-conflict-choice",
          compareKey,
          choice: { kind: "use-local-file", localPath: source.path },
        });
      }
    })();
  }

  setConflictChoice(compareKey: string, choice: ConflictChoice): void {
    this.dispatch({ type: "set-conflict-choice", compareKey, choice });

    // Remember where the user found this mod, NOW rather than at the end.
    //
    // The run that most needs this is the one that does not finish: recording
    // on success would remember only the answers already paid off by a
    // completed install, and forget exactly the ones the user would have to
    // give again. A tester with two dozen external mods had to re-supply every
    // one of them to resume.
    if (choice.kind !== "use-local-file") return;
    const bundle =
      this.state.kind === "decisions" || this.state.kind === "confirm"
        ? this.state.bundle
        : undefined;
    if (bundle === undefined) return;
    void (async (): Promise<void> => {
      const { rememberSource } = await import(
        "../../../core/installer/sourceMemory"
      );
      await rememberSource(
        bundle.appDataPath,
        bundle.plan.manifest.package.id,
        compareKey,
        choice.localPath,
      );
    })();
  }

  setOrphanChoice(modId: string, choice: OrphanChoice): void {
    this.dispatch({ type: "set-orphan-choice", modId, choice });
  }

  /**
   * How the curator's FOMOD answers get replayed. Asked on the confirm step,
   * because that is the last moment before anything is written and the only
   * one where the trade-off is still the user's to make.
   */
  setFomodReplayMode(mode: FomodReplayMode): void {
    this.dispatch({ type: "set-fomod-mode", mode });
  }

  backToPreview(): void {
    this.dispatch({ type: "back-to-preview" });
  }

  /**
   * decisions → confirm. Defaults are filled for any choice the user
   * didn't explicitly resolve so the confirm step shows the exact
   * decisions that will be applied.
   */
  openConfirm(): void {
    if (this.state.kind !== "decisions") return;
    const filledConflicts = fillDefaultConflictChoices(
      this.state.bundle,
      this.state.conflictChoices,
    );
    const filledOrphans = fillDefaultOrphanChoices(
      this.state.bundle,
      this.state.orphanChoices,
    );
    this.dispatch({
      type: "open-confirm",
      decisions: {
        conflictChoices: filledConflicts,
        orphanChoices: filledOrphans,
        fomodReplayMode: this.state.fomodReplayMode,
      },
    });
  }

  backFromConfirm(): void {
    this.dispatch({ type: "back-from-confirm" });
  }

  /**
   * The blocked dialog, with an offer to actually fix it.
   *
   * Telling a user their extractor is broken and leaving them to find
   * protontricks is the failure this whole feature exists to avoid. Most
   * people running a 900-mod collection did not sign up to debug a DLL search
   * path, so the dialog offers to install the runtimes itself.
   *
   * It never claims success from an exit code: the repair re-runs the 7-Zip
   * self-test afterwards and reports what THAT said. "Installed, and it works
   * now" and "installed, and it still does not" are different sentences, and
   * the second one is the useful one because it redirects to the Proton build.
   */
  private async offerRuntimeRepair(
    api: types.IExtensionApi,
    blocked: NonNullable<PreviewBundle["extractorBlocked"]>,
  ): Promise<void> {
    const NL = String.fromCharCode(10);
    const body = [
      blocked.message,
      "",
      `${blocked.toUnpack} of this collection's mods still have to be ` +
        `unpacked, and every one of them would fail. Nothing is lost by ` +
        `stopping now.`,
      "",
      "Event Horizon can download and install the Microsoft runtimes this " +
        "usually needs, then re-test the extractor and tell you whether it " +
        "actually helped.",
      "",
      ...blocked.steps,
    ].join(NL);

    const choice = await api.showDialog?.(
      "error",
      "Vortex cannot unpack mod archives",
      { text: body },
      [{ label: "Close" }, { label: "Install runtimes" }],
    );
    if (choice?.action !== "Install runtimes") return;

    try {
      const [{ installPrerequisites, summarisePrereqResults }, { nodePrereqDeps }, prereqs, health] =
        await Promise.all([
          import("../../../core/runtime/installPrerequisites"),
          import("../../../core/runtime/nodePrereqDeps"),
          import("../../../core/runtime/prerequisites"),
          import("../../../core/installer/checkSevenZipHealth"),
        ]);

      const onWine = health.looksLikeWine();
      const plan = prereqs
        .planPrerequisites({ onWine, aggressive: true })
        .filter((p) => p.preselected);

      api.sendNotification?.({
        id: "eh-prereq-repair",
        type: "activity",
        title: "Installing runtimes",
        message: "Downloading…",
      });

      const results = await installPrerequisites(
        plan,
        // The verify is the whole point: re-probe the actual thing we are
        // trying to fix rather than trusting the installer's exit code.
        nodePrereqDeps(async () => (await health.checkSevenZipHealth()).kind === "ok"),
        {
          onStep: (step) => {
            api.sendNotification?.({
              id: "eh-prereq-repair",
              type: "activity",
              title: "Installing runtimes",
              message:
                step.phase === "downloading"
                  ? `Downloading ${step.id}…`
                  : step.phase === "installing"
                    ? `Installing ${step.id}…`
                    : step.phase === "verifying"
                      ? "Re-testing the extractor…"
                      : `${step.id} done`,
            });
          },
        },
      );

      api.dismissNotification?.("eh-prereq-repair");
      const summary = summarisePrereqResults(results, onWine);

      /**
       * ─── A REPAIR THAT WORKED HAS TO CLEAR THE GATE IT UNBLOCKED ───────
       * `extractorBlocked` is written once during loading and read by the
       * gate in `startInstall`. Nothing cleared it, and the repair never
       * re-ran the preflight — so the dialog said "Installed, and the
       * extractor works now. You can start the install.", the user pressed
       * Install, and the gate fired again off the stale snapshot. Repeating
       * the repair hit 1638 (already-current), verified true, and printed the
       * same encouraging sentence forever. The only escape was re-picking the
       * .ehcoll, which nothing told them about.
       *
       * `summary.fixed` is not "the installer exited 0" — it is the 7-Zip
       * self-test passing afterwards, which is the same probe the gate is
       * standing on. So when it is true, the gate's reason is gone.
       */
      if (summary.fixed) {
        this.dispatch({ type: "extractor-unblocked" });
        const { ehLog: log } = await import("../../../core/logging/ehLog");
        log("info", "prereq.repair.gate-cleared", {});
      }

      const { ehLog } = await import("../../../core/logging/ehLog");
      ehLog(summary.fixed ? "info" : "warn", "prereq.repair", {
        onWine,
        attempted: results.map((r) => r.id),
        verdicts: results.map((r) => r.verdict.kind),
        verified: results.map((r) => r.verified),
      });

      void api.showDialog?.(
        summary.fixed ? "info" : "error",
        summary.fixed ? "Runtimes installed" : "Still not working",
        {
          text: [
            summary.message,
            "",
            ...results.map(
              (r) =>
                `${r.name}: ${r.verdict.kind}` +
                (r.verdict.kind === "failed" ? ` — ${r.verdict.why}` : ""),
            ),
            ...(summary.fixed
              ? []
              : ["", ...blocked.steps]),
          ].join(NL),
        },
        [{ label: "Close" }],
      );
    } catch (err) {
      api.dismissNotification?.("eh-prereq-repair");
      void api.showDialog?.(
        "error",
        "Could not install the runtimes",
        {
          text: [
            err instanceof Error ? err.message : String(err),
            "",
            ...blocked.steps,
          ].join(NL),
        },
        [{ label: "Close" }],
      );
    }
  }

  // ── Phase: confirm → installing → done ───────────────────────────

  /**
   * Kick off the install driver.
   *
   * Cancellable, but only at the seams the driver chooses. Every `checkAbort`
   * in runInstall sits after a unit of work completes — after a mod is
   * installed AND enabled, after a phase ends — so a stop lands between mods
   * and never inside one. That is what makes this safe to expose: the concern
   * that kept it non-cancellable was a half-written mod, and the driver
   * structurally cannot produce one.
   *
   * What a stop DOES leave is a partial install, which is why the aborted
   * result carries `installedSoFar`. Nothing is rolled back.
   *
   * We also survive a remount: the component that comes back in just observes
   * the live progress.
   */
  startInstall(api: types.IExtensionApi): void {
    if (this.state.kind !== "confirm") return;
    if (this.installInFlight) return;

    // THE GATE. Vortex's extractor is dead, so every mod that still has to be
    // unpacked would fail. This used to be a dismissible notification during
    // loading, and a tester ran a 963-mod install four minutes after we had
    // already detected the problem.
    //
    // Only a FATAL verdict reaches here — a broken `list` with working
    // extraction does not block, because our listing paths are native-first.
    // And a collection whose mods are ALL already installed needs no
    // extraction at all, so it is still allowed through.
    const blocked = this.state.bundle.extractorBlocked;
    if (blocked !== undefined && blocked.toUnpack > 0) {
      void this.offerRuntimeRepair(api, blocked);
      return;
    }

    // THE SECOND GATE, and the same lesson one stage further on.
    //
    // Vortex can stage every mod perfectly and still have no way to LINK them
    // into the game folder. A tester lost seventy minutes to exactly that: 963
    // mods staged, nothing deployed, and the first sign of it had appeared an
    // hour earlier on mod 489. Asked here it costs one synchronous call.
    //
    // Only `none` blocks. `unknown` proceeds — a preflight that refuses a
    // working install because it could not run its own check does more damage
    // than the failure it guards, and the driver still stops at the first real
    // occurrence.
    // THE THIRD GATE. Vortex's auto-deploy runs a deployment every time the
    // mod list changes — up to 967 of them here — and, worse than slow, one
    // can land BEFORE the collection's conflict rules are applied, linking the
    // wrong winner for every shared file. Every hash still matches afterwards,
    // which is what makes it the failure this project exists to prevent.
    //
    // Unlike the other two, this one is a boolean we can set, so it is offered
    // rather than described.
    // Read defensively for the same reason the plan shape is: a gate that
    // THROWS fails closed in the worst way, killing the install with a
    // TypeError instead of the thing it was guarding against.
    let liveState: unknown;
    try {
      liveState = api.getState();
    } catch {
      liveState = undefined;
    }
    if (autoDeployBlocks(liveState)) {
      void this.offerDisableAutoDeploy(api);
      return;
    }

    /**
     * The same gate for automatic plugin SORTING, and it matters for the same
     * reason: it silently replaces the curator's load order with LOOT's, both
     * during the run and every time the user deploys afterwards. It is on by
     * default in Vortex, so most users arrive with it enabled.
     */
    if (autoSortBlocks(liveState)) {
      void this.offerDisableAutoSort(api);
      return;
    }

    // Read defensively. Failing open is the rule for this whole check, and a
    // gate that THROWS on an unfamiliar plan shape fails closed in the worst
    // way — it takes down the install with a TypeError instead of the thing it
    // was guarding against.
    const gateGameId = (
      this.state.bundle.plan as { manifest?: { game?: { id?: unknown } } }
    )?.manifest?.game?.id;
    if (typeof gateGameId === "string" && gateGameId.length > 0) {
      const deployment = probeDeploymentMethod({ api, gameId: gateGameId });
      if (deployment.kind === "none") {
        void this.warnNoDeploymentMethod(api);
        return;
      }
    }

    /**
     * THE ENVIRONMENT GATE, last because it is the only one that changes the
     * game folder. Re-run rather than read from the preview: a tester who was
     * told to start the game once does exactly that and clicks Install again.
     * Blocked checks refuse with steps; then Vortex's deployment is purged and
     * anything the game would load that no record accounts for is moved aside,
     * with one confirmation. Passed once per plan.
     */
    if (
      typeof gateGameId === "string" &&
      gateGameId.length > 0 &&
      this.environmentClearedFor !== this.state.bundle.plan
    ) {
      void this.runEnvironmentGate(api);
      return;
    }

    this.installInFlight = true;
    const controller = new AbortController();
    this.installController = controller;
    const startState = this.state;

    this.dispatch({ type: "start-install" });

    void (async (): Promise<void> => {
      try {
        const result = await runInstall({
          api,
          plan: startState.bundle.plan,
          ehcoll: startState.bundle.ehcoll,
          ehcollZipPath: startState.bundle.zipPath,
          appDataPath: startState.bundle.appDataPath,
          decisions: startState.decisions,
          abortSignal: controller.signal,
          onProgress: (progress): void => {
            // Late progress events from a session that's already
            // moved on (e.g. user clicked "Start over" mid-install,
            // which we technically don't allow but be defensive).
            if (this.state.kind !== "installing") return;
            this.dispatch({ type: "install-progress", progress });
          },
        });
        this.installInFlight = false;
        this.installController = undefined;
        this.warnIfLeftUndeployed(api, startState.bundle.plan, result.kind);
        if (this.state.kind !== "installing") return;
        this.dispatch({ type: "install-result", result });
      } catch (err) {
        this.installInFlight = false;
        this.installController = undefined;
        this.warnIfLeftUndeployed(api, startState.bundle.plan, "crashed");
        this.failWith(err, {
          title: "Install driver crashed",
          context: {
            step: "installing",
            packageId: startState.bundle.plan.manifest.package.id,
          },
        });
      }
    })();
  }

  private environmentClearedFor: unknown = undefined;
  private environmentGateRunning = false;
  /** The plan whose install began right after Vortex's deployment was purged. */
  private purgedForPlan: unknown = undefined;

  /**
   * After a purge the game has no mods deployed until the install deploys them
   * again. A run that ends any other way has to say so, or the tester starts a
   * vanilla game and reports a broken collection.
   */
  private warnIfLeftUndeployed(api: types.IExtensionApi, plan: unknown, outcome: string): void {
    if (outcome === "success" || this.purgedForPlan !== plan) return;
    logFailure("warn", "install.ended-undeployed", { outcome });
    api.sendNotification?.({
      id: "event-horizon-undeployed",
      type: "warning",
      message:
        "Event Horizon purged Vortex's deployment before this install, and the install did not finish. Deploy in Vortex (or install again) to put your mods back into the game.",
    });
  }

  private async runEnvironmentGate(api: types.IExtensionApi): Promise<void> {
    if (this.state.kind !== "confirm" || this.environmentGateRunning) return;
    this.environmentGateRunning = true;
    const plan = this.state.bundle.plan;
    const manifest = plan.manifest;
    const gameId = manifest.game.id;
    const proceed = (): void => {
      if (this.state.kind !== "confirm" || this.state.bundle.plan !== plan) return;
      this.environmentClearedFor = plan;
      this.startInstall(api);
    };
    const NOTIFICATION = "event-horizon-environment-gate";
    // Up to three scans and a purge — minutes on a large setup. Say so, or the
    // Install button looks dead.
    api.sendNotification?.({
      id: NOTIFICATION,
      type: "activity",
      message: "Event Horizon: checking the game folder…",
    });
    let recordPath: string | undefined;
    let purged = false;
    try {
      // Inside the try: a module that fails to load must not leave the gate
      // flagged as running, with the Install button dead for the session.
      const [
        { gatherPreflightFacts, purgeGameDeployment },
        { runEnvironmentPreflight },
        { blockingChecks, describeBlockedChecks },
        { cleanGameFolder, describeCleanPlan },
        { scanGameFolder, groupEntries },
        { quarantineFiles, quarantineRootFor },
        { getEventHorizonDir },
        { getActiveGameId },
      ] = await Promise.all([
        import("../../../core/environment/vortexEnvironment"),
        import("../../../core/environment/preflight"),
        import("../../../core/environment/environmentChecks"),
        import("../../../core/environment/cleanGameFolder"),
        import("../../../core/environment/gameFolderScan"),
        import("../../../core/environment/quarantine"),
        import("../../../core/paths"),
        import("../../../core/getModsListForProfile"),
      ]);
      const facts = gatherPreflightFacts({
        state: api.getState(),
        gameId,
        externalDependencies: manifest.externalDependencies,
        ...(manifest.gameIni !== undefined ? { gameIni: manifest.gameIni } : {}),
      });
      const report = await runEnvironmentPreflight(facts, { scanFolder: false, context: "install-gate" });
      const blocked = blockingChecks(report.checks);
      if (blocked.length > 0) {
        logFailure("warn", "install.blocked.environment", { gameId, checks: blocked.map((c) => c.id) });
        await api.showDialog?.(
          "error",
          blocked.length === 1 ? blocked[0]!.title : `${facts.gameName} is not ready for this collection`,
          {
            text: "Event Horizon stopped before changing anything. Fix the following, then click Install again.",
            message: describeBlockedChecks(report.checks),
          },
          [{ label: "Close" }],
        );
        return;
      }
      const gameDir = report.gameDir;
      if (gameDir === undefined) {
        proceed();
        return;
      }
      // Vortex's purge acts on the ACTIVE game. The preview checked it, but a
      // user can switch games in Vortex between the preview and this click —
      // and then the purge would empty the deployment of a game this
      // collection has nothing to do with.
      const activeNow = getActiveGameId(api.getState());
      if (activeNow !== gameId) {
        logFailure("warn", "install.blocked.active-game-changed", { gameId, activeNow });
        await api.showDialog?.(
          "error",
          `Vortex is managing ${activeNow ?? "no game"} now, not ${facts.gameName}`,
          { text: `Switch Vortex back to ${facts.gameName} and click Install again. Nothing was changed.` },
          [{ label: "Close" }],
        );
        return;
      }
      const outcome = await cleanGameFolder({
        gameId,
        gameName: facts.gameName,
        quarantineFolder: quarantineRootFor(gameDir),
        scan: () =>
          scanGameFolder({
            gameDir,
            ...(facts.localGameDir !== undefined ? { localGameDir: facts.localGameDir } : {}),
            declared: facts.declared,
            ...(facts.executable !== undefined ? { executable: facts.executable } : {}),
          }),
        purge: async () => {
          // Checked again at the moment of purging: the scan before it takes a
          // while, and purge-mods empties whatever game is active THEN.
          const activeAtPurge = getActiveGameId(api.getState());
          if (activeAtPurge !== gameId) {
            throw new Error(
              `Vortex switched to ${activeAtPurge ?? "no game"} before the purge, so nothing was purged`,
            );
          }
          await purgeGameDeployment(api);
          purged = true;
        },
        confirm: async (preview) => {
          const d = describeCleanPlan(preview);
          const answer = await api.showDialog?.(
            "question",
            d.title,
            { text: d.text, message: d.message },
            [{ label: d.decline }, { label: d.confirm }],
          );
          return answer?.action === d.confirm;
        },
        quarantine: async (entries) => {
          const result = await quarantineFiles({
            gameId,
            gameDir,
            entries,
            reason: `Before installing ${manifest.package.name} v${manifest.package.version}`,
            recordDir: getEventHorizonDir("quarantine"),
          });
          recordPath = result.recordPath;
          return result;
        },
      });
      logFailure("info", "install.environment-gate.outcome", { gameId, outcome: outcome.kind, purged, recordPath });
      if (outcome.kind === "declined") return;
      if (outcome.kind === "failed") {
        await api.showDialog?.(
          "error",
          `The ${facts.gameName} folder could not be made clean`,
          {
            text: `${outcome.message} The install was not started.`,
            message: [
              ...groupEntries(outcome.remaining).map((g) => `${g.group} — ${g.files} file(s)`),
              ...(outcome.purged
                ? [
                    "",
                    "Vortex's deployment was purged, so the game has no mods deployed right now. Deploy in Vortex to put them back, or click Install again once the problem is fixed.",
                  ]
                : []),
              ...(outcome.recordPath !== undefined
                ? ["", "Files already moved aside can be put back from Doctor → Moved-aside files.", outcome.recordPath]
                : []),
            ].join("\n"),
          },
          [{ label: "Close" }],
        );
        return;
      }
      if (outcome.kind === "cleaned" && outcome.purged) this.purgedForPlan = plan;
      proceed();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logFailure("error", "install.environment-gate.crashed", {
        gameId,
        error: err instanceof Error ? err.stack ?? message : message,
        purged,
        recordPath,
      });
      const aftermath = [
        ...(recordPath !== undefined
          ? [`Some files were already moved aside. Doctor → Moved-aside files puts them back (${recordPath}).`]
          : []),
        ...(purged ? ["Vortex's deployment was purged. Deploy in Vortex puts your mods back."] : []),
      ];
      // A check that could not run must not become a wall: say so, with what
      // already happened, and let the user decide.
      const answer = await api.showDialog?.(
        "error",
        "The game setup check failed",
        {
          text: `Event Horizon could not finish checking the game folder: ${message}`,
          ...(aftermath.length > 0 ? { message: aftermath.join("\n") } : {}),
        },
        [{ label: "Cancel" }, { label: "Install anyway" }],
      );
      if (answer?.action === "Install anyway") {
        logFailure("warn", "install.environment-gate.overridden", { gameId, purged });
        if (purged) this.purgedForPlan = plan;
        proceed();
      }
    } finally {
      this.environmentGateRunning = false;
      api.dismissNotification?.(NOTIFICATION);
    }
  }

  /**
   * Tell the user deployment is impossible, before they spend the hour.
   *
   * A plain dialog rather than an offer to repair: unlike the 7-Zip runtimes,
   * this is a Vortex SETTING for their machine and their filesystem layout,
   * and picking one on their behalf could silently change how every mod they
   * already have is linked. Naming the exact screen is the most we should do.
   */
  private async warnNoDeploymentMethod(
    api: types.IExtensionApi,
  ): Promise<void> {
    const { looksLikeWine } = await import(
      "../../../core/installer/checkSevenZipHealth"
    );
    const { describeDeploymentBlock } = await import(
      "../../../core/installer/probeDeployment"
    );
    const { ehLog } = await import("../../../core/logging/ehLog");
    const described = describeDeploymentBlock(looksLikeWine());
    ehLog("warn", "install.blocked.no-deployment-method", {
      gameId:
        this.state.kind === "confirm"
          ? (this.state.bundle.plan as { manifest?: { game?: { id?: string } } })
              ?.manifest?.game?.id
          : undefined,
    });
    await api.showDialog?.(
      "error",
      described.title,
      { text: described.body },
      [{ label: "Close" }],
    );
  }

  /**
   * Offer to turn auto-deployment off, then continue.
   *
   * Offered, not done: it is the user's Vortex. And left off afterwards rather
   * than restored — a setting quietly changed back at the end of an hour-long
   * run is a worse surprise than one left where they agreed to put it.
   */
  private async offerDisableAutoDeploy(
    api: types.IExtensionApi,
  ): Promise<void> {
    if (this.state.kind !== "confirm") return;
    const modCount = this.state.bundle.plan.modResolutions.length;
    const [{ describeAutoDeployBlock }, { ehLog }, vortex] = await Promise.all([
      import("../../../core/installer/autoDeploy"),
      import("../../../core/logging/ehLog"),
      import("@nexusmods/vortex-api"),
    ]);
    const described = describeAutoDeployBlock(modCount);
    ehLog("warn", "install.blocked.auto-deploy", { modCount });

    const result = await api.showDialog?.(
      "question",
      described.title,
      { text: described.body },
      [{ label: described.decline }, { label: described.confirm }],
    );
    if (result?.action !== described.confirm) return;

    try {
      api.store?.dispatch(vortex.actions.setAutoDeployment(false));
      ehLog("info", "install.auto-deploy-disabled", {});
    } catch (err) {
      ehLog("warn", "install.auto-deploy-disable-failed", {
        error: String(err),
      });
      return;
    }
    // Straight on: the user has just agreed to install, and making them click
    // Install a second time after answering a question they did not raise is
    // the kind of friction that reads as a bug.
    this.startInstall(api);
  }

  /**
   * Offer to turn automatic plugin sorting off, then continue.
   *
   * Same contract as auto-deployment: offered rather than done, and left off
   * afterwards rather than quietly restored.
   */
  private async offerDisableAutoSort(
    api: types.IExtensionApi,
  ): Promise<void> {
    if (this.state.kind !== "confirm") return;
    const pluginCount = (
      this.state.bundle.plan as {
        manifest?: { plugins?: { order?: unknown[] } };
      }
    )?.manifest?.plugins?.order?.length;
    const [{ describeAutoSortBlock, ACTION_SET_AUTOSORT_ENABLED }, { ehLog }] =
      await Promise.all([
        import("../../../core/installer/autoSort"),
        import("../../../core/logging/ehLog"),
      ]);
    const described = describeAutoSortBlock(
      typeof pluginCount === "number" ? pluginCount : 0,
    );
    ehLog("warn", "install.blocked.auto-sort", { pluginCount });

    const result = await api.showDialog?.(
      "question",
      described.title,
      { text: described.body },
      [{ label: described.decline }, { label: described.confirm }],
    );
    if (result?.action !== described.confirm) {
      // Their Vortex, their call. The install proceeds and the order is still
      // pinned — it is simply liable to be re-sorted later, which is now a
      // choice they made rather than a surprise.
      ehLog("info", "install.auto-sort.declined", {});
      this.startInstall(api);
      return;
    }

    try {
      /**
       * A RAW dispatch: `SET_AUTOSORT_ENABLED` is registered by Vortex's
       * bundled `gamebryo-plugin-management` extension, not by core, so there
       * is no typed action creator to import — the same deliberate sidestep
       * `applyPluginOrder` and `applyUserlist` make. Its payload is the bare
       * boolean (`createAction('SET_AUTOSORT_ENABLED', e => e)`).
       */
      const store = api.store as unknown as {
        dispatch?: (action: { type: string; payload: unknown }) => void;
      };
      if (typeof store?.dispatch !== "function") {
        throw new Error("no redux store available");
      }
      store.dispatch({ type: ACTION_SET_AUTOSORT_ENABLED, payload: false });
      ehLog("info", "install.auto-sort-disabled", {});
    } catch (err) {
      // Non-fatal: the install is still worth doing, and the order is still
      // pinned. Saying so beats stopping over a setting.
      ehLog("warn", "install.auto-sort-disable-failed", {
        error: String(err),
      });
    }
    this.startInstall(api);
  }

  /**
   * Ask the running install to stop.
   *
   * Takes effect at the driver's next checkpoint, which is after the mod
   * currently being installed finishes — so this is a request, not an
   * interruption, and the UI says as much rather than implying the click
   * stops something mid-flight.
   *
   * Idempotent, and a no-op when nothing is running: a second click on a
   * signal that is already aborted changes nothing, and the driver reaches its
   * checkpoint when it reaches it.
   */
  cancelInstall(): void {
    const controller = this.installController;
    if (controller === undefined || controller.signal.aborted) return;
    controller.abort();
    // Aborting changes no wizard state, so nothing would re-render and the
    // click would look like it did nothing — for as long as the current mod
    // takes to finish, which is exactly when the user needs to see that it
    // registered. `isCancelPending` reads the controller rather than a copy
    // in state, so it also survives a remount.
    this.notify();
  }

  /** True while a stop has been requested but the driver has not yet stopped. */
  isCancelPending(): boolean {
    return this.installController?.signal.aborted ?? false;
  }

  // ── Phase: any → reset ───────────────────────────────────────────

  /**
   * Bounce back to the picker. Aborts any in-flight load (install
   * is intentionally non-abortable; if installing is in flight, the
   * caller should disable the reset button).
   */
  reset(): void {
    this.loadingController?.abort();
    this.loadingController = undefined;
    this.dispatch({ type: "reset" });
  }

  /**
   * After Vortex did its profile-switch dance: bring the wizard back
   * to picker so the user can install another collection. Same as
   * `reset` except semantically "I'm done" rather than "abandon".
   */
  finish(): void {
    this.dispatch({ type: "reset" });
  }

  // ── Internals ────────────────────────────────────────────────────

  private dispatch(action: WizardAction): void {
    const next = wizardReducer(this.state, action);
    if (next === this.state) return;
    if (action.type === "set-error") {
      this.errorSeq += 1;
    }
    this.state = next;
    this.notify();
  }

  /**
   * Wrap an unknown error into a {@link FormattedError} and route it
   * into the error state. Bumps `errorSeq` so the UI's "report once"
   * effect fires for this specific failure.
   */
  private failWith(
    err: unknown,
    opts: {
      title: string;
      context: Record<string, string | number | boolean | undefined | null>;
    },
  ): void {
    const formatted: FormattedError = formatError(err, opts);

    /**
     * ─── THE ERROR THE USER READS MUST BE IN THE LOG THEY SEND ─────────
     * This dispatched to UI state and stopped. So every failure the install
     * wizard has ever shown — the modal, the report the tester copies out by
     * hand — existed only on screen.
     *
     * Measured on a real report: a tester pasted "Install driver crashed /
     * Profile switch did not complete within 64s" AND attached the log from
     * the same session. That message appears in the log ZERO times. The one
     * error that mattered was the one thing missing from the file whose whole
     * purpose is to explain it, and answering him meant reading a screenshot.
     *
     * Logged before the dispatch, so a render that throws cannot lose it.
     */
    logFailure("error", "install.wizard.failed", {
      title: formatted.title,
      message: formatted.message,
      className: formatted.className,
      severity: formatted.severity,
      ...(formatted.context !== undefined ? { context: formatted.context } : {}),
      // The original, before any friendly rewriting — `truncate` keeps the
      // first frames of the stack, which is what names the failing call.
      err,
    });

    this.dispatch({ type: "set-error", error: formatted });
  }

  private notify(): void {
    // Mirror "is the wizard touching Vortex right now?" into the
    // runtime so the build page can warn about concurrent ops.
    // `loading` does archive hashing, `installing` mutates Vortex
    // state. Picker / preview / decisions / confirm / done / error
    // are all user-thinking states with no in-flight side effects.
    const busy =
      this.state.kind === "loading" || this.state.kind === "installing";
    getEHRuntime().setInstallBusy(busy);

    const snap = this.getSnapshot();
    for (const listener of this.listeners) {
      try {
        listener(snap);
      } catch {
        /* one bad subscriber must not poison the others */
      }
    }
  }
}

// Module-scope singleton. Survives component remounts; dies with the
// JS heap on Vortex restart (downloads / receipts on disk are the
// durable layer for that case).
let singleton: InstallSession | undefined;

export function getInstallSession(): InstallSession {
  if (singleton === undefined) singleton = new InstallSession();
  return singleton;
}

// ───────────────────────────────────────────────────────────────────────
// Helpers
// ───────────────────────────────────────────────────────────────────────

/**
 * True when an error came from an AbortController.abort() chain.
 * Mirrors the helper in `BuildSession`.
 */
export function isAbortError(err: unknown): boolean {
  /**
   * Broader than the shared predicate ON PURPOSE, and the only one of the
   * copies that was. Vortex rejects a cancelled operation with a plain Error
   * whose MESSAGE says "cancelled" and whose name does not — so a session
   * that used `isAbort` alone would report the user's own Stop as a failure.
   *
   * The shared half is delegated so the two cannot drift; the extra clause is
   * the difference this file is entitled to.
   */
  if (isAbort(err)) return true;
  if (err instanceof Error) {
    return (err.message ?? "").toLowerCase().includes("cancelled");
  }
  return false;
}
