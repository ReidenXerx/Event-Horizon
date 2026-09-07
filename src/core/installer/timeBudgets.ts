/**
 * ──────────────────────────────────────────────────────────────────────
 * How long to wait before calling something hung.
 *
 * Every number here was a flat constant tuned on Windows with a small
 * collection. Two things break that: Wine, where the same file work costs
 * several times more, and scale, where a 954-mod collection does roughly a
 * hundred times the work of a 10-mod one and got exactly the same budget.
 *
 * ─── THE DISTINCTION THAT DRIVES THE DESIGN ────────────────────────────
 * A generous timeout is NOT automatically a cost to the user, and treating
 * all three of these the same way would be wrong.
 *
 *   A CEILING (deploy, profile switch) is a race between an event and a
 *   timer. If the work finishes in two seconds, the event fires, the timer
 *   is cleared, and the ceiling cost nothing whatsoever. Raising it is free
 *   on every successful run and only ever changes how long a genuinely
 *   stuck operation takes to give up. So: be generous.
 *
 *   A STALL WATCHDOG is different. It measures silence, so a bigger number
 *   directly means a hung install sits there longer before anyone is told.
 *   That IS a real cost, paid on the failure path. So rather than simply
 *   enlarging it, make it PROPORTIONAL TO THE WORK: a 2 GB archive is
 *   allowed to be quiet for longer than a 5 MB one, because it legitimately
 *   will be.
 *
 * The result is that a fast machine is never made to wait, and a slow one
 * is not accused of hanging for doing the work correctly.
 * ──────────────────────────────────────────────────────────────────────
 */

/**
 * How much slower to assume everything is under Wine/Proton.
 *
 * Deliberately a blunt multiplier rather than a measurement. The honest
 * position is that we cannot know the factor for a given prefix, filesystem
 * and Proton build; what we can know is that being too generous costs
 * nothing on a healthy run, while being too tight fails a correct install.
 * Given that asymmetry, guess high.
 */
export const WINE_SLOWDOWN = 3;

/** Assumed worst-case extraction throughput, for sizing the quiet window. */
/**
 * Deliberately far below any disk's real throughput, because extraction time
 * tracks FILE COUNT, not bytes.
 *
 * A 50 MB mod of 20,000 loose meshes and textures takes far longer than a
 * 500 MB mod of three BA2s, and under a Wine/Proton prefix every one of those
 * file operations crosses the translation layer. Sizing from bytes at a
 * disk-like rate assumes the opposite, and a tester's run killed a 535 KB mod
 * and a 28 MB mod that were extracting perfectly well.
 *
 * We cannot see the file count before extracting, so the rate absorbs it: at
 * 512 KB/s a byte-light, file-heavy mod still gets a window measured in
 * minutes rather than seconds.
 */
const PESSIMISTIC_EXTRACT_BYTES_PER_SEC = 512 * 1024; // 512 KB/s

/**
 * The flat constants these budgets replaced.
 *
 * Kept as named values rather than deleted, because they are the floors: a
 * budget that came out BELOW the number it replaced would fail installs that
 * used to pass, which is the one outcome this whole change exists to avoid.
 * The invariant is asserted in the tests, for every input, in both
 * environments.
 */
export const LEGACY_DEPLOY_TIMEOUT_MS = 5 * 60_000;
export const LEGACY_PROFILE_SWITCH_TIMEOUT_MS = 30_000;
export const LEGACY_STALL_WATCHDOG_MS = 90_000;

/**
 * The smallest extraction window we will ever allow, before the Wine multiplier.
 *
 * Ten minutes sounds enormous for a 500 KB file and is not: the number that
 * matters is how long Vortex can be silent while doing real work, and on a slow
 * disk full of loose files that is minutes, not seconds.
 */
export const EXTRACT_FLOOR_MS = 10 * 60_000;

export type BudgetEnv = {
  /** Whether we are running under Wine/Proton. */
  wine: boolean;
};

const scale = (ms: number, env: BudgetEnv): number =>
  env.wine ? ms * WINE_SLOWDOWN : ms;

const clamp = (ms: number, min: number, max: number): number =>
  Math.min(Math.max(Math.round(ms), min), max);

/**
 * Ceiling for Vortex to finish a deployment.
 *
 * Deployment links or copies every file of every mod, so the work is roughly
 * linear in mod count — a fixed five minutes was a 954-mod collection's
 * problem and a 10-mod collection's waste. It fires at the very END of an
 * install, which is the worst place to be wrong: everything succeeded and
 * the last step reports failure.
 */
export function deployBudgetMs(modCount: number, env: BudgetEnv): number {
  const base = 120_000; // enough for a small collection on a slow disk
  const perMod = 500; // linear component
  return clamp(
    scale(base + perMod * Math.max(0, modCount), env),
    // The floor is the OLD flat constant, not a smaller number chosen to look
    // tidy. A first draft used 2 min and would have given a 10-mod collection
    // LESS than it had before — a regression introduced by a change whose
    // entire purpose was to stop failing slow machines. Budgets may only ever
    // go up. See the invariant test.
    LEGACY_DEPLOY_TIMEOUT_MS,
    30 * 60_000, // never more than 30 min, or a real hang is unbearable
  );
}

