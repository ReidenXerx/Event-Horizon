/**
 * ──────────────────────────────────────────────────────────────────────
 * "An install was running when Vortex died."
 *
 * A receipt is written only when an install COMPLETES, and deliberately so:
 * a receipt asserts the collection IS installed, and a run that stopped
 * half-way has not earned that claim. But the consequence is that a crash or
 * a force-quit leaves NOTHING on disk, and the next launch cannot tell an
 * interrupted install from one that never started.
 *
 * A tester hit exactly that: the install stalled, he killed Vortex, reopened
 * it, and Event Horizon had no idea anything had been in flight. The recovery
 * itself works — re-running re-matches what is already installed by Nexus id
 * and hash, and it correctly found the mods from the previous run — but he had
 * no way to know that was what would happen, or that the half-populated
 * profile in his list came from us.
 *
 * So this records the fact of a run, and nothing more:
 *
 *   - It is NOT a receipt and never becomes one. It claims a run STARTED, not
 *     that anything is installed. Nothing reads it to decide what to install;
 *     that stays with the resolver's re-match, which is evidence-based.
 *   - It is written at the start and removed on EVERY exit — success, failure,
 *     and abort alike. A marker that outlives a run that ended cleanly would
 *     warn about an interruption that never happened, which is worse than
 *     silence.
 *   - Its only job is to let the next launch say "this was interrupted, here
 *     is the profile it left behind, re-running picks up where it stopped."
 * ──────────────────────────────────────────────────────────────────────
 */

import * as fsp from "fs/promises";

import { ehLog } from "../logging/ehLog";
import * as path from "path";

export interface InstallMarker {
  /** Stable collection identity, matching the receipt's packageId. */
  packageId: string;
  /** Display name, so the warning can name the collection. */
  packageName: string;
  /** ISO timestamp of when the run began. */
  startedAt: string;
  /** The profile the run was installing into — usually one it created. */
  profileId: string;
  /** Vortex game id, for the message. */
  gameId: string;
  /** How many mods the plan had, so "interrupted" can be given a scale. */
  totalMods: number;
}

/** Markers live beside the receipts, in their own directory. */
export function getMarkerDir(appDataPath: string): string {
  return path.join(appDataPath, "event-horizon", "installs", "in-progress");
}

function markerPath(appDataPath: string, packageId: string): string {
  // packageId is a UUID from our own manifest, but it arrives from a file on
  // disk, so it is never interpolated into a path without being reduced to
  // characters that cannot traverse.
  const safe = packageId.replace(/[^A-Za-z0-9._-]/g, "_");
  return path.join(getMarkerDir(appDataPath), `${safe}.json`);
}

/**
 * Record that an install has started.
 *
 * Never throws. A marker is a convenience for the NEXT launch; failing an
 * install because we could not write one would trade a real outcome for a
 * diagnostic.
 */
export async function writeInstallMarker(
  appDataPath: string,
  marker: InstallMarker,
): Promise<void> {
  try {
    await fsp.mkdir(getMarkerDir(appDataPath), { recursive: true });
    // Write-then-rename: a crash mid-write must not leave a truncated file
    // that the next launch fails to parse — the one moment this is read is
    // after a crash, so that is not a hypothetical.
    const target = markerPath(appDataPath, marker.packageId);
    const tmp = `${target}.tmp`;
    await fsp.writeFile(tmp, JSON.stringify(marker, null, 2), "utf8");
    await fsp.rename(tmp, target);
  } catch (err) {
    // Still never thrown; just no longer invisible. Without a marker, an
    // install killed mid-run leaves nothing behind at all, and the next launch
    // reports a clean slate for a machine that is halfway through a collection.
    ehLog("error", "marker.write.failed", {
      packageId: marker.packageId,
      consequence:
        "an interruption of this run will not be detected on the next launch",
      err,
    });
  }
}

