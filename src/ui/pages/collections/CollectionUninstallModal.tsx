/**
 * "Uninstall this collection": the full plan before anything happens, then
 * the run, then exactly what happened.
 *
 * The plan is `planCollectionUninstall` and the run is
 * `runCollectionUninstall`; this file only reads Vortex's state for the one
 * and hands Vortex's actions to the other. What the player ticks here is what
 * runs, and nothing else does.
 */

import * as React from "react";
import type { types } from "@nexusmods/vortex-api";

import { listReceipts, deleteReceipt } from "../../../core/installLedger";
import { planCollectionUninstall, type UninstallPlan, type UninstallProfileView } from "../../../core/installer/collectionUninstall";
import { runCollectionUninstall, type UninstallOutcome } from "../../../core/installer/runCollectionUninstall";
import { uninstallMod, uninstallMods } from "../../../core/installer/modInstall";
import { enableModInProfile } from "../../../core/installer/profile";
import { deploymentInProgress, removeSupersededProfiles } from "../../../core/installer/profileCleanup";
import { ehLog } from "../../../core/logging/ehLog";
import { getVortexUserDataPath } from "../../../core/paths";
import type { InstallReceipt } from "../../../types/installLedger";
import { Button, Callout, Checkbox, Modal, Pill, Section } from "../../components";
import { useErrorReporter } from "../../errors";
import { useApi } from "../../state";

type Phase =
  | { kind: "planning" }
  | { kind: "ready"; plan: UninstallPlan }
  | { kind: "running"; plan: UninstallPlan; done: number; total: number }
  | { kind: "finished"; plan: UninstallPlan; outcome: UninstallOutcome };

/** Profiles as the plan needs them, from Vortex's own state. */
function readProfiles(state: unknown): UninstallProfileView[] {
  const profiles =
    (state as {
      persistent?: {
        profiles?: Record<string, { name?: string; gameId?: string; modState?: Record<string, { enabled?: boolean }> }>;
      };
    })?.persistent?.profiles ?? {};
  return Object.entries(profiles).map(([id, p]) => ({
    id,
    name: p?.name ?? id,
    ...(p?.gameId !== undefined ? { gameId: p.gameId } : {}),
    enabled: new Set(
      Object.entries(p?.modState ?? {})
        .filter(([, s]) => s?.enabled === true)
        .map(([modId]) => modId),
    ),
  }));
}

export async function buildUninstallPlan(api: types.IExtensionApi, receipt: InstallReceipt): Promise<UninstallPlan> {
  const state = api.getState() as unknown as {
    persistent?: { mods?: Record<string, Record<string, { attributes?: { installTime?: unknown } }>> };
    settings?: { profiles?: { activeProfileId?: string; lastActiveProfile?: Record<string, string> } };
  };
  const all = await listReceipts(getVortexUserDataPath());
  const pool = Object.fromEntries(
    Object.entries(state.persistent?.mods?.[receipt.gameId] ?? {}).map(([id, m]) => [id, { installTime: m?.attributes?.installTime }]),
  );
  return planCollectionUninstall({
    receipt,
    otherReceipts: all.filter((r) => r.packageId !== receipt.packageId),
    pool,
    profiles: readProfiles(state),
    activeProfileId: state.settings?.profiles?.activeProfileId,
    lastActiveProfileId: state.settings?.profiles?.lastActiveProfile?.[receipt.gameId],
  });
}

