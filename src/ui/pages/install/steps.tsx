/**
 * Step components for the install wizard. Each step is a pure
 * presentational React component — it receives state slice + a
 * dispatch and renders accordingly. All async work is owned by the
 * InstallPage orchestrator.
 *
 * Steps in document order:
 *
 *   1. PickStep            — large drop / pick CTA
 *   2. LoadingStep         — phase-aware skeleton with progress ring
 *   3. StaleReceiptStep    — three-button resolution prompt
 *   4. PreviewStep         — plan summary + verdict + Install button
 *   5. DecisionsStep       — per-conflict + per-orphan picker grid
 *   6. ConfirmStep         — final review before driver runs
 *   7. InstallingStep      — live phase + per-step progress
 *   8. DoneStep            — success / aborted / failed report
 *
 * Each step renders itself inside an `eh-page` wrapper so the
 * entrance animation plays on every step transition.
 */

import * as React from "react";
import { EnvironmentCard, summarizeEnvironment } from "./EnvironmentCard";
import { PlayGameCard } from "../../play/PlayGameButton";
import { util } from "@nexusmods/vortex-api";

import {
  Button,
  Callout,
  Card,
  ChoiceCard,
  EventHorizonMark,
  HashingCard,
  Modal,
  Notice,
  Page,
  Pill,
  ProgressRing,
  Section,
  StatGrid,
  StatTile,
  StepDots,
} from "../../components";
import { useApi, useApiOptional } from "../../state";
import { useToast } from "../../components";
import { useKeyboardShortcut } from "../../hooks/useKeyboardShortcut";
import { formatBytes } from "../../../utils/diskSpace";
import { openExternalUrl, revealInFileManager } from "../../../core/revealPath";
import { writeToClipboard } from "../../clipboard";
import { describeDownload } from "./downloadGuidance";
import {
  describeElapsed,
  describeQuiet,
  estimateRemainingMs,
  formatDuration,
  trackPhase,
} from "./installProgress";
import type { PhaseTiming } from "./installProgress";
import {
  countNexusDownloads,
  describeNexusAccount,
  readNexusAccount,
} from "../../../core/installer/checkNexusAccount";
import type { NexusAccount } from "../../../core/installer/checkNexusAccount";
import { describeRuntimeFindings } from "../../../core/runtime/detectRuntimes";
import {
  ConflictChoice,
  DriverProgress,
  InstallResult,
  OrphanChoice,
} from "../../../types/installDriver";
import {
  InstallPlan,
  ModResolution,
  OrphanedModDecision,
} from "../../../types/installPlan";
import { deleteReceipt } from "../../../core/installLedger";
import { pickModArchiveFile } from "../../../utils/utils";
import { useErrorReporter } from "../../errors";
import { getVortexUserDataPath } from "../../../core/paths";
import {
  LoadingPhase,
  PreviewBundle,
  WizardAction,
  WizardState,
  buildUserConfirmedDecisions,
  canProceedFromDecisions,
  countUndecidedConflicts,
  defaultConflictChoice,
  defaultOrphanChoice,
  fillDefaultConflictChoices,
  fillDefaultOrphanChoices,
  selectConflictResolutions,
} from "./state";
import { choicesFor } from "../../../core/installer/installerChoices";
import type { FomodReplayMode } from "../../../core/installer/fomodReplayMode";
import {
  describeFomodModes,
  mustAskReplayMode,
} from "../../../core/installer/fomodReplayMode";

// ===========================================================================
// Common building blocks
// ===========================================================================

/**
 * The wizard step indicator we show at the top of every step (except
 * the very first pick screen). 7 dots = 6 transitions; the active one
 * expands into a pill with the current step's label.
 */
const STEP_LABELS: Array<{ kind: WizardState["kind"]; label: string }> = [
  { kind: "pick", label: "Pick" },
  { kind: "loading", label: "Loading" },
  { kind: "preview", label: "Preview" },
  { kind: "decisions", label: "Decisions" },
  { kind: "confirm", label: "Confirm" },
  { kind: "installing", label: "Install" },
  { kind: "done", label: "Done" },
];

function Stepper(props: { current: WizardState["kind"] }): JSX.Element {
  const visibleStates: Array<WizardState["kind"]> = [
    "pick",
    "loading",
    "preview",
    "decisions",
    "confirm",
    "installing",
    "done",
  ];
  const idx = visibleStates.indexOf(props.current);
  // map stale-receipt and error to the closest visible step
  const safeIdx =
    idx >= 0
      ? idx
      : props.current === "stale-receipt"
        ? 1
        : 0;
  return (
    <>
      <StepDots total={visibleStates.length} current={safeIdx} />
      <span className="eh-label">
        Step {safeIdx + 1} / {visibleStates.length}
        {STEP_LABELS[safeIdx]?.label
          ? ` · ${STEP_LABELS[safeIdx]?.label}`
          : ""}
      </span>
    </>
  );
}

function StepFrame(props: {
  current: WizardState["kind"];
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  showStepper?: boolean;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <Page
      key={props.current}
      eyebrow={props.showStepper !== false ? <Stepper current={props.current} /> : undefined}
      title={props.title}
      subtitle={props.subtitle}
    >
      {props.children}
    </Page>
  );
}

// ===========================================================================
// 1. PickStep
// ===========================================================================

export interface PickStepProps {
  onPick: (zipPath: string) => void;
}

export function PickStep(props: PickStepProps): JSX.Element {
  const reportError = useErrorReporter();
  const showToast = useToast();
  const api = useApi();
  const [isDragging, setDragging] = React.useState(false);
  // Track nested dragenter/dragleave: child elements fire leave when
  // we cross internal boundaries, which would clear the highlight
  // even though the cursor is still over the drop zone.
  const dragDepthRef = React.useRef(0);

  const handlePick = React.useCallback(async (): Promise<void> => {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { pickEhcollFile } = await import("../../../utils/utils");
      const file = await pickEhcollFile(api);
      if (file !== undefined) {
        props.onPick(file);
      }
    } catch (err) {
      reportError(err, {
        title: "Couldn't open file picker",
        context: { step: "pick" },
      });
    }
  }, [props, reportError]);

  const handleDragEnter = React.useCallback((e: React.DragEvent): void => {
    e.preventDefault();
    e.stopPropagation();
    dragDepthRef.current += 1;
    if (dragDepthRef.current === 1) setDragging(true);
  }, []);

  const handleDragLeave = React.useCallback((e: React.DragEvent): void => {
    e.preventDefault();
    e.stopPropagation();
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
    if (dragDepthRef.current === 0) setDragging(false);
  }, []);

  const handleDragOver = React.useCallback((e: React.DragEvent): void => {
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = "copy";
  }, []);

  const handleDrop = React.useCallback(
    (e: React.DragEvent): void => {
      e.preventDefault();
      e.stopPropagation();
      dragDepthRef.current = 0;
      setDragging(false);

      const files = e.dataTransfer.files;
      if (files.length === 0) return;
      if (files.length > 1) {
        showToast({
          intent: "warning",
          message: "Drop only one .ehcoll file at a time.",
        });
        return;
      }
      // Electron exposes the absolute path on File. In a normal
      // browser this is empty for security; we tell the user to
      // browse instead.
      const dropped = files[0] as File & { path?: string };
      const filePath = dropped.path ?? "";
      if (filePath.length === 0) {
        showToast({
          intent: "warning",
          message:
            "Couldn't read the dropped file path. Use the Browse button instead.",
        });
        return;
      }
      if (!filePath.toLowerCase().endsWith(".ehcoll")) {
        showToast({
          intent: "warning",
          message: "That's not a .ehcoll file. Drop an Event Horizon collection.",
        });
        return;
      }
      props.onPick(filePath);
    },
    [props, showToast],
  );

  return (
    <StepFrame
      current="pick"
      showStepper={false}
      title="Install a collection"
      subtitle="Pick a .ehcoll archive and Event Horizon walks you through every mod, conflict, and decision before touching your profile."
    >
      <div
        onDragEnter={handleDragEnter}
        onDragLeave={handleDragLeave}
        onDragOver={handleDragOver}
        onDrop={handleDrop}
        className={isDragging ? "eh-dropzone eh-dropzone--active" : "eh-dropzone"}
      >
        <EventHorizonMark size={120} />
        <div>
          <h3 className="eh-dropzone__title">Drop a .ehcoll file or click to browse</h3>
          <p className="eh-dropzone__hint">
            Event Horizon never modifies your current profile until you click Install on the final review screen.
          </p>
        </div>
        <Button
          intent="primary"
          size="lg"
          onClick={(): void => {
            void handlePick();
          }}
        >
          Choose .ehcoll file...
        </Button>
      </div>
    </StepFrame>
  );
}

// ===========================================================================
// 2. LoadingStep
// ===========================================================================

const LOADING_PHASE_LABELS: Record<LoadingPhase, string> = {
  "reading-package": "Reading the .ehcoll archive",
  "reading-receipt": "Looking up previous installs",
  "checking-game": "Checking the active game profile",
  "hashing-mods": "Hashing your installed mods",
  "hashing-staging": "Verifying installed mod contents",
  "scanning-downloads": "Checking which archives you already have",
  "resolving-plan": "Resolving the install plan",
  "checking-environment": "Checking the game setup and game folder",
};

export function LoadingStep(props: {
  phase: LoadingPhase;
  hashCount?: number;
  hashDone?: number;
  hashCurrent?: string;
  onCancel?: () => void;
}): JSX.Element {
  const phaseIdx =
    Object.keys(LOADING_PHASE_LABELS).indexOf(props.phase);
  const totalPhases = Object.keys(LOADING_PHASE_LABELS).length;
  const ratio = totalPhases > 0 ? (phaseIdx + 1) / totalPhases : 0;

  // Specialised UI for the hashing pass: live counter + scanner +
  // cancel button. Hashing is read-only so cancellation is always
  // safe — see `core/archiveHashing.ts`.
  const isHashing =
    props.phase === "hashing-mods" ||
    props.phase === "hashing-staging" ||
    props.phase === "scanning-downloads";
  const total = props.hashCount ?? 0;

  return (
    <StepFrame
      current="loading"
      title="Working on it..."
      subtitle="Event Horizon needs to inspect the archive, your installed mods, and any previous install of this collection before it can show you a plan."
    >
      {isHashing && total > 0 ? (
        <HashingCard
          title="Hashing your installed mods"
          subtitle="Computing SHA-256 of every archive — this is read-only and safe to cancel."
          done={props.hashDone ?? 0}
          total={total}
          currentItem={props.hashCurrent}
          onCancel={props.onCancel}
        />
      ) : (
        <div className="eh-progress-panel">
          <ProgressRing value={ratio} size={88} />
          <div className="eh-fill eh-stack eh-stack--xs">
            <strong className="eh-progress-panel__title">
              {LOADING_PHASE_LABELS[props.phase]}
            </strong>
            <p className="eh-body">
              Hold tight — this can take a moment for large mod lists.
            </p>
          </div>
          {props.onCancel !== undefined && (
            <Button intent="ghost" size="sm" onClick={props.onCancel}>
              Cancel
            </Button>
          )}
        </div>
      )}
    </StepFrame>
  );
}

// ===========================================================================
// 3. StaleReceiptStep
// ===========================================================================

export interface StaleReceiptStepProps {
  state: Extract<WizardState, { kind: "stale-receipt" }>;
  onResolved: (
    resolution: "delete" | "keep" | "cancel",
  ) => void;
}

export function StaleReceiptStep(
  props: StaleReceiptStepProps,
): JSX.Element {
  const { state, onResolved } = props;
  const api = useApi();
  const reportError = useErrorReporter();
  const [busy, setBusy] = React.useState(false);

  // Esc → "Go back" (least destructive). We deliberately do NOT bind
  // Enter here: there are three roughly-equivalent choices and silent
  // confirmation of any one of them could wipe the receipt by accident.
  useKeyboardShortcut("Escape", () => {
    if (!busy) onResolved("cancel");
  });

  const handleDelete = async (): Promise<void> => {
    setBusy(true);
    try {
      const appData = getVortexUserDataPath();
      await deleteReceipt(appData, state.receipt.packageId);
      onResolved("delete");
    } catch (err) {
      reportError(err, {
        title: "Couldn't delete the stale receipt",
        context: {
          step: "stale-receipt",
          packageId: state.receipt.packageId,
        },
      });
      onResolved("cancel");
    } finally {
      setBusy(false);
    }
  };

  void api;

  return (
    <StepFrame
      current="stale-receipt"
      title="This collection was installed here before"
      subtitle="Event Horizon kept a record of the last install, but the Vortex profile it pointed to is gone. Pick how to handle it before continuing."
    >
      <Card
        title={`${state.receipt.packageName} v${state.receipt.packageVersion}`}
        footer={`Receipt last updated ${formatTime(state.receipt.installedAt)}`}
      >
        <div className="eh-stack eh-body">
          <div>
            <strong>Was installed into:</strong>{" "}
            {state.receipt.vortexProfileName}{" "}
            <span className="eh-muted">
              (deleted — id {state.receipt.vortexProfileId})
            </span>
          </div>
          <div>
            <strong>Mods recorded in receipt:</strong>{" "}
            {state.receipt.mods.length}
          </div>

          <details className="eh-details eh-inset">
            <summary className="eh-strong">What is a stale receipt?</summary>
            <p className="eh-details__body eh-body">
              When a collection is installed, Event Horizon writes a small
              JSON file remembering which mods went where, so a re-install
              can skip them. If the Vortex profile is later deleted (or
              you moved your config), that receipt is left dangling and
              points nowhere.
            </p>
          </details>

          <Callout tone="info" icon={null}>
            <strong>Recommended:</strong>{" "}
            <em>Start fresh</em> — Event Horizon deletes the dead receipt
            and treats this like a brand-new install (a new profile, full
            install plan, full safety guarantees).
          </Callout>
        </div>
        <div className="eh-actions">
          <Button
            intent="primary"
            disabled={busy}
            onClick={(): void => {
              void handleDelete();
            }}
            title="Delete the dead receipt and install into a new profile (recommended)"
          >
            Start fresh
          </Button>
          <Button
            intent="ghost"
            disabled={busy}
            onClick={(): void => onResolved("keep")}
            title="Keep the receipt as-is and try to install into your currently-active Vortex profile"
          >
            Install into current profile
          </Button>
          <Button
            intent="ghost"
            disabled={busy}
            onClick={(): void => onResolved("cancel")}
            title="Go back and pick a different file"
          >
            Go back
          </Button>
        </div>
      </Card>
    </StepFrame>
  );
}

