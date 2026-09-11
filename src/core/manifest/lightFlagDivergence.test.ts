/**
 * ──────────────────────────────────────────────────────────────────────
 * A plugin the curator marked LIGHT is a mutated staged file. Who notices?
 *
 * Vortex's "mark as light" writes bit 9 into the TES4 flags field at offset 8
 * — in place, four bytes, so the file's SIZE does not change. With hardlink
 * deployment the staged copy and the deployed copy are one inode, so the
 * curator's staging now differs from the archive it came from.
 *
 * Measured on the real Skyrim profile this was written against: of 60 staged
 * light-flagged plugins compared against their own .zip archives, 3 differed
 * from the archive by EXACTLY one byte, at offset 9, `staged XOR archive ==
 * 0x200`. Not a hypothetical — the curator flipped those three in Vortex.
 *
 * ─── THE TWO SIDES ANSWER DIFFERENTLY, AND BOTH ARE RIGHT ──────────────
 * BUILD: `runSelfChecks` builds its `StagedFileRef`s with `{path, size}` and
 *   NO crc, so `verifyStagingAgainstArchive` cannot do an exact match and
 *   falls to size-only — which the flag does not disturb. The plugin comes
 *   back `size-only`, never `unexplained`, so it never reaches the curator as
 *   a post-processing decision. Good outcome, but note WHY: it is a
 *   consequence of not computing staged CRCs, not of anything knowing what a
 *   plugin is.
 *
 * INSTALL: `judgeReinstall` DOES compute a real crc32 per staged file
 *   (judgeReinstall.ts:217), so there the same plugin is `unexplained` — and
 *   that is the case judgeReinstall exists for. The user's bytes match the
 *   archive, so the verdict is `curator-diverged` and no reinstall is spent.
 *   `applyPluginLightFlags` then sets the flag (runInstall.ts:1938), after
 *   which the second verification agrees with the curator's hash.
 *
 * ─── WHY THIS FILE EXISTS ──────────────────────────────────────────────
 * The build-side safety is INCIDENTAL. `verifyAgainstArchive`'s own header
 * describes matching by `(size, crc32)` and its headline 96.6% measurement
 * used CRCs on both sides. Adding staged CRCs is an obvious future accuracy
 * win — and the day someone does it, every plugin the curator ever flipped
 * becomes an entry in "N mods need a decision", where the panel's own caution
 * text steers them toward "ship my copy" and bundles a whole staging folder
 * to carry one flipped bit that is already recorded and replayed.
 *
 * So this pins the behaviour AND the reason. If the staged side starts
 * carrying a crc, the last test here fails and points at what to do about it.
 * ──────────────────────────────────────────────────────────────────────
 */
import { readFileSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { crc32 } from "./readZip";
import { pluginCapabilityFor, readPluginFlags, setPluginLightFlag } from "./pluginFlags";

const SSE = pluginCapabilityFor("skyrimse")!;
import { verifyStagingAgainstArchive } from "./verifyAgainstArchive";
import type { ArchiveListing } from "./archiveContents";

/** A minimal but real TES4 plugin: tag, data size, flags, then filler. */
function plugin(flags: number): Buffer {
  const buf = Buffer.alloc(256);
  buf.write("TES4", 0, "latin1");
  buf.writeUInt32LE(200, 4);
  buf.writeUInt32LE(flags, 8);
  buf.fill(0x41, 12);
  return buf;
}

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "eh-light-"));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("what marking a plugin light actually does to the file", () => {
  it("changes the CRC but NOT the size", async () => {
    const file = join(dir, "Foo.esp");
    const before = plugin(0);
    await writeFile(file, before);

    const changed = await setPluginLightFlag(file, true, SSE);
    expect(changed).toBe(true);

    const after = await readFile(file);
    expect(after.length).toBe(before.length); // ← the whole reason size-only saves it
    expect(crc32(after)).not.toBe(crc32(before));
  });

  it("differs by exactly the light bit, and nothing else", async () => {
    // The shape measured on the real profile: one byte, at offset 9,
    // staged XOR archive === 0x200.
    const file = join(dir, "Bar.esp");
    const before = plugin(0);
    await writeFile(file, before);
    await setPluginLightFlag(file, true, SSE);
    const after = await readFile(file);

    const differing = [...before.keys()].filter((i) => before[i] !== after[i]);
    expect(differing).toEqual([9]);
    expect(after.readUInt32LE(8) ^ before.readUInt32LE(8)).toBe(0x200);
    expect((await readPluginFlags(file, SSE))?.isLight).toBe(true);
  });
});

/** One archive entry: the plugin as the AUTHOR shipped it, unflagged. */
const archived = plugin(0);
const listing = (): ArchiveListing =>
  ({
    entries: [
      {
        path: "Foo.esp",
        size: archived.length,
        crc: crc32(archived).toString(16).padStart(8, "0"),
      },
    ],
    crcCoverage: 1,
    withCrc: 1,
  }) as unknown as ArchiveListing;

describe("the build side does not turn it into a curator decision", () => {
  it("reports size-only, not unexplained, for the shape runSelfChecks passes", () => {
    // Exactly what runSelfChecks.ts:270 builds: path and size, no crc.
    const r = verifyStagingAgainstArchive(
      [{ path: "Foo.esp", size: archived.length }],
      listing(),
    );
    expect(r.verdicts[0]!.kind).toBe("size-only");
    expect(r.unexplained).toBe(0);
  });

  it("would report unexplained the moment a staged crc is supplied", () => {
    // The install side's shape — and the future build side, if staged CRCs
    // are ever added. Documented so the change is a decision, not a surprise.
    const staged = plugin(0x200);
    const r = verifyStagingAgainstArchive(
      [
        {
          path: "Foo.esp",
          size: staged.length,
          crc: crc32(staged).toString(16).padStart(8, "0"),
        },
      ],
      listing(),
    );
    expect(r.verdicts[0]!.kind).toBe("unexplained");
    expect(r.unexplained).toBe(1);
  });
});

describe("the tripwire", () => {
  it("staged refs on the build side still carry no crc", () => {
    // If this fails, someone added CRCs to the build-side staging refs. That
    // is a real accuracy improvement AND it makes every curator-flipped ESL
    // plugin a post-processing decision. Read this file's header before
    // deleting the assertion: the fix is to match a light-flag-only
    // difference explicitly, not to leave the panel asking about it.
    const src = readFileSync(
      join(__dirname, "runSelfChecks.ts"),
      "utf8",
    );
    const at = src.indexOf("const staged = (mod.stagingFiles ?? []).map(");
    expect(at).toBeGreaterThan(-1);
    const decl = src.slice(at, at + 200);
    expect(decl).toContain("size: f.size");
    expect(decl).not.toContain("crc");
  });
});
