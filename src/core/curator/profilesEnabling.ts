/**
 * ──────────────────────────────────────────────────────────────────────
 * Which of this game's profiles have a given mod switched ON.
 *
 * ─── WHY THE ORPHAN PROMPT NEEDS THIS ──────────────────────────────────
 * "Uninstall it" on an orphaned mod calls Vortex's `removeMods`, which is
 * GAME-scoped: in Vortex a mod lives in one pool per game and a profile only
 * records which are enabled (NS-3). So removing it removes it everywhere —
 * including from profiles that have nothing to do with this collection.
 *
 * The prompt said "Removes the mod entirely (file system + Vortex state).
 * Destructive." Every word of that is true and it still does not say the one
 * thing that matters: that the player's OWN profile loses the mod too. A
 * player who reads "orphaned" as "no longer part of this collection" and
 * ticks Uninstall is not agreeing to that.
 *
 * NS-2 is satisfied literally — Event Horizon did install the mod — but the
 * player's independent adoption of it is theirs, and this is what makes it
 * visible before they choose.
 *
 * Pure and defensive: Vortex state is a plain object and every level of it
 * can be absent on a profile that has never been opened.
 * ──────────────────────────────────────────────────────────────────────
 */

type ProfileShape = {
  gameId?: unknown;
  name?: unknown;
  modState?: Record<string, { enabled?: unknown }>;
};

type StateShape = {
  persistent?: { profiles?: Record<string, ProfileShape> };
};

/**
 * The NAMES of this game's profiles in which `modId` is enabled.
 *
 * `excludeProfileId` leaves out the profile the install is targeting — it is
 * the one the player is deciding about, so naming it back to them is noise.
 * Names, not ids, because the only consumer shows them to a person; a profile
 * with no name falls back to its id so it is never silently dropped from a
 * count the player is meant to weigh.
 */
export function profilesEnabling(args: {
  state: unknown;
  gameId: string;
  modId: string;
  excludeProfileId?: string;
}): string[] {
  const profiles = (args.state as StateShape)?.persistent?.profiles;
  if (profiles === null || typeof profiles !== "object") return [];

  const out: string[] = [];
  for (const [profileId, profile] of Object.entries(profiles)) {
    if (profileId === args.excludeProfileId) continue;
    if (profile?.gameId !== args.gameId) continue;
    // `enabled` is the only truthy value that counts. Vortex writes `false`
    // on a disable rather than deleting the entry, so presence is not enough.
    if (profile?.modState?.[args.modId]?.enabled !== true) continue;
    out.push(
      typeof profile.name === "string" && profile.name.length > 0
        ? profile.name
        : profileId,
    );
  }
  return out;
}
