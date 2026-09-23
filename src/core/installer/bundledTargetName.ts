/**
 * ──────────────────────────────────────────────────────────────────────
 * The name a BUNDLED mod installs under.
 *
 * A bundled mod's archive is written as `<curator's mod name>.zip`, and Vortex
 * names the mod after the file. That is load-bearing: a resumed install finds
 * the mod again by that name (`enrichStagingSetHashes.ts`). It holds until the
 * pool already has a DIFFERENT mod under the same name — the previous
 * revision's copy of a curator mod that changed, or a player's own mod the
 * curator repacked. Vortex then stops the install to ask "already installed —
 * replace, or install as a variant?", one modal per mod, which an Event
 * Horizon run cannot pre-answer.
 *
 * Measured 2026-09-23: a player's update from Meridia 1.0.20 to 1.0.23 stopped
 * at mod 1,106 of 1,746 (`Pandora_sd`) and waited three hours for an answer
 * nobody saw. Vortex was closed, the new profile stayed half-built, and the
 * game came up without an Address Library. Three more mods of that revision
 * would have asked the same question.
 *
 * Answering "Replace" is not the fix either. Vortex replaces the mod on EVERY
 * profile, and a new revision builds into its own profile precisely so the one
 * being played stays intact until the new one works — and a player's own mod
 * is never ours to overwrite (NS-2). So the curator's copy goes in BESIDE the
 * other one, under the per-release name a mirrored mod already gets.
 * ──────────────────────────────────────────────────────────────────────
 */

import { alongsideInstallName } from "./installAlongside";
import { bundledArchiveFileName } from "./modInstall";

export function bundledTargetName(args: {
  /** The curator's mod name — what the mod is called when nothing is in the way. */
  modName: string;
  /** The bundle's sha256, which names the file when the mod name has nothing usable. */
  sha256: string | undefined;
  /** Is a mod with this Vortex id already in the game's pool? */
  isTaken: (vortexModId: string) => boolean;
  collectionName: string;
  collectionVersion: string;
  packageId: string;
  compareKey: string;
}): string {
  // The id Vortex would derive: the sanitised file name without its extension.
  const file = bundledArchiveFileName(args.sha256 ?? "", args.modName);
  const plainId = file.slice(0, file.length - ".zip".length);
  if (!args.isTaken(plainId)) return args.modName;
  return alongsideInstallName({
    modName: args.modName,
    collectionName: args.collectionName,
    collectionVersion: args.collectionVersion,
    packageId: args.packageId,
    compareKey: args.compareKey,
  });
}
