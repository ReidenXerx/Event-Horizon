/**
 * The mirror, executed — real files, a real ZIP, the real extractor.
 *
 * `mirrorStaging.test.ts` covers the decision; nothing there touches a disk.
 * This runs the half that does, because the two failures that cost this
 * project releases were both in code no test ever EXECUTED. A plan that is
 * right and an applier that writes to the wrong path fail identically from the
 * outside.
 *
 * The ZIP is built here rather than mocked: `extractZipEntryToFile` is the
 * thing under test, and a stub that returns bytes proves the stub works.
 */
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  applyMirrorPlan,
  describeMirrorOutcome,
  mirrorEntryFor,
  replaceFile,
} from "./applyMirrors";
import { planMirror } from "./mirrorStaging";
import { crc32 } from "../manifest/readZip";
import type { SevenZipApi, SevenZipListEntry } from "../manifest/sevenZip";
import { makeZip } from "../../../test/makeZip";

const sha = (b: Buffer): string => createHash("sha256").update(b).digest("hex");

let dir: string;
let staging: string;
let ehcoll: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "eh-mirror-t-"));
  staging = join(dir, "staging");
  ehcoll = join(dir, "pkg.ehcoll");
  await mkdir(staging, { recursive: true });
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const CLEANED = Buffer.from("the curator's cleaned plugin");
const STOCK = Buffer.from("whatever the archive produced");

describe("applying a mirror to a real folder", () => {
  it("writes a file the user does not have", async () => {
    await writeFile(ehcoll, makeZip([
      { name: mirrorEntryFor(sha(CLEANED)), data: CLEANED },
    ]));

    const outcome = await applyMirrorPlan({
      stagingRoot: staging,
      ehcollPath: ehcoll,
      plan: planMirror({
        target: [{ path: "Data/x.esp", size: CLEANED.length, sha256: sha(CLEANED) }],
        current: [],
      }),
    });

    expect(outcome).toMatchObject({ restored: 1, removed: 0, failures: [] });
    expect(await readFile(join(staging, "Data", "x.esp"))).toEqual(CLEANED);
  });

  it("replaces a file whose bytes differ, and creates missing folders", async () => {
    await mkdir(join(staging, "Data"), { recursive: true });
    await writeFile(join(staging, "Data", "x.esp"), STOCK);
    await writeFile(ehcoll, makeZip([
      { name: mirrorEntryFor(sha(CLEANED)), data: CLEANED },
    ]));

    await applyMirrorPlan({
      stagingRoot: staging,
      ehcollPath: ehcoll,
      plan: planMirror({
        target: [{ path: "Data/x.esp", size: CLEANED.length, sha256: sha(CLEANED) }],
        current: [{ path: "Data/x.esp", size: STOCK.length, sha256: sha(STOCK) }],
      }),
    });

    expect(await readFile(join(staging, "Data", "x.esp"))).toEqual(CLEANED);
  });

  it("removes a file the curator does not have", async () => {
    await writeFile(join(staging, "leftover.esp"), STOCK);
    await writeFile(ehcoll, makeZip([
      { name: mirrorEntryFor(sha(CLEANED)), data: CLEANED },
    ]));

    const outcome = await applyMirrorPlan({
      stagingRoot: staging,
      ehcollPath: ehcoll,
      plan: planMirror({
        target: [{ path: "keep.esp", size: CLEANED.length, sha256: sha(CLEANED) }],
        current: [{ path: "leftover.esp", size: STOCK.length, sha256: sha(STOCK) }],
      }),
    });

    expect(outcome.removed).toBe(1);
    expect(existsSync(join(staging, "leftover.esp"))).toBe(false);
    expect(existsSync(join(staging, "keep.esp"))).toBe(true);
  });
});

