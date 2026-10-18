/**
 * ──────────────────────────────────────────────────────────────────────
 * Versions of one mod: the player installs exactly one.
 *
 * Ivy Rev 15 (Fallout-collection, 2026-10-09): Ivy's FaceGen comes in 2048
 * and 1024; same plugin and scripts, different textures, 23 GB against 10 GB.
 * The curator installs every version as a mod and names them one group in the
 * collection config (`externalMods[id].variant`). Each member is an OPTIONAL
 * mod underneath, so everything that already lets an optional mod be absent
 * (summary, Doctor, rules, plugin order, deploy check) covers the versions the
 * player did not pick; this module only decides which one is picked.
 *
 * Owner poll, 2026-10-09: the pick is REMEMBERED across updates (no 10–23 GB
 * surprise), and on a Steam Deck / Proton install the version the curator
 * marks low-end is pre-selected. The player always sees every version and can
 * pick another.
 *
 * ─── STORE BUILDS (owner, 2026-10-18) ─────────────────────────────────
 * Meridia is built on GOG Skyrim; a Steam player needs Steam builds of SKSE
 * and five plugins, and must NOT get two GOG-only fixes. The curator installs
 * both builds and tags each member with its `store`. A group whose members
 * carry a store is not a choice: the member for the player's store is picked
 * and every other is left out, so a group with only a GOG member installs
 * nothing on Steam. A store Event Horizon cannot tell picks nothing until the
 * player answers which store their game is from (owner's pick: ask, never
 * guess the curator's store).
 * ──────────────────────────────────────────────────────────────────────
 */

import * as fsp from "fs/promises";
import * as path from "path";

import { ehLog } from "../logging/ehLog";
import { getEventHorizonDir } from "../paths/appDataPaths";

/** The stores whose builds differ and that a curator can tag a version with. */
export const GAME_STORES = ["steam", "gog"] as const;
export type GameStore = (typeof GAME_STORES)[number];

/** Vortex's discovered store, as one Event Horizon can pick builds for; anything else is undefined. */
export function asGameStore(store: string | undefined): GameStore | undefined {
  const s = store?.toLowerCase();
  return (GAME_STORES as readonly string[]).includes(s ?? "") ? (s as GameStore) : undefined;
}

export type ModVariant = { group: string; label: string; lowEnd?: true; default?: true; store?: GameStore };

export type VariantMember = {
  compareKey: string;
  name: string;
  label: string;
  lowEnd: boolean;
  isDefault: boolean;
  /** The store this member is the build for; absent on an ordinary version. */
  store?: GameStore;
};

/** A group of store builds: decided by the player's store, never offered as a choice. */
export function isStoreGroup(members: readonly VariantMember[]): boolean {
  return members.some((m) => m.store !== undefined);
}

/**
 * Does every player get one member of this group? A version choice always
 * installs one; store builds only when each store has a build. Meridia 1.0.32
 * (Skyrim-collection, 2026-10-18): both Honed Metal builds ship HonedMetal.esp,
 * and the master check called it optional because every member is.
 */
export function groupAlwaysInstalls(members: readonly VariantMember[]): boolean {
  if (members.length === 0) return false;
  if (!isStoreGroup(members)) return true;
  return GAME_STORES.every((s) => members.some((m) => m.store === s));
}

/**
 * Files every player gets from version groups, whichever member: the ones
 * each member of an always-installed group ships. `filesOf` names a member's
 * files by its compareKey, compared as given.
 */
export function filesEveryGroupProvides(
  groups: ReadonlyMap<string, readonly VariantMember[]>,
  filesOf: (compareKey: string) => readonly string[],
): Set<string> {
  const out = new Set<string>();
  for (const members of groups.values()) {
    if (!groupAlwaysInstalls(members)) continue;
    const [first, ...rest] = members.map((m) => new Set(filesOf(m.compareKey)));
    for (const f of first!) if (rest.every((s) => s.has(f))) out.add(f);
  }
  return out;
}

/**
 * The mods a player on `store` gets, as far as store builds go: every mod but
 * the builds tagged for another store. An unknown store keeps them all, which
 * is what every check did before store builds existed.
 */
export function modsForStore<M extends { state?: { variant?: ModVariant } }>(
  mods: readonly M[],
  store: string | undefined,
): M[] {
  const s = asGameStore(store);
  if (s === undefined) return [...mods];
  return mods.filter((m) => {
    const tagged = m.state?.variant?.store;
    return tagged === undefined || tagged === s;
  });
}

/** Does any mod in the collection come in store builds? */
export function hasStoreBuilds(mods: readonly { state?: { variant?: ModVariant } }[]): boolean {
  return mods.some((m) => m.state?.variant?.store !== undefined);
}

/**
 * The left-out keys of every store group for a player on `store`: each member
 * not built for it. `undefined` (store not known yet) leaves out every member.
 */
export function storeGroupSkips(
  groups: ReadonlyMap<string, readonly VariantMember[]>,
  store: GameStore | undefined,
): { storeKeys: string[]; skipped: string[] } {
  const storeKeys: string[] = [];
  const skipped: string[] = [];
  for (const members of groups.values()) {
    if (!isStoreGroup(members)) continue;
    for (const m of members) {
      storeKeys.push(m.compareKey);
      if (store === undefined || m.store !== store) skipped.push(m.compareKey);
    }
  }
  return { storeKeys, skipped };
}