/**
 * Ceiling for Vortex to switch profiles.
 *
 * ─── A SWITCH IS A PURGE, NOT A FLAG FLIP ──────────────────────────────
 * This used to read "cheaper than deployment but still proportional: the
 * profile carries every mod's enabled state", and charged 20ms per mod
 * against deployment's 500ms. That description is of the profile RECORD.
 * The work Vortex actually does is unlink every deployed file of the profile
 * being LEFT before it activates the new one — a deployment in reverse, at
 * deployment's cost.
 *
 * A tester with ~1,100 mods deployed got 64s for that and the install died
 * with "Profile switch did not complete within 64s. Check Vortex's
 * notifications for a stuck deployment." There was no stuck deployment. The
 * error sent them looking for one, which is the worst thing a timeout can do.
 *
 * Sized from the purge now. Still below `deployBudgetMs` — a purge unlinks
 * where a deploy links and reads content — but the same shape, because it is
 * the same walk over the same files.
 */
export function profileSwitchBudgetMs(
  modCount: number,
  env: BudgetEnv,
): number {
  return clamp(
    scale(60_000 + 200 * Math.max(0, modCount), env),
    LEGACY_PROFILE_SWITCH_TIMEOUT_MS,
    // Ten minutes, not five. A real hang is unbearable at either, and the
    // cost of being wrong the other way is a 1,700-mod install thrown away
    // at the second step — which is what happened.
    10 * 60_000,
  );
}

export type StallPhase =
  /** Bytes are arriving; Vortex's download state moves and we see it. */
  | { phase: "downloading" }
  /**
   * The archive is complete and Vortex is unpacking it. NOTHING observable
   * moves in this window — the download entry has stopped changing and the
   * mod record does not appear until the install finishes — so this is
   * where a flat watchdog wrongly declares a hang.
   */
  | { phase: "extracting"; bytes?: number };

/**
 * How long silence is allowed to last before we call the install hung.
 *
 * During download we get frequent signals, so silence really is suspicious
 * and the window stays tight. During extraction we are blind by
 * construction, so the window is sized from the archive itself: how long
 * would this legitimately take at a pessimistic throughput?
 */
export function stallBudgetMs(at: StallPhase, env: BudgetEnv): number {
  if (at.phase === "downloading") {
    // A stalled download is a real and common failure; keep this responsive.
    return clamp(scale(90_000, env), LEGACY_STALL_WATCHDOG_MS, 10 * 60_000);
  }

  // Unknown size: we cannot size the window, so fall back to something that
  // will not fail a large mod. Guessing small here is the expensive mistake.
  //
  // The FLOOR matters more than the formula. A small archive is not a fast
  // extraction — it may be thousands of tiny files, on unknown hardware, in a
  // prefix. The old floor was 90s (270s under Wine) and it killed healthy mods
  // of 535 KB, 2.2 MB, 6.2 MB and 28 MB in a single run.
  //
  // Being generous costs nothing when things are working: this timer RESETS on
  // every observed progress signal, so a large window is only ever spent when
  // genuinely nothing is happening. The only price is that a true hang takes
  // longer to notice, which is the right trade for an install that legitimately
  // runs for hours.
  const bytes = at.bytes ?? 0;
  const fromSize =
    bytes > 0 ? (bytes / PESSIMISTIC_EXTRACT_BYTES_PER_SEC) * 1000 : 10 * 60_000;

  return clamp(
    scale(Math.max(EXTRACT_FLOOR_MS, fromSize), env),
    EXTRACT_FLOOR_MS,
    2 * 60 * 60_000,
  );
}

/**
 * How many mods Vortex is tracking, across every game.
 *
 * Lives here rather than in each caller because both the deploy ceiling and
 * the profile-switch ceiling need it and a copy in each drifts.
 *
 * Deliberately forgiving: an unrecognised state shape returns 0, which floors
 * the budget at the legacy constant rather than throwing. This runs on the
 * install's critical path, and being wrong low costs a shorter budget while
 * throwing would fail the install outright. Vortex's state shape is not ours
 * to depend on precisely.
 */
export function countMods(state: unknown): number {
  const mods = (
    state as { persistent?: { mods?: Record<string, unknown> } } | null
  )?.persistent?.mods;
  if (mods === null || typeof mods !== "object" || mods === undefined) return 0;
  let total = 0;
  for (const perGame of Object.values(mods)) {
    if (perGame !== null && typeof perGame === "object") {
      total += Object.keys(perGame).length;
    }
  }
  return total;
}

/** One line for the log, so a timeout in the wild can be explained. */
export function describeBudget(
  what: string,
  ms: number,
  env: BudgetEnv,
): string {
  return `${what} budget ${Math.round(ms / 1000)}s${env.wine ? " (Wine: x" + WINE_SLOWDOWN + ")" : ""}`;
}