describe("a blob that is not what it claims", () => {
  it("is NOT written, and is reported", async () => {
    // The package is content-addressed, so the entry name is the expectation.
    // Writing bytes that fail it would be a mirror that installs the wrong
    // file and calls it success — the one outcome worse than stopping.
    await writeFile(ehcoll, makeZip([
      { name: mirrorEntryFor(sha(CLEANED)), data: STOCK },
    ]));

    const outcome = await applyMirrorPlan({
      stagingRoot: staging,
      ehcollPath: ehcoll,
      plan: planMirror({
        target: [{ path: "x.esp", size: CLEANED.length, sha256: sha(CLEANED) }],
        current: [],
      }),
    });

    expect(outcome.restored).toBe(0);
    expect(outcome.failures).toHaveLength(1);
    expect(outcome.failures[0]!.why).toContain("not the file the manifest describes");
    expect(existsSync(join(staging, "x.esp"))).toBe(false);
  });

  it("leaves the existing file untouched rather than half-replacing it", async () => {
    await writeFile(join(staging, "x.esp"), STOCK);
    await writeFile(ehcoll, makeZip([
      { name: mirrorEntryFor(sha(CLEANED)), data: Buffer.from("corrupt") },
    ]));

    await applyMirrorPlan({
      stagingRoot: staging,
      ehcollPath: ehcoll,
      plan: planMirror({
        target: [{ path: "x.esp", size: CLEANED.length, sha256: sha(CLEANED) }],
        current: [{ path: "x.esp", size: STOCK.length, sha256: sha(STOCK) }],
      }),
    });

    expect(await readFile(join(staging, "x.esp"))).toEqual(STOCK);
  });

  it("keeps going after one failure", async () => {
    const OTHER = Buffer.from("second file, perfectly fine");
    await writeFile(ehcoll, makeZip([
      { name: mirrorEntryFor(sha(CLEANED)), data: Buffer.from("wrong") },
      { name: mirrorEntryFor(sha(OTHER)), data: OTHER },
    ]));

    const outcome = await applyMirrorPlan({
      stagingRoot: staging,
      ehcollPath: ehcoll,
      plan: planMirror({
        target: [
          { path: "bad.esp", size: CLEANED.length, sha256: sha(CLEANED) },
          { path: "good.esp", size: OTHER.length, sha256: sha(OTHER) },
        ],
        current: [],
      }),
    });

    expect(outcome.restored).toBe(1);
    expect(outcome.failures).toHaveLength(1);
    expect(await readFile(join(staging, "good.esp"))).toEqual(OTHER);
  });

  it("reports a blob the package does not carry at all", async () => {
    await writeFile(ehcoll, makeZip([{ name: "unrelated", data: STOCK }]));

    const outcome = await applyMirrorPlan({
      stagingRoot: staging,
      ehcollPath: ehcoll,
      plan: planMirror({
        target: [{ path: "x.esp", size: CLEANED.length, sha256: sha(CLEANED) }],
        current: [],
      }),
    });

    expect(outcome.restored).toBe(0);
    expect(outcome.failures).toHaveLength(1);
  });
});

