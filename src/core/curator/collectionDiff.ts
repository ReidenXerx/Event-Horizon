/**
 * ──────────────────────────────────────────────────────────────────────
 * What changed between the collection you shipped and the profile you have.
 *
 * The question a curator asks before pressing Rebuild, and until now the
 * dashboard could only answer it as a yes: it knew the profile had moved and
 * said nothing about how. This is the diff — added, removed, updated, toggled
 * — so the next version is something the curator chose rather than something
 * that happened.
 *
 * ─── IT IS KEYED ON THE COLLECTION'S OWN VOCABULARY ────────────────────
 * `compareKey` is what a manifest uses to name a mod, and for a Nexus mod it
 * is `nexus:<modId>:<fileId>` — derivable from a live profile for free, and
 * identical to what the build will compute. Comparing on anything else would
 * report changes the build then disagrees with.
 *
 * ─── AND EXACT ONLY WHERE IT CAN BE ────────────────────────────────────
 * An EXTERNAL mod's key is the sha256 of its archive, or a hash over its whole
 * staging folder. Both mean reading gigabytes, which is not something a view
 * that opens beside a button may do. So external mods are matched by NAME and
 * counted separately as approximate, rather than being silently compared on a
 * weaker basis or silently dropped.
 *
 * A rename of an external mod therefore reads as one removal and one addition.
 * That is wrong-looking but honest, and the alternative — inventing a match —
 * would tell the curator their collection is unchanged when it is not.
 * ──────────────────────────────────────────────────────────────────────
 */

import { compareSelections } from "./fomodSelectionDiff";
import { compareShapes, stagingShapeOf } from "./stagingShape";
import { nexusCompareKey } from "../identity/compareKey";
import { isNexusSourced } from "../identity/nexusSourced";
import type {
  AuditorMod,
  FomodSelectionStep,
} from "../getModsListForProfile";
import type { EhcollMod } from "../../types/ehcoll";

/**
 * The little of a shipped mod this diff needs.
 *
 * Deliberately NOT `EhcollMod`: that carries `state.stagingFiles`, which on a
 * 963-mod collection is a list of every file of every mod. A view that holds
 * the whole manifest to answer "what changed" pays megabytes of React state
 * for four fields.
 */
export type BuiltModSummary = {
  compareKey: string;
  name: string;
  version?: string;
  enabled: boolean;
  /**
   * The curator's FOMOD answers at build time.
   *
   * Included despite this type's rule against heavy fields, because it is not
   * one: a mod's answers are a handful of step/group/choice names, where
   * `stagingFiles` is every file of every mod. The whole point of the
   * exclusion above is that the diff must not hold megabytes; this is bytes.
   *
   * Without it the diff cannot see a re-install through the installer wizard
   * — same mod, same file, same version, different contents.
   */
  fomodSelections: FomodSelectionStep[];
  /** The build PROVED an empty answer set. See `compareSelections` (NS-8). */
  emptySelectionVerified?: boolean;
  /**
   * A stat-only fingerprint of what this mod staged at build time.
   *
   * Derived from `state.stagingFiles` and then that array is DROPPED — the
   * reduction is the point. A hash is 64 characters; the file list it came
   * from is, across a 1,755-mod collection, hundreds of thousands of entries
   * this view must never hold.
   *
   * Absent when the package recorded no staged files for the mod, which is a
   * real state and must not read as "nothing staged".
   */
  stagingShape?: string;
};

/** Project a manifest down to what the diff reads. */
export function summarizeBuiltMods(
  mods: readonly EhcollMod[],
): BuiltModSummary[] {
  return mods.map((mod) => ({
    compareKey: mod.compareKey,
    name: mod.name,
    fomodSelections: mod.install?.fomodSelections ?? [],
    ...(mod.state?.stagingFiles !== undefined &&
    mod.state.stagingFiles.length > 0
      ? { stagingShape: stagingShapeOf(mod.state.stagingFiles) }
      : {}),
    ...(mod.install?.emptySelectionVerified === true
      ? { emptySelectionVerified: true }
      : {}),
    ...(mod.version !== undefined ? { version: mod.version } : {}),
    // Absent means enabled: the manifest omits `false` only for mods that
    // were on, and an older package may not carry the field at all.
    enabled: mod.state?.enabled !== false,
  }));
}

