/**
 * ──────────────────────────────────────────────────────────────────────
 * The collection a player installed, kept, so the Doctor never has to ask.
 *
 * ─── THE UX FAILURE ────────────────────────────────────────────────────
 * Three of the Doctor's six repairs re-run a pipeline step that reads the
 * collection MANIFEST — mod rules, the LOOT userlist, reinstalling a changed
 * mod — and the deep scan reads it too. None of them could run without the
 * `.ehcoll`, and nothing ever recorded where it went. So a player whose load
 * order had drifted was told to go and find the file they installed from,
 * weeks later, possibly after clearing their downloads folder, before the tool
 * that knows exactly what is wrong would agree to fix it.
 *
 * The tool had that file in its hands at install time. Keeping it is the
 * entire fix, and it makes every repair a single button.
 *
 * ─── ONE PER COLLECTION, THE ONE THAT IS INSTALLED ─────────────────────
 * Written when a run SUCCEEDS, beside the receipt it belongs to, and replacing
 * the previous copy. That pairing is the load-bearing part: the receipt is
 * what the Doctor diagnoses from, and a stored package from a *different*
 * version than the receipt would have it diagnose one collection and repair
 * with another (the mistake `vortex-doctor-receipt-vs-manifest` already
 * records in the other direction). {@link readStoredPackage} refuses a copy
 * whose version does not match what the caller expects, rather than trusting
 * the filename.
 *
 * A failed or aborted run stores NOTHING, for the same reason: it would
 * replace the good copy that matches the receipt with one that does not.
 *
 * ─── COST ──────────────────────────────────────────────────────────────
 * A full copy of the package, which is gigabytes when the curator bundles or
 * mirrors mods. Chosen deliberately (owner, 2026-09-18) over keeping only the
 * manifest: it makes every repair work with no conditions, and NS-1 puts
 * reliability above what things cost in space.
 *
 * Every failure here is swallowed and logged. A collection that installed
 * correctly must not be reported as broken because a copy could not be made —
 * the consequence is only that the Doctor will have to ask.
 * ──────────────────────────────────────────────────────────────────────
 */

import * as fsp from "fs/promises";
import * as path from "path";

import { ehLog } from "../logging/ehLog";

/** What was kept, written beside the file it describes. */
export type StoredPackageMeta = {
  packageId: string;
  /** Must match the receipt's `packageVersion` before the copy is used. */
  packageVersion: string;
  /**
   * The Nexus collection revision this copy is, when it came from a page.
   *
   * ─── BECAUSE THE VERSION IS NOT AN IDENTITY ─────────────────────────
   * The version string is typed by the curator, so two different revisions
   * can carry the same one. `storeInstalledPackage` swallows every failure —
   * deliberately, since a finished install must not be reported as broken
   * over a housekeeping copy — and the likeliest time to fail is exactly
   * when the package is the multi-gigabyte mirrored kind.
   *
   * Put together: update to a new revision that kept its version, the copy
   * fails on a full disk, and the store still holds the PREVIOUS revision's
   * archive under a version string that matches. `locatePackage` then offers
   * it as "kept" and the Doctor's repair hands the old manifest to the
   * installer, walking the player backwards into the revision they just
   * left, with every check passing.
   *
   * Absent when the package did not come from a collection page, and absent
   * is not a mismatch — a file install has no revision to disagree about.
   */
  revisionNumber?: number;
  packageName: string;
  /** File name inside the store, e.g. `<id>.ehcoll`. */
  fileName: string;
  sizeBytes: number;
  /** Where the player installed it from. For the log, never for reading. */
  sourcePath: string;
  storedAt: string;
};

export function getPackageStoreDir(appDataPath: string): string {
  return path.join(appDataPath, "event-horizon", "packages");
}

function metaPath(appDataPath: string, packageId: string): string {
  return path.join(getPackageStoreDir(appDataPath), `${packageId}.meta.json`);
}

/**
 * Keep this run's package. Never throws.
 *
 * Copied to a temporary name and renamed into place, so an interrupted copy
 * can never be mistaken for a complete one — the meta file, written last, is
 * what makes a copy readable at all.
 */
export async function storeInstalledPackage(input: {
  appDataPath: string;
  packageId: string;
  packageVersion: string;
  /** See {@link StoredPackageMeta.revisionNumber}. */
  revisionNumber?: number;
  packageName: string;
  sourcePath: string;
}): Promise<StoredPackageMeta | undefined> {
  const dir = getPackageStoreDir(input.appDataPath);
  const ext = path.extname(input.sourcePath) === "" ? ".ehcoll" : path.extname(input.sourcePath);
  const fileName = `${input.packageId}${ext}`;
  const dest = path.join(dir, fileName);
  const partial = `${dest}.partial`;

  try {
    // Installing FROM the store is what a repair does. Copying a file over
    // itself would truncate it.
    if (path.resolve(input.sourcePath) === path.resolve(dest)) {
      const existing = await readStoredPackage(input.appDataPath, input.packageId);
      if (existing !== undefined) return existing.meta;
    }

    await fsp.mkdir(dir, { recursive: true });
    await fsp.rm(partial, { force: true });
    await fsp.copyFile(input.sourcePath, partial);
    const size = (await fsp.stat(partial)).size;
    await fsp.rm(dest, { force: true });
    await fsp.rename(partial, dest);

    // Any earlier copy under a different extension is now a second answer to
    // one question. There can be only one.
    for (const stale of await fsp.readdir(dir).catch(() => [])) {
      if (stale.startsWith(`${input.packageId}.`) && stale !== fileName && !stale.endsWith(".meta.json")) {
        await fsp.rm(path.join(dir, stale), { force: true }).catch(() => undefined);
      }
    }

    const meta: StoredPackageMeta = {
      packageId: input.packageId,
      packageVersion: input.packageVersion,
      ...(input.revisionNumber !== undefined
        ? { revisionNumber: input.revisionNumber }
        : {}),
      packageName: input.packageName,
      fileName,
      sizeBytes: size,
      sourcePath: input.sourcePath,
      storedAt: new Date().toISOString(),
    };
    await fsp.writeFile(metaPath(input.appDataPath, input.packageId), JSON.stringify(meta, null, 2), "utf8");
    ehLog("info", "package-store.kept", {
      packageId: input.packageId,
      packageVersion: input.packageVersion,
      sizeBytes: size,
      why: "so the Doctor can repair this collection without asking for the file",
    });
    return meta;
  } catch (err) {
    await fsp.rm(partial, { force: true }).catch(() => undefined);
    ehLog("warn", "package-store.keep.failed", {
      packageId: input.packageId,
      sourcePath: input.sourcePath,
      consequence:
        "repairs that read the collection will ask for the file, or download " +
        "it again, exactly as they did before",
      err,
    });
    return undefined;
  }
}

