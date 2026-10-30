/**
 * Is each mirrored mod laid out the way the curator's is?
 *
 * A mirrored mod's install is two steps: Vortex installs the archive, then the
 * mirror moves it into the curator's layout. When the second step does not
 * happen (an Event Horizon older than the package, the mod's archive gone) the
 * player keeps the archive's own layout with nothing on the receipt to compare
 * against: a mirrored mod earns no drift reference unless the mirror proved
 * itself. Ivy 1.0.56, .frenchkiwi, 2026-10-30: "Collection of textures and
 * presets" kept Data/Textures/actors/... and 15 preset plugins instead of the
 * curator's Textures/CoTaP/..., and nothing in Doctor said so.
 *
 * So this asks the cheap half of the question from the package: does every
 * file the curator recorded exist at its path? Names only, no hashing. A
 * missing file is the finding; extra files are not judged here (a player's
 * BodySlide output is extra too).
 *
 * Only mods Event Horizon installed. An adopted mod is the player's, and the
 * mirror never rewrites it (NS-2), so a finding there would offer a repair
 * that cannot run.
 */
import type { EhcollMod } from "../../types/ehcoll";
import { judgeSkipSet, skipsVerification } from "../volatileFiles";

export type MirrorLayoutTarget = {
  compareKey: string;
  name: string;
  vortexModId: string;
  /** The curator's recorded paths the player's folder must hold. */
  wanted: string[];
};

export type MirrorLayoutFinding = {
  compareKey: string;
  name: string;
  missing: number;
  of: number;
  examples: string[];
};

export type MirrorLayoutResult =
  | { kind: "not-checked"; why: string }
  | { kind: "checked"; judged: number; skipped: number; findings: MirrorLayoutFinding[] };

/** The mirrored mods of the package that the receipt says Event Horizon installed. */
export function mirrorLayoutTargets(
  manifestMods: readonly EhcollMod[],
  receiptMods: ReadonlyArray<{ compareKey: string; vortexModId: string; name: string; ownership?: string }>,
): MirrorLayoutTarget[] {
  const byKey = new Map(receiptMods.map((m) => [m.compareKey, m]));
  const out: MirrorLayoutTarget[] = [];
  for (const mod of manifestMods) {
    if (mod.state?.mirrored !== true) continue;
    const ours = byKey.get(mod.compareKey);
    if (ours === undefined || ours.ownership === "adopted") continue;
    const skip = judgeSkipSet(mod.state);
    const wanted = (mod.state.stagingFiles ?? [])
      // Held for plugins the player may not have: absent is correct there.
      .filter((f) => f.installerCondition === undefined)
      .map((f) => f.path)
      .filter((p) => !skipsVerification(p, skip));
    if (wanted.length === 0) continue;
    out.push({ compareKey: mod.compareKey, name: ours.name, vortexModId: ours.vortexModId, wanted });
  }
  return out;
}

const norm = (p: string): string => p.replace(/\\/g, "/").toLowerCase();

/** Which of `wanted` the folder listing lacks. Case-insensitive: the lenient direction. */
export function missingFromListing(wanted: readonly string[], present: Iterable<string>): string[] {
  const have = new Set<string>();
  for (const p of present) have.add(norm(p));
  return wanted.filter((p) => !have.has(norm(p)));
}

/**
 * Walk each target's staging folder and report the ones missing curator files.
 *
 * A folder that cannot be found or read in full is skipped, never reported:
 * "we could not look" is not "the files are gone", and a missing mod has its
 * own check.
 */
export async function checkMirrorLayout(args: {
  targets: readonly MirrorLayoutTarget[];
  stagingRootFor: (vortexModId: string) => string | undefined;
  /** Relative paths under `root`, or undefined when the listing is incomplete or the folder is gone. */
  list: (root: string) => Promise<string[] | undefined>;
}): Promise<MirrorLayoutResult> {
  if (args.targets.length === 0) return { kind: "checked", judged: 0, skipped: 0, findings: [] };
  const findings: MirrorLayoutFinding[] = [];
  let judged = 0;
  let skipped = 0;
  for (const t of args.targets) {
    const root = args.stagingRootFor(t.vortexModId);
    const listing = root === undefined ? undefined : await args.list(root).catch(() => undefined);
    if (listing === undefined || listing.length === 0) {
      skipped += 1;
      continue;
    }
    judged += 1;
    const missing = missingFromListing(t.wanted, listing);
    if (missing.length > 0) {
      findings.push({ compareKey: t.compareKey, name: t.name, missing: missing.length, of: t.wanted.length, examples: missing.slice(0, 3) });
    }
  }
  return { kind: "checked", judged, skipped, findings };
}
