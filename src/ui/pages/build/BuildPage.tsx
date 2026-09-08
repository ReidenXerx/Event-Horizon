/**
 * BuildPage — Phase 5.3 (session-driven, 5.5+).
 *
 * The curator-side React UI. Drives the full build pipeline:
 *   1. Idle:     friendly welcome card, "Begin" launches the load.
 *   2. Loading:  read state, hash mods, load (or create) collection config.
 *   3. Form:     metadata + per-mod overrides + README / CHANGELOG editors.
 *   4. Building: run the manifest + package pipeline with progress.
 *   5. Done:     success card with "Copy path" / "Show in folder" actions.
 *
 * Crucially the page DOES NOT own the pipeline state. All in-flight
 * work (loadBuildContext, runBuildPipeline, AbortControllers, draft
 * restore) lives in `buildSession.ts` — a module-scope singleton
 * that survives sidebar tab switches. This page is a thin renderer:
 *   • subscribes to the session on mount,
 *   • dispatches user actions to it,
 *   • re-renders whenever the session emits.
 *
 * That decoupling is what lets the build keep running in the
 * background when the user navigates to another tab (the bug
 * symptom: hashing/building "restarted" on every tab return).
 */

import * as React from "react";
import * as path from "path";

import {
  Button,
  Card,
  DiffSectionBlock,
  HashingCard,
  Pill,
  ProgressRing,
  StepDots,
  useToast,
} from "../../components";
import {
  describeCollectionDiff,
  isUnchanged,
} from "../../../core/curator/collectionDiff";
import { loadBuildDiff, type BuildDiffOutcome } from "./buildDiff";
import type { AuditorMod } from "../../../core/getModsListForProfile";
import { ErrorBoundary, useErrorReporter, useErrorReporterFormatted } from "../../errors";
import type { EventHorizonRoute } from "../../routes";
import { useApi } from "../../state";
import {
  validateCuratorInput,
  type BuildContext,
  type BuildPipelineResult,
  type BuildProgress,
  type CuratorInput,
} from "./engine";
import type {
  AvailabilityFinding,
  AvailabilitySummary,
} from "../../../core/build/nexusAvailability";
import type { PostProcessingCandidate } from "../../../core/manifest/runSelfChecks";
import { isNexusMod, recordPostProcessingDecision } from "./engine";
import {
  countKinds,
  describeUnexplainedFile,
} from "../../../core/manifest/unexplainedFiles";
import {
  describeChoice,
  describeDecisionIntro,
  overrideForChoice,
} from "./postProcessingDecision";
import type { PostProcessingChoice } from "./postProcessingDecision";
import type { ExternalModConfigEntry } from "../../../core/manifest/collectionConfig";
import { shipsAsExternal } from "../../../core/manifest/shipsAsExternal";
import { findRecoverableMods } from "../../../core/archiveRecovery";
import type {
  EhcollExternalDependency,
  GameVersionPolicy,
} from "../../../types/ehcoll";
import type { ExternalDependencyConfigEntry } from "../../../core/manifest/collectionConfig";
import type { VerificationLevel } from "../../../types/ehcoll";
import { getAppDataPath, saveDraft } from "../../../core/draftStorage";
import {
  type BuildDraftPayload,
  type BuildSession,
  type BuildSessionState,
} from "./buildSession";
import { getBuildSessionRegistry } from "./buildSessionRegistry";
import {
  splitWarning,
  sortWarningsBySeverity,
  warningTone,
} from "./warningText";
import { BuildDashboard } from "./BuildDashboard";
import { revealInFileManager } from "../../../core/revealPath";
import type { ExternalHint } from "../../../core/manifest/externalHints";
import {
  describeSourceKind,
  SOURCE_KINDS,
  sourceKindOf,
  sourcePatch,
  sourceProblem,
} from "./externalSource";
import type { ExternalSourceKind } from "./externalSource";
import {
  configWithOverrides,
  createOverridePersister,
} from "./persistOverrides";
import { ConcurrentOpBanner } from "../../runtime/ConcurrentOpBanner";
import { nativeNotify } from "../../runtime/nativeNotify";
import { getActiveGameId } from "../../../core/getModsListForProfile";
import { writeToClipboard } from "../../clipboard";

export interface BuildPageProps {
  onNavigate: (route: EventHorizonRoute) => void;
}

/**
 * Local alias for the form variant of the session state. Kept under
 * the old name so the inner panel components (FormPanel, banner) can
 * stay verbatim from the previous component-state implementation.
 */
type BuildFormState = Extract<BuildSessionState, { kind: "form" }>;

const DRAFT_AUTOSAVE_DEBOUNCE_MS = 600;

// ===========================================================================
// Page
// ===========================================================================

export function BuildPage(props: BuildPageProps): JSX.Element {
  const reportFormatted = useErrorReporterFormatted();
  // Top-level routing between dashboard and wizard. `undefined` ==
  // dashboard view (Track 1: parallel drafts). The dashboard creates
  // sessions in the registry on "+ New draft" / "Open" / "Update"
  // and hands the resulting draftId back here so the wizard can
  // subscribe to it.
  //
  // Kept in component state (not Redux/route segment) because the
  // dashboard ↔ wizard transition is purely a UI concern — the
  // sessions themselves persist across the transition because they
  // live in the module-scope registry.
  const [activeDraftId, setActiveDraftId] = React.useState<
    string | undefined
  >(undefined);

  return (
    <ErrorBoundary
      where="BuildPage"
      variant="page"
      onReport={reportFormatted}
    >
      {activeDraftId === undefined ? (
        <BuildDashboard
          onOpenDraft={(draftId): void => {
            setActiveDraftId(draftId);
          }}
        />
      ) : (
        <BuildWizard
          draftId={activeDraftId}
          onNavigate={props.onNavigate}
          onBackToDashboard={(): void => {
            setActiveDraftId(undefined);
          }}
        />
      )}
    </ErrorBoundary>
  );
}

interface BuildWizardProps extends BuildPageProps {
  draftId: string;
  onBackToDashboard: () => void;
}

