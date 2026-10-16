/**
 * Cleanup by exact ids: the request is judged against the setup as it will be
 * after its own removals, and an archive a remaining mod points at is never
 * deletable.
 */
import { describe, expect, it } from "vitest";

import { planCleanup, type DownloadEntry } from "./cleanupPlan";
import { bucketArchives, checkCleanupRequest } from "./cleanupSelection";
import type { CuratorMod } from "./profileActions";

// Same shape as cleanupPlan.test.ts: a name Vortex would write, so two rows of one page are two versions of one file.
const named = (modId: number | undefined, stem: string): string =>
  modId === undefined ? `${stem}.7z` : `${stem}-${modId}-1-0-1700000000.7z`;
const mod = (id: string, over: Partial<CuratorMod> = {}): CuratorMod => {
  const merged = { id, name: id, enabled: true, modType: "", ...over };
  return { fileName: named(merged.nexusModId, "the-file"), ...merged } as CuratorMod;
};
// Each record its own file, as Vortex's download timestamp makes it.
let stamp = 0;
const dl = (id: string, over: Partial<DownloadEntry> = {}): DownloadEntry => {
  const merged = { id, bytes: 100, ...over };
  return { fileName: merged.nexusModId === undefined ? `${id}.7z` : named(merged.nexusModId, "the-file").replace("1700000000", String(1700000000 + ++stamp)), ...merged };
};

const MODS = [
  mod("old", { archiveId: "dl-old", nexusModId: 7, nexusFileId: 1, enabled: false }),
  mod("new", { archiveId: "dl-new", nexusModId: 7, nexusFileId: 9 }),
  mod("other", { archiveId: "dl-other", nexusModId: 8, nexusFileId: 3 }),
];
const DOWNLOADS = [
  dl("dl-old", { nexusModId: 7, nexusFileId: 1 }),
  dl("dl-new", { nexusModId: 7, nexusFileId: 9 }),
  dl("dl-other", { nexusModId: 8, nexusFileId: 3 }),
  dl("dl-stale", { nexusModId: 7, nexusFileId: 2 }),
  dl("dl-ahead", { nexusModId: 8, nexusFileId: 5, fileName: "Other Addon-8-1-0-1700000000.7z" }),
  dl("dl-gone", { nexusModId: 99, nexusFileId: 1 }),
  dl("dl-local", { fileName: "my build.7z" }),
];

describe("bucketArchives", () => {
  it("sorts every download by how sure its deletion is", () => {
    const b = Object.fromEntries(bucketArchives(MODS, DOWNLOADS).map((a) => [a.entry.id, a.bucket]));
    expect(b).toEqual({
      "dl-old": "referenced",
      "dl-new": "referenced",
      "dl-other": "referenced",
      "dl-stale": "superseded",
      "dl-ahead": "samePageInstalled",
      "dl-gone": "noInstall",
      "dl-local": "noNexusId",
    });
  });

  it("names the mods holding a referenced archive", () => {
    expect(bucketArchives(MODS, DOWNLOADS).find((a) => a.entry.id === "dl-old")?.heldBy).toEqual(["old"]);
  });

  it("an installed mod's own file with a dead archive link is staleLinked, not an orphan", () => {
    const mods = [mod("cur", { archiveId: "dl-deleted-record", nexusModId: 7, nexusFileId: 9 })];
    expect(bucketArchives(mods, [dl("dl-9", { nexusModId: 7, nexusFileId: 9 })])[0]!.bucket).toBe("staleLinked");
  });
});

describe("two download records naming one file (Skyrim-collection, 2026-10-16: OStim 7.5c)", () => {
  const mods = [mod("live", { archiveId: "dl-a", nexusModId: 7, nexusFileId: 9 })];
  const downloads = [
    dl("dl-a", { nexusModId: 7, nexusFileId: 9, fileName: "OStim-7-5c.7z" }),
    dl("dl-b", { nexusModId: 7, nexusFileId: 1, fileName: "ostim-7-5C.7z" }), // the orphan twin, older file id
  ];

  it("planCleanup keeps the twin: deleting it deletes the file the mod uses", () => {
    const plan = planCleanup({ mods, downloads });
    expect(plan.deleteArchives).toEqual([]);
    expect(plan.unclearOrphans).toEqual([]);
    expect(plan.keptReferenced).toBe(2);
  });

  it("the twin is referenced, held by the same mod, and a request for it is refused", () => {
    expect(bucketArchives(mods, downloads).find((a) => a.entry.id === "dl-b")).toMatchObject({ bucket: "referenced", heldBy: ["live"] });
    const r = checkCleanupRequest({ mods, downloads, removeModIds: [], deleteArchiveIds: ["dl-b"] });
    expect(r.problems).toEqual([expect.stringContaining("still the archive of live")]);
  });

  it("removing the mod frees both", () => {
    const r = checkCleanupRequest({ mods, downloads, removeModIds: ["live"], deleteArchiveIds: ["dl-a", "dl-b"] });
    expect(r.problems).toEqual([]);
  });
});

describe("checkCleanupRequest", () => {
  const check = (removeModIds: string[], deleteArchiveIds: string[]) =>
    checkCleanupRequest({ mods: MODS, downloads: DOWNLOADS, removeModIds, deleteArchiveIds });

  it("frees an install's archive when the same request removes the install", () => {
    const r = check(["old"], ["dl-old", "dl-stale", "dl-gone", "dl-local"]);
    expect(r.problems).toEqual([]);
    expect(r.removals.map((m) => m.id)).toEqual(["old"]);
    expect(r.deletions.map((d) => [d.entry.id, d.bucket])).toEqual([
      ["dl-old", "superseded"],
      ["dl-stale", "superseded"],
      ["dl-gone", "noInstall"],
      ["dl-local", "noNexusId"],
    ]);
  });

  it("refuses an archive a remaining mod still points at, naming the mod", () => {
    const r = check([], ["dl-old", "dl-stale"]);
    expect(r.problems).toEqual([expect.stringContaining("still the archive of old")]);
  });

  it("refuses an archive whose holder is not being removed even when another mod is", () => {
    expect(check(["old"], ["dl-new"]).problems).toEqual([expect.stringContaining("still the archive of new")]);
  });

  it("refuses unknown mod and download ids", () => {
    const r = check(["nope"], ["dl-nope"]);
    expect(r.problems).toEqual([expect.stringContaining("nope"), expect.stringContaining("dl-nope")]);
  });

  it("refuses an installed mod's own file reached through a dead link", () => {
    const r = checkCleanupRequest({
      mods: [mod("cur", { archiveId: "dl-deleted-record", nexusModId: 7, nexusFileId: 9 })],
      downloads: [dl("dl-9", { nexusModId: 7, nexusFileId: 9 })],
      removeModIds: [],
      deleteArchiveIds: ["dl-9"],
    });
    expect(r.problems).toEqual([expect.stringContaining("installed mod's own file")]);
  });
});