export type DiffEntry = {
  name: string;
  /** Present when known on both sides or the one side that has it. */
  version?: string;
};

export type UpdatedEntry = {
  name: string;
  fromVersion: string;
  toVersion: string;
};

/**
 * A mod whose CONTENTS changed while its identity did not.
 *
 * The reason is carried because the two causes call for different actions: a
 * curator who re-ran an installer chose that, while one whose staging folder
 * drifted may not know it happened at all.
 */
export type ReconfiguredEntry = {
  name: string;
  version?: string;
  reason: "installer-options" | "staged-files";
};

export type ToggledEntry = {
  name: string;
  nowEnabled: boolean;
};

export type CollectionDiff = {
  /** In the profile, not in the shipped collection. */
  added: DiffEntry[];
  /** In the shipped collection, not in the profile any more. */
  removed: DiffEntry[];
  /** Same Nexus mod, different file. */
  updated: UpdatedEntry[];
  /** Same mod, but switched on or off since the build. */
  toggled: ToggledEntry[];
  /**
   * Same mod and same file, re-installed with DIFFERENT installer options.
   *
   * The axis the first four miss entirely. Added, removed, updated and toggled
   * are all about a mod's IDENTITY, and re-running a FOMOD wizard changes none
   * of them — so the dashboard reported "your profile still matches the
   * published version" about a collection whose contents had changed, and a
   * rebuild would have shipped the new files under the old version number.
   */
  reconfigured: ReconfiguredEntry[];
  /**
   * Mods whose installer answers could not be compared either way.
   *
   * One side has answers and the other does not, and nothing proves the empty
   * side means "picked nothing" rather than "Vortex discarded them" (NS-8).
   * Counted rather than hidden, so "no changes" is never read as stronger than
   * the evidence — the same rule as `approximate`.
   */
  selectionsUnknown: number;
  /**
   * Mods whose staged FILES could not be compared.
   *
   * Either the package recorded none or the folder could not be walked. Like
   * `selectionsUnknown`, counted and stated rather than folded into a match.
   */
  stagingUnknown: number;
  /** Matched and identical. Counted, because it is the boring majority. */
  unchanged: number;
  /**
   * How many mods could only be matched by NAME.
   *
   * External mods, whose real key needs a hash of the archive or the whole
   * staging folder. Surfaced so "no changes" is never read as stronger than
   * the evidence behind it.
   */
  approximate: number;
};

const shown = (v: string | undefined): string => v ?? "unknown";

/** The key a Nexus mod will have in the next manifest, computed the same way. */
function keyFor(mod: AuditorMod): string | undefined {
  return isNexusSourced(mod)
    ? nexusCompareKey(mod.nexusModId as number, mod.nexusFileId as number)
    : undefined;
}

/** The Nexus mod id inside a `nexus:<modId>:<fileId>` key. */
function nexusModIdOf(compareKey: string): string | undefined {
  const parts = compareKey.split(":");
  return parts[0] === "nexus" && parts.length === 3 ? parts[1] : undefined;
}