function BuildWizard(props: BuildWizardProps): JSX.Element {
  const api = useApi();
  const reportError = useErrorReporter();
  const showToast = useToast();
  // Get-or-fail: the dashboard always creates the session before
  // routing here, so the `ensure` call below is effectively a get.
  // We seed the fallback `gameId` with whatever Vortex thinks is the
  // active game at recreate time — `ensure` ignores `gameId` for
  // existing sessions, which is what we always have at this point.
  // The fallback only fires after a hot reload nuked the registry
  // but `activeDraftId` state survived; in that case we want a
  // sensible game to pin the recreated session to (an empty string
  // would let `begin()` pick something arbitrary later, which races
  // with the user switching profiles between reload and click).
  const session: BuildSession = React.useMemo(() => {
    const registry = getBuildSessionRegistry();
    const existing = registry.get(props.draftId);
    if (existing !== undefined) return existing;
    const fallbackGameId = getActiveGameId(api.getState()) ?? "";
    return registry.ensure({
      draftId: props.draftId,
      gameId: fallbackGameId,
    });
    // We deliberately omit `api` from deps: the session is keyed by
    // draftId. Re-evaluating on every state tick would either
    // re-fetch the same instance (cheap, fine) or — if `api` changed
    // identity, which it shouldn't — risk a no-op `ensure`. Either
    // way the result is stable for this draftId.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.draftId]);

  // Mirror the session's state into local React state. The session
  // is the source of truth; this useState only exists to trigger
  // re-renders when the session emits.
  const [state, setLocalState] = React.useState<BuildSessionState>(() =>
    session.getState(),
  );
  React.useEffect(() => {
    // On (re)mount, immediately sync — the session may have moved on
    // while we were on another tab.
    setLocalState(session.getState());
    return session.subscribe(setLocalState);
  }, [session]);

  // Come back to where the curator was, rather than to a Begin button. Only
  // when a draft for this build already exists — a first-time user still gets
  // the intro card. Fires once per mount; the session ignores it unless idle.
  const resumedRef = React.useRef(false);
  React.useEffect(() => {
    if (resumedRef.current) return;
    resumedRef.current = true;
    session.resumeIfDraftExists(api);
  }, [session, api]);

  // ── Side-effect dispatch on session transitions ──────────────────
  // Toasts and error modals must fire once per real transition, NOT
  // on remount when the user lands back on the page mid-state. We
  // track the previous kind in a ref and only react when it changes.
  // Refs persist for the component instance lifetime; reportedErrorId
  // makes "did I already open the modal for this exact failure?"
  // dedup explicit (the session bumps errorId per failure).
  const prevKindRef = React.useRef<BuildSessionState["kind"] | undefined>(
    undefined,
  );
  const reportedErrorIdRef = React.useRef<number | undefined>(undefined);
  React.useEffect(() => {
    const prev = prevKindRef.current;
    prevKindRef.current = state.kind;

    // First subscription tick: just record kind, never spam toasts
    // for whatever state we walked into.
    if (prev === undefined) return;
    if (prev === state.kind) return;

    if (state.kind === "done" && prev === "building") {
      showToast({
        intent: "success",
        title: `Built ${state.curator.name} v${state.curator.version}`,
        message: `${state.result.modCount} mods, ${formatBytes(state.result.outputBytes)}.`,
      });
      nativeNotify({
        title: "Event Horizon · build complete",
        body: `${state.curator.name} v${state.curator.version} — ${state.result.modCount} mods, ${formatBytes(state.result.outputBytes)}`,
        tag: `eh-build-${state.curator.name}-${state.curator.version}`,
      });
      return;
    }
    if (state.kind === "form" && prev === "building") {
      // Only path from building → form is a user-initiated cancel.
      showToast({
        intent: "info",
        title: "Build cancelled",
        message: "No .ehcoll was written.",
      });
      return;
    }
    if (state.kind === "error") {
      // Each distinct failure gets one report — even if the user
      // remounts the page, the modal won't reopen for the same
      // errorId. Cleared once they retry/reset.
      if (reportedErrorIdRef.current === state.record.errorId) return;
      reportedErrorIdRef.current = state.record.errorId;
      reportError(state.record.error, {
        title:
          state.record.phase === "load"
            ? "Couldn't prepare build context"
            : "Build failed",
        context: { step: state.record.phase },
      });
      return;
    }
    if (state.kind === "idle" || state.kind === "loading") {
      // Cleared so a future error after a retry reports cleanly.
      reportedErrorIdRef.current = undefined;
    }
  }, [state, showToast, reportError]);

  // ── Autosave (debounced) ─────────────────────────────────────────
  // Stays in the component because autosave only matters while the
  // user is editing — which means they're on this page. Persists to
  // disk via `core/draftStorage`; restoration happens inside the
  // session on the loading → form transition.
  //
  // Track 1: the autosave key is the session's `draftId` (a UUIDv4),
  // not `ctx.gameId`. That's what unlocks "many drafts per game" —
  // each draft gets its own file, no clobbering.
  //
  // We also persist linkage metadata (`linkedSlug`/`linkedPackageId`)
  // here because the dashboard's "Update from published" pre-stages
  // a partial draft on disk, but a subsequent autosave would
  // overwrite it without these fields if we didn't carry them
  // through. They're read off the saved disk envelope at the start
  // of the form session (see auto-begin effect below) and then
  // written back on every autosave.
  const linkedFieldsRef = React.useRef<{
    linkedSlug?: string;
    linkedPackageId?: string;
  }>({});

  // `title` lives in component state (not session form state)
  // because it's a dashboard-only label — never sent to the
  // manifest, never validated, just displayed on the DraftCard so
  // a curator with five drafts can tell them apart at a glance.
  // Initialised from any restored on-disk envelope below.
  const [draftTitle, setDraftTitle] = React.useState<string>("");

  React.useEffect(() => {
    if (state.kind !== "form") return undefined;
    const formState = state;
    const handle = setTimeout(() => {
      const payload: BuildDraftPayload = {
        draftId: session.draftId,
        gameId: session.gameId,
        title: draftTitle.length > 0 ? draftTitle : undefined,
        linkedSlug: linkedFieldsRef.current.linkedSlug,
        linkedPackageId: linkedFieldsRef.current.linkedPackageId,
        curator: formState.curator,
        overrides: formState.overrides,
        readme: formState.readme,
        changelog: formState.changelog,
        verificationLevel: formState.verificationLevel,
        reverifyEverything: formState.reverifyEverything,
      };
      void saveDraft(getAppDataPath(), "build", session.draftId, payload);
    }, DRAFT_AUTOSAVE_DEBOUNCE_MS);
    return () => {
      clearTimeout(handle);
    };
  }, [
    session,
    state.kind,
    draftTitle,
    state.kind === "form" ? state.curator : undefined,
    state.kind === "form" ? state.overrides : undefined,
    state.kind === "form" ? state.readme : undefined,
    state.kind === "form" ? state.changelog : undefined,
    state.kind === "form" ? state.verificationLevel : undefined,
    // `reverifyEverything` was written INTO the payload above but never listed
    // here, so ticking "Re-read every file" on its own scheduled no autosave
    // and the choice was lost until the next keystroke somewhere else.
    state.kind === "form" ? state.reverifyEverything : undefined,
  ]);

  // ── Restore link-metadata from disk ──────────────────────────────
  // Pre-load `linkedSlug`/`linkedPackageId`/`title` from any on-disk
  // draft into the ref + title state so the autosave keeps them
  // stable across edits (the session's `form` state doesn't carry
  // them — they're dashboard-side affordances).
  //
  // Predictable-UX choice: we deliberately DO NOT call
  // `session.begin(api)` here. Even though the hashing pass would be
  // a "guessable next step" after Open / + New draft / Update, the
  // legacy auto-begin had two real downsides:
  //   • Surprise CPU. Tab-switching into the build page kicked off
  //     a heavy read pass without the user touching anything.
  //   • Race with the registry's defensive recreate path —
  //     `session.gameId === ""` when the registry was nuked by a
  //     hot reload, and `begin()` would silently re-bind to whatever
  //     game is active *right now*, not what the draft was created
  //     for.
  // Curators land on `IdlePanel`, read what's about to happen, and
  // press "Begin" explicitly. One extra click, zero surprise CPU.
  React.useEffect(() => {
    let alive = true;
    void (async (): Promise<void> => {
      try {
        const { loadDraft } = await import("../../../core/draftStorage");
        const env = await loadDraft<BuildDraftPayload>(
          getAppDataPath(),
          "build",
          session.draftId,
        );
        if (!alive) return;
        if (env !== undefined) {
          linkedFieldsRef.current = {
            linkedSlug: env.payload.linkedSlug,
            linkedPackageId: env.payload.linkedPackageId,
          };
          if (typeof env.payload.title === "string") {
            setDraftTitle(env.payload.title);
          }
        }
      } catch {
        /* swallow — best-effort */
      }
    })();
    return (): void => {
      alive = false;
    };
    // Run once per mounted draftId, not per state tick. Note we no
    // longer key on `state.kind === "idle"`: link metadata might be
    // missing from the ref if the user navigated away mid-form and
    // came back, in which case we still want to re-hydrate.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session]);

  // ── Step indicator ───────────────────────────────────────────────
  // `queued` shares a step bucket with `building` because from the
  // user's mental model "I clicked Build, now I'm waiting" is one
  // phase. The QueuedPanel itself spells out the distinction.
  const stepIndex =
    state.kind === "idle"
      ? 0
      : state.kind === "loading"
      ? 1
      : state.kind === "form"
      ? 2
      : state.kind === "building" || state.kind === "queued"
      ? 3
      : 4;
  const stepLabels = ["Idle", "Loading", "Form", "Building", "Done"];

  // ── Render ────────────────────────────────────────────────────────
  // Tiny "← Drafts" affordance so the curator can always bail back
  // to the dashboard without resetting their session. Sessions live
  // in the registry; remounting the wizard for the same draftId
  // resumes exactly where they left off.
  const backToDashboard = (
    <div style={{ marginBottom: "var(--eh-sp-3)" }}>
      <Button intent="ghost" onClick={props.onBackToDashboard}>
        ← Drafts
      </Button>
    </div>
  );

  if (state.kind === "idle") {
    return (
      <div className="eh-page">
        {backToDashboard}
        <Header stepIndex={stepIndex} stepLabel="Idle" />
        <ConcurrentOpBanner self="build" />
        <IdlePanel
          onBegin={(): void => session.begin(api)}
          onCancel={props.onBackToDashboard}
        />
      </div>
    );
  }
  if (state.kind === "loading") {
    return (
      <div className="eh-page">
        {backToDashboard}
        <Header stepIndex={stepIndex} stepLabel={stepLabels[stepIndex]} />
        <LoadingPanel
          progress={state.phase}
          onCancel={(): void => session.cancelLoading()}
        />
      </div>
    );
  }
  if (state.kind === "recovering") {
    const pct =
      state.total === 0 ? 0 : Math.round((state.done / state.total) * 100);
    return (
      <div className="eh-page">
        {backToDashboard}
        <Header stepIndex={stepIndex} stepLabel={stepLabels[stepIndex]} />
        <Card title="Re-downloading source archives">
          <p style={{ marginTop: 0, color: "var(--eh-text-secondary)" }}>
            Fetching the archives Vortex no longer has, so these mods can be
            identified. Only the archive is downloaded — your installed mods are
            not touched and nothing is re-installed.
          </p>
          <p style={{ fontVariantNumeric: "tabular-nums" }}>
            <strong>
              {state.done} / {state.total}
            </strong>{" "}
            ({pct}%)
            {state.currentMod !== undefined ? ` — ${state.currentMod}` : ""}
          </p>
          <div
            aria-hidden="true"
            style={{
              height: 6,
              borderRadius: 3,
              background: "var(--eh-bg-elevated)",
              overflow: "hidden",
              margin: "var(--eh-sp-3) 0",
            }}
          >
            <div
              style={{
                width: `${pct}%`,
                height: "100%",
                background: "var(--eh-accent, var(--eh-text-secondary))",
                transition: "width 200ms linear",
              }}
            />
          </div>
          <Button
            intent="ghost"
            onClick={(): void => session.cancelRecovering()}
          >
            Stop after this one
          </Button>
          <p
            style={{
              marginBottom: 0,
              fontSize: "var(--eh-text-sm)",
              color: "var(--eh-text-secondary)",
            }}
          >
            Vortex offers no way to abort a download already in progress, so
            stopping takes effect once the current file finishes. Everything
            recovered so far is kept.
          </p>
        </Card>
      </div>
    );
  }
  if (state.kind === "error") {
    return (
      <div className="eh-page">
        {backToDashboard}
        <Header stepIndex={stepIndex} stepLabel="Error" />
        <ErrorPanel
          onRetry={(): void => {
            session.reset();
            session.begin(api);
          }}
        />
      </div>
    );
  }
  if (state.kind === "queued") {
    return (
      <div className="eh-page">
        {backToDashboard}
        <Header stepIndex={stepIndex} stepLabel="Queued" />
        <QueuedPanel
          curator={state.curator}
          queuePosition={state.queuePosition}
          onCancel={(): void => session.cancelBuilding()}
        />
      </div>
    );
  }
  if (state.kind === "building") {
    return (
      <div className="eh-page">
        {backToDashboard}
        <Header stepIndex={stepIndex} stepLabel={stepLabels[stepIndex]} />
        <BuildingPanel
          progress={state.progress}
          curator={state.curator}
          onCancel={(): void => session.cancelBuilding()}
        />
      </div>
    );
  }
  if (state.kind === "awaiting-decisions") {
    return (
      <div className="eh-page">
        {backToDashboard}
        <Header stepIndex={stepIndex} stepLabel="Decisions" />
        <DecisionsGate
          state={state}
          onDecide={async (candidate, choice): Promise<void> => {
            const mod = state.ctx.mods.find((m) => m.id === candidate.modId);
            await recordPostProcessingDecision({
              collectionName: state.curator.name,
              modId: candidate.modId,
              patch: overrideForChoice(choice, {
                isNexusMod: mod !== undefined && isNexusMod(mod),
                ...(candidate.fingerprint !== undefined
                  ? { fingerprint: candidate.fingerprint }
                  : {}),
              }),
            });
          }}
          onContinue={(): void => session.continueAfterDecisions()}
          onCancel={(): void => session.cancelBuilding()}
        />
      </div>
    );
  }
  if (state.kind === "done") {
    return (
      <div className="eh-page">
        {backToDashboard}
        <Header stepIndex={stepIndex} stepLabel={stepLabels[stepIndex]} />
        <DonePanel
          result={state.result}
          onDecidePostProcessing={async (candidate, choice): Promise<void> => {
            // The mod's own record decides whether bundling also needs
            // `treatAsExternal` — a Nexus mod is not external until that says
            // so, and `bundled` alone would be a decision the build ignores.
            const mod = state.ctx.mods.find((m) => m.id === candidate.modId);
            await recordPostProcessingDecision({
              collectionName: state.curator.name,
              modId: candidate.modId,
              patch: overrideForChoice(choice, {
                isNexusMod: mod !== undefined && isNexusMod(mod),
                // What this answer is ABOUT. Without it the answer would
                // apply for ever, including to files added afterwards.
                ...(candidate.fingerprint !== undefined
                  ? { fingerprint: candidate.fingerprint }
                  : {}),
              }),
            });
          }}
          onBuildAnother={(): void => {
            // Successful build — drop the session from the registry
            // and bounce back to the dashboard. Curators almost
            // always start a *different* collection next, not an
            // identical rebuild of the same one.
            session.reset();
            getBuildSessionRegistry().remove(session.draftId);
            props.onBackToDashboard();
          }}
          onGoHome={(): void => {
            session.reset();
            getBuildSessionRegistry().remove(session.draftId);
            props.onNavigate("home");
          }}
        />
      </div>
    );
  }

  const formState = state;
  const handleChange = (next: Partial<BuildFormState>): void => {
    session.patchForm(next);
  };

  const handleDiscardDraft = (): void => {
    void session.discardDraft();
    showToast({
      intent: "info",
      title: "Draft discarded",
      message: "Form reset to your saved collection defaults.",
    });
  };

  const handleDismissDraftBanner = (): void => {
    session.dismissDraftBanner();
  };

  const onBuild = (): void => {
    if (formState.ctx.mods.length === 0) {
      session.setValidationError(
        "Your active profile has no mods. Enable at least one mod in Vortex before building a collection.",
      );
      return;
    }
    const validationError = validateCuratorInput(formState.curator);
    if (validationError !== undefined) {
      session.setValidationError(validationError);
      return;
    }
    session.build(api, {
      ctx: formState.ctx,
      curator: formState.curator,
      overrides: formState.overrides,
      readme: formState.readme,
      changelog: formState.changelog,
      verificationLevel: formState.verificationLevel,
      reverifyEverything: formState.reverifyEverything,
    });
  };

  // Game-mismatch banner: this draft was created for `session.gameId`,
  // but Vortex is currently active on a different game. Building
  // would still produce a manifest tied to `session.gameId` (the
  // form's `ctx.gameId` was pinned at load time), but any "begin
  // again" / "retry" path would re-read Vortex's active game and
  // silently switch — so warn the curator before that happens.
  const activeGameId = getActiveGameId(api.getState());
  const gameMismatch =
    typeof activeGameId === "string" &&
    activeGameId.length > 0 &&
    session.gameId.length > 0 &&
    activeGameId !== session.gameId;

  return (
    <div className="eh-page">
      {backToDashboard}
      <Header stepIndex={stepIndex} stepLabel={stepLabels[stepIndex]} />
      <ConcurrentOpBanner self="build" />
      {gameMismatch && (
        <GameMismatchBanner
          draftGameId={session.gameId}
          activeGameId={activeGameId as string}
        />
      )}
      <FormPanel
        state={formState}
        title={draftTitle}
        onTitleChange={setDraftTitle}
        onChange={handleChange}
        onBuild={onBuild}
        onRefresh={(): void => session.refreshContext(api)}
        refreshing={formState.refreshing === true}
        {...(formState.refreshedAt !== undefined
          ? { refreshedAt: formState.refreshedAt }
          : {})}
        onDiscardDraft={handleDiscardDraft}
        onDismissDraftBanner={handleDismissDraftBanner}
        recoverableCount={
          findRecoverableMods(formState.ctx.mods, {
            // Same predicate the session uses, from the same live overrides,
            // so the button's count and what it would actually do agree.
            shipsAsExternal: (m) =>
              shipsAsExternal(isNexusMod(m), formState.overrides[m.id]),
          }).recoverable.length
        }
        onRecoverArchives={(): void => session.recoverArchives(api)}
        onCheckAvailability={(): void => session.checkNexusAvailability(api)}
        {...(state.availabilityProgress !== undefined
          ? { availabilityProgress: state.availabilityProgress }
          : {})}
        {...(state.availability !== undefined
          ? { availability: state.availability }
          : {})}
      />
    </div>
  );
}

/**
 * Sticky orange notice at the top of the form when Vortex's active
 * game has drifted away from the game this draft was created for.
 * Doesn't disable Build (the form context is already pinned to the
 * draft's game and a build will still produce a coherent manifest)
 * — it just prevents the curator being surprised when their build
 * doesn't match what they currently see in Vortex's mod list.
 */
function GameMismatchBanner(props: {
  draftGameId: string;
  activeGameId: string;
}): JSX.Element {
  return (
    <div
      role="alert"
      style={{
        marginBottom: "var(--eh-sp-3)",
        padding: "var(--eh-sp-3) var(--eh-sp-4)",
        background: "rgba(255, 198, 99, 0.08)",
        border: "1px solid var(--eh-warning)",
        borderRadius: "var(--eh-radius-md)",
        color: "var(--eh-text-primary)",
        fontSize: "var(--eh-text-sm)",
        display: "flex",
        gap: "var(--eh-sp-2)",
        alignItems: "flex-start",
      }}
    >
      <span aria-hidden="true">⚠</span>
      <div>
        <strong>Active game switched.</strong>{" "}
        This draft was loaded for <code>{props.draftGameId}</code>, but
        Vortex is now active on <code>{props.activeGameId}</code>. The
        form data still reflects the original game and will build
        correctly. Switch Vortex back to{" "}
        <code>{props.draftGameId}</code> if you need to inspect
        live mod state, or open this draft from the dashboard after
        switching profiles.
      </div>
    </div>
  );
}

// ===========================================================================
// Queued
// ===========================================================================

/**
 * Card shown when this draft's build is parked behind another draft's
 * build. The registry's queue promotes us automatically; we just
 * render a friendly "you're #N in line" + a cancel that bails us out
 * without touching whoever currently owns the slot.
 */
function QueuedPanel(props: {
  curator: CuratorInput;
  queuePosition: number;
  onCancel: () => void;
}): JSX.Element {
  return (
    <Card title={`Queued: ${props.curator.name} v${props.curator.version}`}>
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: "var(--eh-sp-3)",
          padding: "var(--eh-sp-2)",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: "var(--eh-sp-3)",
          }}
        >
          <ProgressRing size={48} />
          <div>
            <div
              style={{
                color: "var(--eh-text-primary)",
                fontSize: "var(--eh-text-md)",
              }}
            >
              Waiting for the current build to finish.
            </div>
            <div
              style={{
                color: "var(--eh-text-secondary)",
                fontSize: "var(--eh-text-sm)",
                marginTop: "var(--eh-sp-1)",
              }}
            >
              Position {props.queuePosition} in queue. We'll start automatically
              when it's your turn — switching tabs is fine.
            </div>
          </div>
        </div>
        <div style={{ display: "flex", justifyContent: "flex-end" }}>
          <Button intent="ghost" onClick={props.onCancel}>
            Cancel build
          </Button>
        </div>
      </div>
    </Card>
  );
}

// ===========================================================================
// Idle
// ===========================================================================


/**
 * "Ship as external" — offered on every mod a user could not download.
 *
 * Deliberately the SAME mechanism external mods already use rather than a
 * bespoke one. Marking a mod here moves it into the external-mods table, where
 * bundling, a link and instructions already exist and have already been
 * thought about. It is also the shape that keeps the redistribution decision
 * where it belongs: the curator ticks one specific mod, knowingly, instead of
 * a tool deciding to ship files on their behalf.
 */
function TreatAsExternalAction(props: {
  finding: AvailabilityFinding;
  onTreat?: (modId: number, fileId: number) => void;
  marked: boolean;
}): JSX.Element | null {
  if (props.onTreat === undefined) return null;
  if (props.marked) {
    return (
      <span style={{ color: "var(--eh-success)" }}>
        {" "}
        — ships as an external mod
      </span>
    );
  }
  return (
    <button
      type="button"
      onClick={() => props.onTreat?.(props.finding.modId, props.finding.fileId)}
      style={{
        marginLeft: "var(--eh-sp-2)",
        background: "none",
        border: "none",
        padding: 0,
        cursor: "pointer",
        color: "var(--eh-cyan)",
        font: "inherit",
        textDecoration: "underline",
      }}
    >
      ship as external
    </button>
  );
}

/**
 * Whether the people installing this collection can still get the mods.
 *
 * The curator is the one person who cannot notice this problem unaided: every
 * mod is already on their disk, so a collection referencing a file Nexus
 * deleted builds, packs and ships perfectly, and fails only on someone else's
 * machine — hundreds of mods into an install, with the curator not in the
 * room. Two such mods sat in a real collection for days doing exactly that.
 *
 * Deliberately a button rather than part of every build. It is one lookup per
 * unique mod (780 of them for a 955-mod collection), which is a real slice of
 * a daily Nexus API budget.
 */
export function AvailabilityPanel(props: {
  onCheck: () => void;
  progress?: { done: number; total: number };
  result?: {
    summary: AvailabilitySummary;
    findings: readonly AvailabilityFinding[];
    checkedAt: string;
  };
  /**
   * Ship this mod as an external dependency instead of a Nexus download.
   *
   * The only honest option left for a mod whose Nexus file is gone: its
   * `nexus:modId:fileId` identity is a promise the user cannot keep. As an
   * external it is identified by hash instead, and picks up everything the
   * external-mods table already offers — bundle it, link somewhere else, or
   * write instructions. That table exists and has been reviewed; a second
   * mechanism just for dead mods would not have been.
   */
  onTreatAsExternal?: (modId: number, fileId: number) => void;
  /** `modId:fileId` of mods already marked, so the button can say so. */
  externalModIds?: ReadonlySet<string>;
}): JSX.Element {
  const running = props.progress !== undefined;
  const result = props.result;
  // Only the two statuses a user would actually fail on. `old-version` is
  // fragile but downloadable, and `unknown` is not a finding at all.
  const blocked = (result?.findings ?? []).filter(
    (f) => f.status === "file-missing" || f.status === "mod-missing",
  );
  // Listed too, quietly. Saying "21 files are old versions" and not saying
  // WHICH is the same failure as reporting a missing file with no replacement:
  // a problem stated with nothing to act on. These are the ones to update
  // BEFORE an author deletes them, and that is only possible by name.
  const fragile = (result?.findings ?? []).filter(
    (f) => f.status === "old-version",
  );
  // Listed too, and deliberately NOT as a problem. "Could not check" is not
  // "broken" — but a mod nobody checked is also a mod nobody confirmed, and
  // the whole point of running this before publishing is to have no such gap
  // left. Naming them is what makes a second run targeted instead of blind.
  const unchecked = (result?.findings ?? []).filter(
    (f) => f.status === "unknown",
  );

  return (
    <Card title="Can your users still download these mods?">
      <p
        style={{
          margin: 0,
          fontSize: "var(--eh-text-sm)",
          color: "var(--eh-text-secondary)",
          lineHeight: "var(--eh-leading-relaxed)",
        }}
      >
        You already have every mod on disk, so one that Nexus has since
        deleted packs and ships perfectly — and then fails for everyone else.
        This asks Nexus about each mod, one request per mod page.
      </p>

      <div style={{ marginTop: "var(--eh-sp-3)" }}>
        <Button intent="ghost" size="sm" disabled={running} onClick={props.onCheck}>
          {running
            ? `Checking ${props.progress!.done}/${props.progress!.total || "…"}`
            : result === undefined
              ? "Check Nexus availability"
              : "Check again"}
        </Button>
      </div>

      {result !== undefined && (
        <div style={{ marginTop: "var(--eh-sp-3)" }}>
          {result.summary.lines.map((line, i) => (
            <p
              key={i}
              style={{
                margin: "0 0 var(--eh-sp-2) 0",
                fontSize: "var(--eh-text-sm)",
                lineHeight: "var(--eh-leading-relaxed)",
                color:
                  i === 0 && !result.summary.clean
                    ? "var(--eh-text-primary)"
                    : "var(--eh-text-secondary)",
              }}
            >
              {line}
            </p>
          ))}

          {blocked.length > 0 && (
            <ul
              style={{
                margin: "var(--eh-sp-2) 0 0 0",
                paddingLeft: "var(--eh-sp-4)",
                display: "flex",
                flexDirection: "column",
                gap: 2,
                fontSize: "var(--eh-text-xs)",
                fontFamily: "var(--eh-font-mono)",
                color: "var(--eh-text-muted)",
                maxHeight: 220,
                overflowY: "auto",
              }}
            >
              {blocked.map((f) => (
                <li key={f.compareKey}>
                  {/* Which of the two, per mod: "old version tidied up" and
                      "page taken down" read identically as a download
                      failure and mean opposite things. */}
                  <span
                    style={{
                      color:
                        f.status === "mod-missing"
                          ? "var(--eh-danger)"
                          : "var(--eh-warning)",
                    }}
                  >
                    {f.status === "mod-missing" ? "page gone" : "file gone"}
                  </span>{" "}
                  {f.name} — mod {f.modId}, file {f.fileId}
                  {f.replacement !== undefined && (
                    <span style={{ color: "var(--eh-text-secondary)" }}>
                      {" "}
                      → current main file {f.replacement.fileId}
                      {f.replacement.version != null
                        ? ` (v${f.replacement.version})`
                        : ""}
                    </span>
                  )}
                  <TreatAsExternalAction
                    finding={f}
                    {...(props.onTreatAsExternal !== undefined
                      ? { onTreat: props.onTreatAsExternal }
                      : {})}
                    marked={
                      props.externalModIds?.has(`${f.modId}:${f.fileId}`) === true
                    }
                  />
                </li>
              ))}
            </ul>
          )}

          {unchecked.length > 0 && (
            <details style={{ marginTop: "var(--eh-sp-3)" }}>
              <summary
                style={{
                  cursor: "pointer",
                  color: "var(--eh-text-muted)",
                  fontSize: "var(--eh-text-xs)",
                  letterSpacing: "var(--eh-tracking-wide)",
                  textTransform: "uppercase",
                  fontWeight: 600,
                }}
              >
                Show the {unchecked.length} Nexus could not answer for
              </summary>
              <ul
                style={{
                  margin: "var(--eh-sp-2) 0 0 0",
                  paddingLeft: "var(--eh-sp-4)",
                  display: "flex",
                  flexDirection: "column",
                  gap: 2,
                  fontSize: "var(--eh-text-xs)",
                  fontFamily: "var(--eh-font-mono)",
                  color: "var(--eh-text-muted)",
                  maxHeight: 220,
                  overflowY: "auto",
                }}
              >
                {unchecked.map((f) => (
                  <li key={f.compareKey}>
                    {f.name} — mod {f.modId}, file {f.fileId}
                  </li>
                ))}
              </ul>
            </details>
          )}

          {fragile.length > 0 && (
            <details style={{ marginTop: "var(--eh-sp-3)" }}>
              <summary
                style={{
                  cursor: "pointer",
                  color: "var(--eh-text-muted)",
                  fontSize: "var(--eh-text-xs)",
                  letterSpacing: "var(--eh-tracking-wide)",
                  textTransform: "uppercase",
                  fontWeight: 600,
                }}
              >
                Show the {fragile.length} old or archived file
                {fragile.length === 1 ? "" : "s"}
              </summary>
              <ul
                style={{
                  margin: "var(--eh-sp-2) 0 0 0",
                  paddingLeft: "var(--eh-sp-4)",
                  display: "flex",
                  flexDirection: "column",
                  gap: 2,
                  fontSize: "var(--eh-text-xs)",
                  fontFamily: "var(--eh-font-mono)",
                  color: "var(--eh-text-muted)",
                  maxHeight: 220,
                  overflowY: "auto",
                }}
              >
                {fragile.map((f) => (
                  <li key={f.compareKey}>
                    {f.name} — mod {f.modId}, file {f.fileId}
                  </li>
                ))}
              </ul>
            </details>
          )}
        </div>
      )}
    </Card>
  );
}

/**
 * First-impression panel for the build flow. We deliberately don't
 * auto-start the (slow) hashing pass on tab open — it's surprising
 * for the user, costs CPU, and on cancel had no good "back" button.
 *
 * Instead this card explains what's about to happen and waits for an
 * explicit click. Once the work is in flight the session keeps it
 * running across tab switches.
 */
function IdlePanel(props: {
  onBegin: () => void;
  onCancel: () => void;
}): JSX.Element {
  return (
    <Card title="Build a collection">
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: "var(--eh-sp-3)",
          padding: "var(--eh-sp-2)",
        }}
      >
        <p
          style={{
            margin: 0,
            color: "var(--eh-text-secondary)",
            fontSize: "var(--eh-text-md)",
            lineHeight: "var(--eh-leading-normal)",
          }}
        >
          Event Horizon will read your active profile, hash every mod
          archive (so the manifest pins exact files), and then open
          the curator form so you can polish the metadata, README,
          and CHANGELOG before packaging the .ehcoll.
        </p>
        <ul
          className="eh-list"
        >
          <li>
            Hashing is read-only and safe to cancel. Big profiles can
            take a few minutes the first time, near-instant on retries.
          </li>
          <li>
            Your draft autosaves while you edit. Switch to another tab
            or restart Vortex — your form will be there when you come back.
          </li>
          <li>
            The build keeps running if you navigate away while it's
            in flight; come back to this tab to see progress.
          </li>
        </ul>
        <div
          style={{
            display: "flex",
            justifyContent: "flex-end",
            gap: "var(--eh-sp-2)",
            marginTop: "var(--eh-sp-2)",
            flexWrap: "wrap",
          }}
        >
          <Button intent="ghost" onClick={props.onCancel}>
            Cancel
          </Button>
          <Button intent="primary" size="lg" onClick={props.onBegin}>
            Begin
          </Button>
        </div>
      </div>
    </Card>
  );
}

