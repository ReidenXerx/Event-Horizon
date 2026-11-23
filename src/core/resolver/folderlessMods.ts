/**
 * Mods Vortex still lists whose staging folder is gone.
 *
 * alasdairn, Meridia 1.0.55 (2026-11-22): after "Mod Staging Folder missing ->
 * Reinitialize", Vortex kept 1,674 Skyrim SE mods in its state with no folder
 * behind any of them. The install preview adopted 433 collection mods as
 * already installed (they would have been enabled with no files) and planned
 * to carry 949 own mods the same way.
 *
 * A mod with no files is not installed, whatever Vortex's state says, so the
 * resolver never sees it: it gets downloaded or installed like any missing mod.
 *
 * Only a folder that is POSITIVELY missing drops a mod. No staging root, no
 * folder name, or a folder we could not check (permissions, an offline drive
 * that answers with something other than "not found") keeps the mod, so a
 * failed check never turns a working setup into a reinstall.
 */

import * as fs from "fs";

import type { types } from "@nexusmods/vortex-api";

import { ehLog } from "../logging/ehLog";
import type { AuditorMod } from "../getModsListForProfile";
import { installRootFor, stagingRootFromFolder } from "../stagingPath";

/** True only when the path definitely does not exist. */
export function folderPositivelyMissing(p: string): boolean {
  try {
    fs.statSync(p);
    return false;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    return code === "ENOENT" || code === "ENOTDIR";
  }
}

export function splitFolderlessMods<M extends Pick<AuditorMod, "installationPath">>(
  mods: readonly M[],
  installRoot: string | undefined,
  missing: (p: string) => boolean = folderPositivelyMissing,
): { present: M[]; folderless: M[] } {
  const present: M[] = [];
  const folderless: M[] = [];
  for (const m of mods) {
    const folder = stagingRootFromFolder(installRoot, m.installationPath);
    if (folder !== undefined && missing(folder)) folderless.push(m);
    else present.push(m);
  }
  return { present, folderless };
}

/** The pool without its folderless mods, logged when any were dropped. */
export function withoutFolderlessMods<M extends Pick<AuditorMod, "installationPath" | "name">>(
  state: types.IState,
  gameId: string,
  mods: readonly M[],
  where: string,
): M[] {
  const { present, folderless } = splitFolderlessMods(mods, installRootFor(state, gameId));
  if (folderless.length > 0) {
    ehLog("warn", "install.pool.folderless", {
      where,
      gameId,
      count: folderless.length,
      of: mods.length,
      sample: folderless.slice(0, 10).map((m) => m.name),
      why: "Vortex lists these mods but their staging folders are gone; treated as not installed",
    });
  }
  return present;
}
