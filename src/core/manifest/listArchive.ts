/**
 * ──────────────────────────────────────────────────────────────────────
 * List an archive: natively when it is a ZIP, through 7z otherwise.
 *
 * ─── WHY THE ORDER MATTERS ─────────────────────────────────────────────
 * Every read of an archive header used to go through 7z, which meant that on
 * a Wine prefix where 7z will not start — the platform this whole
 * investigation began on — nothing could be listed at all. The features built
 * on listings then degraded to their fallback answers: "undecidable", which
 * reinstalls, and "cannot compare", which blames the wrong party. They failed
 * silently and precisely where they were needed most.
 *
 * A large share of mod archives are ZIPs and we own a reader for those, so the
 * native route is tried first. The CRCs it reports come from the same central
 * directory 7z reads, so this is a cheaper path to the identical answer rather
 * than a weaker one.
 *
 * ─── DETECTION IS BY CONTENT, NOT EXTENSION ────────────────────────────
 * A mod archive named `.zip` is sometimes a RAR, and a `.7z` is occasionally a
 * ZIP. The native reader either parses a central directory or it does not, and
 * that answer is worth more than the filename's opinion.
 *
 * ─── UNREADABLE IS A RESULT, NOT AN ERROR ──────────────────────────────
 * Callers use this while explaining some other failure, so it reports why it
 * could not read rather than throwing into the middle of a diagnosis. It also
 * distinguishes the two routes in `via`, because "which reader answered" is
 * itself diagnostic on a broken prefix.
 * ──────────────────────────────────────────────────────────────────────
 */

import {
  listArchiveContents,
  normalizeArchivePath,
  type ArchiveListing,
} from "./archiveContents";
import { listZipEntries } from "./readZip";
import type { SevenZipApi } from "./sevenZip";

export type ArchiveListingAttempt =
  | { kind: "listed"; listing: ArchiveListing; via: "native-zip" | "seven-zip" }
  /**
   * Neither reader could parse it. That is a real finding in its own right: a
   * file that no reader can open is not an archive we merely failed to
   * inspect, it is a damaged or truncated download.
   */
  | { kind: "unreadable"; why: string };

/**
 * List a ZIP without a subprocess, or throw if it is not a readable ZIP.
 *
 * Only the LISTING is native. Unpacking a mod archive stays Vortex's job with
 * Vortex's 7z, because a mod archive is as often .7z or .rar as .zip.
 */
async function listZipNatively(
  archivePath: string,
): Promise<{ listing: ArchiveListing; namesCertain: boolean }> {
  const zipEntries = await listZipEntries(archivePath);
  const namesCertain = zipEntries.every((e) => e.nameEncodingKnown);

  const entries = zipEntries
    .filter((e) => !e.isDirectory)
    .map((e) => ({
      path: normalizeArchivePath(e.name),
      size: e.uncompressedSize,
      // A ZIP central directory always carries a CRC, so this path reports
      // full coverage — including the legitimate 00000000 of an empty file.
      crc: (e.crc32 >>> 0).toString(16).padStart(8, "0"),
    }));

  return {
    listing: { entries, withCrc: entries.length, crcCoverage: 1 },
    namesCertain,
  };
}

/** Never throws. See the note on {@link ArchiveListingAttempt}. */
export async function listArchiveNativeFirst(args: {
  archivePath: string;
  /** Injection point for tests; defaults to Vortex's own SevenZip. */
  sevenZip?: SevenZipApi;
  signal?: AbortSignal;
}): Promise<ArchiveListingAttempt> {
  if (args.signal?.aborted === true) {
    return { kind: "unreadable", why: "cancelled" };
  }

  /**
   * ─── A NAME WE COULD ONLY GUESS DEFERS TO 7-ZIP ───────────────────────
   * A ZIP without the UTF-8 flag whose names carry non-ASCII bytes is in some
   * codepage this reader cannot identify, and the files on disk are named by
   * whatever 7-Zip decoded on THIS machine. So 7-Zip is asked instead — it is
   * the only decoder guaranteed to agree with the extraction.
   *
   * The native listing is kept as a LAST resort rather than thrown away: on a
   * Wine prefix where 7-Zip will not run (the reason this module exists), a
   * listing with one or two uncertain names is far more useful than
   * "unreadable" for the whole mod. Measured: 2 of 1,283 mod ZIPs on the
   * curator's machine are in this state.
   */
  let guessed: ArchiveListing | undefined;
  try {
    const native = await listZipNatively(args.archivePath);
    if (native.namesCertain) {
      return { kind: "listed", listing: native.listing, via: "native-zip" };
    }
    guessed = native.listing;
  } catch {
    // Not a ZIP, or not a readable one. Either way 7z gets its turn.
  }

  try {
    const { resolveSevenZip } = await import("./sevenZip");
    const sevenZip = args.sevenZip ?? resolveSevenZip();
    return {
      kind: "listed",
      listing: await listArchiveContents(sevenZip, args.archivePath, {
        ...(args.signal !== undefined ? { signal: args.signal } : {}),
      }),
      via: "seven-zip",
    };
  } catch (err) {
    if (guessed !== undefined) {
      return { kind: "listed", listing: guessed, via: "native-zip" };
    }
    return {
      kind: "unreadable",
      why: err instanceof Error ? err.message : String(err),
    };
  }
}