// ===========================================================================
// Header
// ===========================================================================

function Header(props: { stepIndex: number; stepLabel: string }): JSX.Element {
  return (
    <header
      style={{
        display: "flex",
        alignItems: "flex-end",
        justifyContent: "space-between",
        gap: "var(--eh-sp-3)",
        marginBottom: "var(--eh-sp-5)",
        flexWrap: "wrap",
      }}
    >
      <div>
        <h2
          style={{
            margin: 0,
            fontSize: "var(--eh-text-2xl)",
            color: "var(--eh-text-primary)",
            letterSpacing: "var(--eh-tracking-tight)",
          }}
        >
          Build a collection
        </h2>
        <p
          style={{
            margin: "var(--eh-sp-2) 0 0 0",
            color: "var(--eh-text-secondary)",
            fontSize: "var(--eh-text-md)",
          }}
        >
          Capture your active profile as an Event Horizon .ehcoll package.
        </p>
      </div>
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "flex-end",
          gap: "var(--eh-sp-2)",
        }}
      >
        <StepDots total={5} current={props.stepIndex} />
        <span
          className="eh-label"
        >
          Step {props.stepIndex + 1} / 5 · {props.stepLabel}
        </span>
      </div>
    </header>
  );
}

// ===========================================================================
// Loading
// ===========================================================================

function LoadingPanel(props: {
  progress?: BuildProgress;
  onCancel?: () => void;
}): JSX.Element {
  const phaseLabel = phaseToLabel(props.progress?.phase);
  const isHashing = props.progress?.phase === "hashing-mods";
  const total = props.progress?.total ?? 0;

  // Specialised card for the long, slow hashing pass: live counter,
  // current item, scanner shimmer, and a cancel button.
  if (isHashing && total > 0) {
    return (
      <HashingCard
        title="Hashing mod archives"
        subtitle="Computing SHA-256 of every mod archive — this is read-only and safe to cancel at any time."
        done={props.progress?.done ?? 0}
        total={total}
        currentItem={props.progress?.currentItem}
        onCancel={props.onCancel}
      />
    );
  }

  return (
    <Card>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "var(--eh-sp-4)",
          padding: "var(--eh-sp-3)",
        }}
      >
        <ProgressRing size={64} />
        <div className="eh-fill">
          <h3 style={{ margin: 0, color: "var(--eh-text-primary)" }}>
            Preparing build context
          </h3>
          <p
            style={{
              margin: "var(--eh-sp-1) 0 0 0",
              color: "var(--eh-text-secondary)",
              fontSize: "var(--eh-text-sm)",
            }}
          >
            {props.progress?.message ?? phaseLabel ?? "Reading active profile..."}
          </p>
        </div>
        {props.onCancel !== undefined && (
          <Button intent="ghost" size="sm" onClick={props.onCancel}>
            Cancel
          </Button>
        )}
      </div>
    </Card>
  );
}

// ===========================================================================
// Form
// ===========================================================================

interface FormPanelProps {
  state: BuildFormState;
  /**
   * Optional dashboard-only label so curators with multiple drafts
   * in flight can tell them apart at a glance ("Skyrim — main", "Skyrim
   * — testing"). Independent from `curator.name` (which becomes the
   * package name and goes into the manifest); the title is purely a
   * draft-side affordance and never ships in the .ehcoll.
   */
  title: string;
  onTitleChange: (next: string) => void;
  onChange: (next: Partial<BuildFormState>) => void;
  onBuild: () => void;
  /**
   * Re-read Vortex and the game folder without losing what has been typed.
   *
   * Acting on this form usually means LEAVING it — it says a prerequisite is
   * missing, you go and install it, you come back. Without this the form is
   * still showing the scan from before you fixed the thing it asked for.
   */
  onRefresh: () => void;
  refreshing: boolean;
  refreshedAt?: string;
  onDiscardDraft: () => void;
  onDismissDraftBanner: () => void;
  /** How many mods could have their archive fetched back from Nexus. */
  recoverableCount: number;
  onRecoverArchives: () => void;
  /** Ask Nexus whether users can still download every mod. */
  onCheckAvailability: () => void;
  availabilityProgress?: { done: number; total: number };
  availability?: {
    summary: AvailabilitySummary;
    findings: readonly AvailabilityFinding[];
    checkedAt: string;
  };
}

/**
 * One warning: a headline you can scan, with the explanation folded away.
 *
 * The warnings are prose on purpose — a curator meeting "9 external mods no
 * longer match" needs what happened, why it matters and what to do. Ten of
 * those as ten paragraphs is a wall, and a wall gets skimmed, which loses the
 * one that mattered.
 */
function WarningRow(props: { text: string }): JSX.Element {
  const { headline, detail } = splitWarning(props.text);
  const tone = warningTone(props.text);
  const dot =
    tone === "blocking"
      ? "var(--eh-danger)"
      : tone === "attention"
      ? "var(--eh-warning)"
      : "var(--eh-text-muted)";

  if (detail.length === 0) {
    return (
      <div className="eh-row eh-row--sm">
        <Dot color={dot} />
        <span className="eh-fill eh-secondary">{headline}</span>
      </div>
    );
  }

  return (
    <details>
      <summary style={{ cursor: "pointer", listStyle: "none" }}>
        <span className="eh-row eh-row--sm" style={{ display: "inline-flex" }}>
          <Dot color={dot} />
          <span className="eh-secondary">{headline}</span>
        </span>
      </summary>
      <div
        className="eh-note"
        style={{
          whiteSpace: "pre-line",
          margin: "var(--eh-sp-1) 0 0 var(--eh-sp-4)",
        }}
      >
        {detail}
      </div>
    </details>
  );
}

/** Severity as a shape, not a word — the list stays scannable. */
function Dot(props: { color: string }): JSX.Element {
  return (
    <span
      aria-hidden
      style={{
        width: 6,
        height: 6,
        borderRadius: "50%",
        background: props.color,
        flexShrink: 0,
      }}
    />
  );
}


/**
 * ──────────────────────────────────────────────────────────────────────
 * "What would this build change?" — answered where the decision is made.
 *
 * The diff existed already, on an expanded published card on the dashboard.
 * A curator filling in this form is two screens from it and has exactly this
 * question, so it is here as well.
 *
 * Loaded in the background: reading the baseline means opening one entry of
 * one `.ehcoll`, and the form must stay usable while that happens. Every
 * failure resolves to something the card SAYS — a first build, or a package
 * it could not read — because rendering silence would read as "nothing
 * changed", which is a claim about a file nobody managed to open.
 * ──────────────────────────────────────────────────────────────────────
 */
