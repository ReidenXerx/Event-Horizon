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
  over: Partial<{ packageVersion: string; packageName: string }> = {},
): ReturnType<typeof storeInstalledPackage> =>
  storeInstalledPackage({
    appDataPath: appData,
    packageId: PKG,
    packageVersion: over.packageVersion ?? "1.1.8",
    packageName: over.packageName ?? "Gate to SovnGoon",
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
