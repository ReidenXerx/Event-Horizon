/**
 * Which bundled mods get packed into the `.ehcoll`, and why the rest do not.
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
 *  - A bundled mod ships the files this build packed from its staging folder,
 *    and nothing else. One that was not packed is an error carrying the reason
 *    — never a fallback to its original archive, which would be the version
 *    from before the curator's edits AND an archive inside the package, which
 *    Nexus quarantines.
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
import { ehLog } from "../logging/ehLog";

import type { AuditorMod } from "../getModsListForProfile";
import type { RepackedBundle, RepackFailure } from "./bundleFromStaging";
import type { BundleSpec } from "./packageZip";
import type { CollectionConfig } from "./collectionConfig";

/** What this build packed from staging folders, and what it could not. */
export type PackedBundles = {
  bundles: readonly RepackedBundle[];
  /** modId → why that mod could not be packed. */
  failures: ReadonlyMap<string, RepackFailure>;
};

export type BundledArchiveResolution = {
  bundles: BundleSpec[];
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
  packed: PackedBundles,
): BundledArchiveResolution {
  const errors: string[] = [];
  const warnings: string[] = [];
  const droppedModIds: string[] = [];
  const bundles: BundleSpec[] = [];
  const modById = new Map(mods.map((m) => [m.id, m]));
  const packedByMod = new Map(packed.bundles.map((b) => [b.modId, b] as const));
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

    const bundle = packedByMod.get(modId);
    if (bundle !== undefined) {
      bundles.push({
        rootDir: bundle.rootDir,
        sha256: bundle.sha256,
        modName: mod.name,
      });
      continue;
    }

    const failure = packed.failures.get(modId);
    const reason = failure?.reason ?? "its files were not packed in this build";
    ehLog("error", "build.bundle.not-packed", { modId, name: mod.name, reason });
    errors.push(
      `"${mod.name}" (id="${modId}") is flagged for bundling, but ${reason}. ` +
        `A package carries a bundled mod's own files and never its archive, ` +
        `so nothing can ship for it: fix that and rebuild, or untick bundle.`,
    );
  }

  return { bundles, errors, warnings, droppedModIds };
}