/**
 * ──────────────────────────────────────────────────────────────────────
 * Diff the shipped collection against the live profile.
 *
 * Pure. `built` is the manifest of the version currently published;
 * `current` is what `getModsForProfile` reports right now.
 *
 * ─── THE TWO SIDES DO NOT ALWAYS SPEAK THE SAME VOCABULARY ─────────────
 * A manifest records whatever identity was available AT BUILD TIME. On a
 * real 1,757-mod package, 29 mods came out as `external:staging:<hash>` —
 * Event Horizon could not tie them to Nexus then. The same mods read as
 * `nexus:<modId>:<fileId>` from the live profile today, because Vortex has
 * since filled in their attributes.
 *
 * Neither key is wrong; they are answers to different questions asked at
 * different times. But an exact comparison finds nothing, and the name
 * fallback used to run ONLY when the CURRENT mod lacked a Nexus key — so
 * for a mod that was external then and Nexus-keyed now, no fallback ran at
 * all. Twenty mods the curator had not touched appeared as twenty additions
 * and twenty removals of the same twenty names.
 *
 * So the fallback is symmetric now: name is consulted whenever EITHER side
 * is not Nexus-keyed. A name appearing in both `added` and `removed` is
 * always a failure to match, never a change.
 *
 * ─── AND NAME NEVER OVERRIDES TWO REAL KEYS ────────────────────────────
 * When both sides ARE Nexus-keyed, a different file id is an UPDATE and is
 * reported as one. Name matching is the bridge between vocabularies, not a
 * shortcut around them — letting it run there would silently swallow a
 * genuine version change whenever an author kept the file name.
 * ──────────────────────────────────────────────────────────────────────
 */
