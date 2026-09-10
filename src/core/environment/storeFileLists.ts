/**
 * ──────────────────────────────────────────────────────────────────────
 * The game's own files, as the STORE that installed it recorded them.
 *
 * "Is this game folder clean?" needs a list of what a clean folder contains,
 * and the only trustworthy source is the store's own install record — never a
 * list typed into this repository, which would be wrong for the next DLC, the
 * next patch and the next store.
 *
 *  - GOG writes `goggame-galaxyFileList.ini`: one section per product, each a
 *    list of `F<n>=<relative path>`. Numeric sections are the game and its
 *    DLC; named sections (`[ISI]`, `[DirectX]`, `[MSVC2019]`) are redistributable
 *    installers that GOG deletes after running them, so their absence is not
 *    damage. Measured on the curator's Fallout 4 GOTY: 119 product files, all
 *    present; 160 redistributable entries, all absent.
 *
 *  - Steam keeps a depot manifest per installed depot in `depotcache`,
 *    `<depotId>_<manifestId>.manifest`, and names the installed pair in the
 *    app's `appmanifest_<appId>.acf`. The manifest is a length-prefixed
 *    protobuf carrying every file's path, size and SHA-1. Validated against a
 *    real 91 GB depot: 115 of 115 files present with the recorded size.
 *
 * Everything else is `unknown`, with the reason — never an empty list, which
 * would call every file in the folder foreign.
 * ──────────────────────────────────────────────────────────────────────
 */

import { segmentsOf } from "../paths";

export type StoreFile = {
  /** Relative path with "/" separators, original case. */
  path: string;
  /** Bytes, when the store records it (Steam does, GOG does not). */
  size?: number;
  /**
   * False for files the store installs and then removes on purpose — GOG's
   * redistributable installers. Absence of a required file is damage; absence
   * of these is normal.
   */
  required: boolean;
};

// ── GOG ──────────────────────────────────────────────────────────────────

/** A GOG entry value that is a content hash, not a path (F0 of each section). */
const GOG_HASH_VALUE = /^[0-9a-f]{32}$/i;

export type GogFileList = {
  /** Numeric section names: the game's product ids. */
  productIds: string[];
  files: StoreFile[];
};

export function parseGogFileList(text: string): GogFileList {
  const productIds: string[] = [];
  const files: StoreFile[] = [];
  let section: string | undefined;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    const header = /^\[(.+)\]$/.exec(line);
    if (header !== null) {
      section = header[1]!.trim();
      if (/^\d+$/.test(section)) productIds.push(section);
      continue;
    }
    const entry = /^F\d+=(.*)$/.exec(line);
    if (entry === null || section === undefined) continue;
    const value = entry[1]!.trim();
    if (value.length === 0 || GOG_HASH_VALUE.test(value)) continue;
    files.push({
      path: toPosix(value),
      required: /^\d+$/.test(section),
    });
  }
  return { productIds, files };
}

// ── Steam: KeyValues (.acf / .vdf) ───────────────────────────────────────

export type VdfObject = { [key: string]: string | VdfObject };

/**
 * Valve's text KeyValues. Quoted keys and values, braces for objects. Enough
 * for appmanifest and libraryfolders, and it refuses anything else rather than
 * returning half an object.
 */
export function parseVdf(text: string): VdfObject | undefined {
  const tokens: Array<{ kind: "str"; value: string } | { kind: "open" } | { kind: "close" }> = [];
  let i = 0;
  while (i < text.length) {
    const c = text[i]!;
    if (c === '"') {
      let value = "";
      i += 1;
      while (i < text.length && text[i] !== '"') {
        if (text[i] === "\\" && i + 1 < text.length) {
          const next = text[i + 1]!;
          value += next === "n" ? "\n" : next === "t" ? "\t" : next;
          i += 2;
          continue;
        }
        value += text[i];
        i += 1;
      }
      if (i >= text.length) return undefined;
      tokens.push({ kind: "str", value });
      i += 1;
    } else if (c === "{") {
      tokens.push({ kind: "open" });
      i += 1;
    } else if (c === "}") {
      tokens.push({ kind: "close" });
      i += 1;
    } else if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i += 1;
    } else {
      i += 1;
    }
  }

  let pos = 0;
  const readObject = (topLevel: boolean): VdfObject | undefined => {
    const obj: VdfObject = {};
    while (pos < tokens.length) {
      const t = tokens[pos]!;
      if (t.kind === "close") {
        if (topLevel) return undefined;
        pos += 1;
        return obj;
      }
      if (t.kind !== "str") return undefined;
      pos += 1;
      const v = tokens[pos];
      if (v === undefined) return undefined;
      if (v.kind === "str") {
        obj[t.value] = v.value;
        pos += 1;
      } else if (v.kind === "open") {
        pos += 1;
        const child = readObject(false);
        if (child === undefined) return undefined;
        obj[t.value] = child;
      } else {
        return undefined;
      }
    }
    return topLevel ? obj : undefined;
  };
  return readObject(true);
}