function BuildDiffCard(props: {
  collectionName: string;
  current: readonly AuditorMod[];
}): JSX.Element | null {
  const [outcome, setOutcome] = React.useState<BuildDiffOutcome | undefined>();
  const { collectionName, current } = props;

  React.useEffect(() => {
    let alive = true;
    setOutcome(undefined);
    void (async (): Promise<void> => {
      try {
        const [{ findBuiltPackages }, { readEhcoll }, { getCollectionsDir }] =
          await Promise.all([
            import("./publishedDetails"),
            import("../../../core/manifest/readEhcoll"),
            import("../../../core/paths"),
          ]);
        const outputDir = getCollectionsDir();

        // Every collection sharing this folder, read off its config file
        // names — `findBuiltPackages` needs them or a name that is a prefix
        // of another ("Ivy" against "Ivy 2") claims the wrong package.
        let knownSlugs: string[] = [];
        try {
          const fsp = await import("fs/promises");
          const entries = await fsp.readdir(path.join(outputDir, ".config"));
          knownSlugs = entries
            .filter((f) => f.endsWith(".json"))
            .map((f) => f.slice(0, -".json".length));
        } catch {
          /* no config folder yet; the slug alone will have to do */
        }

        const result = await loadBuildDiff({
          collectionName,
          outputDir,
          knownSlugs,
          current,
          findPackages: findBuiltPackages,
          readPackage: readEhcoll as never,
        });
        if (alive) setOutcome(result);
      } catch (err) {
        if (alive) {
          setOutcome({
            kind: "unreadable",
            fileName: "your previous build",
            why: err instanceof Error ? err.message : String(err),
          });
        }
      }
    })();
    return (): void => {
      alive = false;
    };
  }, [collectionName, current]);

  return <BuildDiffView outcome={outcome} />;
}

/**
 * The card, given an answer.
 *
 * Split from the loading above so it can be rendered — and looked at — with
 * each outcome in hand. A component whose only path to content is an async
 * effect is a component nobody sees until it ships.
 */
export function BuildDiffView(props: {
  outcome: BuildDiffOutcome | undefined;
}): JSX.Element | null {
  const { outcome } = props;

  // Nothing to say yet, and nothing to say for a first build — a card that
  // announced "this is your first build" on every new collection would be
  // noise on the screen where you are least able to act on it.
  if (outcome === undefined || outcome.kind === "first-build") return null;

  if (outcome.kind === "unreadable") {
    return (
      <Card title="Changes since your last build">
        <p style={{ margin: 0, color: "var(--eh-warning)" }}>
          Couldn't read {outcome.fileName}, so there is nothing to compare
          against: {outcome.why}
        </p>
      </Card>
    );
  }

  const { diff } = outcome;
  return (
    <Card title={`Changes since v${outcome.againstVersion}`}>
      <p
        style={{
          margin: "0 0 var(--eh-sp-2)",
          color: isUnchanged(diff)
            ? "var(--eh-text-secondary)"
            : "var(--eh-text-primary)",
        }}
      >
        {describeCollectionDiff(diff)}
      </p>
      {!isUnchanged(diff) && (
        <div className="eh-stack eh-stack--sm">
          <DiffSectionBlock
            title="Added"
            count={diff.added.length}
            intent="success"
          >
            <DiffLines>
            {diff.added.map((e) => (
              <DiffLine key={e.name} name={e.name} detail={e.version} />
            ))}
          </DiffLines>
          </DiffSectionBlock>
          <DiffSectionBlock
            title="Removed"
            count={diff.removed.length}
            intent="danger"
          >
            <DiffLines>
            {diff.removed.map((e) => (
              <DiffLine key={e.name} name={e.name} detail={e.version} />
            ))}
          </DiffLines>
          </DiffSectionBlock>
          <DiffSectionBlock
            title="Updated"
            count={diff.updated.length}
          >
            <DiffLines>
            {diff.updated.map((e) => (
              <DiffLine
                key={e.name}
                name={e.name}
                detail={`${e.fromVersion} → ${e.toVersion}`}
              />
            ))}
          </DiffLines>
          </DiffSectionBlock>
          {/*
            Above "Enabled or disabled" on purpose. A toggle is a decision the
            curator remembers making; a re-installed mod is one they may not
            realise changed the collection at all, which is exactly why it went
            unnoticed until a stranger's install differed from the curator's.
          */}
          <DiffSectionBlock
            title="Re-installed with different options"
            count={diff.reconfigured.length}
            intent="warning"
          >
            <DiffLines>
              {diff.reconfigured.map((e) => (
                <DiffLine
                  key={`r${e.name}`}
                  name={e.name}
                  detail="installer options changed"
                />
              ))}
            </DiffLines>
          </DiffSectionBlock>
          <DiffSectionBlock
            title="Enabled or disabled"
            count={diff.toggled.length}
          >
            <DiffLines>
            {diff.toggled.map((e) => (
              <DiffLine
                key={e.name}
                name={e.name}
                detail={e.nowEnabled ? "now enabled" : "now disabled"}
              />
            ))}
          </DiffLines>
          </DiffSectionBlock>
        </div>
      )}
    </Card>
  );
}

/** One section's rows, scrolling rather than pushing the page down. */
function DiffLines(props: { children: React.ReactNode }): JSX.Element {
  return (
    <div style={{ maxHeight: 200, overflowY: "auto" }}>{props.children}</div>
  );
}

function DiffLine(props: { name: string; detail?: string }): JSX.Element {
  return (
    <div
      style={{
        display: "flex",
        justifyContent: "space-between",
        gap: "var(--eh-sp-3)",
        padding: "2px 0",
        fontSize: "var(--eh-text-sm)",
      }}
    >
      <span style={{ color: "var(--eh-text-primary)", minWidth: 0 }}>
        {props.name}
      </span>
      {props.detail !== undefined && (
        <span
          style={{
            color: "var(--eh-text-muted)",
            fontFamily: "var(--eh-font-mono)",
            fontSize: "var(--eh-text-xs)",
            whiteSpace: "nowrap",
          }}
        >
          {props.detail}
        </span>
      )}
    </div>
  );
}

function FormPanel(props: FormPanelProps): JSX.Element {
  // Autosave. Everything below used to live only in the build session, which
  // is module-scoped — it survived tab switches and a React remount, and was
  // discarded by a Vortex restart. Fine for a version number; not fine for
  // thirty-two download links researched one at a time.
  const persister = React.useMemo(
    () =>
      createOverridePersister({
        write: async (configPath, config) => {
          const { saveCollectionConfig } = await import(
            "../../../core/manifest/collectionConfig"
          );
          // Split back into the pair the public API takes, rather than
          // reaching for the private writeConfigFile — this keeps the slug
          // validation on the path, and the slug IS the filename.
          await saveCollectionConfig({
            configDir: path.dirname(configPath),
            slug: path.basename(configPath, ".json"),
            config,
          });
        },
        setTimer: (fn, ms) => setTimeout(fn, ms),
        clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
      }),
    [],
  );

  const {
    state,
    title,
    onTitleChange,
    onChange,
    onBuild,
    onDiscardDraft,
    onDismissDraftBanner,
    recoverableCount,
    onRecoverArchives,
    onCheckAvailability,
    availabilityProgress,
    availability,
  } = props;
  const {
    ctx, curator, overrides, readme, changelog, validationError, restoredAt,
    reverifyEverything,
  } = state;

  /**
   * Prerequisite decisions live in the collection config, not the form draft:
   * they describe the COLLECTION, not this build attempt, and should survive
   * into the next one without being retyped.
   */
  const onDependencyChange = (
    id: string,
    patch: ExternalDependencyConfigEntry,
  ): void => {
    const existing = ctx.collectionConfig.externalDependencies ?? {};
    const nextConfig = {
      ...ctx.collectionConfig,
      externalDependencies: {
        ...existing,
        [id]: { ...existing[id], ...patch },
      },
    };
    onChange({ ctx: { ...ctx, collectionConfig: nextConfig } });
    persistNow(overrides, nextConfig);
  };

  // One place that knows what "the config, as the form currently has it"
  // means, so the two callers below cannot drift apart.
  const persistNow = (
    nextOverrides: typeof overrides,
    nextConfig: typeof ctx.collectionConfig,
  ): void => {
    persister.save({
      configPath: ctx.configPath,
      config: configWithOverrides({
        config: nextConfig,
        overrides: nextOverrides,
      }),
    });
  };

  // Write out whatever is still pending when this page unmounts — navigating
  // away is exactly when an 800ms debounce would otherwise lose the last edit.
  React.useEffect(
    () => () => {
      void persister.flush();
    },
    [persister],
  );

  const updateCurator = (patch: Partial<CuratorInput>): void =>
    onChange({ curator: { ...curator, ...patch } });

  // Recomputed from the OVERRIDES, not taken from ctx.externalMods.
  //
  // The context's list is fixed at load time, so a mod marked "treat as
  // external" here would not appear in the table below until the whole profile
  // was rescanned — minutes on a 1000-mod profile, for a checkbox. Deriving it
  // makes the row appear the moment it is marked, which is the only way the
  // action reads as having worked.
  const externalRows = React.useMemo(() => {
    const byId = new Map(ctx.externalMods.map((m) => [m.id, m]));
    for (const m of ctx.mods) {
      if (overrides[m.id]?.treatAsExternal === true) byId.set(m.id, m);
    }
    return [...byId.values()];
  }, [ctx.externalMods, ctx.mods, overrides]);

  const updateOverride = (
    modId: string,
    patch: Partial<ExternalModConfigEntry>,
  ): void => {
    const next = {
      ...overrides,
      [modId]: { ...overrides[modId], ...patch },
    };
    onChange({ overrides: next });
    persistNow(next, ctx.collectionConfig);
  };

  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "minmax(0, 1fr)",
        gap: "var(--eh-sp-4)",
      }}
    >
      {/* Acting on this form usually means LEAVING it: it names a missing
          prerequisite or an archive you have to fetch, you go to Vortex and
          fix it, and you come back to the scan from before you did. The form
          is a snapshot, and until now the only way to retake it was to discard
          the draft — which threw away the typing with it. */}
      <div className="eh-row" style={{ justifyContent: "flex-end" }}>
        {props.refreshedAt !== undefined && !props.refreshing && (
          <span className="eh-note">
            re-read {formatRelativeTime(props.refreshedAt)}
          </span>
        )}
        <Button
          intent="ghost"
          size="sm"
          disabled={props.refreshing}
          onClick={props.onRefresh}
          title={
            "Re-reads your mods, archives and game folder. Everything you " +
            "have typed is kept."
          }
        >
          {props.refreshing ? "Re-reading…" : "Refresh"}
        </Button>
      </div>
      {restoredAt !== undefined && (
        <DraftRestoredBanner
          savedAt={restoredAt}
          onDiscard={onDiscardDraft}
          onDismiss={onDismissDraftBanner}
        />
      )}
      {ctx.scopeWarnings.length > 0 && (
        <div
          role="status"
          style={{
            padding: "var(--eh-sp-3) var(--eh-sp-4)",
            background: "var(--eh-bg-elevated)",
            border: "1px solid var(--eh-warning, var(--eh-border-default))",
            borderRadius: "var(--eh-radius-md)",
            color: "var(--eh-text-primary)",
            fontSize: "var(--eh-text-sm)",
            display: "flex",
            gap: "var(--eh-sp-2)",
            alignItems: "flex-start",
          }}
        >
          <span aria-hidden="true">⚠</span>
          <div>
            <strong>Worth knowing before you build.</strong>
            <ul style={{ margin: "var(--eh-sp-2) 0 0", paddingLeft: "var(--eh-sp-4)" }}>
              {ctx.scopeWarnings.map((warning) => (
                <li key={warning} style={{ marginBottom: "var(--eh-sp-1)" }}>
                  {warning}
                </li>
              ))}
            </ul>
            {recoverableCount > 0 && (
              <div style={{ marginTop: "var(--eh-sp-3)" }}>
                <Button intent="primary" size="sm" onClick={onRecoverArchives}>
                  Re-download {recoverableCount} archive
                  {recoverableCount === 1 ? "" : "s"}
                </Button>
              </div>
            )}
          </div>
        </div>
      )}

      <AvailabilityPanel
        onCheck={onCheckAvailability}
        onTreatAsExternal={(modId: number, fileId: number): void => {
          // Findings are keyed by NEXUS ids; overrides by Vortex mod id.
          const match = ctx.mods.find(
            (m) =>
              Number(m.nexusModId) === modId && Number(m.nexusFileId) === fileId,
          );
          if (match === undefined) return;
          updateOverride(match.id, { treatAsExternal: true });
        }}
        externalModIds={new Set(
          ctx.mods
            .filter((m) => overrides[m.id]?.treatAsExternal === true)
            .map((m) => `${String(m.nexusModId)}:${String(m.nexusFileId)}`),
        )}
        {...(availabilityProgress !== undefined ? { progress: availabilityProgress } : {})}
        {...(availability !== undefined ? { result: availability } : {})}
      />

      {ctx.mods.length === 0 && (
        <div
          role="alert"
          style={{
            padding: "var(--eh-sp-3) var(--eh-sp-4)",
            background: "var(--eh-bg-elevated)",
            border: "1px solid var(--eh-danger)",
            borderRadius: "var(--eh-radius-md)",
            color: "var(--eh-text-primary)",
            fontSize: "var(--eh-text-sm)",
            display: "flex",
            gap: "var(--eh-sp-2)",
            alignItems: "flex-start",
          }}
        >
          <span aria-hidden="true">⚠</span>
          <div>
            <strong>Your active profile has no mods.</strong>{" "}
            A collection needs at least one mod. Enable some mods in
            Vortex first, then come back here.
          </div>
        </div>
      )}
      <BuildDiffCard collectionName={curator.name} current={ctx.mods} />

      <Card title="Collection metadata">
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            gap: "var(--eh-sp-3)",
            marginBottom: "var(--eh-sp-3)",
            flexWrap: "wrap",
          }}
        >
          <Field
            label="Draft label (dashboard only)"
            hint="Optional. Helps you tell drafts apart on the dashboard. Not shipped in the .ehcoll."
          >
            <input
              type="text"
              className="eh-input"
              value={title}
              placeholder={`Untitled draft — e.g. "${ctx.gameId} main run"`}
              onChange={(e) => onTitleChange(e.target.value)}
              style={{ minWidth: 280 }}
            />
          </Field>
          <ImportPreviousButton
            onImported={(patch): void => {
              onChange({ curator: { ...curator, ...patch } });
            }}
          />
        </div>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
            gap: "var(--eh-sp-3)",
          }}
        >
          <Field label="Name" hint="Curator-facing display name. Becomes the package name.">
            <input
              type="text"
              className="eh-input"
              value={curator.name}
              placeholder="My Awesome Skyrim Build"
              onChange={(e) => updateCurator({ name: e.target.value })}
            />
          </Field>
          <Field label="Version" hint="Semver: 1.0.0, 0.2.1-beta.1.">
            <input
              type="text"
              className="eh-input"
              value={curator.version}
              placeholder="1.0.0"
              onChange={(e) => updateCurator({ version: e.target.value })}
            />
          </Field>
          <Field label="Author">
            <input
              type="text"
              className="eh-input"
              value={curator.author}
              placeholder="Your Nexus username"
              onChange={(e) => updateCurator({ author: e.target.value })}
            />
          </Field>
        </div>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "minmax(220px, 2fr) minmax(160px, 1fr)",
            gap: "var(--eh-sp-3)",
            marginTop: "var(--eh-sp-3)",
          }}
        >
          <Field
            label="Required game version"
            hint={
              ctx.gameVersion === "unknown"
                ? "Vortex could not read your game's version — type it in, or leave blank to ship no requirement."
                : `Detected on this machine: ${ctx.gameVersion}. Users on a different version are told to use a downgrader.`
            }
          >
            <input
              type="text"
              className="eh-input"
              value={curator.gameVersion}
              placeholder="e.g. 1.10.163.0 — blank means no check"
              onChange={(e) => updateCurator({ gameVersion: e.target.value })}
            />
          </Field>
          <Field
            label="Enforcement"
            hint={
              curator.gameVersionPolicy === "exact"
                ? "Blocks any other version."
                : "Blocks only older versions."
            }
          >
            <select
              className="eh-input"
              value={curator.gameVersionPolicy}
              disabled={curator.gameVersion.trim().length === 0}
              onChange={(e) =>
                updateCurator({
                  gameVersionPolicy: e.target.value as GameVersionPolicy,
                })
              }
            >
              <option value="exact">Exactly this version</option>
              <option value="minimum">This version or newer</option>
            </select>
          </Field>
        </div>
        <div style={{ marginTop: "var(--eh-sp-3)" }}>
          <Field label="Description (optional)">
            <textarea
              className="eh-input eh-input--textarea"
              rows={3}
              value={curator.description}
              placeholder="What this collection ships, who it's for..."
              onChange={(e) => updateCurator({ description: e.target.value })}
            />
          </Field>
        </div>
        <div
          style={{
            display: "flex",
            gap: "var(--eh-sp-2)",
            marginTop: "var(--eh-sp-3)",
            flexWrap: "wrap",
          }}
        >
          <Pill intent="info">{ctx.gameId}</Pill>
          <Pill intent="neutral">{ctx.mods.length} mods</Pill>
          <Pill intent="neutral">{ctx.externalMods.length} external</Pill>
          {ctx.configCreated ? (
            <Pill intent="warning">first build</Pill>
          ) : (
            <Pill intent="success" withDot>
              config loaded
            </Pill>
          )}
        </div>
      </Card>

      <Card title={`External mods (${ctx.externalMods.length})`}>
        {externalRows.length === 0 ? (
          <p style={{ margin: 0, color: "var(--eh-text-secondary)" }}>
            No external (non-Nexus) mods in this profile. Nothing to override.
          </p>
        ) : (
          <ExternalModsTable
            mods={externalRows}
            overrides={overrides}
            hints={ctx.externalHints}
            onChange={updateOverride}
          />
        )}
      </Card>

      {/*
        Facts, not a warning, and shown even when it is one line long.
        A panel that hid itself when the list was short could not do its job:
        the point is to let a curator notice something ABSENT from it. Nothing
        in a staging folder distinguishes an engine injector from a tool —
        tried against the real collection, it matched Pandora and Nemesis —
        so this states what Vortex will do and leaves the judgement to the
        person who knows their own load order.
      */}
      <Card title="Installs outside Data">
        <div className="eh-stack eh-stack--xs">
          {ctx.rootFolderReview.map((line, i) => (
            <p
              key={`${i}-${line.slice(0, 24)}`}
              style={{
                margin: 0,
                color: line.startsWith("  •")
                  ? "var(--eh-text-primary)"
                  : "var(--eh-text-secondary)",
                fontFamily: line.startsWith("  •")
                  ? "var(--eh-font-mono)"
                  : undefined,
                fontSize: line.startsWith("  •") ? "0.9em" : undefined,
              }}
            >
              {line}
            </p>
          ))}
        </div>
      </Card>

      <Card title="README (optional)">
        <textarea
          className="eh-input eh-input--textarea"
          rows={6}
          value={readme}
          placeholder="Markdown shipped inside the .ehcoll. Shown on the install screen."
          onChange={(e) => onChange({ readme: e.target.value })}
        />
      </Card>

      <Card title="CHANGELOG (optional)">
        <textarea
          className="eh-input eh-input--textarea"
          rows={6}
          value={changelog}
          placeholder="Markdown describing what's new in this version."
          onChange={(e) => onChange({ changelog: e.target.value })}
        />
      </Card>

      <PrerequisitesCard
        detected={ctx.detectedDependencies}
        overrides={ctx.collectionConfig.externalDependencies ?? {}}
        gameVersion={ctx.gameVersion}
        gameId={ctx.gameId}
        onChange={onDependencyChange}
      />

      <IntegrityLevelCard
        modCount={ctx.mods.length}
        reverify={reverifyEverything}
        onReverifyChange={(v): void => onChange({ reverifyEverything: v })}
      />

      <div
        style={{
          display: "flex",
          justifyContent: "flex-end",
          gap: "var(--eh-sp-2)",
          alignItems: "center",
          flexWrap: "wrap",
        }}
      >
        {validationError !== undefined && (
          <span
            style={{
              color: "var(--eh-danger)",
              fontSize: "var(--eh-text-sm)",
            }}
          >
            {validationError}
          </span>
        )}
        <Button
          intent="primary"
          size="lg"
          onClick={onBuild}
          disabled={state.ctx.mods.length === 0}
          title={
            state.ctx.mods.length === 0
              ? "Enable at least one mod in your Vortex profile first"
              : undefined
          }
        >
          Build .ehcoll
        </Button>
      </div>
    </div>
  );
}

