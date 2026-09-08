/**
 * The path service.
 *
 * One import for everything this project does with a path, so the next reader
 * does not have to discover which of six private `toPosix` copies a given
 * module happened to use.
 *
 *   appDataPaths   — where OUR files live: Vortex's userData, our own dirs
 *   modPath        — pure string work: separators, segments, keys, containment
 *   caseSensitivity— what the FILESYSTEM thinks, probed rather than assumed
 *
 * The last split is the point. Every comparison in `modPath` takes a
 * `CaseMode` argument and none of them guess, because folding case is correct
 * on NTFS and merges two genuinely different files on the ext4 under a Proton
 * install.
 *
 * `appDataPaths` was `core/paths.ts` and moved here unchanged: "where does
 * this file live" and "are these two paths the same file" are the same
 * subject, and having them in two modules is how a codebase ends up with six
 * copies of one helper.
 */

export {
  getCollectionsConfigDir,
  getCollectionsDir,
  getEventHorizonDir,
  getEventHorizonRoot,
  getVortexUserDataPath,
} from "./appDataPaths";

export {
  type CaseMode,
  basenameKey,
  basenameOf,
  dirnameOf,
  extensionOf,
  isInside,
  isSafeRelativePath,
  pathKey,
  samePath,
  segmentsOf,
  toPosix,
  unsafePathReason,
} from "./modPath";

export {
  __resetCaseSensitivityCache,
  assumedCaseSensitivity,
  detectCaseSensitivity,
} from "./caseSensitivity";