/**
 * The kept package for this collection, if there is a usable one.
 *
 * `expectVersion` is how a caller states which collection it is repairing. A
 * copy from another version is refused rather than returned with a warning:
 * the caller would have to remember to check, and the one that forgets
 * silently repairs with the wrong collection.
 */
export async function readStoredPackage(
  appDataPath: string,
  packageId: string,
  expectVersion?: string,
  /**
   * The revision the caller expects. A stored copy that names a DIFFERENT
   * one is refused even when the version strings agree — see
   * {@link StoredPackageMeta.revisionNumber}.
   */
  expectRevision?: number,
): Promise<{ path: string; meta: StoredPackageMeta } | undefined> {
  let meta: StoredPackageMeta;
  try {
    const raw = await fsp.readFile(metaPath(appDataPath, packageId), "utf8");
    const parsed = JSON.parse(raw) as Partial<StoredPackageMeta>;
    if (
      typeof parsed.packageId !== "string" ||
      typeof parsed.packageVersion !== "string" ||
      typeof parsed.fileName !== "string"
    ) {
      return undefined;
    }
    meta = {
      packageId: parsed.packageId,
      packageVersion: parsed.packageVersion,
      ...(typeof parsed.revisionNumber === "number" &&
      Number.isInteger(parsed.revisionNumber)
        ? { revisionNumber: parsed.revisionNumber }
        : {}),
      packageName: typeof parsed.packageName === "string" ? parsed.packageName : "",
      fileName: parsed.fileName,
      sizeBytes: typeof parsed.sizeBytes === "number" ? parsed.sizeBytes : 0,
      sourcePath: typeof parsed.sourcePath === "string" ? parsed.sourcePath : "",
      storedAt: typeof parsed.storedAt === "string" ? parsed.storedAt : "",
    };
  } catch {
    return undefined;
  }

  if (expectVersion !== undefined && meta.packageVersion !== expectVersion) {
    ehLog("info", "package-store.version-mismatch", {
      packageId,
      stored: meta.packageVersion,
      wanted: expectVersion,
      consequence: "the kept package is not this install's, so it is not used",
    });
    return undefined;
  }

  /**
   * Revisions disagreeing beats version strings agreeing.
   *
   * Only when BOTH sides name one: a copy kept before this field existed, or
   * one from a file install, has nothing to compare and falls back to the
   * version check exactly as before. Unknown is not a mismatch.
   */
  if (
    expectRevision !== undefined &&
    meta.revisionNumber !== undefined &&
    meta.revisionNumber !== expectRevision
  ) {
    ehLog("info", "package-store.revision-mismatch", {
      packageId,
      stored: meta.revisionNumber,
      wanted: expectRevision,
      consequence:
        "the kept package is an older revision under the same version " +
        "string, so it is not used — repairing from it would walk the " +
        "player backwards into the revision they just left",
    });
    return undefined;
  }

  const file = path.join(getPackageStoreDir(appDataPath), meta.fileName);
  try {
    const st = await fsp.stat(file);
    // A truncated copy is worse than no copy: it reads as a damaged archive
    // much later, in the middle of a repair.
    if (meta.sizeBytes > 0 && st.size !== meta.sizeBytes) {
      ehLog("warn", "package-store.size-mismatch", {
        packageId,
        expected: meta.sizeBytes,
        actual: st.size,
        consequence: "the kept package looks incomplete and is not used",
      });
      return undefined;
    }
  } catch {
    return undefined;
  }
  return { path: file, meta };
}

/** Forget the kept package for a collection (it was uninstalled, or replaced). */
export async function clearStoredPackage(
  appDataPath: string,
  packageId: string,
): Promise<void> {
  const dir = getPackageStoreDir(appDataPath);
  try {
    await fsp.rm(metaPath(appDataPath, packageId), { force: true });
    for (const name of await fsp.readdir(dir).catch(() => [])) {
      if (name.startsWith(`${packageId}.`)) {
        await fsp.rm(path.join(dir, name), { force: true }).catch(() => undefined);
      }
    }
  } catch (err) {
    ehLog("info", "package-store.clear.failed", { packageId, err });
  }
}
