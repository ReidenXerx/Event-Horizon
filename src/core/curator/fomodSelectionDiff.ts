/**
 * Did the curator re-install this mod with DIFFERENT installer options?
 *
 * ─── THE GAP THIS FILLS ─────────────────────────────────────────────────────
 * The dashboard diff compares four things: added, removed, updated, toggled.
 * All four are about a mod's IDENTITY. A curator who re-runs a FOMOD wizard
 * and picks different options changes none of them — same Nexus mod id, same
 * file id, same version, same enabled state — so the diff reported "your
 * profile still matches the published version" about a collection whose
 * contents had genuinely changed. The next build would have quietly shipped
 * the new files under the old version number.
 *
 * ─── WHY THIS SIGNAL AND NOT THE FILES ──────────────────────────────────────
 * The honest answer to "did the content change" is a hash of the staging
 * folder, and that is what the BUILD computes. It is also gigabytes of reading,
 * which a view that opens beside a button may not do — the same reason this
 * diff matches external mods by name and says so.
 *
 * FOMOD answers cost nothing. Both sides already carry them: the manifest
 * records `install.fomodSelections` at build time, and the live side reads the
 * same thing out of Vortex's `attributes.installerChoices`. Comparing them is
 * pure string work over data already in memory, and it catches precisely the
 * case that motivated this — a re-install through the wizard.
 *
 * It does NOT catch a hand-edited staging folder. Nothing cheap does, and
 * claiming otherwise would be worse than the gap.
 *
 * ─── NS-8: AN EMPTY ANSWER SET IS AMBIGUOUS ─────────────────────────────────
 * Vortex records nothing both when a user picked nothing AND when the answers
 * were lost — creating a variant without "Pre-populate installer options"
 * discards them. So "empty" is not a value, it is an absence, and comparing it
 * as though it were would report reconfigurations that never happened.
 *
 * The one exception is `emptySelectionVerified`: the build proves an empty
 * answer set by replaying the installer with no choices and comparing the
 * result against the curator's staging folder. Where that flag is set, empty
 * IS a value and can be compared like any other.
 *
 * Everything else returns `"unknown"`, which the caller reports as "could not
 * tell" rather than folding into either answer.
 */

import type { FomodSelectionStep } from "../getModsListForProfile";

/** What comparing two answer sets can conclude. */
export type SelectionVerdict =
  /** Both sides known, and they match. */
  | "same"
  /** Both sides known, and they differ — the mod was re-configured. */
  | "differ"
  /** At least one side's emptiness is ambiguous (NS-8). Do not guess. */
  | "unknown";

/**
 * Does this answer set actually contain a choice?
 *
 * Tolerates `undefined` and ragged shapes throughout. `AuditorMod` declares
 * `fomodSelections` as required and `getModsListForProfile` always supplies
 * it, but this runs in a DASHBOARD view over whatever Vortex state happens to
 * hold — and a diff that throws tells the curator nothing at all, which is
 * strictly worse than the gap it was written to close.
 */
export function hasChoices(
  steps: readonly FomodSelectionStep[] | undefined,
): boolean {
  return (steps ?? []).some((step) =>
    (step?.groups ?? []).some((g) => (g?.choices ?? []).length > 0),
  );
}

/**
 * A stable string for one answer set.
 *
 * Sorted at every level. Vortex emits steps, groups and choices in the
 * installer's own order, and that order is not part of the ANSWER — the same
 * options picked twice can come back arranged differently without the curator
 * having changed anything. Sorting means a reorder is not reported as a
 * reconfiguration.
 *
 * `idx` is included where present: two options can share a display name within
 * a group, and the index is what tells them apart.
 */
export function canonicalSelections(
  steps: readonly FomodSelectionStep[] | undefined,
): string {
  return (steps ?? [])
    .map((step) =>
      [
        step?.name ?? "",
        ...(step?.groups ?? [])
          .map((group) =>
            [
              group?.name ?? "",
              ...(group?.choices ?? [])
                .map((c) => (c.idx === undefined ? c.name : `${c.name}#${c.idx}`))
                .sort(),
            ].join("/"),
          )
          .sort(),
      ].join("|"),
    )
    .sort()
    .join("\n");
}

/**
 * Compare the built answer set against the live one.
 *
 * `builtVerified` is the manifest's `emptySelectionVerified` — the only thing
 * that makes an empty BUILT set meaningful (see NS-8 above).
 */
export function compareSelections(
  built: readonly FomodSelectionStep[] | undefined,
  live: readonly FomodSelectionStep[] | undefined,
  builtVerified = false,
): SelectionVerdict {
  const builtHas = hasChoices(built);
  const liveHas = hasChoices(live);

  // Both sides made choices: a real comparison.
  if (builtHas && liveHas) {
    return canonicalSelections(built) === canonicalSelections(live)
      ? "same"
      : "differ";
  }

  /**
   * The curator PROVED an empty answer set at build time, so empty is a value
   * here and the comparison is meaningful in both directions: still empty is
   * unchanged, and now-has-choices is a genuine reconfiguration.
   */
  if (builtVerified && !builtHas) {
    return liveHas ? "differ" : "same";
  }

  /**
   * Neither side has anything: no evidence of a change, and none to report.
   *
   * This is "same" rather than "unknown" for a blunt reason of proportion.
   * The overwhelming majority of mods have no FOMOD installer at all — on a
   * real 1,755-mod collection that is most of them — and calling every one of
   * those indeterminate would bury the handful of genuine ambiguities in
   * sixteen hundred lines of noise. An unknown nobody can act on is not
   * honesty, it is a broken signal.
   *
   * NS-8 governs REPLAY, where an empty set has to be handed to an installer
   * and guessing costs the user files. Nothing is being replayed here.
   */
  if (!builtHas && !liveHas) return "same";

  /**
   * Exactly one side is empty, and unproven — the case NS-8 is actually about.
   * A curator who picked nothing looks identical to one whose answers Vortex
   * discarded (creating a variant without "Pre-populate installer options"
   * does exactly that). Rare, and worth surfacing precisely because it is.
   */
  return "unknown";
}
