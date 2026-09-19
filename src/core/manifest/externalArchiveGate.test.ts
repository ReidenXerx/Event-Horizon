/**
 * The gate that refuses a build when a mod the PLAYER is asked to supply has
 * no archive on the curator's side.
 *
 * Every case here is one the real build reached: the six archive-less external
 * mods in the first 955-mod package, a Nexus mod marked `treatAsExternal`
 * after its file was pulled, and a bundled mod whose archive Vortex had long
 * since evicted and which cost nobody anything because the package carried it.
 */

import { describe, expect, it } from "vitest";
import {
  externalArchiveRefusal,
  type ExternalArchiveMod,
} from "./externalArchiveGate";

function mod(
  over: Partial<ExternalArchiveMod> & { id: string },
): ExternalArchiveMod {
  return {
    name: over.id,
    shipsAsExternal: false,
    bundled: false,
    archiveSha256: "a".repeat(64),
    ...over,
  };
}

describe("externalArchiveRefusal", () => {
  it("allows a build where every external mod has an archive", () => {
    expect(
      externalArchiveRefusal([
        mod({ id: "nexus-mod" }),
        mod({ id: "loverslab-mod", shipsAsExternal: true }),
      ]),
    ).toBeUndefined();
  });

  it("refuses when an external mod has no archive", () => {
    const refusal = externalArchiveRefusal([
      mod({ id: "x", name: "Devious Devices", shipsAsExternal: true }),
      mod({
        id: "y",
        name: "Some LL Mod",
        shipsAsExternal: true,
        archiveSha256: undefined,
      }),
    ]);
    expect(refusal?.code).toBe("external-without-archive");
    expect(refusal?.mods.map((m) => m.id)).toEqual(["y"]);
    expect(refusal?.message).toContain("Some LL Mod");
    // Not a bare complaint: every way out is named.
    expect(refusal?.message).toContain("Import the archive");
    expect(refusal?.message).toContain("Bundle");
    expect(refusal?.message).toContain("disable the mod");
  });

  it("treats an empty hash as no hash", () => {
    expect(
      externalArchiveRefusal([
        mod({ id: "y", shipsAsExternal: true, archiveSha256: "" }),
      ])?.mods,
    ).toHaveLength(1);
  });

  it("exempts a BUNDLED external mod — nobody is ever asked for it", () => {
    expect(
      externalArchiveRefusal([
        mod({
          id: "y",
          shipsAsExternal: true,
          bundled: true,
          archiveSha256: undefined,
        }),
      ]),
    ).toBeUndefined();
  });

  it("ignores a Nexus mod with no archive — that is the manifest's refusal, not this one", () => {
    expect(
      externalArchiveRefusal([
        mod({ id: "n", shipsAsExternal: false, archiveSha256: undefined }),
      ]),
    ).toBeUndefined();
  });

  it("names a handful and counts the rest rather than printing a wall", () => {
    const many = Array.from({ length: 20 }, (_, i) =>
      mod({
        id: `m${i}`,
        name: `Mod ${i}`,
        shipsAsExternal: true,
        archiveSha256: undefined,
      }),
    );
    const refusal = externalArchiveRefusal(many);
    expect(refusal?.mods).toHaveLength(20);
    expect(refusal?.message).toContain('"Mod 0"');
    expect(refusal?.message).toContain('"Mod 11"');
    expect(refusal?.message).not.toContain('"Mod 12"');
    // One line, because the page renders it in a span with no pre-line.
    expect(refusal?.message).not.toContain(String.fromCharCode(10));
    expect(refusal?.message).toContain("and 8 more");
    expect(refusal?.message).toContain("20 mods");
  });

  it("says 'it' for one mod, 'them' for several", () => {
    const one = externalArchiveRefusal([
      mod({ id: "y", shipsAsExternal: true, archiveSha256: undefined }),
    ]);
    expect(one?.message).toContain("1 mod ships as external");
    expect(one?.message).toContain("its own copy");
    const two = externalArchiveRefusal([
      mod({ id: "y", shipsAsExternal: true, archiveSha256: undefined }),
      mod({ id: "z", shipsAsExternal: true, archiveSha256: undefined }),
    ]);
    expect(two?.message).toContain("2 mods ship as external");
    expect(two?.message).toContain("their own copy");
  });
});