/**
 * Remove the marker for a finished run.
 *
 * Never throws, and a missing file is success: this runs in a `finally`, and
 * an exception here would replace the run's real error with a cleanup one.
 */
export async function clearInstallMarker(
  appDataPath: string,
  packageId: string,
): Promise<void> {
  try {
    await fsp.rm(markerPath(appDataPath, packageId), { force: true });
  } catch {
    // Deliberately silent.
  }
}

/**
 * Every install that started and never finished.
 *
 * Unparseable files are skipped rather than thrown on — this is read at
 * startup, and one bad file must not hide the others or block the page.
 */
export async function listInterruptedInstalls(
  appDataPath: string,
): Promise<InstallMarker[]> {
  let names: string[];
  try {
    names = await fsp.readdir(getMarkerDir(appDataPath));
  } catch {
    return []; // no directory = nothing was ever interrupted
  }

  const out: InstallMarker[] = [];
  let unreadable = 0;
  for (const name of names) {
    if (!name.endsWith(".json")) continue; // skip .tmp leftovers
    try {
      const raw = await fsp.readFile(
        path.join(getMarkerDir(appDataPath), name),
        "utf8",
      );
      const parsed = parseMarker(JSON.parse(raw) as unknown);
      if (parsed !== undefined) {
        out.push(parsed);
      } else {
        // Present but not a marker we can read: the shape check rejected it.
        // Distinct from a parse throw, and the two have different causes.
        unreadable += 1;
      }
    } catch {
      // Skip; a corrupt marker is not worth a failure at startup.
      unreadable += 1;
    }
  }
  if (unreadable > 0) {
    ehLog("warn", "marker.list.unreadable", {
      unreadable,
      usable: out.length,
      consequence: "those interrupted installs will not be reported",
    });
  }
  return out.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

/**
 * Validate a marker read from disk.
 *
 * Whitelisted rather than cast: this file is not authored by us at read time —
 * it was written by a possibly-older build, and a half-written or hand-edited
 * one must not reach the UI as a plausible-looking object.
 */
function parseMarker(raw: unknown): InstallMarker | undefined {
  if (raw === null || typeof raw !== "object") return undefined;
  const o = raw as Record<string, unknown>;
  const str = (v: unknown): string | undefined =>
    typeof v === "string" && v.length > 0 ? v : undefined;

  const packageId = str(o.packageId);
  const packageName = str(o.packageName);
  const startedAt = str(o.startedAt);
  const profileId = str(o.profileId);
  const gameId = str(o.gameId);
  if (
    packageId === undefined ||
    packageName === undefined ||
    startedAt === undefined ||
    profileId === undefined ||
    gameId === undefined
  ) {
    return undefined;
  }
  return {
    packageId,
    packageName,
    startedAt,
    profileId,
    gameId,
    totalMods: typeof o.totalMods === "number" ? o.totalMods : 0,
  };
}

/**
 * What to tell the user, in their terms.
 *
 * Says what happened, what it means, and what to do — because "an install was
 * interrupted" on its own invites the reasonable and wrong conclusion that
 * something must be cleaned up by hand first.
 */
export function describeInterruptedInstall(marker: InstallMarker): string {
  const when = formatWhen(marker.startedAt);
  return (
    `Installing "${marker.packageName}" was interrupted${when} — Vortex ` +
    `closed before it finished. Nothing is broken: run the install again and ` +
    `it will detect what already made it onto your machine and carry on from ` +
    `there, rather than starting over.`
  );
}

function formatWhen(startedAt: string): string {
  const t = Date.parse(startedAt);
  if (Number.isNaN(t)) return "";
  const mins = Math.round((Date.now() - t) / 60000);
  if (mins < 1) return " just now";
  if (mins < 60) return ` ${mins} minute${mins === 1 ? "" : "s"} ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return ` ${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.round(hours / 24);
  return ` ${days} day${days === 1 ? "" : "s"} ago`;
}