// ===========================================================================
// 4. PreviewStep
// ===========================================================================

export interface PreviewStepProps {
  bundle: PreviewBundle;
  onContinue: () => void;
  onCancel: () => void;
}

export function PreviewStep(props: PreviewStepProps): JSX.Element {
  const { bundle, onContinue, onCancel } = props;
  const { plan } = bundle;
  const target = plan.installTarget;
  const summary = plan.summary;

  // Whether this account can actually download what the plan needs. Read
  // here rather than in the resolver because it is a property of the person
  // installing, not of the collection: the same plan is fine for one account
  // and hundreds of manual clicks for another.
  //
  // Outside a Vortex tree there is no api and therefore no answer, which is
  // the same "unknown" the reader gets from an unfamiliar state shape, and
  // warns about nothing either way.
  const api = useApiOptional();
  const account: NexusAccount = React.useMemo(
    () =>
      api === undefined
        ? { kind: "unknown", why: "not running inside Vortex" }
        : readNexusAccount(api),
    [api],
  );
  const accountLines = React.useMemo(
    () => describeNexusAccount(account, countNexusDownloads(plan)),
    [account, plan],
  );

  /**
   * Missing system runtimes, said BEFORE the install rather than discovered
   * after it. Nothing about a missing VC++ redistributable stops a mod
   * installing — it stops xEdit, ENB and the script-extender plugins working
   * afterwards, with no message that names the cause, which is the worst
   * possible moment to find out.
   */
  const runtimeLines = React.useMemo(
    () => describeRuntimeFindings(bundle.runtimeFindings ?? []) ?? [],
    [bundle.runtimeFindings],
  );

  /**
   * The environment preflight. A blocked check (game not managed, never
   * started, wrong-store DLL, Program Files) makes this uninstallable; a
   * warning (dirty game folder, unverifiable folder) is said here and acted on
   * when Install is clicked.
   */
  const environment = React.useMemo(
    () => summarizeEnvironment(bundle.environment),
    [bundle.environment],
  );

  const verdict = computeVerdict(
    plan,
    [...accountLines, ...runtimeLines, ...environment.warnings],
    environment.blockers,
  );

  // Enter = continue to decisions/review. Esc = bail. Off when focus
  // is inside an input (there are no inputs on this screen yet, but
  // the hook's guard makes that future-proof).
  // Enter is Continue, so it obeys the same verdict the disabled button does.
  useKeyboardShortcut("Enter", () => {
    if (verdict.canProceed) onContinue();
  });
  useKeyboardShortcut("Escape", onCancel);

  return (
    <StepFrame
      current="preview"
      title={`${plan.manifest.package.name} v${plan.manifest.package.version}`}
      subtitle={
        plan.manifest.package.description ??
        "Review the plan Event Horizon would execute. Nothing has been changed yet."
      }
    >
      {/* The verdict LEADS.
          It used to sit at the bottom, under six numbers and two cards: a
          reader had to scroll past everything to learn whether this could be
          installed at all. That is the one question this screen exists to
          answer, so it goes first, and the colour carries it before the words
          are read. "Verdict" as a card title said nothing the headline does
          not say better. */}
      <div className="eh-stack eh-stack--xl">
      <Callout tone={verdict.tone} role="status" title={verdict.headline}>
        <div className="eh-stack eh-stack--sm">
          {verdict.lines.length > 0 ? (
            <ul className="eh-list">
              {verdict.lines.map((line, idx) => (
                <li key={idx} className="eh-secondary">
                  {line}
                </li>
              ))}
            </ul>
          ) : null}
          <span className="eh-note">
            Checked against your active game install. Nothing has been changed yet.
          </span>
        </div>
      </Callout>

      {/* Two groups, not six equal numbers.
          The first three describe what happens if you do nothing but press
          continue; the last three are the ones that will ask something of you
          or cannot be done at all. Undifferentiated, a reader gets six figures
          and no sense of which need them — and the zeroes are worth keeping,
          because "Missing: 0" says the check ran. */}
      <Section title="What this collection is">
        <StatGrid min={200}>
          <StatTile size="lg" label="Total mods" value={summary.totalMods} />
          <StatTile size="lg" label="Already installed" value={summary.alreadyInstalled} />
          <StatTile size="lg" label="Will install silently" value={summary.willInstallSilently} />
        </StatGrid>
      </Section>

      {plan.manifest.mods.some((m) => m.attributes?.curatorNote !== undefined) && (
        <Section
          title="From the curator"
          count={plan.manifest.mods.filter((m) => m.attributes?.curatorNote !== undefined).length}
          countIntent="neutral"
          description="Notes the curator wrote on specific mods for the people installing this collection."
        >
          <ul className="eh-list eh-stack eh-stack--xs">
            {plan.manifest.mods
              .filter((m) => m.attributes?.curatorNote !== undefined)
              .map((m) => (
                <li key={m.compareKey}>
                  <span className="eh-strong">{m.name}</span>
                  <span className="eh-secondary"> — {m.attributes!.curatorNote}</span>
                </li>
              ))}
          </ul>
        </Section>
      )}

      <Section title="What needs you">
        <StatGrid min={200}>
          <StatTile
            size="lg"
            label="Need confirmation"
            value={summary.needsUserConfirmation}
            tone={summary.needsUserConfirmation > 0 ? "warning" : "neutral"}
          />
          <StatTile
            size="lg"
            label="Missing"
            value={summary.missing}
            tone={summary.missing > 0 ? "danger" : "neutral"}
          />
          <StatTile
            size="lg"
            label="Orphans"
            value={summary.orphans}
            tone={summary.orphans > 0 ? "warning" : "neutral"}
          />
        </StatGrid>
      </Section>

      <EnvironmentCard report={bundle.environment} />

      <RulesScopePreview summary={summary} />

      <Card title="Install target">
        {target.kind === "fresh-profile" ? (
          <div className="eh-stack eh-stack--sm">
            <div>
              <Pill intent="info" withDot>
                Fresh profile
              </Pill>
            </div>
            <p className="eh-body">
              {target.resumeProfileId !== undefined ? (
                <>
                  {/* A resume continues a profile. Promising a new one here —
                      and naming the profile that will NOT be used — reproduced
                      the "which profile am I in?" confusion this whole change
                      exists to end, in the screen the user actually reads. */}
                  Continuing the profile your interrupted install was filling:{" "}
                  <strong className="eh-strong">
                    {target.resumeProfileName ?? target.resumeProfileId}
                  </strong>
                  . The mods earlier attempts installed are already there. Your
                  other profiles are not modified.
                </>
              ) : (
                <>
                  A new Vortex profile (suggested name{" "}
                  <strong className="eh-strong">
                    {target.suggestedProfileName}
                  </strong>
                  ) will be created. Your current profile is not modified — you
                  can switch back at any time from Vortex's profile selector.
                </>
              )}
            </p>
          </div>
        ) : (
          <div className="eh-stack eh-stack--sm">
            <div>
              <Pill intent="warning" withDot>
                Current profile
              </Pill>
            </div>
            <p className="eh-body">
              The collection will install on top of{" "}
              <strong className="eh-strong">
                {target.profileName}
              </strong>
              . Conflicts and orphans you choose to apply WILL modify your
              setup. You'll see a final summary before any changes are made.
            </p>
          </div>
        )}
      </Card>
      </div>

      <div className="eh-actions">
        <Button intent="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button
          intent="primary"
          onClick={onContinue}
          disabled={!verdict.canProceed}
        >
          Continue →
        </Button>
      </div>
    </StepFrame>
  );
}

/**
 * Preview-time scope tiles for slice 6c + 6d curator content. The
 * top SummaryTile row covers mods only; without this section the
 * user has no way to know that a "small" 12-mod collection might
 * actually ship 200 plugin entries and 80 LOOT rules. Hidden
 * entirely when the curator authored none of these — collections
 * built before slice 6d landed (or that genuinely have no rules)
 * shouldn't gain a noisy empty section.
 */
function RulesScopePreview(props: {
  summary: InstallPlan["summary"];
}): JSX.Element | null {
  const { summary } = props;
  const total =
    summary.ruleCount +
    summary.loadOrderCount +
    summary.pluginOrderCount +
    summary.userlistPluginCount +
    summary.userlistGroupCount;
  if (total === 0) return null;

  return (
    <Section title="Rules & ordering this collection ships">
      <StatGrid min={180}>
        {summary.ruleCount > 0 && (
          <StatTile size="lg" label="Mod rules" value={summary.ruleCount} />
        )}
        {summary.loadOrderCount > 0 && (
          <StatTile size="lg" label="Load order entries" value={summary.loadOrderCount} />
        )}
        {summary.pluginOrderCount > 0 && (
          <StatTile size="lg" label="Plugins" value={summary.pluginOrderCount} />
        )}
        {summary.userlistPluginCount > 0 && (
          <StatTile size="lg" label="LOOT plugin rules" value={summary.userlistPluginCount} />
        )}
        {summary.userlistGroupCount > 0 && (
          <StatTile size="lg" label="LOOT groups" value={summary.userlistGroupCount} />
        )}
      </StatGrid>
      <p className="eh-note eh-prose">
        {/*
          This used to end "Pre-existing rules unrelated to this collection are
          left alone", which stopped being true the day the rule purge landed:
          the collection's rules REPLACE yours, and because Vortex stores mod
          rules on the mod and the LOOT userlist per game — neither per profile
          — that reaches rules for mods outside this collection and for your
          other profiles too. Saying otherwise on the screen shown before the
          user commits is the worst place in the app to be out of date.
        */}
        This collection&apos;s mod rules and LOOT plugin rules become the ONLY
        ones for this game, so what loads is exactly what the curator tested.
        Your existing rules — including any for mods outside this collection,
        and for your other profiles of this game — are cleared first. They are
        saved to a backup file, and the install tells you where.
      </p>
    </Section>
  );
}

/**
 * `accountLines` describes anything about the user's Nexus account that will
 * make this install harder than the plan implies — see checkNexusAccount.
 *
 * It never sets `canProceed: false`, even for a logged-out account that
 * genuinely cannot download. Blocking would rest the whole screen on one
 * inferred state path, and a wrong block leaves the user with no way forward
 * and no explanation; a wrong warning merely wastes a paragraph. The install
 * driver still fails loudly if it turns out to be right.
 */
export function computeVerdict(
  plan: InstallPlan,
  accountLines: readonly string[] = [],
  /** Blocked environment checks, by title. Any one makes the plan uninstallable. */
  environmentBlockers: readonly string[] = [],
): {
  headline: string;
  lines: string[];
  /** The CSS colour, kept for callers that read it; `tone` is what renders. */
  color: string;
  tone: "danger" | "warning" | "success";
  canProceed: boolean;
} {
  const lines: string[] = [];
  const compat = plan.compatibility;
  const blockers: string[] = [];

  for (const r of plan.modResolutions) {
    if (
      r.decision.kind === "nexus-unreachable" ||
      r.decision.kind === "external-missing"
    ) {
      blockers.push(`${r.name} (${r.decision.kind})`);
    }
  }

  if (!plan.summary.canProceed || blockers.length > 0 || environmentBlockers.length > 0) {
    for (const b of environmentBlockers) lines.push(b);
    if (compat.errors.length > 0) {
      for (const e of compat.errors) lines.push(e);
    }
    if (blockers.length > 0) {
      lines.push(
        `${blockers.length} mod${blockers.length === 1 ? " is" : "s are"} structurally unfixable from your side: ` +
          blockers.slice(0, 3).join(", ") +
          (blockers.length > 3 ? ", ..." : ""),
      );
    }
    if (lines.length === 0) {
      lines.push(
        "The plan reports it cannot proceed. See compatibility errors.",
      );
    }
    return {
      headline: "Cannot install",
      lines,
      color: "var(--eh-danger)",
      tone: "danger",
      canProceed: false,
    };
  }

  for (const w of compat.warnings) lines.push(w);
  for (const a of accountLines) lines.push(a);
  if (plan.summary.needsUserConfirmation > 0) {
    lines.push(
      `${plan.summary.needsUserConfirmation} mod${plan.summary.needsUserConfirmation === 1 ? "" : "s"} need your input to resolve`,
    );
  }
  if (plan.summary.orphans > 0) {
    lines.push(
      `${plan.summary.orphans} orphan${plan.summary.orphans === 1 ? "" : "s"} from a previous release will need a decision`,
    );
  }
  if (lines.length === 0) {
    lines.push(
      "All mods resolve cleanly — no conflicts, no orphans, no missing files.",
    );
  }

  // An account that cannot download counts as needing attention. Saying
  // "Plan resolves cleanly" in green above a paragraph explaining that six
  // hundred mods must be fetched by hand would be the headline contradicting
  // the thing it is summarising.
  const needsAttention =
    plan.summary.needsUserConfirmation > 0 ||
    plan.summary.orphans > 0 ||
    accountLines.length > 0;

  return {
    headline: needsAttention
      ? "Plan resolves — needs your input"
      : "Plan resolves cleanly",
    lines,
    color: needsAttention ? "var(--eh-warning)" : "var(--eh-success)",
    tone: needsAttention ? "warning" : "success",
    canProceed: true,
  };
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString();
}

