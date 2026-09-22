/**
 * What modding actually uses on this disk.
 *
 * ─── WHY THIS IS A BUTTON AND NOT A NUMBER ON OPEN ──────────────────────
 * The only honest way to answer is to stat every file. A real Skyrim
 * collection stages 356,678 of them, and the same machine's downloads folder
 * and old profiles add more. That is seconds at best and minutes on a slow
 * disk, every single time the home page opens — for a figure nobody asked
 * for. So the card starts empty, says it has not measured, and measures when
 * the player presses the button.
 *
 * Partial answers are reported as partial: a folder that cannot be read
 * contributes nothing and is named, rather than being silently counted as
 * zero and shrinking the total.
 */
import * as fsp from "fs/promises";
import * as path from "path";
import type { types } from "@nexusmods/vortex-api";

import { ehLog } from "../../../core/logging/ehLog";

export interface FootprintPart {
  label: string;
  gigabytes: number;
}

export interface Footprint {
  parts: FootprintPart[];
  /** Folders that could not be read. Their bytes are in nobody's total. */
  unreadable: string[];
}

/**
 * Recursive size, in bytes, AND the directories that could not be read.
 *
 * A swallowed `readdir` failure — a permission-denied staging root, a locked
 * subfolder, a path too long — returned a number that looked like a
 * measurement and was silently short. The caller needs to know, because the
 * card's own contract is that a partial answer is reported as partial.
 */
async function folderSize(root: string): Promise<{ bytes: number; failed: string[] }> {
  let total = 0;
  const failed: string[] = [];
  const stack: string[] = [root];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries: import("fs").Dirent[];
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      failed.push(dir);
      continue;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.isFile()) {
        try {
          // A hardlinked file is counted once per path here, which OVERSTATES
          // deployment: Event Horizon deploys by hardlink, so the game folder
          // and the staging folder share bytes. Only staging is measured for
          // that reason — see the caller.
          total += (await fsp.stat(full)).size;
        } catch {
          /* vanished between readdir and stat: not this measurement's problem */
        }
      }
    }
  }
  return { bytes: total, failed };
}

const GB = 1024 ** 3;

/**
 * Measure the folders modding owns on this machine, for the active game.
 *
 * Deliberately NOT the game folder: under hardlink deployment its modded
 * files are the same bytes as the staging folder's, and adding both would
 * report roughly double what the disk is actually holding.
 */
export async function measureModdingFootprint(api: types.IExtensionApi): Promise<Footprint> {
  const [{ getActiveGameId }, { getCollectionsDir }, { getEventHorizonRoot }] = await Promise.all([
    import("../../../core/getModsListForProfile"),
    import("../../../core/paths"),
    import("../../../core/paths/appDataPaths"),
  ]);
  const state = api.getState();
  const gameId = getActiveGameId(state);

  const targets: { label: string; dir: string | undefined; exclude?: string[] }[] = [];

  // Staging: where the mods themselves live.
  if (gameId !== undefined) {
    try {
      const { installRootFor } = await import("../../../core/stagingPath");
      targets.push({ label: "Staged mods", dir: installRootFor(state, gameId) });
    } catch (err) {
      ehLog("debug", "dashboard.disk.no-staging-path", { err });
    }
  }

  // Downloads: the archives Vortex keeps after installing.
  const downloads = (state as unknown as {
    settings?: { downloads?: { path?: string } };
  }).settings?.downloads?.path;
  targets.push({ label: "Downloads", dir: typeof downloads === "string" ? downloads : undefined });

  // Event Horizon's own: built packages, and the copies kept for healing.
  targets.push({ label: "Collection packages", dir: getCollectionsDir() });
  /*
   * Event Horizon's OWN folder, minus the packages already counted above.
   * This used to name `install-ledger`, which holds attempts and journals —
   * kilobytes — while the receipts live in `installs` and the cached
   * collection artwork in `presentation`. The row therefore measured the one
   * subfolder that is never big, reported a rounding zero, and was dropped
   * from the chart entirely. Through the paths helper, not a hand-joined
   * string: hand-joining is how the wrong segment got in.
   */
  targets.push({ label: "Event Horizon data", dir: getEventHorizonRoot(), exclude: [getCollectionsDir()] });

  const parts: FootprintPart[] = [];
  const unreadable: string[] = [];
  for (const t of targets) {
    if (t.dir === undefined) {
      unreadable.push(t.label);
      continue;
    }
    try {
      await fsp.access(t.dir);
    } catch {
      // Not there at all is not "unreadable" — a machine with no downloads
      // folder has no download bytes, and 0 is the true answer.
      parts.push({ label: t.label, gigabytes: 0 });
      continue;
    }
    const measured = await folderSize(t.dir);
    let bytes = measured.bytes;
    for (const skip of t.exclude ?? []) {
      // Counted under its own label already; counting it twice would make
      // the total describe a machine that does not exist.
      const inner = await folderSize(skip).catch(() => ({ bytes: 0, failed: [] }));
      bytes -= inner.bytes;
    }
    if (measured.failed.length > 0) unreadable.push(t.label);
    parts.push({ label: t.label, gigabytes: Math.max(Math.round((bytes / GB) * 10) / 10, 0) });
  }

  ehLog("info", "dashboard.disk.measured", {
    parts: parts.map((p) => `${p.label}:${p.gigabytes}GB`).join(" "),
    unreadable,
  });
  // Rows that measured 0.0 GB are dropped from the CHART (a slice nobody can
  // see is noise), but a folder that could not be read is carried out in
  // `unreadable` so the card can say the total is a floor.
  return { parts: parts.filter((p) => p.gigabytes > 0), unreadable };
}
