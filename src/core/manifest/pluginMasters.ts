/**
 * Which plugins a plugin needs before it can load.
 *
 * ─── THE REPORT THIS COMES FROM ─────────────────────────────────────────────
 * A tester's game refused to start, and Vortex told him why: "Some of the
 * enabled plugins depend on others that are not enabled — MEI - Patch -
 * RaceCompatibility.esp depends on RaceCompatibility.esm". He was right that
 * everything was enabled: the master was not there to enable.
 *
 * It was not there in the PACKAGE either. Measured on the real 1,755-mod
 * manifest: `RaceCompatibility.esm` is provided by zero mods and appears
 * nowhere in the 1,607-entry plugin order, while two plugins that require it
 * ship enabled. The collection was internally inconsistent, it worked on the
 * curator's machine because they had the master from somewhere outside its
 * scope, and Event Horizon reproduced it faithfully and reported success.
 *
 * A collection that cannot load is not a collection, and the only person who
 * can fix it is the curator — who finds out here in seconds, or from a tester
 * an hour into an install.
 *
 * ─── THE FORMAT ─────────────────────────────────────────────────────────────
 * A plugin opens with a TES4 record: 4-byte type tag, 4-byte data size, then
 * the record header, then subrecords. Each subrecord is a 4-byte type, a
 * 2-byte length, then its data. The masters are `MAST` subrecords, each
 * holding one NUL-terminated filename, in load order, usually followed by a
 * `DATA` subrecord we do not need.
 *
 * `pluginFlags.ts` already reads the first twelve bytes of this record for the
 * ESL flag. This reads a little further into the same record.
 */

import * as fsp from "fs/promises";

/** Bytes of a TES4 record header before its subrecord data begins. */
const RECORD_HEADER_BYTES = 24;
/** Type tag (4) + data size (2). */
const SUBRECORD_HEADER_BYTES = 6;
/**
 * Refuse to read a header larger than this.
 *
 * The size comes from the file, so without a ceiling a malformed or hostile
 * plugin can ask us to allocate anything it likes. A real TES4 header with a
 * few hundred masters is a few kilobytes; this is generous by three orders of
 * magnitude and still bounded.
 */
const MAX_HEADER_BYTES = 4 * 1024 * 1024;

export type PluginMastersRead =
  | { kind: "ok"; masters: string[] }
  /** ENOENT — the file genuinely is not there. */
  | { kind: "not-found" }
  /** Present and readable, but not a Bethesda plugin (or truncated). */
  | { kind: "not-a-plugin"; why: string }
  /** There, but we could not read it: locked, permissions, an I/O error. */
  | { kind: "unreadable"; why: string };

/**
 * The masters a plugin declares, in the order it declares them.
 *
 * Never throws, and never collapses a failure into an empty list: "this
 * plugin needs nothing" and "we could not read this plugin" are different
 * facts, and reporting the second as the first is how a broken collection
 * passes a consistency check.
 */
export async function readPluginMasters(
  filePath: string,
): Promise<PluginMastersRead> {
  const read = await readPluginHeader(filePath);
  return read.kind === "ok" ? { kind: "ok", masters: read.masters } : read;
}

/** Bit 0 of the TES4 record flags: master. Bit 9: light (ESL). Same bits pluginFlags.ts reads. */
const FLAG_MASTER = 0x1;
const FLAG_LIGHT = 0x200;

export type PluginHeaderRead =
  | { kind: "ok"; masters: string[]; flags: { isLight: boolean; isMaster: boolean } }
  | Exclude<PluginMastersRead, { kind: "ok" }>;

/**
 * Masters and flags in ONE open. The requirements pass reads ~800 plugin
 * headers on a real profile; opening each file twice — once for MAST, once
 * for the flags at offset 8 of the same record header — doubled the
 * syscalls for nothing.
 */
