/**
 * Getting the collection without asking the player for it.
 *
 * The order is the product decision (owner poll, 2026-09-18): the copy kept at
 * install time, then the collections folder, then download the revision the
 * receipt records. A file picker is what happens when all three fail, not what
 * happens first.
 *
 * The one that must never slip: the revision fetched is the INSTALLED one. The
 * newest publication is a different collection, and repairing with it would
 * migrate a player who asked for a repair.
 */
import { describe, expect, it, vi } from "vitest";

import type { types } from "@nexusmods/vortex-api";

import type { InstallReceipt } from "../../types/installLedger";

import { ensureCollectionPackage, type EnsurePackageDeps } from "./ensurePackage";

const api = { getState: () => ({}) } as unknown as types.IExtensionApi;

const receipt = (over: Partial<InstallReceipt> = {}): InstallReceipt =>
  ({
    packageId: "pkg-1",
    packageName: "Gate to SovnGoon",
    packageVersion: "1.1.8",
    gameId: "skyrimse",
    nexusCollection: {
      slug: "ecb76c",
      revisionNumber: 2,
      gameDomain: "skyrimspecialedition",
    },
    ...over,
  }) as unknown as InstallReceipt;

const deps = (over: Partial<EnsurePackageDeps> = {}): EnsurePackageDeps => ({
  locate: async () => undefined,
  download: async () => "D:/downloads/collection-rev2.zip",
  store: async () => undefined,
  loggedIn: () => true,
  ...over,
});

const ensure = (
  d: EnsurePackageDeps,
  r: InstallReceipt = receipt(),
): ReturnType<typeof ensureCollectionPackage> =>
  ensureCollectionPackage({ api, receipt: r, appDataPath: "C:/appdata", deps: d });

describe("getting a collection's package", () => {
  it("uses the copy kept at install time and asks Nexus for nothing", async () => {
    const download = vi.fn();
    const out = await ensure(
      deps({
        locate: async () => ({ path: "C:/appdata/.../pkg-1.zip", source: "kept" }),
        download,
      }),
    );
    expect(out).toEqual({
      kind: "ready",
      path: "C:/appdata/.../pkg-1.zip",
      source: "kept",
    });
    expect(download).not.toHaveBeenCalled();
  });

  it("passes the package id to the lookup, which is what makes it exact", async () => {
    const locate = vi.fn(async () => undefined);
    await ensure(deps({ locate }));
    expect(locate).toHaveBeenCalledWith({
      packageId: "pkg-1",
      packageName: "Gate to SovnGoon",
      packageVersion: "1.1.8",
    });
  });

  it("downloads the INSTALLED revision, never the newest", async () => {
    const download = vi.fn(async () => "D:/downloads/rev2.zip");
    const out = await ensure(deps({ download }));
    expect(out).toEqual({
      kind: "ready",
      path: "D:/downloads/rev2.zip",
      source: "downloaded",
    });
    const update = download.mock.calls[0]![1] as { latestRevision: number };
    // `latestRevision` is the field the shared downloader reads. Pointing it
    // at revision 2 is the whole point: the player installed revision 2.
    expect(update.latestRevision).toBe(2);
  });

  it("keeps what it downloaded, so this happens at most once", async () => {
    const store = vi.fn(async () => undefined);
    await ensure(deps({ store }));
    expect(store).toHaveBeenCalledWith({
      appDataPath: "C:/appdata",
      packageId: "pkg-1",
      packageVersion: "1.1.8",
      packageName: "Gate to SovnGoon",
      sourcePath: "D:/downloads/collection-rev2.zip",
    });
  });

  it("does not invent a page for a collection installed from a file", async () => {
    const download = vi.fn();
    const out = await ensure(
      deps({ download }),
      receipt({ nexusCollection: undefined }),
    );
    expect(out.kind).toBe("unavailable");
    expect(out.kind === "unavailable" ? out.reason : "").toMatch(/installed from a file/);
    expect(download).not.toHaveBeenCalled();
  });

  it("says to log in rather than firing a request that will fail", async () => {
    // Vortex turns every failed Nexus request into an error notification, and
    // a logged-out request for an adult collection fails.
    const download = vi.fn();
    const out = await ensure(deps({ loggedIn: () => false, download }));
    expect(out.kind).toBe("unavailable");
    expect(out.kind === "unavailable" ? out.reason : "").toMatch(/not logged in/);
    expect(download).not.toHaveBeenCalled();
  });

  it("reports a failed download as unavailable, with what went wrong", async () => {
    const out = await ensure(
      deps({
        download: async () => {
          throw new Error("Nexus gave no download address");
        },
      }),
    );
    expect(out.kind).toBe("unavailable");
    expect(out.kind === "unavailable" ? out.reason : "").toMatch(
      /Nexus gave no download address/,
    );
  });
});
