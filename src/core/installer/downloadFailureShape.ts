/**
 * ──────────────────────────────────────────────────────────────────────
 * Two failures wearing the same error message.
 *
 * `api.ext.nexusDownload` reports both of these as "returned no archiveId",
 * and nothing in the response separates them. Their TIMING does, and it
 * separates them cleanly — measured across three runs of a 967-mod collection
 * on a tester's machine:
 *
 *   FILE IS GONE      ~600ms per attempt   modId 98669 and 82232, failing
 *                                          identically in every run since the
 *                                          first. Retrying is pointless.
 *
 *   NEXUS TIMED OUT   ~20s per attempt     eight consecutive mods, uniformly
 *                                          20s × 3 attempts = 71s each, after
 *                                          113 downloads had succeeded in the
 *                                          same run. Cheat Terminal and RobCo
 *                                          Patcher were among them — two of the
 *                                          most-downloaded, actively-maintained
 *                                          mods for this game. They had not
 *                                          been deleted.
 *
 * A healthy download in that run took ~6.5s, so the three populations do not
 * overlap and the thresholds below are not finely balanced.
 *
 * ─── WHY IT IS WORTH TELLING THEM APART ────────────────────────────────
 * The two need opposite handling, and getting it wrong is expensive both ways:
 *
 *   - A 3-second backoff cannot clear a rate limit. Retrying a timeout three
 *     times in 71 seconds is three ways of asking the same question too
 *     quickly, and it reports a permanent failure for a transient one.
 *   - A long backoff on a genuinely dead file wastes minutes per mod proving
 *     something the first 600ms already proved.
 *
 * And the message the user reads has to differ. "Something is wrong for every
 * mod — your extractor, your connection, or your disk" sends someone
 * diagnosing a machine that is working fine, when the honest answer is "Nexus
 * stopped answering; wait a few minutes and run it again".
 * ──────────────────────────────────────────────────────────────────────
 */

export type DownloadFailureShape =
  /** Answered fast and empty — the file is not there. */
  | "gone"
  /** Hung, then gave up. A timeout, a throttle, or a dropped connection. */
  | "timed-out"
  /** Neither shape. Say nothing rather than guess. */
  | "unclear";

/** Above this, one ATTEMPT was hanging rather than answering. */
export const ATTEMPT_TIMEOUT_MS = 15_000;
/** Below this, the attempt answered promptly — it just answered "no". */
export const ATTEMPT_FAST_MS = 5_000;

/** Classify one download ATTEMPT by how long it took to fail. */
export function classifyAttempt(attemptMs: number): DownloadFailureShape {
  if (attemptMs >= ATTEMPT_TIMEOUT_MS) return "timed-out";
  if (attemptMs <= ATTEMPT_FAST_MS) return "gone";
  return "unclear";
}

/**
 * Above this, a whole MOD (every attempt plus the waits between) was hanging.
 *
 * A dead file costs ~12s all-in with the short backoffs; a timing-out one cost
 * 71s with them and more now that the backoff adapts. Nothing observed lands
 * between.
 */
export const MOD_TIMEOUT_MS = 30_000;

/** Classify a whole failed mod by its total elapsed time. */
export function classifyModFailure(totalMs: number): DownloadFailureShape {
  return totalMs >= MOD_TIMEOUT_MS ? "timed-out" : "unclear";
}

/**
 * How long to wait before the next attempt.
 *
 * `attempt` is the one that just failed, 1-based. The short ladder is the
 * original: it exists so a dead file costs about ten seconds to confirm rather
 * than a minute. The long ladder is for the hanging shape, where the point is
 * to actually give whatever is throttling us time to stop.
 */
export function backoffMs(
  attempt: number,
  shape: DownloadFailureShape,
): number {
  const ladder =
    shape === "timed-out" ? [20_000, 60_000] : [3_000, 8_000];
  return ladder[attempt - 1] ?? ladder[ladder.length - 1] ?? 5_000;
}

/**
 * The sentence the user reads when a run stops on a streak.
 *
 * Split out because the wrong one costs them an evening: the generic version
 * names their extractor, their connection and their disk, and a tester who
 * reads that goes looking for a broken machine. When every failure in the
 * streak hung, we know more than that and should say it.
 */
export function describeSystemicFailure(opts: {
  streak: number;
  lastModName: string;
  lastError: string;
  remaining: number;
  shape: DownloadFailureShape;
  /**
   * The Nexus account can't download directly: a free account (Vortex says
   * so, or raised "Only available to premium users" while it ran) or no
   * sign-in at all. Then that IS the cause, and naming the extractor or the
   * disk sends someone hunting a problem their machine does not have
   * (a free-account player, 2026-09-30).
   */
  account?: "free" | "logged-out";
}): string {
  const head =
    `${opts.streak} mods in a row failed to install, ending with ` +
    `"${opts.lastModName}": ${opts.lastError}.`;
  const tail = `Stopped rather than repeating it ${opts.remaining} more times.`;

  if (opts.account === "free") {
    return (
      `${opts.streak} mods in a row could not be downloaded, ending with "${opts.lastModName}". ` +
      `Your Nexus Mods account is not Premium, and Nexus only lets mod managers download files ` +
      `directly for Premium accounts: that is what Vortex's "Only available to premium users" ` +
      `notifications mean. It is not your extractor, connection or disk, and trying again will ` +
      `not change it. With Nexus Premium (one month is enough), press Continue on the ` +
      `collection: everything already installed is kept. ${tail}`
    );
  }
  if (opts.account === "logged-out") {
    return (
      `${opts.streak} mods in a row could not be downloaded, ending with "${opts.lastModName}". ` +
      `Vortex is not signed in to Nexus Mods, so it cannot download anything. Sign in on ` +
      `Vortex's Nexus Mods page, then press Continue on the collection. ${tail}`
    );
  }

  if (opts.shape === "timed-out") {
    return (
      `${head} Each one hung for about twenty seconds before giving up, ` +
      `which is what a Nexus rate limit or a dropped connection looks like — ` +
      `not a problem with these mods, your extractor or your disk. Mods that ` +
      `are genuinely missing fail in under a second. Wait a few minutes and ` +
      `run the install again: everything already installed is skipped, so it ` +
      `picks up near where it stopped. ${tail}`
    );
  }
  return (
    `${head} That is not one bad mod — something is wrong for every mod ` +
    `(Vortex's extractor, the Nexus connection, or disk space). ${tail}`
  );
}
