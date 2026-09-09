/**
 * ──────────────────────────────────────────────────────────────────────
 * Carry out a cleanup plan. The only code in this project that deletes files
 * the curator cannot get back.
 *
 * `planCleanup` decided; this does, in the order the plan requires: old mod
 * installs are removed through Vortex first, and only then are the archives
 * they were holding deleted.
 *
 * ─── A FAILED REMOVAL MUST CANCEL ITS OWN DELETION ─────────────────────
 * The plan says an archive is deletable BECAUSE a mod that references it is
 * going away. If that removal fails, the reference is still there and the
 * premise is gone — deleting it anyway would leave Vortex pointing at a file
 * that no longer exists, which is the "archive missing from disk" state this
 * project has a whole recovery subsystem for.
 *
 * So the executor tracks which removals actually succeeded and drops the
 * deletions that depended on the ones that did not. That is the single most
 * important line here, and it is the one the mutation tests aim at.
 *
 * ─── READING THE DOWNLOAD LIST ─────────────────────────────────────────
 * Vortex's own `IDownload.installed` field is NOT usable for this. Its
 * documentation says so outright: "this will not be unset if the mod is
 * uninstalled, so to determine if the archive is actually installed one has to
 * look at the dictionary of installed mods". The planner does exactly that,
 * through `mod.archiveId`, and this reader deliberately ignores `installed`.
 * ──────────────────────────────────────────────────────────────────────
 */

import type { types } from "@nexusmods/vortex-api";
import { ehLog } from "../logging/ehLog";

import type { ArchiveRemoval, CleanupPlan, DownloadEntry } from "./cleanupPlan";

