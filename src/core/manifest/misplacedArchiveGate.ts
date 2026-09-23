/**
 * ──────────────────────────────────────────────────────────────────────
 * An external archive that Vortex installs into the wrong folder refuses
 * the build.
 *
 * `vortexPlacement.ts` predicts where Vortex puts each file of a script-less
 * archive, and `detectExternalDrift` reports a mod whose staged files the
 * archive holds inside an extra folder Vortex will not strip. Such a mod is
 * not a curator's edit shipping as the original — it is the whole mod landing
 * where the game never reads, on every player's machine, while every check
 * that compares bytes calls it identical.
 *
 * ─── WHY THIS IS A REFUSAL AND NOT A WARNING ───────────────────────────
 * Meridia shipped seven versions (1.0.17 to 1.0.23) with its grass cache in
 * `Data\Grass_Cache_Default\Data\Grass\` for everyone. The install verified it
 * as missing, the repair re-installed the same archive into the same place,
 * and the players who noticed anything were told their install was wrong.
 * Nothing on the player's side can fix an archive; only the curator can, and
 * only before it ships. The owner's call, 2026-09-23: block the build.
 *
 * Exempt, as in `externalArchiveGate.ts`: a MEASURED bundle (the package
 * carries the staging folder's own layout) and a mod answered "mirror" (the
 * mirror pass writes the curator's files where they belong and removes what
 * the archive put elsewhere). A mod whose repack failed is refused by name
 * elsewhere, with the real reason.
 * ──────────────────────────────────────────────────────────────────────
 */

import type { MisplacedFiles } from "./bundleFromStaging";

/** One mod as this gate needs to see it. */
export type MisplacedArchiveMod = {
  id: string;
  name: string;
  misplaced: MisplacedFiles;
  /** MEASURED bundling, not the curator's tick. */
  bundled: boolean;
  /** The curator answered "mirror" for this mod. */
  mirrored: boolean;
};

export type MisplacedArchiveRefusal = {
  code: "external-misplaced";
  mods: readonly { id: string; name: string }[];
  message: string;
};

/** How many mods are described before the rest become a count. */
const NAMES_SHOWN = 5;

/** `undefined` means the build may proceed. Pure, so the rule is testable without a Vortex. */
export function misplacedArchiveRefusal(
  mods: readonly MisplacedArchiveMod[],
): MisplacedArchiveRefusal | undefined {
  const offenders = mods.filter((m) => !m.bundled && !m.mirrored);
  if (offenders.length === 0) return undefined;

  /**
   * One flowing paragraph: the message renders in the `<span>` above the Build
   * button, which has no `pre-line`, so a list would arrive as one run-on line.
   */
  const shown = offenders.slice(0, NAMES_SHOWN).map((m) => {
    const x = m.misplaced;
    return (
      `"${m.name}" (${x.count} file${x.count === 1 ? "" : "s"} inside ` +
      `"${x.under}", so players get ${x.example.installed} where you have ` +
      `${x.example.staged})`
    );
  });
  const rest = offenders.length - shown.length;
  const list = shown.join("; ") + (rest > 0 ? `; and ${rest} more` : "");
  const one = offenders.length === 1;
  const they = one ? "it" : "them";

  return {
    code: "external-misplaced",
    mods: offenders.map((m) => ({ id: m.id, name: m.name })),
    message:
      `${offenders.length} external mod${one ? "" : "s"} would install into ` +
      `a folder the game never reads, for every player but you: ${list}. ` +
      `Vortex removes a wrapper folder from an archive only when something ` +
      `inside it looks like game data to it — a plugin, or a folder such as ` +
      `textures, meshes or scripts — so these archives install exactly as ` +
      `they are packed. Any one of three things fixes ${they}: re-pack the ` +
      `archive with your staging folder's layout at its root, put it in ` +
      `Vortex's download folder over the old one, publish that same file ` +
      `where players download it, and build again; or answer "mirror" for ` +
      `the mod, so the package carries its files and writes them where they ` +
      `belong; or tick "Bundle", which carries the files and replaces the ` +
      `download entirely.`,
  };
}
