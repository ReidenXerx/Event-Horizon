/**
 * ──────────────────────────────────────────────────────────────────────
 * The Collection Doctor, wired up.
 *
 * All the Vortex reads, the package lookup and the repairs live here so
 * `evaluateHealth` stays pure and `DoctorPanel` stays presentational — which
 * is what lets both be tested and screenshotted without a running Vortex.
 *
 * ─── DIAGNOSIS IS FREE; SOME CURES ARE NOT ─────────────────────────────
 * Diagnosis needs only the receipt, so the page is useful the instant it
 * opens, even if the `.ehcoll` was deleted months ago.
 *
 * The deep scan and three of the six cures re-run pipeline steps that read the
 * MANIFEST, so they need the package — and the page gets it ITSELF: the copy
 * kept when the collection was installed, else the collections folder, else
 * the exact installed revision downloaded again from Nexus. Asking the player
 * to go and find a file they used weeks ago is the last resort now, not the
 * greeting, and while that is happening the buttons say which step it is on.
 * Until then those actions are disabled WITH THE REASON rather than hidden — a
 * button that quietly vanishes reads as a missing feature, one that explains
 * itself reads as a tool that knows what it is doing.
 * ──────────────────────────────────────────────────────────────────────
 */

import * as React from "react";

import { Button, Callout, Card, Field, Select } from "../../components";
import { useApi } from "../../state";
import { useErrorReporter } from "../../errors";
import { useToast } from "../../components/Toast";
import { DoctorPanel } from "./DoctorPanel";
import { assessObservedLoadOrder, doctorLightFlagBaseline, evaluateHealth, healingBlockedReason } from "../../../core/doctor/health";
import { ehLog } from "../../../core/logging/ehLog";
import type { HealAction, HealthCheck, HealthReceiptView } from "../../../core/doctor/health";
import { gatherObservations } from "../../../core/doctor/gather";
import { toHealthView } from "../../../core/doctor/receiptView";
import { describeHeal, healNeedsConfirmation, healNeedsManifest } from "../../../core/doctor/heal";
import { runHeal } from "../../../core/doctor/runHeal";
import { getInstallSession } from "../install/installSession";
import type { EventHorizonRoute } from "../../routes";
import type { InstallReceipt } from "../../../types/installLedger";
import type { EhcollManifest } from "../../../types/ehcoll";
import { stagingRootForModId } from "../../../core/stagingPath";
import { EnvironmentTools } from "./EnvironmentTools";
import { LoadOrderCard } from "./LoadOrderCard";
import { baselineOf, previewRepin } from "../../../core/doctor/loadOrderStatus";
import { pickDoctorReceipt } from "../../../core/doctor/pickReceipt";
import { disableAutoSort, readsAutoSort } from "../../../core/installer/autoSort";
import type { HealthObservations } from "../../../core/doctor/health";

export interface DoctorPageProps {
  onNavigate: (route: EventHorizonRoute) => void;
}

type Loaded = {
  receipts: InstallReceipt[];
  selected: InstallReceipt;
};


