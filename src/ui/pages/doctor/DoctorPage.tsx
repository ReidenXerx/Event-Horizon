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
 * MANIFEST, so they need the package. It is looked up by name and version in
 * the collections folder; when that fails the user can point at it. Until then
 * those actions are disabled WITH THE REASON rather than hidden — a button
 * that quietly vanishes reads as a missing feature, one that explains itself
 * reads as a tool that knows what it is doing.
 * ──────────────────────────────────────────────────────────────────────
 */

import * as React from "react";

import { Button, Callout, Card, Field, Select } from "../../components";
import { useApi } from "../../state";
import { useErrorReporter } from "../../errors";
import { useToast } from "../../components/Toast";
import { DoctorPanel } from "./DoctorPanel";
import { evaluateHealth, healingBlockedReason } from "../../../core/doctor/health";
import type { HealAction, HealthCheck, HealthReceiptView } from "../../../core/doctor/health";
import { gatherObservations } from "../../../core/doctor/gather";
import { describeHeal, healNeedsManifest } from "../../../core/doctor/heal";
import { runHeal } from "../../../core/doctor/runHeal";
import { getInstallSession } from "../install/installSession";
import type { EventHorizonRoute } from "../../routes";
import type { InstallReceipt } from "../../../types/installLedger";
import type { EhcollManifest } from "../../../types/ehcoll";
import { stagingRootForModId } from "../../../core/stagingPath";
import { EnvironmentTools } from "./EnvironmentTools";
import { LoadOrderCard } from "./LoadOrderCard";
import { assessLoadOrder, nativeNamesFromState, previewRepin } from "../../../core/doctor/loadOrderStatus";
import { baselineOf } from "../../../core/doctor/loadOrderWatcher";
import { ACTION_SET_AUTOSORT_ENABLED, readsAutoSort } from "../../../core/installer/autoSort";
import type { HealthObservations } from "../../../core/doctor/health";

export interface DoctorPageProps {
  onNavigate: (route: EventHorizonRoute) => void;
}

type Loaded = {
  receipts: InstallReceipt[];
  selected: InstallReceipt;
};

/**
 * The receipt, narrowed to what the checks read.
 *
 * `baselinePluginOrder` is mapped to names on purpose: the receipt stores
 * `{ name, enabled }`, the check compares ORDER, and handing it objects would
 * compare them against a list of strings and report every plugin as drifted.
 */