// ===========================================================================
// Integrity verification level
// ===========================================================================

interface IntegrityLevelCardProps {
  modCount: number;
  reverify: boolean;
  onReverifyChange: (value: boolean) => void;
}

interface PrerequisitesCardProps {
  detected: EhcollExternalDependency[];
  overrides: Record<string, ExternalDependencyConfigEntry>;
  gameVersion: string;
  gameId: string;
  onChange: (id: string, patch: ExternalDependencyConfigEntry) => void;
}

/**
 * Prerequisites the collection cannot install for the user, and the game
 * version it was built against.
 *
 * These share a card because they share a failure: both are things that are
 * simply TRUE of the curator's machine, invisible until someone else tries to
 * reproduce it, and both leave the user stuck in a way no amount of mod
 * installing fixes. A script extender that has to be fetched by hand, and a
 * game version that has to be matched — usually by moving the game BACKWARDS,
 * which is the single least obvious thing about modding Bethesda titles.
 *
 * Nothing here is typed by the curator: the dependencies were detected in the
 * game folder with real file hashes, and the version is Vortex's own. The
 * curator supplies judgement — ship it or not — and the instructions, which are
 * the part a generic default cannot know.
 */
function PrerequisitesCard(props: PrerequisitesCardProps): JSX.Element {
  const { detected, overrides, gameVersion, gameId, onChange } = props;
  return (
    <Card title="Requirements the user must satisfy themselves">
      <div
        style={{
          padding: "var(--eh-sp-3)",
          border: "1px solid var(--eh-border-default)",
          borderRadius: "var(--eh-radius-md)",
          marginBottom: "var(--eh-sp-3)",
        }}
      >
        <strong>Game version — {gameVersion}</strong>
        <p
          style={{
            margin: "var(--eh-sp-1) 0 0",
            color: "var(--eh-text-secondary)",
            fontSize: "var(--eh-text-sm)",
          }}
        >
          Recorded from your install and required exactly. Anyone on a different
          build is told which version they need and pointed at a downgrader —
          moving a Bethesda game backwards is routine, and it is the thing people
          most often do not know they can do.
          {gameId === "fallout4" && gameVersion.startsWith("1.10.9") ? (
            <>
              {" "}
              <strong>
                Note: {gameVersion} is a post-&ldquo;next-gen&rdquo; build.
              </strong>{" "}
              Much of the F4SE plugin ecosystem still targets 1.10.163, so check
              your own load order runs before shipping this.
            </>
          ) : null}
        </p>
      </div>

      {detected.length === 0 ? (
        <p style={{ margin: 0, color: "var(--eh-text-secondary)" }}>
          No prerequisites detected in your game folder that the collection does
          not already install. A script extender or ENB installed as a Vortex mod
          ships with the collection, so it is deliberately not listed here.
        </p>
      ) : (
        <div className="eh-stack">
          {detected.map((dep) => {
            const o = overrides[dep.id] ?? {};
            const included = o.included !== false;
            return (
              <div
                key={dep.id}
                style={{
                  padding: "var(--eh-sp-3)",
                  border: `1px solid ${included ? "var(--eh-accent)" : "var(--eh-border-default)"}`,
                  borderRadius: "var(--eh-radius-md)",
                  background: included ? "var(--eh-bg-elevated)" : "transparent",
                }}
              >
                <label style={{ display: "flex", gap: "var(--eh-sp-2)", alignItems: "center" }}>
                  <input
                    type="checkbox"
                    checked={included}
                    onChange={(e): void => onChange(dep.id, { included: e.target.checked })}
                  />
                  <strong>{dep.name}</strong>
                  <Pill intent="neutral">{dep.version}</Pill>
                  <Pill intent="neutral">{dep.files.length} files</Pill>
                </label>
                <p
                  style={{
                    margin: "var(--eh-sp-2) 0",
                    color: "var(--eh-text-secondary)",
                    fontSize: "var(--eh-text-sm)",
                  }}
                >
                  Found in your game folder, installed by no mod in this
                  collection. The user's copy is verified against these hashes.
                </p>
                <textarea
                  className="eh-input eh-input--textarea"
                  rows={3}
                  value={o.instructions ?? dep.instructions}
                  placeholder="What should the user do? Which build to download, and from where."
                  onChange={(e): void => onChange(dep.id, { instructions: e.target.value })}
                />
                <input
                  className="eh-input"
                  value={o.instructionsUrl ?? dep.instructionsUrl ?? ""}
                  placeholder="Download link"
                  onChange={(e): void => onChange(dep.id, { instructionsUrl: e.target.value })}
                  style={{ marginTop: "var(--eh-sp-2)" }}
                />
              </div>
            );
          })}
        </div>
      )}
    </Card>
  );
}

/**
 * Integrity verification is no longer a choice, and this explains why rather
 * than just removing the control.
 *
 * It used to offer fast / thorough / skip. "Fast" recorded paths and sizes
 * only — but `computeStagingSetHash` requires a sha256 on every file, so an
 * external mod with no surviving archive had no identity at all and the build
 * refused to package it. A curator picking the option labelled "recommended"
 * got a collection that would not build. "Skip" produced a package with no
 * integrity data, which is the one thing this tool exists to provide.
 *
 * Thorough was only ever expensive because it re-read every byte on every
 * build. Hashes are now reused while a file's path, size and mtime all match,
 * so the cost is paid once. What survives as a choice is the honest one: force
 * a full re-read when you want to catch bytes rewritten in place, which is the
 * single thing a fingerprint cannot see.
 */
function IntegrityLevelCard(props: IntegrityLevelCardProps): JSX.Element {
  const { modCount, reverify, onReverifyChange } = props;
  return (
    <Card title="Integrity verification">
      <p
        style={{
          margin: 0,
          marginBottom: "var(--eh-sp-3)",
          color: "var(--eh-text-secondary)",
          fontSize: "var(--eh-text-sm)",
        }}
      >
        Every build records a SHA-256 for each file in all {modCount} mods, so
        an installing user can tell when Vortex drops or corrupts something.
        It is also what identifies a mod whose source archive is gone. Files
        already hashed are reused unless they changed, so this is only slow the
        first time.
      </p>
      <label
        style={{
          display: "flex",
          gap: "var(--eh-sp-3)",
          padding: "var(--eh-sp-3)",
          border: `1px solid ${reverify ? "var(--eh-accent)" : "var(--eh-border-default)"}`,
          borderRadius: "var(--eh-radius-md)",
          background: reverify ? "var(--eh-bg-elevated)" : "transparent",
          cursor: "pointer",
          alignItems: "flex-start",
        }}
      >
        <input
          type="checkbox"
          checked={reverify}
          onChange={(e): void => onReverifyChange(e.target.checked)}
          style={{ marginTop: 3 }}
        />
        <span>
          <strong>Re-read every file</strong>
          <span
            style={{
              display: "block",
              color: "var(--eh-text-secondary)",
              fontSize: "var(--eh-text-sm)",
            }}
          >
            Ignores cached hashes and reads all {modCount} mods from disk again.
            Only worth it if you suspect a file changed without its size or
            timestamp changing — disk corruption rather than anything Vortex
            does. Costs a full pass over your staging folder.
          </span>
        </span>
      </label>
    </Card>
  );
}

// ===========================================================================
// Import previous .ehcoll
// ===========================================================================

interface ImportPreviousButtonProps {
  onImported: (patch: Partial<CuratorInput>) => void;
}

/** Small ghost button on the metadata card. Lets the curator pick a
 * previously-built `.ehcoll` and prefill name/version/author/description
 * from its manifest. We do not import mod selections or external-mod
 * overrides — those depend on the *current* profile's mods, and a stale
 * import would produce silently-mismatched config. */
function ImportPreviousButton(props: ImportPreviousButtonProps): JSX.Element {
  const reportError = useErrorReporter();
  const showToast = useToast();
  // Vortex's own picker, not Electron's — see pickEhcollFile.
  const api = useApi();
  const [busy, setBusy] = React.useState(false);

  const handleClick = React.useCallback(async (): Promise<void> => {
    setBusy(true);
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { pickEhcollFile } = await import("../../../utils/utils");
      const file = await pickEhcollFile(api);
      if (file === undefined) return;

      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { readEhcoll } = await import(
        "../../../core/manifest/readEhcoll"
      );
      const result = await readEhcoll(file);
      const pkg = result.manifest.package;

      const patch: Partial<CuratorInput> = {
        name: pkg.name,
        version: pkg.version,
        author: pkg.author,
        description: pkg.description ?? "",
      };
      props.onImported(patch);
      showToast({
        intent: "success",
        title: "Imported metadata",
        message: `Pre-filled from "${pkg.name}" v${pkg.version}.`,
      });
    } catch (err) {
      reportError(err, {
        title: "Couldn't import .ehcoll metadata",
        context: { step: "build-import-existing" },
      });
    } finally {
      setBusy(false);
    }
  }, [props, reportError, showToast]);

  return (
    <Button
      intent="ghost"
      size="sm"
      disabled={busy}
      onClick={(): void => {
        void handleClick();
      }}
      title="Pick a previously-built .ehcoll and copy its name/version/author/description into this form."
    >
      {busy ? "Importing..." : "Import from previous .ehcoll"}
    </Button>
  );
}

// ===========================================================================
// External mods table
// ===========================================================================

interface ExternalModsTableProps {
  mods: BuildContext["externalMods"];
  overrides: Record<string, ExternalModConfigEntry>;
  onChange: (modId: string, patch: Partial<ExternalModConfigEntry>) => void;
}