/** Exported for the render harness: the plan, as the player reads it. */
export function UninstallPlanView(props: {
  plan: UninstallPlan;
  deleteProfileIds: ReadonlySet<string>;
  onToggleProfile: (id: string) => void;
  disabled?: boolean;
}): JSX.Element {
  const { plan } = props;
  const retired = plan.remove.filter((m) => m.from === "retired").length;
  return (
    <div className="eh-stack eh-stack--lg eh-body">
      <p>
        Event Horizon will remove the <strong>{plan.remove.length}</strong> mod(s) it installed for this collection
        {retired > 0 ? `, including ${retired} from earlier revisions that the current one no longer uses` : ""}.
      </p>

      {plan.remove.length > 0 && (
        <Section title="Will be removed" count={plan.remove.length} size="sm">
          <ul className="eh-list-box">
            {plan.remove.map((m) => (
              <li key={m.vortexModId} className="eh-row eh-row--split">
                <span className="eh-strong">{m.name}</span>
                {m.from === "retired" && <Pill intent="neutral">earlier revision</Pill>}
              </li>
            ))}
          </ul>
        </Section>
      )}

      {plan.keep.length > 0 && (
        <Section title="Kept, although Event Horizon installed them" count={plan.keep.length} size="sm">
          <ul className="eh-list-box">
            {plan.keep.map((m) => (
              <li key={m.vortexModId} className="eh-stack eh-stack--xs">
                <span className="eh-strong">{m.name}</span>
                <span className="eh-muted">
                  {m.reason.kind === "other-collection"
                    ? `Also used by ${m.reason.collections.join(", ")}.`
                    : m.reason.kind === "your-profile"
                      ? `Enabled in your profile ${m.reason.profiles.map((p) => `"${p}"`).join(", ")}.`
                      : `Not removed: ${m.reason.why}.`}
                </span>
              </li>
            ))}
          </ul>
        </Section>
      )}

      {plan.profiles.length > 0 && (
        <Section title="This collection's profiles" count={plan.profiles.length} size="sm">
          <div className="eh-stack eh-stack--sm">
            {plan.profiles.map((p) => (
              <Checkbox
                key={p.id}
                label={p.name}
                {...(p.reason !== undefined ? { description: p.reason } : { description: "Deleted with its load order." })}
                checked={p.deletable && props.deleteProfileIds.has(p.id)}
                disabled={!p.deletable || props.disabled === true}
                onChange={(): void => props.onToggleProfile(p.id)}
              />
            ))}
          </div>
        </Section>
      )}

      <Callout tone="info" title="Left as it is">
        {plan.notOursCount > 0 && (
          <p>
            {plan.notOursCount} mod(s) you already had before this collection. They are yours, and they stay.
          </p>
        )}
        {plan.alreadyGoneCount > 0 && <p>{plan.alreadyGoneCount} mod(s) you have already removed yourself.</p>}
        <p>
          Game INI settings the collection applied, light flags it set on plugins, and files it moved to quarantine
          are not changed back.
        </p>
      </Callout>
    </div>
  );
}

