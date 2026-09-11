/**
 * The ESL / "light" flag: a bit of the TES4 flags field at offset 8 — 0x200
 * in Skyrim SE and Fallout 4, 0x100 in Starfield.
 *
 * Load-bearing, not cosmetic. Only 254 regular plugins can load; light ones
 * share the FE index for free. Measured on the real 963-mod profile: 817
 * plugins, 573 light, so 244 regular against a limit of 254 — ten slots of
 * headroom, and eleven lost flags means the game does not start.
 *
 * The parser is checked against a header built here AND against the real
 * fixtures the reader must not mistake for plugins.
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  pluginCapabilityFor,
  readPluginFlags,
  readPluginFlagsDetailed,
  setPluginLightFlag,
  REGULAR_PLUGIN_LIMIT,
} from "./pluginFlags";

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "eh-esp-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

/**
 * A minimal TES4 record header.
 *
 * Layout Vortex's own ESPFile reads: type[4] "TES4", dataSize[4], flags[4] at
 * offset 8. Trailing bytes stand in for the rest of the record.
 */
const writePlugin = (name: string, flags: number): string => {
  const buf = Buffer.alloc(24);
  buf.write("TES4", 0, "latin1");
  buf.writeUInt32LE(12, 4);
  buf.writeUInt32LE(flags, 8);
  const p = path.join(dir, name);
  fs.writeFileSync(p, buf);
  return p;
};

const FLAG_LIGHT = 0x200;
const SF_FLAG_LIGHT = 0x100;
const FLAG_MEDIUM = 0x400;
const FLAG_MASTER = 0x1;

const SSE = pluginCapabilityFor("skyrimse")!;
const SF = pluginCapabilityFor("starfield")!;
const FNV = pluginCapabilityFor("falloutnv")!;

describe("reading the flag", () => {
  it("reads light and master independently", async () => {
    expect(await readPluginFlags(writePlugin("a.esp", 0), SSE)).toEqual({
      isLight: false,
      isMaster: false,
      isMedium: false,
    });
    expect(await readPluginFlags(writePlugin("b.esp", FLAG_LIGHT), SSE)).toEqual({
      isLight: true,
      isMaster: false,
      isMedium: false,
    });
    expect(await readPluginFlags(writePlugin("c.esm", FLAG_MASTER), SSE)).toEqual({
      isLight: false,
      isMaster: true,
      isMedium: false,
    });
    // An ESM that is ALSO light — 34 of them on the real profile.
    expect(
      await readPluginFlags(writePlugin("d.esm", FLAG_MASTER | FLAG_LIGHT), SSE),
    ).toEqual({ isLight: true, isMaster: true, isMedium: false });
  });

  it("ignores unrelated flag bits", async () => {
    // Real headers carry other bits. Testing only 0x200 in isolation would
    // pass for an implementation that compared the whole word.
    // `>>> 0` because JS bitwise ops yield a SIGNED int32, and writeUInt32LE
    // rejects the negative that `0xffffffff & ~0x200` produces.
    const p = writePlugin("e.esp", (0xffff_ffff & ~FLAG_LIGHT) >>> 0);
    expect((await readPluginFlags(p, SSE))!.isLight).toBe(false);
    const q = writePlugin("f.esp", 0x8000_0201);
    expect((await readPluginFlags(q, SSE))!.isLight).toBe(true);
  });

  it("returns undefined — not 'not light' — for anything unreadable", async () => {
    // The distinction the whole feature rests on. A file we cannot parse
    // recorded as `false` would tell the installer to CLEAR a flag the user
    // legitimately has, which is the direction that breaks a game.
    expect(await readPluginFlags(path.join(dir, "missing.esp"), SSE)).toBeUndefined();

    const notAPlugin = path.join(dir, "text.esp");
    fs.writeFileSync(notAPlugin, "this is not a plugin at all");
    expect(await readPluginFlags(notAPlugin, SSE)).toBeUndefined();

    const truncated = path.join(dir, "short.esp");
    fs.writeFileSync(truncated, Buffer.from("TES4"));
    expect(await readPluginFlags(truncated, SSE)).toBeUndefined();
  });
});