/**
 * What Vortex already knows about this mod, offered rather than applied.
 *
 * The suggestion is NOT written into the curator's config on its own. It came
 * from a download record or a rule, not from them, and silently filling a
 * field they will later read back as their own words is how a wrong link ends
 * up published under their name. So it sits next to the field, says where it
 * came from, and takes one click to accept.
 *
 * Nothing renders when Vortex knows nothing — which on a profile whose mods
 * were all installed from disk is the normal case, not a failure.
 */
/**
 * Why this link will not survive, in the curator's words.
 *
 * The manifest only carries http(s): a `file://` or bare path is the
 * curator's own machine and means nothing to anyone else, and the parser
 * drops anything else on the way IN — silently, on someone else's computer,
 * long after the curator could have fixed it.
 */
export function urlProblem(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  if (/^https?:\/\/\S+$/i.test(trimmed)) return undefined;
  if (/^[a-z]+:\/\//i.test(trimmed)) {
    return "Only http:// and https:// links are shipped — this one will be dropped.";
  }
  return "Needs the full address, starting with https:// — otherwise it is dropped.";
}

function HintSuggestion(props: {
  hint?: ExternalHint;
  current: { instructions?: string; url?: string };
  onAccept: (patch: { instructions?: string; url?: string }) => void;
}): JSX.Element | null {
  const { hint, current } = props;
  if (hint === undefined) return null;

  // Only offer what would actually fill a gap. A curator who already wrote
  // both fields does not need a button that changes nothing.
  const offersUrl = hint.url !== undefined && current.url === undefined;
  const offersText =
    hint.instructions !== undefined && current.instructions === undefined;
  if (!offersUrl && !offersText) return null;

  const source =
    hint.via === "collection-rule"
      ? "your Vortex collection"
      : hint.via === "homepage"
        ? "the mod's homepage"
        : "where the archive was downloaded from";

  return (
    <div className="eh-row eh-row--sm" style={{ alignItems: "flex-start" }}>
      <span className="eh-note eh-fill">
        From {source}:{" "}
        {hint.url !== undefined && (
          <span className="eh-mono" style={{ wordBreak: "break-all" }}>
            {hint.url}
          </span>
        )}
        {hint.instructions !== undefined && ` — ${hint.instructions}`}
      </span>
      <Button
        intent="ghost"
        onClick={(): void =>
          props.onAccept({
            ...(offersUrl ? { url: hint.url } : {}),
            ...(offersText ? { instructions: hint.instructions } : {}),
          })
        }
      >
        Use
      </Button>
    </div>
  );
}

/**
 * How the user gets this mod: bundled, a direct link, a website, or by hand.
 *
 * A four-way choice rather than the old bundled/not checkbox, because that is
 * the choice Vortex itself models and the one the install screen already acts
 * on — it tells someone the link "starts downloading" or that they should
 * "find the file on the page", and only the curator knows which is true.
 *
 * The selected option's consequence is spelled out underneath rather than
 * left to the label. "Direct link" and "From website" are indistinguishable
 * as words to anyone who has not thought about the difference, and this form
 * is the only place the difference gets decided.
 */
function SourceChoice(props: {
  value: ExternalSourceKind;
  /**
   * Whether the mod has a staging folder to pack FROM.
   *
   * Deliberately not "has an archive": bundling repacks the staging folder
   * into a new archive, so a hand-made mod Vortex never downloaded bundles
   * perfectly well. Gating on the archive would have blocked the case this
   * feature exists for.
   */
  hasStagingFolder: boolean;
  onChange: (kind: ExternalSourceKind) => void;
}): JSX.Element {
  return (
    <div className="eh-stack eh-stack--xs" style={{ minWidth: "9rem" }}>
      <select
        className="eh-input"
        value={props.value}
        onChange={(e): void =>
          props.onChange(e.target.value as ExternalSourceKind)
        }
      >
        {SOURCE_KINDS.map((kind) => (
          <option
            key={kind}
            value={kind}
            /* Nothing on disk to pack from. Note this is the STAGING
               folder, not the download — see the prop's doc. */
            disabled={kind === "bundled" && !props.hasStagingFolder}
          >
            {describeSourceKind(kind).label}
          </option>
        ))}
      </select>
      <span className="eh-note">{describeSourceKind(props.value).hint}</span>
    </div>
  );
}

