/**
 * A FOMOD variant is not a pass.
 *
 * `verifyStagingAgainstArchive` matches staged files to archive entries purely
 * on (size, crc) and never compares paths. So a texture mod offering "2K" and
 * "4K" — both writing the same relative paths — produced `matched === refs
 * .length` with zero missing files, and `judgeReinstall` excused it as
 * `curator-diverged`: "reinstalling would reproduce what is already on disk".
 *
 * For a variant mismatch that sentence is false. The user is running a
 * different build of the mod than the curator and was told it verified — the
 * exact shape NS-4 exists to prevent.
 */
import { describe, expect, it } from "vitest";

import { ambiguousVariantPaths } from "./judgeReinstall";
import type { ArchiveListing } from "../manifest/archiveContents";

const listing = (
  entries: Array<{ path: string; size?: number; crc?: string }>,
): ArchiveListing =>
  ({ entries, withCrc: entries.filter((e) => e.crc !== undefined).length }) as ArchiveListing;

const staged = (...paths: string[]) =>
  paths.map((p) => ({ path: p, size: 1 }) as never);

describe("paths the archive can fill more than one way", () => {
  it("flags a FOMOD that ships two sizes of the same file", () => {
    // The real shape: the staged path (`textures/foo.dds`) appears NOWHERE in
    // the archive — the installer copies one option folder's copy to it. What
    // is visible is two `foo.dds` entries with different content.
    const l = listing([
      { path: "2K/textures/foo.dds", size: 100, crc: "aaaa" },
      { path: "4K/textures/foo.dds", size: 400, crc: "bbbb" },
      { path: "fomod/ModuleConfig.xml", size: 9, crc: "cccc" },
    ]);
    expect(ambiguousVariantPaths(staged("textures/foo.dds"), l)).toEqual([
      "textures/foo.dds",
    ]);
  });

  it("does NOT flag a file the archive holds exactly once", () => {
    // The ordinary case, and by far the common one. Flagging it would turn
    // every legitimate curator-diverged mod into a warning.
    const l = listing([
      { path: "textures/foo.dds", size: 100, crc: "aaaa" },
      { path: "meshes/bar.nif", size: 200, crc: "bbbb" },
    ]);
    expect(ambiguousVariantPaths(staged("textures/foo.dds"), l)).toEqual([]);
  });

  it("does NOT flag two copies with IDENTICAL content", () => {
    // A FOMOD that ships the same bytes in two option folders offers no real
    // choice, so there is nothing ambiguous about which one landed.
    const l = listing([
      { path: "opt-a/foo.dds", size: 100, crc: "aaaa" },
      { path: "opt-b/foo.dds", size: 100, crc: "aaaa" },
    ]);
    expect(ambiguousVariantPaths(staged("textures/foo.dds"), l)).toEqual([]);
  });

  it("does not invent ambiguity from entries it could not read", () => {
    // An entry with no size cannot be shown to differ from anything. The
    // conservative direction is to under-report: a false "you may have the
    // wrong variant" on a healthy mod is its own kind of noise.
    const l = listing([
      { path: "a/foo.dds" },
      { path: "b/foo.dds" },
    ]);
    expect(ambiguousVariantPaths(staged("textures/foo.dds"), l)).toEqual([]);
  });

  it("matches basenames case-insensitively and across separators", () => {
    // Archive entries come from 7z and from our own zip reader, which do not
    // agree on separator, and Windows paths do not agree on case.
    const l = listing([
      { path: "2K\\textures\\Foo.DDS", size: 100, crc: "aaaa" },
      { path: "4K/textures/foo.dds", size: 400, crc: "bbbb" },
    ]);
    expect(ambiguousVariantPaths(staged("textures/FOO.dds"), l)).toEqual([
      "textures/FOO.dds",
    ]);
  });

  it("reports only the staged files that are actually ambiguous", () => {
    const l = listing([
      { path: "2K/foo.dds", size: 100, crc: "aaaa" },
      { path: "4K/foo.dds", size: 400, crc: "bbbb" },
      { path: "bar.nif", size: 10, crc: "cccc" },
    ]);
    expect(
      ambiguousVariantPaths(staged("textures/foo.dds", "meshes/bar.nif"), l),
    ).toEqual(["textures/foo.dds"]);
  });
});
