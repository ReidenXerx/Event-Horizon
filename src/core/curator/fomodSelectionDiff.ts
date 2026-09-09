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
 * ─── THREE STATES, NOT TWO ──────────────────────────────────────────────────
 * What an answer set tells us, which is not the same as what it contains.
 *
 * This module and `installerChoices.ts` read the SAME recorded shape and, for
 * a while, meant opposite things by it. `installerChoices` says it plainly:
 *
 *   "Steps PRESENT with every `choices` array empty is a different thing
 *    entirely: the build watched the curator go through the installer and
 *    recorded what they did, which was tick nothing and press Finish. That is
 *    an answer."
 *
 * It replays that unattended, and names six mods on the reference profile that
 * behave this way — iWant Status Bars, iWant Widgets, Rock Traps Trigger Fixes
 * and others. Meanwhile the old `hasChoices` returned `false` for exactly that
 * shape, so `compareSelections` treated it as an absence and answered
 * `"unknown"` — meaning the mods Event Horizon replays MOST confidently were
 * the ones it could never detect drift on.
 *
 * That is the Val Serano failure in the one shape where the manifest actually
 * holds a definite answer: the user re-installs through the wizard and ticks a
 * patch, the archive is unchanged so the compareKey is unchanged, verification
 * passes because the curator's files are all present (their extra patch is an
 * `extraFile`, informational by design), and the only signal left says
 * "cannot tell".
 */
export type SelectionEvidence =
  /** No installer was ever observed — the NS-8 absence, and nothing else. */
  | "absent"
  /** An installer WAS observed and nothing was ticked. That is an answer. */
  | "recorded-empty"
  /** At least one option was picked. */
  | "has-choices";

/**
 * Tolerates `undefined` and ragged shapes throughout. `AuditorMod` declares
 * `fomodSelections` as required and `getModsListForProfile` always supplies
 * it, but this runs in a DASHBOARD view over whatever Vortex state happens to
 * hold — and a diff that throws tells the curator nothing at all, which is
 * strictly worse than the gap it was written to close.
 */
export function selectionEvidence(
  steps: readonly FomodSelectionStep[] | undefined,
): SelectionEvidence {
  const list = steps ?? [];
  if (list.length === 0) return "absent";
  return list.some((step) => (step?.groups ?? []).some((g) => (g?.choices ?? []).length > 0))
    ? "has-choices"
    : "recorded-empty";
}

/**
 * Does this answer set actually contain a choice?
 *
 * Kept because "did they pick something" is still a question worth asking
 * directly. It is NOT the question `compareSelections` asks — conflating the
 * two is what shipped the bug above.
 */
export function hasChoices(
  steps: readonly FomodSelectionStep[] | undefined,
): boolean {
  return selectionEvidence(steps) === "has-choices";
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
  const builtEvidence = selectionEvidence(built);
  const liveEvidence = selectionEvidence(live);

  // Both sides made choices: a real comparison.
  if (builtEvidence === "has-choices" && liveEvidence === "has-choices") {
    return canonicalSelections(built) === canonicalSelections(live)
      ? "same"
      : "differ";
  }

  /**
   * ─── AN OBSERVED INSTALLER IS COMPARABLE, EVEN WITH NOTHING TICKED ──────
   * Both sides watched an installer run. One recorded ticks and the other
   * recorded none — that is two different answers to the same question, not a
   * missing answer, and `installerChoices.ts` already treats this shape as a
   * definite answer when it REPLAYS it. Returning "unknown" here made the mods
   * we replay most confidently the ones we could never detect drift on.
   *
   * Both recording none is the same answer twice, and is "same".
   */
  if (builtEvidence !== "absent" && liveEvidence !== "absent") {
    if (builtEvidence === "recorded-empty" && liveEvidence === "recorded-empty") {
      return "same";
    }
    return "differ";
  }

  /**
   * The curator PROVED an empty answer set at build time, so empty is a value
   * here and the comparison is meaningful in both directions: still empty is
   * unchanged, and now-has-choices is a genuine reconfiguration.
   */
  if (builtVerified && builtEvidence === "absent") {
    return liveEvidence === "has-choices" ? "differ" : "same";
  }

  /**
   * Neither side observed an installer at all: no evidence of a change, and
   * none to report.
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
  if (builtEvidence === "absent" && liveEvidence === "absent") return "same";

  /**
   * Exactly one side never saw an installer, and the built side is unproven —
   * the case NS-8 is actually about. A mod whose answers Vortex discarded
   * (creating a variant without "Pre-populate installer options" does exactly
   * that) is indistinguishable from one that has no installer, and the two
   * mean opposite things. Rare, and worth surfacing precisely because it is.
   */
  return "unknown";
}
