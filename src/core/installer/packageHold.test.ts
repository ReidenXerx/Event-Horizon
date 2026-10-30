/**
 * .frenchkiwi, Ivy 1.0.56 (2026-10-31): Vortex's download of the collection
 * was deleted 23 minutes into the install, and every bundled mod after that
 * failed with "No file at". The run now reads its own name for the file.
 */
import * as fsp from "fs/promises";
import * as os from "os";
import * as path from "path";

import { afterEach, describe, expect, it } from "vitest";

import { holdPackageForRun, releaseHeldPackage } from "./packageStore";

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await fsp.rm(d, { recursive: true, force: true });
});

describe("the run holds its own copy of the package", () => {
  it("survives the download being deleted mid-install, and is released afterwards", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "eh-hold-"));
    dirs.push(root);
    const download = path.join(root, "downloads", "collection_dmt85e_26.zip");
    await fsp.mkdir(path.dirname(download), { recursive: true });
    await fsp.writeFile(download, "package bytes");

    const held = await holdPackageForRun(path.join(root, "appdata"), "pkg-1", download);
    expect(held).toBeDefined();
    expect(path.basename(held!.path)).toBe("pkg-1.zip");

    await fsp.rm(download);
    expect(await fsp.readFile(held!.path, "utf8")).toBe("package bytes");

    await releaseHeldPackage(held!.path);
    await expect(fsp.stat(held!.path)).rejects.toThrow();
  });

  it("a second run replaces the previous hold instead of failing on it", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "eh-hold-"));
    dirs.push(root);
    const a = path.join(root, "a.zip");
    const b = path.join(root, "b.zip");
    await fsp.writeFile(a, "rev 26");
    await fsp.writeFile(b, "rev 27");
    await holdPackageForRun(path.join(root, "appdata"), "pkg-1", a);
    const held = await holdPackageForRun(path.join(root, "appdata"), "pkg-1", b);
    expect(await fsp.readFile(held!.path, "utf8")).toBe("rev 27");
  });

  it("a missing source is not held: the run reads the original and fails there, as before", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "eh-hold-"));
    dirs.push(root);
    expect(await holdPackageForRun(path.join(root, "appdata"), "pkg-1", path.join(root, "gone.zip"))).toBeUndefined();
  });
});