// ===========================================================================
// 5. DecisionsStep — conflict + orphan picker grid
// ===========================================================================

export interface DecisionsStepProps {
  state: Extract<WizardState, { kind: "decisions" }>;
  dispatch: React.Dispatch<WizardAction>;
  onContinue: () => void;
}

export function DecisionsStep(props: DecisionsStepProps): JSX.Element {
  const { state, dispatch, onContinue } = props;
  const conflicts = selectConflictResolutions(state.bundle);
  const orphans = state.bundle.plan.orphanedMods;
  const canProceed = canProceedFromDecisions(
    state.bundle,
    state.conflictChoices,
  );
  const undecided = countUndecidedConflicts(
    state.bundle,
    state.conflictChoices,
  );

  return (
    <StepFrame
      current="decisions"
      title="Resolve conflicts and orphans"
      subtitle="For each item below, choose what Event Horizon should do. Defaults are conservative — keep your current setup unless you actively want to replace it."
    >
      {conflicts.length === 0 && orphans.length === 0 && (
        <Card title="Nothing to resolve">
          <p
            className="eh-body"
          >
            The plan resolved cleanly. Click Continue to review the install
            target one last time.
          </p>
        </Card>
      )}

      {conflicts.length > 0 && (
        <Section
          count={conflicts.length}
          title="Mod conflicts"
          description="The collection's version differs from what's installed on your machine."
        >
          {/*
            How far through they are. A real plan puts 27 near-identical cards
            on this page, each about a mod the user has never heard of, and the
            only feedback for answering one was that its radio filled in. With
            no denominator visible while scrolling, there is no way to tell
            whether you are nearly done or have twenty to go — and the
            Continue button silently stays disabled until the last one.
          */}
          {conflicts.length > 1 && (
            <p className="eh-note" role="status">
              {(() => {
                const decided = conflicts.filter(
                  (r) =>
                    (state.conflictChoices[r.compareKey] ??
                      defaultConflictChoice(r)) !== undefined,
                ).length;
                return decided >= conflicts.length
                  ? `All ${conflicts.length} answered.`
                  : `${decided} of ${conflicts.length} answered — the rest need a choice before you can continue.`;
              })()}
            </p>
          )}
          <div
            className="eh-stack"
          >
            {conflicts.map((r) => (
              <ConflictRow
                key={r.compareKey}
                resolution={r}
                value={
                  state.conflictChoices[r.compareKey] ??
                  defaultConflictChoice(r)
                }
                onChange={(choice): void =>
                  dispatch({
                    type: "set-conflict-choice",
                    compareKey: r.compareKey,
                    choice,
                  })
                }
              />
            ))}
          </div>
        </Section>
      )}

      {orphans.length > 0 && (
        <Section
          count={orphans.length}
          title="Orphaned mods"
          description="These were installed by a previous release of this collection but are no longer referenced."
        >
          <div
            className="eh-stack"
          >
            {orphans.map((o) => (
              <OrphanRow
                key={o.existingModId}
                orphan={o}
                value={
                  state.orphanChoices[o.existingModId] ?? defaultOrphanChoice()
                }
                onChange={(choice): void =>
                  dispatch({
                    type: "set-orphan-choice",
                    modId: o.existingModId,
                    choice,
                  })
                }
              />
            ))}
          </div>
        </Section>
      )}

      {/* Sticky: with 27 cards above it, the button a user is looking for
          should not be a page-length scroll away. */}
      <div className="eh-actions eh-actions--sticky">
        <Button
          intent="ghost"
          onClick={(): void => dispatch({ type: "back-to-preview" })}
        >
          ← Back
        </Button>
        {/* The reason used to live in a `title` on the DISABLED button, which
            browsers frequently do not render at all — so someone stuck here
            had no way to learn why. Said out loud, and counted. */}
        {!canProceed && (
          <span className="eh-note" role="status">
            {undecided} {undecided === 1 ? "mod" : "mods"} above still need a
            choice before you can continue.
          </span>
        )}
        <Button intent="primary" disabled={!canProceed} onClick={onContinue}>
          Continue →
        </Button>
      </div>
    </StepFrame>
  );
}

/**
 * How to fetch a mod Event Horizon cannot fetch: the link, what kind of link
 * it is, and what to do once the file is on disk.
 *
 * Renders even with no URL, because the mod is still installable by hand and
 * the last step — pick the file, we take it from there — is the same either
 * way. A block that vanished when the link was missing would leave the
 * "Pick a local file" radio with no explanation of where the file comes from.
 */
function ExternalDownloadGuide(props: {
  url?: string;
  mode?: "direct" | "browse" | "manual";
  expectedFilename?: string;
}): JSX.Element {
  // Whether the last attempt to open the link actually reached a browser.
  //
  // On Windows `shell.openExternal` hands off to the shell; under Wine it goes
  // through winebrowser to the host, which USUALLY works and is not something
  // this code can verify from inside the prefix. So the outcome is surfaced
  // rather than assumed: if nothing opened, the user is told, and the full URL
  // is already on screen beside the button for them to copy. Discarding the
  // result would leave someone clicking a button that does nothing, with no
  // way to tell that from a slow browser.
  const [openFailed, setOpenFailed] = React.useState(false);
  const guide = describeDownload({
    ...(props.url !== undefined ? { url: props.url } : {}),
    ...(props.mode !== undefined ? { mode: props.mode } : {}),
    ...(props.expectedFilename !== undefined
      ? { expectedFilename: props.expectedFilename }
      : {}),
  });

  return (
    <div className="eh-stack eh-stack--sm eh-inset">
      {guide.canOpen && props.url !== undefined && (
        <div className="eh-row">
          <span className="eh-mono eh-fill">{props.url}</span>
          <Button
            intent="ghost"
            onClick={(): void => {
              void (async (): Promise<void> => {
                const outcome = await openExternalUrl(props.url as string);
                setOpenFailed(outcome.kind === "failed");
              })();
            }}
          >
            {guide.action}
          </Button>
        </div>
      )}
      {openFailed && (
        <Callout tone="warning" role="alert">
          Nothing opened — your system may not have a browser Vortex can reach.
          Copy the link above into your own browser.
        </Callout>
      )}
      <ol className="eh-list eh-note">
        {guide.steps.map((step, i) => (
          <li key={i}>{step}</li>
        ))}
      </ol>
    </div>
  );
}

function ConflictRow(props: {
  resolution: ModResolution;
  value: ConflictChoice | undefined;
  onChange: (choice: ConflictChoice) => void;
}): JSX.Element {
  const { resolution, value, onChange } = props;
  const decision = resolution.decision;
  const reportError = useErrorReporter();
  const showToast = useToast();
  // Vortex's own picker, not Electron's — see pickModArchiveFile.
  const api = useApi();

  const handlePickFile = async (): Promise<void> => {
    if (decision.kind !== "external-prompt-user") return;
    try {
      const file = await pickModArchiveFile({
        api,
        title: `Select archive for "${resolution.name}"`,
        expectedFilename: decision.expectedFilename,
      });
      if (file !== undefined) {
        onChange({ kind: "use-local-file", localPath: file });
        showToast({
          intent: "success",
          message: `Linked archive for ${resolution.name}.`,
        });
      }
    } catch (err) {
      reportError(err, {
        title: "Couldn't open file picker",
        context: { step: "decisions", mod: resolution.name },
      });
    }
  };

  return (
    <Card
      compact
      headingLevel={4}
      titleSize="sm"
      title={resolution.name}
      subtitle={<span className="eh-mono eh-muted">{resolution.compareKey}</span>}
      actions={<Pill intent="warning">{decisionLabel(decision.kind)}</Pill>}
    >
      <div className="eh-stack">
      <p className="eh-body">{describeConflict(resolution)}</p>

      {/* Get it yourself, in your own browser.
          Vortex answers a browse-website dependency with an embedded browser;
          this deliberately does not. That window is signed out of everything,
          has no password manager, no ad-blocker and no download manager, and
          handles a Cloudflare check badly — the one flow where someone most
          needs their own environment gets the worst version of it.

          The URL is shown in FULL rather than hidden behind the button: it
          came out of a manifest someone else authored, and the person about
          to click should see where they are being sent. openExternalUrl
          refuses anything that is not http(s) regardless. */}
      {decision.kind === "external-prompt-user" && (
        <ExternalDownloadGuide
          url={decision.url}
          mode={decision.downloadMode}
          expectedFilename={decision.expectedFilename}
        />
      )}

      {decision.kind === "external-prompt-user" ? (
        <div className="eh-stack eh-stack--sm" role="radiogroup" aria-label={`What to do about ${resolution.name}`}>
          <ChoiceCard
            name={`conflict:${resolution.compareKey}`}
            checked={value?.kind === "use-local-file"}
            onChange={(): void => {
              void handlePickFile();
            }}
            label="Pick a local file..."
            sub={
              value?.kind === "use-local-file"
                ? `Picked: ${value.localPath}`
                : `Expected filename: ${decision.expectedFilename}`
            }
          />
          <ChoiceCard
            name={`conflict:${resolution.compareKey}`}
            checked={value?.kind === "skip"}
            onChange={(): void => onChange({ kind: "skip" })}
            label="Skip this mod"
            sub="The collection will be installed without this mod."
          />
        </div>
      ) : (
        <div className="eh-stack eh-stack--sm" role="radiogroup" aria-label={`What to do about ${resolution.name}`}>
          <ChoiceCard
            name={`conflict:${resolution.compareKey}`}
            checked={value?.kind === "keep-existing"}
            onChange={(): void => onChange({ kind: "keep-existing" })}
            label="Keep your installed version"
            sub="Safe default — your file stays untouched and is enabled in the install profile."
          />
          <ChoiceCard
            name={`conflict:${resolution.compareKey}`}
            checked={value?.kind === "replace-existing"}
            onChange={(): void => onChange({ kind: "replace-existing" })}
            label="Replace with the collection's version"
            sub="Your installed version will be uninstalled, then the collection's archive is downloaded/installed."
          />
        </div>
      )}
      </div>
    </Card>
  );
}

function OrphanRow(props: {
  orphan: OrphanedModDecision;
  value: OrphanChoice;
  onChange: (choice: OrphanChoice) => void;
}): JSX.Element {
  const { orphan, value, onChange } = props;
  return (
    <Card
      compact
      headingLevel={4}
      titleSize="sm"
      title={orphan.name}
      subtitle={<span className="eh-mono eh-muted">installed by v{orphan.installedFromVersion}</span>}
      actions={<Pill intent="warning">orphaned</Pill>}
    >
      <div className="eh-stack eh-stack--sm" role="radiogroup" aria-label={`What to do about ${orphan.name}`}>
        <ChoiceCard
          name={`orphan:${orphan.existingModId}`}
          checked={value.kind === "keep"}
          onChange={(): void => onChange({ kind: "keep" })}
          label="Keep installed"
          sub="Leave the mod alone — useful if you want it independently of the collection."
        />
        <ChoiceCard
          name={`orphan:${orphan.existingModId}`}
          checked={value.kind === "uninstall"}
          onChange={(): void => onChange({ kind: "uninstall" })}
          label="Uninstall it"
          sub="Removes the mod entirely (file system + Vortex state). Destructive."
        />
      </div>
    </Card>
  );
}


function decisionLabel(kind: ModResolution["decision"]["kind"]): string {
  switch (kind) {
    case "nexus-version-diverged":
      return "version diverged";
    case "nexus-bytes-diverged":
      return "bytes diverged";
    case "external-bytes-diverged":
      return "bytes diverged";
    case "external-prompt-user":
      return "needs file";
    default:
      return kind;
  }
}

function describeConflict(resolution: ModResolution): string {
  const d = resolution.decision;
  switch (d.kind) {
    case "nexus-version-diverged":
      return `You have file id ${d.existingFileId} installed; the collection wants file id ${d.requiredFileId}.`;
    case "nexus-bytes-diverged":
      return "Nexus IDs match but the bytes differ. Either Nexus silently re-uploaded the file or your local archive is corrupt.";
    case "external-bytes-diverged":
      return "An external mod with this identity is installed locally but its archive bytes differ from what the collection bundled.";
    case "external-prompt-user":
      return `This mod is not bundled and not in your downloads. Pick a local archive matching "${d.expectedFilename}", or skip the mod.`;
    default:
      return "";
  }
}

// ===========================================================================
// 6. ConfirmStep
// ===========================================================================

export interface ConfirmStepProps {
  state: Extract<WizardState, { kind: "confirm" }>;
  onInstall: () => void;
  onBack: () => void;
  onSetFomodMode?: (mode: FomodReplayMode) => void;
  /**
   * Render-harness only: start with the replay-mode modal open.
   *
   * The modal is the only place this question is asked, and a static render
   * shows the closed state — so without this the copy that matters most is the
   * copy nobody ever looks at.
   */
  __openModalForRender?: boolean;
}

/** Below this many free bytes on the install drive we surface a
 * pre-flight warning. 5 GB is conservative — most casual collections
 * stage 1–2 GB, but a single high-poly mesh pack can blow past 4. */
const DISK_SPACE_WARN_THRESHOLD = 5 * 1024 * 1024 * 1024;