export type SteamAppManifest = {
  appId: string;
  installDir: string;
  /** Steam's own executable, which locates `depotcache`. */
  launcherPath?: string;
  depots: Array<{ depotId: string; manifestId: string; size?: number }>;
};

export function parseAppManifest(text: string): SteamAppManifest | undefined {
  const root = parseVdf(text);
  const app = root?.["AppState"];
  if (app === undefined || typeof app === "string") return undefined;
  const appId = app["appid"];
  const installDir = app["installdir"];
  if (typeof appId !== "string" || typeof installDir !== "string") return undefined;
  const depots: SteamAppManifest["depots"] = [];
  const installed = app["InstalledDepots"];
  if (installed !== undefined && typeof installed !== "string") {
    for (const [depotId, info] of Object.entries(installed)) {
      if (typeof info === "string") continue;
      const manifestId = info["manifest"];
      if (typeof manifestId !== "string") continue;
      const size = typeof info["size"] === "string" ? Number(info["size"]) : undefined;
      depots.push({
        depotId,
        manifestId,
        ...(size !== undefined && Number.isFinite(size) ? { size } : {}),
      });
    }
  }
  const launcherPath = app["LauncherPath"];
  return {
    appId,
    installDir,
    ...(typeof launcherPath === "string" ? { launcherPath } : {}),
    depots,
  };
}

// ── Steam: depot manifest (binary protobuf) ──────────────────────────────

const PAYLOAD_MAGIC = 0x71f617d0;
const METADATA_MAGIC = 0x1f4812be;
/** `EDepotFileFlag.Directory`. */
const FLAG_DIRECTORY = 0x40;

export type DepotManifest = {
  files: StoreFile[];
  /** When true the names are ciphertext and the list is useless. */
  filenamesEncrypted: boolean;
};

class Truncated extends Error {}

export function parseDepotManifest(buf: Buffer): DepotManifest | undefined {
  try {
    return readDepotManifest(buf);
  } catch {
    return undefined;
  }
}

function readDepotManifest(buf: Buffer): DepotManifest | undefined {
  let payload: { start: number; end: number } | undefined;
  let metadata: { start: number; end: number } | undefined;
  let at = 0;
  while (at + 8 <= buf.length) {
    const magic = buf.readUInt32LE(at);
    const length = buf.readUInt32LE(at + 4);
    const start = at + 8;
    const end = start + length;
    if (end > buf.length) break;
    if (magic === PAYLOAD_MAGIC) payload = { start, end };
    else if (magic === METADATA_MAGIC) metadata = { start, end };
    else break;
    at = end;
  }
  if (payload === undefined) return undefined;

  let filenamesEncrypted = false;
  if (metadata !== undefined) {
    for (const f of fields(buf, metadata.start, metadata.end)) {
      if (f.field === 4 && f.wire === 0) filenamesEncrypted = f.varint !== 0;
    }
  }

  const files: StoreFile[] = [];
  for (const f of fields(buf, payload.start, payload.end)) {
    if (f.field !== 1 || f.wire !== 2) continue;
    let name: string | undefined;
    let size: number | undefined;
    let flags = 0;
    for (const g of fields(buf, f.start, f.end)) {
      if (g.field === 1 && g.wire === 2) name = buf.toString("utf8", g.start, g.end);
      else if (g.field === 2 && g.wire === 0) size = g.varint;
      else if (g.field === 3 && g.wire === 0) flags = g.varint;
    }
    if (name === undefined || (flags & FLAG_DIRECTORY) !== 0) continue;
    files.push({
      path: toPosix(name),
      ...(size !== undefined ? { size } : {}),
      required: true,
    });
  }
  return { files, filenamesEncrypted };
}

type Field = { field: number; wire: number; varint: number; start: number; end: number };

function* fields(buf: Buffer, start: number, end: number): Generator<Field> {
  let pos = start;
  const varint = (): number => {
    // Plain arithmetic, not bit shifts: sizes exceed 2^32, and JS shifts are
    // 32-bit. Exact up to 2^53, which no file size reaches.
    let value = 0;
    let scale = 1;
    for (let i = 0; i < 10; i += 1) {
      if (pos >= end) throw new Truncated();
      const b = buf[pos]!;
      pos += 1;
      value += (b & 0x7f) * scale;
      if ((b & 0x80) === 0) return value;
      scale *= 128;
    }
    throw new Truncated();
  };
  while (pos < end) {
    const key = varint();
    const field = Math.floor(key / 8);
    const wire = key % 8;
    if (wire === 0) {
      yield { field, wire, varint: varint(), start: pos, end: pos };
    } else if (wire === 2) {
      const length = varint();
      const s = pos;
      pos += length;
      if (pos > end) throw new Truncated();
      yield { field, wire, varint: 0, start: s, end: pos };
    } else if (wire === 5) {
      pos += 4;
      if (pos > end) throw new Truncated();
    } else if (wire === 1) {
      pos += 8;
      if (pos > end) throw new Truncated();
    } else {
      throw new Truncated();
    }
  }
}

function toPosix(p: string): string {
  return segmentsOf(p)
    .filter((s) => s !== ".")
    .join("/");
}