function toHealthView(receipt: InstallReceipt): HealthReceiptView {
  const baseline = receipt.rulesApplication?.baselinePluginOrder;
  return {
    packageName: receipt.packageName,
    packageVersion: receipt.packageVersion,
    vortexProfileId: receipt.vortexProfileId,
    mods: receipt.mods.map((m) => ({
      vortexModId: m.vortexModId,
      compareKey: m.compareKey,
      name: m.name,
    })),
    ...(receipt.rulesApplication !== undefined
      ? {
          rulesApplication: {
            ...(receipt.rulesApplication.appliedRuleCount !== undefined
              ? { appliedRuleCount: receipt.rulesApplication.appliedRuleCount }
              : {}),
            ...(baseline !== undefined
              ? {
                  // `enabled` travels with the name: the health check compares
                  // enabled plugins only, and cannot do that from a string[].
                  baselinePluginOrder: baseline.map((e) => ({
                    name: e.name,
                    enabled: e.enabled,
                    // And `light` travels too. This exact map is where the
                    // enabled flag was being dropped before; adding a field
                    // to the receipt and forgetting this line is how the
                    // next one gets lost.
                    ...(e.light !== undefined ? { light: e.light } : {}),
                  })),
                }
              : {}),
          },
        }
      : {}),
    ...(receipt.userlistApplication !== undefined
      ? {
          userlistApplication: {
            ...(receipt.userlistApplication.appliedRuleCount !== undefined
              ? {
                  appliedRuleCount:
                    receipt.userlistApplication.appliedRuleCount,
                }
              : {}),
            /**
             * Carried separately from `appliedRuleCount`, because they count
             * different acts: one ordering rule dispatched, versus one plugin
             * assigned to a group. Folding them together is what made the
             * LOOT check report a healthy install as 501 rules added.
             *
             * Left absent when the receipt has no number, so the check says
             * "unknown" rather than comparing against a zero it invented.
             */
            ...(receipt.userlistApplication.appliedGroupAssignmentCount !==
            undefined
              ? {
                  appliedGroupAssignmentCount:
                    receipt.userlistApplication.appliedGroupAssignmentCount,
                }
              : {}),
          },
        }
      : {}),
    /**
     * What the run that wrote this receipt could NOT do. Both were written to
     * disk and projected nowhere, so every check downstream read a partial
     * install as a complete healthy one — "All 978 mods are still installed"
     * about a collection missing one, and plugin-order drift against an order
     * the run deliberately never applied.
     */
    ...(receipt.failedMods !== undefined && receipt.failedMods.length > 0
      ? { failedMods: receipt.failedMods }
      : {}),
    ...(receipt.finishingSkipped !== undefined &&
    receipt.finishingSkipped.length > 0
      ? { finishingSkipped: receipt.finishingSkipped }
      : {}),
    ...(receipt.fomodReplayMode !== undefined
      ? { fomodReplayMode: receipt.fomodReplayMode }
      : {}),
  };
}

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
  const [tick, setTick] = React.useState(0);

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
        const first = receipts[0];
        if (first === undefined) {
          setLoaded(undefined);
          setLoadError(undefined);
          return;
        }
        setLoaded({ receipts, selected: first });
      } catch (err) {
        if (!alive) return;
        setLoadError(err instanceof Error ? err.message : String(err));
      }
    })();
    return (): void => {
      alive = false;
    };
  }, []);

  // ── find the package (for the deep scan and manifest-backed cures) ────
  React.useEffect(() => {
    if (loaded === undefined) return;
    let alive = true;
    setPkg(undefined);
    setPkgSearched(false);
    void (async (): Promise<void> => {
      try {
        // Shared with My Collections' "check and continue": two callers
        // disagreeing about which package belongs to a collection is exactly
        // the bug a second hand-rolled copy produces.
        const { locateCollectionPackage } = await import(
          "../../../core/manifest/locatePackage"
        );
        const found = await locateCollectionPackage({
          packageName: loaded.selected.packageName,
          packageVersion: loaded.selected.packageVersion,
        });
        if (found === undefined) {
          if (alive) setPkgSearched(true);
          return;
        }
        const { readEhcoll } = await import("../../../core/manifest/readEhcoll");
        const result = await readEhcoll(found.path);
        if (!alive) return;
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
        const obs = await gatherObservations({
          api,
          gameId,
          receiptProfileId: loaded.selected.vortexProfileId,
          // The ESL flags live in the plugin FILES, so checking them needs
          // the curator's recorded values to compare against.
          ...(loaded.selected.rulesApplication?.baselinePluginOrder !== undefined
            ? {
                recordedPlugins:
                  loaded.selected.rulesApplication.baselinePluginOrder,
              }
            : {}),
          ...(drifted !== undefined ? { driftedCompareKeys: drifted } : {}),
        });
        if (!alive) return;
        setObs(obs);
        setChecks(evaluateHealth(toHealthView(loaded.selected), obs));
      } catch (err) {
        if (!alive) return;
        reportError(err, {
          title: "Couldn't check this collection's health",
          context: { step: "doctor-diagnose" },
        });
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

  const missingPackage =
    pkg === undefined && pkgSearched
      ? "The .ehcoll for this collection was not found in your collections " +
        "folder. Repairs that re-run a step of the install need it — pick it " +
        "to enable them."
      : undefined;

  // ── deep scan ────────────────────────────────────────────────────────
  const runDeepScan = React.useCallback(() => {
    if (loaded === undefined || pkg === undefined) return;
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
      }
    })();
  }, [api, loaded, pkg, reportError]);

  // ── heal ─────────────────────────────────────────────────────────────
  const heal = React.useCallback(
    (action: HealAction, checkId: string) => {
      if (loaded === undefined) return;
      const described = describeHeal(action);

      void (async (): Promise<void> => {
        // Every cure writes to the machine and several are destructive by
        // design (rules REPLACE the user's). Ask first, in the words that say
        // what is lost.
        const result = await api.showDialog?.(
          "question",
          described.title,
          { text: described.body },
          [{ label: "Cancel" }, { label: described.confirm }],
        );
        if (result?.action !== described.confirm) return;

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

      {missingPackage !== undefined && (
        <Callout
          tone="warning"
          actions={
            <Button intent="ghost" size="sm" onClick={pickPackage}>
              Pick the .ehcoll…
            </Button>
          }
        >
          {missingPackage}
        </Callout>
      )}

      {checks !== undefined && obs !== undefined && (
        <LoadOrderCard
          packageName={loaded.selected.packageName}
          status={assessLoadOrder({
            baseline: baselineOf(loaded.selected),
            current: obs.currentPluginOrder,
            natives: nativeNamesFromState(api.getState()),
          })}
          {...(obs.currentPluginOrder !== undefined
            ? { preview: previewRepin(baselineOf(loaded.selected), obs.currentPluginOrder) }
            : {})}
          {...(readsAutoSort(api.getState()) !== undefined ? { autoSortOn: readsAutoSort(api.getState()) } : {})}
          busy={busyCheckId === "plugin-order"}
          {...(blocked !== undefined ? { blocked } : {})}
          onReapply={(): void => heal("repin-plugin-order", "plugin-order")}
          onDisableAutoSort={(): void => {
            api.store?.dispatch({ type: ACTION_SET_AUTOSORT_ENABLED, payload: false } as never);
            toast({ intent: "success", message: "Automatic sorting is off. Vortex keeps the order until you sort by hand." });
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
          onRecheck={() => setTick((n) => n + 1)}
          onHeal={heal}
          {...(pkg === undefined
            ? {
                unavailableHeal: (action: HealAction): string | undefined =>
                  healNeedsManifest(action) ? "Needs the .ehcoll" : undefined,
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
