/**
 * ──────────────────────────────────────────────────────────────────────
 * A bundled mod as one exact zip — the same bytes on every machine.
 *
 * Nexus quarantines any upload with an archive inside it: its scanner cannot
 * see into a nested archive, and its own help tells authors to extract them.
 * So a package carries a bundled mod as loose files, `bundled/<sha256>/…`, and
 * nothing inside a package is an archive.
 *
 * Vortex still installs from an archive, and a bundled mod is still identified
 * by the sha256 of one. This writes that archive deterministically from the
 * files alone. The curator's build hashes it without keeping it; the user's
 * install writes it from the package's loose files; the two must agree byte
 * for byte before Vortex touches it. A lost, extra or changed file — a damaged
 * download, a truncated entry — changes the hash, and the install refuses.
 *
 * The format is FROZEN: entries sorted by the UTF-8 bytes of their path,
 * stored (no compression), a fixed 1980-01-01 00:00 timestamp, the UTF-8 name
 * flag, no directory entries, and ZIP64 fields only where a size, offset or
 * count needs them. Change any of it and every bundled mod in every package
 * changes identity — that is a manifest schema change, not a fix.
 *
 * What a bundle holds: every file under the mod's staging folder except the
 * volatile ones a runtime writes (volatileFiles.ts). Those are already left
 * out of verification and of the staging-set identity; shipping a curator's
 * log would only make the bundle change identity on its own.
 * ──────────────────────────────────────────────────────────────────────
 */

import * as crypto from "crypto";
import * as fs from "fs";
import * as fsp from "fs/promises";
import * as path from "path";
import type { Readable, Writable } from "stream";

import { AbortError } from "../../utils/abortError";
import { toPosix } from "../paths";
import { isVolatileFile } from "../volatileFiles";
import { crc32File, crc32Update, type ZipReader } from "./readZip";
import { walkStagingFolder, type UnreadablePath } from "./stagingFileWalker";

/**
 * The version of the frozen format described above.
 *
 * It does not move within a manifest schema: a different format makes
 * different bytes for the same files, which is a different identity, which is
 * a new schema. Build records carry it, so a new format also retires every
 * measurement taken under the old one.
 */
export const BUNDLE_ZIP_FORMAT = 1;

export type BundleFile = {
  /** Path inside the bundle, "/"-separated — the entry's name in the zip. */
  path: string;
  size: number;
  crc32: number;
  /** The file's bytes. Called once, in the order the zip writes them. */
  open: () => Readable | Promise<Readable>;
};

export type BundleZipResult = { sha256: string; bytes: number; files: number };

/** A file under a bundle's folder, before anything has read its bytes. */
export type BundleListing = { path: string; size: number; fullPath: string };

/** Sorted by the UTF-8 bytes of the path — the order both sides must agree on. */
export function sortForBundle<T extends { path: string }>(files: readonly T[]): T[] {
  return [...files].sort((a, b) => Buffer.compare(Buffer.from(a.path, "utf8"), Buffer.from(b.path, "utf8")));
}

/**
 * Every file under `root` that a bundle carries, in the order the zip writes them.
 *
 * The same walk that captures a mod's staging files for the manifest
 * (`walkStagingFolder`), so a bundle holds exactly the files the manifest
 * lists: a link leading out of the mod, or to a folder, is not followed there
 * and must not be here, or users would receive files their manifest does not
 * describe and the mod would never be recognised as installed. A path the walk
 * cannot read refuses the bundle, because a listing with a hole in it ships a
 * mod without that file.
 */
export async function listBundleFolder(root: string, signal?: AbortSignal): Promise<BundleListing[]> {
  const unreadable: UnreadablePath[] = [];
  const walked = await walkStagingFolder(root, signal, (entry) => unreadable.push(entry));
  if (unreadable.length > 0) {
    const first = unreadable[0]!;
    throw new Error(
      `${unreadable.length} path${unreadable.length === 1 ? "" : "s"} under "${root}" could not ` +
        `be read (first: "${first.path}" — ${first.why}), so the bundle would be missing files.`,
    );
  }
  return sortForBundle(
    walked
      .filter((f) => !isVolatileFile(f.relativePath))
      .map((f) => ({ path: f.relativePath, size: f.size, fullPath: f.absolutePath })),
  );
}

/** Read each listed file once for its CRC, so its zip header can be written before its bytes. */
export async function bundleFilesFromListing(listing: readonly BundleListing[], signal?: AbortSignal): Promise<BundleFile[]> {
  const out: BundleFile[] = [];
  for (const f of listing) {
    if (signal?.aborted === true) throw new AbortError("Cancelled");
    out.push({
      path: f.path,
      size: f.size,
      crc32: Number.parseInt(await crc32File(f.fullPath, signal), 16),
      open: () => fs.createReadStream(f.fullPath),
    });
  }
  return out;
}

