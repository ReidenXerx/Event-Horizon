/**
 * ──────────────────────────────────────────────────────────────────────
 * Restore points: one step back from anything an agent changed.
 *
 * An agent that disables the wrong twelve mods, or "fixes" a load order into a
 * crash, leaves the player unable to say what it was before. So before every
 * command that changes the setup, the channel writes down what the active
 * profile looked like: which mods were enabled, every mod rule, LOOT's
 * userlist, and the plugin list in order. `restore` puts that back through
 * the same verified routes the verbs use.
 *
 * What it cannot bring back, it says: a mod removed since is gone from
 * staging (its archive id is in the reply, to install it again). A mod
 * installed since is disabled, never removed: removing is the user's call
 * (see ownerConsent). Nothing here deploys; the reply says to.
 * ──────────────────────────────────────────────────────────────────────
 */

import * as fs from "fs";
import * as path from "path";

import { getEventHorizonRoot } from "../paths/appDataPaths";

export const KEEP = 10;

export type UserlistPlugin = { name: string; group?: string; after: string[]; req: string[]; inc: string[] };

export type RestorePoint = {
  id: string;
  at: string;
  /** The command it was taken before. */
  verb: string;
  gameId: string;
  profileId: string;
  mods: Record<string, { enabled: boolean; name: string; archiveId?: string }>;
  /** Vortex's own rule objects, per mod that has any. */
  modRules: Record<string, unknown[]>;
  plugins: Array<{ name: string; enabled: boolean }>;
  userlist: UserlistPlugin[];
};

export function restorePointsFile(root: string = getEventHorizonRoot()): string {
  return path.join(root, "agent-restore-points.json");
}

export function loadRestorePoints(file: string = restorePointsFile()): RestorePoint[] {
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
    return Array.isArray(raw) ? (raw as RestorePoint[]) : [];
  } catch {
    return [];
  }
}

/** Newest first; keeps the last KEEP. */
export function saveRestorePoint(point: RestorePoint, file: string = restorePointsFile()): void {
  const all = [point, ...loadRestorePoints(file).filter((p) => p.id !== point.id)].slice(0, KEEP);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(all));
}

/** A one-line account of a point, for listings. */
export function summarizePoint(p: RestorePoint): Record<string, unknown> {
  return {
    id: p.id,
    at: p.at,
    before: p.verb,
    gameId: p.gameId,
    profileId: p.profileId,
    enabledMods: Object.values(p.mods).filter((m) => m.enabled).length,
    mods: Object.keys(p.mods).length,
    plugins: p.plugins.length,
  };
}

const ruleKey = (r: unknown): string => JSON.stringify(r, Object.keys((r ?? {}) as object).sort());

/** What restoring would change, computed only from the two states. */
export type RestorePlan = {
  enable: string[];
  disable: string[];
  /** Installed after the point: disabled, not removed. */
  installedSince: Array<{ id: string; name: string }>;
  /** Removed after the point: cannot come back from here. */
  removedSince: Array<{ id: string; name: string; archiveId?: string }>;
  modRulesToRemove: Array<{ modId: string; rule: unknown }>;
  modRulesToAdd: Array<{ modId: string; rule: unknown }>;
  userlistToRemove: Array<{ pluginId: string; reference: string; type: "after" | "requires" | "incompatible" }>;
  userlistToAdd: UserlistPlugin[];
  pluginOrder: Array<{ name: string; enabled: boolean }>;
};

export function planRestore(
  point: RestorePoint,
  now: {
    mods: Record<string, { enabled: boolean; name: string }>;
    modRules: Record<string, unknown[]>;
    plugins: Array<{ name: string; enabled: boolean }>;
    userlist: UserlistPlugin[];
  },
): RestorePlan {
  const plan: RestorePlan = {
    enable: [],
    disable: [],
    installedSince: [],
    removedSince: [],
    modRulesToRemove: [],
    modRulesToAdd: [],
    userlistToRemove: [],
    userlistToAdd: [],
    pluginOrder: [],
  };
  for (const [id, was] of Object.entries(point.mods)) {
    const is = now.mods[id];
    if (is === undefined) {
      plan.removedSince.push({ id, name: was.name, ...(was.archiveId !== undefined ? { archiveId: was.archiveId } : {}) });
      continue;
    }
    if (was.enabled && !is.enabled) plan.enable.push(id);
    if (!was.enabled && is.enabled) plan.disable.push(id);
  }
  for (const [id, is] of Object.entries(now.mods)) {
    if (point.mods[id] !== undefined) continue;
    plan.installedSince.push({ id, name: is.name });
    if (is.enabled) plan.disable.push(id);
  }

  for (const id of Object.keys(now.mods)) {
    if (point.mods[id] === undefined) continue;
    const was = point.modRules[id] ?? [];
    const is = now.modRules[id] ?? [];
    const wasKeys = new Set(was.map(ruleKey));
    const isKeys = new Set(is.map(ruleKey));
    for (const r of is) if (!wasKeys.has(ruleKey(r))) plan.modRulesToRemove.push({ modId: id, rule: r });
    for (const r of was) if (!isKeys.has(ruleKey(r))) plan.modRulesToAdd.push({ modId: id, rule: r });
  }

  const lc = (s: string): string => s.toLowerCase();
  const byName = (list: UserlistPlugin[]): Map<string, UserlistPlugin> => new Map(list.map((p) => [lc(p.name), p]));
  const was = byName(point.userlist);
  const is = byName(now.userlist);
  const kinds = [
    ["after", "after"],
    ["req", "requires"],
    ["inc", "incompatible"],
  ] as const;
  for (const [key, p] of is) {
    const before = was.get(key);
    for (const [k, type] of kinds) {
      const had = new Set((before?.[k] ?? []).map(lc));
      for (const ref of p[k]) if (!had.has(lc(ref))) plan.userlistToRemove.push({ pluginId: key, reference: lc(ref), type });
    }
  }
  for (const [key, p] of was) {
    const after = is.get(key);
    const missing: UserlistPlugin = { name: p.name, after: [], req: [], inc: [] };
    let any = false;
    for (const [k] of kinds) {
      const has = new Set((after?.[k] ?? []).map(lc));
      for (const ref of p[k]) {
        if (!has.has(lc(ref))) {
          missing[k].push(ref);
          any = true;
        }
      }
    }
    if (p.group !== undefined && p.group !== after?.group) {
      missing.group = p.group;
      any = true;
    }
    if (any) plan.userlistToAdd.push(missing);
  }

  const present = new Set(now.plugins.map((p) => lc(p.name)));
  plan.pluginOrder = point.plugins.filter((p) => present.has(lc(p.name)));
  return plan;
}