/**
 * The one warning shape this step uses, defined once.
 *
 * Both banners here had the same eleven inline properties copied out, down to
 * a hardcoded rgba(255, 177, 92, 0.08) that existed nowhere else in the app.
 */


/**
 * How the curator's FOMOD answers get replayed — asked once, as the last act
 * before the driver starts.
 *
 * ─── WHY A MODAL, AND WHY IT HAS NO DEFAULT BUTTON ─────────────────────
 * This began as an inline radio group on the confirm screen with "silent"
 * preselected. That is offering, not asking: the recommended answer was
 * already filled in, so the whole question — including the part about the
 * Doctor undoing a deliberate change — could be scrolled past unread by
 * someone clicking Install. Which is most people.
 *
 * So the two modes are the two BUTTONS, and there is no third button that
 * proceeds without choosing. You cannot start this install without saying
 * which one you want. Cancel returns to the review screen; it does not pick
 * for you.
 *
 * One modal for the whole collection, not one per mod: the answer applies to
 * every installer in the run and is held for its duration.
 *
 * Esc and backdrop-click are disabled deliberately. Both would dismiss the
 * question, and the only sane reading of a dismissal is "do not install" —
 * which is what Cancel already says, in a word the user chose rather than a
 * gesture they may have made by accident.
 */
function FomodModeModal(props: {
  open: boolean;
  answerable: number;
  unanswered: number;
  onCancel: () => void;
  /** The chosen mode AND the go-ahead: this starts the install. */
  onChoose: (mode: FomodReplayMode) => void;
  installCount: number;
}): JSX.Element {
  const options = describeFomodModes(props.answerable, props.unanswered);

  return (
    <Modal
      open={props.open}
      onClose={props.onCancel}
      // xl + a two-up grid so BOTH options are on screen at once. Stacked,
      // they overflowed a normal Vortex window and put "Show me each
      // installer" — the option carrying the warning — below the fold behind a
      // scrollbar. An option you have to go looking for is not a choice being
      // offered, and it is the wrong one to hide.
      size="xl"
      closeOnEsc={false}
      closeOnBackdropClick={false}
      hideCloseButton
      title="Some mods ask questions while they install"
      subtitle={
        <>
          The curator already answered them, and those answers are part of the
          collection. Choose how you want them applied — this covers all{" "}
          {props.installCount} mods.
        </>
      }
      footer={
        <Button intent="ghost" onClick={props.onCancel}>
          Cancel
        </Button>
      }
    >
      {/* Two-up so BOTH options are on screen at once; the cards stretch to
          one height so the buttons line up across columns. */}
      <div
        className="eh-grid eh-grid--tight"
        style={{ ["--eh-grid-min" as string]: "330px" } as React.CSSProperties}
      >
        {options.map((opt) => (
          <div key={opt.mode} className="eh-option-card">
            <span className="eh-row eh-row--sm">
              <strong className="eh-strong">{opt.title}</strong>
              {opt.recommended && <Pill intent="info">Recommended</Pill>}
            </span>

            <p className="eh-body">{opt.blurb}</p>

            <ul className="eh-list eh-muted">
              {opt.points.map((pt, i) => (
                <li key={i}>{pt}</li>
              ))}
            </ul>

            {/* Always shown, not only once selected: there is no selection
                here, and a warning that appears after you commit is not a
                warning. */}
            {opt.caution !== undefined && (
              <Callout tone="warning" role="silent">
                {opt.caution}
              </Callout>
            )}

            <div className="eh-option-card__cta">
              <Button
                intent={opt.recommended ? "primary" : "ghost"}
                fullWidth
                onClick={() => props.onChoose(opt.mode)}
              >
                {opt.mode === "silent"
                  ? "Install automatically"
                  : "Install, showing me each installer"}
              </Button>
            </div>
          </div>
        ))}
      </div>
    </Modal>
  );
}

export function ConfirmStep(props: ConfirmStepProps): JSX.Element {
  const { state, onInstall, onBack } = props;
  const { bundle, decisions } = state;
  const target = bundle.plan.installTarget;

  // TWO counts, because they behave differently and the difference is the
  // one thing silent replay cannot hide.
  //
  //   answerable — we have an answer to hand back; silent replay silences it.
  //   unanswered — the curator's install went through an installer but nothing
  //                was selected in any group. `choicesFor` returns undefined
  //                rather than invent an answer, so the mod takes Vortex's
  //                ordinary path — which is the path that OPENS the dialog.
  //
  // Measured 112 / 3 on the real collection. Collapsing them would either
  // promise three dialogs that do appear, or undercount the clicking.
  const fomodCounts = React.useMemo(() => {
    let answerable = 0;
    let unanswered = 0;
    for (const m of bundle.plan.manifest.mods) {
      if (choicesFor(m) !== undefined) answerable += 1;
      else if ((m.install?.fomodSelections ?? []).length > 0) unanswered += 1;
    }
    return { answerable, unanswered };
  }, [bundle.plan.manifest.mods]);

  // Only ask when the answer changes something. With nothing replayable the
  // mode is inert — any unanswered installers open either way — and a modal
  // that cannot affect the outcome is pure friction.
  const asksAboutInstallers =
    mustAskReplayMode(fomodCounts.answerable) &&
    props.onSetFomodMode !== undefined;
  const [askingMode, setAskingMode] = React.useState(
    props.__openModalForRender === true,
  );

  // Esc = back to decisions. Enter is deliberately NOT bound here.
  //
  // Every other step in this wizard advances on Enter, so binding it to the
  // install would make the last, irreversible action reachable by the same
  // reflex that got the user through the reversible ones. The screen says
  // "Last chance to review"; committing should take a click.
  useKeyboardShortcut("Escape", onBack);

  // Best-effort disk-space probe. We swallow probe errors and just
  // show nothing if the API is unavailable — never block install on
  // a flaky stat. Runs once on mount; recomputing per re-render is
  // pointless because the user can't free disk space without leaving
  // this screen.
  const [diskFreeBytes, setDiskFreeBytes] = React.useState<number | undefined>(
    undefined,
  );
  React.useEffect(() => {
    let cancelled = false;
    void (async (): Promise<void> => {
      try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { getFreeBytes } = await import("../../../utils/diskSpace");
        const probePath = util.getVortexPath("userData");
        const free = await getFreeBytes(probePath);
        if (!cancelled) setDiskFreeBytes(free);
      } catch {
        /* swallow — UI just won't render the banner */
      }
    })();
    return (): void => {
      cancelled = true;
    };
  }, []);

  const conflictCount = Object.keys(decisions.conflictChoices ?? {}).length;
  const orphanCount = Object.keys(decisions.orphanChoices ?? {}).length;

  const removalCount =
    Object.values(decisions.conflictChoices ?? {}).filter(
      (c) => c.kind === "replace-existing",
    ).length +
    Object.values(decisions.orphanChoices ?? {}).filter(
      (c) => c.kind === "uninstall",
    ).length;

  const isFresh = target.kind === "fresh-profile";

  const installCount =
    bundle.plan.summary.willInstallSilently +
    Object.values(decisions.conflictChoices ?? {}).filter(
      (c) => c.kind === "replace-existing" || c.kind === "use-local-file",
    ).length;

  return (
    <StepFrame
      current="confirm"
      title="Last chance to review"
      subtitle="Once you click Install, Event Horizon will start downloading, hardlinking, and deploying mods. Closing the page won't roll the changes back."
    >
      <div className="eh-stack">
      <Card
        title={`${bundle.plan.manifest.package.name} v${bundle.plan.manifest.package.version}`}
      >
        <div className="eh-stack">
        <ul className="eh-list">
          <li>
            <strong>Target:</strong>{" "}
            {isFresh
              ? target.resumeProfileId !== undefined
                ? // Last chance to review — so it has to name the profile the
                  // install will actually land in, not the one we would have
                  // created had this not been a resume.
                  `Resuming profile: ${target.resumeProfileName ?? target.resumeProfileId}`
                : `Fresh profile (suggested name: ${target.suggestedProfileName})`
              : `Current profile: ${target.profileName}`}
          </li>
          <li>
            <strong>Mods to install:</strong> {installCount}
          </li>
          <li>
            <strong>Conflict decisions:</strong> {conflictCount}
          </li>
          <li>
            <strong>Orphan decisions:</strong> {orphanCount}
          </li>
        </ul>

        {/* Removals used to be the fifth bullet in that list, sitting at the
            same weight as "Conflict decisions: 3". It is the only line here
            that describes something being destroyed, so it does not belong
            in a list of counts. When there is nothing to remove, saying so
            plainly is the reassurance this screen owes the reader. */}
        {/*
          "Nothing will be uninstalled" was the only claim this screen made
          about the user's existing setup, and it left the reader to conclude
          that nothing else of theirs changes. Since the rule purge that is no
          longer true: their conflict and LOOT rules are cleared for the whole
          game. It is reversible from the backup, but it is not nothing, and
          the last screen before an hour of work is where it has to be said.
        */}
        <p className="eh-note">
          Your own mod-conflict and LOOT rules for this game will be replaced
          by the collection&apos;s, so the load order matches what the curator
          tested. They are backed up to a file first, and the summary at the
          end tells you where.
        </p>

        {removalCount === 0 ? (
          <p className="eh-note">Nothing will be uninstalled.</p>
        ) : (
          <Callout tone="warning">
            <strong>
              {removalCount} mod{removalCount === 1 ? "" : "s"} will be
              uninstalled
              {isFresh ? "" : " from your current profile"}.
            </strong>{" "}
            This is what you asked for on the previous screen, but it is the
            part that cannot be undone by going back.
          </Callout>
        )}
        </div>
      </Card>

      {diskFreeBytes !== undefined &&
        diskFreeBytes < DISK_SPACE_WARN_THRESHOLD && (
          <Callout tone="warning" role="alert" title="Low disk space on Vortex's data drive.">
            Only {formatBytes(diskFreeBytes)} free where mods get staged.
            Large collections can easily download tens of gigabytes —
            installs may fail mid-way if the disk fills. Free up space
            before continuing if you&apos;re unsure.
          </Callout>
        )}
      </div>

      <div className="eh-actions">
        <Button intent="ghost" onClick={onBack}>
          ← Back
        </Button>
        <Button
          intent="primary"
          onClick={asksAboutInstallers ? () => setAskingMode(true) : onInstall}
        >
          Install {installCount} mod{installCount === 1 ? "" : "s"}
        </Button>
      </div>

      {asksAboutInstallers && (
        <FomodModeModal
          open={askingMode}
          answerable={fomodCounts.answerable}
          unanswered={fomodCounts.unanswered}
          installCount={installCount}
          onCancel={() => setAskingMode(false)}
          onChoose={(mode) => {
            // Order matters: the mode must be in `decisions` before the driver
            // reads it. The session dispatches synchronously, so by the time
            // onInstall runs the state already carries the choice.
            props.onSetFomodMode?.(mode);
            setAskingMode(false);
            onInstall();
          }}
        />
      )}
    </StepFrame>
  );
}

// ===========================================================================
// 7. InstallingStep
// ===========================================================================

const PHASE_LABELS: Record<DriverProgress["phase"], string> = {
  preflight: "Pre-flight checks",
  "creating-profile": "Creating fresh profile",
  "switching-profile": "Switching to install profile",
  "removing-mods": "Removing replaced + orphaned mods",
  "installing-mods": "Installing mods",
  "verifying-mods": "Verifying mod integrity",
  "applying-mod-rules": "Applying mod rules",
  "applying-userlist": "Applying LOOT plugin rules",
  mirroring: "Mirroring the curator's files",
  deploying: "Deploying",
  "applying-load-order": "Applying load order",
  "writing-receipt": "Writing receipt",
  complete: "Complete",
  aborted: "Aborted",
  failed: "Failed",
};

/**
 * The phases a run passes through, in order, minus the terminal ones.
 *
 * The wizard's step dots count SEVEN wizard steps, of which the whole install
 * is one — so during the hour that step takes they never move. This is the
 * map of what is actually happening, and its value is mostly in what it shows
 * is still to come: a user watching "Installing mods" for forty minutes cannot
 * otherwise tell whether verification, rules and deployment are minutes or
 * hours away.
 *
 * Phases are SKIPPED, not merely passed: a current-profile install creates no
 * profile, and a collection with no rules applies none. So this marks
 * everything before the current phase as done rather than tracking each one,
 * which would report a skipped phase as pending forever.
 */
/**
 * How many past activity lines to keep.
 *
 * Enough to see that something is moving and to recognise a repeat; short
 * enough that it stays a glance rather than becoming a log viewer, which is
 * what the log file is for.
 */
const ACTIVITY_TRAIL = 6;

/**
 * The directory holding a file, without importing node:path into the renderer.
 *
 * Both separators, because these paths come from Vortex and cross Wine, where
 * a Windows path can arrive with forward slashes.
 */
function parentDir(filePath: string): string {
  const cut = Math.max(filePath.lastIndexOf("\\"), filePath.lastIndexOf("/"));
  return cut > 0 ? filePath.slice(0, cut) : filePath;
}

const DRIVER_PHASE_ORDER: ReadonlyArray<DriverProgress["phase"]> = [
  "preflight",
  "creating-profile",
  "switching-profile",
  "removing-mods",
  "installing-mods",
  "verifying-mods",
  "applying-mod-rules",
  "applying-userlist",
  "mirroring",
  "deploying",
  "applying-load-order",
  "writing-receipt",
];

