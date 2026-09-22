/**
 * Everything the dashboard reads, and where it comes from.
 *
 * The view is presentational and this is the only place that touches Vortex,
 * the disk or Nexus. Each source is independent and each failure is local: a
 * Nexus call that times out leaves the curator panel saying so while every
 * number read off this machine still renders.
 *
 * ─── WHAT IS DELIBERATELY NOT DONE HERE ─────────────────────────────────
 * No disk walk on open. Measuring what modding uses means stating hundreds of
 * thousands of files, which on a real collection took minutes — so it happens
 * when the player presses Measure, and until then the card says it does not
 * know rather than showing a plausible number.
 */
import * as React from "react";
import type { types } from "@nexusmods/vortex-api";

import { ehLog } from "../../../core/logging/ehLog";
import { collectionFigures, healthRollup, since } from "./summary";
import { loadDashboardData, type DashboardData } from "./data";
import type {
  CollectionTileView,
  CuratorCollectionView,
  DashboardHeroView,
  DashboardMode,
  DashboardViewModel,
} from "./DashboardView";
import type { InstallReceipt } from "../../../types/installLedger";
import type { HealthCheck } from "../../../core/doctor/health";

/** Package file name → the collection it belongs to and its version. */
const buildLabel = (fileName: string): { slug: string; version: string } | undefined => {
  const m = /^(.*)-(\d+\.\d+\.\d+)\.(?:ehcoll|zip)$/i.exec(fileName);
  return m === null ? undefined : { slug: m[1], version: m[2] };
};

/** The health of one installed collection, from the Doctor's own cheap pass. */
async function healthOf(
  api: types.IExtensionApi,
  receipt: InstallReceipt,
  receipts: readonly InstallReceipt[],
): Promise<HealthCheck[] | undefined> {
  try {
    const [{ gatherObservations }, { evaluateHealth, doctorLightFlagBaseline }, { toHealthView }] =
      await Promise.all([
        import("../../../core/doctor/gather"),
        import("../../../core/doctor/health"),
        import("../../../core/doctor/receiptView"),
      ]);
    const { baseline } = doctorLightFlagBaseline(
      receipt.gameId,
      receipt.rulesApplication?.baselinePluginOrder,
      receipt.rulesApplication?.baselineLightFlagBit,
    );
    const obs = await gatherObservations({
      api,
      gameId: receipt.gameId,
      receiptProfileId: receipt.vortexProfileId,
      orderReceipt: receipt,
      receipts: receipts as InstallReceipt[],
      ...(baseline !== undefined ? { recordedPlugins: baseline } : {}),
    });
    return evaluateHealth(toHealthView(receipt), obs);
  } catch (err) {
    // A dashboard that cannot check health still shows every other number;
    // `undefined` renders as "unknown", which is the honest word for it.
    ehLog("debug", "dashboard.health-failed", { packageId: receipt.packageId, err });
    return undefined;
  }
}

async function artFor(receipts: readonly InstallReceipt[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  try {
    const [{ loadCachedPresentation }, { getEventHorizonDir }] = await Promise.all([
      import("../../../core/presentation/presentationCache"),
      import("../../../core/paths/appDataPaths"),
    ]);
    const cacheRoot = getEventHorizonDir("presentation");
    for (const r of receipts) {
      const shown = await loadCachedPresentation(cacheRoot, r.packageId, r.packageVersion).catch(() => undefined);
      const url = shown?.header?.url ?? shown?.tile?.url;
      if (url !== undefined) out.set(r.packageId, url);
    }
  } catch (err) {
    ehLog("debug", "dashboard.art-failed", { err });
  }
  return out;
}

/** When each collection was last actually launched, from the feedback store. */
async function playedFor(): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  try {
    const [{ loadFeedback }, { getEventHorizonRoot }] = await Promise.all([
      import("../../../core/feedback/collectionFeedback"),
      import("../../../core/paths/appDataPaths"),
    ]);
    const store = await loadFeedback(getEventHorizonRoot());
    for (const entry of Object.values(store.entries ?? {})) {
      const e = entry as { packageId?: string; playedAt?: string };
      if (e.packageId === undefined || e.playedAt === undefined) continue;
      const prev = out.get(e.packageId);
      if (prev === undefined || Date.parse(e.playedAt) > Date.parse(prev)) out.set(e.packageId, e.playedAt);
    }
  } catch (err) {
    ehLog("debug", "dashboard.played-failed", { err });
  }
  return out;
}

export interface DashboardSources {
  data: DashboardData;
  health: Map<string, HealthCheck[]>;
  art: Map<string, string>;
  played: Map<string, string>;
  updates: Map<string, number>;
}

/**
 * Build the view model. Pure, so the render harness can drive it with
 * fixtures and a screenshot proves what a real machine would show.
 */
