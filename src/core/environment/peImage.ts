/**
 * ──────────────────────────────────────────────────────────────────────
 * What a Windows executable imports, and what a DLL exports.
 *
 * A tester's Fallout4Launcher.exe died with "Entry Point Not Found:
 * SteamInternal_CreateInterface" — a Steam install carrying a GOG copy of
 * steam_api64.dll. The GOG build exports twelve names and that is not one of
 * them. Windows refuses to start the process, and nothing in Vortex or the game
 * says which file is wrong.
 *
 * The check that finds it is the one the Windows loader itself runs: every
 * symbol an executable imports from a DLL sitting beside it must be exported by
 * that DLL. No list of "known good" DLLs, no per-store hash table — it holds for
 * any game and any DLL, and it cannot go stale when a store ships an update.
 * Measured against real installs before it was written: zero mismatches on the
 * vanilla executables of GOG Fallout 4, GOG Skyrim AE, Hunt: Showdown and CS2;
 * and GOG Fallout 4's CreationKit.exe (a Steam build, not part of the GOG game)
 * DOES mismatch, missing SteamInternal_CreateInterface — the tester's error.
 *
 * Only static imports. A delay-loaded import fails later, if ever, and is not
 * what stops a launcher opening.
 *
 * Unparseable input returns `undefined`, never a guess: a file this cannot read
 * is "cannot say", and a gate must not block on "cannot say".
 * ──────────────────────────────────────────────────────────────────────
 */

export type PeImports = {
  /** Imported symbol names, as written in the import table. */
  names: string[];
  /** Symbols imported by ordinal only. */
  ordinals: number[];
};

export type PeImage = {
  /** True for PE32+ (64-bit). */
  is64: boolean;
  /** Every exported symbol NAME. Forwarded exports are included. */
  exports: ReadonlySet<string>;
  /** Every ordinal the export table covers. */
  exportOrdinals: ReadonlySet<number>;
  /** Static imports, keyed by lower-cased DLL name. */
  imports: ReadonlyMap<string, PeImports>;
};

type Section = { va: number; vsize: number; raw: number; rawSize: number };

/** Hard ceilings, so a corrupt table cannot spin a loop forever. */
const MAX_DESCRIPTORS = 4096;
const MAX_THUNKS = 1 << 16;
const MAX_NAME = 1024;

class Malformed extends Error {}

export function parsePeImage(buf: Buffer): PeImage | undefined {
  try {
    return parse(buf);
  } catch {
    return undefined;
  }
}

