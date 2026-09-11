/**
 * ──────────────────────────────────────────────────────────────────────
 * The link file on a collection's landing page.
 *
 * Nexus quarantines an Event Horizon package (a zip of zips), so the mod
 * page is a landing page and its own file is a small zip that carries the
 * package's download link and SHA-256. Pasting that page's address has to
 * end in the package, so this reads the zip and says which link and which
 * checksum it carries — or exactly why it cannot tell.
 *
 * The format, in order of preference:
 *
 *   event-horizon-link.json   {"format": "event-horizon-link", "version": 1,
 *                              "url": "https://pixeldrain.com/api/file/<id>?download",
 *                              "sha256": "<64 hex>",
 *                              "fileName": "ivy-panties-1.0.19.ehcoll", "size": 3430197672}
 *   any .txt / .md file       human text; accepted when it holds exactly one
 *                             direct https download link and exactly one
 *                             SHA-256 (a #sha256= fragment on the link counts)
 *
 * The checksum is required: a link file exists to carry the link AND the
 * proof, and one without the proof is refused rather than downloaded
 * unverified. Ambiguity is refused too, with what was found listed — two
 * links or two checksums are a question for whoever published the page,
 * not a pick.
 *
 * The zip is read here rather than through 7-Zip: it is a few hundred
 * bytes, stored or deflated, and reading it needs no external process. Only
 * small archives are opened, and every entry's CRC is checked.
 * ──────────────────────────────────────────────────────────────────────
 */

import * as fs from "fs";
import * as path from "path";
import * as zlib from "zlib";

import { parseInstallLink } from "./installLink";

export const LINK_FILE_NAME = "event-horizon-link.json";
export const LINK_FILE_FORMAT = "event-horizon-link";

export type CarrierLink = {
  /** The direct download link, normalized the way a pasted link is. */
  url: string;
  /** Lowercase hex. */
  sha256: string;
  fileName?: string;
  size?: number;
  /** Which entry of the zip said so. */
  source: string;
};

/** A link file is a few hundred bytes; anything past this is not one. */
const MAX_ZIP_BYTES = 1024 * 1024;
const MAX_ENTRY_BYTES = 256 * 1024;
const MAX_ENTRIES = 64;

/** Read the link file at `zipPath`. Throws an Error saying why it cannot be used. */
export async function readLinkCarrier(zipPath: string): Promise<CarrierLink> {
  const name = path.basename(zipPath);
  const size = (await fs.promises.stat(zipPath)).size;
  if (size > MAX_ZIP_BYTES) {
    throw new Error(`The page's file "${name}" is ${size} bytes, too large to be a link file; it is not a collection package either (.ehcoll).`);
  }
  let parsed: CarrierLink | { why: string };
  try {
    parsed = parseLinkCarrier(readSmallZip(await fs.promises.readFile(zipPath)));
  } catch (err) {
    parsed = { why: err instanceof Error ? err.message : String(err) };
  }
  if ("why" in parsed) throw new Error(`The page's file "${name}" is not a usable link file: ${parsed.why}`);
  return parsed;
}