function ExternalModsTable(
  props: ExternalModsTableProps & {
    /** What Vortex already knows about where each mod came from. */
    hints?: ReadonlyMap<string, ExternalHint>;
  },
): JSX.Element {
  const { mods, overrides, onChange } = props;
  return (
    <div
      style={{
        border: "1px solid var(--eh-border-subtle)",
        borderRadius: "var(--eh-radius-sm)",
        overflow: "hidden",
      }}
    >
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "minmax(0, 2fr) auto minmax(0, 3fr)",
          gap: "var(--eh-sp-3)",
          padding: "var(--eh-sp-2) var(--eh-sp-3)",
          background: "var(--eh-bg-base)",
          color: "var(--eh-text-muted)",
          fontSize: "var(--eh-text-xs)",
          textTransform: "uppercase",
          letterSpacing: "var(--eh-tracking-widest)",
        }}
      >
        <span>Mod</span>
        <span>Source</span>
        <span>Link and instructions</span>
      </div>
      {mods.map((mod) => {
        const override = overrides[mod.id] ?? {};
        // What bundling actually needs. The archive is irrelevant to it —
        // repackBundledExternals packs the staging folder and re-keys the mod
        // to the new archive's hash before the manifest is built.
        const hasStagingFolder =
          typeof mod.installationPath === "string" &&
          mod.installationPath.length > 0;
        // A separate fact, and still worth showing: with no archive the mod's
        // identity falls back to its staging-set hash rather than an archive
        // sha. That affects how it is MATCHED on the user's machine, not
        // whether it can ship.
        const hasArchive =
          typeof mod.archiveSha256 === "string" && mod.archiveSha256.length > 0;
        return (
          <div
            key={mod.id}
            style={{
              display: "grid",
              gridTemplateColumns: "minmax(0, 2fr) auto minmax(0, 3fr)",
              gap: "var(--eh-sp-3)",
              padding: "var(--eh-sp-3)",
              borderTop: "1px solid var(--eh-border-subtle)",
              alignItems: "start",
            }}
          >
            <div>
              <div
                style={{
                  color: "var(--eh-text-primary)",
                  fontWeight: 600,
                  wordBreak: "break-word",
                }}
              >
                {mod.name}
              </div>
              <div
                style={{
                  color: "var(--eh-text-muted)",
                  fontSize: "var(--eh-text-xs)",
                  fontFamily: "var(--eh-font-mono)",
                  marginTop: 2,
                  wordBreak: "break-all",
                }}
              >
                {mod.id}
              </div>
              {!hasArchive && (
                <div style={{ marginTop: 4 }}>
                  {/* Neutral, not a warning: this does not stop the mod
                      shipping. Bundling repacks the staging folder, and
                      identity falls back to the staging-set hash. It was
                      styled as a problem, which is what made "no archive"
                      read as "cannot be bundled". */}
                  <Pill intent="neutral">identified by files</Pill>
                </div>
              )}
            </div>
            <SourceChoice
              value={sourceKindOf(override)}
              hasStagingFolder={hasStagingFolder}
              onChange={(kind): void => onChange(mod.id, sourcePatch(kind))}
            />
            <div className="eh-stack eh-stack--xs">
              {/* The link the user gets when this mod is not bundled.
                  Everything downstream of this existed before the field did —
                  the manifest carries a url, the install screen renders it as
                  "Open the page", and openExternalUrl opens it in the user's
                  own browser — but there was nowhere to type one, so the whole
                  chain was unreachable unless Vortex happened to know the URL
                  itself. On a profile of hand-added archives it never does. */}
              {/* Only the link-based kinds have anywhere to put a link.
                  Shown for Bundled too when one was already typed, so
                  switching to Bundled does not make the curator's own text
                  vanish — it is kept, just not used. */}
              {(sourceKindOf(override) === "direct" ||
                sourceKindOf(override) === "browse" ||
                (override.url ?? "").length > 0) && (
                <input
                  className="eh-input"
                  type="url"
                  inputMode="url"
                  placeholder={
                    sourceKindOf(override) === "direct"
                      ? "Link to the file — https://..."
                      : "Link to the mod's page — https://..."
                  }
                  value={override.url ?? ""}
                  onChange={(e) => onChange(mod.id, { url: e.target.value })}
                  style={
                    urlProblem(override.url) !== undefined
                      ? { borderColor: "var(--eh-warning)" }
                      : undefined
                  }
                />
              )}
              {/* Said HERE rather than at build time, because the manifest
                  parser drops a non-http(s) link on the user's machine — so a
                  curator who typed "example.com" would publish a collection
                  with no link and never find out. Caught where it is typed,
                  and where it can be fixed. */}
              {urlProblem(override.url) !== undefined && (
                <span className="eh-note" style={{ color: "var(--eh-warning)" }}>
                  {urlProblem(override.url)}
                </span>
              )}
              {/* A choice that cannot work: "From website" with no page to
                  open, or "Bundled" with no archive left to bundle. Caught
                  here because the user-side screen would otherwise offer a
                  button that has nothing behind it. */}
              {sourceProblem(override, { hasStagingFolder }) !== undefined && (
                <span className="eh-note" style={{ color: "var(--eh-warning)" }}>
                  {sourceProblem(override, { hasStagingFolder })}
                </span>
              )}
              <textarea
                className="eh-input eh-input--textarea"
                rows={2}
                placeholder="Optional instructions shown when the user installs."
                value={override.instructions ?? ""}
                onChange={(e) =>
                  onChange(mod.id, { instructions: e.target.value })
                }
              />
              <HintSuggestion
                hint={props.hints?.get(mod.id)}
                current={override}
                onAccept={(patch): void => onChange(mod.id, patch)}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ===========================================================================
// Building
// ===========================================================================


/**
 * The one finding on the Done card that is a QUESTION rather than a notice.
 *
 * Everything else here can be read and ignored. This cannot: leaving a mod
 * undecided ships a collection that fails on every machine that installs it.
 *
 * ─── BUILT TO BE SLOW TO ANSWER ────────────────────────────────────────
 * There is no "mark all", no default selection, and the offending file names
 * are on screen rather than behind a link. That is deliberate and it is the
 * whole design. The cheap answer ("these are all mine") is always available,
 * always plausible, and when wrong produces a collection that installs
 * perfectly for everyone while silently omitting the files the curator added
 * — no error, no warning, nothing in a diff. A curator who has to read six
 * file names per mod will notice the patch they dropped in; one clicking a
 * bulk action will not.
 *
 * So the friction is the feature. It costs a minute per mod, once.
 */
/**
 * ──────────────────────────────────────────────────────────────────────
 * The build, held open for an answer.
 *
 * Packing has not happened yet, which is the whole point: an answer given
 * here ships in the package being built. Asked on the Done card it applied to
 * the NEXT build, so shipping one decision cost two builds.
 *
 * Continuing without answering is allowed and says what it costs. The
 * alternative — refusing to proceed — would trap a curator who wants to think
 * about it, in the middle of a build they cannot leave.
 * ──────────────────────────────────────────────────────────────────────
 */
export function DecisionsGate(props: {
  state: Extract<BuildSessionState, { kind: "awaiting-decisions" }>;
  onDecide: (
    c: PostProcessingCandidate,
    choice: PostProcessingChoice,
  ) => Promise<void>;
  onContinue: () => void;
  onCancel: () => void;
}): JSX.Element {
  const [decided, setDecided] = React.useState<
    ReadonlyMap<string, PostProcessingChoice>
  >(new Map());
  const [busy, setBusy] = React.useState<string | undefined>(undefined);
  const { candidates } = props.state;
  // A settled row is listed for review and is NOT outstanding. Counting it
  // made the button say "3 unanswered" under a heading reading "2 mods need
  // a decision".
  const open = candidates.filter((c) => c.needsAnswer && !decided.has(c.modId));

  return (
    <Card title="Before this gets packed">
      <p style={{ margin: "0 0 var(--eh-sp-3)", color: "var(--eh-text-secondary)" }}>
        The build is waiting here. Whatever you answer goes into the package
        it is about to make — you do not have to build again.
      </p>

      <PostProcessingDecisions
        candidates={candidates}
        decided={decided}
        busy={busy}
        applyMode="this-build"
        onDecide={(candidate, choice): void => {
          setBusy(candidate.modId);
          void (async (): Promise<void> => {
            try {
              await props.onDecide(candidate, choice);
              setDecided((prev) => new Map(prev).set(candidate.modId, choice));
            } finally {
              setBusy(undefined);
            }
          })();
        }}
      />

      <div
        style={{
          display: "flex",
          gap: "var(--eh-sp-2)",
          marginTop: "var(--eh-sp-3)",
          flexWrap: "wrap",
          alignItems: "center",
        }}
      >
        <Button
          intent="primary"
          disabled={busy !== undefined}
          onClick={props.onContinue}
        >
          {open.length === 0
            ? "Continue building"
            : `Continue with ${open.length} unanswered`}
        </Button>
        <Button intent="ghost" disabled={busy !== undefined} onClick={props.onCancel}>
          Cancel build
        </Button>
        {open.length > 0 && (
          <span style={{ color: "var(--eh-text-secondary)", fontSize: "var(--eh-text-sm)" }}>
            Unanswered mods ship as they are today — their extra files are
            recorded as required, and users installing from the archive cannot
            produce them.
          </span>
        )}
      </div>
    </Card>
  );
}

function PostProcessingDecisions(props: {
  candidates: PostProcessingCandidate[];
  /** Mods already answered in this session, so the list shrinks as they go. */
  decided: ReadonlyMap<string, PostProcessingChoice>;
  busy: string | undefined;
  onDecide: (c: PostProcessingCandidate, choice: PostProcessingChoice) => void;
  /**
   * Which package these answers reach.
   *
   * Asked mid-build they land in the package being made; asked on the Done
   * card the package is already sealed and they wait for the next one. The
   * same component says both, because saying the wrong one is how a curator
   * ends up believing they shipped a decision they did not.
   */
  applyMode?: "this-build" | "next-build";
}): JSX.Element | null {
  const { candidates, decided, busy, onDecide } = props;
  const applyMode = props.applyMode ?? "next-build";
  /**
   * Rows the curator has explicitly re-opened to change the verdict.
   *
   * Settled mods are LISTED now rather than hidden — a verdict given once was
   * previously unreachable for ever, which made the screen impossible to
   * review. They show their answer; this is what turns one back into a
   * question.
   */
  const [changing, setChanging] = React.useState<ReadonlySet<string>>(new Set());
  const open = candidates.filter(
    (c) => c.needsAnswer && !decided.has(c.modId),
  );
  if (candidates.length === 0) return null;

  const intro = describeDecisionIntro(open.length);

  return (
    <div
      style={{
        padding: "var(--eh-sp-3)",
        background: "rgba(255, 122, 122, 0.06)",
        border: "1px solid var(--eh-danger, #ff7a7a)",
        borderRadius: "var(--eh-radius-sm)",
      }}
      className="eh-stack eh-stack--sm"
    >
      {open.length === 0 ? (
        <strong style={{ color: "var(--eh-text-primary)" }}>
          All {candidates.length} answered.{" "}
          {applyMode === "this-build"
            ? "They will be applied to this build."
            : "Build again to apply them."}
        </strong>
      ) : (
        <>
          <strong style={{ color: "var(--eh-text-primary)" }}>{intro.title}</strong>
          <p style={{ margin: 0, color: "var(--eh-text-secondary)" }}>{intro.what}</p>
          <p style={{ margin: 0, color: "var(--eh-text-primary)" }}>
            <strong>{intro.question}</strong>
          </p>
          <p style={{ margin: 0, color: "var(--eh-text-secondary)" }}>
            {intro.ifIgnored}
          </p>
          {/* The warning against the cheap answer, styled so it is not skipped. */}
          <p
            style={{
              margin: 0,
              padding: "var(--eh-sp-2)",
              borderLeft: "3px solid var(--eh-warning)",
              color: "var(--eh-warning)",
            }}
          >
            {intro.caution}
          </p>
        </>
      )}

      {/*
        One card per mod, and the separation has to be real.
        `--eh-border-subtle` is rgba(255,255,255,0.06) on a panel that is
        already near-black, so the previous divider was invisible and 57 mods
        ran together as a single column of text. Each card now sits on a
        raised surface with a border that can actually be seen, because the
        curator is answering these one at a time and needs to see where one
        question ends and the next begins.
      */}
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: "var(--eh-sp-3)",
          marginTop: "var(--eh-sp-2)",
        }}
      >
        {candidates.map((c, i) => {
          // Either answered a moment ago in this panel, or carried in from
          // the config. Both are a verdict and both are changeable.
          const settledAs: PostProcessingChoice | undefined =
            decided.get(c.modId) ??
            (c.needsAnswer ? undefined : (c.decision as PostProcessingChoice | undefined));
          const answer = decided.get(c.modId);
          const done = settledAs !== undefined && !changing.has(c.modId);
          return (
            <div
              key={c.modId}
              style={{
                padding: "var(--eh-sp-3)",
                background: done
                  ? "var(--eh-bg-base)"
                  : "var(--eh-bg-raised)",
                border: `1px solid ${
                  done ? "var(--eh-border-subtle)" : "var(--eh-border-default)"
                }`,
                borderRadius: "var(--eh-radius-md)",
                boxShadow: done ? "none" : "var(--eh-shadow-card)",
                opacity: done ? 0.6 : 1,
              }}
              className="eh-stack eh-stack--sm"
            >
              {/* Header: which mod, how far through, and the count as a badge. */}
              <div
                style={{
                  display: "flex",
                  alignItems: "baseline",
                  justifyContent: "space-between",
                  gap: "var(--eh-sp-3)",
                  flexWrap: "wrap",
                }}
              >
                <div
                  style={{
                    color: "var(--eh-text-primary)",
                    fontSize: "var(--eh-text-md)",
                    minWidth: 0,
                    wordBreak: "break-word",
                  }}
                >
                  <span
                    style={{
                      color: "var(--eh-text-muted)",
                      fontVariantNumeric: "tabular-nums",
                      marginRight: "var(--eh-sp-2)",
                    }}
                  >
                    {i + 1}/{candidates.length}
                  </span>
                  <strong>{c.modName}</strong>
                </div>
                <span
                  style={{
                    flexShrink: 0,
                    padding: "2px var(--eh-sp-2)",
                    borderRadius: "var(--eh-radius-pill)",
                    background: "var(--eh-warning-soft)",
                    color: "var(--eh-warning)",
                    fontSize: "var(--eh-text-xs)",
                    whiteSpace: "nowrap",
                  }}
                >
                  {describeUnreproducible(c.unexplained)}
                </span>
              </div>

              {c.shipsNothing && (
                /*
                  The degenerate case, and it needs saying out loud because
                  every ordinary answer below is wrong for it.
                  "Declare" settles what VERIFICATION does — the user is no
                  worse off without these files — and says nothing about
                  whether the mod is worth installing. A curator can answer
                  correctly and still ship a mod that makes every user
                  perform an install to obtain nothing, and on a real
                  collection that install was a FOMOD dialog that ended in a
                  Vortex error.
                */
                <p
                  style={{
                    margin: 0,
                    padding: "var(--eh-sp-2)",
                    borderLeft: "3px solid var(--eh-warning)",
                    color: "var(--eh-text-secondary)",
                    fontSize: "var(--eh-text-sm)",
                  }}
                >
                  <strong className="eh-strong">
                    This mod ships nothing a user can obtain.
                  </strong>{" "}
                  Every file in its staging folder is one its archive cannot
                  produce, so installing it from that archive gives the user an
                  empty mod. Bundling or mirroring would ship these exact files
                  and work — but if they are a placeholder or leftover, the
                  useful answer is to remove the mod from your collection.
                </p>
              )}

              {c.reopened && (
                // Not a new question. The curator answered this mod before and
                // the files it was about have changed since, so the old answer
                // is deliberately not reapplied — reapplying "users don't need
                // them" to a file added afterwards withholds it in silence.
                <p
                  style={{
                    margin: 0,
                    padding: "var(--eh-sp-2)",
                    borderLeft: "3px solid var(--eh-info)",
                    color: "var(--eh-text-secondary)",
                    fontSize: "var(--eh-text-sm)",
                  }}
                >
                  You answered this mod before, and these files have changed
                  since. Your previous answer is still saved and still applies
                  until you change it here — this is asking again because it
                  was given about different files.
                </p>
              )}

              {/*
                Evidence, on screen. The decision is unanswerable without it —
                and a bare path is not enough evidence. "Common Clothes and
                Armors.esp" tells the curator nothing about whether declaring
                it costs the user that file or merely hands them the archive's
                version, so each path now carries what it means.
              */}
              {c.files.length > 0 && (
                <ul
                  style={{
                    margin: 0,
                    padding: "var(--eh-sp-2) var(--eh-sp-2) var(--eh-sp-2) var(--eh-sp-5)",
                    background: "var(--eh-bg-deep)",
                    borderRadius: "var(--eh-radius-sm)",
                    fontFamily: "var(--eh-font-mono)",
                    fontSize: "var(--eh-text-xs)",
                    color: "var(--eh-text-secondary)",
                  }}
                >
                  {c.files.map((f) => (
                    <li key={f.path}>
                      {f.path}
                      <span
                        style={{
                          color:
                            f.kind === "changed" && (f.delta ?? 0) > 0
                              ? "var(--eh-warning)"
                              : "var(--eh-text-muted)",
                        }}
                      >
                        {" — "}
                        {describeUnexplainedFile(f)}
                      </span>
                    </li>
                  ))}
                  {c.unexplained > c.files.length && (
                    <li style={{ listStyle: "none", opacity: 0.7 }}>
                      and {c.unexplained - c.files.length} more
                    </li>
                  )}
                </ul>
              )}

              {settledAs !== undefined && !changing.has(c.modId) ? (
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: "var(--eh-sp-2)",
                    flexWrap: "wrap",
                  }}
                >
                  <Pill intent="neutral">
                    ✓{" "}
                    {
                      describeChoice(settledAs, c.unexplained, countKinds(c.files))
                        .label
                    }
                  </Pill>
                  <span
                    style={{
                      color: "var(--eh-text-secondary)",
                      fontSize: "var(--eh-text-sm)",
                    }}
                  >
                    {answer !== undefined
                      ? applyMode === "this-build"
                        ? "Saved — applies to this build."
                        : "Saved — applies from your next build; the package you just built is unchanged."
                      : "Answered earlier, and these files have not changed since."}
                  </span>
                  <Button
                    size="sm"
                    intent="ghost"
                    disabled={busy !== undefined}
                    onClick={(): void =>
                      setChanging((prev) => new Set(prev).add(c.modId))
                    }
                  >
                    Change
                  </Button>
                </div>
              ) : (
                // Side by side, so the two answers read as alternatives to
                // weigh rather than a list to get through. They are not
                // interchangeable and the layout should not imply they are.
                <div
                  style={{
                    display: "grid",
                    gridTemplateColumns:
                      "repeat(auto-fit, minmax(260px, 1fr))",
                    gap: "var(--eh-sp-2)",
                  }}
                >
                  {(
                    [
                      "mirror",
                      "declare",
                      "bundle",
                      // Last: it is the only answer that does not ship the
                      // mod, so it does not belong among the three that do.
                      "drop",
                    ] as PostProcessingChoice[]
                  ).map((k) => {
                    const copy = describeChoice(k, c.unexplained, countKinds(c.files));
                    // Mirroring reconciles against per-file hashes, which a
                    // `fast` build never recorded. Showing it as pickable then
                    // would take an answer the build cannot honour.
                    const blocked = k === "mirror" && !c.canMirror;
                    return (
                      <div
                        key={k}
                        className="eh-stack eh-stack--xs"
                        style={{
                          padding: "var(--eh-sp-2)",
                          border: "1px solid var(--eh-border-subtle)",
                          borderRadius: "var(--eh-radius-sm)",
                        }}
                      >
                        <Button
                          intent={k === "mirror" ? "primary" : "ghost"}
                          disabled={busy !== undefined || blocked}
                          onClick={(): void => {
                            // Close the row again: a re-opened one must show
                            // its NEW verdict, not stay a set of buttons.
                            setChanging((prev) => {
                              const next = new Set(prev);
                              next.delete(c.modId);
                              return next;
                            });
                            onDecide(c, k);
                          }}
                        >
                          {busy === c.modId ? "Saving..." : copy.label}
                        </Button>
                        <span
                          className="eh-note"
                          style={{ color: "var(--eh-text-secondary)" }}
                        >
                          {blocked
                            ? "Needs a Thorough build — this one recorded file sizes only, so there is nothing to reconcile against."
                            : copy.consequence}
                        </span>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** "1608 files its archive cannot produce" — the fact, not a verdict. */
function describeUnreproducible(n: number): string {
  return `${n} file${n === 1 ? "" : "s"} its archive cannot produce`;
}

function BuildingPanel(props: {
  progress: BuildProgress;
  curator: CuratorInput;
  onCancel?: () => void;
}): JSX.Element {
  // The packaging phase runs through the ZIP writer which doesn't
  // support cancellation cleanly, so we only show the Cancel button
  // in early phases. Beyond `packaging` we hide it to avoid implying
  // we can rip a half-written file out from under the user.
  const cancellable =
    props.progress.phase !== "packaging" &&
    props.progress.phase !== "resolving-bundled-archives";

  return (
    <Card>
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap: "var(--eh-sp-4)",
          padding: "var(--eh-sp-5)",
        }}
      >
        <ProgressRing size={84} />
        <h3
          style={{
            margin: 0,
            color: "var(--eh-text-primary)",
            textAlign: "center",
          }}
        >
          Building {props.curator.name} v{props.curator.version}
        </h3>
        <p
          style={{
            margin: 0,
            color: "var(--eh-text-secondary)",
            fontSize: "var(--eh-text-sm)",
            textAlign: "center",
          }}
        >
          {props.progress.message ?? phaseToLabel(props.progress.phase)}
        </p>
        {props.onCancel !== undefined && cancellable && (
          <Button intent="ghost" size="sm" onClick={props.onCancel}>
            Cancel
          </Button>
        )}
        {props.onCancel !== undefined && !cancellable && (
          <p
            style={{
              margin: 0,
              color: "var(--eh-text-muted)",
              fontSize: "var(--eh-text-xs)",
            }}
          >
            Finishing up — please don't close Vortex.
          </p>
        )}
      </div>
    </Card>
  );
}

// ===========================================================================
// Done
// ===========================================================================

/**
 * Exported for the render harness only — nothing else imports it.
 *
 * This is the screen a curator reads after a 28-minute build, and the one that
 * carries every warning the pipeline produced. Reaching it through BuildWizard
 * would mean driving a whole build session into its terminal state; rendering
 * the panel directly with a real result is the same picture for none of that
 * machinery.
 */
export function DonePanel(props: {
  result: BuildPipelineResult;
  onBuildAnother: () => void;
  onGoHome: () => void;
  /**
   * Record one post-processing answer. Optional: the render harness and any
   * caller without a live session pass nothing, and the panel then shows the
   * finding without offering to act on it, which is still better than hiding
   * it.
   */
  onDecidePostProcessing?: (
    candidate: PostProcessingCandidate,
    choice: PostProcessingChoice,
  ) => Promise<void>;
}): JSX.Element {
  const { result } = props;
  const showToast = useToast();

  // Answered in THIS sitting. Not read back from the config, because the
  // config is not reloaded here and a decision that appeared to vanish would
  // read as a failed save.
  const [decided, setDecided] = React.useState<
    ReadonlyMap<string, PostProcessingChoice>
  >(new Map());
  const [decidingMod, setDecidingMod] = React.useState<string | undefined>();

  const handleDecide = React.useCallback(
    (candidate: PostProcessingCandidate, choice: PostProcessingChoice): void => {
      const record = props.onDecidePostProcessing;
      if (record === undefined) return;
      setDecidingMod(candidate.modId);
      void record(candidate, choice)
        .then(() => {
          setDecided((m) => new Map(m).set(candidate.modId, choice));
        })
        .catch((err: unknown) => {
          // Never silently: an answer the curator believes is saved and is not
          // is worse than one that visibly failed.
          showToast({
            intent: "danger",
            title: "Couldn't save that decision",
            message: err instanceof Error ? err.message : String(err),
            // Sticky: a decision the curator believes is saved and is not is
            // worse than one that visibly failed, and a 4-second toast on a
            // page they are reading carefully is a notice they will miss.
            ttl: 0,
          });
        })
        .finally(() => setDecidingMod(undefined));
    },
    [props, showToast],
  );

  const handleCopyHash = React.useCallback((): void => {
    void writeToClipboard(result.outputSha256).then((ok) => {
      showToast({
        intent: ok ? "success" : "warning",
        title: ok ? "Checksum copied" : "Couldn't copy checksum",
        message: ok
          ? "Publish it next to the package so people can check their copy."
          : "Clipboard isn't available right now.",
        ttl: 3500,
      });
    });
  }, [result.outputSha256, showToast]);

  const handleCopyPath = React.useCallback((): void => {
    void writeToClipboard(result.outputPath).then((ok) => {
      showToast({
        intent: ok ? "success" : "warning",
        title: ok ? "Path copied" : "Couldn't copy path",
        message: ok ? result.outputPath : "Clipboard isn't available right now.",
        ttl: 3500,
      });
    });
  }, [result.outputPath, showToast]);

  const handleShowInFolder = React.useCallback((): void => {
    void (async (): Promise<void> => {
      const outcome = await revealInFileManager({
        filePath: result.outputPath,
        folderPath: result.outputPath.replace(/[\\/][^\\/]+$/, ""),
      });
      if (outcome.kind === "failed") {
        showToast({
          intent: "warning",
          title: "Couldn't open the folder",
          message: result.outputPath,
          ttl: 6000,
        });
      }
    })();
  }, [result.outputPath, showToast]);

  return (
    <Card title="Build complete">
      <div
        className="eh-stack eh-stack--lg"
      >
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))",
            gap: "var(--eh-sp-3)",
          }}
        >
          <Stat label="Output size" value={formatBytes(result.outputBytes)} />
          <Stat label="Mods" value={String(result.modCount)} />
          <Stat label="Bundled archives" value={String(result.bundledCount)} />
          <Stat label="Warnings" value={String(result.warnings.length)} />
        </div>
        <BuildRulesScopeSummary result={result} />
        <div
          style={{
            padding: "var(--eh-sp-3)",
            background: "var(--eh-bg-base)",
            border: "1px solid var(--eh-border-subtle)",
            borderRadius: "var(--eh-radius-sm)",
            fontFamily: "var(--eh-font-mono)",
            color: "var(--eh-text-secondary)",
            fontSize: "var(--eh-text-xs)",
            wordBreak: "break-all",
          }}
        >
          {result.outputPath}
        </div>
        {/*
          The package's checksum, next to its path.

          Publish this wherever the collection is shared. When someone cannot
          open it, the first question is always whether their copy is intact,
          and until this existed the only way to answer it was for two people
          to run sha256sum by hand and read hex to each other over chat — which
          is exactly how an alpha tester's afternoon went.
        */}
        <div
          style={{
            display: "flex",
            alignItems: "baseline",
            gap: "var(--eh-sp-2)",
            padding: "var(--eh-sp-3)",
            background: "var(--eh-bg-base)",
            border: "1px solid var(--eh-border-subtle)",
            borderRadius: "var(--eh-radius-sm)",
            fontSize: "var(--eh-text-xs)",
            wordBreak: "break-all",
          }}
        >
          <span
            style={{
              color: "var(--eh-text-muted)",
              textTransform: "uppercase",
              letterSpacing: "var(--eh-tracking-widest)",
              flexShrink: 0,
            }}
          >
            sha256
          </span>
          <code
            style={{
              fontFamily: "var(--eh-font-mono)",
              color: "var(--eh-text-secondary)",
            }}
          >
            {result.outputSha256}
          </code>
          <Button intent="ghost" onClick={handleCopyHash}>
            Copy
          </Button>
        </div>
        <DistributionHint />
        {/*
          Above the warnings, not inside them. Everything in that list can be
          read and ignored; this is the only finding on the page that ships a
          broken collection if it is left alone.
        */}
        <PostProcessingDecisions
          candidates={result.postProcessingCandidates}
          decided={decided}
          busy={decidingMod}
          onDecide={handleDecide}
        />
        {/*
          OPEN by default. These are warnings about a package the curator is
          about to hand to strangers, and they were behind a disclosure that
          said only "10 warnings" — so the one reading "this mod is missing 7
          files its archive contains, worth opening before shipping" was one
          click away and indistinguishable from "4382 contested files
          recorded", which is pure bookkeeping.

          A curator who has read them can collapse the section; a curator who
          has not should not have to discover it exists. The install side
          already shows its notices this way.
        */}
        {result.warnings.length > 0 && (
          <details
            open
            style={{
              padding: "var(--eh-sp-3)",
              background: "rgba(255, 198, 99, 0.06)",
              border: "1px solid var(--eh-warning)",
              borderRadius: "var(--eh-radius-sm)",
              color: "var(--eh-warning)",
            }}
          >
            <summary style={{ cursor: "pointer" }}>
              {result.warnings.length} thing{result.warnings.length === 1 ? "" : "s"}{" "}
              worth reading before you share this
            </summary>
            <div className="eh-stack eh-stack--sm" style={{ marginTop: "var(--eh-sp-2)" }}>
              {/*
                Ordered by severity, not by which part of the pipeline happened
                to emit them. warningTone already classifies every line and the
                dot colour already shows it — but the list was in production
                order, so on the real build the one reading "is missing 7
                file(s) ... worth opening before shipping" sat EIGHTH, below
                four pieces of bookkeeping. Sorting costs nothing and puts what
                needs doing where it is read.

                Stable within a tone, so the pipeline's own ordering still
                decides ties and the list does not reshuffle between builds.
              */}
              {sortWarningsBySeverity(result.warnings).map((w, i) => (
                <WarningRow key={`${i}-${w.slice(0, 24)}`} text={w} />
              ))}
            </div>
          </details>
        )}
        <div
          style={{
            display: "flex",
            gap: "var(--eh-sp-2)",
            flexWrap: "wrap",
            justifyContent: "flex-end",
          }}
        >
          <Button intent="ghost" onClick={handleCopyPath}>
            Copy path
          </Button>
          {/* Was two buttons, "Open file" and "Open folder", both routed
              through a helper that ignored shell.openPath's returned error
              string — so a failure did nothing and said nothing. "Open file"
              could not have worked often anyway: .ehcoll has no handler
              registered on a normal machine, so the OS returns "no
              application associated" and that was the string being dropped.

              One action now, the one people actually want: show the package
              in the file manager with it highlighted, ready to attach or
              copy. It reports when it cannot. */}
          <Button intent="ghost" onClick={handleShowInFolder}>
            Show in folder
          </Button>
          <Button intent="ghost" onClick={props.onBuildAnother}>
            Build another
          </Button>
          <Button intent="primary" onClick={props.onGoHome}>
            Done
          </Button>
        </div>
      </div>
    </Card>
  );
}

// ===========================================================================
// Error
// ===========================================================================

function ErrorPanel(props: { onRetry: () => void }): JSX.Element {
  return (
    <Card>
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: "var(--eh-sp-3)",
          padding: "var(--eh-sp-3)",
        }}
      >
        <h3 style={{ margin: 0, color: "var(--eh-danger)" }}>
          Something went wrong
        </h3>
        <p
          className="eh-body"
        >
          A detailed error report should already be open. Once you're done
          reading it you can retry — Event Horizon will reload your active
          profile.
        </p>
        <div>
          <Button intent="primary" onClick={props.onRetry}>
            Retry
          </Button>
        </div>
      </div>
    </Card>
  );
}

// ===========================================================================
// Helpers
// ===========================================================================

function Field(props: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <label
      style={{
        display: "flex",
        flexDirection: "column",
        gap: "var(--eh-sp-1)",
      }}
    >
      <span
        style={{
          color: "var(--eh-text-secondary)",
          fontSize: "var(--eh-text-xs)",
          textTransform: "uppercase",
          letterSpacing: "var(--eh-tracking-widest)",
        }}
      >
        {props.label}
      </span>
      {props.children}
      {props.hint !== undefined && (
        <span
          style={{
            color: "var(--eh-text-muted)",
            fontSize: "var(--eh-text-xs)",
          }}
        >
          {props.hint}
        </span>
      )}
    </label>
  );
}

function Stat(props: { label: string; value: string }): JSX.Element {
  return (
    <div
      className="eh-inset"
    >
      <div
        className="eh-label"
      >
        {props.label}
      </div>
      <div
        style={{
          marginTop: "var(--eh-sp-1)",
          color: "var(--eh-text-primary)",
          fontWeight: 600,
        }}
      >
        {props.value}
      </div>
    </div>
  );
}

/**
 * Curator-side mirror of the install Done card's "Rules & ordering"
 * section. Reads the rule/loadOrder/userlist counts from the build
 * pipeline result so the curator gets immediate feedback that the
 * curator's mod rules + LOOT plugin rules + load order baselines
 * landed in the package — without this, the only way to know was
 * to install the .ehcoll on a fresh Vortex.
 *
 * Hidden when the curator authored none of these. A collection
 * with zero rules / zero load order / zero plugins (e.g. a tiny
 * texture pack) shouldn't get a noisy empty section.
 */
function BuildRulesScopeSummary(props: {
  result: BuildPipelineResult;
}): JSX.Element | null {
  const { result } = props;
  const total =
    result.ruleCount +
    result.loadOrderCount +
    result.pluginOrderCount +
    result.userlistPluginCount +
    result.userlistGroupCount +
    result.stagingFileCount;
  if (total === 0) return null;

  const integrityLabel =
    result.verificationLevel === "thorough"
      ? "thorough (sha256)"
      : result.verificationLevel === "fast"
        ? "fast (size only)"
        : "skipped";

  return (
    <div
      className="eh-stack eh-stack--sm"
    >
      <div
        className="eh-label"
      >
        Captured into the package
      </div>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
          gap: "var(--eh-sp-2)",
        }}
      >
        {result.ruleCount > 0 && (
          <Stat label="Mod rules" value={String(result.ruleCount)} />
        )}
        {result.loadOrderCount > 0 && (
          <Stat
            label="Load order entries"
            value={String(result.loadOrderCount)}
          />
        )}
        {result.pluginOrderCount > 0 && (
          <Stat label="Plugins" value={String(result.pluginOrderCount)} />
        )}
        {result.userlistPluginCount > 0 && (
          <Stat
            label="LOOT plugin rules"
            value={String(result.userlistPluginCount)}
          />
        )}
        {result.userlistGroupCount > 0 && (
          <Stat
            label="LOOT groups"
            value={String(result.userlistGroupCount)}
          />
        )}
        {result.stagingFileCount > 0 && (
          <Stat
            label={`Integrity (${integrityLabel})`}
            value={`${result.stagingFileCount.toLocaleString()} files`}
          />
        )}
      </div>
    </div>
  );
}


// writeToClipboard moved to ../../clipboard — the install page needs it for
// the curator report, and a second copy of a fallback chain is a second thing
// to keep in step.

/**
 * Tiny hint card that bridges "build finished" → "now what?". Until
 * we ship a one-click publish flow (see docs/RESEARCH_PUBLISHING.md),
 * curators distribute their `.ehcoll` by uploading it as a regular
 * Nexus mod attachment. Saying it explicitly here saves "where do I
 * upload this?" support requests.
 */
function DistributionHint(): JSX.Element {
  return (
    <div
      style={{
        padding: "var(--eh-sp-3) var(--eh-sp-4)",
        background:
          "color-mix(in srgb, var(--eh-accent) 8%, transparent)",
        border:
          "1px solid color-mix(in srgb, var(--eh-accent) 30%, transparent)",
        borderRadius: "var(--eh-radius-sm)",
        fontSize: "var(--eh-text-sm)",
        lineHeight: "var(--eh-leading-relaxed)",
        color: "var(--eh-text-secondary)",
      }}
    >
      <strong className="eh-strong">Next: share it.</strong>{" "}
      Upload this <code>.ehcoll</code> as a regular Nexus mod
      attachment under your collection&apos;s mod page — testers install it via
      Event Horizon&apos;s install tab. A one-click publish flow is
      tracked in <code>docs/RESEARCH_PUBLISHING.md</code>.
    </div>
  );
}

function phaseToLabel(phase: BuildProgress["phase"] | undefined): string | undefined {
  switch (phase) {
    case "hashing-mods":
      return "Hashing mod archives...";
    case "inspecting-mods":
      return "Inspecting mod folders for integrity capture...";
    case "capturing-deployment":
      return "Capturing deployment manifests...";
    case "capturing-load-order":
      return "Capturing load order...";
    case "capturing-userlist":
      return "Capturing LOOT userlist...";
    case "reading-plugins-txt":
      return "Reading plugins.txt...";
    case "writing-config":
      return "Saving collection config...";
    case "building-manifest":
      return "Building manifest...";
    case "resolving-bundled-archives":
      return "Resolving bundled archives...";
    case "packaging":
      return "Packaging .ehcoll...";
    default:
      return undefined;
  }
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

// ===========================================================================
// Draft-restored banner
// ===========================================================================

/**
 * Surfaces "we just rehydrated your in-flight build form" to the curator
 * the very first time they open the page after a reboot/remount/crash.
 *
 * Two affordances:
 *   • "Discard draft" — nukes the on-disk draft file and resets every
 *     editable field to the config defaults. Confirms via toast.
 *   • Close (×)        — hides the banner only. The restored values
 *     stay, and autosave keeps writing as the curator edits.
 *
 * The relative time is recomputed every 30s while mounted so a long
 * editing session shows accurate "Restored 12 minutes ago" → "13" etc.
 */
function DraftRestoredBanner(props: {
  savedAt: string;
  onDiscard: () => void;
  onDismiss: () => void;
}): JSX.Element {
  const [, forceTick] = React.useState(0);
  React.useEffect(() => {
    const handle = setInterval(() => {
      forceTick((t) => t + 1);
    }, 30_000);
    return () => clearInterval(handle);
  }, []);

  const relative = formatRelativeTime(props.savedAt);
  const absolute = (() => {
    try {
      return new Date(props.savedAt).toLocaleString();
    } catch {
      return props.savedAt;
    }
  })();

  return (
    <div
      role="status"
      style={{
        display: "flex",
        alignItems: "center",
        gap: "var(--eh-sp-3)",
        padding: "var(--eh-sp-3) var(--eh-sp-4)",
        border: "1px solid var(--eh-cyan)",
        background: "rgba(118, 228, 247, 0.08)",
        borderRadius: "var(--eh-radius-md)",
        color: "var(--eh-text-primary)",
      }}
    >
      <div
        aria-hidden="true"
        style={{
          width: 10,
          height: 10,
          borderRadius: 999,
          background: "var(--eh-cyan)",
          boxShadow: "0 0 8px var(--eh-cyan)",
          flexShrink: 0,
        }}
      />
      <div className="eh-fill">
        <div style={{ fontWeight: 600 }}>Draft restored</div>
        <div
          style={{
            color: "var(--eh-text-secondary)",
            fontSize: "var(--eh-text-sm)",
          }}
          title={absolute}
        >
          Picked up where you left off — autosaved {relative}.
        </div>
      </div>
      <Button intent="ghost" size="sm" onClick={props.onDiscard}>
        Discard draft
      </Button>
      <button
        type="button"
        aria-label="Dismiss"
        onClick={props.onDismiss}
        style={{
          background: "transparent",
          border: 0,
          color: "var(--eh-text-muted)",
          cursor: "pointer",
          fontSize: "var(--eh-text-lg)",
          padding: "0 var(--eh-sp-1)",
          lineHeight: 1,
        }}
      >
        ×
      </button>
    </div>
  );
}

/**
 * Relative-time formatter tuned for "just now → minutes ago →
 * hours ago → days ago". Falls back to the raw ISO string on parse
 * failure so we never show "NaN ago" garbage in the banner.
 */
function formatRelativeTime(iso: string): string {
  const parsed = Date.parse(iso);
  if (Number.isNaN(parsed)) return `at ${iso}`;
  const deltaMs = Date.now() - parsed;
  if (deltaMs < 30_000) return "just now";
  if (deltaMs < 60_000) return `${Math.round(deltaMs / 1000)}s ago`;
  if (deltaMs < 60 * 60_000) {
    const m = Math.round(deltaMs / 60_000);
    return `${m} minute${m === 1 ? "" : "s"} ago`;
  }
  if (deltaMs < 24 * 60 * 60_000) {
    const h = Math.round(deltaMs / (60 * 60_000));
    return `${h} hour${h === 1 ? "" : "s"} ago`;
  }
  const d = Math.round(deltaMs / (24 * 60 * 60_000));
  return `${d} day${d === 1 ? "" : "s"} ago`;
}
