/**
 * "Did the files in this mod's staging folder change?" — answered by stat
 * alone, without reading a byte of content.
 *
 * ─── THE GAP ────────────────────────────────────────────────────────────────
 * The dashboard diff compares identity (added / removed / updated / toggled)
 * and installer answers (re-configured). None of those sees a curator editing
 * a staging folder by hand — deleting a mesh, dropping in a patched script,
 * hand-merging a config. For an EXTERNAL mod that is not even unusual: some
 * are the curator's own work, maintained in place over months.
 *
 * The exact answer is the mod's real identity — a hash of every staged file —
 * and that is gigabytes of reading, which the BUILD does and a view that opens
 * beside a button may not.
 *
 * ─── WHAT THIS IS INSTEAD ───────────────────────────────────────────────────
 * A hash over the sorted list of "path size" for every staged file. Both sides
 * produce it cheaply, from the same definition:
 *
 *   built side — for free, out of the manifest's own `stagingFiles`
 *   live side  — a directory walk, stat only, no file contents
 *
 * It catches a file added, a file deleted, a file renamed, and any edit that
 * changes a file's length. It does NOT catch an edit that preserves every
 * file's exact byte count — flipping a character in an INI, swapping two
 * same-sized textures. That is a real limit and it is stated wherever this
 * result is shown, because a check whose blind spot is undisclosed is worse
 * than no check at all.
 *
 * ─── VOLATILE FILES ARE EXCLUDED, AND THAT IS LOAD-BEARING ──────────────────
 * A script extender writes a log into a mod's folder every time the game runs.
 * Without excluding those, this would report most of the collection as changed
 * after a single play session — and a signal that fires constantly is one the
 * curator learns to ignore, which is worse than the gap it was closing. Same
 * exclusion the identity hash already uses, from the same module.
 */

import { createHash } from "crypto";

import { isVolatileFile } from "../volatileFiles";
import { toPosix } from "../paths";

/** One staged file, as either side describes it. */
type StagedLike = { path: string; size?: number };

/**
 * The shape of a set of staged files.
 *
 * Paths are POSIX-normalised, because the manifest carries "/" and a Windows
 * walk produces "\\", and comparing those raw would report every mod as
 * changed. Case is NOT folded: two files differing only by case are two files
 * on the ext4 under a Proton install, and an identity-shaped hash has no
 * business merging them (NS-4).
 */
export function stagingShapeOf(files: readonly StagedLike[]): string {
  const lines = files
    // Projected as OBJECTS before filtering. Filtering a list of paths and
    // then indexing `files` by position pairs each surviving path with a
    // different file's size the moment anything is excluded — and something
    // is excluded on every mod that has ever been played.
    .map((f) => ({ path: toPosix(f.path), size: f.size ?? -1 }))
    .filter((f) => !isVolatileFile(f.path))
    .map((f) => `${f.path} ${f.size}`)
    .sort();
  return createHash("sha256").update(lines.join("\n"), "utf8").digest("hex");
}

/** What comparing two shapes can conclude. */
export type ShapeVerdict = "same" | "differ" | "unknown";

/**
 * Compare a built shape against a live one.
 *
 * `undefined` on either side is `unknown`, never `same`. A staging folder that
 * could not be walked — the mod was uninstalled, the path is unreadable, the
 * package predates staging capture — is an absence, and reporting an absence
 * as a match is the confident zero this project keeps having to unlearn.
 */
export function compareShapes(
  built: string | undefined,
  live: string | undefined,
): ShapeVerdict {
  if (built === undefined || live === undefined) return "unknown";
  return built === live ? "same" : "differ";
}
