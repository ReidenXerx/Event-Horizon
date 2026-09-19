/**
 * ──────────────────────────────────────────────────────────────────────
 * Mods the previous revision had and this one does not.
 *
 * ─── WHY THIS HAS TO BE SAID OUT LOUD ──────────────────────────────────
 * A version-changing update installs into a FRESH PROFILE, so a mod the
 * curator dropped is not removed, not disabled, and — until this existed —
 * not mentioned anywhere. It stays in Vortex's per-game pool, enabled in the
 * profile of the revision the player was on, and inert in the new one.
 *
 * That is the correct BEHAVIOUR. NS-2 forbids destroying it, the player may
 * want it, and orphan detection is off by construction in fresh-profile mode
 * because a new profile starts empty. What was wrong is the silence: the
 * player's disk fills up one revision at a time with mods nothing will ever
 * mention again, and when they wonder why the collection is 40 GB bigger than
 * the download, nothing can tell them.
 *
 * So this is a NOTICE, never an action. It names what changed hands, says
 * where those mods are still switched on, and leaves the decision where it
 * belongs.
 *
 * ─── WHAT IT DELIBERATELY DOES NOT CLAIM ───────────────────────────────
 * Not "these were deleted" — nothing was. Not "you should remove them" — we
 * do not know that. And it only counts mods the PREVIOUS RECEIPT says we
 * installed: a mod the player added themselves was never ours to report on.
 * ──────────────────────────────────────────────────────────────────────
 */

import type { InstallReceiptMod } from "../../types/installLedger";

export type DroppedMod = {
  vortexModId: string;
  compareKey: string;
  name: string;
};

/** How many names go in the notice before it becomes a wall of text. */
const NAMES_SHOWN = 8;

/**
 * Which of the previous revision's mods this one no longer contains.
 *
 * Pure, so the rule is testable without an install. `stillInstalled` lets the
 * caller exclude mods the player has since removed themselves — reporting
 * those would be describing a disk nobody has.
 */
export function findDroppedMods(args: {
  previousMods: readonly InstallReceiptMod[];
  /** compareKeys in the manifest being installed NOW. */
  currentCompareKeys: ReadonlySet<string>;
  /** Vortex mod ids that still exist, when the caller can answer it. */
  stillInstalled?: ReadonlySet<string>;
}): DroppedMod[] {
  const out: DroppedMod[] = [];
  for (const mod of args.previousMods) {
    if (args.currentCompareKeys.has(mod.compareKey)) continue;
    /**
     * Ours to talk about, or theirs?
     *
     * `ownership: "adopted"` means the mod was already on this machine and we
     * recognised it rather than installing it. It does not belong to the
     * collection in any sense that survives the collection dropping it, and
     * saying "this version no longer includes it" about a mod the player
     * brought themselves is both wrong and alarming.
     */
    if (mod.ownership !== "installed") continue;
    if (
      args.stillInstalled !== undefined &&
      !args.stillInstalled.has(mod.vortexModId)
    ) {
      continue;
    }
    out.push({
      vortexModId: mod.vortexModId,
      compareKey: mod.compareKey,
      name: mod.name,
    });
  }
  return out;
}

/**
 * The lines the Done screen shows, or nothing when nothing was dropped.
 *
 * `previousProfileName` is where those mods are still switched on — the fact
 * that makes the notice actionable rather than merely interesting.
 */
export function describeDroppedMods(
  dropped: readonly DroppedMod[],
  previousProfileName: string | undefined,
): string[] {
  if (dropped.length === 0) return [];

  const shown = dropped.slice(0, NAMES_SHOWN).map((m) => m.name);
  const rest = dropped.length - shown.length;
  const names = shown.join(", ") + (rest > 0 ? `, and ${rest} more` : "");
  const count = `${dropped.length} mod${dropped.length === 1 ? "" : "s"}`;
  const they = dropped.length === 1 ? "it" : "they";

  return [
    `${count} from the version you had are not in this one: ${names}.`,
    `Nothing was removed — ${they} ${dropped.length === 1 ? "is" : "are"} ` +
      `still installed and still switched on in` +
      (previousProfileName !== undefined
        ? ` your previous profile, "${previousProfileName}"`
        : ` the profile you were using before`) +
      `, and switched off in this one. Delete ${they} in Vortex if you want ` +
      `the disk space back, or leave ${they} alone if you still want ${they}.`,
  ];
}
