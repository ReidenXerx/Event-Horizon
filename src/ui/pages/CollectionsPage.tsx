/**
 * CollectionsPage — Phase 5.2.
 *
 * Lists every install receipt under
 * `<appData>/Vortex/event-horizon/installs/*.json` so the user has a
 * single place to:
 *
 *   - See "what did Event Horizon install on this machine?"
 *   - Switch to the Vortex profile that holds a given collection.
 *   - Inspect the per-mod records the receipt holds.
 *   - Uninstall: every mod Event Horizon installed for it, in any revision
 *     (collections/CollectionUninstallModal.tsx).
 *
 * The page never edits a receipt directly — it only reads, deletes,
 * and acts on profiles. Receipts are written exclusively by the
 * install driver.
 */

import * as React from "react";
import { util } from "@nexusmods/vortex-api";
import type { types } from "@nexusmods/vortex-api";

import { listReceipts } from "../../core/installLedger";
import { ehLog } from "../../core/logging/ehLog";
import { switchToProfile } from "../../core/installer/profile";
import type { InstallReceipt } from "../../types/installLedger";
import { installModeLabel } from "./installModeLabel";
import {
  Button,
  Callout,
  Card,
  EmptyState,
  EventHorizonLogo,
  Field,
  Input,
  Modal,
  Pill,
  ProgressRing,
  Section,
  Select,
  StatGrid,
  StatTile,
  useToast,
} from "../components";
import { ErrorBoundary, useErrorReporter, useErrorReporterFormatted } from "../errors";
import {
  describeInstallAttempt,
  listInstallAttempts,
  type InstallAttempt,
} from "../../core/installer/attemptRecord";
import {
  describeInterruptedInstall,
  listInterruptedInstalls,
  type InstallMarker,
} from "../../core/installer/installMarker";
import type { EventHorizonRoute } from "../routes";
import { useApi } from "../state";
import { DidItWorkPrompt, type DidItWorkState } from "./collections/DidItWorkPrompt";
import { CollectionUninstallModal } from "./collections/CollectionUninstallModal";
import { useEHRuntime } from "../runtime/useEHRuntime";
import {
  checkCollectionUpdates,
  getCollectionUpdateStore,
  pendingUpdateFor,
  startCollectionUpdate,
} from "../runtime/collectionUpdates";
import type { CollectionUpdate } from "../../core/nexus/collectionUpdates";
import { EXTENSION_VERSION } from "../version";
import { getVortexUserDataPath } from "../../core/paths";
import { looksLikeWine } from "../../core/proton";
import { PlayGameButton } from "../play/PlayGameButton";
import { CollectionBanner, hasBanner } from "../components/CollectionShowcase";
import {
  loadCachedPresentation,
  type ShownPresentation,
} from "../../core/presentation/presentationCache";
import { themeVariables } from "../../core/presentation/presentation";
import { getEventHorizonDir } from "../../core/paths/appDataPaths";

export interface CollectionsPageProps {
  onNavigate: (route: EventHorizonRoute) => void;
}

interface LoadedState {
  kind: "loaded";
  receipts: InstallReceipt[];
  /**
   * Installs that started and never finished.
   *
   * A receipt is written only when an install COMPLETES, deliberately — it
   * asserts the collection IS installed, and a half-finished run has not
   * earned that claim. The consequence is that an interrupted install leaves
   * no receipt, so this page showed nothing at all: a tester had 963 mods
   * staged on his machine and "My Collections" said he had none.
   *
   * The marker is the missing half. It claims only that a run STARTED.
   */
  interrupted: InstallMarker[];
  /**
   * Installs that ended cleanly but did not succeed.
   *
   * Distinct from `interrupted`: that means the process DIED, this means it
   * stopped and said why. Seven of the driver's eight failure paths return
   * before the receipt is written, so without this a failed install is as
   * invisible as a crashed one was.
   */
  failedAttempts: InstallAttempt[];
  errors: Array<{ filename: string; message: string }>;
}

type PageState =
  | { kind: "loading" }
  | LoadedState
  | { kind: "empty" };

export function CollectionsPage(props: CollectionsPageProps): JSX.Element {
  const reportFormatted = useErrorReporterFormatted();
  return (
    <ErrorBoundary
      where="CollectionsPage"
      variant="page"
      onReport={reportFormatted}
    >
      <CollectionsList onNavigate={props.onNavigate} />
    </ErrorBoundary>
  );
}

/**
 * Installs that started and never finished.
 *
 * Shown ABOVE the installed collections, and shown even when there are none:
 * the case this exists for is a machine with a half-installed collection and
 * no receipt, where the page previously said "no collections" to a user
 * looking at 963 staged mods.
 *
 * It offers to re-run rather than to "resume". There is no resume — and that
 * is the right design, not a missing feature. Re-running re-matches what is
 * already on disk by Nexus id and hash, so it picks up where it stopped
 * without trusting a record of what a dead process THOUGHT it had done. The
 * marker's only job is to tell the user that is what will happen.
 */