/**
 * Store-group shape problems, for the build: every member tagged, and at most
 * one per store. A group mixing tagged and untagged members, or with two Steam
 * builds, has no single right answer for a player.
 */
export function storeGroupProblems(groups: ReadonlyMap<string, readonly VariantMember[]>): string[] {
  const out: string[] = [];
  for (const [group, members] of groups) {
    if (!isStoreGroup(members)) continue;
    const untagged = members.filter((m) => m.store === undefined);
    if (untagged.length > 0) {
      out.push(
        `Version group "${group}" mixes store builds with untagged versions (${untagged.map((m) => m.name).join(", ")}). ` +
          `Give every member a "store", or none.`,
      );
    }
    for (const store of GAME_STORES) {
      const same = members.filter((m) => m.store === store);
      if (same.length > 1) {
        out.push(`Version group "${group}" has ${same.length} ${store} builds (${same.map((m) => m.name).join(", ")}); keep one.`);
      }
    }
  }
  return out;
}

type VariantMod = { compareKey: string; name: string; state?: { variant?: ModVariant } };

/** The collection's version groups, members in manifest order. */
export function variantGroupsOf(mods: readonly VariantMod[]): Map<string, VariantMember[]> {
  const out = new Map<string, VariantMember[]>();
  for (const m of mods) {
    const v = m.state?.variant;
    if (v === undefined) continue;
    const members = out.get(v.group) ?? [];
    members.push({
      compareKey: m.compareKey,
      name: m.name,
      label: v.label,
      lowEnd: v.lowEnd === true,
      isDefault: v.default === true,
      ...(v.store !== undefined ? { store: v.store } : {}),
    });
    out.set(v.group, members);
  }
  return out;
}

/**
 * Which member of each group is picked: the remembered label when the group
 * still has it; else the low-end one on low-end hardware; else the one the
 * curator marked `default`; else the first in manifest order (an order the
 * build decides, which is why `default` exists: Ivy Rev 15's rule put 1024
 * before 2048).
 *
 * A store group is decided by `store` alone: its member for that store, or no
 * pick at all (no build for this store, or the store is not known yet).
 */
export function defaultVariantPicks(
  groups: ReadonlyMap<string, readonly VariantMember[]>,
  remembered: ReadonlyMap<string, string>,
  lowEndHardware: boolean,
  store?: GameStore,
): Map<string, VariantMember> {
  const picks = new Map<string, VariantMember>();
  for (const [group, members] of groups) {
    if (members.length === 0) continue;
    if (isStoreGroup(members)) {
      const built = store === undefined ? undefined : members.find((m) => m.store === store);
      if (built !== undefined) picks.set(group, built);
      continue;
    }
    const label = remembered.get(group);
    const pick =
      (label !== undefined ? members.find((m) => m.label === label) : undefined) ??
      (lowEndHardware ? members.find((m) => m.lowEnd) : undefined) ??
      members.find((m) => m.isDefault) ??
      members[0]!;
    picks.set(group, pick);
  }
  return picks;
}

/** compareKeys of every member not picked: the optional mods this install leaves out. */
export function unpickedKeys(
  groups: ReadonlyMap<string, readonly VariantMember[]>,
  picks: ReadonlyMap<string, VariantMember>,
): string[] {
  const out: string[] = [];
  for (const [group, members] of groups) {
    const pick = picks.get(group);
    for (const m of members) if (m.compareKey !== pick?.compareKey) out.push(m.compareKey);
  }
  return out;
}

/** The picked member of each group, read back from the skipped set. */
export function picksFromSkipped(
  groups: ReadonlyMap<string, readonly VariantMember[]>,
  skipped: ReadonlySet<string>,
): Map<string, VariantMember> {
  const picks = new Map<string, VariantMember>();
  for (const [group, members] of groups) {
    const pick = members.find((m) => !skipped.has(m.compareKey));
    if (pick !== undefined) picks.set(group, pick);
  }
  return picks;
}

function picksFile(packageId: string): string {
  return getEventHorizonDir("choices", `${packageId}.versions.json`);
}

/** The player's remembered version per group, by label. Empty when none. */
export async function readVariantPicks(packageId: string): Promise<Map<string, string>> {
  try {
    const raw = JSON.parse(await fsp.readFile(picksFile(packageId), "utf8")) as { picks?: Record<string, unknown> };
    return new Map(
      Object.entries(raw.picks ?? {}).filter((e): e is [string, string] => typeof e[1] === "string"),
    );
  } catch {
    return new Map();
  }
}

/** Remember the player's pick per group for the next update. Never throws. */
export async function saveVariantPicks(packageId: string, picks: ReadonlyMap<string, VariantMember>): Promise<void> {
  if (picks.size === 0) return;
  try {
    const current = await readVariantPicks(packageId);
    // A store build is the game's fact, not a preference: nothing to remember.
    for (const [group, m] of picks) if (m.store === undefined) current.set(group, m.label);
    const file = picksFile(packageId);
    await fsp.mkdir(path.dirname(file), { recursive: true });
    await fsp.writeFile(file, JSON.stringify({ picks: Object.fromEntries(current) }, null, 2), "utf8");
    ehLog("info", "variant-picks.saved", { packageId, picks: Object.fromEntries(current) });
  } catch (err) {
    ehLog("warn", "variant-picks.save-failed", { packageId, err: String(err) });
  }
}
