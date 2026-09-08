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
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  applyMirrorPlan,
  describeMirrorOutcome,
  mirrorEntryFor,
  replaceFile,
} from "./applyMirrors";
import { planMirror } from "./mirrorStaging";
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
