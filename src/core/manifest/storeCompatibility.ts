/**
 * The store a collection was built on, and why it matters.
 *
 * ─── THE REPORT THIS COMES FROM ─────────────────────────────────────────────
 * A tester's game showed:
 *
 *     SKSE Plugin Loader (2.2.6)
 *     HonedMetal.dll: disabled, incompatible with current version of the game
 *
 * He was on GOG. The collection declares `version: "1.6.1179.0"` with
 * `versionPolicy: "exact"`, and his GOG install IS 1.6.1179.0 — so the version
 * check passed and told him nothing.
 *
 * ─── WHY THE VERSION CHECK CANNOT SEE THIS ──────────────────────────────────
 * GOG and Steam ship Skyrim Special Edition at the same version numbers and
 * DIFFERENT executables. An SKSE plugin is a DLL compiled against a specific
 * runtime's memory layout, resolved through Address Library, and the address
 * IDs differ per store. A DLL built for Steam 1.6.1179 does not load on GOG
 * 1.6.1179, and the version string is identical on both.
 *
 * So the store is a compatibility axis of its own. Event Horizon already KNEW
 * it — `discoveredStore()` is used to find the right `plugins.txt` folder —
 * and simply never recorded it or compared it.
 *
 * ─── WHY IT ONLY WARNS WHEN SKSE PLUGINS ARE PRESENT ────────────────────────
 * A store difference breaks address-library-bound DLLs and nothing else. A
 * texture collection installs across stores perfectly well, and a warning that
 * is usually irrelevant is a warning people learn to skip. So the check fires
 * only when the package actually carries script-extender plugins — and then it
 * NAMES THE MODS, because "which ones do I re-download" is the question the
 * curator answers in their comments section over and over.
 */

import { basenameOf, toPosix } from "../paths";

import type { EhcollMod } from "../../types/ehcoll";

/**
 * A mod that ships at least one script-extender plugin DLL.
 *
 * Named rather than counted: the user has to go and re-download these, one by
 * one, choosing the build for their own store.
 */
export type ScriptExtenderMod = {
  name: string;
  /** The plugin DLLs it ships, for the curious and for a support log. */
  dlls: string[];
};

/**
 * Directories a script extender loads plugins from.
 *
 * Matched case-insensitively on purpose: this is name recognition, not path
 * identity — `SKSE/Plugins` and `skse/plugins` are the same convention on
 * every platform, and mod authors spell it both ways.
 */
const EXTENDER_DIRS = ["skse/plugins/", "f4se/plugins/"];

/**
 * Extensions that are store-bound INSIDE those directories.
 *
 * `.dll` is the obvious one. `.bin` is Address Library's version database
 * (`versionlib-1-6-1170-0.bin`) — the file every other plugin resolves its
 * addresses THROUGH, so a user who re-downloads forty DLLs and keeps the
 * wrong version-lib has fixed nothing. It lives nowhere but these folders.
 */
const EXTENDER_PAYLOAD_EXTS = [".dll", ".bin"];

/**
 * The script extender's own files, which live at the GAME ROOT, not under
 * `SKSE/Plugins`.
 *
 * SKSE64 is staged as a `dinput` mod deploying to the root — measured, on a
 * real 1,753-mod Skyrim profile exactly one mod is `dinput` and it is SKSE64.
 * Its files are `skse64_loader.exe`, `skse64_1_6_1170.dll`,
 * `skse64_steam_loader.dll`, and the loader is the most store-specific thing
 * in the whole collection: with the wrong one the game does not launch at
 * all. Matching only `SKSE/Plugins/*.dll` named forty mods to re-download and
 * omitted the one that has to be done first.
 */
const EXTENDER_BINARY = /^(skse64|skse|f4se)[_.]/i;

/** Does this staged path look like a script-extender plugin? */
export function isScriptExtenderPlugin(relPath: string): boolean {
  const posix = toPosix(relPath).toLowerCase();
  const base = basenameOf(posix);
  // The extender itself, wherever it sits — it deploys to the game root.
  if (EXTENDER_BINARY.test(base)) return true;
  if (!EXTENDER_PAYLOAD_EXTS.some((ext) => posix.endsWith(ext))) return false;
  return EXTENDER_DIRS.some((dir) => posix.includes(dir));
}

/**
 * Which mods in this package ship script-extender plugins.
 *
 * Sorted by name so the list a user reads is stable between runs — an
 * order that shuffles makes two reports impossible to compare.
 */
export function scriptExtenderMods(
  mods: readonly EhcollMod[],
): ScriptExtenderMod[] {
  const out: ScriptExtenderMod[] = [];
  for (const mod of mods) {
    const dlls = (mod.state.stagingFiles ?? [])
      .map((f) => f.path)
      .filter(isScriptExtenderPlugin);
    if (dlls.length > 0) {
      out.push({ name: mod.name, dlls: dlls.map(basenameOf) });
    }
  }
  return out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/**
 * What the user is told when the stores differ.
 *
 * Returns `[]` when there is nothing to say — same store, unknown store on
 * either side, or a package with no extender plugins at all. An absent answer
 * must never be reported as a mismatch: a collection built before the store was
 * recorded has `undefined`, and warning everyone on those would train them to
 * ignore the one case that matters.
 */
export function describeStoreMismatch(args: {
  curatorStore: string | undefined;
  userStore: string | undefined;
  mods: readonly EhcollMod[];
}): string[] {
  const { curatorStore, userStore } = args;
  if (curatorStore === undefined || userStore === undefined) return [];
  if (curatorStore.toLowerCase() === userStore.toLowerCase()) return [];

  const affected = scriptExtenderMods(args.mods);
  if (affected.length === 0) return [];

  const names = affected.map((m) => m.name);
  const shown = names.slice(0, 15);
  return [
    `This collection was built on the ${curatorStore} version of the game and ` +
      `you are on ${userStore}. The two ship the same version number but ` +
      `different executables, so script-extender plugins (.dll files) built ` +
      `for one do not load on the other — the game will report them as ` +
      `"incompatible with current version of the game".`,
    `${affected.length} mod(s) in this collection ship such a plugin. ` +
      `Re-download each from its mod page and pick the ${userStore} build:`,
    ...shown.map((n) => `  • ${n}`),
    ...(names.length > shown.length
      ? [`  • and ${names.length - shown.length} more.`]
      : []),
    `Everything else in the collection is unaffected — textures, meshes, ` +
      `plugins and patches work the same on both stores.`,
  ];
}
