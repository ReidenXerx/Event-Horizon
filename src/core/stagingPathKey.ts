/**
 * Comparing two staging paths for identity.
 *
 * ─── WHY A KEY AND NOT THE PATH ─────────────────────────────────────────────
 * These are Windows paths on a case-INSENSITIVE filesystem, produced by two
 * different machines and two different extractions of the same archive. The
 * curator's manifest may record `scripts/Foo.pex` while the user's copy of the
 * identical file lands as `Scripts/Foo.pex`; a FOMOD, a 7-Zip version, or a
 * mod author's own folder casing is enough to change it. The bytes are the
 * same, the file is the same, and the Creation Engine — which is itself
 * case-insensitive — loads them identically.
 *
 * ─── THE COST OF GETTING THIS WRONG, MEASURED ───────────────────────────────
 * Verification compared paths verbatim while the mirror pass, in the same
 * install, compared them through a key. On a real 1,755-mod run that produced
 * eight "could not be reproduced" reports, of which FOUR were nothing but
 * case, and the tell is unmistakable — the missing and extra counts matched
 * exactly every time:
 *
 *     missing 30 / extra 30   scripts/… vs Scripts/…
 *     missing  1 / extra  1   …/00000D70.nif vs …/00000d70.nif
 *     missing 16 / extra 16   …/Male/… vs …/male/…
 *     missing 28 / extra 28   …/smallroomsecond/… vs …/SmallRoomSecond/…
 *
 * Each one told the user their mod was broken, invited them to paste a report
 * to the curator about a file that was present and correct, and counted toward
 * the reinstall signal. The other four reports in that run were genuine —
 * missing files with no matching extras — which is exactly the distinction
 * this key restores.
 *
 * Separators are normalised for the same reason: the manifest carries POSIX
 * `/` from the walker, a Windows walk produces `\`, and neither is a fact
 * about the file.
 */

/**
 * The identity of a staged path, for comparison only.
 *
 * NEVER use the result as a path — it is lowercased and cannot address a file
 * on a case-sensitive filesystem. Report and write the ORIGINAL string; use
 * this solely to decide whether two of them are the same file.
 */
export function stagingPathKey(p: string): string {
  return p.replace(/\\/g, "/").toLowerCase();
}
