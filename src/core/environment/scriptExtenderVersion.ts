/**
 * ──────────────────────────────────────────────────────────────────────
 * What a script-extender plugin says about the game versions it runs on.
 *
 * Almost everything in a collection works on any version of the game —
 * meshes, textures, most plugins. What breaks on a different version is
 * native code: SKSE and F4SE plugins are compiled against one executable's
 * memory layout. So "which mods do I need to swap for my version" is, in
 * practice, "which of these DLLs will not load", and the DLLs say so
 * themselves.
 *
 * ─── HOW THEY SAY IT ───────────────────────────────────────────────────
 * A modern plugin exports a DATA block — `SKSEPlugin_Version` or
 * `F4SEPlugin_Version` — listing the runtimes it supports, or declaring
 * itself independent of the runtime via Address Library or signature
 * scanning. An older one exports only a `…Plugin_Query` FUNCTION, which
 * decides at load time and declares nothing a file reader can see.
 *
 * Measured on a real Skyrim profile: 251 of 252 SKSE plugins declare; 241 of
 * those are independent and 10 are pinned to listed runtimes. On a real
 * Fallout 4 profile: 64 declare (56 independent, 8 pinned) and 40 are
 * query-only.
 *
 * ─── THE TWO STRUCTS ARE NOT THE SAME SHAPE ────────────────────────────
 * Both start `dataVersion, pluginVersion, name[256], author[256]`. SKSE then
 * has a 252-byte `supportEmail` that F4SE does not, so everything after
 * `author` sits 252 bytes later in SKSE. Reading F4SE with SKSE's offsets
 * returns zeros — which is exactly what the first measurement here did.
 *
 *   SKSE  772 versionIndependenceEx  776 versionIndependence  780 compatibleVersions[16]
 *   F4SE  520 addressIndependence    524 structureIndependence 528 compatibleVersions[16]
 *
 * ─── WHAT THIS DELIBERATELY DOES NOT DECIDE ────────────────────────────
 * Whether a plugin LOADS depends on the player's extender too, not only the
 * DLL. Old-gen F4SE (0.6.x) and SE-era SKSE call `Query` and ignore the data
 * block entirely; AE SKSE and next-gen F4SE read the block. A DLL exporting
 * both is loaded either way. So this module reports what the file declares
 * and nothing more — the judgement lives with the caller that knows which
 * extender the player runs.
 * ──────────────────────────────────────────────────────────────────────
 */

// From the module itself rather than the `paths` barrel: the barrel pulls in
// Vortex's API, and a pure file parser must run anywhere, including outside
// Vortex where that does not resolve.
import { toPosix } from "../paths/modPath";
import { parsePeImage, readExportedData } from "./peImage";

export type ScriptExtender = "skse" | "f4se";

export type NativePluginDeclaration =
  /** Exports the version data block. */
  | {
      kind: "declares";
      /** The plugin's own name, from the block. */
      name: string;
      /**
       * Works on any runtime its independence mechanism covers — Address
       * Library or signature scanning — rather than on a fixed list.
       */
      versionIndependent: boolean;
      /** Runtimes it names, e.g. "1.6.1170", "1.6.1179.1". May be empty. */
      runtimes: string[];
      /** Also exports `…Plugin_Query`, so an old-gen extender loads it too. */
      hasQuery: boolean;
    }
  /** Only the old `…Plugin_Query` function: declares nothing readable. */
  | { kind: "query-only" }
  /** A DLL with neither export — a support library, not a plugin. */
  | { kind: "not-a-plugin" };

/**
 * ─── ONE OF THE TWO INDEPENDENCE DWORDS IS NOT MODELLED ────────────────
 * Both extenders declare two: SKSE has `versionIndependenceEx` at 772 beside
 * `versionIndependence` at 776, and F4SE has `structureIndependence` at 524
 * beside `addressIndependence` at 520. Only the second of each pair is read,
 * because what the extenders do with the first could not be established from
 * anything available here — no extender source, no documentation, and a
 * corpus where no plugin sets it.
 *
 * So a plugin rejected on STRUCT compatibility while being address
 * independent would be reported as loading. That is a known unknown rather
 * than an oversight, and it is written down here so the next person does not
 * have to rediscover that the field exists.
 */