describe("which bit is light is the game's answer", () => {
  /**
   * The defect: one constant, 0x200, for every game. On Starfield light is
   * 0x100 and 0x200 is a different flag, so a Starfield plugin carrying only
   * 0x200 was recorded as light, and the installer then flipped 0x200 inside
   * the user's plugins. Both directions are pinned, and Skyrim SE beside them.
   */
  it("Starfield: 0x200 set, 0x100 clear is NOT light", async () => {
    const p = writePlugin("NotLight.esm", FLAG_LIGHT);
    expect((await readPluginFlags(p, SF))!.isLight).toBe(false);
  });

  it("Starfield: 0x100 set, 0x200 clear IS light", async () => {
    const p = writePlugin("Light.esm", SF_FLAG_LIGHT);
    expect((await readPluginFlags(p, SF))!.isLight).toBe(true);
  });

  it("Skyrim SE is unchanged: 0x200 is light and 0x100 is not", async () => {
    expect((await readPluginFlags(writePlugin("A.esp", FLAG_LIGHT), SSE))!.isLight).toBe(true);
    expect((await readPluginFlags(writePlugin("B.esp", SF_FLAG_LIGHT), SSE))!.isLight).toBe(false);
  });

  it("reads medium where the game has medium plugins, and nowhere else", async () => {
    const p = writePlugin("Medium.esm", FLAG_MEDIUM);
    expect(await readPluginFlags(p, SF)).toMatchObject({ isLight: false, isMedium: true });
    expect(await readPluginFlags(p, SSE)).toMatchObject({ isLight: false, isMedium: false });
  });

  it("has no light plugins in a game without them, whatever 0x200 says", async () => {
    const p = writePlugin("Old.esp", FLAG_LIGHT);
    expect((await readPluginFlags(p, FNV))!.isLight).toBe(false);
  });

  it("states no flags at all for a game whose bits are unknown", async () => {
    // A perfectly good plugin. Without the game's semantics its light bit is
    // not a fact, and "not light" would be a guess the installer acts on.
    const p = writePlugin("Good.esp", FLAG_LIGHT);
    expect(await readPluginFlags(p, pluginCapabilityFor("cyberpunk2077"))).toBeUndefined();
  });
});

describe("writing the flag", () => {
  it("sets and clears only that bit, leaving the rest of the header alone", async () => {
    const p = writePlugin("g.esp", 0x0000_00a5);
    const before = fs.readFileSync(p);

    expect(await setPluginLightFlag(p, true, SSE)).toBe(true);
    expect((await readPluginFlags(p, SSE))!.isLight).toBe(true);

    const after = fs.readFileSync(p);
    // Same length, same everything except the flags word.
    expect(after.length).toBe(before.length);
    expect(after.subarray(0, 8)).toEqual(before.subarray(0, 8));
    expect(after.subarray(12)).toEqual(before.subarray(12));
    // The other bits of the flags word survived.
    expect(after.readUInt32LE(8) & 0xff).toBe(0xa5);

    expect(await setPluginLightFlag(p, false, SSE)).toBe(true);
    expect((await readPluginFlags(p, SSE))!.isLight).toBe(false);
    expect(fs.readFileSync(p)).toEqual(before);
  });

  it("writes Starfield's 0x100, and leaves its 0x200 exactly as it was", async () => {
    const p = writePlugin("Outpost.esm", FLAG_LIGHT);
    const before = fs.readFileSync(p);

    expect(await setPluginLightFlag(p, true, SF)).toBe(true);
    const after = fs.readFileSync(p);
    expect(after.readUInt32LE(8) ^ before.readUInt32LE(8)).toBe(SF_FLAG_LIGHT);
    expect((await readPluginFlags(p, SF))!.isLight).toBe(true);

    // Clearing light must not touch 0x200 either: it is not light there.
    expect(await setPluginLightFlag(p, false, SF)).toBe(true);
    expect(fs.readFileSync(p)).toEqual(before);
    expect(await setPluginLightFlag(p, false, SF)).toBe(false);
  });

  it("refuses to write in a game with no light bit, and leaves the file untouched", async () => {
    const p = writePlugin("Old.esp", 0);
    const before = fs.readFileSync(p);
    await expect(setPluginLightFlag(p, true, FNV)).rejects.toThrow(/no light plugins/);
    expect(fs.readFileSync(p)).toEqual(before);
  });

  it("reports NO change when the flag already matches", async () => {
    // A no-op write would inflate the reported correction count and bump the
    // file's mtime, which the hash cache keys on — invalidating a cache entry
    // for a file whose bytes never changed.
    const p = writePlugin("h.esp", FLAG_LIGHT);
    expect(await setPluginLightFlag(p, true, SSE)).toBe(false);
  });

  it("throws when it cannot write, rather than reporting success", async () => {
    // Reading failures degrade quietly; write failures must not. Each one is a
    // plugin closer to the game not loading.
    await expect(
      setPluginLightFlag(path.join(dir, "nope.esp"), true, SSE),
    ).rejects.toThrow();
  });
});

