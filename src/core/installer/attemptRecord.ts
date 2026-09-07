/**
 * ──────────────────────────────────────────────────────────────────────
 * "The last attempt did not work, and here is how far it got."
 *
 * Three ways an install can end, and until now only one of them left a trace:
 *
 *   succeeded    → a RECEIPT. Asserts the collection IS installed.
 *   crashed      → an install MARKER survives, because nothing cleared it.
 *   failed/abort → nothing at all.
 *
 * The third is the common one and it was invisible. Seven of the driver's
 * eight failure returns happen before the receipt is written — correctly, a
 * half-finished run has not earned the claim that the collection is installed
 * — and the marker is cleared in the `finally`, correctly, because the process
 * did not die. So a tester whose install stopped at the deploy step with 963
 * mods staged had a machine full of mods, an empty "My Collections", and no
 * way to find out what had happened.
 *
 * ─── WHAT THIS IS, AND WHAT IT REFUSES TO BE ───────────────────────────
 * It records that an ATTEMPT ended badly, where it stopped, and how far it
 * got. It is not a receipt and never becomes one:
 *
 *   - Nothing reads it to decide WHAT to install. That stays with the
 *     resolver's re-match, which is evidence from disk rather than a dead
 *     run's opinion.
 *   - `profileId` alone decides WHERE a resume lands, and only that: without
 *     it every restart created another Vortex profile, because an
 *     interrupted run leaves no receipt and so takes fresh-profile mode
 *     again. One tester restarted five times and got five profiles — and
 *     since enablement is per-profile, the mods from the earlier four read
 *     "Disabled" in the newest one. `resumableProfileFromAttempts` checks
 *     the profile still exists before trusting it, and the mode stays
 *     fresh-profile: a failed attempt is still not a previous install.
 *   - A later SUCCESS deletes it. A warning about a failure that has since
 *     been fixed is worse than silence, because it teaches people to ignore
 *     the panel.
 *   - Writing it can never fail an install. The install has already ended by
 *     the time this runs, and losing the record of a failure is a far smaller
 *     harm than turning a partial install into a crash.
 * ──────────────────────────────────────────────────────────────────────
 */

import * as fsp from "fs/promises";
import * as path from "path";

export interface InstallAttempt {
  /** Stable collection identity, matching the receipt's packageId. */
  packageId: string;
  packageName: string;
  packageVersion: string;
  gameId: string;
  /** ISO-8601 UTC of when the attempt ended. */
  endedAt: string;
  /** How it ended. `aborted` is the user's own doing; `failed` is not. */
  outcome: "failed" | "aborted";
  /** Driver phase it stopped in, e.g. "installing-mods". */
  phase: string;
  /** Mods that made it onto disk before it stopped. */
  installedCount: number;
  /** What the plan set out to install. */
  totalMods: number;
  /** The reason, as the user was shown it. */
  error?: string;
  /** The profile it was installing into, which may still exist. */
  profileId?: string;
}

/** Attempts live beside the receipts, in their own directory. */
export function getAttemptDir(appDataPath: string): string {
  return path.join(appDataPath, "event-horizon", "install-ledger", "attempts");
}

function attemptPath(appDataPath: string, packageId: string): string {
  // Same identity as the receipt, so one collection has at most one of each.
  return path.join(getAttemptDir(appDataPath), `${packageId}.json`);
}

/**
 * Record a failed or aborted attempt. Never throws.
 *
 * The install is already over when this runs; a write error here must not
 * become the user's problem on top of the failure they already have.
 */
export async function writeInstallAttempt(
  appDataPath: string,
  attempt: InstallAttempt,
): Promise<void> {
  try {
    const dir = getAttemptDir(appDataPath);
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(
      attemptPath(appDataPath, attempt.packageId),
      JSON.stringify(attempt, null, 2),
      "utf8",
    );
  } catch {
    // Deliberately silent. See the header.
  }
}

/**
 * Forget the last failed attempt for a collection. Never throws.
 *
 * Called after a SUCCESSFUL install, so the panel stops warning about a
 * problem the user has just fixed.
 */
export async function clearInstallAttempt(
  appDataPath: string,
  packageId: string,
): Promise<void> {
  try {
    await fsp.unlink(attemptPath(appDataPath, packageId));
  } catch {
    // Absent is the normal case — most installs never failed.
  }
}

/** Every recorded failed attempt, newest first. Never throws. */
export async function listInstallAttempts(
  appDataPath: string,
): Promise<InstallAttempt[]> {
  let names: string[];
  try {
    names = await fsp.readdir(getAttemptDir(appDataPath));
  } catch {
    return [];
  }

  const out: InstallAttempt[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    try {
      const raw = await fsp.readFile(
        path.join(getAttemptDir(appDataPath), name),
        "utf8",
      );
      const parsed = JSON.parse(raw) as Partial<InstallAttempt>;
      // A record missing its identity cannot be shown or matched to a
      // collection, and half-rendering one is worse than skipping it.
      if (
        typeof parsed.packageId !== "string" ||
        typeof parsed.packageName !== "string" ||
        typeof parsed.endedAt !== "string"
      ) {
        continue;
      }
      out.push({
        packageId: parsed.packageId,
        packageName: parsed.packageName,
        packageVersion:
          typeof parsed.packageVersion === "string" ? parsed.packageVersion : "",
        gameId: typeof parsed.gameId === "string" ? parsed.gameId : "",
        endedAt: parsed.endedAt,
        outcome: parsed.outcome === "aborted" ? "aborted" : "failed",
        phase: typeof parsed.phase === "string" ? parsed.phase : "unknown",
        installedCount:
          typeof parsed.installedCount === "number" ? parsed.installedCount : 0,
        totalMods: typeof parsed.totalMods === "number" ? parsed.totalMods : 0,
        ...(typeof parsed.error === "string" ? { error: parsed.error } : {}),
        ...(typeof parsed.profileId === "string"
          ? { profileId: parsed.profileId }
          : {}),
      });
    } catch {
      // One unreadable record must not hide the others.
    }
  }
  return out.sort((a, b) => (a.endedAt < b.endedAt ? 1 : -1));
}

/**
 * What the user reads about a failed attempt.
 *
 * Leads with how far it got, because that is the part that decides what they
 * do next — 963 of 967 installed is a very different situation from 4, and
 * both were previously shown as nothing at all.
 */
export function describeInstallAttempt(attempt: InstallAttempt): string {
  const progress =
    attempt.totalMods > 0
      ? `${attempt.installedCount} of ${attempt.totalMods} mods were installed before it stopped`
      : `it stopped before installing anything`;

  if (attempt.outcome === "aborted") {
    return (
      `You stopped this install during "${attempt.phase}" — ${progress}. ` +
      `Nothing is broken: running it again picks up from what is already on ` +
      `your machine rather than starting over.`
    );
  }

  return (
    `The last install of "${attempt.packageName}" failed during ` +
    `"${attempt.phase}" — ${progress}. Those mods are still on your machine, ` +
    `so running the install again continues from there rather than starting ` +
    `over.`
  );
}
