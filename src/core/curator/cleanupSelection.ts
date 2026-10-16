/**
 * ──────────────────────────────────────────────────────────────────────
 * Disk cleanup by exact ids, for the control channel.
 *
 * The Curator page ticks from `planCleanup`'s own lists. An agent working for
 * the owner names ids instead (owner, 2026-10-16: clean FO4 of old installs
 * and old archives), and under NS-2's scope that is the owner's act, like
 * clicking Remove: exact ids, all-or-nothing on anything unknown or unsafe.
 *
 * The one judgement kept here is the one `planCleanup` exists for: an archive
 * a mod still points at is never deleted. So a request is checked against
 * the setup AS IT WILL BE after the requested removals, and checked again,
 * on the real state, after they ran: a removal that failed leaves its archive
 * referenced, and that deletion is dropped rather than leaving Vortex pointing
 * at a missing file.
 * ──────────────────────────────────────────────────────────────────────
 */

import { orphanArchives, planCleanup, sameFileKey, type DownloadEntry } from "./cleanupPlan";
import type { CuratorMod } from "./profileActions";

/**
 * Where an archive stands.
 *
 * - `referenced`: a mod's `archiveId` points at it, or at another record
 *   naming the same file. Never deletable.
 * - `staleLinked`: an installed mod's own file, reached by Nexus ids because
 *   the mod's `archiveId` is dead. Never deletable.
 * - `superseded`: nothing points at it and a strictly newer version of the
 *   same file is installed.
 * - `samePageInstalled`: nothing points at it; something from its Nexus page
 *   is installed, but not a newer version of this file (a newer download,
 *   another file on the page). Review.
 * - `noInstall`: nothing from its Nexus page is installed.
 * - `noNexusId`: no Nexus mod id recorded; nothing to compare against.
 */
export type ArchiveBucket = "referenced" | "staleLinked" | "superseded" | "samePageInstalled" | "noInstall" | "noNexusId";

export type BucketedArchive = { entry: DownloadEntry; bucket: ArchiveBucket; heldBy?: string[] };

/** Every finished download of the game, sorted into buckets against these mods. */
export function bucketArchives(mods: readonly CuratorMod[], downloads: readonly DownloadEntry[]): BucketedArchive[] {
  const plan = planCleanup({ mods, downloads });
  const holders = new Map<string, string[]>();
  for (const m of mods) {
    if (m.archiveId === undefined || m.archiveId === "") continue;
    holders.set(m.archiveId, [...(holders.get(m.archiveId) ?? []), m.id]);
  }
  // A record that names the same file as a held one is held too: deleting it deletes that file.
  const fileHolders = new Map<string, string[]>();
  for (const d of downloads) {
    const held = holders.get(d.id);
    if (held === undefined) continue;
    const key = sameFileKey(d.fileName);
    fileHolders.set(key, [...(fileHolders.get(key) ?? []), ...held]);
  }
  const superseded = new Set(orphanArchives(plan).map((a) => a.entry.id));
  const stale = new Set(plan.staleLinked.map((s) => s.entry.id));
  const pages = new Set(mods.map((m) => m.nexusModId).filter((n): n is number => n !== undefined));
  return downloads.map((entry): BucketedArchive => {
    const heldBy = holders.get(entry.id) ?? fileHolders.get(sameFileKey(entry.fileName));
    if (heldBy !== undefined) return { entry, bucket: "referenced", heldBy };
    if (stale.has(entry.id)) return { entry, bucket: "staleLinked" };
    if (superseded.has(entry.id)) return { entry, bucket: "superseded" };
    if (entry.nexusModId === undefined) return { entry, bucket: "noNexusId" };
    return { entry, bucket: pages.has(entry.nexusModId) ? "samePageInstalled" : "noInstall" };
  });
}

export const DELETABLE: ReadonlySet<ArchiveBucket> = new Set(["superseded", "samePageInstalled", "noInstall", "noNexusId"]);

export type CleanupRequest = {
  problems: string[];
  removals: CuratorMod[];
  /** Each archive as it will stand once the removals have happened. */
  deletions: BucketedArchive[];
};

/**
 * Checks a request against the setup after its own removals. Any problem
 * refuses the whole request: nothing is removed or deleted.
 */
export function checkCleanupRequest(args: {
  mods: readonly CuratorMod[];
  downloads: readonly DownloadEntry[];
  removeModIds: readonly string[];
  deleteArchiveIds: readonly string[];
}): CleanupRequest {
  const problems: string[] = [];
  const byId = new Map(args.mods.map((m) => [m.id, m]));
  const unknownMods = args.removeModIds.filter((id) => !byId.has(id));
  if (unknownMods.length > 0) problems.push(`Not in this game's mods: ${unknownMods.join(", ")}.`);
  const removing = new Set(args.removeModIds);
  const after = bucketArchives(
    args.mods.filter((m) => !removing.has(m.id)),
    args.downloads,
  );
  const byDownload = new Map(after.map((a) => [a.entry.id, a]));
  const unknownArchives = args.deleteArchiveIds.filter((id) => !byDownload.has(id));
  if (unknownArchives.length > 0) {
    problems.push(`Not a finished download of this game: ${unknownArchives.join(", ")}.`);
  }
  const deletions: BucketedArchive[] = [];
  for (const id of new Set(args.deleteArchiveIds)) {
    const a = byDownload.get(id);
    if (a === undefined) continue;
    if (a.bucket === "referenced") {
      const names = (a.heldBy ?? []).map((m) => byId.get(m)?.name ?? m);
      problems.push(`${a.entry.fileName} (${id}) is still the archive of ${names.join(", ")}; remove that mod in the same request to free it.`);
    } else if (a.bucket === "staleLinked") {
      problems.push(`${a.entry.fileName} (${id}) is an installed mod's own file (its archive link is stale); it stays.`);
    } else {
      deletions.push(a);
    }
  }
  return {
    problems,
    removals: args.removeModIds.map((id) => byId.get(id)).filter((m): m is CuratorMod => m !== undefined),
    deletions,
  };
}
