/**
 * "Remove old profiles": the profiles earlier revisions of one collection
 * left behind, with the option to also remove the mods only they still used.
 *
 * Opened from the collection's card in My Collections and from the install's
 * Done screen. The rule is `planOldProfiles` / `modsFreedBy`; this file reads
 * Vortex's state for it and hands Vortex's actions to it.
 *
 * ─── WHY NO PROFILE STARTS TICKED ──────────────────────────────────────
 * The previous revision's profile is the rollback a version-changing update
 * exists to provide. With the affirmative button one click away, a reflex
 * press must remove nothing. The mods option starts ticked (owner, 2026-10-05):
 * it only acts on profiles the player ticked, and only on mods Event Horizon
 * installed that no remaining profile enables (NS-2).
 */

import * as React from "react";
import type { types } from "@nexusmods/vortex-api";

import { listReceipts } from "../../../core/installLedger";
import { uninstallMods } from "../../../core/installer/modInstall";
import { modsFreedBy, planOldProfiles, type FreeableMod, type OldProfilesPlan, type OldProfileView } from "../../../core/installer/oldProfiles";
import { deploymentInProgress, removeSupersededProfiles } from "../../../core/installer/profileCleanup";
import { UNINSTALL_CHUNK } from "../../../core/installer/runCollectionUninstall";
import { ehLog } from "../../../core/logging/ehLog";
import { getVortexUserDataPath } from "../../../core/paths";
import { stagingRootForModId } from "../../../core/stagingPath";
import type { InstallReceipt } from "../../../types/installLedger";
import { Button, Callout, Checkbox, Modal, Section } from "../../components";
import { useErrorReporter } from "../../errors";
import { useApi } from "../../state";
import { folderSize } from "../dashboard/diskFootprint";
import { formatBytes, formatRelativeTime } from "../dashboard/data";

export type OldProfilesOutcome = {
  profilesRemoved: string[];
  profilesFailed: { name: string; error: string }[];
  modsRemoved: FreeableMod[];
  modsFailed: { mod: FreeableMod; error: string }[];
};

type Phase =
  | { kind: "planning" }
  | { kind: "ready"; plan: OldProfilesPlan; sizes: ReadonlyMap<string, number> }
  | { kind: "running"; plan: OldProfilesPlan; sizes: ReadonlyMap<string, number> }
  | { kind: "finished"; outcome: OldProfilesOutcome };

/** Profiles as the plan needs them, from Vortex's own state. */
export function readOldProfileViews(state: unknown): OldProfileView[] {
  const profiles =
    (state as {
      persistent?: {
        profiles?: Record<
          string,
          { name?: string; gameId?: string; lastActivated?: unknown; modState?: Record<string, { enabled?: boolean }> }
        >;
      };
    })?.persistent?.profiles ?? {};
  return Object.entries(profiles).map(([id, p]) => ({
    id,
    name: p?.name ?? id,
    ...(p?.gameId !== undefined ? { gameId: p.gameId } : {}),
    ...(typeof p?.lastActivated === "number" ? { lastActivated: p.lastActivated } : {}),
    enabled: new Set(
      Object.entries(p?.modState ?? {})
        .filter(([, s]) => s?.enabled === true)
        .map(([modId]) => modId),
    ),
  }));
}

async function buildPlan(api: types.IExtensionApi, receipt: InstallReceipt): Promise<OldProfilesPlan> {
  const state = api.getState() as unknown as {
    persistent?: { mods?: Record<string, Record<string, { attributes?: { installTime?: unknown } }>> };
    settings?: { profiles?: { activeProfileId?: string; lastActiveProfile?: Record<string, string> } };
  };
  const all = await listReceipts(getVortexUserDataPath());
  const pool = Object.fromEntries(
    Object.entries(state.persistent?.mods?.[receipt.gameId] ?? {}).map(([id, m]) => [id, { installTime: m?.attributes?.installTime }]),
  );
  return planOldProfiles({
    receipt,
    otherReceipts: all.filter((r) => r.packageId !== receipt.packageId),
    pool,
    profiles: readOldProfileViews(state),
    activeProfileId: state.settings?.profiles?.activeProfileId,
    lastActiveProfileId: state.settings?.profiles?.lastActiveProfile?.[receipt.gameId],
  });
}

/** Staging bytes per candidate mod. A mod that cannot be measured is left out of the total, not guessed. */
async function measure(api: types.IExtensionApi, plan: OldProfilesPlan): Promise<Map<string, number>> {
  const sizes = new Map<string, number>();
  for (const m of plan.candidates) {
    const dir = stagingRootForModId(api.getState(), plan.gameId, m.vortexModId);
    if (dir === undefined) continue;
    const { bytes, failed } = await folderSize(dir);
    if (failed.length === 0) sizes.set(m.vortexModId, bytes);
  }
  return sizes;
}