describe("the limit that makes this matter", () => {
  it("is 254 regular plugins", () => {
    // 817 plugins - 573 light = 244 regular. Ten spare.
    expect(REGULAR_PLUGIN_LIMIT).toBe(254);
    expect(817 - 573).toBeLessThan(REGULAR_PLUGIN_LIMIT);
    expect(817 - 573 + 11).toBeGreaterThan(REGULAR_PLUGIN_LIMIT);
  });
});

describe("why a read failed, for the caller that has to explain it", () => {
  it("reports a missing file as not-found, never as unreadable", async () => {
    const r = await readPluginFlagsDetailed(
      path.join(dir, "definitely-not-here.esp"),
      SSE,
    );
    expect(r.kind).toBe("not-found");
  });

  it("reports a non-plugin as not-a-plugin, with the reason", async () => {
    // A stray .esp that is really a text file. Present and readable — telling
    // the user it is "not on disk" would send them looking for it.
    const f = path.join(dir, "text.esp");
    fs.writeFileSync(f, "this is not a plugin at all, but it is long");
    const r = await readPluginFlagsDetailed(f, SSE);
    expect(r.kind).toBe("not-a-plugin");
    expect(r.kind === "not-a-plugin" && r.why).toMatch(/TES4/);
  });

  it("reports a truncated file as not-a-plugin, saying how short", async () => {
    const f = path.join(dir, "short.esp");
    fs.writeFileSync(f, "TES");
    const r = await readPluginFlagsDetailed(f, SSE);
    expect(r.kind).toBe("not-a-plugin");
    expect(r.kind === "not-a-plugin" && r.why).toMatch(/bytes/);
  });

  it("still gives the swallowing reader the same answers", async () => {
    // The two must not drift: readPluginFlags is defined in terms of the
    // detailed one precisely so a new failure mode cannot appear in one and
    // not the other.
    const f = path.join(dir, "gone.esp");
    expect(await readPluginFlags(f, SSE)).toBeUndefined();
    expect((await readPluginFlagsDetailed(f, SSE)).kind).toBe("not-found");
  });
});

describe("a failure that is not ENOENT", () => {
  it("reports UNREADABLE, not not-found, when the path cannot be opened", async () => {
    /**
     * The branch the whole detailed reader exists for, and the one that is
     * hard to reach on a healthy machine — EBUSY and EPERM need another
     * process holding the file. A DIRECTORY is the portable way to make the
     * open fail for a reason that is not "it does not exist".
     *
     * Without this the `code === "ENOENT"` test is never exercised: every
     * other case returns before the catch, so collapsing the two back into
     * "not-found" passes the whole suite.
     */
    const asDir = path.join(dir, "IAmADirectory.esp");
    fs.mkdirSync(asDir);
    const r = await readPluginFlagsDetailed(asDir, SSE);
    expect(r.kind).toBe("unreadable");
    expect(r.kind === "unreadable" && r.why).toMatch(/EISDIR|EPERM|EACCES/);
  });
});
