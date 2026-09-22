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

/**
 * The receipts this screen may speak for: the ACTIVE game's, newest first.
 *
 * One function, called by both the loader and the view model, because the
 * two had the same filter written twice and a copy is how they drift.
 */
export function heroCandidates(
  receipts: readonly InstallReceipt[],
  gameId: string | undefined,
): InstallReceipt[] {
  if (gameId === undefined) return [];
  return receipts.filter((r) => r.gameId === gameId);
}

/** Package file name → the collection it belongs to and its version. */
const buildLabel = (fileName: string): { slug: string; version: string } | undefined => {
  const m = /^(.*)-(\d+\.\d+\.\d+)\.(?:ehcoll|zip)$/i.exec(fileName);
  return m === null ? undefined : { slug: m[1], version: m[2] };
};

/**
 * The last health answer, per collection, with the moment it was taken.
 *
 * ─── WHY A CACHE, ON THE SCREEN THAT REFUSED ONE ──────────────────────
 * The disk card next door is behind a button precisely so the page does not
 * walk the filesystem on open — and this ran the Doctor's gather on every
 * mount, which opens one plugin header per recorded plugin: 1,597 of them on
 * the project's own reference collection, serially, in the game folder. Home
 * is the default route and remounts on every back-navigation, so that was
 * the price of looking at the dashboard.
 *
 * Sixty seconds, keyed on the receipt's identity AND its install time, so a
 * reinstall is never answered from the previous install's cache. It is a
 * cache of a MEASUREMENT, not of a decision, and the window is short enough
 * that a repair made in the Doctor shows up on the next visit.
 */
const healthCache = new Map<string, { at: number; checks: HealthCheck[] }>();
const HEALTH_TTL_MS = 60_000;

/** Exported so a test can prove the cache is per install, not per package. */
export function __clearHealthCache(): void {
  healthCache.clear();
}

/**
 * The health of one installed collection, from the Doctor's own cheap pass.
 *
 * Exported for the test that proves the memo above is keyed on the INSTALL:
 * a cache that answered a reinstall from the previous install's measurement
 * would be worse than no cache at all.
 */
export async function healthOf(
  api: types.IExtensionApi,
  receipt: InstallReceipt,
  receipts: readonly InstallReceipt[],
): Promise<HealthCheck[] | undefined> {
  const key = `${receipt.packageId}@${receipt.packageVersion}@${receipt.installedAt}`;
  const hit = healthCache.get(key);
  if (hit !== undefined && Date.now() - hit.at < HEALTH_TTL_MS) return hit.checks;
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
    const checks = evaluateHealth(toHealthView(receipt), obs);
    healthCache.set(key, { at: Date.now(), checks });
    return checks;
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
  /**
   * The game as Vortex reports it right now: version, and store when known.
   *
   * The hero always had fields for these and the view model filled them with
   * `undefined`, so the only place they were ever seen was a test fixture —
   * a screenshot of a feature that did not exist. They are also what makes
   * the version line on the hero checkable against a mod page.
   */
  game: { version: string | undefined; store: string | undefined };
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

  // This screen is about the game the player is standing in, and a hero from
  // another game would be a lie about what pressing Play would start — so no
  // active game means no hero, rather than the newest receipt of any game.
  const mine = heroCandidates(data.receipts, gameId);
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
      gameVersion: sources.game.version,
      store: sources.game.store,
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
    gameVersion: sources.game.version,
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
  const mine = heroCandidates(data.receipts, data.status.gameId);

  const [art, played] = await Promise.all([artFor(mine), playedFor()]);

  // Read once, here, so every figure on the screen describes one moment.
  const game = await (async (): Promise<DashboardSources["game"]> => {
    if (data.status.gameId === undefined) return { version: undefined, store: undefined };
    try {
      const [{ resolveGameVersion }, { discoveredStore }] = await Promise.all([
        import("../../../core/resolver/userState"),
        import("../../../core/comparePlugins"),
      ]);
      const state = api.getState();
      return {
        version: resolveGameVersion(state, data.status.gameId),
        store: discoveredStore(state, data.status.gameId),
      };
    } catch (err) {
      // Absent is the honest answer; the hero simply omits the clause.
      ehLog("debug", "dashboard.game-read-failed", { err });
      return { version: undefined, store: undefined };
    }
  })();

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
    const { getCollectionUpdateStore, pendingUpdateFor } = await import("../../runtime/collectionUpdates");
    for (const [, update] of getCollectionUpdateStore().all()) {
      /*
       * `pendingUpdateFor` is the judgement, and it is stricter than the
       * comparison this used to make: it requires the receipt to HAVE a
       * Nexus identity and to name the same collection. Re-deriving it here
       * defaulted a missing revision to 0, so reinstalling a collection from
       * a downloaded file — which overwrites the receipt, one file per
       * package id — advertised an update the player already had.
       */
      const match = mine.find((r) => r.packageId === update.packageId);
      const pending = match === undefined ? undefined : pendingUpdateFor(match, update);
      if (match !== undefined && pending !== undefined) {
        updates.set(match.packageId, pending.latestRevision);
      }
    }
  } catch (err) {
    ehLog("debug", "dashboard.updates-unavailable", { err });
  }

  return { data, game, health, art, played, updates };
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