/** How many old profiles the card offers, from state already in memory. */
export function oldProfileCount(state: unknown, receipt: InstallReceipt): number {
  return planOldProfiles({ receipt, otherReceipts: [], pool: {}, profiles: readOldProfileViews(state) }).profiles.length;
}

export function OldProfilesModal(props: {
  receipt: InstallReceipt | undefined;
  onClose: () => void;
  onFinished: (outcome: OldProfilesOutcome) => void;
}): JSX.Element {
  const api = useApi();
  const reportError = useErrorReporter();
  const { receipt } = props;
  const [phase, setPhase] = React.useState<Phase>({ kind: "planning" });
  const [ticked, setTicked] = React.useState<ReadonlySet<string>>(new Set());
  const [alsoMods, setAlsoMods] = React.useState(true);

  React.useEffect(() => {
    if (receipt === undefined) return undefined;
    let cancelled = false;
    setPhase({ kind: "planning" });
    setTicked(new Set());
    setAlsoMods(true);
    buildPlan(api, receipt)
      .then(async (plan) => {
        const sizes = await measure(api, plan);
        if (!cancelled) setPhase({ kind: "ready", plan, sizes });
      })
      .catch((err) => {
        if (cancelled) return;
        reportError(err, { title: "Couldn't list the old profiles", context: { step: "old-profiles-plan", packageId: receipt.packageId } });
        props.onClose();
      });
    return (): void => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [receipt?.packageId]);

  const views = readOldProfileViews(api.getState());
  const freed = phase.kind === "ready" || phase.kind === "running" ? modsFreedBy(phase.plan, views, ticked) : [];
  const sizes = phase.kind === "ready" || phase.kind === "running" ? phase.sizes : new Map<string, number>();
  const freedBytes = freed.reduce((sum, m) => sum + (sizes.get(m.vortexModId) ?? 0), 0);
  const measured = freed.every((m) => sizes.has(m.vortexModId));

  const run = async (plan: OldProfilesPlan): Promise<void> => {
    if (receipt === undefined) return;
    if (deploymentInProgress(api.getState())) {
      reportError(new Error("Vortex is deploying right now. Wait for it to finish, then try again."), { title: "Not now" });
      return;
    }
    setPhase({ kind: "running", plan, sizes });
    const outcome: OldProfilesOutcome = { profilesRemoved: [], profilesFailed: [], modsRemoved: [], modsFailed: [] };
    try {
      const chosen = plan.profiles.filter((p) => p.deletable && ticked.has(p.id));
      const removal = await removeSupersededProfiles({
        api,
        gameId: plan.gameId,
        userDataPath: getVortexUserDataPath(),
        profiles: chosen.map((p) => ({ id: p.id, name: p.name, version: p.version })),
      });
      outcome.profilesRemoved = removal.removed.map((p) => p.name);
      outcome.profilesFailed = removal.failed.map((f) => ({ name: f.profile.name, error: f.error }));

      if (alsoMods) {
        // Re-read AFTER the profiles went: a profile that failed to delete still enables its mods, and they stay.
        const toRemove = modsFreedBy(plan, readOldProfileViews(api.getState()), new Set());
        for (let at = 0; at < toRemove.length; at += UNINSTALL_CHUNK) {
          const chunk = toRemove.slice(at, at + UNINSTALL_CHUNK);
          try {
            await uninstallMods(api, { gameId: plan.gameId, modIds: chunk.map((m) => m.vortexModId) });
            outcome.modsRemoved.push(...chunk);
          } catch {
            // One at a time names the mod that failed; ids Vortex already removed are skipped by Vortex.
            for (const mod of chunk) {
              try {
                await uninstallMods(api, { gameId: plan.gameId, modIds: [mod.vortexModId] });
                outcome.modsRemoved.push(mod);
              } catch (err) {
                outcome.modsFailed.push({ mod, error: err instanceof Error ? err.message : String(err) });
              }
            }
          }
        }
      }
      ehLog(outcome.profilesFailed.length + outcome.modsFailed.length > 0 ? "warn" : "info", "collection.old-profiles.done", {
        packageId: plan.packageId,
        profilesRemoved: outcome.profilesRemoved.length,
        profilesFailed: outcome.profilesFailed.length,
        alsoMods,
        modsRemoved: outcome.modsRemoved.length,
        modsFailed: outcome.modsFailed.length,
      });
      setPhase({ kind: "finished", outcome });
    } catch (err) {
      ehLog("error", "collection.old-profiles.crashed", { packageId: plan.packageId, err });
      reportError(err, { title: "Removing old profiles stopped", context: { step: "old-profiles", packageId: plan.packageId } });
      props.onClose();
    }
  };

  const busy = phase.kind === "running";
  const finish = (): void => {
    if (phase.kind === "finished") props.onFinished(phase.outcome);
    else props.onClose();
  };

  return (
    <Modal
      open={receipt !== undefined}
      onClose={(): void => {
        if (!busy) finish();
      }}
      size="lg"
      title={`${receipt?.packageName ?? ""}: old profiles`}
      footer={
        phase.kind === "finished" ? (
          <Button intent="primary" onClick={finish}>
            Close
          </Button>
        ) : (
          <>
            <Button intent="ghost" onClick={props.onClose} disabled={busy}>
              Cancel
            </Button>
            <Button
              intent="danger"
              disabled={phase.kind !== "ready" || (ticked.size === 0 && !(alsoMods && freed.length > 0))}
              onClick={(): void => {
                if (phase.kind === "ready") void run(phase.plan);
              }}
            >
              {busy ? "Removing…" : "Remove"}
            </Button>
          </>
        )
      }
    >
      {phase.kind === "planning" && <p className="eh-body eh-muted">Looking for this collection's old profiles…</p>}
      {(phase.kind === "ready" || phase.kind === "running") && (
        <OldProfilesView
          plan={phase.plan}
          ticked={ticked}
          alsoMods={alsoMods}
          freedCount={freed.length}
          freedBytes={measured ? freedBytes : undefined}
          disabled={busy}
          onToggle={(id): void =>
            setTicked((prev) => {
              const next = new Set(prev);
              if (next.has(id)) next.delete(id);
              else next.add(id);
              return next;
            })
          }
          onAlsoMods={setAlsoMods}
        />
      )}
      {phase.kind === "finished" && <OldProfilesResult outcome={phase.outcome} />}
    </Modal>
  );
}

/** Exported for the render harness: the choice, as the player reads it. */
export function OldProfilesView(props: {
  plan: OldProfilesPlan;
  ticked: ReadonlySet<string>;
  alsoMods: boolean;
  freedCount: number;
  /** Undefined when a freed mod's folder could not be measured. */
  freedBytes: number | undefined;
  disabled?: boolean;
  onToggle: (id: string) => void;
  onAlsoMods: (on: boolean) => void;
}): JSX.Element {
  const { plan } = props;
  if (plan.profiles.length === 0) {
    return (
      <p className="eh-body">
        Event Horizon has no older profiles for this collection on this machine. Profiles you made or renamed yourself
        are never listed.
      </p>
    );
  }
  const frees =
    props.freedCount === 0
      ? "none with this selection"
      : `${props.freedCount} mod(s)${props.freedBytes !== undefined ? `, frees ${formatBytes(props.freedBytes)}` : ""}`;
  return (
    <div className="eh-stack eh-stack--lg eh-body">
      <p>
        Event Horizon made these profiles for earlier revisions of this collection. Removing one throws away its load
        order and enabled/disabled state, including your way back to that revision. It cannot be undone.
      </p>
      <Section title="Old profiles" count={plan.profiles.length} size="sm">
        <div className="eh-stack eh-stack--sm">
          {plan.profiles.map((p) => (
            <Checkbox
              key={p.id}
              label={p.name}
              description={
                p.reason ??
                (p.lastActivated !== undefined ? `Last used ${formatRelativeTime(p.lastActivated)}.` : "Never switched to.")
              }
              checked={p.deletable && props.ticked.has(p.id)}
              disabled={!p.deletable || props.disabled === true}
              onChange={(): void => props.onToggle(p.id)}
            />
          ))}
        </div>
      </Section>
      <Checkbox
        label={`Also remove mods no profile uses any more (${frees})`}
        description="Only mods Event Horizon installed for revisions that dropped them, and only when no profile left enables them. Mods you installed yourself are never touched."
        checked={props.alsoMods}
        disabled={props.disabled === true}
        onChange={(): void => props.onAlsoMods(!props.alsoMods)}
      />
      <Callout tone="info" title="Never listed">
        <p>The collection's current profile, profiles you made or renamed yourself, and other collections' profiles.</p>
      </Callout>
    </div>
  );
}

/** Exported for the render harness: what actually happened. */
export function OldProfilesResult(props: { outcome: OldProfilesOutcome }): JSX.Element {
  const o = props.outcome;
  return (
    <div className="eh-stack eh-body">
      <p>
        Removed <strong>{o.profilesRemoved.length}</strong> profile(s)
        {o.modsRemoved.length > 0 ? ` and ${o.modsRemoved.length} mod(s) no profile used any more` : ""}.
      </p>
      {o.profilesFailed.length > 0 && (
        <Callout tone="warning" title={`${o.profilesFailed.length} profile(s) could not be removed`}>
          <p>Their mods were kept. Try again, or delete them from Vortex's Profiles page.</p>
          <ul>
            {o.profilesFailed.map((f) => (
              <li key={f.name}>
                {f.name}: {f.error}
              </li>
            ))}
          </ul>
        </Callout>
      )}
      {o.modsFailed.length > 0 && (
        <Callout tone="warning" title={`${o.modsFailed.length} mod(s) could not be removed`}>
          <ul>
            {o.modsFailed.slice(0, 10).map((f) => (
              <li key={f.mod.vortexModId}>
                {f.mod.name}: {f.error}
              </li>
            ))}
          </ul>
        </Callout>
      )}
    </div>
  );
}