/** Numbers Vortex may have stored as strings. */
function asNumber(raw: unknown): number | undefined {
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : undefined;
  if (typeof raw === "string" && raw.trim() !== "") {
    const n = Number(raw);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

/**
 * Every finished download for this game, in the planner's shape.
 *
 * Unfinished ones are skipped: a partial download is not disk the curator can
 * reclaim by this route, and deleting one mid-transfer would be a different
 * kind of surprise.
 */
export function readDownloads(
  state: types.IState,
  gameId: string,
): DownloadEntry[] {
  const files = (
    state as unknown as {
      persistent?: {
        downloads?: {
          files?: Record<
            string,
            {
              localPath?: string;
              game?: string[];
              size?: number;
              state?: string;
              modInfo?: Record<string, unknown>;
            }
          >;
        };
      };
    }
  )?.persistent?.downloads?.files;
  if (files === undefined) return [];

  const out: DownloadEntry[] = [];
  for (const [id, file] of Object.entries(files)) {
    if (file?.localPath === undefined || file.localPath === "") continue;
    if (file.state !== undefined && file.state !== "finished") continue;
    if (Array.isArray(file.game) && !file.game.includes(gameId)) continue;

    const nexus = (file.modInfo?.nexus ?? {}) as {
      ids?: Record<string, unknown>;
      fileInfo?: Record<string, unknown>;
    };
    const ids = nexus.ids ?? {};
    /**
     * `fileInfo.name` is the FILE's own name on Nexus — the same value Vortex
     * copies to a mod's `logicalFileName` when it installs this download.
     * Carrying it here is what lets an archive be compared against an install
     * by file rather than by mod page, so an addon nobody ever set up is not
     * read as an old version of its page's main file.
     */
    const logical = nexus.fileInfo?.name;
    const logicalFileName =
      typeof logical === "string" && logical.trim() !== ""
        ? logical.trim()
        : undefined;
    out.push({
      id,
      fileName: file.localPath,
      bytes: typeof file.size === "number" ? file.size : 0,
      ...(logicalFileName !== undefined ? { logicalFileName } : {}),
      ...(asNumber(ids.modId) !== undefined
        ? { nexusModId: asNumber(ids.modId)! }
        : {}),
      ...(asNumber(ids.fileId) !== undefined
        ? { nexusFileId: asNumber(ids.fileId)! }
        : {}),
    });
  }
  return out;
}

export type CleanupOutcome = {
  modsRemoved: string[];
  modsFailed: { name: string; why: string }[];
  archivesDeleted: string[];
  archivesFailed: { fileName: string; why: string }[];
  /** Deletions dropped because the removal they depended on failed. */
  archivesSkipped: { fileName: string; why: string }[];
  bytesFreed: number;
  cancelled: boolean;
};

/**
 * Execute the plan. Never throws for one item's problem.
 *
 * Both effects are injected: the caller supplies Vortex's own removal and a
 * file delete, which keeps the ordering rule testable without a disk.
 */
export async function runCleanup(input: {
  plan: CleanupPlan;
  removeMod: (vortexModId: string) => Promise<void>;
  deleteArchive: (entry: DownloadEntry) => Promise<void>;
  onProgress?: (done: number, total: number, what: string) => void;
  signal?: AbortSignal;
}): Promise<CleanupOutcome> {
  const { plan, removeMod, deleteArchive, onProgress, signal } = input;
  const out: CleanupOutcome = {
    modsRemoved: [],
    modsFailed: [],
    archivesDeleted: [],
    archivesFailed: [],
    archivesSkipped: [],
    bytesFreed: 0,
    cancelled: false,
  };

  const total = plan.removeMods.length + plan.deleteArchives.length;
  let done = 0;
  const startedAt = Date.now();
  // Deletion is the one thing here a curator cannot undo, so what went and
  // what survived is written down before anyone has to ask.
  ehLog("info", "cleanup.start", {
    removeMods: plan.removeMods.length,
    deleteArchives: plan.deleteArchives.length,
    bytesPlanned: plan.bytesFreed,
  });

  /** Mods whose removal failed — their archives are still referenced. */
  const stillHeld = new Set<string>();

  for (const removal of plan.removeMods) {
    if (signal?.aborted === true) {
      out.cancelled = true;
      return out;
    }
    onProgress?.(done, total, `Removing ${removal.mod.name}`);
    try {
      await removeMod(removal.mod.id);
      ehLog("info", "cleanup.mod-removed", {
        mod: removal.mod.name,
        modId: removal.mod.id,
        supersededBy: removal.supersededBy.name,
      });
      out.modsRemoved.push(removal.mod.name);
    } catch (err) {
      ehLog("warn", "cleanup.mod-remove-failed", {
        mod: removal.mod.name,
        err,
      });
      out.modsFailed.push({
        name: removal.mod.name,
        why: err instanceof Error ? err.message : String(err),
      });
      // Whatever it was holding must survive.
      if (removal.mod.archiveId !== undefined) stillHeld.add(removal.mod.archiveId);
    }
    done += 1;
  }

  for (const archive of plan.deleteArchives) {
    if (signal?.aborted === true) {
      out.cancelled = true;
      return out;
    }
    // The premise check. A `freed-by-removal` deletion is only valid if the
    // removal it was predicated on actually happened.
    if (dependsOnFailedRemoval(archive, stillHeld)) {
      out.archivesSkipped.push({
        fileName: archive.entry.fileName,
        why:
          "the old install that was holding it could not be removed, so " +
          "Vortex still points at this file",
      });
      done += 1;
      continue;
    }
    onProgress?.(done, total, `Deleting ${archive.entry.fileName}`);
    try {
      await deleteArchive(archive.entry);
      out.archivesDeleted.push(archive.entry.fileName);
      out.bytesFreed += archive.entry.bytes;
    } catch (err) {
      out.archivesFailed.push({
        fileName: archive.entry.fileName,
        why: err instanceof Error ? err.message : String(err),
      });
    }
    done += 1;
  }

  onProgress?.(done, total, "Done");
  return out;
}

function dependsOnFailedRemoval(
  archive: ArchiveRemoval,
  stillHeld: ReadonlySet<string>,
): boolean {
  return archive.reason === "freed-by-removal" && stillHeld.has(archive.entry.id);
}

/** What the curator is told afterwards. */
export function describeCleanupOutcome(outcome: CleanupOutcome): string[] {
  const lines: string[] = [];
  const gb = (b: number): string =>
    b >= 1024 ** 3
      ? `${(b / 1024 ** 3).toFixed(2)} GB`
      : `${Math.round(b / 1024 ** 2)} MB`;

  lines.push(
    `Removed ${outcome.modsRemoved.length} old install(s) and deleted ` +
      `${outcome.archivesDeleted.length} archive(s), freeing ${gb(outcome.bytesFreed)}.`,
  );
  if (outcome.modsFailed.length > 0) {
    lines.push(
      `${outcome.modsFailed.length} install(s) could not be removed: ` +
        outcome.modsFailed.slice(0, 3).map((f) => `"${f.name}" (${f.why})`).join("; "),
    );
  }
  if (outcome.archivesSkipped.length > 0) {
    lines.push(
      `${outcome.archivesSkipped.length} archive(s) were left alone because ` +
        `the install holding them did not go away. Nothing points at a ` +
        `missing file.`,
    );
  }
  if (outcome.archivesFailed.length > 0) {
    lines.push(
      `${outcome.archivesFailed.length} archive(s) could not be deleted ` +
        `(usually a file in use): ` +
        outcome.archivesFailed.slice(0, 3).map((f) => f.fileName).join(", "),
    );
  }
  if (outcome.cancelled) {
    lines.push("Stopped early — the rest was left alone.");
  }
  return lines;
}