function CollectionDoctor(props: DoctorPageProps): JSX.Element {
  const api = useApi();
  const reportError = useErrorReporter();
  const toast = useToast();

  const [loaded, setLoaded] = React.useState<Loaded | undefined>(undefined);
  const [loadError, setLoadError] = React.useState<string | undefined>(undefined);
  const [checks, setChecks] = React.useState<HealthCheck[] | undefined>(undefined);
  /** Kept beside the checks: the load-order card reads the current order from it. */
  const [obs, setObs] = React.useState<HealthObservations | undefined>(undefined);
  const [busyCheckId, setBusyCheckId] = React.useState<string | undefined>(undefined);
  const [drifted, setDrifted] = React.useState<readonly string[] | undefined>(undefined);
  const [pkg, setPkg] = React.useState<
    { path: string; manifest: EhcollManifest } | undefined
  >(undefined);
  const [pkgSearched, setPkgSearched] = React.useState(false);
  /** Set while the collection is being fetched again, so the page says so. */
  const [pkgFetching, setPkgFetching] = React.useState<string | undefined>(undefined);
  /** Why the collection could not be obtained, when it could not be. */
  const [pkgUnavailable, setPkgUnavailable] = React.useState<string | undefined>(undefined);
  const [tick, setTick] = React.useState(0);
  /**
   * Both buttons ran with no sign they had started — reported as "we didn't
   * show that process started and for user its kinda do nothing". A gather
   * takes 4–16ms, so a spinner alone would flash by unseen; `checkedAt` is
   * the other half, giving an instant re-check a visible result.
   */
  const [scanning, setScanning] = React.useState(false);
  const [rechecking, setRechecking] = React.useState(false);
  const [checkedAt, setCheckedAt] = React.useState<number | undefined>(undefined);

  // ── receipts ─────────────────────────────────────────────────────────
  React.useEffect(() => {
    let alive = true;
    void (async (): Promise<void> => {
      try {
        const [{ listReceipts }, { getVortexUserDataPath }] = await Promise.all([
          import("../../../core/installLedger"),
          import("../../../core/paths"),
        ]);
        const receipts = await listReceipts(getVortexUserDataPath());
        if (!alive) return;
        /**
         * Which collection to open on is a real decision, not `[0]` — see
         * {@link pickDoctorReceipt}. Reading the active profile is allowed to
         * fail: the pick then degrades to the newest install rather than
         * throwing away the page.
         */
        let activeProfileId: string | undefined;
        try {
          const { getActiveProfileId } = await import(
            "../../../core/getModsListForProfile"
          );
          activeProfileId = getActiveProfileId(api.getState());
        } catch (err) {
          ehLog("debug", "doctor.active-profile-unreadable", { err });
          activeProfileId = undefined;
        }
        if (!alive) return;
        const first = pickDoctorReceipt(receipts, activeProfileId);
        if (first === undefined) {
          setLoaded(undefined);
          setLoadError(undefined);
          return;
        }
        // Which collection every check below is about. A report of "Doctor
        // says X" cannot be read without it — that is how a whole install's
        // worth of checks got attributed to the wrong collection unnoticed.
        ehLog("info", "doctor.receipt.selected", {
          package: first.packageName,
          version: first.packageVersion,
          profile: first.vortexProfileName ?? first.vortexProfileId,
          activeProfile: activeProfileId ?? "unreadable",
          onActiveProfile: first.vortexProfileId === activeProfileId,
          receipts: receipts.length,
        });
        setLoaded({ receipts, selected: first });
      } catch (err) {
        if (!alive) return;
        setLoadError(err instanceof Error ? err.message : String(err));
      }
    })();
    return (): void => {
      alive = false;
    };
  }, [api]);

  // ── find the package (for the deep scan and manifest-backed cures) ────
  React.useEffect(() => {
    if (loaded === undefined) return;
    let alive = true;
    setPkg(undefined);
    setPkgSearched(false);
    setPkgFetching(undefined);
    setPkgUnavailable(undefined);
    void (async (): Promise<void> => {
      try {
        // Shared with My Collections' "check and continue": two callers
        // disagreeing about which package belongs to a collection is exactly
        // the bug a second hand-rolled copy produces.
        /**
         * The copy kept at install time first, then the collections folder,
         * then the exact revision from the page it came from — see
         * {@link ensureCollectionPackage}. The player is asked for a file only
         * when all three fail, which for a collection installed from Nexus
         * should be never.
         */
        const [{ ensureCollectionPackage }, { getVortexUserDataPath }] =
          await Promise.all([
            import("../../runtime/ensurePackage"),
            import("../../../core/paths"),
          ]);
        const found = await ensureCollectionPackage({
          api,
          receipt: loaded.selected,
          appDataPath: getVortexUserDataPath(),
          onDownloadProgress: (received, total) => {
            if (!alive) return;
            setPkgFetching(
              total !== undefined && total > 0
                ? `Fetching the collection again — ${Math.floor((received / total) * 100)}%`
                : "Fetching the collection again…",
            );
          },
        });
        if (found.kind !== "ready") {
          if (alive) {
            setPkgFetching(undefined);
            setPkgUnavailable(found.reason);
            setPkgSearched(true);
          }
          return;
        }
        const { readEhcoll } = await import("../../../core/manifest/readEhcoll");
        const result = await readEhcoll(found.path);
        if (!alive) return;
        setPkgFetching(undefined);
        setPkgUnavailable(undefined);
        setPkg({ path: found.path, manifest: result.manifest });
        setPkgSearched(true);
      } catch {
        // A package we cannot read is the same situation as one we cannot
        // find: the cures that need it stay disabled and say why. Not an
        // error dialog — diagnosis still works perfectly without it.
        if (alive) setPkgSearched(true);
      }
    })();
    return (): void => {
      alive = false;
    };
  }, [loaded]);

  // ── diagnose ─────────────────────────────────────────────────────────
  React.useEffect(() => {
    if (loaded === undefined) return;
    let alive = true;
    void (async (): Promise<void> => {
      try {
        const gameId = loaded.selected.gameId;
        const recordedLight = doctorLightFlagBaseline(
          gameId,
          loaded.selected.rulesApplication?.baselinePluginOrder,
          loaded.selected.rulesApplication?.baselineLightFlagBit,
        );
        if (recordedLight.refused !== undefined) {
          ehLog("warn", "doctor.light-flags.refused", {
            gameId,
            recordedLightFlagBit: loaded.selected.rulesApplication?.baselineLightFlagBit,
            reason: recordedLight.refused,
          });
        }
        const obs = await gatherObservations({
          api,
          gameId,
          receiptProfileId: loaded.selected.vortexProfileId,
          // Whose load order it is depends on every receipt: the newest
          // install into the active profile owns it.
          orderReceipt: loaded.selected,
          receipts: loaded.receipts,
          // The ESL flags live in the plugin FILES, so checking them needs
          // the curator's recorded values to compare against.
          ...(recordedLight.baseline !== undefined
            ? { recordedPlugins: recordedLight.baseline }
            : {}),
          ...(drifted !== undefined ? { driftedCompareKeys: drifted } : {}),
        });
        if (!alive) return;
        setObs(obs);
        setChecks(evaluateHealth(toHealthView(loaded.selected), obs));
        setCheckedAt(Date.now());
      } catch (err) {
        if (!alive) return;
        reportError(err, {
          title: "Couldn't check this collection's health",
          context: { step: "doctor-diagnose" },
        });
      } finally {
        // Guarded: the effect's cleanup runs before this on an unmount, and
        // setting state there is a React warning for no gain.
        if (alive) setRechecking(false);
      }
    })();
    return (): void => {
      alive = false;
    };
  }, [api, loaded, drifted, tick, reportError]);

  /**
   * `.state` — the snapshot is `{ state, errorSeq }` and the wizard's `kind`
   * is on the state. This was `getSnapshot() as { kind?: unknown }`, and the
   * cast is what made it compile: the snapshot has no `kind`, the optional
   * property tolerated that, and every repair button was disabled with
   * "Install in progress" from the day it was written. No cast now, so the
   * shape is the compiler's problem rather than a curator's.
   */
  const blocked = healingBlockedReason(getInstallSession().getSnapshot().state);

  /**
   * Only what the player must act on. Event Horizon keeps a copy of every
   * collection it installs and can fetch the installed revision again from
   * Nexus, so this is now the last resort rather than the usual greeting: a
   * file install whose package is gone, or a fetch that failed.
   */
  const missingPackage =
    pkg === undefined && pkgSearched
      ? (pkgUnavailable ??
        "The package for this collection could not be found. Repairs that " +
          "re-run a step of the install need it — pick it to enable them.")
      : undefined;

  // ── deep scan ────────────────────────────────────────────────────────
  const runDeepScan = React.useCallback(() => {
    if (loaded === undefined || pkg === undefined) return;
    setScanning(true);
    setBusyCheckId("staging");
    void (async (): Promise<void> => {
      try {
        const [{ selectDriftCandidates, findDriftedMods }, { getVortexUserDataPath }, path, vortex] =
          await Promise.all([
            import("../../../core/installer/detectStagingDrift"),
            import("../../../core/paths"),
            import("path"),
            import("@nexusmods/vortex-api"),
          ]);
        const gameId = loaded.selected.gameId;
        const candidates = selectDriftCandidates({
          receiptMods: loaded.selected.mods,
          manifestMods: pkg.manifest.mods,
        });
        const state = api.getState();
        const filesByKey = new Map(
          pkg.manifest.mods.map((m) => [m.compareKey, m.state.stagingFiles]),
        );
        const found = await findDriftedMods({
          candidates,
          manifestFilesFor: (key) => filesByKey.get(key),
          cacheDir: getVortexUserDataPath(),
          stagingRootFor: (vortexModId) => {
            // Identical to runInstall's callback, and now literally the
            // same function rather than a second copy of the reasoning.
            return stagingRootForModId(state, gameId, vortexModId);
          },
        });
        setDrifted(found.map((f) => f.compareKey));
      } catch (err) {
        reportError(err, {
          title: "Deep scan failed",
          context: { step: "doctor-deep-scan" },
        });
      } finally {
        setBusyCheckId(undefined);
        setScanning(false);
      }
    })();
  }, [api, loaded, pkg, reportError]);

  // ── heal ─────────────────────────────────────────────────────────────
  const heal = React.useCallback(
    (action: HealAction, checkId: string) => {
      if (loaded === undefined) return;
      const described = describeHeal(action);

      void (async (): Promise<void> => {
        /**
         * Only the cures that take something away still ask — replacing the
         * player's mod rules, or removing and rebuilding mod folders. Putting
         * a recorded load order back is one press, because seeing the problem
         * and fixing it should not be two conversations.
         */
        if (healNeedsConfirmation(action)) {
          const result = await api.showDialog?.(
            "question",
            described.title,
            { text: described.body },
            [{ label: "Cancel" }, { label: described.confirm }],
          );
          if (result?.action !== described.confirm) return;
        }

        setBusyCheckId(checkId);
        try {
          const outcome = await runHeal(action, {
            api,
            gameId: loaded.selected.gameId,
            receipt: loaded.selected,
            ...(pkg !== undefined ? { manifest: pkg.manifest, ehcollPath: pkg.path } : {}),
          });
          if (outcome.kind === "blocked") {
            toast({ intent: "warning", message: outcome.reason });
            return;
          }
          if (outcome.kind === "handoff") {
            toast({ intent: "info", message: outcome.summary });
            getInstallSession().pickFile(api, outcome.ehcollPath);
            props.onNavigate("install");
            return;
          }
          toast({ intent: "success", message: outcome.summary });
          // Re-diagnose: the user should see the verdict change, not be told
          // it did.
          setTick((n) => n + 1);
        } catch (err) {
          reportError(err, {
            title: `Couldn't ${described.confirm.toLowerCase()}`,
            context: { step: "doctor-heal", action },
          });
        } finally {
          setBusyCheckId(undefined);
        }
      })();
    },
    [api, loaded, pkg, props, reportError, toast],
  );

  const pickPackage = React.useCallback(() => {
    void (async (): Promise<void> => {
      try {
        const [{ pickEhcollFile }, { readEhcoll }] = await Promise.all([
          import("../../../utils/utils"),
          import("../../../core/manifest/readEhcoll"),
        ]);
        const picked = await pickEhcollFile(api);
        if (picked === undefined) return;
        const result = await readEhcoll(picked);
        setPkg({ path: picked, manifest: result.manifest });
      } catch (err) {
        reportError(err, {
          title: "Couldn't read that collection package",
          context: { step: "doctor-pick-package" },
        });
      }
    })();
  }, [api, reportError]);

  if (loadError !== undefined) {
    return (
      <Card title="Collection Doctor">
        <p className="eh-note">Could not read your install receipts: {loadError}</p>
      </Card>
    );
  }

  if (loaded === undefined) {
    return (
      <Card title="Collection Doctor">
        <div className="eh-stack">
          <p className="eh-body">
            No installed collections yet. Install one and the Doctor will be able
            to tell you whether it is still intact.
          </p>
          <Button intent="primary" onClick={() => props.onNavigate("install")}>
            Install a collection
          </Button>
        </div>
      </Card>
    );
  }

  return (
    <div className="eh-stack eh-stack--lg">
      {loaded.receipts.length > 1 && (
        <Card inert>
          <Field label="Collection">
            {(id) => (
              <Select
                id={id}
                value={loaded.selected.packageId}
                onChange={(e) => {
                  const next = loaded.receipts.find(
                    (r) => r.packageId === e.target.value,
                  );
                  if (next === undefined) return;
                  setDrifted(undefined);
                  setChecks(undefined);
                  setLoaded({ ...loaded, selected: next });
                }}
              >
                {loaded.receipts.map((r) => (
                  <option key={r.packageId} value={r.packageId}>
                    {r.packageName} v{r.packageVersion}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        </Card>
      )}

      {pkgFetching !== undefined && (
        <Callout tone="info">{pkgFetching}</Callout>
      )}

      {missingPackage !== undefined && (
        <Callout
          tone="warning"
          actions={
            <Button intent="ghost" size="sm" onClick={pickPackage}>
              Pick the package…
            </Button>
          }
        >
          {missingPackage}
        </Callout>
      )}

      {checks !== undefined && obs !== undefined && (
        <LoadOrderCard
          packageName={loaded.selected.packageName}
          // The same assessment the plugin-order health check makes.
          status={assessObservedLoadOrder(toHealthView(loaded.selected), obs)}
          // Vortex's state, which the re-apply reads too — never the file —
          // so the moves listed are the moves the button makes.
          {...(obs.currentPluginOrderFromState !== undefined
            ? { preview: previewRepin(baselineOf(loaded.selected), obs.currentPluginOrderFromState, obs.userPluginMasters) }
            : {})}
          {...(obs.pluginsTxtMismatch === true ? { fileMismatch: true } : {})}
          {...(readsAutoSort(api.getState()) !== undefined ? { autoSortOn: readsAutoSort(api.getState()) } : {})}
          busy={busyCheckId === "plugin-order"}
          {...(blocked !== undefined
            ? { blocked }
            : obs.currentPluginOrderFromState === undefined
              ? { blocked: "Vortex lists no plugins for this game right now, so there is no order to re-apply into." }
              : {})}
          onReapply={(): void => heal("repin-plugin-order", "plugin-order")}
          onDisableAutoSort={(): void => {
            // Read back before saying so: a success toast over a setting that
            // stayed on is what this card used to show.
            const outcome = disableAutoSort(api, "doctor");
            toast(
              outcome.ok
                ? { intent: "success", message: "Automatic sorting is off. Vortex keeps the order until you sort by hand." }
                : { intent: "danger", message: outcome.reason },
            );
            setTick((n) => n + 1);
          }}
        />
      )}

      {checks === undefined ? (
        <Card title="Collection Doctor">
          <p className="eh-body">Checking…</p>
        </Card>
      ) : (
        <DoctorPanel
          packageName={loaded.selected.packageName}
          packageVersion={loaded.selected.packageVersion}
          checks={checks}
          {...(busyCheckId !== undefined ? { busyCheckId } : {})}
          {...(blocked !== undefined ? { healingBlocked: blocked } : {})}
          {...(pkg !== undefined ? { onRunDeepScan: runDeepScan } : {})}
          scanning={scanning}
          rechecking={rechecking}
          {...(checkedAt !== undefined ? { checkedAt } : {})}
          onRecheck={() => {
            setRechecking(true);
            setTick((n) => n + 1);
          }}
          onHeal={heal}
          {...(pkg === undefined
            ? {
                unavailableHeal: (action: HealAction): string | undefined =>
                  healNeedsManifest(action)
                    ? pkgFetching !== undefined
                      ? "Fetching the collection…"
                      : pkgSearched
                        ? "Needs the package"
                        : "Reading the collection…"
                    : undefined,
              }
            : {})}
        />
      )}
    </div>
  );
}

/**
 * The Doctor: the game-setup tools first, because they work with no collection
 * installed — which is exactly when a tester whose install never finished needs
 * them — and the collection's own health below.
 */
export function DoctorPage(props: DoctorPageProps): JSX.Element {
  return (
    <div className="eh-stack eh-stack--lg">
      <EnvironmentTools />
      <CollectionDoctor {...props} />
    </div>
  );
}
