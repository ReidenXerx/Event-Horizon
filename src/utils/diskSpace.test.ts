/**
 * Room is checked before a big write, instead of being discovered when the disk
 * fills partway through. Pinned: what is headed for one drive adds up; the
 * refusal names the drive, each write and both numbers; a drive whose free
 * space cannot be read never blocks; and writes that share a drive wait for
 * each other rather than refusing one that would have fit.
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DiskSpaceError, claimFreeSpace, requireFreeSpace } from "./diskSpace";

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "eh-disk-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const GB = 1024 ** 3;

describe("requireFreeSpace", () => {
  it("adds up what is headed for one drive, and names the drive, each write and both numbers", async () => {
    // Folders that do not exist yet are on the drive of the nearest one that does.
    const first = path.join(dir, "downloads");
    const second = path.join(dir, "staging");
    const err = await requireFreeSpace(
      [
        { dir: first, bytes: 2 * GB, what: "the archive" },
        { dir: second, bytes: 2 * GB, what: "the installed mod" },
      ],
      async () => 3 * GB,
    ).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(DiskSpaceError);
    expect(err).toMatchObject({ code: "ENOSPC" });
    const message = (err as Error).message;
    expect(message).toContain(`Not enough free space on the drive holding "${first}"`);
    expect(message).toContain("the archive (2.00 GB) and the installed mod (2.00 GB) need about 4.00 GB");
    expect(message).toContain("3.00 GB is free");
    expect(message).toContain("Free up at least 1.00 GB there");
  });

  it("lets writes through that fit together", async () => {
    await expect(
      requireFreeSpace(
        [
          { dir, bytes: GB, what: "one" },
          { dir, bytes: GB, what: "two" },
        ],
        async () => 2 * GB,
      ),
    ).resolves.toBeUndefined();
  });

  it("never blocks on a drive whose free space cannot be read", async () => {
    await expect(requireFreeSpace([{ dir, bytes: 100 * GB, what: "one" }], async () => undefined)).resolves.toBeUndefined();
  });
});

describe("claimFreeSpace", () => {
  it("refuses a write that does not fit with nothing else running", async () => {
    await expect(
      claimFreeSpace({ dir, bytes: 2 * GB, what: "the archive" }, { probe: async () => GB }),
    ).rejects.toBeInstanceOf(DiskSpaceError);
  });

  it("holds a write that only fits on its own until the running one is done, then lets it start", async () => {
    const probe = async (): Promise<number> => 3 * GB;
    const running = await claimFreeSpace({ dir, bytes: 2 * GB, what: "first" }, { probe });
    let started = false;
    const waiting = claimFreeSpace({ dir, bytes: 2 * GB, what: "second" }, { probe }).then((claim) => {
      started = true;
      return claim;
    });

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(started).toBe(false);

    running.release();
    (await waiting).release();
    expect(started).toBe(true);
  });
});
