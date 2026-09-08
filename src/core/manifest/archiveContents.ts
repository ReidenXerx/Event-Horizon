/**
 * Archive content listing — what an archive SAYS it contains, without
 * extracting it.
 *
 * ─── WHY THIS EXISTS ──────────────────────────────────────────────────
 * `captureStagingFiles` records the curator's staging folder *after* Vortex
 * extracted and the FOMOD resolved. That makes the CURATOR'S DISK the
 * reference for verification — and Vortex's "lost files" bug, the very thing
 * verification exists to catch, can corrupt that reference. A curator whose
 * own install silently dropped files ships those omissions as the etalon, and
 * the user who installs correctly is then told they are wrong.
 *
 * An archive listing is a second, independent reference: it comes from the
 * archive itself and no one's extraction. 7-Zip reports per-entry size and
 * CRC32 straight from the archive header, so this costs a header read rather
 * than a decompress.
 *
 * Measured on a real 939-mod Fallout 4 profile (60-archive sample across
 * .zip/.7z/.rar): 100% of file entries carried a CRC, at ~0.02s per archive —
 * about 24 seconds for the whole profile, against 19.1 minutes for the
 * SHA-256 archive pass. Cheap enough to run on every build.
 *
 * ─── WHAT CRC32 IS AND IS NOT ─────────────────────────────────────────
 * CRC32 detects corruption and truncation. It is NOT collision-resistant and
 * carries no integrity guarantee against a deliberately crafted file. That is
 * fine here: identity is already established by the archive-level SHA-256
 * (`archiveSha256`). CRC32's job is only "are these bytes intact", and it is
 * the strongest per-entry signal obtainable without decompressing.
 * ──────────────────────────────────────────────────────────────────────
 */

import * as path from "path";

import { toPosix } from "../paths";

import { sevenZipList } from "./sevenZip";
import type { SevenZipApi, SevenZipListEntry } from "./sevenZip";

/** One file inside an archive, as the archive header describes it. */
export type ArchiveEntry = {
  /** POSIX-style path inside the archive, as listed. */
  path: string;
  /** Uncompressed size in bytes. `undefined` when 7z did not report one. */
  size?: number;
  /**
   * Lowercase hex CRC32 (8 chars), when the archive stores one.
   *
   * Absent for directory entries, and legitimately absent for some entries in
   * some formats. Callers MUST treat absence as "cannot verify this entry",
   * never as "mismatch".
   */
  crc?: string;
};

export type ArchiveListing = {
  /** File entries only — directories are dropped. */
  entries: ArchiveEntry[];
  /** Count of entries carrying a usable CRC. */
  withCrc: number;
  /**
   * `withCrc / entries.length`, or 1 for an empty archive.
   *
   * Surface this rather than assuming: an archive whose entries have no CRC
   * can only be verified by size, and the user deserves to know which of those
   * they got.
   */
  crcCoverage: number;
};

export type ListArchiveContentsOptions = {
  /** Abort a long listing (huge solid archives on slow disks). */
  signal?: AbortSignal;
};

/**
 * True when a listed entry is a directory rather than a file.
 *
 * 7z marks directories two ways depending on format and version: `Folder = +`
 * (surfaced by node-7z as `attr`/`folder`) or a `D` in the DOS attribute
 * string. Checking both avoids counting directories as unverifiable files,
 * which would silently depress crcCoverage.
 */
function isDirectoryEntry(entry: SevenZipListEntry): boolean {
  const attr = entry.attr ?? "";
  // `D` is the DOS directory flag and it is NOT necessarily first. Measured on
  // a real .7z: directories come back as `"RD"` (read-only + directory), which
  // a `startsWith("D")` test misses — so all 15 directory entries in that
  // archive were listed as files. Downstream they became "expected files" that
  // can never exist in staging, and the self-check reported them as MISSING.
  // A false "missing" is the worst output this area can produce, so match the
  // flag wherever it sits. No regular file carries `D` in its attributes.
  if (attr.includes("D")) return true;
  // node-7z surfaces the `Folder = +` column on some versions.
  if (entry.folder === "+") return true;
  // Belt and braces: 7z emits trailing separators for some directory entries.
  return entry.name.endsWith("/") || entry.name.endsWith("\\");
}

