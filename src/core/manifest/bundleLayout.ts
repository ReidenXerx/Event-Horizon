/**
 * Where a bundled mod sits inside a package — names only, no bytes.
 *
 * Kept apart from bundleZip.ts, which reads and writes zips, so the layers
 * that only need the name — the pure resolver, the reader's classification —
 * do not import a zip writer to get it. One spelling for the packager, the
 * reader, the resolver and the installer.
 */

/** The folder a bundled mod's files sit in inside a package: `bundled/<sha256>/`. */
export function bundleFolderInPackage(sha256: string): string {
  return `bundled/${sha256}/`;
}

/** The sha256 a package's bundle folder is named after; `undefined` for anything else. */
export function shaOfBundleFolder(folder: string): string | undefined {
  return /^bundled\/([0-9a-f]{64})\/$/.exec(folder)?.[1];
}

/**
 * The bundled mod a package entry belongs to, and its path inside the mod.
 *
 * `undefined` for anything that is not `bundled/<sha256>/<path>` — which, under
 * `bundled/`, is an entry no package of this schema writes.
 */
export function bundleEntryOf(
  entryName: string,
): { sha256: string; folder: string; path: string } | undefined {
  const m = /^bundled\/([0-9a-f]{64})\/(.+)$/.exec(entryName);
  if (m === null) return undefined;
  return { sha256: m[1]!, folder: bundleFolderInPackage(m[1]!), path: m[2]! };
}
