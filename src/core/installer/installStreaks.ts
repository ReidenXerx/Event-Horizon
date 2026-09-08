/**
 * "Is it this mod, or is it everything?" — the run's two streak counters.
 *
 * ─── WHAT THIS FILE USED TO BE ──────────────────────────────────────────────
 * `runAccumulator.ts`, and it was meant to be the first step of decomposing
 * `runInstallImpl`: take the twenty-odd mutable locals the driver declares in
 * its preamble and keeps in scope for two thousand lines, put them behind one
 * object, then extract the phases.
 *
 * The state moved and the driver did not. `RunAccumulator` grew eight report
 * collectors, a proven-state pair and the streaks; the driver kept its own
 * `failedMods`, `skippedMods`, `removedMods`, `carriedMods`, `verifications`,
 * `curatorReports`, `externalNotices`, `damagedArchives`, `verifiedOkKeys`,
 * `expectedFilesByCompareKey` and a local `noteVerifiedOk` — and those are the
 * ones the receipt and the result actually read. Measured: SEVEN production
 * call sites on the class, every one of them a streak member. The rest was
 * ~150 lines of shadow state, including two `noteVerifiedOk` implementations
 * and one docblock duplicated word-for-word in both files.
 *
 * That is worse than indirection with no benefit. It is a second, plausible,
 * well-documented home for state that production does not use, which is what
 * the next person edits by mistake. So the shadow is gone and what remains is
 * the part that earned its place.
 *
 * ─── WHY THE STREAKS ARE WORTH A MODULE AND THE COLLECTORS WERE NOT ─────────
 * The collectors are storage: an array you push onto. The streaks are the only
 * piece of that state with a RULE, and the rule is easy to get wrong because
 * it lives across three assignments in different phases. Writing it down is
 * what surfaced that `DownloadFailureShape` has a `"gone"` member which must
 * NOT extend the timeout streak.
 *
 * The decomposition itself is still worth doing. It has to start with the
 * phases, not the state — extracting the state first is what produced a shadow
 * of it.
 */

import type { DownloadFailureShape } from "./downloadFailureShape";

/**
 * How a mod's install failed, for the streak rule.
 *
 * Reuses the driver's own classification rather than a narrower copy: the real
 * type also carries `"gone"` (Nexus answered fast and empty), and a local
 * two-value alias would have silently excluded it from the streak — which is
 * the shape that matters most, since a run of `gone` means the collection
 * references files that no longer exist rather than a wedged Vortex.
 */
export type FailureShape = DownloadFailureShape;

/**
 * Two counters and the rule that connects them.
 *
 * A streak is how the driver tells "this mod is broken" from "something is
 * broken" — the first is a report, the second is a reason to stop asking. The
 * two are counted separately because they are different diagnoses: eight
 * failures in a row means the collection references things that cannot be
 * fetched; four TIMEOUTS in a row means Vortex itself is wedged, and only the
 * second is worth abandoning the run over.
 */
export class InstallStreaks {
  private _consecutiveFailures = 0;
  private _consecutiveTimeouts = 0;

  /**
   * One mod failed. A timeout also extends the timeout streak; anything else
   * ends it.
   *
   * `gone` and `unclear` both end the timeout streak. A missing file is a fact
   * about the collection, not a sign that Vortex is wedged, and conflating
   * them stops a run for the wrong reason — telling the user to restart
   * Vortex when what they actually need is a curator who repacked.
   */
  noteModFailed(shape: FailureShape): void {
    this._consecutiveFailures += 1;
    this._consecutiveTimeouts =
      shape === "timed-out" ? this._consecutiveTimeouts + 1 : 0;
  }

  /**
   * One mod succeeded. BOTH streaks reset — that is the whole rule.
   *
   * The reset is the point: a streak only means anything while it is
   * unbroken, and one success proves the cause was not systemic.
   */
  noteModSucceeded(): void {
    this._consecutiveFailures = 0;
    this._consecutiveTimeouts = 0;
  }

  get consecutiveFailures(): number {
    return this._consecutiveFailures;
  }

  get consecutiveTimeouts(): number {
    return this._consecutiveTimeouts;
  }
}