export function InterruptedInstalls(props: {
  markers: readonly InstallMarker[];
  onResume: () => void;
}): JSX.Element | null {
  if (props.markers.length === 0) return null;
  return (
    <section aria-label="Interrupted installs" className="eh-stack eh-stack--sm">
      {props.markers.map((m) => (
        <Callout
          key={m.packageId}
          tone="warning"
          icon="⏸"
          title={
            <span className="eh-row eh-row--sm">
              <span>{m.packageName}</span>
              <Pill intent="warning">unfinished</Pill>
            </span>
          }
          actions={
            <Button intent="primary" size="sm" onClick={props.onResume}>
              Run the install again
            </Button>
          }
        >
          {describeInterruptedInstall(m)}
        </Callout>
      ))}
    </section>
  );
}

/**
 * Installs that stopped and said why.
 *
 * The sibling of {@link InterruptedInstalls}, and the more common case: a
 * crash leaves a marker behind, but a clean failure returns before the receipt
 * is written and used to leave nothing at all. A tester's run stopped at the
 * deploy step with 963 of 967 mods staged, and this page showed him none of
 * it.
 *
 * Quieter than the interrupted banner on purpose — it is a report, not an
 * alarm, and the mods it describes are on disk and fine.
 */
export function FailedAttempts(props: {
  attempts: readonly InstallAttempt[];
  onRetry: () => void;
}): JSX.Element | null {
  if (props.attempts.length === 0) return null;
  return (
    <section aria-label="Installs that did not finish" className="eh-stack eh-stack--sm">
      {props.attempts.map((a) => (
        <Callout
          key={a.packageId}
          title={
            <span className="eh-row eh-row--sm">
              <span>{a.packageName}</span>
              {/* Absent on a record written before the field existed — show
                  no pill rather than an empty one. */}
              {a.packageVersion !== undefined && a.packageVersion.length > 0 && (
                <Pill intent="neutral">v{a.packageVersion}</Pill>
              )}
              <Pill intent={a.outcome === "aborted" ? "neutral" : "danger"}>
                {a.outcome === "aborted" ? "stopped" : "did not finish"}
              </Pill>
            </span>
          }
          actions={
            <Button intent="ghost" size="sm" onClick={props.onRetry}>
              Run the install again
            </Button>
          }
        >
          <div className="eh-stack eh-stack--sm">
            <p className="eh-body">{describeInstallAttempt(a)}</p>
            {a.error !== undefined && (
              // The reason it stopped, verbatim. Paraphrasing an error the
              // user may need to search for helps nobody.
              <p className="eh-mono eh-muted">{a.error}</p>
            )}
          </div>
        </Callout>
      ))}
    </section>
  );
}

type SortKey = "recent" | "name" | "mods";

