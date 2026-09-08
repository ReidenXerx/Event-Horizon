import * as crypto from "crypto";

import { isVolatileFile } from "../volatileFiles";
import { toPosix } from "../paths";

import type { EhcollStagingFile } from "../../types/ehcoll";

/**
 * Deterministic SHA-256 over a mod's staging file set — the manifest's
 * fallback identity oracle for external mods whose original archive
 * bytes are unavailable.
 *
 * The hash is identical iff two callers see *the same set of files
 * with the same content*, regardless of insertion order. The function
 * is pure (no I/O, no clocks) and stable across machines and OS:
 *
 *   - Files are sorted by `path` (POSIX-style, lexicographic) before
 *     digesting, so callers don't have to pre-sort.
 *   - Each file contributes exactly one canonical line:
 *
 *         <path>|<size>|<sha256>\n
 *
 *     where `<path>` is the POSIX-style relative path the curator
 *     captured, `<size>` is the byte count as a decimal integer, and
 *     `<sha256>` is the lowercase hex SHA-256 of the file contents.
 *
 * RETURN VALUE:
 *   - `string` (64 lowercase hex chars) when every input file has a
 *     `sha256` field. This is the only configuration the user-side
 *     resolver matches against; "fast" verification level captures
 *     `path + size` only and yields `undefined`.
 *   - `undefined` when:
 *       * `files.length === 0` (no staging snapshot — the curator
 *         opted out, or the mod has no files yet),
 *       * any file is missing `sha256` (partial capture due to I/O
 *         errors during walk; safer to refuse than to produce a
 *         hash that ignores some files).
 *
 * The "any file missing → undefined" rule is load-bearing: a
 * partial hash would silently match against unrelated mods that
 * happen to share the hashable subset, breaking the identity
 * promise the resolver relies on.
 *
 * VOLATILE FILES ARE EXCLUDED, AND THAT IS LOAD-BEARING:
 * A runtime log or a `Thumbs.db` changes on its own, so any set hash that
 * counted one could never match itself twice. This function is BOTH sides of
 * two different comparisons — the receipt's drift reference against a later
 * re-hash of the same folder, and a manifest's identity oracle against the
 * user's staging — so the exclusion has to live HERE, at the single point both
 * sides pass through, or one side filters and the other does not and every
 * comparison fails.
 *
 * The regression that proved it: excluding volatile files from VERIFICATION
 * (and only there) made seven previously-failing mods pass, and a receipt
 * records a drift reference only for mods that PASSED. So they went from
 * having no drift reference at all to having one computed over a file the game
 * rewrites on every launch — and the Doctor then offered to reinstall seven
 * healthy mods, permanently, since reinstalling cannot stop Skyrim writing a
 * log. Filtering in one place and not the other was worse than not filtering.
 *
 * WHY NOT MERKLE / TREE HASH:
 * Flat per-line digest is the right choice here. We don't need
 * proof-of-inclusion; we just need set equality. Sorted-line digest
 * is the simplest representation that's both order-insensitive and
 * cheap to verify by hand from a captured manifest snippet.
 *
 * @param files - Staging file entries. Modified copy is used internally;
 *                input array is not mutated.
 * @returns Lowercase hex SHA-256, or `undefined` when the input is
 *          unfit for a stable hash (see above).
 */
export function computeStagingSetHash(
  files: readonly EhcollStagingFile[],
): string | undefined {
  // Before the emptiness check, not after: a mod whose ONLY staged file is a
  // log has no stable set to hash, and `undefined` is the honest answer rather
  // than a hash of nothing.
  const stable = files.filter((f) => !isVolatileFile(f.path));

  if (stable.length === 0) {
    return undefined;
  }
  for (const f of stable) {
    if (typeof f.sha256 !== "string" || f.sha256.length !== 64) {
      return undefined;
    }
  }

  /**
   * ─── SEPARATORS NORMALISED, CASE DELIBERATELY NOT ───────────────────────
   * This digest is compared ACROSS MACHINES — the curator's hash from
   * `buildManifest` against the user's from `enrichStagingSetHashes` — so
   * anything that can differ between two machines for the same content has to
   * be normalised out, or the resolver fails to identify a mod that really is
   * the curator's.
   *
   * Separators are exactly that: a Windows walk produces `\` and the manifest
   * carries `/`. Both walkers go through the path service now, so this is a
   * no-op today; it is here so the digest does not silently depend on that
   * staying true.
   *
   * CASE is a different question, and folding it would be WRONG. On ext4 under
   * Proton `Scripts/a.pex` and `scripts/a.pex` are two files that can both
   * exist with different content, and an identity oracle that merges them
   * invents a collision — the same defect that was in `deriveId`. Identity is
   * about what the bytes ARE (NS-4), and two different files are two different
   * files. A curator and a user who disagree about case genuinely have
   * different staging sets, and the honest answer is "not identified" rather
   * than a wrong match.
   */
  const keyed = stable.map((f) => ({ ...f, key: toPosix(f.path) }));
  const sorted = keyed.sort((a, b) =>
    a.key < b.key ? -1 : a.key > b.key ? 1 : 0,
  );

  const hasher = crypto.createHash("sha256");
  for (const f of sorted) {
    hasher.update(`${f.key}|${f.size}|${f.sha256!}\n`);
  }
  return hasher.digest("hex");
}
