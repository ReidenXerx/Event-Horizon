/**
 * ──────────────────────────────────────────────────────────────────────
 * Offering to remove the profiles an earlier install of the same
 * collection left behind.
 *
 * A fresh-profile install creates one profile per collection VERSION, which
 * is deliberate: it is what lets someone go back to the version they were
 * playing. What was never handled is the other end — after seventeen
 * installs a curator's profile list is seventeen entries long, sixteen of
 * them dead, and Vortex's own profile UI is where they live.
 *
 * ─── WHY THIS ASKS, EVERY TIME, AND NAMES WHAT IT WOULD DELETE ─────────
 * Deleting a profile throws away the enabled/disabled state and the load
 * order the user had there. Event Horizon created these particular profiles,
 * so removing them is inside what it may touch — but "Event Horizon made it"
 * is not the same as "the user is finished with it", and only the user knows
 * which. So this module never decides: it produces a LIST, and the caller
 * shows it with a tick per profile.
 *
 * ─── WHAT IT REFUSES TO OFFER ──────────────────────────────────────────
 * Three exclusions, each for its own reason rather than out of caution:
 *
 *  • the profile this install just landed in — deleting it would throw away
 *    the collection that was the point of the run;
 *  • the profile Vortex is on — Vortex must not be left pointing at a
 *    directory that no longer exists;
 *  • the game's LAST-ACTIVE profile — `clearLastActiveProfile` is internal
 *    to Vortex and not exported to extensions, so a deleted last-active
 *    profile leaves a dangling id we have no way to clear.
 *
 * And the name match is ANCHORED and escaped. A collection called "Ivy (2)"
 * would otherwise turn into a pattern matching things it must not, and a
 * profile the user renamed to "… - my tweaks" is theirs, not ours.
 *
 * Renaming a collection between versions hides the older profiles from this
 * list, because the name is the only evidence tying a profile to a
 * collection — a receipt records one profile, not the history. Missing a
 * stale profile costs a line in a list; offering to delete a profile that
 * belongs to a different collection costs the user their setup. The
 * conservative direction is the correct one here.
 * ──────────────────────────────────────────────────────────────────────
 */

import * as fsp from "fs/promises";
import * as path from "path";

import { actions, types } from "@nexusmods/vortex-api";

import { ehLog } from "../logging/ehLog";

/** A profile this collection left behind, as the offer lists it. */
export interface SupersededProfile {
  id: string;
  name: string;
  /** The collection version its name records, for the tick-list subtitle. */
  version: string;
}

/** The shape read off Vortex's `persistent.profiles`. */
export interface KnownProfile {
  id: string;
  name: string;
  gameId?: string;
}

/**
 * Escape a package name for use inside a RegExp.
 *
 * Collections are named by curators, and "Ivy's Panties (NSFW)" is an
 * ordinary name containing three regex metacharacters.
 */
function escapeForRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Matches exactly what {@link buildSuggestedProfileName} produces, plus the
 * collision suffix `pickNonCollidingName` may append — ` (2)`…` (999)`, or
 * the 8-hex fallback it uses when even that runs out.
 */
function nameMatcher(packageName: string): RegExp {
  return new RegExp(
    `^${escapeForRegExp(packageName)} \\(Event Horizon v(.+?)\\)` +
      `(?: \\((?:\\d+|[0-9a-f]{8})\\))?$`,
  );
}

/**
 * Every profile an earlier install of THIS collection created, minus the
 * three that must not be offered.
 *
 * Pure, so the rule can be tested without a Vortex. Returns them in name
 * order: the list is read, not computed against, and a stable order stops
 * the ticks moving between runs.
 */