function CollectionsList(props: CollectionsPageProps): JSX.Element {
  const reportError = useErrorReporter();
  const showToast = useToast();
  const api = useApi();

  /**
   * ─── "DID THIS COLLECTION WORK FOR YOU?" ────────────────────────────
   * Only ever populated for a collection whose game was actually STARTED
   * (see `notePlayedCollection`). Vortex asks the moment its own installer
   * finishes; at that moment nobody has loaded a save, and the vote is
   * public and permanent.
   */
  const [feedback, setFeedback] = React.useState<DidItWorkState>({ kind: "idle" });
  const [feedbackId, setFeedbackId] = React.useState<string | undefined>(undefined);
  const [feedbackBusy, setFeedbackBusy] = React.useState(false);

  /** Can Vortex endorse this collection from here at all? */
  const canEndorseHere = React.useCallback(
    async (entry: { gameDomain: string; collectionId?: number }): Promise<boolean> => {
      if (entry.collectionId === undefined) return false;
      const { findCollectionModId } = await import("../runtime/collectionRating");
      return findCollectionModId(api, entry.gameDomain, entry.collectionId) !== undefined;
    },
    [api],
  );

  React.useEffect(() => {
    let alive = true;
    void (async (): Promise<void> => {
      try {
        const [{ loadFeedback, nextToAsk, nextToOfferEndorsement }, { getEventHorizonRoot }] =
          await Promise.all([
            import("../../core/feedback/collectionFeedback"),
            import("../../core/paths/appDataPaths"),
          ]);
        const store = await loadFeedback(getEventHorizonRoot());
        if (!alive) return;
        const ask = nextToAsk(store);
        if (ask !== undefined) {
          setFeedbackId(ask.key);
          setFeedback({ kind: "asking", entry: ask.entry });
          return;
        }
        const offer = nextToOfferEndorsement(store);
        if (offer === undefined) return;
        const endorsableHere = await canEndorseHere(offer.entry);
        if (!alive) return;
        setFeedbackId(offer.key);
        setFeedback({ kind: "offer-endorse", entry: offer.entry, endorsableHere });
      } catch {
        // A prompt that cannot load is simply not shown.
      }
    })();
    return (): void => {
      alive = false;
    };
  }, [canEndorseHere]);

  const recordFeedback = React.useCallback(
    async (outcome: { answer?: "worked" | "did-not-work"; dismissed?: boolean }): Promise<void> => {
      if (feedbackId === undefined) return;
      const [{ loadFeedback, noteAnswered, saveFeedback }, { getEventHorizonRoot }] =
        await Promise.all([
          import("../../core/feedback/collectionFeedback"),
          import("../../core/paths/appDataPaths"),
        ]);
      const root = getEventHorizonRoot();
      await saveFeedback(
        root,
        noteAnswered(await loadFeedback(root), feedbackId, outcome, new Date().toISOString()),
      );
    },
    [feedbackId],
  );

  const onFeedbackAnswer = React.useCallback(
    (answer: "worked" | "did-not-work"): void => {
      if (feedback.kind !== "asking") return;
      const entry = feedback.entry;
      setFeedbackBusy(true);
      void (async (): Promise<void> => {
        try {
          const { rateRevision } = await import("../runtime/collectionRating");
          const sent = await rateRevision(api, {
            slug: entry.slug,
            revisionNumber: entry.revisionNumber,
            answer,
          });
          /**
           * Recorded whether or not Nexus took the vote. They answered; asking
           * again because a server was unreachable would punish them for our
           * network, and the question is theirs to be asked once.
           */
          await recordFeedback({ answer });
          if (sent.kind !== "sent") {
            showToast({
              intent: "info",
              message:
                sent.kind === "no-revision"
                  ? "Saved here. Nexus could not be reached, so the vote was not cast — signing in to Nexus in Vortex lets it go next time."
                  : "Saved here, but Nexus did not accept the vote.",
            });
          }
          if (answer === "worked") {
            setFeedback({
              kind: "offer-endorse",
              entry,
              endorsableHere: await canEndorseHere(entry),
            });
          } else {
            setFeedback({ kind: "thanks-no", entry });
          }
        } finally {
          setFeedbackBusy(false);
        }
      })();
    },
    [api, canEndorseHere, feedback, recordFeedback, showToast],
  );

  const onFeedbackDismiss = React.useCallback((): void => {
    void recordFeedback({ dismissed: true });
    setFeedback({ kind: "idle" });
  }, [recordFeedback]);

  const onFeedbackEndorse = React.useCallback((): void => {
    if (feedback.kind !== "offer-endorse") return;
    const entry = feedback.entry;
    if (entry.collectionId === undefined) return;
    setFeedbackBusy(true);
    void (async (): Promise<void> => {
      try {
        const { endorseCollection } = await import("../runtime/collectionRating");
        const out = endorseCollection(api, {
          gameId: entry.gameDomain,
          collectionId: entry.collectionId!,
        });
        if (out.kind === "endorsed") {
          const [{ loadFeedback, noteEndorsed, saveFeedback }, { getEventHorizonRoot }] =
            await Promise.all([
              import("../../core/feedback/collectionFeedback"),
              import("../../core/paths/appDataPaths"),
            ]);
          const root = getEventHorizonRoot();
          if (feedbackId !== undefined) {
            await saveFeedback(
              root,
              noteEndorsed(await loadFeedback(root), feedbackId, new Date().toISOString()),
            );
          }
          showToast({ intent: "success", message: "Endorsed. Thank you." });
        } else {
          showToast({
            intent: "info",
            message: "Vortex could not endorse from here — the collection's page can.",
          });
        }
        setFeedback({ kind: "idle" });
      } finally {
        setFeedbackBusy(false);
      }
    })();
  }, [api, feedback, feedbackId, showToast]);

  const onFeedbackOpenPage = React.useCallback((): void => {
    if (feedback.kind === "idle") return;
    const entry = feedback.entry;
    void (async (): Promise<void> => {
      const { collectionPageUrl } = await import("../runtime/collectionRating");
      api.events.emit("open-url", collectionPageUrl(entry.gameDomain, entry.slug));
      setFeedback({ kind: "idle" });
    })();
  }, [api, feedback]);
  // Whether an install is running RIGHT NOW — see the interrupted panel below.
  const { installBusy } = useEHRuntime();

  const [state, setState] = React.useState<PageState>({ kind: "loading" });
  const [uninstalling, setUninstalling] = React.useState<InstallReceipt | undefined>(undefined);
  const [selected, setSelected] = React.useState<InstallReceipt | undefined>(
    undefined,
  );
  const [refreshTick, setRefreshTick] = React.useState(0);
  const [query, setQuery] = React.useState("");
  const [sortKey, setSortKey] = React.useState<SortKey>("recent");
  // How each installed collection presents itself, as its install preview
  // extracted it. Loaded after the list; a collection without one looks plain.
  const [presentations, setPresentations] = React.useState<
    ReadonlyMap<string, ShownPresentation>
  >(new Map());
  const loadedReceipts = state.kind === "loaded" ? state.receipts : undefined;
  React.useEffect(() => {
    if (loadedReceipts === undefined || loadedReceipts.length === 0) return undefined;
    let alive = true;
    void (async (): Promise<void> => {
      const cacheRoot = getEventHorizonDir("presentation");
      const found = new Map<string, ShownPresentation>();
      for (const r of loadedReceipts) {
        const shown = await loadCachedPresentation(cacheRoot, r.packageId, r.packageVersion).catch(
          () => undefined,
        );
        if (shown !== undefined) found.set(r.packageId, shown);
      }
      if (alive) setPresentations(found);
    })();
    return (): void => {
      alive = false;
    };
  }, [loadedReceipts]);

  const refresh = React.useCallback((): void => {
    setRefreshTick((t) => t + 1);
  }, []);

  // Newer Nexus revisions of these collections, as the last check found them.
  // The check itself runs at Vortex startup; a visit re-asks at most every few
  // minutes, so opening this page is never what hammers Nexus.
  const [updates, setUpdates] = React.useState<ReadonlyMap<string, CollectionUpdate>>(
    () => getCollectionUpdateStore().all(),
  );
  React.useEffect(() => getCollectionUpdateStore().subscribe(setUpdates), []);
  React.useEffect(() => {
    if (loadedReceipts === undefined) return;
    if (!loadedReceipts.some((r) => r.nexusCollection !== undefined)) return;
    // Logged, not raised: a background check the player did not ask for must
    // not put an error dialog over the page they did open.
    checkCollectionUpdates(api, { notify: false }).catch((err: unknown) => {
      ehLog("warn", "collection-updates.page-check-failed", { err });
    });
  }, [api, loadedReceipts]);


  /**
   * Re-run the install for a collection already on this machine.
   *
   * There is no "resume" state to restore, and that is the design rather than
   * a shortfall: the installer re-resolves every mod against what is actually
   * on disk, by Nexus id and hash. So it finds what is missing, skips what is
   * already correct, and picks up where the last run stopped — without
   * trusting any record of what a previous run believed it had done.
   *
   * The point of the button is that the user does not have to go and find the
   * .ehcoll again to get that. We already know which package this receipt came
   * from; asking them to re-import a file we can locate ourselves is the kind
   * of small indignity that makes a tool feel unfinished.
   */
  const handleContinueInstall = React.useCallback(
    async (receipt: InstallReceipt): Promise<void> => {
      try {
        const [{ locateCollectionPackage }, { getInstallSession }] =
          await Promise.all([
            import("../../core/manifest/locatePackage"),
            import("./install/installSession"),
          ]);
        let target = await locateCollectionPackage({
          packageId: receipt.packageId,
          packageName: receipt.packageName,
          packageVersion: receipt.packageVersion,
          // So a kept copy of an OLDER revision that shares this version
          // string is refused rather than repaired from.
          ...(receipt.nexusCollection?.revisionNumber !== undefined
            ? { revisionNumber: receipt.nexusCollection.revisionNumber }
            : {}),
        });

        if (target === undefined) {
          // Not in the collections folder — it may never have been built on
          // this machine. Ask rather than give up.
          const { pickEhcollFile } = await import("../../utils/utils");
          const picked = await pickEhcollFile(api);
          if (picked === undefined) return;
          target = { path: picked, fileName: picked, source: "found" };
        }

        setSelected(undefined);
        getInstallSession().pickFile(api, target.path);
        props.onNavigate("install");
      } catch (err) {
        reportError(err, {
          title: "Couldn't reopen this collection's package",
          context: { step: "continue-install", packageId: receipt.packageId },
        });
      }
    },
    [api, props, reportError],
  );

  React.useEffect(() => {
    let alive = true;
    void (async (): Promise<void> => {
      setState({ kind: "loading" });
      try {
        const errors: Array<{ filename: string; message: string }> = [];
        const appData = getVortexUserDataPath();
        const receipts = await listReceipts(appData, (filename, err) => {
          errors.push({ filename, message: err.message });
        });
        // Never fatal: an unreadable marker directory must not hide the
        // collections that ARE installed.
        // `appData`, NOT `getMarkerDir(appData)`: the function joins the
        // marker directory itself, so passing an already-resolved one looked
        // for `…/in-progress/event-horizon/installs/in-progress`, which never
        // exists. `readdir` threw, the catch below returned [], and the
        // "an install was interrupted" banner could not appear for anyone.
        const interrupted = await listInterruptedInstalls(appData).catch(
          () => [] as InstallMarker[],
        );
        const failedAttempts = await listInstallAttempts(appData).catch(
          () => [] as InstallAttempt[],
        );
        if (!alive) return;
        if (
          receipts.length === 0 &&
          errors.length === 0 &&
          interrupted.length === 0 &&
          failedAttempts.length === 0
        ) {
          setState({ kind: "empty" });
        } else {
          setState({
            kind: "loaded",
            receipts,
            interrupted,
            failedAttempts,
            errors,
          });
        }
      } catch (err) {
        if (!alive) return;
        reportError(err, {
          title: "Couldn't list installed collections",
          context: { step: "collections-list" },
        });
        setState({
          kind: "loaded",
          receipts: [],
          interrupted: [],
          failedAttempts: [],
          errors: [],
        });
      }
    })();
    return (): void => {
      alive = false;
    };
  }, [refreshTick, reportError]);

  const activeProfileId =
    api.getState().settings?.profiles?.activeProfileId;

  // Apply search + sort to the loaded receipts. Memoised because the
  // grid below re-renders on every keystroke into the search box.
  const visibleReceipts = React.useMemo<InstallReceipt[]>(() => {
    if (state.kind !== "loaded") return [];
    const q = query.trim().toLowerCase();
    const filtered =
      q.length === 0
        ? state.receipts
        : state.receipts.filter((r) =>
            // Match name OR game id OR profile name. Searching by
            // profile name lets users find "the collection in <Skyrim
            // playthrough X>" without remembering its title.
            [r.packageName, r.gameId, r.vortexProfileName]
              .some((s) => s.toLowerCase().includes(q)),
          );
    const out = [...filtered];
    switch (sortKey) {
      case "recent":
        out.sort(
          (a, b) =>
            new Date(b.installedAt).getTime() -
            new Date(a.installedAt).getTime(),
        );
        break;
      case "name":
        out.sort((a, b) =>
          a.packageName.localeCompare(b.packageName, undefined, {
            sensitivity: "base",
          }),
        );
        break;
      case "mods":
        out.sort((a, b) => b.mods.length - a.mods.length);
        break;
    }
    return out;
  }, [state, query, sortKey]);

  if (state.kind === "loading") {
    return (
      <div className="eh-page">
        <Section title="Loading installed collections...">
          <Card>
            <div className="eh-row eh-row--lg">
              <ProgressRing size={56} />
              <span className="eh-secondary">
                Scanning %APPDATA%/Vortex/event-horizon/installs/
              </span>
            </div>
          </Card>
        </Section>
      </div>
    );
  }

  if (state.kind === "empty") {
    return (
      <div className="eh-page">
        <EmptyState
          icon={<EventHorizonLogo size={88} />}
          title="No collections yet"
          actions={
            <Button
              intent="primary"
              onClick={(): void => props.onNavigate("install")}
            >
              Install a collection
            </Button>
          }
        >
          Install your first .ehcoll collection and Event Horizon will keep a
          receipt here so you can switch profiles, inspect the mod list, or
          uninstall in a single click.
        </EmptyState>
      </div>
    );
  }

  return (
    <div className="eh-page">
      {/*
        ─── NOT WHILE ONE IS ACTUALLY RUNNING ──────────────────────────────
        An `InstallMarker` is written when the run starts and cleared when it
        ends, and it carries no pid, no session token and no heartbeat — so
        the marker of a run that is HAPPILY IN PROGRESS is byte-identical to
        one left by a crash. Forty minutes into a 1,755-mod install this panel
        told the user "Installing X was interrupted 40 minutes ago — Vortex
        closed before it finished" and offered them a "Run the install again"
        button, which is how you get two concurrent installs of one collection
        — the shape sequential installation exists to prevent.

        `installBusy` is the live answer, and it is already tracked; it simply
        was not consulted here.
      */}
      <DidItWorkPrompt
        state={feedback}
        busy={feedbackBusy}
        onAnswer={onFeedbackAnswer}
        onDismiss={onFeedbackDismiss}
        onEndorse={onFeedbackEndorse}
        onOpenPage={onFeedbackOpenPage}
        onSendLogs={(): void => {
          // The bundle tool already exists on the Doctor page; sending them
          // there beats a second copy of a flow that works.
          setFeedback({ kind: "idle" });
          props.onNavigate("doctor");
        }}
      />
      {!installBusy && (
        <InterruptedInstalls
          markers={state.interrupted}
          onResume={(): void => props.onNavigate("install")}
        />
      )}
      <FailedAttempts
        attempts={state.failedAttempts}
        onRetry={(): void => props.onNavigate("install")}
      />
      <Section
        className="eh-section--page"
        title="Installed collections"
        description={
          <>
            {state.receipts.length} collection{state.receipts.length === 1 ? "" : "s"} on this machine
            {query.trim().length > 0 &&
              ` · showing ${visibleReceipts.length}`}
            .
          </>
        }
        actions={
          <>
            <Button intent="ghost" onClick={refresh}>
              Refresh
            </Button>
            <Button
              intent="primary"
              onClick={(): void => props.onNavigate("install")}
            >
              Install another
            </Button>
          </>
        }
      >
        {state.receipts.length > 1 && (
          <div className="eh-row">
            <Input
              type="search"
              value={query}
              onChange={(e): void => setQuery(e.target.value)}
              placeholder="Search by name, game, or profile..."
              aria-label="Filter installed collections"
              className="eh-fill"
            />
            <Field label="Sort:" inline>
              {(id): JSX.Element => (
                <Select
                  id={id}
                  value={sortKey}
                  onChange={(e): void => setSortKey(e.target.value as SortKey)}
                  aria-label="Sort installed collections"
                  auto
                >
                  <option value="recent">Most recent</option>
                  <option value="name">Name (A → Z)</option>
                  <option value="mods">Mod count (high → low)</option>
                </Select>
              )}
            </Field>
          </div>
        )}

        {state.errors.length > 0 && (
          <Callout
            tone="danger"
            title={`${state.errors.length} receipt${state.errors.length === 1 ? "" : "s"} failed to load.`}
          >
            <ul className="eh-list">
              {state.errors.slice(0, 5).map((e) => (
                <li key={e.filename}>
                  {e.filename}: {e.message}
                </li>
              ))}
            </ul>
          </Callout>
        )}

        {visibleReceipts.length === 0 && state.receipts.length > 0 ? (
          <EmptyState
            title={
              <>
                No collections match{" "}
                <strong className="eh-strong">&quot;{query}&quot;</strong>.
              </>
            }
            actions={
              <Button intent="ghost" onClick={(): void => setQuery("")}>
                Clear search
              </Button>
            }
          />
        ) : (
          <div className="eh-grid" style={{ ["--eh-grid-min" as string]: "320px" }}>
            {visibleReceipts.map((receipt) => (
              <ReceiptCard
                key={receipt.packageId}
                receipt={receipt}
                isActive={receipt.vortexProfileId === activeProfileId}
                onOpen={(): void => setSelected(receipt)}
                onUninstall={(): void => setUninstalling(receipt)}
                presentation={presentations.get(receipt.packageId)}
                update={pendingUpdateFor(receipt, updates.get(receipt.packageId))}
                onUpdate={(update): void => {
                  void startCollectionUpdate(api, update);
                }}
              />
            ))}
          </div>
        )}
      </Section>

      <ReceiptDetailModal
        presentation={selected !== undefined ? presentations.get(selected.packageId) : undefined}
        receipt={selected}
        onContinueInstall={(receipt): void => {
          void handleContinueInstall(receipt);
        }}
        onClose={(): void => setSelected(undefined)}
        onUninstall={(receipt): void => {
          setSelected(undefined);
          setUninstalling(receipt);
        }}
      />

      <CollectionUninstallModal
        receipt={uninstalling}
        onClose={(): void => setUninstalling(undefined)}
        onFinished={(outcome): void => {
          setUninstalling(undefined);
          showToast({
            intent: outcome.failed.length > 0 ? "warning" : "success",
            message:
              outcome.failed.length > 0
                ? `Removed ${outcome.removed.length} mod(s); ${outcome.failed.length} could not be removed.`
                : `Collection uninstalled: ${outcome.removed.length} mod(s) removed.`,
          });
          refresh();
        }}
      />
    </div>
  );
}

