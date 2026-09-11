/**
 * InstallPage — root component for the install wizard route.
 *
 * Pure view layer over {@link InstallSession}. The session is a
 * module-scope singleton so the wizard's state, hashing pipeline, and
 * (most importantly) the in-flight install driver survive sidebar tab
 * switches. Mount = subscribe. Unmount = unsubscribe. Nothing else.
 *
 * Lifecycle:
 *   • On mount we read the snapshot synchronously and re-subscribe.
 *     If a load was running while the user was on another tab, we
 *     pick right back up at the live phase / hash count.
 *   • Errors and "install finished" events surface via state
 *     transitions — we de-dupe report-once side effects using the
 *     session's `errorSeq` and the result's identity.
 *   • This component owns ZERO async work. Anything that takes more
 *     than one frame belongs in the session.
 */

import * as React from "react";

import { Button, Card } from "../../components";
import { ErrorBoundary, useErrorReporterFormatted } from "../../errors";
import { buildErrorReport } from "../../errors/formatError";
import { useApi } from "../../state";
import { useToast } from "../../components";
import { ConcurrentOpBanner } from "../../runtime/ConcurrentOpBanner";
import { nativeNotify } from "../../runtime/nativeNotify";
import { switchToProfile } from "../../../core/installer/profile";
import {
  ConfirmStep,
  DecisionsStep,
  DoneStep,
  InstallingStep,
  LinkFetchingStep,
  LinkManualStep,
  LoadingStep,
  PickStep,
  PreviewStep,
  StaleReceiptStep,
} from "./steps";
import {
  getInstallSession,
  type InstallSessionSnapshot,
} from "./installSession";
import type { WizardAction, WizardState } from "./state";
import type { EventHorizonRoute } from "../../routes";

export interface InstallPageProps {
  onNavigate: (route: EventHorizonRoute) => void;
}

export function InstallPage(props: InstallPageProps): JSX.Element {
  const reportFormatted = useErrorReporterFormatted();
  return (
    <ErrorBoundary
      where="InstallPage"
      variant="page"
      onReport={reportFormatted}
    >
      <InstallWizard onNavigate={props.onNavigate} />
    </ErrorBoundary>
  );
}