/** Normalise an archive-internal path for stable comparison across platforms. */
export function normalizeArchivePath(p: string): string {
  return toPosix(p).replace(/^\.\//, "").trim();
}

/**
 * Read a CRC off a listing entry.
 *
 * node-7z's field naming is not guaranteed across versions, and the archive
 * itself may omit one, so every shape is probed and anything unusable becomes
 * `undefined` rather than a bogus value. A wrong CRC is far worse than a
 * missing one: missing degrades to a size check, wrong invents a mismatch.
 */
function readCrc(entry: SevenZipListEntry): string | undefined {
  const raw = (entry as unknown as { crc?: unknown; CRC?: unknown }).crc
    ?? (entry as unknown as { CRC?: unknown }).CRC;
  if (typeof raw !== "string" && typeof raw !== "number") return undefined;
  // A NUMBER is the raw CRC value and must be rendered in hex. Stringifying it
  // decimally would produce a plausible-looking 8-char value that is simply
  // wrong — and a wrong CRC manufactures a mismatch, which is the worst
  // outcome this module can produce. A string is already hex as 7z prints it.
  if (typeof raw === "number") {
    if (!Number.isInteger(raw) || raw < 0 || raw > 0xffffffff) return undefined;
    return raw.toString(16).padStart(8, "0");
  }
  const hex = raw.trim().toLowerCase();
  if (!/^[0-9a-f]{1,8}$/.test(hex)) return undefined;
  // 7z prints CRCs unpadded; pad so string comparison is safe.
  return hex.padStart(8, "0");
}

/**
 * List an archive's file entries.
 *
 * Rejects when the archive cannot be read at all — a listing that failed is
 * NOT an empty archive, and callers must be able to tell those apart. Per-mod
 * tolerance belongs to the caller, the same way `enrichModsWithArchiveHashes`
 * treats a failed hash as "no hash" rather than aborting the batch.
 */
export async function listArchiveContents(
  sevenZip: SevenZipApi,
  archivePath: string,
  opts?: ListArchiveContentsOptions,
): Promise<ArchiveListing> {
  const abortIfCancelled = (): void => {
    if (opts?.signal?.aborted === true) {
      throw new Error(`Listing aborted: ${path.basename(archivePath)}`);
    }
  };

  // A listing is a single fast 7z header read (~24ms on a real mod archive),
  // so it is checkpointed either side rather than interrupted mid-flight —
  // node-7z's `list` forwards no cancellation hook to its parser.
  abortIfCancelled();
  const listed = await sevenZipList(sevenZip, archivePath);
  abortIfCancelled();

  const entries: ArchiveEntry[] = [];
  for (const entry of listed) {
    if (isDirectoryEntry(entry)) continue;
    const crc = readCrc(entry);
    entries.push({
      path: normalizeArchivePath(entry.name),
      ...(typeof entry.size === "number" ? { size: entry.size } : {}),
      ...(crc !== undefined ? { crc } : {}),
    });
  }

  const withCrc = entries.filter((e) => e.crc !== undefined).length;
  return {
    entries,
    withCrc,
    crcCoverage: entries.length === 0 ? 1 : withCrc / entries.length,
  };
}

/**
 * Index a listing by `size:crc` so staged files can be matched by CONTENT
 * rather than by path.
 *
 * Path-independence is the whole point: a FOMOD renames and relocates what it
 * installs (`<file source destination>`), so a staged file's path frequently
 * has no counterpart in the archive. Its bytes do.
 *
 * Entries without a CRC are indexed under size alone, so they can still be
 * matched weakly instead of being dropped.
 */
export function indexByContent(listing: ArchiveListing): Map<string, ArchiveEntry[]> {
  const index = new Map<string, ArchiveEntry[]>();
  for (const entry of listing.entries) {
    const key = contentKey(entry.size, entry.crc);
    const bucket = index.get(key);
    if (bucket === undefined) index.set(key, [entry]);
    else bucket.push(entry);
  }
  return index;
}

/** Key used by {@link indexByContent}. `undefined` parts collapse to `?`. */
export function contentKey(size: number | undefined, crc: string | undefined): string {
  return `${size ?? "?"}:${crc ?? "?"}`;
}
