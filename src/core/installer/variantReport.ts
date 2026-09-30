/**
 * What to tell someone whose mod installed as a DIFFERENT installer option
 * than the curator's.
 *
 * Verification compares the installed bytes against the curator's staging. A
 * `variant-ambiguous` verdict means the files that differ sit at paths this
 * mod's archive can fill more than one way — a FOMOD with options — so nothing
 * is broken: the player simply has a different version of this mod than the
 * curator had.
 *
 * ── Why this is its own function ──
 * It used to be an inline template in the driver ending "reinstalling would
 * replay the curator's recorded answers, which may or may not change it."
 * That sentence hedges about something the driver KNOWS, and the two cases
 * want opposite advice:
 *
 *   answers recorded  — replaying them lands the curator's version, so a
 *                       reinstall is worth doing.
 *   nothing recorded  — there is nothing to replay (NS-8: an empty selection
 *                       is never guessed), so a reinstall lands this same
 *                       version again. Suggesting it spends an uninstall and
 *                       a re-extract on a foregone conclusion.
 *
 * ── The cause worth naming ──
 * An ATTENDED install shows the mod's own FOMOD dialog, which pre-ticks the
 * mod's defaults — and a curator's recorded answer is often to tick NOTHING in
 * some groups (per-variant toggles). Clicking through that dialog therefore
 * lands the mod's defaults rather than the curator's answer, and this report is
 * the first place anyone sees the difference.
 *
 * Measured on a tester's fresh install of two DynDOLOD tree-LOD mods: both
 * carry full recorded selections (5 and 3 steps) whose later groups are
 * deliberately empty, and 4 and 5 LOD meshes differed.
 */
export type VariantAmbiguousInput = {
  name: string;
  /** The differing paths. The first three are quoted as examples. */
  paths: readonly string[];
  /** Does the manifest carry an answer for this mod's installer? */
  recorded: boolean;
  /** Did the player answer the installer themselves this run? */
  attended: boolean;
};

export function describeVariantAmbiguous(input: VariantAmbiguousInput): string {
  const head =
    `"${input.name}" may be a different installer option than the curator's: ` +
    `${input.paths.length} file(s) differ at path(s) this mod's archive can ` +
    `fill more than one way (for example ${input.paths.slice(0, 3).join(", ")}). ` +
    `Nothing is damaged.`;

  if (!input.recorded) {
    return (
      `${head} Nothing was recorded for this mod's installer, so a reinstall ` +
      `would land this same version again — leave it unless the mod ` +
      `misbehaves in game.`
    );
  }

  const fix =
    `The curator's answers for this mod ARE recorded, so reinstalling it with ` +
    `the curator's answers applied automatically lands their version.`;

  return input.attended
    ? `${head} ${fix} You answered this mod's installer yourself — that is the ` +
        `likely difference: the dialog pre-ticks the mod's own defaults, and ` +
        `the curator left some of those boxes empty on purpose.`
    : `${head} ${fix}`;
}
