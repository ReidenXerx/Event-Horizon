/**
 * Which archives get packed into the `.ehcoll`, and why the rest do not.
 *
 * ─── WHY THIS IS ITS OWN MODULE ─────────────────────────────────────────────
 * It was two modules. `buildPackageAction.ts` and `ui/pages/build/engine.ts`
 * each held a private `resolveBundledArchives` with the same signature and the
 * same rules, and the action's copy carried this comment:
 *
 *     // See engine.resolveBundledArchives — the same rule, and it must stay
 *     // the same rule. This copy is why marking a mod external fixed the
 *     // manifest and not the build.
 *
 * A shipped bug, attributed in writing to the duplication, with both copies
 * left in place. They then diverged AGAIN — measured, the two bodies differed
 * on nothing but user-facing text, and each had a message the other lacked.
 *
 * Six test files in this repo exist only to assert that these two build paths
 * have not drifted apart on some rule, each named after a rule that drifted
 * once already. That approach cannot hold, and it was proven not to: the
 * missing-masters gate landed on one path and shipped unchecked packages from
 * the other, because a regex over source text can only police the rules
 * somebody remembered to enumerate.
 *
 * So the rule gets one home. Both doors call it, both produce the same errors,
 * and there is nothing left to keep in step.
 *
 * ─── THE RULES, IN ONE PLACE ────────────────────────────────────────────────
 *  - An entry whose mod is GONE from Vortex is dropped and pruned. It refers
 *    to nothing and can never be satisfied, and failing on it blocked every
 *    future build until someone hand-edited a JSON file.
 *  - An entry whose mod is still installed but not in this collection keeps
 *    FAILING. The answer is live and the absence is almost certainly an
 *    oversight: a mod marked to ship that is not shipping.
 *  - A Nexus mod may only be bundled once the curator has marked it external
 *    (NS-6 territory: the user's own API key normally fetches it, and that
 *    stops being true the moment the file is deleted from Nexus).
 *  - No hash or no archive on disk is an error, never a silent skip.
 *
 * Per-mod failures accumulate rather than throwing, so a curator gets one
 * report covering every problem instead of fixing them one build at a time.
 */

import type { types } from "@nexusmods/vortex-api";

import {
  classifyMissingConfigEntry,
  describeDroppedEntry,
} from "./staleConfigEntries";
import { isNexusSourced } from "../identity/nexusSourced";
import { mayBundle } from "./shipsAsExternal";
import { resolveModArchivePath } from "../archiveHashing";
import { ehLog } from "../logging/ehLog";

import type { AuditorMod } from "../getModsListForProfile";
import type { BundledArchiveSpec } from "./packageZip";
import type { CollectionConfig } from "./collectionConfig";

export type BundledArchiveResolution = {
  bundledArchives: BundledArchiveSpec[];
  errors: string[];
  /** Curator-facing notes about answers that were dropped. */
  warnings: string[];
  /** Config keys whose mod no longer exists; safe to prune. */
  droppedModIds: string[];
};

export function resolveBundledArchives(
  state: types.IState,
  gameId: string,
  config: CollectionConfig,
  mods: AuditorMod[],
): BundledArchiveResolution {
  const errors: string[] = [];
  const warnings: string[] = [];
  const droppedModIds: string[] = [];
  const bundledArchives: BundledArchiveSpec[] = [];
  const modById = new Map(mods.map((m) => [m.id, m]));
  const inCollection = new Set(modById.keys());
  /**
   * Every mod id Vortex holds for this game, enabled or not (NS-3).
   *
   * This is what separates "the curator deleted the mod" from "the curator
   * switched it off", and those two get different answers.
   */
  const inGamePool = new Set(
    Object.keys(
      (
        state as unknown as {
          persistent?: { mods?: Record<string, Record<string, unknown>> };
        }
      )?.persistent?.mods?.[gameId] ?? {},
    ),
  );

  for (const [modId, entry] of Object.entries(config.externalMods)) {
    if (entry.bundled !== true) continue;

    const mod = modById.get(modId);
    if (mod === undefined) {
      const kind = classifyMissingConfigEntry(modId, inCollection, inGamePool);
      if (kind === "deleted") {
        warnings.push(describeDroppedEntry(modId, entry.name, "bundle"));
        droppedModIds.push(modId);
        ehLog("warn", "build.config.stale-entry-dropped", {
          modId,
          name: entry.name,
          answer: "bundled",
          why: "the mod is no longer in Vortex's mod pool for this game",
        });
        continue;
      }
      errors.push(
        `Config flags modId "${modId}" as bundled, but that mod is installed ` +
          `and NOT enabled in this profile, so it is not in the collection. ` +
          `Enable it, or set bundled=false.`,
      );
      continue;
    }

    // `mayBundle`, not `isNexusSourced` alone. A Nexus mod is normally not
    // bundleable because the user's own API key fetches it — but that stops
    // being true the moment the file is deleted from Nexus, which is exactly
    // when the curator marks it `treatAsExternal`.
    if (!mayBundle(isNexusSourced(mod), entry)) {
      errors.push(
        `Config flags Nexus mod "${mod.name}" (id="${modId}") as bundled, ` +
          `but it is not marked as an external dependency. Nexus mods are ` +
          `downloaded with the user's own API key, so bundling one only ` +
          `makes sense once its file is gone from Nexus — use "ship as ` +
          `external" on the availability check first.`,
      );
      continue;
    }

    if (
      typeof mod.archiveSha256 !== "string" ||
      mod.archiveSha256.length === 0
    ) {
      // Both halves kept: the engine's copy named the mod, the action's named
      // the remedy, and a curator reading either one alone had half an answer.
      errors.push(
        `External mod "${mod.name}" (id="${modId}") is flagged for bundling ` +
          `but has no archiveSha256. Re-export the snapshot or check the ` +
          `archive is on disk; the export pipeline should have hashed it.`,
      );
      continue;
    }

    const sourcePath = resolveModArchivePath(state, mod, gameId);
    if (sourcePath === undefined) {
      errors.push(
        `External mod "${mod.name}" (id="${modId}") is flagged for bundling ` +
          `but its source archive cannot be located on disk ` +
          `(archiveId="${mod.archiveId ?? "<unset>"}"). The archive may have ` +
          `been deleted from the Vortex downloads folder.`,
      );
      continue;
    }

    bundledArchives.push({
      sourcePath,
      sha256: mod.archiveSha256,
    });
  }

  return { bundledArchives, errors, warnings, droppedModIds };
}
