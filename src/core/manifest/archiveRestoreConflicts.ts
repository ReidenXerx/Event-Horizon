/**
 * Files a mod's archive puts back on a player's machine that would replace the
 * copy the curator's game actually uses — where the collection's rules do not
 * keep the curator's copy on top.
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
 * ─── AGAINST THE LIVE WINNER, THROUGH ANY CHAIN ────────────────────────────
 * The first cut (0.2.92) compared a restored file with EVERY mod that stages
 * the path. On Ivy 1.0.57 all 12 of its warnings were for mods that lose the
 * path anyway: JNFA wins it, and the rules put JNFA after every one of them. So
 * a restored file is judged only against the copy the curator's game uses (the
 * recorded deployment winner, or the only mod that stages it), and is harmless
 * when that mod deploys after the restorer through any chain of rules.
 *
 * ─── A TAIL NEVER CROSSES A DATA FOLDER ────────────────────────────────────
 * An archive path whose install place is not known (an installer that could not
 * be replayed, or a placement Vortex makes order-dependent) is matched by its
 * tail. `00 Main/Meshes/AnimTextData/x` matched a mod staging `AnimTextData/x` —
 * Data\AnimTextData, a folder the game never reads — by dropping `Meshes/`. Only
 * wrapper folders may be dropped: never one named like game data.
 *
 * Content is compared by SIZE: an archive entry and a staged file with the same
 * size are taken as the same file. It can miss an edit that kept the length,
 * and it keeps two mods shipping one identical file from being reported.
 */

import type { EhcollDeploymentWinner, EhcollRule } from "../../types/ehcoll";
import { deploysAfter, normPath } from "./deploymentWinners";
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
  /** The restorer's installer could not be replayed: it MAY put these back. */
  maybe: boolean;
};

/**
 * Folders a Bethesda game reads from Data, and so never a wrapper Vortex
 * strips: Vortex's own gamebryo stop folders, the script extenders, and the
 * Data folders their list leaves out.
 */
const DATA_FOLDERS = new Set([
  "distantlod", "textures", "meshes", "music", "shaders", "video", "interface", "fonts", "scripts",
  "facegen", "menus", "lodsettings", "lsdata", "sound", "strings", "trees", "materials", "vis",
  "grass", "seq", "shadersfx", "programs", "mcm", "f4se", "skse", "fose", "nvse", "obse",
]);

/** `archive` ends with `staged`, and what is dropped from its front holds no Data folder. */
export function tailMatches(archive: string, staged: string): boolean {
  if (archive === staged) return true;
  if (!archive.endsWith(`/${staged}`)) return false;
  const dropped = archive.slice(0, archive.length - staged.length - 1).split("/");
  return !dropped.some((segment) => DATA_FOLDERS.has(segment));
}

