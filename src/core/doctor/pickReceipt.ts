/**
 * ──────────────────────────────────────────────────────────────────────
 * Which installed collection the Doctor diagnoses.
 *
 * ─── A ZERO-EFFORT DEFAULT DIAGNOSED THE WRONG COLLECTION ─────────────
 * Receipts are one file per package id, and `listReceipts` returns them in
 * raw `readdir` order — which on every real filesystem means sorted by the
 * package UUID, a number with no relationship to anything a user cares
 * about. The Doctor took `receipts[0]`.
 *
 * On a player's machine that was `351ac575…` — Ivy's OLD Nexus page, v1.0.12,
 * installed on 3 September — while the collection they had just installed was
 * `b4715cae…` v1.0.28. `3` sorts before `b`, so every check they ran
 * diagnosed a three-week-old collection. It cost them more than a wrong
 * reading: the profile check saw "you are on a different profile", offered
 * "Switch to that profile", and the switch they accepted moved Vortex OFF the
 * collection they had just installed and then re-pinned the old load order
 * over it.
 *
 * So the default is not a tie-break, it is the whole answer for anyone who
 * never opens the picker. It follows the ACTIVE PROFILE: the collection you
 * are set up to play right now is the one a health check is about. Only when
 * no receipt claims the active profile does it fall back to the most recent
 * install, which is what "the last install of this collection on this
 * machine" — the sentence the panel already prints — has always promised.
 * ──────────────────────────────────────────────────────────────────────
 */

/** The minimum of a receipt this choice reads. */
export interface DoctorReceiptChoice {
  /** The Vortex profile the install filled. */
  vortexProfileId: string;
  /** ISO-8601, as every receipt carries. */
  installedAt: string;
}

/**
 * Newest first. An unparseable or missing `installedAt` sorts LAST rather
 * than winning: `NaN` compares false against everything, and a receipt whose
 * date we cannot read is the last one that should be picked by date.
 */
function newestFirst<T extends DoctorReceiptChoice>(receipts: readonly T[]): T[] {
  return [...receipts].sort((a, b) => {
    const at = Date.parse(a.installedAt);
    const bt = Date.parse(b.installedAt);
    if (Number.isNaN(at) && Number.isNaN(bt)) return 0;
    if (Number.isNaN(at)) return 1;
    if (Number.isNaN(bt)) return -1;
    return bt - at;
  });
}

/**
 * The collection the Doctor should open on.
 *
 * @param activeProfileId Vortex's active profile, or `undefined` when it
 *        could not be read — in which case this degrades to "newest install"
 *        rather than guessing.
 *
 * Returns `undefined` only for an empty list, so the caller's "no collection
 * installed" screen keeps its single cause.
 */
export function pickDoctorReceipt<T extends DoctorReceiptChoice>(
  receipts: readonly T[],
  activeProfileId: string | undefined,
): T | undefined {
  const byDate = newestFirst(receipts);
  if (activeProfileId !== undefined) {
    // Newest among the matches, not merely the first: two collections
    // installed into one profile is unusual but not impossible, and the
    // later install is the one that shaped what is on disk now.
    const onActive = byDate.find((r) => r.vortexProfileId === activeProfileId);
    if (onActive !== undefined) return onActive;
  }
  return byDate[0];
}
