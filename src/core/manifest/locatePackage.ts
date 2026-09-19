/**
 * Find the `.ehcoll` a receipt came from.
 *
 * Two features need it and neither can work without it: the Collection Doctor
 * repairs by re-running pipeline steps that read the manifest, and "check and
 * continue" hands the package back to the installer. Both start from a
 * receipt, which records the package's NAME and VERSION but not where the file
 * is.
 *
 * Extracted because the Doctor grew this logic inline first, and a second
 * hand-rolled copy in My Collections is how two callers start disagreeing
 * about which package belongs to a collection — the same shape of bug that put
 * `treatAsExternal` into the manifest and past two bundling gates that had
 * never heard of it.
 *
 * Never throws: a missing or unreadable collections folder means "not found",
 * and both callers already handle that by asking the user to point at the file.
 */

import { matchEhcollFile } from "../doctor/heal";

export interface LocatedPackage {
  /** Absolute path to the `.ehcoll`. */
  path: string;
  /** Filename that matched, for the message when we want to name it. */
  fileName: string;
  /**
   * Where it came from. `"kept"` is the copy this tool made when the
   * collection was installed — exact, version-checked and always the right
   * one. `"found"` is a filename match in the collections folder, which is
   * the curator's own build output and the only thing that existed before.
   */
  source: "kept" | "found";
}

export async function locateCollectionPackage(args: {
  /**
   * The receipt's package id. With it, the copy kept at install time is used
   * — no filename guessing, no folder to look in, and nothing for the player
   * to go and find. Optional only because a caller may not have a receipt.
   */
  packageId?: string;
  packageName: string;
  packageVersion: string;
  /**
   * The receipt's Nexus revision, when it has one.
   *
   * The version string is the curator's to retype, so two revisions can share
   * it; the kept copy is then accepted on a match that proves nothing and a
   * repair walks the player backwards into the revision they just left.
   * Passing it lets the store refuse that. Absent is not a mismatch.
   */
  revisionNumber?: number;
  /** Defaults to Vortex's user-data path. Injected by tests. */
  appDataPath?: string;
}): Promise<LocatedPackage | undefined> {
  try {
    const [{ getCollectionsDir, getVortexUserDataPath }, fsp, path] = await Promise.all([
      import("../paths"),
      import("fs/promises"),
      import("path"),
    ]);

    /**
     * ─── THE COPY WE KEPT BEATS ANY SEARCH ─────────────────────────────
     * Matching by file NAME only ever worked for a curator, whose own build
     * output sits in the collections folder under a predictable name. A
     * player installs from a Nexus download named something else entirely, in
     * a folder this never looked in — so the Doctor asked them to go and find
     * the file, weeks later, before it would repair anything.
     *
     * The kept copy is keyed by package id and refuses a version — and, when
     * both sides name one, a REVISION — that is not the installed one, so it
     * cannot answer with the wrong collection.
     */
    if (args.packageId !== undefined) {
      const { readStoredPackage } = await import("../installer/packageStore");
      const kept = await readStoredPackage(
        args.appDataPath ?? getVortexUserDataPath(),
        args.packageId,
        args.packageVersion,
        args.revisionNumber,
      );
      if (kept !== undefined) {
        return { path: kept.path, fileName: kept.meta.fileName, source: "kept" };
      }
    }

    const dir = getCollectionsDir();
    const files = await fsp.readdir(dir).catch(() => [] as string[]);
    const match = matchEhcollFile(
      files,
      args.packageName,
      args.packageVersion,
    );
    if (match === undefined) return undefined;
    return { path: path.join(dir, match), fileName: match, source: "found" };
  } catch {
    return undefined;
  }
}
