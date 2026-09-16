/**
 * Which Nexus collection revision a package file is, from Vortex's own record
 * of downloading it.
 *
 * The shapes here are Vortex 2.6.3's: `startDownloadCollection` stores
 * `modInfo.nexus.ids = { gameId, collectionId, collectionSlug, revisionId,
 * revisionNumber }` on the download, with `game` an array of Vortex game ids
 * and `localPath` a file name inside that game's download folder.
 */
import * as path from "path";

import { describe, expect, it } from "vitest";

import { nexusCollectionOfDownload, readNexusCollectionRevision } from "./collectionRevision";

const DIR = path.join("D:", "Vortex", "vortexDownload", "fallout4");
const dirFor = (gameId: string): string | undefined => (gameId === "fallout4" ? DIR : undefined);

const stateWith = (files: Record<string, unknown>) => ({ persistent: { downloads: { files } } });

const collectionDownload = (localPath: string, ids: Record<string, unknown> = {}) => ({
  localPath,
  game: ["fallout4"],
  state: "finished",
  modInfo: {
    game: "fallout4",
    source: "nexus",
    nexus: {
      ids: { gameId: "fallout4", collectionId: 350133, collectionSlug: "tumkz9", revisionId: 9001, revisionNumber: 13, ...ids },
    },
  },
});

describe("the revision a package file was downloaded as", () => {
  it("is read off the download whose file this is", () => {
    const state = stateWith({ a: collectionDownload("Ivy's Panties-rev13.zip") });
    expect(nexusCollectionOfDownload(state, path.join(DIR, "Ivy's Panties-rev13.zip"), dirFor)).toEqual({
      slug: "tumkz9",
      revisionNumber: 13,
      gameDomain: "fallout4",
      collectionId: 350133,
    });
  });

  it("matches the path however Windows spells it", () => {
    const state = stateWith({ a: collectionDownload("Ivy's Panties-rev13.zip") });
    const spelled = path.join(DIR, "Ivy's Panties-rev13.zip").toUpperCase().replace(/\\/g, "/");
    expect(nexusCollectionOfDownload(state, spelled, dirFor)?.revisionNumber).toBe(13);
  });

  it("is nothing for a file no collection download produced", () => {
    // A mod-page zip or a file picked from the desktop: no revision exists,
    // and none may be guessed.
    const state = stateWith({
      a: collectionDownload("Ivy's Panties-rev13.zip"),
      b: { localPath: "ivy-panties-1.0.29.zip", game: ["fallout4"], modInfo: { nexus: { ids: { modId: 109025, fileId: 1 } } } },
    });
    expect(nexusCollectionOfDownload(state, path.join(DIR, "ivy-panties-1.0.29.zip"), dirFor)).toBeUndefined();
    expect(nexusCollectionOfDownload(state, path.join("C:", "Users", "x", "Desktop", "Ivy's Panties-rev13.zip"), dirFor)).toBeUndefined();
  });

  it("does not take a file of the same name from another game's folder", () => {
    const state = stateWith({ a: { ...collectionDownload("same.zip"), game: ["skyrimse"] } });
    expect(nexusCollectionOfDownload(state, path.join(DIR, "same.zip"), dirFor)).toBeUndefined();
  });

  it("accepts ids Nexus sent as strings, and refuses a download with no usable revision", () => {
    const stringy = stateWith({ a: collectionDownload("r.zip", { revisionNumber: "13", collectionId: "350133" }) });
    expect(nexusCollectionOfDownload(stringy, path.join(DIR, "r.zip"), dirFor)).toEqual({
      slug: "tumkz9",
      revisionNumber: 13,
      gameDomain: "fallout4",
      collectionId: 350133,
    });
    const broken = stateWith({ a: collectionDownload("r.zip", { revisionNumber: undefined }) });
    expect(nexusCollectionOfDownload(broken, path.join(DIR, "r.zip"), dirFor)).toBeUndefined();
  });

  it("survives a state with no downloads at all", () => {
    expect(nexusCollectionOfDownload({}, path.join(DIR, "r.zip"), dirFor)).toBeUndefined();
    expect(nexusCollectionOfDownload(undefined, path.join(DIR, "r.zip"), dirFor)).toBeUndefined();
  });
});

describe("a recorded revision", () => {
  const ok = { slug: "tumkz9", revisionNumber: 13, gameDomain: "fallout4", collectionId: 350133 };

  it("is kept whole", () => {
    expect(readNexusCollectionRevision(ok)).toEqual(ok);
    expect(readNexusCollectionRevision({ ...ok, collectionId: undefined })).toEqual({
      slug: "tumkz9",
      revisionNumber: 13,
      gameDomain: "fallout4",
    });
  });

  it("is refused when a part would change the address or the comparison", () => {
    expect(readNexusCollectionRevision({ ...ok, slug: "../mods/1" })).toBeUndefined();
    expect(readNexusCollectionRevision({ ...ok, gameDomain: "evil.example" })).toBeUndefined();
    expect(readNexusCollectionRevision({ ...ok, revisionNumber: 0 })).toBeUndefined();
    expect(readNexusCollectionRevision({ ...ok, revisionNumber: 1.5 })).toBeUndefined();
    expect(readNexusCollectionRevision(null)).toBeUndefined();
  });
});
