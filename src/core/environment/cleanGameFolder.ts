/**
 * ──────────────────────────────────────────────────────────────────────
 * Turn the game folder into a clean game, right before an install.
 *
 * The curator's rule: purge Vortex's deployment FIRST, then look — because a
 * purge leaves its own junk behind, and anything Vortex had linked in would
 * otherwise hide what is underneath it. Then every file the game would load
 * that no record accounts for is moved aside (quarantine.ts), and the folder is
 * scanned a third time: the install only starts when that scan finds nothing.
 *
 * Asked once, with the list. Purging is reversible (Vortex redeploys at the end
 * of the install) and quarantine is reversible (Doctor restores it), but both
 * touch the user's machine, so neither happens without a yes.
 *
 * No store record → nothing is purged or moved, and the caller is told why:
 * without a vanilla list this cannot tell the game's own files from a mod's.
 * ──────────────────────────────────────────────────────────────────────
 */

import { ehLog } from "../logging/ehLog";
import { groupEntries, type FolderEntry, type GameFolderScan } from "./gameFolderScan";

export type CleanPreview = {
  gameName: string;
  deployedCount: number;
  unmanaged: readonly FolderEntry[];
  quarantineFolder: string;
};

export type CleanOutcome =
  | { kind: "already-clean" }
  | { kind: "unverifiable"; reason: string }
  | { kind: "declined" }
  | { kind: "cleaned"; purged: boolean; moved: number; recordPath?: string }
  | { kind: "failed"; message: string; remaining: FolderEntry[]; recordPath?: string };

export async function cleanGameFolder(deps: {
  gameId: string;
  gameName: string;
  quarantineFolder: string;
  scan: () => Promise<GameFolderScan>;
  purge: () => Promise<void>;
  confirm: (preview: CleanPreview) => Promise<boolean>;
  quarantine: (
    entries: FolderEntry[],
  ) => Promise<{ recordPath: string; moved: number; failed: ReadonlyArray<{ path: string; error?: string }> }>;
}): Promise<CleanOutcome> {
  const first = await deps.scan();
  if (first.report.vanilla.kind === "unknown") {
    ehLog("warn", "clean-folder.unverifiable", { gameId: deps.gameId, reason: first.report.vanilla.reason });
    return { kind: "unverifiable", reason: first.report.vanilla.reason };
  }
  if (first.deployedCount === 0 && first.report.unmanaged.length === 0) {
    ehLog("info", "clean-folder.already-clean", { gameId: deps.gameId });
    return { kind: "already-clean" };
  }

  const preview: CleanPreview = {
    gameName: deps.gameName,
    deployedCount: first.deployedCount,
    unmanaged: first.report.unmanaged,
    quarantineFolder: deps.quarantineFolder,
  };
  const agreed = await deps.confirm(preview);
  ehLog("info", "clean-folder.confirm", {
    gameId: deps.gameId,
    agreed,
    deployedCount: first.deployedCount,
    unmanaged: first.report.unmanaged.length,
  });
  if (!agreed) return { kind: "declined" };

  let purged = false;
  if (first.deployedCount > 0) {
    try {
      await deps.purge();
      purged = true;
      ehLog("info", "clean-folder.purged", { gameId: deps.gameId, deployedBefore: first.deployedCount });
    } catch (err) {
      const message = `Vortex could not purge ${deps.gameName}: ${err instanceof Error ? err.message : String(err)}`;
      ehLog("error", "clean-folder.purge-failed", { gameId: deps.gameId, error: message });
      return { kind: "failed", message, remaining: [] };
    }
  }

  const second = await deps.scan();
  if (second.deployedCount > 0) {
    const message = `Vortex still has ${second.deployedCount} files deployed into ${deps.gameName} after purging.`;
    ehLog("error", "clean-folder.purge-incomplete", { gameId: deps.gameId, deployed: second.deployedCount, manifests: second.manifests });
    return { kind: "failed", message, remaining: [] };
  }

  let recordPath: string | undefined;
  let moved = 0;
  if (second.report.unmanaged.length > 0) {
    const result = await deps.quarantine([...second.report.unmanaged]);
    recordPath = result.recordPath;
    moved = result.moved;
    if (result.failed.length > 0) {
      const message = `${result.failed.length} file(s) could not be moved out of the ${deps.gameName} folder (first: ${result.failed[0]!.path}${result.failed[0]!.error !== undefined ? ` — ${result.failed[0]!.error}` : ""}). Close the game and any tool using those files, then try again.`;
      return {
        kind: "failed",
        message,
        remaining: second.report.unmanaged.filter((e) => result.failed.some((f) => f.path === e.path)),
        recordPath,
      };
    }
  }

  // The claim "clean" is only made by a scan that found nothing.
  const third = await deps.scan();
  if (third.report.unmanaged.length > 0 || third.deployedCount > 0) {
    const message = `The ${deps.gameName} folder still is not clean after cleaning: ${third.report.unmanaged.length} unaccounted file(s), ${third.deployedCount} deployed.`;
    ehLog("error", "clean-folder.verify-failed", {
      gameId: deps.gameId,
      remaining: third.report.unmanaged.slice(0, 200).map((e) => e.path),
      deployed: third.deployedCount,
    });
    return { kind: "failed", message, remaining: third.report.unmanaged, ...(recordPath !== undefined ? { recordPath } : {}) };
  }
  ehLog("info", "clean-folder.verified-clean", { gameId: deps.gameId, purged, moved, recordPath });
  return { kind: "cleaned", purged, moved, ...(recordPath !== undefined ? { recordPath } : {}) };
}

export function describeCleanPlan(preview: CleanPreview): {
  title: string;
  text: string;
  message: string;
  confirm: string;
  decline: string;
} {
  const lines: string[] = [];
  if (preview.deployedCount > 0) {
    lines.push(
      `1. Purge Vortex's deployment for ${preview.gameName} (${preview.deployedCount} files). Your mods stay installed in Vortex; the collection deploys again when the install finishes.`,
      "",
    );
  }
  lines.push(
    `${preview.deployedCount > 0 ? "2" : "1"}. Move every file the game would load that is not part of ${preview.gameName}, Vortex or this collection into:`,
    `   ${preview.quarantineFolder}`,
    "   Nothing is deleted. Doctor → Moved-aside files puts every file back.",
    "",
  );
  if (preview.unmanaged.length > 0) {
    lines.push(`Found now (${preview.unmanaged.length} files):`);
    const groups = groupEntries(preview.unmanaged);
    for (const g of groups.slice(0, 200)) {
      lines.push(`   ${g.group} — ${g.files} file${g.files === 1 ? "" : "s"}`);
    }
    if (groups.length > 200) lines.push(`   … and ${groups.length - 200} more folders`);
  }
  if (preview.deployedCount > 0) {
    lines.push("", "Anything Vortex's purge leaves behind is moved aside too.");
  }
  return {
    title: `Make ${preview.gameName} a clean game first`,
    text:
      "This collection is installed onto a clean game, so nothing left over from earlier mod setups can collide with it. " +
      "Event Horizon will do the following before the install starts:",
    message: lines.join("\n"),
    confirm: "Clean and install",
    decline: "Cancel",
  };
}
