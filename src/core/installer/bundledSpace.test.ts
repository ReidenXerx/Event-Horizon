/**
 * A bundled mod's archive is checked for room before it is written to the temp
 * drive, and again before Vortex copies it into its download folder and unpacks
 * it into staging. Pinned: the write claims room for the size its zip can
 * reach; a short drive refuses before anything is written or handed to Vortex;
 * and the temp folder does not outlive a refusal.
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const space = vi.hoisted(() => ({
  refuseClaim: false,
  refuseRequire: false,
  claimed: [] as Array<{ dir: string; bytes: number; what: string }>,
}));

vi.mock("../../utils/diskSpace", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../utils/diskSpace")>();
  const short = (): never => {
    throw new real.DiskSpaceError([
      { dir: "D:\\Temp", neededBytes: 2 * 1024 ** 3, freeBytes: 1024 ** 3, what: ["the archive (2.00 GB)"] },
    ]);
  };
  return {
    ...real,
    claimFreeSpace: async (...args: Parameters<typeof real.claimFreeSpace>) => {
      space.claimed.push(args[0]);
      return space.refuseClaim ? short() : real.claimFreeSpace(...args);
    },
    requireFreeSpace: async (...args: Parameters<typeof real.requireFreeSpace>) =>
      space.refuseRequire ? short() : real.requireFreeSpace(...args),
  };
});

import { bundleEntries, writePackage, type BundleContent } from "../manifest/bundlePackage.testutil";
import { bundleZipBytesAtMost } from "../manifest/bundleZip";
import { installFromBundledArchive, writeBundledArchive } from "./modInstall";
// eslint-disable-next-line import/no-relative-packages
import { __testPaths } from "../../../test/stubs/vortex-api";

const MOD: BundleContent = {
  "Plugin.esp": "TES4 plugin bytes",
  "Textures/armor/cuirass.dds": "DDS texture bytes",
};

let dir: string;
let prevDownload: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "eh-bundled-space-"));
  prevDownload = __testPaths.downloadPath;
  __testPaths.downloadPath = path.join(dir, "downloads");
  fs.mkdirSync(__testPaths.downloadPath, { recursive: true });
  space.refuseClaim = false;
  space.refuseRequire = false;
  space.claimed.length = 0;
});
afterEach(() => {
  __testPaths.downloadPath = prevDownload;
  fs.rmSync(dir, { recursive: true, force: true });
});

/** Run with os.tmpdir() pointed at a private, empty folder, so what is left in it can be counted exactly. */
async function inPrivateTemp(run: (tmp: string) => Promise<void>): Promise<void> {
  const isolated = fs.mkdtempSync(path.join(dir, "tmp-"));
  const names = ["TMPDIR", "TEMP", "TMP"] as const;
  const saved = names.map((n) => [n, process.env[n]] as const);
  for (const n of names) process.env[n] = isolated;
  try {
    expect(os.tmpdir()).toBe(isolated);
    await run(isolated);
  } finally {
    for (const [n, v] of saved) {
      if (v === undefined) delete process.env[n];
      else process.env[n] = v;
    }
  }
}

describe("writing a bundled mod's archive", () => {
  it("claims room on the temp drive for the size its zip can reach", async () => {
    const { folder, entries } = await bundleEntries(MOD);
    const pkg = writePackage(dir, "p.ehcoll", entries);
    await inPrivateTemp(async (tmp) => {
      const { tempDir } = await writeBundledArchive(pkg, folder, "Armor");
      expect(path.dirname(tempDir)).toBe(tmp);
      expect(space.claimed).toHaveLength(1);
      expect(space.claimed[0]!.dir).toBe(tempDir);
      expect(space.claimed[0]!.bytes).toBe(
        bundleZipBytesAtMost(Object.entries(MOD).map(([p, body]) => ({ path: p, size: Buffer.byteLength(body) }))),
      );
      expect(space.claimed[0]!.what).toContain('"Armor"');
    });
  });

  it("is refused before anything is written when the temp drive is short, and leaves no temp folder", async () => {
    const { folder, entries } = await bundleEntries(MOD);
    const pkg = writePackage(dir, "p.ehcoll", entries);
    space.refuseClaim = true;
    await inPrivateTemp(async (tmp) => {
      await expect(writeBundledArchive(pkg, folder, "Armor")).rejects.toThrow(
        /Not enough free space on the drive holding/,
      );
      expect(fs.readdirSync(tmp)).toEqual([]);
    });
  });
});

describe("handing a bundled mod's archive to Vortex", () => {
  it("is refused before Vortex sees it when the download or staging drive is short, and removes the temp folder", async () => {
    const tempDir = path.join(dir, "extracted");
    fs.mkdirSync(tempDir, { recursive: true });
    const extractedPath = path.join(tempDir, "BundledMod.zip");
    fs.writeFileSync(extractedPath, Buffer.alloc(64, 3));
    const emits: string[] = [];
    const api = {
      events: {
        emit: (event: string) => {
          emits.push(event);
        },
        on: () => undefined,
        removeListener: () => undefined,
      },
      store: { dispatch: () => undefined, getState: () => ({}) },
      getState: () => ({}),
    } as never;
    space.refuseRequire = true;

    await expect(
      installFromBundledArchive(api, {
        gameId: "fallout4",
        ehcollZipPath: "C:/nowhere/pkg.ehcoll",
        bundleFolder: "bundled/abc/",
        preExtracted: { extractedPath, tempDir },
      }),
    ).rejects.toThrow(/Not enough free space on the drive holding/);
    expect(emits).toEqual([]);
    expect(fs.existsSync(tempDir)).toBe(false);
  });
});