function InstallWizard(props: InstallPageProps): JSX.Element {
  const api = useApi();
  const reportFormatted = useErrorReporterFormatted();
  const showToast = useToast();
  const session = React.useMemo(() => getInstallSession(), []);

  const [snapshot, setSnapshot] = React.useState<InstallSessionSnapshot>(() =>
    session.getSnapshot(),
  );
  React.useEffect(() => {
    setSnapshot(session.getSnapshot());
    return session.subscribe(setSnapshot);
  }, [session]);

  const state = snapshot.state;

  // ── One-shot side effects on transitions ─────────────────────────
  //
  // Two flags keep us from re-firing toasts / modals when the
  // component remounts into an already-completed or already-errored
  // session: `lastErrorSeqRef` (one report per fresh errorSeq) and
  // `lastDoneIdRef` (one toast per fresh `done` state's bundle).

  const lastErrorSeqRef = React.useRef<number>(0);
  React.useEffect(() => {
    if (state.kind !== "error") return;
    if (snapshot.errorSeq === lastErrorSeqRef.current) return;
    lastErrorSeqRef.current = snapshot.errorSeq;
    reportFormatted(state.error);
  }, [state, snapshot.errorSeq, reportFormatted]);

  const lastDoneRef = React.useRef<string | undefined>(undefined);
  React.useEffect(() => {
    if (state.kind !== "done") return;
    const result = state.result;
    const pkg = state.bundle.plan.manifest.package;
    const key = `${pkg.id}@${result.kind}`;
    if (lastDoneRef.current === key) return;
    lastDoneRef.current = key;

    if (result.kind === "success") {
      // Skipped mods are non-fatal but worth surfacing — the user
      // came back to a "done" page they may not have been watching,
      // and seeing "12 of 13 installed" inline beats them later
      // wondering why the count is off.
      if (result.skippedMods.length > 0) {
        showToast({
          intent: "warning",
          title: "Install finished with skipped mods",
          message: `${result.skippedMods.length} mod(s) were skipped — check the report.`,
          ttl: 8000,
        });
        nativeNotify({
          title: "Event Horizon · install finished with skipped mods",
          body: `${pkg.name} — ${result.skippedMods.length} skipped`,
          tag: `eh-install-${pkg.id}`,
        });
      } else {
        showToast({
          intent: "success",
          title: "Install complete",
          message: `${pkg.name} is ready in your collection.`,
          ttl: 6000,
        });
        nativeNotify({
          title: "Event Horizon · install complete",
          body: `${pkg.name} is ready to play.`,
          tag: `eh-install-${pkg.id}`,
        });
      }
    } else if (result.kind === "aborted") {
      showToast({
        intent: "info",
        title: "Install aborted",
        message: `Stopped at ${result.phase}: ${result.reason}`,
        ttl: 6000,
      });
    } else if (result.kind === "failed") {
      // Failures get surfaced via the error modal, but if the user
      // had Alt-tabbed away during a long install they might miss
      // it — ping the OS notification centre too.
      nativeNotify({
        title: "Event Horizon · install failed",
        body: `${pkg.name} stopped at ${result.phase}.`,
        tag: `eh-install-${pkg.id}`,
        even_when_focused: false,
      });
    }
  }, [state, showToast]);

  // ── Bridge: keep DecisionsStep's dispatch contract intact ────────
  //
  // DecisionsStep was written against React.useReducer's `dispatch`.
  // Rather than pin a refactor of the steps file to this PR, we
  // bridge the action shape onto session methods. New action types
  // added later that need wiring will surface as a TS error here.
  const dispatch = React.useCallback(
    (action: WizardAction): void => {
      switch (action.type) {
        case "set-conflict-choice":
          session.setConflictChoice(action.compareKey, action.choice);
          return;
        case "set-orphan-choice":
          session.setOrphanChoice(action.modId, action.choice);
          return;
        case "back-to-preview":
          session.backToPreview();
          return;
        case "reset":
          session.reset();
          return;
        default:
          // Other action types are dispatched directly by the session
          // via its public methods; we don't expect DecisionsStep to
          // emit them. Silently ignore so a future step extension
          // doesn't crash the page.
          return;
      }
    },
    [session],
  );

  // ── Render ───────────────────────────────────────────────────────
  switch (state.kind) {
    case "pick":
      return (
        <>
          <ConcurrentOpBanner self="install" />
          <PickStep
            onPick={(zipPath): void => session.pickFile(api, zipPath)}
            onLink={(input): void => session.installFromLink(api, input)}
          />
        </>
      );

    case "link-fetching":
      return (
        <LinkFetchingStep
          state={state}
          onCancel={(): void => session.cancelLink()}
        />
      );

    case "link-manual":
      return (
        <LinkManualStep
          state={state}
          onPickDownloaded={(): void => session.pickDownloadedFile(api)}
          onBack={(): void => session.reset()}
        />
      );

    case "loading":
      return (
        <LoadingStep
          phase={state.phase}
          hashCount={state.hashCount}
          hashDone={state.hashDone}
          hashCurrent={state.hashCurrent}
          onCancel={(): void => session.cancelLoading()}
        />
      );

    case "stale-receipt":
      return (
        <StaleReceiptStep
          state={state}
          onResolved={(resolution): void => {
            session.resolveStaleReceipt(api, resolution);
          }}
        />
      );

    case "preview":
      return (
        <PreviewStep
          bundle={state.bundle}
          onContinue={(): void => session.openDecisionsFromPreview()}
          onCancel={(): void => session.reset()}
        />
      );

    case "decisions":
      return (
        <DecisionsStep
          state={state}
          dispatch={dispatch}
          onContinue={(): void => session.openConfirm()}
        />
      );

    case "confirm":
      return (
        <ConfirmStep
          state={state}
          onInstall={(): void => session.startInstall(api)}
          onBack={(): void => session.backFromConfirm()}
          onSetFomodMode={(mode): void => session.setFomodReplayMode(mode)}
        />
      );

    case "installing":
      return (
        <InstallingStep
          state={state}
          onCancel={(): void => session.cancelInstall()}
          cancelPending={session.isCancelPending()}
        />
      );

    case "done":
      return (
        <DoneStep
          result={state.result}
          bundle={state.bundle}
          onStartOver={(): void => session.finish()}
          /**
           * Re-run the SAME package. Not "start over": the partial receipt
           * this run just wrote means the resolver recognises everything that
           * did install, so the second pass only does what failed — minutes
           * instead of the hour the first run took.
           *
           * Goes back through the loading pipeline rather than calling
           * `startInstall` directly, because that only runs from the confirm
           * state and would be a dead button here.
           */
          onRetryFailed={(): void =>
            session.pickFile(api, state.bundle.zipPath)
          }
          onGoCollections={(): void => props.onNavigate("collections")}
          onSwitchProfile={(profileId, profileName): void => {
            // Fire-and-forget: profile activation is async (Vortex
            // purges deployment, switches, redeploys) but the user
            // doesn't need to wait inside our UI. We toast on
            // success/failure so the action isn't silent.
            void switchToProfile(api, profileId).then(
              () => {
                showToast({
                  intent: "success",
                  title: "Profile switched",
                  message: `${profileName} is now active.`,
                  ttl: 4000,
                });
              },
              (err: unknown) => {
                showToast({
                  intent: "warning",
                  title: "Profile switch failed",
                  message:
                    err instanceof Error
                      ? err.message
                      : "Vortex didn't acknowledge the switch in time.",
                  ttl: 7000,
                });
              },
            );
          }}
        />
      );

    case "error":
      return (
        <ErrorRetry
          state={state}
          onRetry={(): void => session.reset()}
        />
      );

    default: {
      const exhaustive: never = state;
      void exhaustive;
      return <PickStep onPick={(): void => undefined} />;
    }
  }
}

