/**
 * Everything this project does to a mod-relative path, in one place.
 *
 * ─── WHY A SERVICE AND NOT SIX PRIVATE COPIES ───────────────────────────────
 * Before this existed the codebase carried, independently: six copies of
 * `p.replace(/\\/g, "/")`, two ways of taking a basename (`split(/[\\/]/).pop()`
 * and `lastIndexOf("/")`), and three comparison keys that each lowercased on
 * their own terms. They did not agree, and the disagreement shipped: the
 * mirror pass keyed by lowercased path from the day it was written while
 * verification compared verbatim, so a real install reported four healthy mods
 * as broken because a FOMOD had written `Scripts/` where the curator recorded
 * `scripts/`.
 *
 * ─── AND WHY CASE IS NOT A CONSTANT ─────────────────────────────────────────
 * The fix for that was to fold case — which is correct on NTFS and WRONG
 * everywhere else. Vortex runs under Proton for a growing number of people,
 * and on ext4 `Scripts/a.pex` and `scripts/a.pex` are two different files that
 * can both exist in one folder. Folding them together there would let
 * verification pass on a file that is not the one the curator shipped, and
 * would let the mirror pass delete the wrong one — turning a cosmetic fix into
 * data loss on the platform it was never tested on.
 *
 * So case folding is a property OF THE FILESYSTEM, probed rather than assumed
 * (see `caseSensitivity.ts`), and every comparison here takes it as an
 * argument. Separator normalisation is unconditional: `\` versus `/` is never
 * a fact about a file on any platform this runs on.
 */

import * as nodePath from "path";

/** How the filesystem holding a staging folder treats letter case. */
export type CaseMode =
  /** NTFS, and a Wine prefix over it. `A.esp` and `a.esp` are one file. */
  | "insensitive"
  /** ext4, btrfs, xfs — a Proton install on Linux. They are two files. */
  | "sensitive";

/**
 * Separators only. Never touches case.
 *
 * The manifest carries POSIX `/` because that is what the walker emits; a
 * Windows walk produces `\`. Neither is a fact about the file, and every
 * comparison in this project starts by agreeing on one.
 */
export function toPosix(p: string): string {
  return p.replace(/\\/g, "/");
}

/** The path's segments, split on either separator. Empty segments dropped. */
export function segmentsOf(p: string): string[] {
  return toPosix(p)
    .split("/")
    .filter((s) => s.length > 0);
}

/** The last segment, or `""` for a path that has none. */
export function basenameOf(p: string): string {
  const segments = segmentsOf(p);
  return segments[segments.length - 1] ?? "";
}

/**
 * The directory part, POSIX-style, or `""` at the root.
 *
 * Replaces two different inline idioms that disagreed on a path with no
 * separator: one returned the whole string, the other an empty one.
 */
export function dirnameOf(p: string): string {
  const posix = toPosix(p);
  const cut = posix.lastIndexOf("/");
  return cut < 0 ? "" : posix.slice(0, cut);
}

/**
 * The extension INCLUDING the dot, lowercased, or `""`.
 *
 * A leading dot is not an extension — `.gitignore` is a name — which is the
 * case a `lastIndexOf(".")` gets wrong.
 */
export function extensionOf(p: string): string {
  const name = basenameOf(p);
  const cut = name.lastIndexOf(".");
  return cut > 0 ? name.slice(cut).toLowerCase() : "";
}

/**
 * The identity of a path, for comparison only.
 *
 * NEVER use the result as a path: under `insensitive` it is lowercased and
 * cannot address a file on a case-sensitive filesystem. Report and write the
 * ORIGINAL string; use this solely to decide whether two of them are the same
 * file.
 */
export function pathKey(p: string, mode: CaseMode): string {
  const posix = toPosix(p);
  return mode === "insensitive" ? posix.toLowerCase() : posix;
}

/** Are these two paths the same file on a filesystem of this kind? */
export function samePath(a: string, b: string, mode: CaseMode): boolean {
  return pathKey(a, mode) === pathKey(b, mode);
}

/**
 * A basename key, for the one comparison that is about the NAME rather than
 * the path — "does this archive hold two different files called foo.dds".
 */
export function basenameKey(p: string, mode: CaseMode): string {
  const name = basenameOf(p);
  return mode === "insensitive" ? name.toLowerCase() : name;
}

// ===========================================================================
// Containment
// ===========================================================================

/**
 * Is `p` safe to join onto a directory we control?
 *
 * A `.ehcoll` is a file a stranger hands you, and its staging paths are joined
 * onto a folder we own so the mirror pass can write into it. A path of
 * `../../../../plugins/evil/index.js` resolves out of the mod folder and into
 * Vortex's own extension directory, which Vortex loads on the next start.
 *
 * Backslashes count as separators here whatever the platform: a hostile file
 * is not obliged to use `/`, and a POSIX-only check passes `..\..\evil` which
 * Windows then splits into the very segments the check was looking for.
 */
export function isSafeRelativePath(p: string): boolean {
  return unsafePathReason(p) === "";
}

/** Why `p` was rejected, for an error message. `""` when it is safe. */
export function unsafePathReason(p: string): string {
  if (p.length === 0) return "it is empty";
  if (/^[A-Za-z]:/.test(p)) return "it names a drive";
  if (p.startsWith("/") || p.startsWith("\\")) return "it is absolute";
  // A NUL truncates the path at the syscall boundary on some platforms, so a
  // name that looks safe here can address something else entirely.
  if (p.includes("\0")) return "it contains a NUL byte";
  for (const segment of toPosix(p).split("/")) {
    if (segment === "..") return 'it contains a ".." segment';
    if (segment === ".") return 'it contains a "." segment';
  }
  return "";
}

/**
 * Is `child` inside `parent`?
 *
 * For an ABSOLUTE path the caller already holds — a picked archive against
 * Vortex's download folder — where the question is containment on this
 * machine's filesystem, not identity between two recorded strings.
 *
 * The case mode matters here for the same reason it does everywhere else:
 * `C:\Downloads` and `c:\downloads` are one directory, and
 * `/home/u/Downloads` and `/home/u/downloads` are two. This lived in
 * `adoptLocalArchive` with an unconditional `.toLowerCase()`, which answers
 * the Windows question correctly and the Proton one wrongly.
 */
export function isInside(
  parent: string,
  child: string,
  mode: CaseMode,
  /** Injected so this stays pure and testable; defaults to node's `path`. */
  ops: {
    resolve: (p: string) => string;
    relative: (from: string, to: string) => string;
    isAbsolute: (p: string) => boolean;
  } = nodePath,
): boolean {
  const fold = (p: string): string =>
    mode === "insensitive" ? p.toLowerCase() : p;
  const rel = ops.relative(fold(ops.resolve(parent)), fold(ops.resolve(child)));
  return rel.length > 0 && !rel.startsWith("..") && !ops.isAbsolute(rel);
}