// ===========================================================================
// Card
// ===========================================================================

/** Exported for the render harness. */
export function ReceiptCard(props: {
  receipt: InstallReceipt;
  isActive: boolean;
  onOpen: () => void;
  /** How the collection presents itself, when this machine has it. */
  presentation?: ShownPresentation | undefined;
  /** A newer revision on Nexus, when the last check found one. */
  update?: CollectionUpdate | undefined;
  onUpdate?: (update: CollectionUpdate) => void;
  /** Uninstall straight from the card, without opening the details. */
  onUninstall?: () => void;
}): JSX.Element {
  const { receipt, isActive, onOpen, presentation, update } = props;
  const tile = presentation?.tile;
  return (
    <Card
      onClick={onOpen}
      {...(presentation?.theme?.accent !== undefined
        ? {
            className: "eh-card--themed",
            style: themeVariables(presentation.theme) as React.CSSProperties,
          }
        : {})}
      title={receipt.packageName}
      footer={
        <span className="eh-muted">
          installed {new Date(receipt.installedAt).toLocaleDateString()}
        </span>
      }
    >
      <div className="eh-row eh-row--nowrap">
      {tile !== undefined && <img className="eh-card__media" src={tile.url} alt="" />}
      <div className="eh-stack eh-stack--sm eh-body eh-fill">
        <div className="eh-row">
          {/* First, so the one card whose profile Vortex is on is found at a glance. */}
          {isActive && (
            <Pill intent="success" withDot>
              active
            </Pill>
          )}
          <Pill intent="info">v{receipt.packageVersion}</Pill>
          {/*
            Only an install from a collection page knows its revision, and only
            those are checked for updates — so this pill is also the answer to
            "why does this collection never offer an update".
          */}
          {receipt.nexusCollection !== undefined && (
            <Pill intent="neutral">rev {receipt.nexusCollection.revisionNumber}</Pill>
          )}
          <Pill intent="neutral">{receipt.gameId}</Pill>
          <Pill intent="neutral" title={installModeLabel(receipt.installTargetMode).title}>
            {installModeLabel(receipt.installTargetMode).short}
          </Pill>
        </div>
        <div>
          <strong>Profile:</strong> {receipt.vortexProfileName}
        </div>
        <div className="eh-row">
          <span>
            <strong>Mods:</strong> {receipt.mods.length}
          </span>
          {/*
            A receipt is also written by a run that did not finish — 978 mods
            with provenance beat 978 mods with none (NS-2). Both facts were
            recorded and rendered nowhere, so a partial install looked exactly
            like a complete one and the only place it was ever said was the
            Done screen the user then closed.
          */}
          {(receipt.failedMods?.length ?? 0) > 0 && (
            <span
              title={receipt.failedMods
                ?.map((m) => `${m.name} — ${m.reason}`)
                .join("\n")}
            >
              <Pill intent="warning" plain>
                {receipt.failedMods?.length} could not be installed
              </Pill>
            </span>
          )}
          {(receipt.finishingSkipped?.length ?? 0) > 0 && (
            <span
              title={`Not applied: ${receipt.finishingSkipped?.join(", ")}`}
            >
              <Pill intent="warning" plain>
                stopped before finishing
              </Pill>
            </span>
          )}
        </div>
        {((update !== undefined && props.onUpdate !== undefined) || props.onUninstall !== undefined) && (
          <div className="eh-row">
            {update !== undefined && props.onUpdate !== undefined && (
            <Button
              intent="primary"
              size="sm"
              onClick={(event): void => {
                // The whole card opens the details; this button must not.
                event.stopPropagation();
                props.onUpdate?.(update);
              }}
            >
              Update to revision {update.latestRevision}
            </Button>
            )}
            {props.onUninstall !== undefined && (
              <Button
                intent="ghost"
                size="sm"
                onClick={(event): void => {
                  // The whole card opens the details; this button must not.
                  event.stopPropagation();
                  props.onUninstall?.();
                }}
              >
                Uninstall
              </Button>
            )}
          </div>
        )}
      </div>
      </div>
    </Card>
  );
}