export function findArchiveRestoreConflicts(input: {
  mods: readonly RestoreConflictMod[];
  restoresByKey: ReadonlyMap<string, readonly ArchiveRestore[]>;
  rules: readonly EhcollRule[];
  /** The curator's deployment winners (manifest.deployment.winners). */
  winners?: readonly EhcollDeploymentWinner[];
}): RestoreConflict[] {
  type Staged = { key: string; path: string; size?: number };
  // Per mod type: lowercase path → the enabled mods that stage it.
  const byPath = new Map<string, Map<string, Staged[]>>();
  const byBase = new Map<string, Map<string, string[]>>();
  for (const m of input.mods) {
    if (m.enabled === false) continue;
    const type = m.modType ?? "";
    const paths = byPath.get(type) ?? new Map<string, Staged[]>();
    byPath.set(type, paths);
    const bases = byBase.get(type) ?? new Map<string, string[]>();
    byBase.set(type, bases);
    for (const f of m.files) {
      const p = normPath(f.path);
      const list = paths.get(p);
      const s: Staged = { key: m.compareKey, path: f.path, ...(f.size !== undefined ? { size: f.size } : {}) };
      if (list === undefined) {
        paths.set(p, [s]);
        const base = p.slice(p.lastIndexOf("/") + 1);
        bases.set(base, [...(bases.get(base) ?? []), p]);
      } else list.push(s);
    }
  }
  const recorded = new Map<string, string>();
  for (const w of input.winners ?? []) for (const p of w.paths) recorded.set(`${w.modType}\u0000${p}`, w.mod);
  const keys = new Set(input.mods.map((m) => m.compareKey));
  const after = (a: string, b: string) => deploysAfter(a, b, input.rules, keys);

  const groups = new Map<string, RestoreConflict>();
  for (const m of input.mods) {
    if (m.enabled === false || !m.installsFromArchive) continue;
    const restores = input.restoresByKey.get(m.compareKey);
    if (restores === undefined || restores.length === 0) continue;
    const type = m.modType ?? "";
    const paths = byPath.get(type);
    if (paths === undefined) continue;
    for (const r of restores) {
      const p = normPath(r.path);
      const targets = r.exact
        ? paths.has(p) ? [p] : []
        : (byBase.get(type)?.get(p.slice(p.lastIndexOf("/") + 1)) ?? []).filter((q) => tailMatches(p, q));
      for (const target of targets) {
        const stagers = (paths.get(target) ?? []).filter((s) => s.key !== m.compareKey);
        if (stagers.length === 0) continue;
        // The copy the curator's game uses: recorded, or the only one there is.
        const live = recorded.get(`${type}\u0000${target}`);
        const keeper = live !== undefined ? stagers.find((s) => s.key === live) : stagers.length === 1 ? stagers[0] : undefined;
        if (keeper === undefined) {
          // Unrecorded and contested: harmless when any copy there beats the restorer.
          if (stagers.some((s) => after(s.key, m.compareKey))) continue;
        }
        const k = keeper ?? stagers[0]!;
        // Same size: the same file, as far as the build can tell — nothing changes for the player.
        if (r.size === undefined || k.size === undefined || r.size === k.size) continue;
        if (after(k.key, m.compareKey)) continue;
        const id = `${m.compareKey}\u0000${k.key}\u0000${r.maybe === true ? "maybe" : ""}`;
        const g = groups.get(id) ?? {
          restorer: m.compareKey,
          keeper: k.key,
          paths: [],
          restorerWins: after(m.compareKey, k.key),
          maybe: r.maybe === true,
        };
        if (!g.paths.includes(k.path)) g.paths.push(k.path);
        groups.set(id, g);
      }
    }
  }
  return [...groups.values()].sort(
    (a, b) => Number(a.maybe) - Number(b.maybe) || b.paths.length - a.paths.length || (a.restorer < b.restorer ? -1 : 1),
  );
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
    const files = `${n} file${n === 1 ? "" : "s"}`;
    const eg = `e.g. ${c.paths.slice(0, 2).join(", ")}`;
    if (c.maybe) {
      return (
        `"${restorer}" may put back ${files} its folder here does not have (its installer's answers could not be replayed); ` +
        `if it does, it can replace "${keeper}"'s copy on a player's game, ${eg}. ` +
        `To be sure, add a rule: "${keeper}" loads after "${restorer}".`
      );
    }
    return (
      `"${restorer}" puts back ${files} its folder here does not have, which ` +
      (c.restorerWins
        ? `the collection's rules let replace "${keeper}"'s copy`
        : `can replace "${keeper}"'s copy (no rule orders the two)`) +
      ` on a player's game, ${eg}. ` +
      (c.restorerWins
        ? `Change the rule so "${keeper}" loads after "${restorer}", or mirror "${restorer}" so its deletions ship.`
        : `Add a rule: "${keeper}" loads after "${restorer}" — or mirror "${restorer}" so its deletions ship.`)
    );
  });
  if (conflicts.length > max) lines.push(`…and ${conflicts.length - max} more pairs of mods like these.`);
  return lines;
}