describe("a file the package leaves to the mod's own archive", () => {
  // The package does not carry these: the build proved the mod's archive
  // installs each byte for byte. The mirror still has to heal one the install
  // did not produce, which it used to do from the package.
  const modZip = (): string => join(dir, "mod.zip");
  const hex = (b: Buffer): string => (crc32(b) >>> 0).toString(16).padStart(8, "0");

  it("is taken from the archive when the install did not produce it", async () => {
    await writeFile(ehcoll, makeZip([{ name: "unrelated", data: STOCK }]));
    await writeFile(modZip(), makeZip([{ name: "My Mod/Data/x.esp", data: STOCK }]));

    const outcome = await applyMirrorPlan({
      stagingRoot: staging,
      ehcollPath: ehcoll,
      plan: planMirror({
        target: [{ path: "Data/x.esp", size: STOCK.length, sha256: sha(STOCK) }],
        current: [],
      }),
      fromArchive: { paths: new Set(["Data/x.esp"]), archivePath: modZip() },
    });

    expect(outcome).toMatchObject({
      restored: 1,
      failures: [],
      fromArchive: { wanted: 1, restored: 1 },
    });
    expect(await readFile(join(staging, "Data", "x.esp"))).toEqual(STOCK);
  });

  it("writes nothing, and deletes nothing, when the archive's file there is not the recorded one", async () => {
    const OTHER_BYTES = Buffer.from("whatever the archive producer");
    expect(OTHER_BYTES.length).toBe(STOCK.length);
    await writeFile(ehcoll, makeZip([{ name: "unrelated", data: STOCK }]));
    await writeFile(modZip(), makeZip([{ name: "Data/x.esp", data: OTHER_BYTES }]));
    await writeFile(join(staging, "extra.esp"), CLEANED);

    const outcome = await applyMirrorPlan({
      stagingRoot: staging,
      ehcollPath: ehcoll,
      plan: planMirror({
        target: [{ path: "Data/x.esp", size: STOCK.length, sha256: sha(STOCK) }],
        current: [{ path: "extra.esp", size: CLEANED.length, sha256: sha(CLEANED) }],
      }),
      fromArchive: { paths: new Set(["Data/x.esp"]), archivePath: modZip() },
    });

    expect(outcome.restored).toBe(0);
    expect(outcome.failures).toEqual([
      {
        path: "Data/x.esp",
        why: expect.stringContaining("none holds the bytes the curator recorded"),
      },
    ]);
    expect(outcome.removalsSkipped).toBe(1);
    expect(existsSync(join(staging, "Data", "x.esp"))).toBe(false);
    expect(existsSync(join(staging, "extra.esp"))).toBe(true);
  });

  it("says so when the archive has no file of that size at that path", async () => {
    await writeFile(ehcoll, makeZip([{ name: "unrelated", data: STOCK }]));
    await writeFile(modZip(), makeZip([{ name: "Data/other.esp", data: STOCK }]));

    const outcome = await applyMirrorPlan({
      stagingRoot: staging,
      ehcollPath: ehcoll,
      plan: planMirror({
        target: [{ path: "Data/x.esp", size: STOCK.length, sha256: sha(STOCK) }],
        current: [],
      }),
      fromArchive: { paths: new Set(["Data/x.esp"]), archivePath: modZip() },
    });

    expect(outcome.failures).toEqual([
      {
        path: "Data/x.esp",
        why: expect.stringContaining("has no file of this size at this path"),
      },
    ]);
  });

  it("names the archive as missing when Vortex has no record of it", async () => {
    await writeFile(ehcoll, makeZip([{ name: "unrelated", data: STOCK }]));

    const outcome = await applyMirrorPlan({
      stagingRoot: staging,
      ehcollPath: ehcoll,
      plan: planMirror({
        target: [{ path: "Data/x.esp", size: STOCK.length, sha256: sha(STOCK) }],
        current: [],
      }),
      fromArchive: { paths: new Set(["Data/x.esp"]), archivePath: undefined },
    });

    expect(outcome.failures).toEqual([
      { path: "Data/x.esp", why: expect.stringContaining("no record of that archive") },
    ]);
  });

  it("still reads the package for every file it does not leave to the archive", async () => {
    await writeFile(ehcoll, makeZip([{ name: mirrorEntryFor(sha(CLEANED)), data: CLEANED }]));
    await writeFile(modZip(), makeZip([{ name: "Data/x.esp", data: STOCK }]));

    const outcome = await applyMirrorPlan({
      stagingRoot: staging,
      ehcollPath: ehcoll,
      plan: planMirror({
        target: [
          { path: "Data/x.esp", size: STOCK.length, sha256: sha(STOCK) },
          { path: "Data/cleaned.esp", size: CLEANED.length, sha256: sha(CLEANED) },
        ],
        current: [],
      }),
      fromArchive: { paths: new Set(["Data/x.esp"]), archivePath: modZip() },
    });

    expect(outcome).toMatchObject({
      restored: 2,
      failures: [],
      fromArchive: { wanted: 1, restored: 1 },
    });
    expect(await readFile(join(staging, "Data", "cleaned.esp"))).toEqual(CLEANED);
    expect(await readFile(join(staging, "Data", "x.esp"))).toEqual(STOCK);
  });

  it("extracts with 7-Zip, in one run, from an archive that is not a ZIP", async () => {
    await writeFile(ehcoll, makeZip([{ name: "unrelated", data: STOCK }]));
    const archivePath = join(dir, "mod.7z");
    await writeFile(archivePath, Buffer.from("not a zip at all"));
    const SECOND = Buffer.from("a second file from the archive");
    const inArchive: Record<string, Buffer> = {
      "Wrap/Data/x.esp": STOCK,
      "Wrap/Data/y.esp": SECOND,
    };
    const extractions: string[][] = [];
    const sevenZip: SevenZipApi = {
      list: async (archive, _options, progress) => {
        for (const [name, data] of Object.entries(inArchive)) {
          progress?.([{ name, size: data.length, crc: hex(data) } as SevenZipListEntry]);
        }
        return { path: archive, type: "7z", physicalSize: "1" };
      },
      extractFull: async (_archive, dest, options) => {
        const names = options?.raw ?? [];
        extractions.push([...names]);
        for (const name of names) {
          const data = inArchive[name];
          if (data === undefined) continue;
          const target = join(dest, ...name.split("/"));
          await mkdir(dirname(target), { recursive: true });
          await writeFile(target, data);
        }
        return { code: 0, errors: [] };
      },
      add: async () => ({ code: 0, errors: [] }),
    };

    const outcome = await applyMirrorPlan({
      stagingRoot: staging,
      ehcollPath: ehcoll,
      plan: planMirror({
        target: [
          { path: "Data/x.esp", size: STOCK.length, sha256: sha(STOCK) },
          { path: "Data/y.esp", size: SECOND.length, sha256: sha(SECOND) },
        ],
        current: [],
      }),
      fromArchive: {
        paths: new Set(["Data/x.esp", "Data/y.esp"]),
        archivePath,
        sevenZip,
      },
    });

    expect(outcome).toMatchObject({ restored: 2, failures: [] });
    expect(extractions).toEqual([["Wrap/Data/x.esp", "Wrap/Data/y.esp"]]);
    expect(await readFile(join(staging, "Data", "y.esp"))).toEqual(SECOND);
  });

  it("tells the user how many files came from the mod's own archive", () => {
    const line = describeMirrorOutcome("Apocalypse", {
      restored: 3,
      removed: 0,
      failures: [],
      fromArchive: { wanted: 2, restored: 2 },
    });
    expect(line).toContain("3 file(s) written (2 from the mod's own archive)");
  });
});

