/**
 * The path service, and specifically the half that is not the same on every
 * platform.
 *
 * Folding case is correct on NTFS and wrong on the ext4 under a Proton
 * install, where `Scripts/a.pex` and `scripts/a.pex` are two files that can
 * both exist in one folder. Every comparison here takes the mode as an
 * argument for that reason, and these tests pin BOTH answers.
 */
import { describe, expect, it } from "vitest";

import {
  basenameKey,
  basenameOf,
  dirnameOf,
  extensionOf,
  isInside,
  isSafeRelativePath,
  pathKey,
  samePath,
  segmentsOf,
  toPosix,
  unsafePathReason,
} from "./modPath";

describe("separators are never a fact about the file", () => {
  it("normalises backslashes on every platform", () => {
    expect(toPosix("Scripts\\Foo.pex")).toBe("Scripts/Foo.pex");
    expect(toPosix("a\\b/c\\d")).toBe("a/b/c/d");
  });

  it("does NOT touch case", () => {
    // The two concerns are separate and only one of them is unconditional.
    expect(toPosix("Scripts\\Foo.pex")).toBe("Scripts/Foo.pex");
  });

  it("splits on either separator and drops empty segments", () => {
    expect(segmentsOf("a\\b//c/")).toEqual(["a", "b", "c"]);
    expect(segmentsOf("")).toEqual([]);
  });
});

describe("basename and dirname, replacing two idioms that disagreed", () => {
  it("takes the last segment whatever the separator", () => {
    expect(basenameOf("meshes\\actors\\body.nif")).toBe("body.nif");
    expect(basenameOf("body.nif")).toBe("body.nif");
  });

  it("returns an empty dirname at the root, not the whole path", () => {
    // The `lastIndexOf("/")` idiom returned the whole string here and the
    // `split().pop()` one returned nothing. They cannot both be right.
    expect(dirnameOf("body.nif")).toBe("");
    expect(dirnameOf("meshes/actors/body.nif")).toBe("meshes/actors");
  });

  it("does not read a leading dot as an extension", () => {
    // `.gitignore` is a name, not an extension — the case a bare
    // `lastIndexOf(".")` gets wrong.
    expect(extensionOf(".gitignore")).toBe("");
    expect(extensionOf("Mod.7Z")).toBe(".7z");
    expect(extensionOf("no-extension")).toBe("");
  });
});

describe("case folding is a property of the filesystem", () => {
  const WINDOWS = "insensitive" as const;
  const PROTON = "sensitive" as const;

  it("on NTFS, two spellings are ONE file", () => {
    // The bug this fixed: a FOMOD wrote `Scripts/` where the curator recorded
    // `scripts/`, and four healthy mods were reported as broken.
    expect(samePath("scripts/Foo.pex", "Scripts/Foo.pex", WINDOWS)).toBe(true);
    expect(samePath("a/00000D70.nif", "a/00000d70.nif", WINDOWS)).toBe(true);
  });

  it("on ext4 under Proton, two spellings are TWO files", () => {
    /**
     * The half that matters for Linux. Merging these would let verification
     * pass on a file that is not the one the curator shipped, and would let
     * the mirror pass — which DELETES what the curator's listing does not
     * mention — act on the wrong one. That turns a cosmetic Windows fix into
     * data loss on a platform it was never tested on.
     */
    expect(samePath("scripts/Foo.pex", "Scripts/Foo.pex", PROTON)).toBe(false);
    expect(samePath("a/00000D70.nif", "a/00000d70.nif", PROTON)).toBe(false);
  });

  it("normalises separators in BOTH modes", () => {
    // Case is conditional; separators never are.
    expect(samePath("a\\b\\c.esp", "a/b/c.esp", PROTON)).toBe(true);
    expect(samePath("a\\b\\c.esp", "a/b/c.esp", WINDOWS)).toBe(true);
  });

  it("keys the same way it compares", () => {
    expect(pathKey("Scripts\\A.pex", WINDOWS)).toBe("scripts/a.pex");
    expect(pathKey("Scripts\\A.pex", PROTON)).toBe("Scripts/A.pex");
  });

  it("applies the same rule to a basename key", () => {
    expect(basenameKey("2K/textures/Foo.DDS", WINDOWS)).toBe("foo.dds");
    expect(basenameKey("2K/textures/Foo.DDS", PROTON)).toBe("Foo.DDS");
  });
});

describe("containment, for paths a stranger supplies", () => {
  it("rejects traversal in either separator", () => {
    expect(isSafeRelativePath("../../../../plugins/evil/index.js")).toBe(false);
    expect(isSafeRelativePath("..\\..\\evil.js")).toBe(false);
    expect(isSafeRelativePath("a/../../b")).toBe(false);
  });

  it("rejects absolute, drive-qualified, NUL-bearing and empty", () => {
    expect(isSafeRelativePath("/etc/passwd")).toBe(false);
    expect(isSafeRelativePath("C:/Windows/x.dll")).toBe(false);
    expect(isSafeRelativePath("safe.txt\0../../evil")).toBe(false);
    expect(isSafeRelativePath("")).toBe(false);
  });

  it("accepts what a real staging folder contains", () => {
    // A containment check that rejects real content is one nobody can ship.
    for (const p of [
      "SKSE/Plugins/BugFixesSSE.dll",
      "meshes/actors/character/character assets/femalebody_1.nif",
      "Nemesis_Engine/Lib/test/capath/0e4015b9.0",
      "Mod v1..2/file.dds",
      "..leading-dots.esp",
    ]) {
      expect(isSafeRelativePath(p)).toBe(true);
    }
  });

  it("gives a reason, for the error message", () => {
    expect(unsafePathReason("../x")).toContain("..");
    expect(unsafePathReason("SKSE/Plugins/x.dll")).toBe("");
  });
});

describe("isInside, for absolute paths on this machine", () => {
  /**
   * Injected `path` ops so the test asks the question it means, rather than
   * whichever one the machine running it happens to answer. On Windows,
   * node's own `path.resolve` would turn every POSIX fixture below into
   * `C:\...` and the case comparison would stop being the thing under test.
   */
  const posixOps = {
    resolve: (p: string) => p,
    relative: (from: string, to: string) =>
      to.startsWith(from + "/") ? to.slice(from.length + 1) : `../${to}`,
    isAbsolute: (p: string) => p.startsWith("/"),
  };

  it("on NTFS, a differently-cased parent is the SAME directory", () => {
    expect(
      isInside("/home/u/Downloads", "/home/u/downloads/a.7z", "insensitive", posixOps),
    ).toBe(true);
  });

  it("on ext4 under Proton, it is a different directory", () => {
    // The reason this moved out of `adoptLocalArchive`, whose comment read
    // "Case-insensitive: this is Windows" — true of the machines it was
    // written on, false under Proton.
    expect(
      isInside("/home/u/Downloads", "/home/u/downloads/a.7z", "sensitive", posixOps),
    ).toBe(false);
  });

  it("is true for a real child and false for a sibling, in both modes", () => {
    for (const mode of ["insensitive", "sensitive"] as const) {
      expect(
        isInside("/home/u/dl", "/home/u/dl/a.7z", mode, posixOps),
      ).toBe(true);
      expect(
        isInside("/home/u/dl", "/home/u/other/a.7z", mode, posixOps),
      ).toBe(false);
    }
  });

  it("is false for the directory itself", () => {
    // `rel` is empty, which is neither inside nor outside — and treating it as
    // inside would let a caller mistake a folder for a file within it.
    expect(isInside("/home/u/dl", "/home/u/dl", "insensitive", posixOps)).toBe(
      false,
    );
  });
});