function parse(buf: Buffer): PeImage | undefined {
  const u16 = (off: number): number => {
    if (off < 0 || off + 2 > buf.length) throw new Malformed();
    return buf.readUInt16LE(off);
  };
  const u32 = (off: number): number => {
    if (off < 0 || off + 4 > buf.length) throw new Malformed();
    return buf.readUInt32LE(off);
  };

  if (buf.length < 0x40 || u16(0) !== 0x5a4d) return undefined; // "MZ"
  const pe = u32(0x3c);
  if (u32(pe) !== 0x00004550) return undefined; // "PE\0\0"

  const sectionCount = u16(pe + 6);
  const optionalSize = u16(pe + 20);
  const optional = pe + 24;
  const magic = u16(optional);
  if (magic !== 0x10b && magic !== 0x20b) return undefined;
  const is64 = magic === 0x20b;

  const sizeOfHeaders = u32(optional + 60);
  const directoryCount = u32(optional + (is64 ? 108 : 92));
  const directories = optional + (is64 ? 112 : 96);
  const dir = (index: number): { rva: number; size: number } =>
    index < directoryCount
      ? { rva: u32(directories + index * 8), size: u32(directories + index * 8 + 4) }
      : { rva: 0, size: 0 };

  const sections: Section[] = [];
  const sectionTable = optional + optionalSize;
  for (let i = 0; i < sectionCount; i += 1) {
    const at = sectionTable + i * 40;
    sections.push({
      vsize: u32(at + 8),
      va: u32(at + 12),
      rawSize: u32(at + 16),
      raw: u32(at + 20),
    });
  }

  const offsetOf = (rva: number): number => {
    if (rva < sizeOfHeaders) return rva;
    for (const s of sections) {
      const span = Math.max(s.vsize, s.rawSize);
      if (rva >= s.va && rva < s.va + span) return rva - s.va + s.raw;
    }
    throw new Malformed();
  };
  const cstring = (off: number): string => {
    let end = off;
    while (end < buf.length && end - off < MAX_NAME && buf[end] !== 0) end += 1;
    if (end >= buf.length || buf[end] !== 0) throw new Malformed();
    return buf.toString("latin1", off, end);
  };

  // ── exports ──────────────────────────────────────────────────────────
  const exports = new Set<string>();
  const exportOrdinals = new Set<number>();
  const exportDir = dir(0);
  if (exportDir.rva !== 0) {
    const at = offsetOf(exportDir.rva);
    const base = u32(at + 16);
    const functionCount = u32(at + 20);
    const nameCount = u32(at + 24);
    const namesRva = u32(at + 32);
    if (functionCount > MAX_THUNKS || nameCount > MAX_THUNKS) throw new Malformed();
    for (let i = 0; i < functionCount; i += 1) exportOrdinals.add(base + i);
    if (nameCount > 0) {
      const names = offsetOf(namesRva);
      for (let i = 0; i < nameCount; i += 1) {
        exports.add(cstring(offsetOf(u32(names + i * 4))));
      }
    }
  }

  // ── imports ──────────────────────────────────────────────────────────
  const imports = new Map<string, PeImports>();
  const importDir = dir(1);
  if (importDir.rva !== 0) {
    let at = offsetOf(importDir.rva);
    for (let d = 0; d < MAX_DESCRIPTORS; d += 1, at += 20) {
      const originalThunk = u32(at);
      const nameRva = u32(at + 12);
      const firstThunk = u32(at + 16);
      if (nameRva === 0 && originalThunk === 0 && firstThunk === 0) break;
      if (nameRva === 0) break;
      const dll = cstring(offsetOf(nameRva)).toLowerCase();
      const entry = imports.get(dll) ?? { names: [], ordinals: [] };
      let thunk = offsetOf(originalThunk !== 0 ? originalThunk : firstThunk);
      for (let t = 0; t < MAX_THUNKS; t += 1) {
        const low = u32(thunk);
        const high = is64 ? u32(thunk + 4) : 0;
        thunk += is64 ? 8 : 4;
        if (low === 0 && high === 0) break;
        const byOrdinal = is64 ? (high & 0x80000000) !== 0 : (low & 0x80000000) !== 0;
        if (byOrdinal) {
          entry.ordinals.push(low & 0xffff);
        } else {
          // Hint (2 bytes), then the name.
          entry.names.push(cstring(offsetOf(low & 0x7fffffff) + 2));
        }
      }
      imports.set(dll, entry);
    }
  }

  return { is64, exports, exportOrdinals, imports };
}

/**
 * What `exe` imports from `dll` that `dll` does not provide.
 *
 * Empty means the pair is consistent. Ordinals are checked against the export
 * table's ordinal range, which is exactly what the loader checks.
 */
export function missingImports(
  exe: PeImage,
  dllName: string,
  dll: PeImage,
): string[] {
  const wanted = exe.imports.get(dllName.toLowerCase());
  if (wanted === undefined) return [];
  const missing: string[] = [];
  for (const name of wanted.names) {
    if (!dll.exports.has(name)) missing.push(name);
  }
  for (const ordinal of wanted.ordinals) {
    if (!dll.exportOrdinals.has(ordinal)) missing.push(`#${ordinal}`);
  }
  return missing;
}