describe("what the user is told", () => {
  it("names the files that could not be mirrored", () => {
    const line = describeMirrorOutcome("Apocalypse", {
      restored: 2,
      removed: 1,
      failures: [{ path: "x.esp", why: "missing from package" }],
    });
    expect(line).toContain("2 file(s) written");
    expect(line).toContain("1 removed");
    expect(line).toContain("does not match the curator's copy");
    expect(line).toContain("x.esp");
  });

  it("says nothing when there was nothing to do", () => {
    expect(
      describeMirrorOutcome("Mod", { restored: 0, removed: 0, failures: [] }),
    ).toBeUndefined();
  });

  it("names the supplied archive as the cause when it is the cause", () => {
    /**
     * ─── THE TWO FACTS THAT WERE NEVER JOINED ───────────────────────────
     * A mirrored mod may leave its UNCHANGED files to its own archive so the
     * package does not re-host the author's bytes. For a Nexus mod that is
     * safe — modId + fileId + sha256 pin the file. An EXTERNAL mod is
     * supplied by hand, and installFromLocalArchive deliberately allows a
     * different build of it, so those files are simply not in the archive the
     * player pointed at and every candidate fails its hash check.
     *
     * The run knew that and said only "4 could NOT be mirrored", which reads
     * as a bug in the tool rather than a file the player can go and fetch.
     */
    const line = describeMirrorOutcome(
      "SCAR",
      {
        restored: 1,
        removed: 0,
        failures: [{ path: "Data/scar.esp", why: "not in the archive" }],
      },
      { expected: "SCAR-v2.01.AE.7z", actual: "SCAR-v2.02.7z" },
    );
    expect(line).toContain("does not match the curator's copy");
    expect(line).toContain("not the one the collection was built from");
    expect(line).toContain("SCAR-v2.01.AE.7z");
    expect(line).toContain("SCAR-v2.02.7z");
    expect(line).toContain("pick the matching download");
  });

  it("says nothing about the supplied archive when nothing failed", () => {
    // A differing archive that still produced every file is not a problem to
    // report: the mod matches the curator, which is the only claim that counts.
    const line = describeMirrorOutcome(
      "SCAR",
      { restored: 2, removed: 0, failures: [] },
      { expected: "a.7z", actual: "b.7z" },
    );
    expect(line).not.toContain("not the one the collection was built from");
  });
});