/** Short forms — the trail is a glance, not a second copy of the phase label. */
const PHASE_SHORT: Partial<Record<DriverProgress["phase"], string>> = {
  preflight: "Checks",
  "creating-profile": "Profile",
  "switching-profile": "Switch",
  "removing-mods": "Remove",
  "installing-mods": "Install",
  "verifying-mods": "Verify",
  "applying-mod-rules": "Rules",
  "applying-userlist": "LOOT",
  mirroring: "Mirror",
  deploying: "Deploy",
  "applying-load-order": "Order",
  "writing-receipt": "Receipt",
};

function PhaseTrail(props: {
  current: DriverProgress["phase"] | undefined;
}): JSX.Element | null {
  const idx =
    props.current === undefined
      ? -1
      : DRIVER_PHASE_ORDER.indexOf(props.current);
  if (idx < 0) return null;

  return (
    <ol aria-label="Install phases" className="eh-phase-trail">
      {DRIVER_PHASE_ORDER.map((phase, i) => {
        const done = i < idx;
        const active = i === idx;
        return (
          <li
            key={phase}
            aria-current={active ? "step" : undefined}
            className={
              active
                ? "eh-phase-trail__phase eh-phase-trail__phase--active"
                : done
                  ? "eh-phase-trail__phase eh-phase-trail__phase--done"
                  : "eh-phase-trail__phase"
            }
          >
            {done ? "✓ " : ""}
            {PHASE_SHORT[phase] ?? phase}
          </li>
        );
      })}
    </ol>
  );
}

export function InstallingStep(props: {
  state: Extract<WizardState, { kind: "installing" }>;
  /** Ask the driver to stop at its next checkpoint. */
  onCancel: () => void;
  /** A stop has been asked for and the driver has not reached a checkpoint. */
  cancelPending: boolean;
}): JSX.Element {
  const { progress, bundle, decisions } = props.state;

  // Stopping a run that has been going for two hours should not be one
  // stray click away, so the button asks first. It is not a destructive
  // confirm though — nothing is removed, and the copy says so, because a
  // scary dialog here would push people toward killing Vortex instead,
  // which is the genuinely unsafe option.
  const [confirmingStop, setConfirmingStop] = React.useState(false);

  // This screen is up for HOURS on a real collection, and the driver goes
  // quiet for minutes at a time during a large download. A clock that only
  // advanced on driver beats would freeze during exactly the silence the
  // reader needs explaining, so it ticks on its own.
  const [startedAtMs] = React.useState(() => Date.now());
  const [nowMs, setNowMs] = React.useState(() => Date.now());
  React.useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), 1000);
    return (): void => clearInterval(id);
  }, []);

  // Timing is kept per phase because the driver's step counters reset at every
  // transition — see installProgress.
  const [timing, setTiming] = React.useState<PhaseTiming | undefined>(
    undefined,
  );
  React.useEffect(() => {
    if (progress === undefined) return;
    setTiming((prev) => trackPhase(prev, progress, Date.now()));
  }, [progress]);

  // The last few things the driver said.
  //
  // One line of "what is happening now" is only useful while it changes. On a
  // 963-mod run it changes every few seconds for an hour and then stops, and
  // the single line cannot tell "finished that mod, starting the next" from
  // "stuck on this mod" — the reader has no memory of what it said before.
  // Keeping a short trail makes stalls self-evident: the same line at the top
  // of an unchanging list, for minutes.
  const [recent, setRecent] = React.useState<readonly string[]>([]);
  React.useEffect(() => {
    const line = progress?.message;
    if (line === undefined || line.length === 0) return;
    setRecent((prev) =>
      prev[0] === line ? prev : [line, ...prev].slice(0, ACTIVITY_TRAIL),
    );
  }, [progress?.message]);

  // How many mods carry the curator's installer answers.
  //
  // Whether Vortex STOPS for them is now the user's choice, made on the
  // confirm step — so this count alone no longer says what happens, and the
  // banner below has to read the mode too.
  //
  // Counted through `choicesFor` to match what actually gets replayed: a
  // recorded step the curator answered nothing in produces no dialog.
  const fomodCounts = React.useMemo(() => {
    let answerable = 0;
    let unanswered = 0;
    for (const m of bundle.plan.manifest.mods) {
      if (choicesFor(m) !== undefined) answerable += 1;
      else if ((m.install?.fomodSelections ?? []).length > 0) unanswered += 1;
    }
    return { answerable, unanswered };
  }, [bundle.plan.manifest.mods]);
  const { answerable, unanswered } = fomodCounts;
  const fomodCount = answerable + unanswered;
  const supervised = decisions.fomodReplayMode === "supervised";

  const phaseLabel =
    progress !== undefined ? PHASE_LABELS[progress.phase] : "Starting...";
  const ratio =
    progress !== undefined && progress.totalSteps > 0
      ? progress.currentStep / progress.totalSteps
      : undefined;

  const remainingMs =
    timing !== undefined && progress !== undefined
      ? estimateRemainingMs({
          timing,
          totalSteps: progress.totalSteps,
          nowMs,
        })
      : undefined;
  const quiet = timing !== undefined ? describeQuiet(timing, nowMs) : undefined;

  return (
    <StepFrame
      current="installing"
      title="Installing"
      subtitle={`${bundle.plan.manifest.package.name} v${bundle.plan.manifest.package.version} — keep this page open until the run finishes.`}
    >
      <div className="eh-stack">
      <div className="eh-progress-panel">
        <ProgressRing value={ratio} size={120} />
        <div className="eh-fill eh-stack eh-stack--xs">
          <strong className="eh-progress-panel__title">{phaseLabel}</strong>
          <p className="eh-body">
            {progress?.message ??
              "Driver is starting up — this usually takes a few seconds."}
          </p>
          {/* Elapsed is always true and always worth knowing; the estimate
              appears only once it is measured rather than guessed. */}
          <p className="eh-mono eh-muted">
            {describeElapsed(startedAtMs, nowMs)}
            {progress !== undefined && progress.totalSteps > 1
              ? ` · step ${progress.currentStep} / ${progress.totalSteps}`
              : ""}
            {remainingMs !== undefined
              ? ` · about ${formatDuration(remainingMs)} left`
              : ""}
          </p>
          <PhaseTrail current={progress?.phase} />
        </div>
      </div>

      {/* Said once, before it happens, and only while mods are being installed
          — by verification time the prompts are done and this would be noise.

          It has to follow the user's choice. Promising a dialog that never
          opens is not a harmless inaccuracy on this screen: it is the one
          screen where someone sits watching for exactly that, and it would
          teach them to read a working install as a stuck one — the precise
          failure the original banner was written to prevent, inverted. */}
      {fomodCount > 0 && progress?.phase === "installing-mods" && (
        <p className="eh-note eh-prose">
          {supervised ? (
            <>
              {fomodCount} of these mods have installer options. Vortex will
              open its own installer window for them with the curator&apos;s
              choices already selected —{" "}
              <strong>the run pauses until you confirm</strong>, so it is not
              stuck if it sits still with a dialog open.
            </>
          ) : unanswered > 0 ? (
            <>
              {answerable} of these mods have installer options that are
              answered for you automatically. {unanswered} other
              {unanswered === 1 ? " mod" : " mods"} recorded no usable answer,
              so <strong>Vortex will still ask you about those</strong> — if it
              sits still with a dialog open, it is waiting on you, not stuck.
            </>
          ) : (
            <>
              {answerable} of these mods have installer options. You chose to
              have the curator&apos;s answers applied automatically, so{" "}
              <strong>no installer windows will open</strong> — nothing here is
              waiting on you.
            </>
          )}
        </p>
      )}

      {recent.length > 1 && (
        <details className="eh-details">
          <summary>Recent activity</summary>
          {/* The newest line is the one the eye should land on (first-child
              is brighter); the rest are context and fade back. */}
          <ol className="eh-activity eh-details__body">
            {recent.map((line, i) => (
              <li key={`${i}-${line}`}>{line}</li>
            ))}
          </ol>
        </details>
      )}

      {quiet !== undefined && (
        <p className="eh-note" role="status">
          {quiet}
        </p>
      )}
      </div>

      {/* The stop control lives below the progress, away from the eye, and
          never becomes a primary action — the expected thing to do on this
          screen is wait. */}
      <div className="eh-actions">
        {props.cancelPending ? (
          <span className="eh-note" role="status">
            Stopping after the current mod finishes...
          </span>
        ) : confirmingStop ? (
          <>
            <span className="eh-note eh-fill">
              Stop after the current mod finishes? Mods already installed stay
              where they are — nothing is undone, and running this collection
              again picks up from where it stopped.
            </span>
            <Button intent="ghost" onClick={(): void => setConfirmingStop(false)}>
              Keep going
            </Button>
            <Button intent="danger" onClick={props.onCancel}>
              Stop install
            </Button>
          </>
        ) : (
          <Button intent="ghost" onClick={(): void => setConfirmingStop(true)}>
            Stop install
          </Button>
        )}
      </div>
    </StepFrame>
  );
}

// ===========================================================================
// 8. DoneStep
// ===========================================================================

export interface DoneStepProps {
  result: InstallResult;
  bundle: PreviewBundle;
  onStartOver: () => void;
  /**
   * Run the install again to pick up the mods that failed.
   *
   * Not the same button as "install another collection". A partial run now
   * writes a receipt carrying its failures, so a second run resolves every
   * mod that DID install as already-installed and only does the rest — which
   * is minutes rather than the hour the first run took, and is the only way
   * to finish a collection whose installer refused before the collection
   * existed.
   */
  onRetryFailed?: () => void;
  onGoCollections: () => void;
  /**
   * Optional. When provided AND the install succeeded, the success
   * card surfaces a "Switch to <profile>" button so the user lands
   * directly inside the profile their collection just installed
   * into. No-op for aborted/failed results.
   */
  onSwitchProfile?: (profileId: string, profileName: string) => void;
}

export function DoneStep(props: DoneStepProps): JSX.Element {
  const {
    result,
    bundle,
    onStartOver,
    onGoCollections,
    onSwitchProfile,
    onRetryFailed,
  } = props;

  let badge: JSX.Element;
  let headline: string;
  let body: React.ReactNode;
  let accent: "success" | "warning" | "danger";

  if (result.kind === "success") {
    /**
     * A run the user STOPPED after the deploy still returns `success`, and
     * correctly — the mods are installed and the receipt is written, which is
     * the whole reason the driver refuses to unwind past that point (NS-2).
     * But it did not do everything, and a green "Success" pill is a claim
     * that it did.
     *
     * `finishingSkippedNotice` is present only on that path, so it is also
     * the test for it.
     */
    const stoppedLate =
      result.finishingSkippedNotice !== undefined &&
      result.finishingSkippedNotice.length > 0;
    badge = stoppedLate ? (
      <Pill intent="warning" withDot>
        Stopped
      </Pill>
    ) : (
      <Pill intent="success" withDot>
        Success
      </Pill>
    );
    headline = stoppedLate
      ? `Installed ${bundle.plan.manifest.package.name} v${bundle.plan.manifest.package.version} — finishing steps skipped`
      : `Installed ${bundle.plan.manifest.package.name} v${bundle.plan.manifest.package.version}`;
    accent = stoppedLate ? "warning" : "success";
    body = (
      <SuccessBody
        result={result}
        bundle={bundle}
      />
    );
  } else if (result.kind === "aborted") {
    badge = <Pill intent="warning">Stopped</Pill>;
    headline = "Install stopped";
    accent = "warning";
    body = (
      <FailureBody
        phase={result.phase}
        partialProfileId={result.partialProfileId}
        message={result.reason}
        installedSoFar={result.installedSoFar.length}
        stopped
      />
    );
  } else {
    badge = (
      <Pill intent="danger" withDot>
        Failed
      </Pill>
    );
    headline = "Install failed";
    accent = "danger";
    body = (
      <FailureBody
        phase={result.phase}
        partialProfileId={result.partialProfileId}
        message={result.error}
        installedSoFar={result.installedSoFar.length}
        {...(result.rulesPurgeNotice !== undefined
          ? { rulesPurgeNotice: result.rulesPurgeNotice }
          : {})}
        {...(result.finishingSkippedNotice !== undefined
          ? { finishingSkippedNotice: result.finishingSkippedNotice }
          : {})}
        {...(result.pluginFlagNotice !== undefined
          ? { pluginFlagNotice: result.pluginFlagNotice }
          : {})}
        {...(result.mirrorNotice !== undefined
          ? { mirrorNotice: result.mirrorNotice }
          : {})}
        {...(result.damagedArchiveNotice !== undefined
          ? { damagedArchiveNotice: result.damagedArchiveNotice }
          : {})}
        {...(result.curatorReports !== undefined
          ? { curatorReports: result.curatorReports }
          : {})}
        {...(result.receiptPath !== undefined
          ? { receiptPath: result.receiptPath }
          : {})}
      />
    );
  }

  return (
    <StepFrame
      current="done"
      title={<span className={`eh-tone--${accent}`}>{headline}</span>}
      subtitle={badge}
    >
      <Card>{body}</Card>

      <div
        className="eh-actions"
      >
        {/*
          FIRST, and primary, because it is the only action that finishes what
          the user came here to do. Everything else on this row navigates away
          from an install that is not done.
        */}
        {result.kind === "failed" &&
          (result.failedMods?.length ?? 0) > 0 &&
          onRetryFailed !== undefined && (
            <Button
              intent="primary"
              onClick={onRetryFailed}
              title={
                `Run the install again. The ${result.installedSoFar?.length ?? 0} ` +
                `mod(s) already installed are recognised rather than ` +
                `re-downloaded, so this only does the ones that failed.`
              }
            >
              Retry {result.failedMods?.length ?? 0} failed mod
              {(result.failedMods?.length ?? 0) === 1 ? "" : "s"}
            </Button>
          )}
        <Button intent="ghost" onClick={onStartOver}>
          Install another collection
        </Button>
        {result.kind === "success" && onSwitchProfile !== undefined && (
          <Button
            intent="ghost"
            onClick={(): void =>
              onSwitchProfile(result.profileId, result.profileName)
            }
            title={`Activate the "${result.profileName}" profile in Vortex`}
          >
            Switch to {result.profileName}
          </Button>
        )}
        <Button intent="primary" onClick={onGoCollections}>
          View installed collections
        </Button>
      </div>
    </StepFrame>
  );
}

