/**
 * Is this file an archive? Read from its first bytes, never from its name.
 *
 * Nexus quarantines an upload that has an archive inside it, and a package
 * carries a mod's own files loose — so a mod that itself contains a .zip puts
 * an archive back inside the package. The build refuses that and names the
 * file (the curator's call).
 *
 * By signature, because a name proves nothing either way: a mirrored file sits
 * in a package under its hash with no extension, and a renamed archive is
 * still an archive to a scanner. Bethesda's own archives — .ba2 ("BTDX") and
 * .bsa ("BSA\0") — are not archives in this sense: every mod on Nexus ships
 * them, and their signatures are not in this list.
 */

import * as fsp from "fs/promises";

export type ArchiveFormat =
  | "zip"
  | "7z"
  | "rar"
  | "gzip"
  | "xz"
  | "bzip2"
  | "zstd"
  | "lz4"
  | "cab"
  | "wim"
  | "tar";

/** Enough of a file to see every signature below, tar's included. */
export const ARCHIVE_HEAD_BYTES = 262;

const SIGNATURES: ReadonlyArray<{ format: ArchiveFormat; at: number; bytes: readonly number[] }> = [
  { format: "zip", at: 0, bytes: [0x50, 0x4b, 0x03, 0x04] },
  { format: "zip", at: 0, bytes: [0x50, 0x4b, 0x05, 0x06] },
  { format: "zip", at: 0, bytes: [0x50, 0x4b, 0x07, 0x08] },
  { format: "7z", at: 0, bytes: [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c] },
  { format: "rar", at: 0, bytes: [0x52, 0x61, 0x72, 0x21, 0x1a, 0x07] },
  { format: "gzip", at: 0, bytes: [0x1f, 0x8b, 0x08] },
  { format: "xz", at: 0, bytes: [0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00] },
  { format: "zstd", at: 0, bytes: [0x28, 0xb5, 0x2f, 0xfd] },
  { format: "lz4", at: 0, bytes: [0x04, 0x22, 0x4d, 0x18] },
  { format: "cab", at: 0, bytes: [0x4d, 0x53, 0x43, 0x46, 0x00, 0x00, 0x00, 0x00] },
  { format: "wim", at: 0, bytes: [0x4d, 0x53, 0x57, 0x49, 0x4d, 0x00, 0x00, 0x00] },
  // "BZh", a block size digit, then the first block's own magic number.
  { format: "bzip2", at: 0, bytes: [0x42, 0x5a, 0x68] },
  { format: "tar", at: 257, bytes: [0x75, 0x73, 0x74, 0x61, 0x72] },
];

const BZIP2_BLOCK_MAGIC = [0x31, 0x41, 0x59, 0x26, 0x53, 0x59];

function matchesAt(head: Buffer, at: number, bytes: readonly number[]): boolean {
  if (head.length < at + bytes.length) return false;
  return bytes.every((b, i) => head[at + i] === b);
}

export function archiveFormatOf(head: Buffer): ArchiveFormat | undefined {
  for (const s of SIGNATURES) {
    if (!matchesAt(head, s.at, s.bytes)) continue;
    if (s.format === "bzip2") {
      const level = head[3];
      if (level === undefined || level < 0x31 || level > 0x39 || !matchesAt(head, 4, BZIP2_BLOCK_MAGIC)) continue;
    }
    return s.format;
  }
  return undefined;
}

export async function archiveFormatOfFile(filePath: string): Promise<ArchiveFormat | undefined> {
  const handle = await fsp.open(filePath, "r");
  try {
    const head = Buffer.alloc(ARCHIVE_HEAD_BYTES);
    const { bytesRead } = await handle.read(head, 0, ARCHIVE_HEAD_BYTES, 0);
    return archiveFormatOf(head.subarray(0, bytesRead));
  } finally {
    await handle.close().catch(() => undefined);
  }
}
