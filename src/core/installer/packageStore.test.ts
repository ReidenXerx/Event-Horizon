/**
 * Keeping the collection a player installed, so a repair is one button.
 *
 * ─── THE UX FAILURE ────────────────────────────────────────────────────────
 * Half the Doctor's repairs re-run a step that reads the collection, and
 * nothing ever recorded where the file went. So the tool that could name the
 * exact problem answered a player's "fix my load order" with "first go and
 * find the .ehcoll you installed weeks ago".
 *
 * The rules that make a kept copy SAFE to use are what these tests hold: it
 * belongs to one package id, it must match the version the receipt records,
 * and an interrupted copy must never be mistaken for a whole one.
 */
import * as fsp from "fs/promises";
import * as os from "os";
import * as path from "path";

import { afterEach, describe, expect, it } from "vitest";

import {
  clearStoredPackage,
  getPackageStoreDir,
  readStoredPackage,
  storeInstalledPackage,
} from "./packageStore";

const PKG = "0be2a2bc-bcb7-4eca-8e07-cfd71a406476";

const dirs: string[] = [];
const tmp = async (): Promise<string> => {
  const d = await fsp.mkdtemp(path.join(os.tmpdir(), "eh-package-store-"));
  dirs.push(d);
  return d;
};

afterEach(async () => {
  for (const d of dirs.splice(0)) await fsp.rm(d, { recursive: true, force: true });
});

const sourceFile = async (dir: string, name: string, body: string): Promise<string> => {
  const p = path.join(dir, name);
  await fsp.writeFile(p, body, "utf8");
  return p;
};

const keep = async (
  appData: string,
  sourcePath: string,
  over: Partial<{
    packageVersion: string;
    packageName: string;
    revisionNumber: number;
  }> = {},
): ReturnType<typeof storeInstalledPackage> =>
  storeInstalledPackage({
    appDataPath: appData,
    packageId: PKG,
    packageVersion: over.packageVersion ?? "1.1.8",
    packageName: over.packageName ?? "Gate to SovnGoon",
    ...(over.revisionNumber !== undefined
      ? { revisionNumber: over.revisionNumber }
      : {}),
    sourcePath,
  });

describe("keeping the installed collection", () => {
  it("copies the package and finds it again by package id", async () => {
    const dir = await tmp();
    const src = await sourceFile(dir, "downloaded-rev2.zip", "PK-the-collection");
    const meta = await keep(dir, src);
    expect(meta?.packageVersion).toBe("1.1.8");

    const found = await readStoredPackage(dir, PKG);
    expect(found).toBeDefined();
    expect(await fsp.readFile(found!.path, "utf8")).toBe("PK-the-collection");
    // Kept under the package id, not the download's name: a player's download
    // is called whatever Nexus called it.
    expect(path.dirname(found!.path)).toBe(getPackageStoreDir(dir));
    expect(found!.meta.sourcePath).toBe(src);
  });

  it("refuses a copy from a different version than the one asked for", async () => {
    /**
     * The Doctor diagnoses from the RECEIPT and repairs from the PACKAGE.
     * Handing it a 1.1.9 package for a 1.1.8 receipt would have it repair a
     * collection the player never installed — the same asymmetry that already
     * cost a supervised FOMOD deviation once.
     */
    const dir = await tmp();
    await keep(dir, await sourceFile(dir, "a.zip", "x"), { packageVersion: "1.1.8" });
    expect(await readStoredPackage(dir, PKG, "1.1.8")).toBeDefined();
    expect(await readStoredPackage(dir, PKG, "1.1.9")).toBeUndefined();
  });

  it("replaces the previous copy rather than collecting them", async () => {
    // One collection, one kept package: the one that is installed.
    const dir = await tmp();
    await keep(dir, await sourceFile(dir, "old.ehcoll", "old-bytes"), { packageVersion: "1.1.7" });
    await keep(dir, await sourceFile(dir, "new.zip", "new-bytes"), { packageVersion: "1.1.8" });

    const files = (await fsp.readdir(getPackageStoreDir(dir))).sort();
    expect(files).toEqual([`${PKG}.meta.json`, `${PKG}.zip`]);
    const found = await readStoredPackage(dir, PKG, "1.1.8");
    expect(await fsp.readFile(found!.path, "utf8")).toBe("new-bytes");
  });

  it("does not answer with a copy whose bytes are incomplete", async () => {
    // A truncated copy would surface as a damaged archive much later, in the
    // middle of a repair, and read as a broken collection.
    const dir = await tmp();
    await keep(dir, await sourceFile(dir, "a.zip", "full-bytes"));
    const kept = await readStoredPackage(dir, PKG);
    await fsp.writeFile(kept!.path, "tr", "utf8");
    expect(await readStoredPackage(dir, PKG)).toBeUndefined();
  });

  it("survives being asked to keep a file that is not there", async () => {
    // An install that succeeded must never be reported as failed because a
    // copy could not be made.
    const dir = await tmp();
    await expect(keep(dir, path.join(dir, "gone.zip"))).resolves.toBeUndefined();
    expect(await readStoredPackage(dir, PKG)).toBeUndefined();
    // And it leaves no half-written file behind.
    expect(await fsp.readdir(getPackageStoreDir(dir)).catch(() => [])).toEqual([]);
  });

  it("does not truncate the kept package when asked to keep it again", async () => {
    // What a repair does: it installs FROM the store, so the next receipt
    // hands this function its own copy as the source.
    const dir = await tmp();
    await keep(dir, await sourceFile(dir, "a.zip", "the-bytes"));
    const kept = await readStoredPackage(dir, PKG);
    const again = await keep(dir, kept!.path);
    expect(again).toBeDefined();
    expect(await fsp.readFile(kept!.path, "utf8")).toBe("the-bytes");
  });

  it("forgets a collection on request, file and record together", async () => {
    const dir = await tmp();
    await keep(dir, await sourceFile(dir, "a.zip", "x"));
    await clearStoredPackage(dir, PKG);
    expect(await readStoredPackage(dir, PKG)).toBeUndefined();
    expect(await fsp.readdir(getPackageStoreDir(dir)).catch(() => [])).toEqual([]);
  });

  it("treats a store that was never written as nothing kept", async () => {
    expect(await readStoredPackage(await tmp(), PKG)).toBeUndefined();
  });
});