/**
 * A bundle's files as a package carries them, loose under `folder`. Their
 * sizes and CRCs come from the package's own index, so the zip is written in
 * one pass straight out of the package, and every entry is checked as it goes.
 */
export function bundleFilesFromPackage(reader: ZipReader, folder: string): BundleFile[] {
  // Separators normalised exactly as the package reader classifies entries, so
  // a file `readEhcoll` counted under this folder is a file this finds.
  const entries = reader.entries
    .map((entry) => ({ entry, name: toPosix(entry.name) }))
    .filter(
      ({ entry, name }) => !entry.isDirectory && name.startsWith(folder) && name.length > folder.length,
    );
  // A name read in a guessed encoding is a different path, so the zip would be
  // a different bundle. Say that, rather than leave the hash to call it damaged.
  const guessed = entries.find(({ entry }) => !entry.nameEncodingKnown);
  if (guessed !== undefined) {
    throw new Error(
      `"${guessed.name}" does not say how its name is encoded, so the bundled mod it ` +
        `belongs to cannot be rebuilt exactly. The package was re-packed by a tool that ` +
        `does not mark UTF-8 names — use the original.`,
    );
  }
  return entries.map(({ entry, name }) => ({
    path: name.slice(folder.length),
    size: entry.uncompressedSize,
    crc32: entry.crc32,
    open: () => reader.openEntry(entry),
  }));
}

const LOCAL_SIG = 0x04034b50;
const CENTRAL_SIG = 0x02014b50;
const END_SIG = 0x06054b50;
const END64_SIG = 0x06064b50;
const END64_LOCATOR_SIG = 0x07064b50;
const FLAG_UTF8_NAME = 0x0800;
/** 1980-01-01, the first date a zip can hold: year 0, month 1, day 1. */
const DOS_DATE = (1 << 5) | 1;
const DOS_TIME = 0;
const MARK32 = 0xffffffff;
const MARK16 = 0xffff;

function zip64Extra(values: readonly number[]): Buffer {
  const buf = Buffer.alloc(4 + 8 * values.length);
  buf.writeUInt16LE(0x0001, 0);
  buf.writeUInt16LE(8 * values.length, 2);
  values.forEach((v, i) => buf.writeBigUInt64LE(BigInt(v), 4 + 8 * i));
  return buf;
}

/** A function, not an inline check: TypeScript narrows a property read across an await and calls a later check impossible. */
function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

function writeChunk(sink: Writable, buf: Buffer): Promise<void> {
  return new Promise((resolve, reject) => {
    sink.write(buf, (err) => (err !== undefined && err !== null ? reject(err) : resolve()));
  });
}

function assertBundlePaths(sorted: readonly BundleFile[]): void {
  let previous: string | undefined;
  for (const f of sorted) {
    const segments = f.path.split("/");
    if (f.path.includes("\\") || segments.some((s) => s === "" || s === "." || s === "..")) {
      throw new Error(`"${f.path}" cannot be a file inside a bundle.`);
    }
    if (f.path === previous) throw new Error(`"${f.path}" appears twice in one bundle.`);
    previous = f.path;
  }
}

/**
 * Write the bundle's zip into `sink` — or, with no sink, only hash it.
 *
 * Throws when a file's bytes do not match the size and CRC it was listed with:
 * a file that changed after it was listed, or a damaged package entry. Nothing
 * written by a call that threw is a bundle.
 */