// ===========================================================================
// Detail modal
// ===========================================================================

function ReceiptDetailModal(props: {
  receipt: InstallReceipt | undefined;
  onClose: () => void;
  /** Open the uninstall dialog for this collection. */
  onUninstall: (receipt: InstallReceipt) => void;
  /** Hand this package back to the installer and go there. */
  onContinueInstall: (receipt: InstallReceipt) => void;
  /** How the collection presents itself, when this machine has it. */
  presentation?: ShownPresentation | undefined;
}): JSX.Element {
  const { receipt, onClose, presentation } = props;
  const api = useApi();
  const reportError = useErrorReporter();
  const showToast = useToast();

  const [busy, setBusy] = React.useState(false);

  const handleExportDiagnostic = async (): Promise<void> => {
    if (receipt === undefined) return;
    setBusy(true);
    try {
      const saved = await saveDiagnosticReport(api, receipt);
      if (saved) {
        showToast({
          intent: "success",
          message: "Diagnostic saved.",
        });
      }
    } catch (err) {
      reportError(err, {
        title: "Couldn't export diagnostic",
        context: {
          step: "export-diagnostic",
          packageId: receipt.packageId,
        },
      });
    } finally {
      setBusy(false);
    }
  };

  const handleSwitchProfile = async (): Promise<void> => {
    if (receipt === undefined) return;
    setBusy(true);
    try {
      await switchToProfile(api, receipt.vortexProfileId);
      showToast({
        intent: "success",
        message: `Switched to profile "${receipt.vortexProfileName}".`,
      });
      onClose();
    } catch (err) {
      reportError(err, {
        title: "Couldn't switch profile",
        context: {
          step: "switch-profile",
          profileId: receipt.vortexProfileId,
        },
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={receipt !== undefined}
      onClose={(): void => {
        if (busy) return;
        onClose();
      }}
      size="lg"
      title={receipt?.packageName ?? ""}
      subtitle={
        receipt !== undefined
          ? `v${receipt.packageVersion} · ${receipt.gameId}`
          : undefined
      }
      footer={
        receipt !== undefined && (
          <>
            <PlayGameButton gameId={receipt.gameId} />
            <Button
              intent="danger"
              disabled={busy}
              onClick={(): void => props.onUninstall(receipt)}
            >
              Uninstall
            </Button>
            <Button
              intent="ghost"
              disabled={busy}
              onClick={(): void => {
                void handleSwitchProfile();
              }}
            >
              Switch to profile
            </Button>
            <Button
              intent="ghost"
              disabled={busy}
              title={
                "Re-runs the install against this collection. Mods already " +
                "correct are skipped, so it only fetches what is missing."
              }
              onClick={(): void => props.onContinueInstall(receipt)}
            >
              Check and continue
            </Button>
            <Button
              intent="ghost"
              disabled={busy}
              onClick={(): void => {
                void handleExportDiagnostic();
              }}
              title="Save a JSON diagnostic with this receipt + version metadata. Useful to attach to bug reports."
            >
              Export diagnostic
            </Button>
            <Button intent="primary" onClick={onClose} disabled={busy}>
              Close
            </Button>
          </>
        )
      }
    >
      {receipt !== undefined && (
        <div
          className="eh-stack eh-stack--lg"
        >
          {hasBanner(presentation) && (
            <CollectionBanner
              name={receipt.packageName}
              version={receipt.packageVersion}
              presentation={presentation}
            />
          )}
          <StatGrid min={180}>
            <StatTile
              label="Profile"
              value={receipt.vortexProfileName}
              sub={`id ${receipt.vortexProfileId}`}
              subMono
            />
            <StatTile
              label="Installed into"
              value={installModeLabel(receipt.installTargetMode).long}
            />
            <StatTile
              label="Installed at"
              value={new Date(receipt.installedAt).toLocaleString()}
            />
            <StatTile
              label="Mod count"
              value={String(receipt.mods.length)}
            />
          </StatGrid>

          <Section title="Mods recorded" count={receipt.mods.length} size="sm">
            <ul className="eh-list-box">
              {receipt.mods.map((m) => (
                <li key={m.vortexModId} className="eh-row eh-row--split">
                  <span className="eh-strong">
                    {m.name}
                  </span>
                  <span className="eh-mono eh-muted">
                    {m.source} · {m.vortexModId}
                  </span>
                </li>
              ))}
            </ul>
          </Section>

        </div>
      )}

    </Modal>
  );
}

// ===========================================================================
// Diagnostic export
// ===========================================================================

interface MinimalElectronDialog {
  showSaveDialog: (
    opts: Record<string, unknown>,
  ) => Promise<{ canceled: boolean; filePath?: string }>;
}
interface MinimalElectronModule {
  remote?: { dialog?: MinimalElectronDialog };
  dialog?: MinimalElectronDialog;
}

/** Build a self-contained diagnostic JSON for a receipt and prompt
 * the user to save it. We bundle the full receipt + a metadata block
 * (Event Horizon version, OS, timestamp) so a bug report attachment
 * is enough on its own — no follow-up "what's your version" pings.
 *
 * Returns true if the user actually picked a path and we wrote to
 * disk; false if they cancelled the dialog.
 *
 * Throws on real I/O errors so the caller's reportError can pick
 * them up. Cancellation is NOT an error. */
async function saveDiagnosticReport(
  api: types.IExtensionApi,
  receipt: InstallReceipt,
): Promise<boolean> {
  // Vortex's own picker. `electron.remote` was removed in Electron 14 and
  // `dialog` is main-process-only, so the previous route could not work in a
  // renderer — it threw instead of saving, on the button whose entire job is
  // getting diagnostics to someone who can read them.

  const sanitized = receipt.packageName
    .replace(/[<>:"\\/|?*\x00-\x1f]/g, "_")
    .slice(0, 60)
    .trim();
  const stamp = new Date()
    .toISOString()
    .replace(/[:.]/g, "-")
    .slice(0, 19);
  const defaultName = `event-horizon-diagnostic-${sanitized}-${stamp}.json`;

  const filePath = await api.saveFile({
    title: "Export Event Horizon diagnostic",
    defaultPath: defaultName,
    filters: [
      { name: "JSON", extensions: ["json"] },
      { name: "All files", extensions: ["*"] },
    ],
  });
  if (filePath === undefined || filePath.length === 0) return false;

  const payload = {
    schema: "event-horizon.diagnostic/1",
    generatedAt: new Date().toISOString(),
    extension: {
      name: "vortex-event-horizon",
      version: EXTENSION_VERSION,
    },
    host: {
      // `process.platform` reports "win32" under Proton, because Vortex there
      // IS a Windows process. That made every Linux tester's report claim
      // Windows — the most misleading field a remote diagnosis can carry, and
      // it cost days on the 7z investigation before anyone thought to ask.
      platform: describeHostPlatform(),
      nodeVersion:
        typeof process !== "undefined" ? process.version : "unknown",
      // Trim user-agent to avoid leaking arbitrary auth state, just
      // keep the major Electron + Chrome version string.
      userAgent:
        typeof navigator !== "undefined"
          ? navigator.userAgent.slice(0, 240)
          : "unknown",
    },
    receipt,
  };

  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const fsp = require("fs/promises") as typeof import("fs/promises");
  await fsp.writeFile(
    filePath,
    JSON.stringify(payload, null, 2),
    { encoding: "utf-8" },
  );
  return true;
}

/**
 * The host OS as a human would describe it.
 *
 * Never throws: this feeds an ERROR REPORT, and a diagnostic that fails while
 * describing a failure leaves the reader with nothing.
 */
function describeHostPlatform(): string {
  if (typeof process === "undefined") return "unknown";
  const base = process.platform;
  try {
    // process.platform says "win32" under Proton too; the Proton service knows.
    return looksLikeWine() ? `${base} (Wine/Proton)` : base;
  } catch {
    // Probe unavailable — report the plain platform rather than nothing.
    return base;
  }
}