export function diffCollectionAgainstProfile(args: {
  built: readonly BuiltModSummary[];
  current: readonly AuditorMod[];
  /**
   * Vortex mod id → stat-only shape of that mod's staging folder RIGHT NOW.
   *
   * Optional, and the function stays pure: walking a thousand folders is the
   * caller's job and its cost. Omit it and the staged-files axis does not run,
   * which is reported rather than assumed.
   */
  liveShapes?: ReadonlyMap<string, string>;
}): CollectionDiff {
  const { built, current, liveShapes } = args;

  const diff: CollectionDiff = {
    added: [],
    removed: [],
    updated: [],
    toggled: [],
    reconfigured: [],
    selectionsUnknown: 0,
    stagingUnknown: 0,
    unchanged: 0,
    approximate: 0,
  };

  /** Built entries accounted for, so the leftovers are genuine removals. */
  const claimed = new Set<string>();

  const builtByKey = new Map<string, BuiltModSummary>();
  /** Only Nexus-keyed entries, so this index can never bridge vocabularies. */
  const byNexusModId = new Map<string, BuiltModSummary[]>();
  const byName = new Map<string, BuiltModSummary[]>();
  for (const mod of built) {
    builtByKey.set(mod.compareKey, mod);
    const modId = nexusModIdOf(mod.compareKey);
    if (modId !== undefined) {
      const list = byNexusModId.get(modId);
      if (list === undefined) byNexusModId.set(modId, [mod]);
      else list.push(mod);
    }
    const named = byName.get(mod.name);
    if (named === undefined) byName.set(mod.name, [mod]);
    else named.push(mod);
  }

  /**
   * The first candidate not already spoken for, optionally filtered.
   *
   * The predicate matters more than it looks. Taking the FIRST unclaimed
   * candidate is only right when there is one; a Nexus page routinely ships
   * several installs — a main file and its variants, "Bodypaints - CBBE"
   * beside "Bodypaints - Male" — and then "first" is whichever the built
   * manifest happened to list first.
   */
  const firstUnclaimed = (
    list: BuiltModSummary[] | undefined,
    accept?: (b: BuiltModSummary) => boolean,
  ): BuiltModSummary | undefined =>
    list?.find(
      (b) => !claimed.has(b.compareKey) && (accept === undefined || accept(b)),
    );

  /** Same mod on both sides: identical, or switched on or off. */
  const settle = (
    mod: AuditorMod,
    match: BuiltModSummary,
    approximate: boolean,
  ): void => {
    claimed.add(match.compareKey);
    if (approximate) diff.approximate += 1;

    /**
     * Both axes, not one or the other. A mod can be switched off AND
     * re-configured, and the old `if/else` counted the second as unchanged
     * whenever the first fired.
     */
    let changed = false;
    if (match.enabled !== mod.enabled) {
      diff.toggled.push({ name: mod.name, nowEnabled: mod.enabled });
      changed = true;
    }
    const verdict = compareSelections(
      match.fomodSelections,
      mod.fomodSelections,
      match.emptySelectionVerified === true,
    );
    if (verdict === "differ") {
      diff.reconfigured.push({
        name: mod.name,
        reason: "installer-options",
        ...(mod.version !== undefined ? { version: mod.version } : {}),
      });
      changed = true;
    } else if (verdict === "unknown") {
      diff.selectionsUnknown += 1;
    }

    /**
     * And the files themselves, when the caller could afford to look.
     *
     * `liveShapes` is optional: producing it means walking every staging
     * folder, which the pure diff has no business doing and some callers
     * cannot afford. Absent, this axis simply does not run — it is never
     * silently reported as "unchanged".
     *
     * Only when the installer answers did NOT already explain the change: a
     * re-run installer changes the staged files too, and reporting one mod
     * twice for one event is noise.
     */
    if (liveShapes !== undefined) {
      const shapeVerdict = compareShapes(
        match.stagingShape,
        liveShapes.get(mod.id),
      );
      /**
       * The guard used to wrap this whole block, which suppressed the
       * ACCOUNTING as well as the second finding. A mod whose selections
       * differ AND whose folder could not be walked was counted nowhere:
       * `stagingUnknown` did not see it, so `describeCollectionDiff` never
       * said a check had failed to complete for it, and "we could not tell"
       * read as "we told you everything".
       *
       * Only the duplicate REPORT is suppressed now. A re-run installer
       * changes the staged files too, so listing one mod twice for one event
       * is noise — but the unknown is a different fact and it still counts.
       */
      if (shapeVerdict === "differ") {
        if (verdict !== "differ") {
          diff.reconfigured.push({
            name: mod.name,
            reason: "staged-files",
            ...(mod.version !== undefined ? { version: mod.version } : {}),
          });
          changed = true;
        }
      } else if (shapeVerdict === "unknown") {
        diff.stagingUnknown += 1;
      }
    }
    if (!changed) {
      diff.unchanged += 1;
    }
  };

  // Pass 1 — an exact key match, which needs no interpretation at all.
  const pending: { mod: AuditorMod; key: string | undefined }[] = [];
  for (const mod of current) {
    const key = keyFor(mod);
    const match = key === undefined ? undefined : builtByKey.get(key);
    if (match !== undefined && !claimed.has(match.compareKey)) {
      settle(mod, match, false);
    } else {
      pending.push({ mod, key });
    }
  }

  // Pass 2 — both sides Nexus-keyed for the same page: a newer FILE, which
  // is an update. Calling it an addition would also make the old file look
  // removed, reporting one change as two.
  const stillPending: typeof pending = [];
  for (const entry of pending) {
    const modId = entry.key === undefined ? undefined : nexusModIdOf(entry.key);
    /**
     * Prefer the entry with the SAME NAME before falling back to any entry
     * from the page. Two installs off one page are the ordinary case, and
     * pairing "Bodypaints - Male" with the built "Bodypaints - CBBE" reports
     * an update that did not happen — with the wrong from/to versions — and
     * leaves the real counterpart to be reported as added AND removed.
     */
    const fromPage = modId === undefined ? undefined : byNexusModId.get(modId);
    const match =
      firstUnclaimed(fromPage, (b) => b.name === entry.mod.name) ??
      firstUnclaimed(fromPage);
    if (match === undefined) {
      stillPending.push(entry);
      continue;
    }
    claimed.add(match.compareKey);
    diff.updated.push({
      name: entry.mod.name,
      fromVersion: shown(match.version),
      toVersion: shown(entry.mod.version),
    });
  }

  // Pass 3 — the bridge. One side is not Nexus-keyed, so no key comparison
  // is possible and the name is the only thing both sides agree on. Counted
  // as approximate, because a rename would defeat it.
  const unmatched: AuditorMod[] = [];
  for (const entry of stillPending) {
    /**
     * The bridgeability test belongs IN the search, not after it.
     *
     * It used to take the first unclaimed name match and then ask whether
     * that one could bridge — so when a name is shared by a Nexus-keyed
     * entry and an external one, and this side is Nexus-keyed, the first
     * candidate fails the test and the mod is reported as ADDED even though
     * the external entry sitting right behind it is exactly its counterpart.
     * One unchanged mod then reads as one addition and one removal.
     */
    const candidate = firstUnclaimed(
      byName.get(entry.mod.name),
      (b) =>
        entry.key === undefined || nexusModIdOf(b.compareKey) === undefined,
    );
    if (candidate !== undefined) settle(entry.mod, candidate, true);
    else unmatched.push(entry.mod);
  }

  for (const mod of unmatched) {
    diff.added.push({
      name: mod.name,
      ...(mod.version !== undefined ? { version: mod.version } : {}),
    });
  }

  for (const mod of built) {
    if (claimed.has(mod.compareKey)) continue;
    diff.removed.push({
      name: mod.name,
      ...(mod.version !== undefined ? { version: mod.version } : {}),
    });
  }

  return diff;
}

