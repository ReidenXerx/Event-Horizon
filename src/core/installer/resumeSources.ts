/**
 * Every record that can tell a resume which profile a stopped run was filling.
 *
 * ─── WHY TWO ─────────────────────────────────────────────────────────────────
 * The driver keeps two records of a run in flight, and they are disjoint by
 * construction — which meant the resume could see only one of them:
 *
 *   - an ATTEMPT is written when a run ENDS badly (`recordAttemptOutcome`),
 *   - a MARKER is written when a run STARTS, and cleared in the `finally`.
 *
 * `resumableProfileFromAttempts` read attempts alone. So a run that ended —
 * failed, aborted, threw — resumed correctly, and a run that was KILLED did
 * not: Vortex force-quit, power lost, the process gone. No `finally` runs, so
 * no attempt is written; the marker survives with the profile id in it, and
 * nothing read it. The next launch found no attempt, logged
 * `whyNotResumed: "no-attempt"`, and forked a new profile.
 *
 * That is the case the marker was WRITTEN for. Its own docblock says so: "let
 * the next launch say 'this was interrupted, here is the profile it left
 * behind'". Nothing implemented the second half.
 *
 * ─── ORDER MATTERS ───────────────────────────────────────────────────────────
 * Attempts first. `resumableProfileFromAttempts` takes the FIRST record
 * matching the package, and an attempt is the more specific claim: it knows
 * how the run ended and in which phase. A marker only knows it started. When
 * both exist — a cleared marker is the normal case, so this means the clear
 * failed — the attempt is the one to believe.
 */

import type { InstallAttempt } from "./attemptRecord";
import type { InstallMarker } from "./installMarker";

/** The shape `resumableProfileFromAttempts` actually needs. */
export type ResumeCandidate = {
  packageId: string;
  packageVersion?: string;
  profileId?: string;
};

/**
 * Attempts and markers as one list, attempts first.
 *
 * Markers whose `packageVersion` is absent are still included: the resume
 * guard treats an unknown version as "do not refuse on version grounds",
 * which is the same reading it already applies to a legacy attempt, and
 * refusing a real half-finished install because an older build did not record
 * a field is the failure this whole path exists to stop.
 */
export function resumeCandidates(
  attempts: readonly InstallAttempt[],
  markers: readonly InstallMarker[],
): ResumeCandidate[] {
  return [
    ...attempts.map((a) => ({
      packageId: a.packageId,
      ...(a.packageVersion !== undefined
        ? { packageVersion: a.packageVersion }
        : {}),
      ...(a.profileId !== undefined ? { profileId: a.profileId } : {}),
    })),
    ...markers.map((m) => ({
      packageId: m.packageId,
      ...(m.packageVersion !== undefined
        ? { packageVersion: m.packageVersion }
        : {}),
      profileId: m.profileId,
    })),
  ];
}
