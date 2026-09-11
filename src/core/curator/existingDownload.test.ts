/**
 * The archive Vortex already has for a planned file.
 *
 * Vortex's `downloadFile` resolves an existing download of the same game,
 * mod and file without downloading or installing anything. A plan step that
 * asked Vortex anyway waited fifteen minutes for an install that was never
 * going to start.
 */
import { describe, expect, it } from "vitest";

import { __testPaths } from "@nexusmods/vortex-api";

import {
  downloadIdsForPage,
  existingArchiveFor,
  findExistingNexusDownload,
  type DownloadRecord,
} from "./existingDownload";

const rec = (over: Partial<DownloadRecord> & { modId?: unknown; fileId?: unknown } = {}): DownloadRecord => {
  const { modId = 42, fileId = 500, ...rest } = over;
  return {
    game: ["skyrimse"],
    localPath: "plugin-500.7z",
    state: "finished",
    modInfo: { nexus: { ids: { modId, fileId } } },
    ...rest,
  };
};

describe("findExistingNexusDownload", () => {
  it("finds the download of this game, mod AND file", () => {
    expect(findExistingNexusDownload({ a: rec() }, "skyrimse", 42, 500)).toEqual({
      id: "a",
      localPath: "plugin-500.7z",
      state: "finished",
    });
  });

  it("is not satisfied by another file of the same page", () => {
    expect(findExistingNexusDownload({ a: rec({ fileId: 499 }) }, "skyrimse", 42, 500)).toBeUndefined();
  });

  it("is not satisfied by the same file downloaded for another game", () => {
    expect(findExistingNexusDownload({ a: rec({ game: ["fallout4"] }) }, "skyrimse", 42, 500)).toBeUndefined();
  });

  it("skips a failed download and one with no file name, as Vortex does", () => {
    expect(findExistingNexusDownload({ a: rec({ state: "failed" }) }, "skyrimse", 42, 500)).toBeUndefined();
    expect(findExistingNexusDownload({ a: rec({ localPath: undefined }) }, "skyrimse", 42, 500)).toBeUndefined();
  });

  it("reads ids Vortex stored as strings", () => {
    expect(findExistingNexusDownload({ a: rec({ modId: "42", fileId: "500" }) }, "skyrimse", 42, 500)?.id).toBe("a");
  });
});

describe("existingArchiveFor", () => {
  const state = (files: Record<string, DownloadRecord>): unknown => ({ persistent: { downloads: { files } } });

  it("installs from a finished download whose archive is on disk, at Vortex's own path", async () => {
    const asked: string[] = [];
    const probe = await existingArchiveFor(state({ a: rec() }), "skyrimse", 42, 500, async (p) => {
      asked.push(p);
      return true;
    });
    expect(probe.installable).toBe("a");
    expect(asked).toHaveLength(1);
    expect(asked[0]!.replace(/\\/g, "/")).toBe(`${__testPaths.downloadPath}/plugin-500.7z`);
  });

  it("does not offer a record whose archive is gone", async () => {
    const probe = await existingArchiveFor(state({ a: rec() }), "skyrimse", 42, 500, async () => false);
    expect(probe).toMatchObject({ onDisk: false });
    expect(probe.installable).toBeUndefined();
  });

  it("does not offer an unfinished download: Vortex refuses to install one", async () => {
    const probe = await existingArchiveFor(state({ a: rec({ state: "paused" }) }), "skyrimse", 42, 500, async () => true);
    expect(probe.installable).toBeUndefined();
  });

  it("says nothing is there when nothing matches", async () => {
    expect(await existingArchiveFor(state({}), "skyrimse", 42, 500, async () => true)).toEqual({ onDisk: false });
  });
});

describe("downloadIdsForPage", () => {
  it("lists every download naming the page, any file", () => {
    expect(downloadIdsForPage({ a: rec(), b: rec({ fileId: 1 }), c: rec({ modId: 7 }) }, 42)).toEqual(["a", "b"]);
  });
});