/** True when the profile still matches what was shipped. */
export function isUnchanged(diff: CollectionDiff): boolean {
  return (
    diff.added.length === 0 &&
    diff.removed.length === 0 &&
    diff.updated.length === 0 &&
    diff.toggled.length === 0 &&
    diff.reconfigured.length === 0
  );
}

/**
 * The summary line above the diff.
 *
 * Says what a rebuild WOULD do rather than what happened, because that is the
 * decision in front of the curator.
 */
export function describeCollectionDiff(diff: CollectionDiff): string {
  if (isUnchanged(diff)) {
    const line =
      `Your profile still matches the published version — ${diff.unchanged} ` +
      `mod(s), nothing added, removed, updated, toggled or re-configured.`;
    /**
     * Never a bare "matches" when something could not be checked. A curator
     * reads this line to decide whether to rebuild, and an unqualified match
     * is a stronger claim than the evidence when part of it was unreadable.
     */
    const unresolved = diff.selectionsUnknown + diff.stagingUnknown;
    return unresolved > 0
      ? `${line} ${unresolved} check(s) could not be completed — a rebuild ` +
          `reads every file and would settle it.`
      : line;
  }
  const parts: string[] = [];
  if (diff.added.length > 0) parts.push(`${diff.added.length} added`);
  if (diff.removed.length > 0) parts.push(`${diff.removed.length} removed`);
  if (diff.updated.length > 0) parts.push(`${diff.updated.length} updated`);
  if (diff.toggled.length > 0) parts.push(`${diff.toggled.length} toggled`);
  const byOptions = diff.reconfigured.filter(
    (r) => r.reason === "installer-options",
  ).length;
  const byFiles = diff.reconfigured.length - byOptions;
  if (byOptions > 0) {
    parts.push(`${byOptions} re-installed with different options`);
  }
  if (byFiles > 0) {
    parts.push(`${byFiles} with edited staging folders`);
  }
  const head = `Rebuilding would ship ${parts.join(", ")}.`;
  const notes: string[] = [];
  if (diff.approximate > 0) {
    notes.push(
      `${diff.approximate} external mod(s) could only be matched by name — ` +
        `their real identity is a hash of the archive, which is only computed ` +
        `during a build.`,
    );
  }
  if (diff.selectionsUnknown > 0) {
    notes.push(
      `${diff.selectionsUnknown} mod(s) had installer answers on one side ` +
        `only, so whether their options changed could not be determined.`,
    );
  }
  if (diff.stagingUnknown > 0) {
    notes.push(
      `${diff.stagingUnknown} mod(s) had no staged file list to compare ` +
        `against, so an edit to their folder would not show here.`,
    );
  }
  return [head, ...notes].join(" ");
}
