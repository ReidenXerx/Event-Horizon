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
 * ──────────────────────────────────────────────────────────────────────
 */

import * as fsp from "fs/promises";
import * as path from "path";

import { ehLog } from "../logging/ehLog";
import { getEventHorizonDir } from "../paths/appDataPaths";

export type ModVariant = { group: string; label: string; lowEnd?: true; default?: true };

export type VariantMember = { compareKey: string; name: string; label: string; lowEnd: boolean; isDefault: boolean };

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
 */
export function defaultVariantPicks(
  groups: ReadonlyMap<string, readonly VariantMember[]>,
  remembered: ReadonlyMap<string, string>,
  lowEndHardware: boolean,
): Map<string, VariantMember> {
  const picks = new Map<string, VariantMember>();
  for (const [group, members] of groups) {
    if (members.length === 0) continue;
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
    for (const [group, m] of picks) current.set(group, m.label);
    const file = picksFile(packageId);
    await fsp.mkdir(path.dirname(file), { recursive: true });
    await fsp.writeFile(file, JSON.stringify({ picks: Object.fromEntries(current) }, null, 2), "utf8");
    ehLog("info", "variant-picks.saved", { packageId, picks: Object.fromEntries(current) });
  } catch (err) {
    ehLog("warn", "variant-picks.save-failed", { packageId, err: String(err) });
  }
}
