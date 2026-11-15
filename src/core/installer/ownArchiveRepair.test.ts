/**
 * Ivy 1.0.59 dropped one FOMOD pick (Rottweiler) from UAP, an unbundled
 * LoversLab mod, and kept the archive byte-identical. Every updater's install
 * said "installer options differ from the collection's" and attempted no
 * reinstall: the repair only knew Nexus and bundled sources, so it found "no
 * archive to reinstall from" while Vortex still held exactly the right one
 * (Fallout-collection, 11-15).
 *
 * The repair now uses the mod's own archive when its hash PROVES it is the
 * collection's file, and nothing else.
 */
import { createHash } from "crypto";
import { mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { describe, expect, it, vi } from "vitest";

const archiveDir = mkdtempSync(join(tmpdir(), "eh-own-archive-"));
const archivePath = join(archiveDir, "UAP v2.6.64.7z");
const bytes = Buffer.from("the curator's UAP archive");
writeFileSync(archivePath, bytes);
const sha = createHash("sha256").update(bytes).digest("hex");

vi.mock("../archiveHashing", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../archiveHashing")>()),
  getModArchivePath: (_state: unknown, archiveId: string | undefined) =>
    archiveId === "dl-uap" ? archivePath : undefined,
}));

import { ownArchiveRepairDecision } from "./runInstall";

const ctxWith = (archiveId: string | undefined): never =>
  ({
    api: {
      getState: () => ({
        persistent: {
          mods: { fallout4: { "uap+2": archiveId ? { archiveId } : {} } },
        },
      }),
    },
    plan: { manifest: { game: { id: "fallout4" } } },
  }) as never;

const entry = { compareKey: "uap", name: "UAP", vortexModId: "uap+2" } as never;
const external = (sha256: string | undefined, bundled = false): never =>
  ({ source: { kind: "external", sha256, bundled } }) as never;

describe("reinstalling an external mod from its own archive", () => {
  it("uses the archive when its hash is the collection's", async () => {
    await expect(
      ownArchiveRepairDecision(ctxWith("dl-uap"), entry, external(sha)),
    ).resolves.toEqual({
      kind: "external-use-local-download",
      sha256: sha,
      archiveId: "dl-uap",
      localPath: archivePath,
    });
  });

  it("refuses an archive with other bytes", async () => {
    await expect(
      ownArchiveRepairDecision(ctxWith("dl-uap"), entry, external("0".repeat(64))),
    ).resolves.toBeUndefined();
  });

  it("refuses when the mod has no archive in Vortex or the collection names none", async () => {
    await expect(
      ownArchiveRepairDecision(ctxWith(undefined), entry, external(sha)),
    ).resolves.toBeUndefined();
    await expect(
      ownArchiveRepairDecision(ctxWith("dl-uap"), entry, external(undefined)),
    ).resolves.toBeUndefined();
  });

  it("leaves Nexus mods to their own repair", async () => {
    const nexus = { source: { kind: "nexus", sha256: sha } } as never;
    await expect(
      ownArchiveRepairDecision(ctxWith("dl-uap"), entry, nexus),
    ).resolves.toBeUndefined();
  });
});
