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
 *   - Uninstall (remove all recorded mods + delete the receipt).
 *
 * The page never edits a receipt directly — it only reads, deletes,
 * and acts on profiles. Receipts are written exclusively by the
 * install driver.
 */

import * as React from "react";
import { util } from "@nexusmods/vortex-api";
import type { types } from "@nexusmods/vortex-api";

import {
  deleteReceipt,
  listReceipts,
} from "../../core/installLedger";
import { ehLog } from "../../core/logging/ehLog";
import { uninstallMod } from "../../core/installer/modInstall";
import { enableModInProfile } from "../../core/installer/profile";
import { switchToProfile } from "../../core/installer/profile";
import type { InstallReceipt } from "../../types/installLedger";
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
import { useEHRuntime } from "../runtime/useEHRuntime";
import { EXTENSION_VERSION } from "../version";
import { getVortexUserDataPath } from "../../core/paths";
import { PlayGameButton } from "../play/PlayGameButton";

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
  // Whether an install is running RIGHT NOW — see the interrupted panel below.
  const { installBusy } = useEHRuntime();

  const [state, setState] = React.useState<PageState>({ kind: "loading" });
  const [selected, setSelected] = React.useState<InstallReceipt | undefined>(
    undefined,
  );
  const [refreshTick, setRefreshTick] = React.useState(0);
  const [query, setQuery] = React.useState("");
  const [sortKey, setSortKey] = React.useState<SortKey>("recent");

  const refresh = React.useCallback((): void => {
    setRefreshTick((t) => t + 1);
  }, []);

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
          packageName: receipt.packageName,
          packageVersion: receipt.packageVersion,
        });

        if (target === undefined) {
          // Not in the collections folder — it may never have been built on
          // this machine. Ask rather than give up.
          const { pickEhcollFile } = await import("../../utils/utils");
          const picked = await pickEhcollFile(api);
          if (picked === undefined) return;
          target = { path: picked, fileName: picked };
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
              />
            ))}
          </div>
        )}
      </Section>

      <ReceiptDetailModal
        receipt={selected}
        onContinueInstall={(receipt): void => {
          void handleContinueInstall(receipt);
        }}
        onClose={(): void => setSelected(undefined)}
        onUninstalled={(): void => {
          setSelected(undefined);
          showToast({
            intent: "success",
            message: "Collection uninstalled. Receipt deleted.",
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

function ReceiptCard(props: {
  receipt: InstallReceipt;
  isActive: boolean;
  onOpen: () => void;
}): JSX.Element {
  const { receipt, isActive, onOpen } = props;
  return (
    <Card
      onClick={onOpen}
      title={receipt.packageName}
      footer={
        <span className="eh-muted">
          installed {new Date(receipt.installedAt).toLocaleDateString()}
        </span>
      }
    >
      <div className="eh-stack eh-stack--sm eh-body">
        <div className="eh-row">
          <Pill intent="info">v{receipt.packageVersion}</Pill>
          <Pill intent="neutral">{receipt.gameId}</Pill>
          {receipt.installTargetMode === "fresh-profile" ? (
            <Pill intent="info">fresh profile</Pill>
          ) : (
            <Pill intent="warning">current profile</Pill>
          )}
          {isActive && (
            <Pill intent="success" withDot>
              active
            </Pill>
          )}
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
  onUninstalled: () => void;
  /** Hand this package back to the installer and go there. */
  onContinueInstall: (receipt: InstallReceipt) => void;
}): JSX.Element {
  const { receipt, onClose, onUninstalled } = props;
  const api = useApi();
  const reportError = useErrorReporter();
  const showToast = useToast();

  const [busy, setBusy] = React.useState(false);
  const [confirmingUninstall, setConfirmingUninstall] = React.useState(false);
  const [progress, setProgress] = React.useState<{
    current: number;
    total: number;
  } | null>(null);

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

  const handleUninstall = async (): Promise<void> => {
    if (receipt === undefined) return;
    /**
     * ─── ONLY MODS WE PUT HERE (NS-2) ──────────────────────────────────────
     * This loop used to walk `receipt.mods` whole. But the receipt describes
     * what the collection CONTROLS, not what it created: an
     * `*-already-installed` decision records the USER'S own Vortex mod id, so
     * on a real 1,755-mod install 1,591 of those rows were mods Event Horizon
     * never installed. "Uninstall this collection" would have deleted every
     * one of them.
     *
     * `ownership` is absent on receipts written before it existed, and absent
     * means UNKNOWN — which is treated as theirs. That leaves an old receipt
     * uninstalling nothing, and that is the right way round: the remedy for
     * being too careful is a message, and the remedy for deleting someone's
     * 1,591 mods is nothing at all.
     */
    const ours = receipt.mods.filter((m) => m.ownership === "installed");
    const notOurs = receipt.mods.length - ours.length;
    ehLog("info", "collection.uninstall.start", {
      packageId: receipt.packageId,
      total: receipt.mods.length,
      willRemove: ours.length,
      leftAlone: notOurs,
      unknownOwnership: receipt.mods.filter((m) => m.ownership === undefined)
        .length,
    });
    /**
     * ─── NOTHING TO REMOVE IS AN ANSWER, NOT A NO-OP ────────────────────
     * `ownership` is absent on every receipt written before alpha.111, and
     * absent means UNKNOWN, which this correctly treats as theirs (NS-2). So
     * on a legacy receipt `ours` is empty — and the handler used to run an
     * empty loop, DELETE THE RECEIPT anyway, and close the modal. The user
     * had just been told 1,755 mods would be removed; nothing was; the
     * collection vanished from the list; and the receipt — the only record
     * linking those 1,755 mods to this collection, and after the ownership
     * fix the only surviving provenance — was gone.
     *
     * The docblock above already said "the remedy for being too careful is a
     * message". This is that message.
     */
    if (ours.length === 0) {
      ehLog("warn", "collection.uninstall.refused-nothing-ours", {
        packageId: receipt.packageId,
        total: receipt.mods.length,
      });
      reportError(
        new Error(
          `This receipt records ${receipt.mods.length} mod(s) but does not say ` +
            `which of them Event Horizon installed, so none can be safely ` +
            `removed — every one of them may be a mod you already had. ` +
            `Receipts written before this tracking existed are in that state. ` +
            `Re-installing the collection produces a receipt that records it, ` +
            `and the receipt has been LEFT IN PLACE so nothing is lost.`,
        ),
        {
          title: "Nothing can be safely uninstalled",
          context: { step: "uninstall", packageId: receipt.packageId },
        },
      );
      setBusy(false);
      return;
    }

    setBusy(true);
    setProgress({ current: 0, total: ours.length });
    try {
      let i = 0;
      /**
       * Counted, not swallowed. Every failure used to be logged and forgotten,
       * and the receipt was deleted anyway on the `notOurs === 0` branch — so
       * a staging drive going offline mid-uninstall left hundreds of mods on
       * disk with the only record of where they came from gone. The refusal
       * above exists precisely so losing provenance is never silent.
       */
      let failed = 0;
      let restored = 0;
      for (const mod of ours) {
        i += 1;
        setProgress({ current: i, total: ours.length });
        try {
          await uninstallMod(api, {
            gameId: receipt.gameId,
            modId: mod.vortexModId,
          });
          /**
           * ─── GIVE THE USER THEIR OWN MOD BACK ─────────────────────────
           * When a mirrored mod was one the user already owned, the install
           * put the curator's copy beside theirs and switched theirs OFF in
           * this profile. Removing our copy without undoing that leaves them
           * with NEITHER active: their mod still installed, still listed, and
           * silently disabled in the profile they play.
           *
           * Only after the removal succeeded — re-enabling a mod while ours
           * is still there would put two copies of the same mod in one
           * profile, which is the conflict the swap exists to avoid.
           */
          if (mod.displacedModId !== undefined) {
            enableModInProfile(
              api,
              receipt.vortexProfileId,
              mod.displacedModId,
            );
            restored += 1;
          }
        } catch (err) {
          // Continue removing the rest — record per-mod failures, finalize
          // by reporting once at the end.
          failed += 1;
          ehLog("warn", "collection.uninstall.mod-failed", {
            name: mod.name,
            vortexModId: mod.vortexModId,
            err,
          });
        }
      }
      if (restored > 0) {
        ehLog("info", "collection.uninstall.displaced-restored", {
          restored,
          profileId: receipt.vortexProfileId,
          why:
            "these mods were the user's own copies, switched off when the " +
            "collection installed its own beside them",
        });
      }
      const appData = getVortexUserDataPath();
      /**
       * Only when the receipt no longer describes anything on disk.
       *
       * Mods left alone are mods the user still has, and this file is the one
       * thing that can identify them as belonging to this collection later.
       * Deleting it while any of them survive throws away the ability to
       * answer "where did these come from" for good.
       */
      if (notOurs === 0 && failed === 0) {
        await deleteReceipt(appData, receipt.packageId);
      } else {
        ehLog("info", "collection.uninstall.receipt-kept", {
          packageId: receipt.packageId,
          removed: ours.length - failed,
          leftAlone: notOurs,
          failed,
          why:
            failed > 0
              ? "some mods could not be removed and are still on disk; this " +
                "receipt is the only record of where they came from"
              : "mods this receipt covers are still installed, and it is the " +
                "only record of where they came from",
        });
      }
      if (failed > 0) {
        // The outer catch never fires for these — each one was caught in the
        // loop — so without this the user sees a clean finish for an
        // uninstall that left mods behind.
        reportError(
          new Error(
            `${failed} of ${ours.length} mod(s) could not be removed. They ` +
              `are still installed, and this collection has been kept in the ` +
              `list so you can try again.`,
          ),
          { title: "Uninstall incomplete" },
        );
      }
      onUninstalled();
    } catch (err) {
      reportError(err, {
        title: "Uninstall partially failed",
        context: {
          step: "uninstall",
          packageId: receipt.packageId,
        },
      });
    } finally {
      setBusy(false);
      setProgress(null);
      setConfirmingUninstall(false);
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
              onClick={(): void => setConfirmingUninstall(true)}
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
          <StatGrid min={180}>
            <StatTile
              label="Profile"
              value={receipt.vortexProfileName}
              sub={`id ${receipt.vortexProfileId}`}
              subMono
            />
            <StatTile
              label="Mode"
              value={
                receipt.installTargetMode === "fresh-profile"
                  ? "Fresh profile"
                  : "Current profile"
              }
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

          {progress !== null && (
            <div className="eh-inset eh-body">
              Uninstalling... {progress.current} / {progress.total}
            </div>
          )}
        </div>
      )}

      <UninstallConfirmModal
        open={confirmingUninstall}
        receipt={receipt}
        onCancel={(): void => setConfirmingUninstall(false)}
        onConfirm={(): void => {
          void handleUninstall();
        }}
        busy={busy}
      />
    </Modal>
  );
}

function UninstallConfirmModal(props: {
  open: boolean;
  receipt: InstallReceipt | undefined;
  onCancel: () => void;
  onConfirm: () => void;
  busy: boolean;
}): JSX.Element {
  return (
    <Modal
      open={props.open && props.receipt !== undefined}
      onClose={props.onCancel}
      size="sm"
      title="Uninstall this collection?"
      footer={
        <>
          <Button intent="ghost" onClick={props.onCancel} disabled={props.busy}>
            Cancel
          </Button>
          <Button
            intent="danger"
            onClick={props.onConfirm}
            disabled={props.busy}
          >
            Yes, uninstall
          </Button>
        </>
      }
    >
      <p className="eh-body">
        {(() => {
          /**
           * The number that used to be here was `receipt.mods.length` — every
           * mod in the receipt — while the handler removes only the ones
           * Event Horizon actually INSTALLED. On a real 1,755-mod install
           * that is 1,755 promised against 164 removed, and on a receipt
           * written before ownership was tracked it is 1,755 against none.
           *
           * A confirmation dialog is a promise about what the button does.
           */
          const mods = props.receipt?.mods ?? [];
          const ours = mods.filter((m) => m.ownership === "installed").length;
          const theirs = mods.length - ours;
          if (mods.length === 0) return "This receipt records no mods.";
          if (ours === 0) {
            return (
              `This receipt records ${mods.length} mod(s) but does not say which ` +
              `of them Event Horizon installed, so NONE will be removed — each ` +
              `one may be a mod you already had. The receipt will be kept.`
            );
          }
          return (
            `Event Horizon will remove the ${ours} mod(s) it installed for this ` +
            `collection.` +
            (theirs > 0
              ? ` The other ${theirs} were already on your machine and will be ` +
                `left exactly as they are, along with the receipt that records ` +
                `them.`
              : ` The receipt file will be deleted.`) +
            ` The Vortex profile itself is NOT deleted — switch to it manually ` +
            `if you want to inspect what survives.`
          );
        })()}
      </p>
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
    // Cheap synchronous probe; see looksLikeWine for why process.platform
    // cannot answer this on its own.
    const fs = require("fs") as typeof import("fs");
    for (const p of ["Z:\\usr", "Z:\\home", "C:\\windows\\system32\\winemenubuilder.exe"]) {
      if (fs.existsSync(p)) return `${base} (Wine/Proton)`;
    }
  } catch {
    // Probe unavailable — report the plain platform rather than nothing.
  }
  return base;
}