// ===========================================================================
// Error-recovery view
// ===========================================================================

function ErrorRetry(props: {
  state: Extract<WizardState, { kind: "error" }>;
  onRetry: () => void;
}): JSX.Element {
  const showToast = useToast();
  const [copied, setCopied] = React.useState(false);

  const handleCopy = React.useCallback((): void => {
    const text = buildErrorReport(props.state.error);
    void copyTextToClipboard(text).then(
      () => {
        setCopied(true);
        showToast({
          intent: "success",
          message: "Error report copied to clipboard.",
        });
        window.setTimeout(() => setCopied(false), 2000);
      },
      () => {
        showToast({
          intent: "warning",
          message: "Couldn't copy to clipboard.",
        });
      },
    );
  }, [props.state.error, showToast]);

  return (
    <div className="eh-page" key="error">
      <Card title={props.state.error.title}>
        <div className="eh-stack eh-stack--lg">
          <div className="eh-stack">
            <p className="eh-body">{props.state.error.message}</p>
            <p className="eh-small">
              The full report is open in the error panel — copy or save it before retrying.
            </p>
          </div>
          <div className="eh-row">
            <Button intent="primary" onClick={props.onRetry}>
              Start over
            </Button>
            <Button intent="ghost" onClick={handleCopy}>
              {copied ? "Copied!" : "Copy report"}
            </Button>
          </div>
        </div>
      </Card>
    </div>
  );
}

async function copyTextToClipboard(text: string): Promise<void> {
  if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const electron = require("electron") as {
      clipboard?: { writeText?: (s: string) => void };
    };
    if (electron.clipboard?.writeText) {
      electron.clipboard.writeText(text);
      return;
    }
  } catch {
    /* fall through */
  }
  throw new Error("No clipboard API available");
}