describe("a filesystem where rename cannot replace an existing file", () => {
  /**
   * A tester's mirror reported, verbatim:
   *
   *   "Rebecca Rose - TWB - Bodyslide Presets": 1 could NOT be mirrored, so
   *   this mod does not match the curator's copy:
   *   Tools/BodySlide/SliderPresets/Rebecca_Rose_TWB_Nude.xml
   *   (EPERM: operation not permitted, rename
   *   '...xml.ehcoll-restore-tmp' -> '...xml')
   *
   * That temp file is ours. The restore had been `rm(dest)` then
   * `copyFile(staged, dest)`, which leaves a TRUNCATED file if the copy dies
   * part-way, so it became copy-to-temp-then-rename. POSIX rename replaces the
   * destination and Windows mostly does too — that tester's Proton staging
   * folder does not.
   */
  it("prefers the atomic rename when the filesystem allows it", async () => {
    const calls: string[] = [];
    await replaceFile("from.tmp", "to.txt", {
      rename: async () => {
        calls.push("rename");
      },
      rm: async () => {
        calls.push("rm");
      },
    });
    // One rename, and NOTHING removed: the destination is never unlinked on a
    // filesystem that can replace it, which is the whole point of the temp.
    expect(calls).toEqual(["rename"]);
  });

  it("removes the destination and retries when rename refuses", async () => {
    const calls: string[] = [];
    let refused = false;
    await replaceFile("from.tmp", "to.txt", {
      rename: async () => {
        if (!refused) {
          refused = true;
          calls.push("rename-refused");
          throw Object.assign(
            new Error("EPERM: operation not permitted, rename"),
            { code: "EPERM" },
          );
        }
        calls.push("rename-ok");
      },
      rm: async () => {
        calls.push("rm");
      },
    });
    // The order matters: the destination goes only AFTER the atomic attempt
    // failed, and the file that lands is the already-complete temp.
    expect(calls).toEqual(["rename-refused", "rm", "rename-ok"]);
  });

  it("still throws when the retry also fails, rather than reporting success", async () => {
    // A mirror that silently swallowed this would report the mod as matching
    // the curator's copy when it does not.
    await expect(
      replaceFile("from.tmp", "to.txt", {
        rename: async () => {
          throw Object.assign(new Error("EPERM"), { code: "EPERM" });
        },
        rm: async () => undefined,
      }),
    ).rejects.toThrow(/EPERM/);
  });
});