export async function writeBundleZip(
  files: readonly BundleFile[],
  sink: Writable | undefined,
  options: {
    signal?: AbortSignal;
    /** Tests only: the value from which a size or offset is carried as ZIP64. */
    zip64From?: number;
  } = {},
): Promise<BundleZipResult> {
  const limit = options.zip64From ?? MARK32;
  const sorted = sortForBundle(files);
  assertBundlePaths(sorted);
  const hash = crypto.createHash("sha256");
  let offset = 0;
  const emit = async (buf: Buffer): Promise<void> => {
    if (buf.length === 0) return;
    hash.update(buf);
    offset += buf.length;
    if (sink !== undefined) await writeChunk(sink, buf);
  };

  const central: Buffer[] = [];
  for (const file of sorted) {
    if (isAborted(options.signal)) throw new AbortError("Cancelled");
    const name = Buffer.from(file.path, "utf8");
    const bigSize = file.size >= limit;
    const headerOffset = offset;
    const farOffset = headerOffset >= limit;
    const version = bigSize || farOffset ? 45 : 20;
    const size32 = bigSize ? MARK32 : file.size;

    const localExtra = bigSize ? zip64Extra([file.size, file.size]) : Buffer.alloc(0);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(LOCAL_SIG, 0);
    local.writeUInt16LE(version, 4);
    local.writeUInt16LE(FLAG_UTF8_NAME, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(file.crc32 >>> 0, 14);
    local.writeUInt32LE(size32, 18);
    local.writeUInt32LE(size32, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(localExtra.length, 28);
    await emit(local);
    await emit(name);
    await emit(localExtra);

    const stream = await file.open();
    let crc = 0;
    let bytes = 0;
    try {
      for await (const chunk of stream) {
        if (isAborted(options.signal)) throw new AbortError("Cancelled");
        const buf = typeof chunk === "string" ? Buffer.from(chunk) : (chunk as Buffer);
        crc = crc32Update(crc, buf);
        bytes += buf.length;
        await emit(buf);
      }
    } finally {
      stream.destroy();
    }
    if (bytes !== file.size || crc !== file.crc32 >>> 0) {
      throw new Error(
        `"${file.path}" is not the file that was listed: expected ${file.size} bytes with CRC ` +
          `${(file.crc32 >>> 0).toString(16)}, read ${bytes} bytes with CRC ${crc.toString(16)}.`,
      );
    }

    const centralValues = [...(bigSize ? [file.size, file.size] : []), ...(farOffset ? [headerOffset] : [])];
    const centralExtra = centralValues.length > 0 ? zip64Extra(centralValues) : Buffer.alloc(0);
    const record = Buffer.alloc(46);
    record.writeUInt32LE(CENTRAL_SIG, 0);
    record.writeUInt16LE(version, 4);
    record.writeUInt16LE(version, 6);
    record.writeUInt16LE(FLAG_UTF8_NAME, 8);
    record.writeUInt16LE(0, 10);
    record.writeUInt16LE(DOS_TIME, 12);
    record.writeUInt16LE(DOS_DATE, 14);
    record.writeUInt32LE(file.crc32 >>> 0, 16);
    record.writeUInt32LE(size32, 20);
    record.writeUInt32LE(size32, 24);
    record.writeUInt16LE(name.length, 28);
    record.writeUInt16LE(centralExtra.length, 30);
    record.writeUInt32LE(farOffset ? MARK32 : headerOffset, 42);
    central.push(record, name, centralExtra);
  }

  const directory = Buffer.concat(central);
  const directoryOffset = offset;
  await emit(directory);

  const count = sorted.length;
  const countBig = count >= MARK16;
  const sizeBig = directory.length >= limit;
  const offsetBig = directoryOffset >= limit;
  if (countBig || sizeBig || offsetBig) {
    const end64Offset = offset;
    const end64 = Buffer.alloc(56);
    end64.writeUInt32LE(END64_SIG, 0);
    end64.writeBigUInt64LE(BigInt(44), 4);
    end64.writeUInt16LE(45, 12);
    end64.writeUInt16LE(45, 14);
    end64.writeBigUInt64LE(BigInt(count), 24);
    end64.writeBigUInt64LE(BigInt(count), 32);
    end64.writeBigUInt64LE(BigInt(directory.length), 40);
    end64.writeBigUInt64LE(BigInt(directoryOffset), 48);
    const locator = Buffer.alloc(20);
    locator.writeUInt32LE(END64_LOCATOR_SIG, 0);
    locator.writeBigUInt64LE(BigInt(end64Offset), 8);
    locator.writeUInt32LE(1, 16);
    await emit(end64);
    await emit(locator);
  }
  const end = Buffer.alloc(22);
  end.writeUInt32LE(END_SIG, 0);
  end.writeUInt16LE(countBig ? MARK16 : count, 8);
  end.writeUInt16LE(countBig ? MARK16 : count, 10);
  end.writeUInt32LE(sizeBig ? MARK32 : directory.length, 12);
  end.writeUInt32LE(offsetBig ? MARK32 : directoryOffset, 16);
  await emit(end);

  return { sha256: hash.digest("hex"), bytes: offset, files: count };
}

/**
 * Write the bundle's zip to a new file at `filePath`, and return its identity.
 *
 * Owns the file from open to close. The file is created before anything is
 * written, so a failure knows it is ours to remove — and an existing file is
 * refused, never overwritten or deleted. The stream's errors are listened for,
 * because an unheard 'error' takes the whole process down when a disk fills,
 * and this returns only after 'close', so Vortex is never handed a file still
 * being written.
 */
export async function writeBundleZipToFile(
  files: readonly BundleFile[],
  filePath: string,
  options: { signal?: AbortSignal } = {},
): Promise<BundleZipResult> {
  const handle = await fsp.open(filePath, "wx");
  const sink = handle.createWriteStream();
  const failure: { err?: Error } = {};
  sink.on("error", (err) => {
    if (failure.err === undefined) failure.err = err;
  });
  const closed = new Promise<void>((resolve) => sink.once("close", () => resolve()));
  try {
    const result = await writeBundleZip(files, sink, options);
    await new Promise<void>((resolve, reject) => {
      sink.end((err?: Error | null) => (err !== undefined && err !== null ? reject(err) : resolve()));
    });
    await closed;
    if (failure.err !== undefined) throw failure.err;
    return result;
  } catch (err) {
    sink.destroy();
    await closed;
    await fsp.rm(filePath, { force: true }).catch(() => undefined);
    throw failure.err ?? err;
  }
}