/** Which link and checksum the entries carry, or why that cannot be said. */
export function parseLinkCarrier(entries: ReadonlyArray<{ name: string; data: Buffer }>): CarrierLink | { why: string } {
  const json = entries.find((e) => baseName(e.name).toLowerCase() === LINK_FILE_NAME);
  if (json !== undefined) return parseJsonEntry(json);

  const texts = entries.filter((e) => /\.(txt|md)$/i.test(e.name));
  if (texts.length === 0) {
    return { why: `it holds no ${LINK_FILE_NAME} and no text file (${entries.map((e) => e.name).join(", ") || "it is empty"}).` };
  }

  const links = new Map<string, string | undefined>();
  const hashes = new Set<string>();
  const refused: string[] = [];
  for (const entry of texts) {
    const text = decodeText(entry.data);
    for (const m of text.matchAll(/\b[0-9a-f]{64}\b/gi)) hashes.add(m[0].toLowerCase());
    for (const m of text.matchAll(/https?:\/\/[^\s<>"'`()[\]{}]+/gi)) {
      const candidate = m[0].replace(/[.,;:!?]+$/, "");
      const link = parseInstallLink(candidate);
      if (link.kind === "direct") {
        const prior = links.get(link.url);
        links.set(link.url, prior ?? link.sha256);
      } else if (link.kind === "invalid") {
        refused.push(`${candidate.slice(0, 80)} (${link.why})`);
      }
      // A Nexus link in the text is the page itself, not the download.
    }
  }
  const source = texts.map((e) => e.name).join(", ");

  if (links.size === 0) {
    return {
      why:
        `its text (${source}) holds no direct download link` +
        (refused.length > 0 ? `; refused: ${refused.join("; ")}` : "") +
        ".",
    };
  }
  let url: string;
  let fragmentHash: string | undefined;
  if (links.size === 1) {
    [[url, fragmentHash]] = [...links];
  } else {
    const withHash = [...links].filter(([, sha]) => sha !== undefined);
    if (withHash.length !== 1) {
      return { why: `its text holds ${links.size} different download links (${[...links.keys()].join(", ")}), and nothing says which is the package.` };
    }
    [[url, fragmentHash]] = withHash;
  }
  if (hashes.size === 0) {
    return { why: `its text gives the link but no SHA-256, and a link file without the checksum proves nothing about the download.` };
  }
  if (hashes.size > 1) {
    return { why: `its text holds ${hashes.size} different SHA-256 values (${[...hashes].join(", ")}), and nothing says which is the package's.` };
  }
  const [sha256] = [...hashes];
  if (fragmentHash !== undefined && fragmentHash !== sha256) {
    return { why: "the link's #sha256= and the checksum in the text disagree." };
  }
  return { url, sha256, source };
}

function parseJsonEntry(entry: { name: string; data: Buffer }): CarrierLink | { why: string } {
  let doc: unknown;
  try {
    doc = JSON.parse(decodeText(entry.data));
  } catch {
    return { why: `${entry.name} is not valid JSON.` };
  }
  const d = doc as Record<string, unknown> | null;
  if (d === null || typeof d !== "object") return { why: `${entry.name} is not a JSON object.` };
  if (d.format !== LINK_FILE_FORMAT || d.version !== 1) {
    return { why: `${entry.name} is not format "${LINK_FILE_FORMAT}" version 1 (format ${JSON.stringify(d.format)}, version ${JSON.stringify(d.version)}).` };
  }
  if (typeof d.url !== "string") return { why: `${entry.name} has no "url".` };
  if (typeof d.sha256 !== "string" || !/^[0-9a-f]{64}$/i.test(d.sha256)) {
    return { why: `${entry.name}'s "sha256" is not 64 hexadecimal characters.` };
  }
  const link = parseInstallLink(d.url);
  if (link.kind !== "direct") {
    return { why: `${entry.name}'s "url" is not a direct download link${link.kind === "invalid" ? ` (${link.why})` : " (it points at a Nexus page)"}.` };
  }
  const sha256 = d.sha256.toLowerCase();
  if (link.sha256 !== undefined && link.sha256 !== sha256) {
    return { why: `${entry.name}'s "url" carries a #sha256= that disagrees with its "sha256".` };
  }
  return {
    url: link.url,
    sha256,
    ...(typeof d.fileName === "string" && d.fileName.length > 0 ? { fileName: d.fileName } : {}),
    ...(typeof d.size === "number" && Number.isSafeInteger(d.size) && d.size > 0 ? { size: d.size } : {}),
    source: entry.name,
  };
}

function baseName(entryName: string): string {
  return entryName.slice(Math.max(entryName.lastIndexOf("/"), entryName.lastIndexOf("\\")) + 1);
}

function decodeText(data: Buffer): string {
  const text = data.toString("utf8");
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/**
 * The files in a small zip archive: stored or deflated, no encryption, no
 * ZIP64. Throws an Error naming what is wrong with it.
 */
export function readSmallZip(buf: Buffer): Array<{ name: string; data: Buffer }> {
  if (buf.length > MAX_ZIP_BYTES) throw new Error("the archive is too large to be a link file.");
  const eocd = findEndOfCentralDirectory(buf);
  if (eocd < 0) throw new Error("it is not a zip archive (no end-of-central-directory record), or it is cut short.");
  const count = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (count === 0xffff || cdOffset === 0xffffffff) throw new Error("it is a ZIP64 archive, which a link file never needs.");
  if (count > MAX_ENTRIES) throw new Error(`it holds ${count} entries, more than a link file would.`);
  if (cdOffset + cdSize > eocd) throw new Error("its central directory points outside the archive; the file is damaged.");

  const out: Array<{ name: string; data: Buffer }> = [];
  let p = cdOffset;
  for (let i = 0; i < count; i += 1) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) throw new Error("its central directory is damaged.");
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const compSize = buf.readUInt32LE(p + 20);
    const size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const nameBytes = buf.subarray(p + 46, p + 46 + nameLen);
    const name = nameBytes.toString((flags & 0x800) !== 0 ? "utf8" : "latin1");
    p += 46 + nameLen + extraLen + commentLen;

    if (name.endsWith("/")) continue;
    if ((flags & 0x1) !== 0) throw new Error(`"${name}" is encrypted.`);
    if (size > MAX_ENTRY_BYTES) continue; // not a link file's entry; never inflated

    if (localOffset + 30 > buf.length || buf.readUInt32LE(localOffset) !== 0x04034b50) {
      throw new Error(`"${name}" has no local header where the directory says; the file is damaged.`);
    }
    const dataStart = localOffset + 30 + buf.readUInt16LE(localOffset + 26) + buf.readUInt16LE(localOffset + 28);
    if (dataStart + compSize > buf.length) throw new Error(`"${name}" is cut short; the file is damaged.`);
    const raw = buf.subarray(dataStart, dataStart + compSize);
    let data: Buffer;
    if (method === 0) {
      data = Buffer.from(raw);
    } else if (method === 8) {
      try {
        data = zlib.inflateRawSync(raw, { maxOutputLength: MAX_ENTRY_BYTES });
      } catch {
        throw new Error(`"${name}" does not decompress; the file is damaged.`);
      }
    } else {
      throw new Error(`"${name}" uses compression method ${method}; a link file is stored or deflated.`);
    }
    if (data.length !== size || crc32(data) !== crc) {
      throw new Error(`"${name}" fails its CRC check; the file is damaged.`);
    }
    out.push({ name, data });
  }
  return out;
}

function findEndOfCentralDirectory(buf: Buffer): number {
  const lowest = Math.max(0, buf.length - 22 - 0xffff);
  for (let i = buf.length - 22; i >= lowest; i -= 1) {
    if (buf.readUInt32LE(i) === 0x06054b50) return i;
  }
  return -1;
}

let crcTable: Uint32Array | undefined;

function crc32(data: Buffer): number {
  if (crcTable === undefined) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n += 1) {
      let c = n;
      for (let k = 0; k < 8; k += 1) c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i += 1) crc = crcTable[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