/**
 * What the collection changed in the user's game settings.
 *
 * Shown without being asked for. A configuration edited silently is not
 * acceptable even when it is correct, and this is the one moment the user is
 * actually looking — burying it in a receipt they will never open would be
 * the same as not telling them.
 *
 * The summary is the visible part; the per-key `before → after` list folds
 * away, because twelve of those is a wall and the fact that it happened is
 * what matters first.
 */
/**
 * Mods that installed as the wrong KIND.
 *
 * Above the settings notice and styled as a warning, because this one means
 * something is broken rather than something changed — and it is invisible
 * otherwise: every file is present, every hash matches, and the game just
 * does not load the mod.
 */
/**
 * The shared head of every post-install notice: a labelled pill and the
 * summary line, in an inset card.
 *
 * The BODIES stay separate on purpose. Game settings folds behind a
 * disclosure because it can list hundreds of INI keys; the others are a
 * handful of lines and folding them would hide the whole message behind a
 * click. Same head, different body, because the difference is real.
 */

/**
 * How many detail lines a notice shows before it folds them away.
 *
 * Three is what fits beside a summary without the card becoming a wall. Above
 * that the summary alone carries the meaning — "12 mods changed since we
 * installed them" — and the list is reference material the user opens when
 * they want the names.
 */
const INLINE_LINE_LIMIT = 3;

/**
 * Lines under a notice head.
 *
 * Long ones collapse. A drifted-mod list runs to eleven lines and a curator
 * report to a paragraph, and several of those stacked turn the Done screen
 * into a scroll where the things needing action look exactly like the things
 * that do not. The summary above stays visible either way, so nothing is
 * hidden — only folded.
 */
function NoticeLines(props: {
  lines: readonly string[];
  /** What the disclosure offers, when there are enough lines to fold. */
  moreLabel?: string;
}): JSX.Element | null {
  if (props.lines.length === 0) return null;
  const body = (
    <div className="eh-note eh-pre-line">{props.lines.join("\n")}</div>
  );
  if (props.lines.length <= INLINE_LINE_LIMIT) return body;
  return (
    <details className="eh-details">
      <summary>
        {props.moreLabel ?? "Show details"} ({props.lines.length})
      </summary>
      <div className="eh-details__body">{body}</div>
    </details>
  );
}

function ModTypeNotice(props: { lines: readonly string[] }): JSX.Element | null {
  if (props.lines.length === 0) return null;
  const [summary, ...rest] = props.lines;
  return (
    <Notice
      label="Wrong folder"
      intent="warning"
      summary={summary ?? ""}
    >
      <NoticeLines lines={rest} />
    </Notice>
  );
}

/**
 * INI tweaks the curator had on that could not be turned on here.
 *
 * Only failures reach this — see IniTweakApplication. A tweak that landed
 * needs no sentence; one that did not changes how the game runs while
 * changing nothing the user can see, which makes it the one thing on this
 * screen they could never work out for themselves.
 */
/**
 * How the resulting load order differs from the curator's.
 *
 * Given its own notice rather than folded into the others because it is the
 * one failure here that a file check cannot see: every mod can install
 * perfectly and the game still play differently, because load order decides
 * which mod's records win. Shown only when something actually differs.
 */
function PluginOrderNotice(props: {
  lines: readonly string[];
}): JSX.Element | null {
  if (props.lines.length === 0) return null;
  const [summary, ...rest] = props.lines;
  return (
    <Notice
      label="Load order"
      intent="warning"
      summary={summary ?? ""}
    >
      <NoticeLines lines={rest} />
    </Notice>
  );
}

function IniTweakNotice(props: { lines: readonly string[] }): JSX.Element | null {
  if (props.lines.length === 0) return null;
  const [summary, ...rest] = props.lines;
  return (
    <Notice
      label="INI tweaks"
      intent="warning"
      summary={summary ?? ""}
    >
      <NoticeLines lines={rest} />
    </Notice>
  );
}

function GameIniNotice(props: { lines: readonly string[] }): JSX.Element | null {
  if (props.lines.length === 0) return null;
  const [summary, ...changes] = props.lines;

  return (
    <Notice label="Game settings" intent="info" summary={summary ?? ""}>
      {changes.length > 0 && (
        <details className="eh-details">
          <summary>
            Show the {changes.length} setting{changes.length === 1 ? "" : "s"} that changed
          </summary>
          <div className="eh-details__body eh-mono eh-muted eh-pre-line">
            {changes.join("\n")}
          </div>
        </details>
      )}
    </Notice>
  );
}

/**
 * Files the user supplied by hand that are not the ones the collection was
 * built from.
 *
 * Info, not warning: nothing failed and the user's choice was honoured. But a
 * browse-mode dependency that resolved to a different build is the most
 * invisible way an install stops reproducing the curator's setup, so it is
 * said once, here, rather than discovered in-game.
 */
function ExternalArchiveNotice(props: {
  lines: readonly string[];
}): JSX.Element | null {
  if (props.lines.length === 0) return null;
  const n = props.lines.length;
  return (
    <Notice
      label="Files you supplied"
      intent="info"
      summary={`${n} mod${n === 1 ? "" : "s"} installed from a file that is not the one the collection was built from.`}
    >
      <NoticeLines lines={props.lines} />
    </Notice>
  );
}

/**
 * ESL / light flags — restored, or a plugin count that will not load.
 *
 * The only notice on this screen that can mean "the game will not start". A
 * collection this size fits under the 254-plugin limit only because most of
 * its plugins are light, and the flag lives inside the file rather than in any
 * list, so losing it is invisible everywhere else.
 */
function PluginFlagNotice(props: {
  lines: readonly string[];
}): JSX.Element | null {
  if (props.lines.length === 0) return null;
  const [summary, ...rest] = props.lines;
  // `danger` only when the profile is genuinely unloadable; restoring flags
  // successfully is good news and must not look like a failure.
  const broken = /will not start/i.test(summary ?? "");
  return (
    <Notice
      label={broken ? "Too many plugins" : "Plugin flags"}
      intent={broken ? "danger" : "info"}
      summary={summary ?? ""}
    >
      <NoticeLines lines={rest} moreLabel="Details" />
    </Notice>
  );
}

/**
 * The curator's plugin order could not be fully applied.
 *
 * Appears only on failure. Load order decides which mod's records win, so a
 * collection that installed perfectly and did not get its order is a
 * collection that will play wrong — and that is invisible from the file list,
 * which is exactly why it needs saying.
 */
/**
 * What a stop past the point of no return did NOT do.
 *
 * The driver has produced this since alpha.116 and nothing rendered it, so
 * the entire user-facing half of that change was missing: a user who pressed
 * Stop at 90% saw a green "Success" and was never told that the plugin order,
 * the ESL flags and the game settings had been skipped — the three steps that
 * decide whether the game launches and whether it launches as the curator
 * intended.
 *
 * First in the stack. It is the frame for every other card below it, because
 * a phase that was skipped reports itself as a phase that found nothing.
 */
function FinishingSkippedNotice(props: {
  lines: readonly string[];
}): JSX.Element | null {
  if (props.lines.length === 0) return null;
  const [summary, ...rest] = props.lines;
  return (
    <Notice
      label="Stopped before finishing"
      intent="warning"
      summary={summary ?? ""}
    >
      <NoticeLines lines={rest} moreLabel="What was skipped" />
    </Notice>
  );
}

/**
 * What the staging mirror did, and what it could not.
 *
 * Also produced and never rendered. Mirroring is the one pass that WRITES
 * INTO and DELETES FROM a mod folder, so a mod it could not fully reconcile
 * is a mod that does not match the curator's copy — and the user has no other
 * way to learn which.
 */
function MirrorNotice(props: {
  lines: readonly string[];
}): JSX.Element | null {
  if (props.lines.length === 0) return null;
  const [summary, ...rest] = props.lines;
  return (
    <Notice
      label="Mirrored files"
      intent="warning"
      summary={summary ?? ""}
    >
      <NoticeLines lines={rest} moreLabel="Per mod" />
    </Notice>
  );
}

function PluginOrderNotAppliedNotice(props: {
  lines: readonly string[];
}): JSX.Element | null {
  if (props.lines.length === 0) return null;
  const [summary, ...rest] = props.lines;
  return (
    <Notice
      label="Load order"
      intent="warning"
      summary={summary ?? ""}
    >
      <NoticeLines lines={rest} moreLabel="Why" />
    </Notice>
  );
}

/**
 * The user's own rules, replaced by the collection's.
 *
 * Not folded into the notes: this is the one card describing something Event
 * Horizon DELETED. A tool that removes your work and mentions it quietly is
 * how it earns a reputation, and the backup path is only reassuring if the
 * person reads it.
 */
function RulesPurgeNotice(props: {
  lines: readonly string[];
}): JSX.Element | null {
  if (props.lines.length === 0) return null;
  const [summary, ...rest] = props.lines;
  return (
    <Notice
      label="Rules replaced"
      intent="warning"
      summary={summary ?? ""}
    >
      <NoticeLines lines={rest} moreLabel="What was removed" />
    </Notice>
  );
}

/**
 * Archives that are damaged on THIS machine.
 *
 * A warning rather than info, and separate from the curator reports on
 * purpose: this is the one failure in the ladder with a fix the user can
 * perform themselves, and the action is concrete — delete the download, fetch
 * it again, install again. Sending it to the curator instead would ask them to
 * investigate a mod they never changed.
 */
function DamagedArchiveNotice(props: {
  lines: readonly string[];
}): JSX.Element | null {
  if (props.lines.length === 0) return null;
  const n = props.lines.length;
  return (
    <Notice
      label="Damaged downloads"
      intent="warning"
      summary={`${n} mod${n === 1 ? "" : "s"} could not be installed because the downloaded file on this machine is corrupted. Downloading ${n === 1 ? "it" : "them"} again should fix ${n === 1 ? "it" : "them"}.`}
    >
      <NoticeLines lines={props.lines} />
    </Notice>
  );
}

/**
 * Mods that changed on disk since a previous install of this collection.
 *
 * Info, not warning, and the wording matters as much as the detection: we do
 * not know which of these the user did deliberately. Someone told their own
 * edit is damage learns to dismiss the notice that finally isn't.
 */
function StagingDriftNotice(props: {
  lines: readonly string[];
}): JSX.Element | null {
  if (props.lines.length === 0) return null;
  const [summary, ...rest] = props.lines;
  return (
    <Notice label="Changed since last install" intent="info" summary={summary ?? ""}>
      <NoticeLines lines={rest} />
    </Notice>
  );
}

/**
 * Mods that could not be reproduced, with the report ready to send.
 *
 * Every softer explanation has already been ruled out by the time one of
 * these exists: it failed against the curator's file list, failed against its
 * own archive, and survived a reinstall. That is what makes a copy button the
 * right affordance — the useful next action is not to debug it here, it is to
 * tell the person who can.
 */
function CuratorReportsNotice(props: {
  reports: readonly string[];
}): JSX.Element | null {
  const showToast = useToast();
  if (props.reports.length === 0) return null;
  const n = props.reports.length;

  const copy = (text: string, what: string): void => {
    void writeToClipboard(text).then((ok) => {
      showToast({
        intent: ok ? "success" : "warning",
        title: ok ? "Report copied" : "Couldn't copy",
        message: ok
          ? `Paste ${what} wherever you talk to the collection's author.`
          : "Clipboard isn't available right now.",
        ttl: 4000,
      });
    });
  };

  return (
    <Notice
      label="Could not reproduce"
      intent="warning"
      summary={
        `${n} mod${n === 1 ? "" : "s"} did not end up matching the collection, ` +
        `even after reinstalling. This is worth telling the collection's author — ` +
        `the report below is ready to paste.`
      }
    >
      <div className="eh-row">
        <Button
          intent="primary"
          onClick={(): void => copy(props.reports.join("\n\n---\n\n"), "them")}
        >
          Copy {n === 1 ? "report" : `all ${n} reports`}
        </Button>
      </div>
      {props.reports.map((report, i) => (
        <details key={i} className="eh-details">
          <summary>
            {/* First line of the report names the mod. */}
            {report.split("\n").find((l) => l.startsWith("Mod: ")) ??
              `Report ${i + 1}`}
          </summary>
          <div className="eh-details__body eh-stack eh-stack--sm">
            <div className="eh-inset eh-mono eh-muted eh-pre-wrap">{report}</div>
            <div>
              <Button intent="ghost" size="sm" onClick={(): void => copy(report, "it")}>
                Copy this one
              </Button>
            </div>
          </div>
        </details>
      ))}
    </Notice>
  );
}

/**
 * The arithmetic behind {@link ModAccounting}, kept separate so it can be
 * tested without rendering — the whole point of the section is that its sums
 * are right, and a component test would prove the layout instead.
 *
 * `missing` is positive when mods are unaccounted for and negative when they
 * have been counted twice; both are reportable and neither should be silently
 * clamped to zero, which would hide exactly the discrepancy this exists to
 * surface.
 */
