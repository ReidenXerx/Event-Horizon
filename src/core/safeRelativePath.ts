/**
 * Is a path from a `.ehcoll` safe to join onto a folder we own?
 *
 * ─── WHY THIS EXISTS ────────────────────────────────────────────────────────
 * A `.ehcoll` is a file a stranger hands you. Its manifest lists, per mod, the
 * relative paths of that mod's staged files — and the mirror pass takes those
 * strings and does `path.join(stagingRoot, ...path.split("/"))` to decide
 * where to write the bytes shipped alongside them.
 *
 * Nothing checked the string. A manifest carrying
 *
 *     "path": "../../../../plugins/evil/index.js"
 *
 * resolves out of the mod's staging folder, out of the game's mod folder, and
 * into Vortex's own extension directory — which Vortex loads on the next
 * start. The sha256 check on the shipped blob does not help: the author of a
 * hostile package writes both the bytes and the hash it must match, so all
 * that check guarantees is that their file arrives intact.
 *
 * The idiom was already in this codebase — `isInside` in `adoptLocalArchive`
 * does exactly this for a path the USER picked. It had simply never been
 * applied to the paths a STRANGER supplies.
 *
 * ─── WHY IT REJECTS AT THE PARSER ───────────────────────────────────────────
 * A traversing path is not a degraded package to warn about; it is a package
 * that cannot be what it claims. `.ehcoll` promises to reproduce a curator's
 * staging folder, and no staging folder contains an entry above itself. So
 * this is an ERROR at parse time, and the applier re-checks anyway — one
 * check that can be forgotten at a new call site is not a boundary.
 */

/**
 * True when `p` can be safely joined onto a directory we control.
 *
 * Manifest paths are POSIX-style by construction (the walker emits `/`), but
 * a hostile file is not obliged to honour that, so backslashes are treated as
 * separators too — otherwise `..\..\evil` passes a `/`-only check and is then
 * split by Windows into the very segments the check was looking for.
 */
export function isSafeRelativePath(p: string): boolean {
  if (p.length === 0) return false;

  // A drive letter or UNC prefix: `path.join` on Win32 leaves these embedded
  // rather than escaping, but they are never a legitimate staged path and
  // treating them as such invites a platform-specific surprise later.
  if (/^[A-Za-z]:/.test(p)) return false;

  // Leading separator — an absolute POSIX path, or a UNC share.
  if (p.startsWith("/") || p.startsWith("\\")) return false;

  // A NUL byte truncates the path at the syscall boundary on some platforms,
  // so a name that looks safe here can address something else entirely.
  if (p.includes("\0")) return false;

  for (const segment of p.split(/[\\/]/)) {
    // `..` escapes; `.` is harmless but means the path is not the canonical
    // spelling of anything the walker produced, so it is not one of ours.
    if (segment === ".." || segment === ".") return false;
  }

  return true;
}

/** Why `p` was rejected, for an error message. Empty when it is safe. */
export function unsafePathReason(p: string): string {
  if (p.length === 0) return "it is empty";
  if (/^[A-Za-z]:/.test(p)) return "it names a drive";
  if (p.startsWith("/") || p.startsWith("\\")) return "it is absolute";
  if (p.includes("\0")) return "it contains a NUL byte";
  for (const segment of p.split(/[\\/]/)) {
    if (segment === "..") return 'it contains a ".." segment';
    if (segment === ".") return 'it contains a "." segment';
  }
  return "";
}