export function toViewModel(args: {
  sources: DashboardSources;
  mode: DashboardMode;
  disk: DashboardViewModel["disk"];
  diskBusy: boolean;
  curatorBusy: boolean;
  curatorStats: Map<string, import("../../../core/nexus/collectionStats").CollectionStats>;
  now?: number;
}): DashboardViewModel {
  const { sources, now = Date.now() } = args;
  const { data } = sources;
  const gameId = data.status.gameId;

  // The active game's collections first: this screen is about the game the
  // player is standing in, and a hero from another game would be a lie about
  // what pressing Play would start.
  const mine = data.receipts.filter((r) => gameId === undefined || r.gameId === gameId);
  const [first, ...rest] = mine;

  const heroOf = (r: InstallReceipt): DashboardHeroView => {
    const checks = sources.health.get(r.packageId);
    return {
      packageId: r.packageId,
      name: r.packageName,
      version: r.packageVersion,
      revision: r.nexusCollection?.revisionNumber,
      artUrl: sources.art.get(r.packageId),
      gameLabel: data.status.gameLabel,
      gameVersion: undefined,
      store: undefined,
      profileName: r.vortexProfileName,
      lastPlayed: since(sources.played.get(r.packageId), now),
      installedWhen: since(r.installedAt, now),
      // No checks is "unknown", which `healthRollup` already renders as such.
      health: healthRollup(checks ?? []),
      figures: collectionFigures(r),
      updateToRevision: sources.updates.get(r.packageId),
    };
  };

  const tiles: CollectionTileView[] = rest.map((r) => ({
    packageId: r.packageId,
    name: r.packageName,
    version: r.packageVersion,
    gameLabel: data.status.gameLabel,
    artUrl: sources.art.get(r.packageId),
    lastPlayed: since(sources.played.get(r.packageId), now),
    updateToRevision: sources.updates.get(r.packageId),
  }));

  // One cockpit card per curated collection that has a Nexus page: a config
  // with no page has no stats to show and belongs on the Build screen.
  const curator: CuratorCollectionView[] = [];
  for (const cfg of data.curatorConfigs) {
    const nexus = cfg.config?.nexusCollection;
    if (nexus === undefined) continue;
    const builds = data.builtPackages
      .map((p) => ({ parsed: buildLabel(p.fileName), p }))
      .filter((b) => b.parsed !== undefined && b.parsed.slug === cfg.slug)
      .sort((a, b) => a.p.modifiedAt - b.p.modifiedAt)
      .map((b) => ({ label: b.parsed!.version, megabytes: Math.round(b.p.sizeBytes / 1e6) }));
    curator.push({
      slug: nexus.slug,
      // Nexus's own name for it when the link carried one; the slug otherwise.
      name: nexus.name ?? cfg.slug,
      gameLabel: nexus.gameDomain,
      stats: args.curatorStats.get(nexus.slug),
      builds,
    });
  }

  return {
    mode: args.mode,
    gameLabel: data.status.gameLabel,
    gameVersion: undefined,
    vortexVersion: data.status.vortexVersion,
    profileName: data.status.profileName,
    hero: first === undefined ? undefined : heroOf(first),
    tiles,
    disk: args.disk,
    diskBusy: args.diskBusy,
    curator,
    curatorBusy: args.curatorBusy,
    curatorEmpty: curator.length === 0,
  };
}

/** Load every source. Each one fails on its own without taking the rest down. */
export async function loadDashboardSources(api: types.IExtensionApi): Promise<DashboardSources> {
  const data = await loadDashboardData(api);
  const gameId = data.status.gameId;
  const mine = data.receipts.filter((r) => gameId === undefined || r.gameId === gameId);

  const [art, played] = await Promise.all([artFor(mine), playedFor()]);

  // Health for the collection the hero shows. The others are a tile with a
  // name on it, and checking every collection on open would run the Doctor's
  // gather once per receipt for numbers nobody is looking at yet.
  const health = new Map<string, HealthCheck[]>();
  const hero = mine[0];
  if (hero !== undefined) {
    const checks = await healthOf(api, hero, data.receipts);
    if (checks !== undefined) health.set(hero.packageId, checks);
  }

  const updates = new Map<string, number>();
  try {
    const { getCollectionUpdateStore } = await import("../../runtime/collectionUpdates");
    for (const [, update] of getCollectionUpdateStore().all()) {
      // The store already decided an update EXISTS; the comparison here is
      // only against the receipt this dashboard is showing, which may be an
      // older install than the one the check ran for.
      const match = mine.find((r) => r.packageId === update.packageId);
      if (match !== undefined && update.latestRevision > (match.nexusCollection?.revisionNumber ?? 0)) {
        updates.set(match.packageId, update.latestRevision);
      }
    }
  } catch (err) {
    ehLog("debug", "dashboard.updates-unavailable", { err });
  }

  return { data, health, art, played, updates };
}

/** React state for the dashboard: sources, mode, and the two lazy panels. */
export function useDashboardView(api: types.IExtensionApi): {
  sources: DashboardSources | undefined;
  error: boolean;
  reload: () => void;
} {
  const [sources, setSources] = React.useState<DashboardSources | undefined>(undefined);
  const [error, setError] = React.useState(false);
  const [tick, setTick] = React.useState(0);

  React.useEffect(() => {
    let alive = true;
    setSources(undefined);
    setError(false);
    void (async (): Promise<void> => {
      try {
        const loaded = await loadDashboardSources(api);
        if (alive) setSources(loaded);
      } catch (err) {
        ehLog("warn", "dashboard.load-failed", { err });
        if (alive) setError(true);
      }
    })();
    return (): void => {
      alive = false;
    };
  }, [api, tick]);

  return { sources, error, reload: React.useCallback(() => setTick((t) => t + 1), []) };
}