export async function readPluginHeader(
  filePath: string,
): Promise<PluginHeaderRead> {
  let handle;
  try {
    handle = await fsp.open(filePath, "r");

    const head = Buffer.alloc(RECORD_HEADER_BYTES);
    const { bytesRead } = await handle.read(head, 0, RECORD_HEADER_BYTES, 0);
    if (bytesRead < 12) {
      return { kind: "not-a-plugin", why: "too short to hold a TES4 header" };
    }
    if (head.toString("latin1", 0, 4) !== "TES4") {
      return { kind: "not-a-plugin", why: "no TES4 header" };
    }
    const rawFlags = head.readUInt32LE(8);
    const flags = { isLight: (rawFlags & FLAG_LIGHT) !== 0, isMaster: (rawFlags & FLAG_MASTER) !== 0 };

    const dataSize = head.readUInt32LE(4);
    if (dataSize > MAX_HEADER_BYTES) {
      return {
        kind: "not-a-plugin",
        why: `TES4 header claims ${dataSize} bytes, which is not a real header`,
      };
    }

    const data = Buffer.alloc(dataSize);
    const read = await handle.read(data, 0, dataSize, RECORD_HEADER_BYTES);
    if (read.bytesRead < dataSize) {
      return {
        kind: "not-a-plugin",
        why: "the TES4 header is truncated",
      };
    }

    const masters: string[] = [];
    /**
     * Did we actually understand this record?
     *
     * `dataSize` is a number from the file and the subrecord walk is bounded
     * by it, so a size that is too SMALL is invisible to the truncation guard
     * above — the walk simply stops early and returns `{kind: "ok", masters:
     * []}`. That is the one answer this function must never give for a file it
     * failed to parse: "needs nothing" passes the build gate, so a plugin
     * whose masters were lost to a bad size field ships silently.
     *
     * Measured: a file with `TES4` and a zero size, and a well-formed plugin
     * declaring two masters with `dataSize` written as 12, both returned `ok`
     * with an empty list.
     *
     * Every TES4 header opens with a `HEDR` subrecord. Seeing one is proof the
     * walk was reading real structure rather than stopping before it started,
     * so its absence turns a silent pass into an honest unknown.
     */
    let sawHedr = false;
    let at = 0;
    while (at + SUBRECORD_HEADER_BYTES <= data.length) {
      const type = data.toString("latin1", at, at + 4);
      const size = data.readUInt16LE(at + 4);
      const start = at + SUBRECORD_HEADER_BYTES;
      const end = start + size;
      if (end > data.length) break; // truncated subrecord: stop, keep what we have
      if (type === "HEDR") sawHedr = true;
      if (type === "MAST") {
        // NUL-terminated, and latin1 because that is what the engine writes.
        const raw = data.toString("latin1", start, end);
        const name = raw.replace(/\0+$/, "").trim();
        if (name.length > 0) masters.push(name);
      }
      at = end;
    }

    if (!sawHedr) {
      return {
        kind: "not-a-plugin",
        why:
          `the TES4 header has no HEDR subrecord within the ${dataSize} ` +
          `bytes it declares, so its contents could not be read`,
      };
    }

    return { kind: "ok", masters, flags };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { kind: "not-found" };
    return {
      kind: "unreadable",
      why: `${code ?? "error"}: ${err instanceof Error ? err.message : String(err)}`,
    };
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

/**
 * Masters that ship with the GAME, which a collection never provides.
 *
 * Lowercased; compare against a lowercased name. Creation Club content is
 * deliberately absent — see {@link isUserOwnedMaster}.
 */
const SKYRIM_SE_MASTERS: readonly string[] = [
  "skyrim.esm",
  "update.esm",
  "dawnguard.esm",
  "hearthfires.esm",
  "dragonborn.esm",
];

const FALLOUT_4_MASTERS: readonly string[] = [
  "fallout4.esm",
  "dlcrobot.esm",
  "dlcworkshop01.esm",
  "dlcworkshop02.esm",
  "dlcworkshop03.esm",
  "dlccoast.esm",
  "dlcnukaworld.esm",
  "dlcultrahighresolution.esm",
];

/**
 * ─── EVERY GAME THE GATE ACTUALLY RUNS ON ─────────────────────────────────
 * This held two entries while the masters gate ran on five. `comparePlugins`
 * gives Skyrim VR, Fallout 4 VR and Enderal SE the readable Fallout-4
 * plugins.txt format, and `buildPreflight` judges their plugin budgets — so
 * `enabledPlugins` is non-empty on all three and the gate genuinely fires.
 *
 * A base master missing from here is not in `available` either, because the
 * whole reason this table exists is that implicit masters are NOT written to
 * plugins.txt. `checkMasters` then classifies it `missing`, and the gate
 * REFUSES the build with "add the mod that provides each master" — an
 * instruction that cannot be followed for a file that ships with the game.
 *
 * The VR titles carry their own root master alongside the flat-game one:
 * a Fallout 4 VR plugin commonly declares both `Fallout4.esm` and
 * `Fallout4_VR.esm`, and neither was in any list on any code path.
 */
const BASE_MASTERS: Readonly<Record<string, readonly string[]>> = {
  skyrimse: SKYRIM_SE_MASTERS,
  skyrimvr: [...SKYRIM_SE_MASTERS, "skyrimvr.esm"],
  fallout4: FALLOUT_4_MASTERS,
  fallout4vr: [...FALLOUT_4_MASTERS, "fallout4_vr.esm"],
  // Enderal SE is a total conversion built on Skyrim SE: it ships its own
  // master and still declares Skyrim's.
  enderalspecialedition: [
    ...SKYRIM_SE_MASTERS,
    "enderal - forgotten stories.esm",
  ],
};

/**
 * Is this a master the collection is not expected to ship?
 *
 * Two families, and they are excluded for different reasons:
 *
 *  - BASE GAME masters come with the game. Every user has them.
 *  - CREATION CLUB content (`cc*`) is bought per account. The curator cannot
 *    ship it and the user may not own it — so a collection depending on one is
 *    a real prerequisite, but it is NOT a build error, because there is
 *    nothing the curator could do about it. Reported separately rather than
 *    silently allowed.
 */
export function isBaseGameMaster(name: string, gameId: string): boolean {
  return (BASE_MASTERS[gameId] ?? []).includes(name.trim().toLowerCase());
}

/**
 * Creation Club content: bought per account, never shipped by a collection.
 *
 * ─── MEASURED AGAINST REAL FILENAMES ───────────────────────────────────────
 * The shape is `cc` + a 2-4 letter publisher code + the GAME code + digits +
 * a HYPHEN: `ccBGSSSE001-Fish.esm`, `ccQDRSSE001-SurvivalMode.esl`,
 * `ccBGSFO4001-PipBoy(Black).esl`, `ccFSVFO4001-ModularMilitary.esl`.
 *
 * The first two attempts at this both missed. `/^cc[a-z0-9]+_/` required an
 * UNDERSCORE and every real name uses a hyphen, so it matched nothing that
 * ships. `/^cc[a-z]{3}sse\d/` hardcoded `sse`, so it matched all seven Skyrim
 * names tried and none of the eight Fallout 4 ones — and the test fixture was
 * two Skyrim names, the half that worked (GP-4).
 *
 * Getting this wrong is expensive in the blocking direction: an unrecognised
 * CC master is neither base-game nor user-owned, so the build is REFUSED with
 * "add the mod that provides each master" — an instruction the curator cannot
 * follow, because Creation Club content is not shippable.
 */
export function isCreationClubMaster(name: string): boolean {
  return /^cc[a-z]{2,4}(sse|fo4)\d/i.test(name.trim());
}

/**
 * Anniversary Edition's consolidated Creation Club pack.
 *
 * Not in `BASE_MASTERS` — not every Skyrim user has AE — and it does not match
 * the `cc*` shape either, so without naming it a plugin mastered on it hard-
 * refuses the build over a file the curator cannot ship and the user may
 * already own.
 */
const AE_RESOURCE_PACK = "_resourcepack.esl";

/** Neither the collection's job to ship nor a sign of a broken package. */
export function isUserOwnedMaster(name: string, gameId: string): boolean {
  return (
    isBaseGameMaster(name, gameId) ||
    isCreationClubMaster(name) ||
    name.trim().toLowerCase() === AE_RESOURCE_PACK
  );
}
