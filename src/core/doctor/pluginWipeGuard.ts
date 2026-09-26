/**
 * ──────────────────────────────────────────────────────────────────────
 * Catch a wiped plugin list, and offer the last good one back.
 *
 * Measured on the owner's machine, 2026-09-26: Fallout 4 AE's own load-order
 * manager rewrote the shared %LOCALAPPDATA%\Fallout4\Plugins.txt on its
 * first launch, and Vortex imported the result into BOTH profiles. The
 * old-gen profile kept all 807 entries with none active. Nothing errored;
 * the next launch would simply have loaded no mods.
 *
 * So Event Horizon keeps each profile's last GOOD plugin list (names, order,
 * enabled) in <EH root>/plugin-snapshots/<profileId>.json, and when the
 * active count collapses it raises one warning with a Restore button that
 * replays that list through the installer's own writer (no LOOT sort, since
 * the snapshot IS the order). Owner poll, 2026-09-26: "Warn + one-click
 * restore", never automatic.
 *
 * ─── A WIPED LIST IS NEVER THE BASELINE ───────────────────────────────
 * The first look on a machine has no snapshot, and the list it sees may
 * already be the wiped one (the owner's was). A list with almost nothing
 * active is therefore never saved: blessing it would make Restore restore
 * the wipe.
 * ──────────────────────────────────────────────────────────────────────
 */

import * as fs from "fs";
import * as path from "path";
import type { types } from "@nexusmods/vortex-api";

import { ehLog } from "../logging/ehLog";
import { getEHRuntime } from "../../ui/runtime/ehRuntime";
import { getEventHorizonRoot } from "../paths/appDataPaths";
import { readPluginList } from "../curator/pluginPool";

export const WIPE_NOTIFICATION_ID = "event-horizon-plugins-wiped";

export type PluginSnapshotEntry = { name: string; enabled: boolean; loadOrder?: number };
export type PluginSnapshot = {
  profileId: string;
  gameId: string;
  savedAt: string;
  active: number;
  entries: PluginSnapshotEntry[];
};

/** Below this many active plugins a profile is too small for "collapsed" to mean anything. */
export const MIN_ACTIVE_FOR_GUARD = 20;
/** Collapsed: active fell to this share of the snapshot's, or below. */
export const COLLAPSE_SHARE = 0.05;

export type WipeVerdict =
  | { kind: "collapsed"; before: number; now: number }
  | { kind: "unsettled" }
  | { kind: "ok" };

/**
 * Pure: is this list a collapse of the snapshot?
 *
 * A list that lost most of its ENTRIES is mid-change (a profile switch or a
 * reload in flight), not a wipe: the wipe keeps every entry and switches them
 * off. That one is judged on the next settled look.
 */
export function assessWipe(snapshot: PluginSnapshot | undefined, entries: number, active: number): WipeVerdict {
  if (snapshot === undefined || snapshot.active < MIN_ACTIVE_FOR_GUARD) return { kind: "ok" };
  if (entries < snapshot.entries.length * 0.5) return { kind: "unsettled" };
  if (active <= Math.floor(snapshot.active * COLLAPSE_SHARE)) {
    return { kind: "collapsed", before: snapshot.active, now: active };
  }
  return { kind: "ok" };
}

/** Pure: may this list become the profile's last good one? */
export function worthSaving(entries: number, active: number): boolean {
  if (entries === 0 || active === 0) return false;
  // Almost everything off is the wipe's signature, never a baseline.
  return !(entries >= MIN_ACTIVE_FOR_GUARD && active <= entries * COLLAPSE_SHARE);
}

export function snapshotPath(profileId: string, root: string = getEventHorizonRoot()): string {
  return path.join(root, "plugin-snapshots", `${profileId.replace(/[^A-Za-z0-9_-]/g, "_")}.json`);
}

export function loadSnapshot(profileId: string, root?: string): PluginSnapshot | undefined {
  try {
    const s = JSON.parse(fs.readFileSync(snapshotPath(profileId, root), "utf8")) as PluginSnapshot;
    return Array.isArray(s.entries) ? s : undefined;
  } catch {
    return undefined;
  }
}

function saveSnapshot(s: PluginSnapshot, root?: string): void {
  const file = snapshotPath(s.profileId, root);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(s), "utf8");
  fs.renameSync(`${file}.tmp`, file);
}

/** The active profile's non-native plugins, as Vortex holds them now. */
function currentList(api: types.IExtensionApi): PluginSnapshotEntry[] {
  return readPluginList(api.getState())
    .filter((p) => !p.isNative && p.fromDisabledMod !== true)
    .map((p) => ({ name: p.name, enabled: p.enabled, ...(p.loadOrder !== undefined ? { loadOrder: p.loadOrder } : {}) }));
}