export function reconcileMods(input: {
  total: number;
  installed: number;
  carried: number;
  skipped: number;
}): { accounted: number; missing: number; parts: string } {
  const accounted = input.installed + input.carried + input.skipped;
  return {
    accounted,
    missing: input.total - accounted,
    parts: [
      `${input.installed} installed`,
      ...(input.carried > 0 ? [`${input.carried} already had`] : []),
      ...(input.skipped > 0 ? [`${input.skipped} skipped`] : []),
    ].join(" + "),
  };
}

/**
 * Does every mod in the collection appear somewhere in the outcome?
 *
 * The tiles above are six independent counters, and on a real run they do not
 * visibly add up: a 963-mod collection reporting "installed 958, skipped 1"
 * leaves four mods the reader can only find by subtracting, and no way at all
 * to learn what became of them. Six correct numbers that do not reconcile read
 * as a UI that is hiding something — which, in the case where they genuinely
 * do not reconcile, it is.
 *
 * So this states the sum, and when it does not balance it says so plainly
 * rather than letting the arithmetic fail quietly. Unaccounted mods are not a
 * cosmetic problem: each one is a mod the collection contains and this profile
 * does not, which is exactly the failure the whole project exists to catch.
 */
function ModAccounting(props: {
  result: Extract<InstallResult, { kind: "success" }>;
  bundle: PreviewBundle;
}): JSX.Element | null {
  const total = props.bundle.plan.manifest.mods.length;
  if (total === 0) return null;

  const { accounted, missing, parts } = reconcileMods({
    total,
    installed: props.result.installedModIds.length,
    carried: props.result.carriedMods.length,
    skipped: props.result.skippedMods.length,
  });

  return (
    <p className="eh-note eh-prose" role={missing !== 0 ? "status" : undefined}>
      {missing === 0 ? (
        <>
          All {total} mods in this collection are accounted for: {parts}.
        </>
      ) : missing > 0 ? (
        <>
          <strong>
            {missing} of the {total} mods in this collection are not accounted
            for
          </strong>{" "}
          — {parts} leaves {missing} that were neither installed, already
          present, nor recorded as skipped. That is a gap in this report, not a
          mod you can go and find: the log for this run lists every mod the
          driver touched.
        </>
      ) : (
        <>
          This report counts {accounted} outcomes for a collection of {total}{" "}
          mods, so {-missing} mod(s) have been counted twice. The install
          itself is unaffected; the tally above is wrong.
        </>
      )}
    </p>
  );
}

/**
 * The notices that state a fact and ask nothing.
 *
 * Folded behind one line, but the line NAMES each of them — "3 notes: INI
 * tweaks, game settings, files you supplied". A disclosure that says only
 * "3 notes" makes the user open it to find out whether it matters, which is
 * the cost the fold was supposed to save.
 *
 * Renders nothing at all when there is nothing to say, so a clean install
 * gets no empty scaffolding.
 */
function InstallNotes(props: {
  result: Extract<InstallResult, { kind: "success" }>;
}): JSX.Element | null {
  const { result } = props;
  const present: Array<{ label: string; node: JSX.Element }> = [];
  if ((result.iniTweakNotice?.length ?? 0) > 0) {
    present.push({
      label: "INI tweaks",
      node: <IniTweakNotice key="ini" lines={result.iniTweakNotice ?? []} />,
    });
  }
  if ((result.gameIniNotice?.length ?? 0) > 0) {
    present.push({
      label: "game settings",
      node: <GameIniNotice key="game" lines={result.gameIniNotice ?? []} />,
    });
  }
  if ((result.externalArchiveNotice?.length ?? 0) > 0) {
    present.push({
      label: "files you supplied",
      node: (
        <ExternalArchiveNotice
          key="external"
          lines={result.externalArchiveNotice ?? []}
        />
      ),
    });
  }
  if (present.length === 0) return null;

  const n = present.length;
  return (
    <details className="eh-details">
      <summary>
        {n} note{n === 1 ? "" : "s"} about this install —{" "}
        {present.map((p) => p.label).join(", ")}
      </summary>
      <div className="eh-stack eh-details__body">{present.map((p) => p.node)}</div>
    </details>
  );
}

function SuccessBody(props: {
  result: Extract<InstallResult, { kind: "success" }>;
  /** Needed for the collection's own mod count — the result carries outcomes,
   *  not the total they are supposed to add up to. */
  bundle: PreviewBundle;
}): JSX.Element {
  const { result } = props;
  const installedBuckets = countByKey(
    result.installedMods.map((m) => m.fromDecision),
  );
  const removedBuckets = countByKey(
    result.removedMods.map((m) => m.reason),
  );
  return (
    <div className="eh-stack eh-stack--lg">
      {/*
        ─── THINGS THAT NEED THE USER ───────────────────────────────────
        Ordered by consequence, not by the order the driver happens to
        produce them. These used to sit in a flat stack of eight identical
        cards with the purely informational ones FIRST, so "your download is
        corrupted" looked exactly like "the collection wrote your INI
        settings" and arrived after it. Eight equal cards is eight cards
        nobody triages.

        1. a broken download the user can replace right now
        2. files in the wrong folder — installed correctly, may not load
        3. load order, which is the whole promise of this project
        4. mods that changed since we installed them: a decision, not a fault
        5. a report to send, which is the only one whose payoff is someone
           else's, and so the one that waits
      */}
      {/*
        First of everything. This is the only card that can mean the game will
        not launch at all; a broken download is recoverable by comparison.
      */}
      {/*
        ABOVE the plugin-flag card, because it explains why that one is empty.
        A stop past the deploy skips the ESL-flag repair, and a skipped repair
        describes itself as "0 corrected" — indistinguishable from "checked,
        all correct" unless this card says the check never ran.
      */}
      <FinishingSkippedNotice lines={result.finishingSkippedNotice ?? []} />
      <PluginFlagNotice lines={result.pluginFlagNotice ?? []} />
      <DamagedArchiveNotice lines={result.damagedArchiveNotice ?? []} />
      {/*
        High, because it is the only card here describing something we DELETED
        — and the only one whose remedy (the backup file) is useless if unread.
      */}
      <RulesPurgeNotice lines={result.rulesPurgeNotice ?? []} />
      {/*
        Above the drift report, which describes a difference; this one
        describes the attempt to remove it having failed.
      */}
      <PluginOrderNotAppliedNotice
        lines={result.pluginOrderNotApplied ?? []}
      />
      <ModTypeNotice lines={result.modTypeNotice ?? []} />
      <PluginOrderNotice lines={result.pluginOrderNotice ?? []} />
      <MirrorNotice lines={result.mirrorNotice ?? []} />
      <StagingDriftNotice lines={result.stagingDriftNotice ?? []} />
      <CuratorReportsNotice reports={result.curatorReports ?? []} />
      <PlayGameCard gameId={props.bundle.plan.manifest.game.id} />
      <StatGrid min={160}>
        <StatTile label="Profile" value={result.profileName} tone="info" />
        <StatTile
          label="Mode"
          value={
            result.installTargetMode === "fresh-profile"
              ? "Fresh profile"
              : "Current profile"
          }
        />
        {/*
          How long it took. Absent before, and it is the first thing anyone
          asks when reporting that a collection "takes forever" — without it
          the answer is a guess on both sides of the conversation.
        */}
        <StatTile label="Took" value={formatDuration(result.durationMs)} />
        <StatTile label="Installed" value={result.installedModIds.length} tone="success" />
        <StatTile
          label="Removed"
          value={result.removedMods.length}
          tone={result.removedMods.length > 0 ? "warning" : "neutral"}
        />
        <StatTile label="Carried" value={result.carriedMods.length} />
        <StatTile label="Skipped" value={result.skippedMods.length} />
      </StatGrid>

      <ModAccounting result={result} bundle={props.bundle} />

      {/*
        ─── THINGS THAT ARE MERELY TRUE ─────────────────────────────────
        Nothing here asks anything of the user: the INI tweaks that could not
        be turned on, the settings the collection wrote, the files they chose
        by hand. Worth saying once, not worth competing with a corrupted
        download for the same attention — so they fold, with every one of them
        NAMED in the summary. Folded is not hidden; the user can see what is
        in there without opening it.
      */}
      <InstallNotes result={result} />

      {installedBuckets.length > 0 && (
        <BucketList title="Install breakdown" buckets={installedBuckets} />
      )}
      {removedBuckets.length > 0 && (
        <BucketList title="Removal breakdown" buckets={removedBuckets} />
      )}
      {result.skippedMods.length > 0 && (
        <details className="eh-details">
          <summary>Show skipped mods ({result.skippedMods.length})</summary>
          <ul className="eh-list eh-details__body">
            {result.skippedMods.map((s) => (
              <li key={s.compareKey}>
                {s.name} <em className="eh-muted">— {s.reason}</em>
              </li>
            ))}
          </ul>
        </details>
      )}

      <RulesAndUserlistSection
        rules={result.rulesApplication}
        userlist={result.userlistApplication}
      />

      <IntegritySection verifications={result.verifications} />

      <div className="eh-kv">
        <span className="eh-kv__label">Receipt</span>
        <span className="eh-fill eh-mono eh-muted">{result.receiptPath}</span>
      </div>
      {/*
        The path above is unselectable in practice and means nothing to most
        people, but it is the door to everything this run recorded — the
        receipt itself, and the log beside it that lists every mod the driver
        touched. The accounting line above sends readers to that log; without
        a way to reach it that instruction is a dead end.
      */}
      <div className="eh-actions">
        <Button
          intent="ghost"
          size="sm"
          onClick={(): void => {
            void revealInFileManager({
              filePath: result.receiptPath,
              folderPath: parentDir(result.receiptPath),
            });
          }}
        >
          Show receipt
        </Button>
        <Button
          intent="ghost"
          size="sm"
          onClick={(): void => {
            void (async (): Promise<void> => {
              const { getLogFilePath } = await import(
                "../../../core/logging/ehLog"
              );
              const log = getLogFilePath();
              if (log === undefined) return;
              await revealInFileManager({
                filePath: log,
                folderPath: parentDir(log),
              });
            })();
          }}
        >
          Show log
        </Button>
      </div>
    </div>
  );
}

/**
 * Surfaces the slice 7 (file integrity verification) summary the
 * driver writes into the receipt. Without this, the user has no
 * way to see when Vortex's "lost files" bug bit during install.
 *
 * Layout mirrors {@link RulesAndUserlistSection}: a row of count
 * tiles + a `<details>` expander for failure detail. Hidden when
 * the manifest didn't carry a verification snapshot at all (the
 * curator built with `verificationLevel = "none"` AND every
 * verification is `kind: "skip"` for that reason — common for old
 * receipts pre-slice-7).
 */
function IntegritySection(props: {
  verifications: Extract<InstallResult, { kind: "success" }>["verifications"];
}): JSX.Element | null {
  const { verifications } = props;
  if (verifications.length === 0) return null;

  let okCount = 0;
  let recoveredCount = 0;
  let failCount = 0;
  let skipCount = 0;
  let levelNoneSkips = 0;
  let totalVerifiedFiles = 0;
  for (const v of verifications) {
    if (v.kind === "ok") {
      okCount++;
      totalVerifiedFiles += v.verifiedFileCount;
      if (v.retryAttempted === true) recoveredCount++;
    } else if (v.kind === "fail") {
      failCount++;
    } else {
      skipCount++;
      if (v.reason === "verification-level-none") levelNoneSkips++;
    }
  }

  // Hide entirely when every entry is a `verification-level-none`
  // skip — there's nothing to surface and no failure to warn about.
  // (Mixed-skip receipts where SOME mods carried snapshots still
  // render so the user sees the partial coverage.)
  if (
    okCount === 0 &&
    recoveredCount === 0 &&
    failCount === 0 &&
    skipCount === levelNoneSkips
  ) {
    return null;
  }

  const fails = verifications.filter(
    (v): v is Extract<typeof v, { kind: "fail" }> => v.kind === "fail",
  );
  const recovered = verifications.filter(
    (v): v is Extract<typeof v, { kind: "ok" }> =>
      v.kind === "ok" && v.retryAttempted === true,
  );

  return (
    <Section title="Integrity check" size="sm">
      <StatGrid min={160}>
        <StatTile
          label="Mods passing"
          value={okCount}
          tone={failCount === 0 ? "success" : "neutral"}
        />
        <StatTile label="Files verified" value={totalVerifiedFiles} />
        {recoveredCount > 0 && (
          <StatTile label="Recovered" value={recoveredCount} tone="warning" />
        )}
        {failCount > 0 && (
          <StatTile label="Still failing" value={failCount} tone="danger" />
        )}
        {skipCount > 0 && failCount === 0 && (
          <StatTile label="Skipped" value={skipCount} />
        )}
      </StatGrid>
      {recovered.length > 0 && fails.length === 0 && (
        <p className="eh-note eh-prose">
          {recovered.length} mod{recovered.length === 1 ? "" : "s"} needed a
          reinstall to land all files. Common cause: an antivirus briefly
          quarantined a file mid-extract; Event Horizon retried automatically.
        </p>
      )}
      {fails.length > 0 && (
        <details className="eh-details eh-details--danger">
          <summary>Show failing mods ({fails.length})</summary>
          <div className="eh-details__body eh-stack eh-stack--sm">
          <p className="eh-note eh-prose">
            {/*
              Two different failures used to share one sentence. A mod whose
              only defect is its installer ANSWERS verifies byte-for-byte, so
              its row reads "0 missing, 0 truncated, 0 corrupt" — and it was
              rendered under prose telling the user to go through their
              antivirus history. They were sent to hunt corruption that does
              not exist, and the one fact that would have helped appeared
              nowhere on the screen.
            */}
            {fails.some((f) => f.failReason !== "stale-installer-options") && (
              <>
                These mods extracted with missing or corrupt files even after
                an automatic reinstall. The most common cause is antivirus
                quarantining files; check your AV history, restore the files,
                and click <strong>Reinstall</strong> on the mod in
                Vortex&apos;s Mods tab. The full per-file diff is in the
                receipt JSON.
              </>
            )}
            {fails.some((f) => f.failReason === "stale-installer-options") && (
              <>
                {" "}
                Mods marked <em>installer options differ</em> below are a
                different case: every one of their files is correct. They were
                installed through their FOMOD with different answers than this
                collection records, so they contain a different SET of correct
                files. Reinstalling one and choosing the collection&apos;s
                answers is what fixes it — there is nothing wrong with the
                files you have.
              </>
            )}
          </p>
          <ul className="eh-list eh-list--spaced">
            {fails.map((f) => (
              <li key={f.vortexModId}>
                <strong>{f.name}</strong>{" "}
                <em className="eh-muted">
                  {/*
                    Three zeroes are not a description of this failure, so a
                    mod that failed for a non-file reason says what the reason
                    was instead of reporting counts about files that are fine.
                  */}
                  {f.failReason === "stale-installer-options" ? (
                    <>
                      — installer options differ from the collection&apos;s;
                      all {f.expectedFileCount} recorded file(s) verified
                      {f.retryAttempted ? "; reinstall did not help" : ""}
                    </>
                  ) : (
                    <>
                      — {f.missingFileCount} missing,{" "}
                      {f.sizeMismatchCount} truncated,{" "}
                      {f.hashMismatchCount} corrupt of {f.expectedFileCount}
                      {f.retryAttempted ? "; reinstall did not help" : ""}
                    </>
                  )}
                  {/*
                    The one outcome where the mod is GONE. It was recorded and
                    logged and rendered nowhere, so these users were told to
                    click Reinstall on a mod that is no longer in their list.
                  */}
                  {f.modRemoved === true && (
                    <>
                      {" "}
                      <strong className="eh-tone--danger">
                        — removed during the repair and could not be put back;
                        it is no longer installed
                      </strong>
                    </>
                  )}
                </em>
                {f.examples.length > 0 && (
                  <ul className="eh-list eh-mono eh-muted">
                    {f.examples.slice(0, 6).map((ex, i) => (
                      <li key={i}>
                        [{ex.bucket}] {ex.path}
                      </li>
                    ))}
                    {f.examples.length > 6 && (
                      <li className="eh-muted">
                        ... and {f.examples.length - 6} more
                      </li>
                    )}
                  </ul>
                )}
              </li>
            ))}
          </ul>
          </div>
        </details>
      )}
    </Section>
  );
}