const LAYOUT = {
  skse: {
    symbol: "SKSEPlugin_Version",
    query: "SKSEPlugin_Query",
    /** Through `seVersionRequired` at 844. */
    size: 848,
    independence: 776,
    /** AddressLibraryPostAE (1<<0) or Signatures (1<<1). */
    independentMask: 0b11,
    runtimes: 780,
  },
  f4se: {
    symbol: "F4SEPlugin_Version",
    query: "F4SEPlugin_Query",
    /** Through `seVersionRequired` at 592. */
    size: 596,
    independence: 520,
    /**
     * The two ADDRESS-independence flags only — signatures (1<<0) and an
     * Address Library (1<<1) — matching SKSE's mask rather than accepting
     * any bit.
     *
     * `0xffffffff` took a bit this reader does not recognise as proof that
     * the plugin runs anywhere, and version independence short-circuits
     * BEFORE the runtime list is consulted. So a plugin that declared a
     * struct flag and pinned itself to one runtime read as "loads on any
     * version", which is the worst direction to be wrong in: it is then
     * absent from the swap list and silently does nothing in the player's
     * game. No measured plugin sets a bit above 1, so this narrows what is
     * accepted without changing any known answer.
     */
    independentMask: 0b11,
    runtimes: 528,
  },
} as const;

const NAME_OFFSET = 8;
const NAME_LENGTH = 256;
const MAX_RUNTIMES = 16;

/**
 * Runtimes pack as (major<<24)|(minor<<16)|(build<<4)|sub. The sub-version
 * is printed only when set, because it is not noise: `.1` is how SKSE marks
 * the GOG build of 1.6.1179, whose executable itself reports `.0`.
 */
export function formatRuntime(packed: number): string {
  const major = (packed >>> 24) & 0xff;
  const minor = (packed >>> 16) & 0xff;
  const build = (packed >>> 4) & 0xfff;
  const sub = packed & 0xf;
  return `${major}.${minor}.${build}${sub !== 0 ? `.${sub}` : ""}`;
}

/**
 * What this DLL declares, or `undefined` when it is not a readable image.
 * Pure file inspection: nothing is loaded and nothing runs.
 */
export function readNativePluginDeclaration(
  dll: Buffer,
  extender: ScriptExtender,
): NativePluginDeclaration | undefined {
  const image = parsePeImage(dll);
  if (image === undefined) return undefined;
  const layout = LAYOUT[extender];
  const hasQuery = image.exports.has(layout.query);

  if (!image.exports.has(layout.symbol)) {
    return hasQuery ? { kind: "query-only" } : { kind: "not-a-plugin" };
  }

  const block = readExportedData(dll, layout.symbol, layout.size);
  if (block === undefined) {
    // It exports the symbol and the data is not where it points. Saying
    // "query-only" would be a guess about a file that is simply damaged.
    return undefined;
  }

  const nameEnd = block.indexOf(0, NAME_OFFSET);
  const name = block
    .toString("latin1", NAME_OFFSET, nameEnd >= 0 && nameEnd < NAME_OFFSET + NAME_LENGTH ? nameEnd : NAME_OFFSET + NAME_LENGTH)
    .trim();

  const runtimes: string[] = [];
  for (let i = 0; i < MAX_RUNTIMES; i += 1) {
    const packed = block.readUInt32LE(layout.runtimes + i * 4);
    if (packed === 0) break; // zero-terminated
    runtimes.push(formatRuntime(packed));
  }

  return {
    kind: "declares",
    name,
    versionIndependent:
      (block.readUInt32LE(layout.independence) & layout.independentMask) !== 0,
    runtimes,
    hasQuery,
  };
}

/** Which extender a staged path belongs to, from where it sits. */
export function extenderForPath(relativePath: string): ScriptExtender | undefined {
  const p = toPosix(relativePath).toLowerCase();
  if (!p.endsWith(".dll")) return undefined;
  if (/(^|\/)skse\/plugins\/[^/]+$/.test(p)) return "skse";
  if (/(^|\/)f4se\/plugins\/[^/]+$/.test(p)) return "f4se";
  return undefined;
}
