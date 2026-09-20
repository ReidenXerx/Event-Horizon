/**
 * ──────────────────────────────────────────────────────────────────────
 * The content check the divergence flow always had, switched on for the mods
 * that need it.
 *
 * `verifyStagingAgainstArchive` has always been able to tell a regenerated
 * file from an untouched one: a staged file whose `crc` disagrees with the
 * archive's entry is `unexplained`, and `unexplained` is what makes a mod a
 * post-processing candidate and gets mirroring offered. It simply never
 * received a crc — `runSelfChecks` mapped `stagingFiles` to `{path, size}`,
 * so every file took the `size-only` arm that the module itself calls weak
 * evidence and then counts as explained.
 *
 * The real case: a BodySlide output regenerated after its archive was
 * uploaded. 2,994 recorded files, 1,130 different for the player, and every
 * single one at the same path AND THE SAME SIZE. Sizes could not have caught
 * one of them, and the mod was never offered for mirroring.
 *
 * So the fixtures here are that shape deliberately: identical paths,
 * identical sizes, different checksums. Anything else would pass against a
 * size comparison and prove nothing (GP-4).
 * ──────────────────────────────────────────────────────────────────────
 */
import { describe, expect, it } from "vitest";

import { verifyStagingAgainstArchive } from "./verifyAgainstArchive";
import type { ArchiveListing } from "./archiveContents";

const SIZE = 97214;
const listing = (crc: string): ArchiveListing => ({
  entries: [{ path: "Meshes/F/ArmL.nif", size: SIZE, crc }],
  withCrc: 1,
  crcCoverage: 1,
});


describe("a regenerated file at the same path and size", () => {
  it("is UNEXPLAINED once the staged side carries a checksum", () => {
    const r = verifyStagingAgainstArchive(
      [{ path: "Meshes/F/ArmL.nif", size: SIZE, crc: "cccccccc" }],
      listing("aaaaaaaa"),
    );
    expect(r.unexplained).toBe(1);
    expect(r.sizeOnly).toBe(0);
    // This is the number findPostProcessingCandidates filters on, so a
    // non-zero here is what gets mirroring offered.
    expect(r.explainedRatio).toBe(0);
  });

  it("is invisible without one — the bug, pinned", () => {
    // Exactly what the build did before: no crc on the staged side.
    const r = verifyStagingAgainstArchive(
      [{ path: "Meshes/F/ArmL.nif", size: SIZE }],
      listing("aaaaaaaa"),
    );
    expect(r.unexplained).toBe(0);
    expect(r.sizeOnly).toBe(1);
    // "Explained", about a file whose bytes nobody compared.
    expect(r.explainedRatio).toBe(1);
  });

  it("stays explained when the checksums agree", () => {
    const r = verifyStagingAgainstArchive(
      [{ path: "Meshes/F/ArmL.nif", size: SIZE, crc: "aaaaaaaa" }],
      listing("aaaaaaaa"),
    );
    expect(r.matched).toBe(1);
    expect(r.unexplained).toBe(0);
  });

  it("falls back to size-only when the ARCHIVE gives no checksum", () => {
    // Half the evidence is still not a divergence. Unknown is not changed.
    const r = verifyStagingAgainstArchive(
      [{ path: "Meshes/F/ArmL.nif", size: SIZE, crc: "cccccccc" }],
      { entries: [{ path: "Meshes/F/ArmL.nif", size: SIZE }], withCrc: 0, crcCoverage: 0 },
    );
    expect(r.unexplained).toBe(0);
    expect(r.sizeOnly).toBe(1);
  });
});

describe("only non-Nexus mods pay for it", () => {
  const src = (): string =>
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    require("node:fs").readFileSync(
      new URL("./runSelfChecks.ts", import.meta.url),
      "utf8",
    ) as string;

  /**
   * The body of `stagedWithChecksums`, from its declaration to the next
   * top-level declaration.
   *
   * Function-scoped, not a byte count. This read `slice(at, at + 2400)` and
   * a docblock added INSIDE the function pushed the target past 2,400
   * characters — the test failed while the behaviour it guards was
   * untouched, pointing at nothing. PP-2 records the same trap costing a
   * debugging session after a CRLF rewrite moved a different window.
   */
  const stagedWithChecksumsBody = (): string => {
    const body = src();
    const at = body.indexOf("async function stagedWithChecksums(");
    expect(at).toBeGreaterThan(-1);
    const rest = body.slice(at + 1);
    // Column-0 declarations only: anything indented is inside this function.
    const next = rest.search(
      /\n(?:export )?(?:async )?function |\nexport (?:const|type) /,
    );
    return next === -1 ? rest : rest.slice(0, next);
  };

  it("gates the checksum pass on the mod NOT being downloaded from Nexus", () => {
    const body = src();
    const at = body.indexOf("const staged = await stagedWithChecksums(");
    expect(at).toBeGreaterThan(-1);
    const call = body.slice(at, at + 420);
    expect(call).toContain("!opts.downloadedFromNexus.has(mod.id)");
  });

  it("checks EVERY file, however big the mod is", () => {
    // A 19.7 GB external output is exactly the mod where a half-checked
    // result ships, so there is no byte budget and no partial coverage.
    const body = src();
    expect(body).not.toContain("EXTERNAL_CRC_BUDGET_BYTES");
    expect(body).not.toContain("partial:");
  });

  it("never checksums a plugin — a flipped light flag is not a divergence", () => {
    // Vortex writes the light bit in place, same size. Checksum those and
    // every plugin the curator flagged becomes a decision. See
    // lightFlagDivergence.test.ts, whose tripwire caught exactly this.
    const body = src();
    expect(body).toContain('new Set([".esp", ".esm", ".esl"])');
    expect(body).toContain("PLUGIN_EXTENSIONS.has");
  });

  it("leaves a file it could not read without a checksum", () => {
    // Locked or vanished says nothing about the archive, so it must not
    // become a divergence.
    //
    // Scoped to the FUNCTION, not to a byte window. It used to read
    // `slice(at, at + 2400)`, and adding a docblock inside the function
    // pushed the target past 2,400 characters — the test then failed while
    // the behaviour it guards was untouched, pointing at nothing. PP-2
    // records the same trap costing a debugging session on a CRLF rewrite.
    expect(stagedWithChecksumsBody()).toContain("return f;");
  });
});