describe("the kept package does not outlive the collection", () => {
  /**
   * A full package is gigabytes when the curator bundles mods, and it exists
   * only to serve one receipt. An uninstall that deletes the receipt and
   * leaves the package behind is a silent, permanent leak that no screen would
   * ever show — so the wiring is pinned in source, the way `locatePackage`'s
   * callers are.
   */
  // The uninstall moved into its executor (runCollectionUninstall.ts), which runCollectionUninstall.test.ts
  // also checks by behaviour; this keeps the source-level pin on the file that now holds the wiring.
  const page = path.join(__dirname, "runCollectionUninstall.ts");
  const text = (): string => require("fs").readFileSync(page, "utf8") as string;

  it("has the anchors it looks for, so this cannot go vacuous", () => {
    const s = text();
    expect(s.length).toBeGreaterThan(0);
    expect(s).toContain("deps.deleteReceipt(");
  });

  it("clears the kept package in the same branch that deletes the receipt", () => {
    const s = text();
    const del = s.indexOf("deps.deleteReceipt(");
    const clear = s.indexOf("deps.clearStoredPackage(");
    expect(clear).toBeGreaterThan(-1);
    // Right after the delete, inside the same `failed.length === 0`
    // branch — never in the path that KEEPS the receipt because mods survive.
    expect(clear).toBeGreaterThan(del);
    expect(s.slice(del, clear)).not.toContain("receipt-kept");
  });
});

/**
 * ──────────────────────────────────────────────────────────────────────
 * A version string is not an identity.
 *
 * The curator types it, so two revisions can carry the same one — and
 * `storeInstalledPackage` swallows every failure deliberately, because a
 * finished install must not be reported as broken over a housekeeping copy.
 * Put together: update to a new revision that kept its version, the copy
 * fails on a full disk, and the store still holds the PREVIOUS revision's
 * archive under a version that matches. The Doctor then repairs from it and
 * walks the player backwards into the revision they just left, with every
 * check passing.
 * ──────────────────────────────────────────────────────────────────────
 */
describe("the kept copy must be the right REVISION, not just the right version", () => {
  it("refuses a stored copy whose revision is not the one asked for", async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "eh-pkg-rev-"));
    try {
      const src = await sourceFile(dir, "c.ehcoll", "rev-12 bytes");
      await keep(dir, src, { packageVersion: "1.1.8", revisionNumber: 12 });

      // Same version string, different revision: not this install's package.
      expect(await readStoredPackage(dir, PKG, "1.1.8", 13)).toBeUndefined();
      // The matching revision is still served.
      expect(await readStoredPackage(dir, PKG, "1.1.8", 12)).toBeDefined();
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });

  it("falls back to the version check when either side has no revision", async () => {
    // A copy kept before this field existed, or one from a file install, has
    // nothing to compare. Unknown is not a mismatch — refusing here would
    // retire the kept copy for everyone who has not reinstalled since.
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "eh-pkg-rev-"));
    try {
      const src = await sourceFile(dir, "c.ehcoll", "legacy bytes");
      await keep(dir, src, { packageVersion: "1.1.8" });
      expect(await readStoredPackage(dir, PKG, "1.1.8", 13)).toBeDefined();

      const dir2 = await fsp.mkdtemp(path.join(os.tmpdir(), "eh-pkg-rev2-"));
      try {
        const src2 = await sourceFile(dir2, "c.ehcoll", "rev bytes");
        await keep(dir2, src2, { packageVersion: "1.1.8", revisionNumber: 12 });
        // Caller does not know the revision: the version still decides.
        expect(await readStoredPackage(dir2, PKG, "1.1.8")).toBeDefined();
      } finally {
        await fsp.rm(dir2, { recursive: true, force: true });
      }
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });

  it("still refuses a mismatched VERSION regardless of revision", async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "eh-pkg-rev-"));
    try {
      const src = await sourceFile(dir, "c.ehcoll", "bytes");
      await keep(dir, src, { packageVersion: "1.1.8", revisionNumber: 12 });
      expect(await readStoredPackage(dir, PKG, "1.2.0", 12)).toBeUndefined();
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });
});