export function CollectionUninstallModal(props: {
  receipt: InstallReceipt | undefined;
  onClose: () => void;
  onFinished: (outcome: UninstallOutcome) => void;
}): JSX.Element {
  const api = useApi();
  const reportError = useErrorReporter();
  const [phase, setPhase] = React.useState<Phase>({ kind: "planning" });
  const [deleteProfileIds, setDeleteProfileIds] = React.useState<Set<string>>(new Set());
  const { receipt } = props;

  React.useEffect(() => {
    if (receipt === undefined) return;
    let cancelled = false;
    setPhase({ kind: "planning" });
    buildUninstallPlan(api, receipt)
      .then((plan) => {
        if (cancelled) return;
        // Ticked by default: uninstalling a collection means wanting it gone, and each one is listed.
        setDeleteProfileIds(new Set(plan.profiles.filter((p) => p.deletable).map((p) => p.id)));
        setPhase({ kind: "ready", plan });
      })
      .catch((err) => {
        if (cancelled) return;
        reportError(err, { title: "Couldn't work out what to uninstall", context: { step: "uninstall-plan", packageId: receipt.packageId } });
        props.onClose();
      });
    return (): void => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [receipt?.packageId]);

  const run = async (plan: UninstallPlan): Promise<void> => {
    if (receipt === undefined) return;
    if (deploymentInProgress(api.getState())) {
      reportError(new Error("Vortex is deploying right now. Wait for it to finish, then uninstall again."), { title: "Not now" });
      return;
    }
    const appData = getVortexUserDataPath();
    setPhase({ kind: "running", plan, done: 0, total: plan.remove.length });
    try {
      const outcome = await runCollectionUninstall({
        plan,
        collectionProfileId: receipt.vortexProfileId,
        deleteProfileIds,
        deps: {
          uninstallMod: (modId) => uninstallMod(api, { gameId: receipt.gameId, modId }),
          uninstallMods: (modIds) => uninstallMods(api, { gameId: receipt.gameId, modIds }),
          enableModInProfile: (profileId, modId) => enableModInProfile(api, profileId, modId),
          removeProfiles: (profiles) =>
            removeSupersededProfiles({
              api,
              gameId: receipt.gameId,
              userDataPath: appData,
              profiles: profiles.map((p) => ({ id: p.id, name: p.name, version: "" })),
            }),
          deleteReceipt: async () => {
            await deleteReceipt(appData, receipt.packageId);
          },
          clearStoredPackage: async () => {
            const { clearStoredPackage } = await import("../../../core/installer/packageStore");
            await clearStoredPackage(appData, receipt.packageId);
          },
          onProgress: (done, total) => setPhase({ kind: "running", plan, done, total }),
        },
      });
      setPhase({ kind: "finished", plan, outcome });
    } catch (err) {
      ehLog("error", "collection.uninstall.crashed", { packageId: receipt.packageId, err });
      reportError(err, { title: "Uninstall stopped", context: { step: "uninstall", packageId: receipt.packageId } });
      props.onClose();
    }
  };

  const busy = phase.kind === "running";
  const title = receipt !== undefined ? `Uninstall ${receipt.packageName}?` : "";

  return (
    <Modal
      open={receipt !== undefined}
      onClose={(): void => {
        if (busy) return;
        if (phase.kind === "finished") props.onFinished(phase.outcome);
        else props.onClose();
      }}
      size="lg"
      title={phase.kind === "finished" ? `${receipt?.packageName ?? ""}: uninstalled` : title}
      footer={
        phase.kind === "finished" ? (
          <Button intent="primary" onClick={(): void => props.onFinished(phase.outcome)}>
            Close
          </Button>
        ) : (
          <>
            <Button intent="ghost" onClick={props.onClose} disabled={busy}>
              Cancel
            </Button>
            <Button
              intent="danger"
              disabled={phase.kind !== "ready" || (phase.plan.remove.length === 0 && deleteProfileIds.size === 0)}
              onClick={(): void => {
                if (phase.kind === "ready") void run(phase.plan);
              }}
            >
              {busy ? `Removing ${phase.done} / ${phase.total}` : "Uninstall"}
            </Button>
          </>
        )
      }
    >
      {phase.kind === "planning" && <p className="eh-body eh-muted">Working out what this collection installed…</p>}
      {(phase.kind === "ready" || phase.kind === "running") && (
        <UninstallPlanView
          plan={phase.plan}
          deleteProfileIds={deleteProfileIds}
          disabled={busy}
          onToggleProfile={(id): void =>
            setDeleteProfileIds((prev) => {
              const next = new Set(prev);
              if (next.has(id)) next.delete(id);
              else next.add(id);
              return next;
            })
          }
        />
      )}
      {phase.kind === "finished" && <UninstallResult outcome={phase.outcome} />}
    </Modal>
  );
}

/** Exported for the render harness: what actually happened. */
export function UninstallResult(props: { outcome: UninstallOutcome }): JSX.Element {
  const o = props.outcome;
  return (
    <div className="eh-stack eh-body">
      <p>
        Removed <strong>{o.removed.length}</strong> mod(s)
        {o.restored > 0 ? `, and switched ${o.restored} of your own copies back on` : ""}
        {o.profilesRemoved.length > 0 ? `. Deleted ${o.profilesRemoved.length} profile(s)` : ""}.
      </p>
      {o.failed.length > 0 && (
        <Callout tone="warning" title={`${o.failed.length} mod(s) could not be removed`}>
          <p>They are still installed, and the collection stays in the list so you can uninstall again.</p>
          <ul>
            {o.failed.slice(0, 10).map((f) => (
              <li key={f.mod.vortexModId}>
                {f.mod.name}: {f.error}
              </li>
            ))}
          </ul>
        </Callout>
      )}
      {o.profilesFailed.length > 0 && (
        <Callout tone="warning" title={`${o.profilesFailed.length} profile(s) could not be deleted`}>
          <p>Delete them from Vortex's Profiles page.</p>
        </Callout>
      )}
    </div>
  );
}
