/**
 * Files a tool or the game left in a mod's staging folder, which a build
 * leaves out of the package instead of asking about.
 *
 * ─── WHY ───────────────────────────────────────────────────────────────────
 * Owner, 2026-10-03: "we shouldnt ship also generated text files by different
 * plugins bc its constant divergence and its useless mirror them". The case
 * that prompted it: Ivy 1.0.37 recorded `porcOverlays_en.txt.bak`, written by
 * a tool into PorcOverlays' staging. No archive can produce it, so a plain
 * install never has it, and two players were told the mod "could not be
 * reproduced".
 *
 * ─── WHY ONLY THIS NARROW ──────────────────────────────────────────────────
 * Polled the same day: "junk only". A `.bak` or `.tmp` is left out only when
 * the mod's archive has no file of that name anywhere. Two rules hold it there:
 *
 *  - `.bak` is real content when a mod author ships it — `volatileFiles.ts`
 *    measured 18 in one capture (`00000D63.NIF.bak`, `settings.ini.bak`), all
 *    from archives. The archive check is what tells the two apart; it is by
 *    basename because FOMOD installers relocate files.
 *  - "Anything the archive did not produce" would also drop BodySlide output,
 *    LOD and xEdit patches kept inside a mod's folder, which nobody installing
 *    the collection can regenerate (NS-7). Those still go to the curator's
 *    per-mod question.
 *
 * `.log` is not here: `volatileFiles.ts` already excludes it everywhere, with
 * no archive needed. Edited copies of files the archive DOES ship are not here
 * either; they stay a per-mod question (polled: "ask per mod").
 *
 * Used on both sides, like `volatileFiles.ts`: the BUILD leaves these out of
 * new packages, and the INSTALL excuses them when an older package recorded
 * one, so packages already in players' hands stop reporting them.
 */

import type { ArchiveListing } from "./archiveContents";
import { basenameKey } from "../paths";

/** Extensions only a tool or the game writes into a mod's folder. Lowercase. */
const GENERATED_EXTENSIONS = [".bak", ".tmp"] as const;

/** True when the name alone says a tool wrote it. Says nothing about the archive. */
export function hasGeneratedName(relPath: string): boolean {
  const name = relPath.replace(/\\/g, "/").split("/").pop()!.toLowerCase();
  return GENERATED_EXTENSIONS.some((ext) => name.endsWith(ext) && name.length > ext.length);
}

/**
 * The staged paths a tool wrote: a generated name, and no file of that name
 * anywhere in the archive.
 *
 * Basenames are folded on purpose. Folding can only make the archive's set
 * bigger, so it can only KEEP a file that might be the author's; it can never
 * leave out one the archive ships.
 */
export function findGeneratedFiles(
  stagedPaths: readonly string[],
  listing: ArchiveListing,
): string[] {
  const candidates = stagedPaths.filter(hasGeneratedName);
  if (candidates.length === 0) return [];
  const archiveNames = new Set(listing.entries.map((e) => basenameKey(e.path, "insensitive")));
  return candidates.filter((p) => !archiveNames.has(basenameKey(p, "insensitive")));
}