function sameList(a: readonly PluginSnapshotEntry[], b: readonly PluginSnapshotEntry[]): boolean {
  return a.length === b.length && a.every((x, i) => x.name === b[i]!.name && x.enabled === b[i]!.enabled);
}

/** Replays a snapshot into the active profile through the installer's writer. */
export async function restoreSnapshot(api: types.IExtensionApi, snapshot: PluginSnapshot): Promise<string> {
  const { applyPluginOrder } = await import("../installer/applyPluginOrder");
  const order = [...snapshot.entries].sort((a, b) => (a.loadOrder ?? 1e9) - (b.loadOrder ?? 1e9));
  const r = await applyPluginOrder({
    api,
    gameId: snapshot.gameId,
    collectionId: "event-horizon-wipe-guard",
    order: order.map((e) => ({ name: e.name, enabled: e.enabled })),
    skipSort: true,
  });
  ehLog("info", "plugins.wipe.restored", { profileId: snapshot.profileId, entries: order.length, corrections: r.enabledCorrections, notes: r.notes });
  return r.pinned
    ? `Restored ${snapshot.active} active plugins from ${new Date(snapshot.savedAt).toLocaleString()}.`
    : `Could not restore the plugin list: ${r.notes.join("; ")}`;
}

let started = false;
export function startPluginWipeGuard(api: types.IExtensionApi): void {
  if (started) return;
  started = true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  /** profileId|snapshot time already warned about, so one wipe is one notification. */
  let warned = "";

  const look = (): void => {
    try {
      if (getEHRuntime().getSnapshot().installBusy) return; // an install rewrites the list by design
      const state = api.getState();
      const profileId = state.settings?.profiles?.activeProfileId as string | undefined;
      const gameId = profileId !== undefined ? (state.persistent?.profiles?.[profileId]?.gameId as string | undefined) : undefined;
      if (profileId === undefined || gameId === undefined) return;
      const list = currentList(api);
      if (list.length === 0) return; // not a plugin-based game, or not loaded yet
      const active = list.filter((e) => e.enabled).length;
      const snapshot = loadSnapshot(profileId);
      const verdict = assessWipe(snapshot, list.length, active);

      if (verdict.kind === "unsettled") return;
      if (verdict.kind === "collapsed" && snapshot !== undefined) {
        const key = `${profileId}|${snapshot.savedAt}`;
        if (warned === key) return;
        warned = key;
        ehLog("warn", "plugins.wipe.detected", { gameId, profileId, before: verdict.before, now: verdict.now, entries: list.length });
        api.sendNotification?.({
          id: WIPE_NOTIFICATION_ID,
          type: "warning",
          title: "Your plugin list was wiped",
          message:
            `Only ${verdict.now} of your ${verdict.before} plugins are still enabled in this profile. Something outside Vortex ` +
            `rewrote plugins.txt (Fallout 4 AE's own load-order manager does this). Restore brings back the last good list ` +
            `from ${new Date(snapshot.savedAt).toLocaleString()}.`,
          displayMS: undefined,
          actions: [
            {
              title: "Restore",
              action: (dismissIt): void => {
                dismissIt();
                void restoreSnapshot(api, snapshot).then(
                  (msg) => api.sendNotification?.({ type: "success", message: msg, displayMS: 8000 }),
                  (err) => api.sendNotification?.({ type: "error", message: `Could not restore the plugin list: ${String((err as Error)?.message ?? err)}` }),
                );
              },
            },
            {
              title: "Keep as is",
              action: (dismissIt): void => {
                dismissIt();
                // The user chose this list: it becomes the baseline, so it is not warned about again.
                saveSnapshot({ profileId, gameId, savedAt: new Date().toISOString(), active, entries: list });
                ehLog("info", "plugins.wipe.kept", { profileId, active });
              },
            },
          ],
        });
        return;
      }

      // Healthy: back from a wipe, or simply a change. Keep the last good list current.
      if (warned.startsWith(`${profileId}|`)) {
        api.dismissNotification?.(WIPE_NOTIFICATION_ID);
        warned = "";
      }
      if (worthSaving(list.length, active) && (snapshot === undefined || !sameList(snapshot.entries, list))) {
        saveSnapshot({ profileId, gameId, savedAt: new Date().toISOString(), active, entries: list });
      }
    } catch (err) {
      ehLog("warn", "plugins.wipe.look-failed", { err });
    }
  };

  const schedule = (ms: number): void => {
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      look();
    }, ms);
  };

  api.onStateChange?.(["loadOrder"], () => schedule(3000));
  api.onStateChange?.(["settings", "profiles", "activeProfileId"], () => schedule(3000));
  // Vortex imports plugins.txt at start, which is exactly when a wipe made outside it shows.
  schedule(10000);
}
