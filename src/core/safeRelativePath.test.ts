/**
 * A `.ehcoll` is a file a stranger hands you, and its staging paths are joined
 * onto a folder we own and written into. These are the strings that must never
 * get through, and the ordinary ones that must.
 */
import { describe, expect, it } from "vitest";

import { isSafeRelativePath, unsafePathReason } from "./safeRelativePath";

describe("paths a hostile package could supply", () => {
  it("rejects traversal out of the staging folder", () => {
    // The live exploit: from `…/Vortex/skyrimse/mods/SomeMod` this lands in
    // `…/Vortex/plugins/`, which Vortex loads as an extension on next start.
    expect(isSafeRelativePath("../../../../plugins/evil/index.js")).toBe(false);
    expect(isSafeRelativePath("a/../../b")).toBe(false);
    expect(isSafeRelativePath("..")).toBe(false);
  });

  it("rejects traversal spelled with BACKSLASHES", () => {
    // A POSIX-only check passes these, and then Windows splits them into the
    // very segments the check was looking for.
    expect(isSafeRelativePath("..\\..\\evil.js")).toBe(false);
    expect(isSafeRelativePath("textures\\..\\..\\evil.js")).toBe(false);
  });

  it("rejects absolute and drive-qualified paths", () => {
    expect(isSafeRelativePath("/etc/passwd")).toBe(false);
    expect(isSafeRelativePath("\\\\server\\share\\x")).toBe(false);
    expect(isSafeRelativePath("C:/Windows/System32/x.dll")).toBe(false);
    expect(isSafeRelativePath("c:evil")).toBe(false);
  });

  it("rejects a NUL byte, which truncates the path at the syscall", () => {
    expect(isSafeRelativePath("safe.txt\0../../evil")).toBe(false);
  });

  it("rejects an empty path", () => {
    expect(isSafeRelativePath("")).toBe(false);
  });

  it("gives a reason for each rejection, for the error message", () => {
    expect(unsafePathReason("../x")).toContain("..");
    expect(unsafePathReason("/x")).toBe("it is absolute");
    expect(unsafePathReason("C:/x")).toBe("it names a drive");
    expect(unsafePathReason("")).toBe("it is empty");
  });
});

describe("paths a real staging folder actually contains", () => {
  it("accepts the ordinary shapes, or the check is useless", () => {
    // Drawn from a real 354,819-file capture. A containment check that also
    // rejects real content is a check nobody can ship.
    for (const p of [
      "SKSE/Plugins/BugFixesSSE.dll",
      "meshes/actors/character/character assets/femalebody_1.nif",
      "textures/impactdecals/decalsparkburn01_g.dds",
      "Meshes/actors/character/FaceGenData/FaceGeom/018Auri.esp/00000D63.NIF.bak",
      "Nemesis_Engine/Lib/test/capath/0e4015b9.0",
      "SOSRaceMenu.esp",
      "readme.txt",
      "Sound/Voice/Destroy the Dark Brotherhood - Quest Expansion.esp/x.fuz",
    ]) {
      expect(isSafeRelativePath(p)).toBe(true);
      expect(unsafePathReason(p)).toBe("");
    }
  });

  it("accepts a name that merely CONTAINS dots", () => {
    // `..` is a segment, not a substring — rejecting on substring would throw
    // away every versioned filename in the corpus.
    expect(isSafeRelativePath("Mod v1..2/file.dds")).toBe(true);
    expect(isSafeRelativePath("..leading-dots.esp")).toBe(true);
    expect(isSafeRelativePath("x/..y/z")).toBe(true);
  });
});
