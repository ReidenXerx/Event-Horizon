/**
 * Config answers whose mod is no longer in the collection.
 *
 * ─── THE TWO CASES, WHICH ARE NOT THE SAME ─────────────────────────────────
 * `collectionConfig.externalMods` is keyed by Vortex mod id and holds the
 * curator's per-mod answers — bundle, mirror, declare. It deliberately does
 * NOT prune, and `reconcileExternalModsConfig` says why: "the curator may have
 * temporarily removed a mod from the profile and we want their preserved
 * instructions to survive that."
 *
 * That reasoning is right for one case and wrong for the other, and the build
 * could not tell them apart — it saw only "this mod is not in the collection"
 * and hard-failed:
 *
 *   Config flags modId "AAF_V1-5-5" as bundled, but no such mod is in the
 *   active profile right now.
 *
 *  - **DISABLED** — the mod is still in Vortex's per-game pool, just switched
 *    off or in another profile. The answer is live and the absence is very
 *    likely an oversight: the curator marked it to ship and it is not
 *    shipping. Failing the build protects them. UNCHANGED.
 *
 *  - **DELETED** — the mod is gone from the pool entirely. The answer refers
 *    to nothing and can never be satisfied, so it blocks every future build
 *    until someone hand-edits a JSON file. That is not a decision to force on
 *    anyone; it is a stale record to drop.
 *
 * The distinction is one lookup against the game pool (NS-3: the pool is what
 * "do you have this mod" means, never a profile), and it is the whole fix.
 */

/** Why a config entry could not be matched to a mod in the collection. */
export type StaleEntryKind =
  /** Gone from Vortex's per-game pool. The answer is dead. */
  | "deleted"
  /** Still in the pool, but not in this collection's scope. */
  | "disabled";

/**
 * Which of the two this is.
 *
 * @param modId        the config key
 * @param inCollection ids the build is actually shipping
 * @param inGamePool   every mod id Vortex holds for this game, enabled or not
 */
export function classifyMissingConfigEntry(
  modId: string,
  inCollection: ReadonlySet<string>,
  inGamePool: ReadonlySet<string>,
): StaleEntryKind | undefined {
  if (inCollection.has(modId)) return undefined;
  return inGamePool.has(modId) ? "disabled" : "deleted";
}

/** The sentence a curator reads about a dropped answer. */
export function describeDroppedEntry(
  modId: string,
  name: string | undefined,
  answer: string,
): string {
  const label = name !== undefined && name.length > 0 ? `"${name}"` : `"${modId}"`;
  return (
    `${label} was marked "${answer}" in this collection's settings, but the ` +
    `mod is no longer installed in Vortex at all — so that answer has been ` +
    `dropped and the build carried on. If you reinstall the mod you will be ` +
    `asked about it again.`
  );
}
