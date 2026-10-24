/**
 * Files a mod's archive puts back on a player's machine that collide with
 * another collection mod's copy — where the collection's rules do not keep the
 * curator's copy on top.
 *
 * ─── WHY ───────────────────────────────────────────────────────────────────
 * Ivy Rev 26 (sudo_bluuuk, 2026-10-25): the curator had deleted
 * PersistantSubgraphInfoAndOffsetData.txt from four mods' staging folders
 * (MTs-255 FPA Replacer, MTs-255 FPAR, BO6 AS Val, ZaZOut4), so their own game
 * had no conflict at all and JNFA's merged 3,804-line copy won by being the only
 * one. A player installs those four from their archives, gets the file back,
 * and with no rule ordering them one of the 368-line copies won. No save loaded.
 *
 * The deployment-winner record cannot see this: it is made from the curator's
 * staging and deployment, where those files do not exist. Only the archives
 * say what a player will get.
 *
 * Content is compared by SIZE: an archive entry and a staged file with the same
 * size are taken as the same file. It can miss an edit that kept the length,
 * and it keeps two mods shipping one identical file from being reported.
 */

import type { EhcollRule } from "../../types/ehcoll";
import { conflictWinner } from "../environment/nativePluginCompat";
import type { ArchiveRestore } from "./selfCheckMod";

export type RestoreConflictMod = {
  compareKey: string;
  name: string;
  modType?: string;
  enabled?: boolean;
  /** Installed on a player's machine from its archive and left there (not mirrored, not bundled). */
  installsFromArchive: boolean;
  files: ReadonlyArray<{ path: string; size?: number }>;
};

export type RestoreConflict = {
  /** The mod whose archive puts the file back. */
  restorer: string;
  /** The mod whose copy the curator's game uses. */
  keeper: string;
  /** The keeper's paths, as staged. */
  paths: string[];
  /** The collection's rules put the restorer last — the player gets its copy for certain. */
  restorerWins: boolean;
};

const norm = (p: string): string => p.replace(/\\/g, "/").toLowerCase();

export function findArchiveRestoreConflicts(input: {
  mods: readonly RestoreConflictMod[];
  restoresByKey: ReadonlyMap<string, readonly ArchiveRestore[]>;
  rules: readonly EhcollRule[];
}): RestoreConflict[] {
  // Every enabled mod's staged files, by lowercase path and by basename for tails.
  type Staged = { key: string; path: string; size?: number; modType: string };
  const byPath = new Map<string, Staged[]>();
  const byBase = new Map<string, Staged[]>();
  for (const m of input.mods) {
    if (m.enabled === false) continue;
    for (const f of m.files) {
      const p = norm(f.path);
      const s: Staged = { key: m.compareKey, path: f.path, ...(f.size !== undefined ? { size: f.size } : {}), modType: m.modType ?? "" };
      byPath.set(p, [...(byPath.get(p) ?? []), s]);
      const base = p.slice(p.lastIndexOf("/") + 1);
      byBase.set(base, [...(byBase.get(base) ?? []), s]);
    }
  }

  const groups = new Map<string, RestoreConflict>();
  for (const m of input.mods) {
    if (m.enabled === false || !m.installsFromArchive) continue;
    const restores = input.restoresByKey.get(m.compareKey);
    if (restores === undefined || restores.length === 0) continue;
    const type = m.modType ?? "";
    for (const r of restores) {
      const p = norm(r.path);
      const candidates = r.exact
        ? (byPath.get(p) ?? [])
        : (byBase.get(p.slice(p.lastIndexOf("/") + 1)) ?? []).filter((s) => {
            const q = norm(s.path);
            return q === p || p.endsWith(`/${q}`);
          });
      for (const s of candidates) {
        if (s.key === m.compareKey || s.modType !== type) continue;
        // Same size: the same file, as far as the build can tell — nothing changes for the player.
        if (r.size === undefined || s.size === undefined || r.size === s.size) continue;
        const winner = conflictWinner([m.compareKey, s.key], input.rules);
        if (winner === s.key) continue;
        const id = `${m.compareKey}\u0000${s.key}`;
        const g = groups.get(id) ?? { restorer: m.compareKey, keeper: s.key, paths: [], restorerWins: winner === m.compareKey };
        g.paths.push(s.path);
        groups.set(id, g);
      }
    }
  }
  return [...groups.values()].sort((a, b) => b.paths.length - a.paths.length || (a.restorer < b.restorer ? -1 : 1));
}

/** One self-contained warning per pair, naming the rule that keeps the curator's copy. */
export function describeArchiveRestoreConflicts(
  conflicts: readonly RestoreConflict[],
  nameOf: (key: string) => string,
  max = 20,
): string[] {
  if (conflicts.length === 0) return [];
  const lines = conflicts.slice(0, max).map((c) => {
    const restorer = nameOf(c.restorer);
    const keeper = nameOf(c.keeper);
    const n = c.paths.length;
    return (
      `"${restorer}" puts back ${n} file${n === 1 ? "" : "s"} its folder here does not have, which ` +
      (c.restorerWins
        ? `the collection's rules let replace "${keeper}"'s copy`
        : `can replace "${keeper}"'s copy (no rule orders the two)`) +
      ` on a player's game, e.g. ${c.paths.slice(0, 2).join(", ")}. ` +
      (c.restorerWins
        ? `Change the rule so "${keeper}" loads after "${restorer}", or mirror "${restorer}" so its deletions ship.`
        : `Add a rule: "${keeper}" loads after "${restorer}" — or mirror "${restorer}" so its deletions ship.`)
    );
  });
  if (conflicts.length > max) lines.push(`…and ${conflicts.length - max} more pairs of mods like these.`);
  return lines;
}