export function supersededEhProfiles(input: {
  profiles: readonly KnownProfile[];
  gameId: string;
  packageName: string;
  /** The profile this run installed into. Never offered. */
  keepProfileId: string;
  activeProfileId?: string | undefined;
  lastActiveProfileId?: string | undefined;
}): SupersededProfile[] {
  const matcher = nameMatcher(input.packageName);
  const excluded = new Set(
    [input.keepProfileId, input.activeProfileId, input.lastActiveProfileId].filter(
      (id): id is string => id !== undefined,
    ),
  );

  const found: SupersededProfile[] = [];
  for (const profile of input.profiles) {
    if (profile.gameId !== input.gameId) continue;
    if (excluded.has(profile.id)) continue;
    const match = matcher.exec(profile.name);
    if (match === null) continue;
    found.push({
      id: profile.id,
      name: profile.name,
      version: match[1] ?? "",
    });
  }
  return found.sort((a, b) => a.name.localeCompare(b.name));
}

/** Every profile Vortex knows about, from its own state. */
export function readKnownProfiles(state: unknown): KnownProfile[] {
  const profiles = (
    state as {
      persistent?: {
        profiles?: Record<string, { gameId?: string; name?: string }>;
      };
    }
  )?.persistent?.profiles;
  if (profiles === undefined) return [];
  return Object.entries(profiles).map(([id, p]) => ({
    id,
    name: p?.name ?? "",
    ...(p?.gameId !== undefined ? { gameId: p.gameId } : {}),
  }));
}

/**
 * True while Vortex is deploying.
 *
 * Vortex's own profile removal refuses in this state, and it is right to:
 * deployment walks the active profile's mod list, and pulling a profile out
 * from under it is how a deploy half-finishes. Mirrors the check Vortex
 * makes rather than inventing a different one.
 */
export function deploymentInProgress(state: unknown): boolean {
  const activity = (
    state as { session?: { base?: { activity?: { mods?: unknown } } } }
  )?.session?.base?.activity?.mods;
  return Array.isArray(activity) && activity.includes("deployment");
}

export interface ProfileRemovalOutcome {
  removed: SupersededProfile[];
  failed: { profile: SupersededProfile; error: string }[];
}

/**
 * Remove profiles, the way Vortex removes them.
 *
 * ─── THE DIRECTORY IS THE PART THAT IS EASY TO MISS ────────────────────
 * `actions.removeProfile` only drops the profile from Vortex's state. Vortex's
 * own `removeProfileImpl` deletes `<userData>/<gameId>/profiles/<id>` FIRST
 * and dispatches afterwards, so a dispatch on its own leaves the folder —
 * with its plugins.txt and load order — orphaned on disk forever, invisible
 * to both Vortex and the user. The delete is not a tidy-up here; it is the
 * operation.
 *
 * `willRemoveProfile` goes first because Vortex's reducers mark the profile
 * `pendingRemove` on it, which is what stops anything else picking it up
 * while the directory is going away.
 *
 * Failures are collected rather than thrown: removing four profiles and
 * failing on the third should still report the two that went, and a locked
 * directory is an ordinary thing on Windows.
 */
export async function removeSupersededProfiles(deps: {
  api: types.IExtensionApi;
  gameId: string;
  userDataPath: string;
  profiles: readonly SupersededProfile[];
}): Promise<ProfileRemovalOutcome> {
  const outcome: ProfileRemovalOutcome = { removed: [], failed: [] };

  for (const profile of deps.profiles) {
    const dir = path.join(deps.userDataPath, deps.gameId, "profiles", profile.id);
    try {
      deps.api.store?.dispatch(actions.willRemoveProfile(profile.id));
      await fsp.rm(dir, { recursive: true, force: true });
      deps.api.store?.dispatch(actions.removeProfile(profile.id));
      outcome.removed.push(profile);
      ehLog("info", "profile.cleanup.removed", {
        id: profile.id,
        name: profile.name,
        dir,
      });
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      outcome.failed.push({ profile, error });
      ehLog("warn", "profile.cleanup.failed", {
        id: profile.id,
        name: profile.name,
        dir,
        err,
      });
    }
  }
  return outcome;
}