/**
 * Surfaces the slice 6c (mod rules + LoadOrder) and slice 6d
 * (LOOT userlist) application summaries the driver writes into
 * the receipt. Without this section, the user has no way to know
 * whether Vortex's reducers actually accepted the curator's rules
 * or whether some were silently rejected — the verification-on-
 * dispatch we wired into `applyUserlist` would record failures
 * into a JSON file the user never opens.
 *
 * Layout is intentionally compact: collapsed by default if there
 * is nothing meaningful to surface (zero applies, zero skips), so
 * collections without rules don't add noise. Skipped entries open
 * in a `<details>` expander so the danger signal is one click
 * away — same UX pattern as "Show skipped mods" above.
 */
function RulesAndUserlistSection(props: {
  rules: Extract<InstallResult, { kind: "success" }>["rulesApplication"];
  userlist: Extract<InstallResult, { kind: "success" }>["userlistApplication"];
}): JSX.Element | null {
  const { rules, userlist } = props;
  const totalApplied =
    rules.appliedRuleCount +
    rules.appliedLoadOrderCount +
    userlist.appliedRuleCount +
    userlist.appliedGroupAssignmentCount +
    userlist.appliedNewGroupCount +
    userlist.appliedGroupRuleCount;
  const totalSkipped =
    rules.skippedRules.length +
    rules.skippedLoadOrderEntries.length +
    userlist.skippedUserlistEntries.length;
  const hasOverwrites =
    rules.overwrittenUserRuleCount > 0 ||
    userlist.overwrittenGroupAssignmentCount > 0;

  if (totalApplied === 0 && totalSkipped === 0) {
    return null;
  }

  return (
    <Section title="Rules & ordering" size="sm">
      <StatGrid min={160}>
        <StatTile label="Mod rules applied" value={rules.appliedRuleCount} />
        {/*
          Only when the game HAS one. Fallout 4 and Skyrim drive load order
          through plugins.txt, not Vortex's generic LoadOrder API, so a
          correct run legitimately applies zero entries — and "LOAD ORDER
          ENTRIES 0" on the one screen summarising a load-order-critical
          install reads as a failure of the thing the collection exists to
          reproduce. It made the curator stop and ask.
        */}
        {rules.appliedLoadOrderCount > 0 && (
          <StatTile label="Load order entries" value={rules.appliedLoadOrderCount} />
        )}
        <StatTile label="Plugin rules applied" value={userlist.appliedRuleCount} />
        <StatTile
          label="Plugin groups"
          value={`${userlist.appliedGroupAssignmentCount} assigned · ${userlist.appliedNewGroupCount} new`}
        />
        {/*
          Not a warning any more. Replacing the user's rules with the
          collection's is now deliberate policy — it is the only way what
          loads matches what the curator tested — so colouring it amber
          reports our own intended behaviour as something that went wrong.
          The "Rules replaced" card above explains it and names the backup;
          this is just the count.
        */}
        {hasOverwrites && (
          <StatTile
            label="Your rules replaced"
            value={rules.overwrittenUserRuleCount + userlist.overwrittenGroupAssignmentCount}
          />
        )}
        {totalSkipped > 0 && (
          <StatTile label="Skipped" value={totalSkipped} tone="danger" />
        )}
      </StatGrid>
      {totalSkipped > 0 && (
        <details className="eh-details eh-details--danger">
          <summary>Show skipped rules ({totalSkipped})</summary>
          <div className="eh-details__body eh-stack eh-stack--sm">
          <p className="eh-note eh-prose">
            These came from the collection but did not land. Common causes:
            Vortex&apos;s mod-rule or userlist contract changed, the rule
            referenced a mod/plugin that did not install, or the curator
            ignored the rule before publishing. The full per-rule reason
            lives in the receipt JSON.
          </p>
          <ul className="eh-list">
            {rules.skippedRules.map((s, i) => (
              <li key={`mr-${i}`}>
                <code>{s.source}</code> {s.ruleType} <code>{s.reference}</code>{" "}
                <em className="eh-muted">— {s.reason}</em>
              </li>
            ))}
            {rules.skippedLoadOrderEntries.map((s, i) => (
              <li key={`lo-${i}`}>
                load-order <code>{s.compareKey}</code> @ {s.pos}{" "}
                <em className="eh-muted">— {s.reason}</em>
              </li>
            ))}
            {userlist.skippedUserlistEntries.map((s, i) => (
              <li key={`ul-${i}`}>
                {s.kind} <code>{s.subject}</code>
                {s.reference !== undefined && (
                  <>
                    {" "}
                    {s.ruleKind ?? ""} <code>{s.reference}</code>
                  </>
                )}{" "}
                <em className="eh-muted">— {s.reason}</em>
              </li>
            ))}
          </ul>
          </div>
        </details>
      )}
    </Section>
  );
}

function FailureBody(props: {
  phase: string;
  message: string;
  partialProfileId?: string;
  installedSoFar?: number;
  /**
   * This was a deliberate stop, not a failure. Same facts, different verb —
   * telling someone their install "failed" when they stopped it themselves
   * reads as a bug and sends them looking for one.
   */
  stopped?: boolean;
  /**
   * What this run DELETED before it failed, and where the backup went.
   *
   * A partial failure happens after the rules purge, so the user's mod rules
   * and LOOT list are already gone. This card used to render phase, profile
   * and message only, so the one string naming the timestamped backup was
   * computed and dropped.
   */
  rulesPurgeNotice?: string[];
  /**
   * ─── AND EVERYTHING ELSE A PARTIAL RUN ACTUALLY DID ───────────────────
   * A failure card used to be a report about nothing happening. That stopped
   * being true when a partial run started writing a receipt: 978 of 979 mods
   * can be installed, deployed and load-ordered and the run still returns
   * `failed`.
   *
   * `finishingSkipped` is the one that costs the most. Stop after the deploy
   * with a failed mod and the card said "source the missing ones and run this
   * again" — never that the plugin order was not applied or the ESL flags not
   * restored. Without the flags, a profile that fits only because most
   * plugins are light does not start.
   *
   * `damagedArchive` is the only branch of the whole ladder that ends in an
   * action the user can take, and it was computed and dropped here too.
   */
  finishingSkippedNotice?: string[];
  pluginFlagNotice?: string[];
  mirrorNotice?: string[];
  damagedArchiveNotice?: string[];
  curatorReports?: string[];
  /** Where the receipt landed, so a partial install is findable at all. */
  receiptPath?: string;
}): JSX.Element {
  return (
    <div className="eh-stack">
      {/* The reason leads. Someone reading this screen just had an install
          fail; what went wrong is the whole question, and "Phase:" is our
          vocabulary rather than theirs. It used to be the first line. */}
      <p className="eh-strong">{props.message}</p>

      {/* Then the facts about the state their machine is now in, as aligned
          fields rather than a stack of bold-prefixed sentences. */}
      <div className="eh-stack eh-stack--xs">
        <div className="eh-kv">
          <span className="eh-kv__label">
            {props.stopped === true ? "Stopped during" : "Failed during"}
          </span>
          <span className="eh-fill">{props.phase}</span>
        </div>
        {props.installedSoFar !== undefined && (
          <div className="eh-kv">
            <span className="eh-kv__label">Mods installed first</span>
            <span className="eh-fill">{props.installedSoFar}</span>
          </div>
        )}
        {props.partialProfileId !== undefined && (
          <div className="eh-kv">
            <span className="eh-kv__label">Partial profile</span>
            <span className="eh-fill eh-mono">{props.partialProfileId}</span>
          </div>
        )}
      </div>

      {/* Before "what to do": what was already changed. A failure card that
          omits a deletion the run performed is not a report of what
          happened. */}
      {props.rulesPurgeNotice !== undefined &&
        props.rulesPurgeNotice.length > 0 && (
          <RulesPurgeNotice lines={props.rulesPurgeNotice} />
        )}

      {/* What the run did NOT finish. First of the rest, because it is the
          one that can stop the game starting. */}
      {props.finishingSkippedNotice !== undefined &&
        props.finishingSkippedNotice.length > 0 && (
          <FinishingSkippedNotice lines={props.finishingSkippedNotice} />
        )}

      {/* The one phase that DELETES files from a mod folder. */}
      {props.mirrorNotice !== undefined && props.mirrorNotice.length > 0 && (
        <MirrorNotice lines={props.mirrorNotice} />
      )}

      {/* Bytes rewritten inside the user's game folder, and the undo. */}
      {props.pluginFlagNotice !== undefined &&
        props.pluginFlagNotice.length > 0 && (
          <PluginFlagNotice lines={props.pluginFlagNotice} />
        )}

      {/* The only branch of the ladder that ends in something they can do. */}
      {props.damagedArchiveNotice !== undefined &&
        props.damagedArchiveNotice.length > 0 && (
          <DamagedArchiveNotice lines={props.damagedArchiveNotice} />
        )}

      {props.curatorReports !== undefined &&
        props.curatorReports.length > 0 && (
          <CuratorReportsNotice reports={props.curatorReports} />
        )}

      {/* A partial run DID write a receipt, and nothing on this screen said
          so — which mattered, because that receipt is what makes the
          collection uninstallable as a unit and what a retry resumes from. */}
      {props.receiptPath !== undefined && (
        <p className="eh-note">
          A receipt was written for what did install, so this collection can be
          uninstalled as a unit and a retry will pick up from it.
        </p>
      )}

      {/* And last, what to do — which only makes sense once they know what
          happened and what exists. */}
      {props.partialProfileId !== undefined && (
        <p className="eh-note">
          Event Horizon does not roll back. The partial profile is left in
          place: switch to your previous profile in Vortex to carry on as
          before, or stay on this one and inspect what was installed.
        </p>
      )}

      {/* Only for a stop, and only when something landed: after a crash
          "just run it again" is advice we have not earned, but after a
          deliberate stop it is the actual next step, and the reason it works
          is worth stating — the mods are matched by their Nexus ids and
          archive hashes, so they are recognised rather than re-downloaded. */}
      {props.stopped === true &&
        props.installedSoFar !== undefined &&
        props.installedSoFar > 0 && (
          <p className="eh-note">
            Installing this collection again will pick up where it stopped —
            the {props.installedSoFar} mods already installed are recognised by
            their archive hashes and will not be downloaded twice.
          </p>
        )}
    </div>
  );
}



function BucketList(props: {
  title: string;
  buckets: Array<{ key: string; count: number }>;
}): JSX.Element {
  return (
    <Section title={props.title} size="sm">
      <ul className="eh-list">
        {props.buckets.map((b) => (
          <li key={b.key}>
            <span className="eh-mono">{b.key}</span> — {b.count}
          </li>
        ))}
      </ul>
    </Section>
  );
}

function countByKey(
  values: string[],
): Array<{ key: string; count: number }> {
  const counts = new Map<string, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  return [...counts.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([key, count]) => ({ key, count }));
}

// avoid unused warnings for re-exported helpers
void buildUserConfirmedDecisions;
void fillDefaultConflictChoices;
void fillDefaultOrphanChoices;
