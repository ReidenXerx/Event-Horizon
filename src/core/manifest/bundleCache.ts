/**
 * ──────────────────────────────────────────────────────────────────────
 * Don't measure the same bundle twice.
 *
 * A bundled mod's identity is the sha256 of the canonical zip its files make
 * (bundleZip.ts), and working that out reads every byte of the mod's staging
 * folder. DynDOLOD output is commonly several gigabytes and almost never
 * changes between two builds of the same collection, so a curator publishing
 * v1.0.8 after v1.0.7 would pay minutes to learn a hash they already had.
 *
 * ─── THE KEY IS THE CONTENT, NOT THE MOD ───────────────────────────────
 * The key is `computeStagingSetHash`: the same set of files with the same
 * contents, in any order, on any machine. The canonical zip is made of
 * exactly that — paths and bytes, nothing else — so a record found under a
 * key describes those files and no others.
 *
 * That function returns `undefined` when any staged file lacks a sha256, and
 * that is exactly the case where reuse would be a guess. No key, no record.
 *
 * ─── A RECORD IS TRUSTED FOR TIME, NEVER FOR CORRECTNESS ───────────────
 * Packaging hashes the files it actually stages and refuses a bundle that
 * disagrees with the identity it was given, so the worst a wrong record can do
 * is stop a build with an error that names the mod. A record written under a
 * different bundle format is not used at all: the same files would make a
 * different zip.
 *
 * ─── WHAT THIS FOLDER USED TO HOLD ─────────────────────────────────────
 * Until bundles shipped loose, each bundled mod had a 7-Zip archive here —
 * gigabytes, for a LOD mod — plus a sidecar. Nothing reads them now, and the
 * build deletes them.
 * ──────────────────────────────────────────────────────────────────────
 */

import * as path from "path";

/** What a bundle turned out to be, the last time exactly these files were measured. */
export type CachedBundle = {
  /** The bundle format the measurement was taken under — `BUNDLE_ZIP_FORMAT`. */
  format: number;
  /** sha256 of the canonical bundle zip. The mod's identity. */
  sha256: string;
  bytes: number;
  files: number;
};

/** Keep a mod id usable as a filename without inventing collisions. */
export function sanitizeModId(id: string): string {
  return id.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 120);
}

/**
 * The record's name, carrying both the mod and the content it describes.
 *
 * The mod id is in there so a stale record can be found and dropped without
 * reading anything; the key is what makes reuse correct.
 */
export function bundleRecordName(modId: string, contentKey: string): string {
  return `${sanitizeModId(modId)}-${contentKey}.bundle.json`;
}

/**
 * Does this file belong to this mod's records?
 *
 * Matches on the mod segment only, so a mod whose id is a prefix of another's
 * cannot claim its records — the separator has to be there.
 */
export function isBundleRecordOfMod(fileName: string, modId: string): boolean {
  const prefix = `${sanitizeModId(modId)}-`;
  if (!fileName.startsWith(prefix)) return false;
  return /^[0-9a-f]{64}\.bundle\.json$/.test(fileName.slice(prefix.length));
}

/**
 * Records of this mod that are NOT the one just used.
 *
 * One record per bundled mod. Sweeping happens after the build has what it
 * needs, so a failure never destroys the record that would have made the retry
 * fast.
 */
export function staleBundleRecordsFor(args: {
  fileNames: readonly string[];
  modId: string;
  keep: string;
}): string[] {
  const keep = path.basename(args.keep);
  return args.fileNames
    .filter((f) => isBundleRecordOfMod(f, args.modId) && f !== keep)
    .sort();
}

/**
 * An archive, or its sidecar, from before bundles shipped loose:
 * `<mod>-<64 hex>.zip`, `<mod>-<64 hex>.zip.json`, or `<mod>-uncacheable.zip`.
 */
export function isLegacyBundleArchive(fileName: string): boolean {
  return /-(?:[0-9a-f]{64}|uncacheable)\.zip(?:\.json)?$/.test(fileName);
}

/**
 * Is this a complete record, taken under this bundle format?
 *
 * Anything else — a half-written file, a hand edit, a record from another
 * format — answers no, and costs a re-read rather than a guess.
 */
export function recordMatches(record: unknown, format: number): record is CachedBundle {
  if (typeof record !== "object" || record === null) return false;
  const r = record as Partial<Record<keyof CachedBundle, unknown>>;
  return (
    r.format === format &&
    typeof r.sha256 === "string" &&
    /^[0-9a-f]{64}$/.test(r.sha256) &&
    Number.isSafeInteger(r.bytes) &&
    (r.bytes as number) >= 0 &&
    Number.isSafeInteger(r.files) &&
    (r.files as number) >= 0
  );
}
