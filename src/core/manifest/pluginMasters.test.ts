/**
 * The byte-level TES4 parser, and the classification built on it.
 *
 * This file did not exist until an audit pointed out that the riskiest code in
 * either build gate — a hand-rolled binary parser reading untrusted length
 * fields — had no test at all, and that the two Creation Club patterns it
 * relies on matched every Skyrim filename tried and NO Fallout 4 one. The
 * indirect coverage in `checkMasters.test.ts` used two Skyrim names: a fixture
 * drawn from the half that worked (GP-4).
 *
 * The one answer that must never appear for a file we failed to parse is
 * `{kind: "ok", masters: []}` — "this plugin needs nothing" passes the build
 * gate, so a parse failure reported that way ships a collection the game will
 * refuse to load.
 */
import * as fsp from "fs/promises";
import * as os from "os";
import * as path from "path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  isBaseGameMaster,
  isCreationClubMaster,
  isUserOwnedMaster,
  readPluginHeader,
  readPluginMasters,
} from "./pluginMasters";
import { pluginCapabilityFor } from "./pluginCapability";

// ─── Building real TES4 bytes ───────────────────────────────────────────────
// 4-byte tag, 4-byte data size, 16 more bytes of record header (24 total),
// then subrecords: 4-byte type, 2-byte little-endian length, then data.

const subrecord = (type: string, data: Buffer): Buffer => {
  const head = Buffer.alloc(6);
  head.write(type, 0, 4, "latin1");
  head.writeUInt16LE(data.length, 4);
  return Buffer.concat([head, data]);
};

const mast = (name: string): Buffer =>
  subrecord("MAST", Buffer.from(`${name}\0`, "latin1"));

/** The HEDR every real TES4 header opens with. */
const hedr = (): Buffer => subrecord("HEDR", Buffer.alloc(12));

const tes4 = (body: Buffer, sizeOverride?: number): Buffer => {
  const header = Buffer.alloc(24);
  header.write("TES4", 0, 4, "latin1");
  header.writeUInt32LE(sizeOverride ?? body.length, 4);
  return Buffer.concat([header, body]);
};

let dir: string;
const write = async (name: string, bytes: Buffer): Promise<string> => {
  const p = path.join(dir, name);
  await fsp.writeFile(p, bytes);
  return p;
};

beforeAll(async () => {
  dir = await fsp.mkdtemp(path.join(os.tmpdir(), "eh-masters-"));
});
afterAll(async () => {
  await fsp.rm(dir, { recursive: true, force: true }).catch(() => undefined);
});

describe("reading a plugin's masters", () => {
  it("reads them in file order", async () => {
    const p = await write(
      "normal.esp",
      tes4(Buffer.concat([hedr(), mast("Skyrim.esm"), mast("Update.esm")])),
    );
    expect(await readPluginMasters(p)).toEqual({
      kind: "ok",
      masters: ["Skyrim.esm", "Update.esm"],
    });
  });

  it("reports a plugin with no masters as OK and empty", async () => {
    // The legitimate empty case has to stay distinguishable from the failures
    // below, or the guard that produces them is just breaking valid plugins.
    const p = await write("nomasters.esm", tes4(Buffer.concat([hedr()])));
    expect(await readPluginMasters(p)).toEqual({ kind: "ok", masters: [] });
  });

  it("is not fooled by a dataSize that is too SMALL", async () => {
    /**
     * The dangerous case, and the one the truncation guard cannot see: the
     * walk is BOUNDED by the same untrusted number, so a size written as 12
     * stops the walk before the MAST records and the masters vanish. It used
     * to return `{kind: "ok", masters: []}` — a silent gate pass for a plugin
     * that in fact requires two masters.
     */
    const body = Buffer.concat([
      hedr(),
      mast("Skyrim.esm"),
      mast("RaceCompatibility.esm"),
    ]);
    const p = await write("liar.esp", tes4(body, 12));
    const read = await readPluginMasters(p);
    expect(read.kind).not.toBe("ok");
  });

  it("is not fooled by a zero dataSize", async () => {
    const p = await write("zero.esp", tes4(Buffer.alloc(0), 0));
    const read = await readPluginMasters(p);
    expect(read.kind).not.toBe("ok");
  });

  it("refuses a file that is not a plugin at all", async () => {
    const p = await write("readme.esm", Buffer.from("this is just text, honestly"));
    expect((await readPluginMasters(p)).kind).toBe("not-a-plugin");
  });

  it("refuses an empty file", async () => {
    const p = await write("empty.esp", Buffer.alloc(0));
    expect((await readPluginMasters(p)).kind).toBe("not-a-plugin");
  });

  it("reports a missing file as not-found, not as a parse failure", async () => {
    // `not-found` and `not-a-plugin` lead to the same gate outcome today, but
    // they are different facts and a support log needs to tell them apart.
    expect(
      (await readPluginMasters(path.join(dir, "nope.esp"))).kind,
    ).toBe("not-found");
  });

  it("never throws — a directory comes back as unreadable", async () => {
    const sub = path.join(dir, "adirectory.esm");
    await fsp.mkdir(sub, { recursive: true });
    expect((await readPluginMasters(sub)).kind).toBe("unreadable");
  });

  it("refuses a hostile size field instead of allocating it", async () => {
    // 4 GB claimed in a 24-byte file. The check must happen before the alloc.
    const p = await write("hostile.esp", tes4(Buffer.alloc(0), 0xffffffff));
    expect((await readPluginMasters(p)).kind).toBe("not-a-plugin");
  });
});

/**
 * ──────────────────────────────────────────────────────────────────────
 * A master list that could not be read in full is not a short master list.
 *
 * The walk used to `break` on a subrecord whose declared size overran the
 * header and then return `{kind: "ok", masters}` with whatever it had
 * collected. `sawHedr` guards the "dataSize too small" shape, but it cannot
 * guard this one: the bad subrecord comes AFTER the HEDR, so the flag is
 * already true and the partial list sails through.
 *
 * The consequence is the one this module's own docblock says must never
 * happen — "needs nothing" passes the build gate, so a plugin whose masters
 * were lost ships silently, and the collection is unloadable on a machine
 * that lacks them.
 * ──────────────────────────────────────────────────────────────────────
 */
describe("a header it could not finish reading", () => {
  it("refuses rather than returning the masters it happened to reach", async () => {
    /**
     * Real HEDR, one real master, then a subrecord claiming 400 bytes it does
     * not have. The old code returned ok with ["Skyrim.esm"] — a list that is
     * true as far as it goes and wrong as an answer.
     *
     * The type is `ONAM` and that now matters. This fixture used the four
     * letters `XXXX` as a stand-in for "some subrecord", and XXXX turns out to
     * be a REAL tag with its own meaning — the oversized-subrecord marker —
     * so the file now exercises that path instead of this guard. A neutral
     * type keeps the test measuring what its name says.
     */
    const overrun = Buffer.concat([
      Buffer.from("ONAM", "latin1"),
      (() => {
        const n = Buffer.alloc(2);
        n.writeUInt16LE(400);
        return n;
      })(),
      Buffer.alloc(4),
    ]);
    const body = Buffer.concat([hedr(), mast("Skyrim.esm"), overrun]);
    const file = await write("overrun.esp", tes4(body));

    const read = await readPluginMasters(file);
    expect(read.kind).toBe("not-a-plugin");
    if (read.kind === "not-a-plugin") {
      expect(read.why).toContain("runs past");
    }
  });

  it("still reads a header whose subrecords all fit", async () => {
    // The guard must not fire on a well-formed plugin.
    const body = Buffer.concat([hedr(), mast("Skyrim.esm"), mast("Dawnguard.esm")]);
    const file = await write("fine.esp", tes4(body));

    const read = await readPluginMasters(file);
    expect(read.kind).toBe("ok");
    if (read.kind === "ok") {
      expect(read.masters).toEqual(["Skyrim.esm", "Dawnguard.esm"]);
    }
  });
});

describe("which masters a collection is not expected to ship", () => {
  it("knows the base game masters for both supported games", () => {
    expect(isBaseGameMaster("Skyrim.esm", "skyrimse")).toBe(true);
    expect(isBaseGameMaster("Dragonborn.esm", "skyrimse")).toBe(true);
    expect(isBaseGameMaster("Fallout4.esm", "fallout4")).toBe(true);
    expect(isBaseGameMaster("DLCCoast.esm", "fallout4")).toBe(true);
    // Not cross-wired between games.
    expect(isBaseGameMaster("Fallout4.esm", "skyrimse")).toBe(false);
  });

  it("recognises Creation Club content for FALLOUT 4, not only Skyrim", () => {
    /**
     * The regression this file was written for. The old patterns were
     * `/^cc[a-z0-9]+_/` — which requires an UNDERSCORE, and every real CC
     * name uses a hyphen — and `/^cc[a-z]{3}sse\d/`, which hardcodes `sse`.
     * So all eight of these returned false, and a Fallout 4 collection whose
     * plugin needed a CC master was REFUSED with an instruction the curator
     * cannot follow: Creation Club content is not shippable.
     */
    for (const name of [
      "ccBGSFO4001-PipBoy(Black).esl",
      "ccBGSFO4016-Prey.esl",
      "ccBGSFO4044-HellfirePowerArmor.esl",
      "ccFSVFO4001-ModularMilitary.esl",
      "ccFRSFO4001-HandmadeShotgun.esl",
      "ccOTMFO4001-Remnants.esl",
    ]) {
      expect(isCreationClubMaster(name), name).toBe(true);
    }
  });

  it("still recognises Creation Club content for Skyrim", () => {
    for (const name of [
      "ccBGSSSE001-Fish.esm",
      "ccQDRSSE001-SurvivalMode.esl",
      "ccBGSSSE037-Curios.esl",
    ]) {
      expect(isCreationClubMaster(name), name).toBe(true);
    }
  });

  it("recognises Anniversary Edition's resource pack as user-owned", () => {
    // Not base-game (not every user has AE) and not `cc*`-shaped, so without
    // naming it a plugin mastered on it hard-refuses the build.
    expect(isCreationClubMaster("_ResourcePack.esl")).toBe(false);
    expect(isUserOwnedMaster("_ResourcePack.esl", "skyrimse")).toBe(true);
  });

  it("does not mistake an ordinary mod for Creation Club content", () => {
    // The pattern has to stay narrow: a false positive here SILENCES a real
    // missing master, which is the failure the whole gate exists to catch.
    for (const name of [
      "ccBGSNotReallyCC.esp",
      "Campfire.esm",
      "ccc.esp",
      "cchouse_mod.esp",
    ]) {
      expect(isCreationClubMaster(name), name).toBe(false);
    }
  });
});

/**
 * ──────────────────────────────────────────────────────────────────────
 * Every game the masters gate runs on needs a base-master list.
 *
 * The table held two entries — Skyrim SE and Fallout 4 — while the gate fires
 * on five. `comparePlugins` gives Skyrim VR, Fallout 4 VR and Enderal SE the
 * readable Fallout-4 plugins.txt format, and `buildPreflight` judges their
 * plugin budgets, so `enabledPlugins` is non-empty on all three.
 *
 * A base master missing from here is missing from `available` too — that is
 * the entire reason the table exists, since implicit masters are not written
 * to plugins.txt. `checkMasters` then calls it `missing` and the gate REFUSES
 * the build, telling the curator to "add the mod that provides each master"
 * about a file that ships with the game.
 * ──────────────────────────────────────────────────────────────────────
 */
describe("the base masters of every supported game", () => {
  it("knows Skyrim VR's, including its own root master", () => {
    expect(isBaseGameMaster("Skyrim.esm", "skyrimvr")).toBe(true);
    expect(isBaseGameMaster("Dragonborn.esm", "skyrimvr")).toBe(true);
    expect(isBaseGameMaster("SkyrimVR.esm", "skyrimvr")).toBe(true);
  });

  it("knows Fallout 4 VR's, including Fallout4_VR.esm", () => {
    // A FO4VR plugin commonly declares both, and neither was in any list on
    // any code path — so every VR build refused.
    expect(isBaseGameMaster("Fallout4.esm", "fallout4vr")).toBe(true);
    expect(isBaseGameMaster("Fallout4_VR.esm", "fallout4vr")).toBe(true);
    expect(isBaseGameMaster("DLCCoast.esm", "fallout4vr")).toBe(true);
  });

  it("knows Enderal SE's, which is Skyrim plus its own", () => {
    // A total conversion built on Skyrim SE: it ships its own master and its
    // plugins still declare Skyrim's.
    expect(isBaseGameMaster("Skyrim.esm", "enderalspecialedition")).toBe(true);
    expect(
      isBaseGameMaster("Enderal - Forgotten Stories.esm", "enderalspecialedition"),
    ).toBe(true);
  });

  it("does not leak one game's masters into another", () => {
    // The lists are per-game for a reason: treating Fallout's masters as
    // present on Skyrim would SILENCE a genuinely missing master, which is
    // the failure the gate exists to catch.
    expect(isBaseGameMaster("Fallout4.esm", "skyrimse")).toBe(false);
    expect(isBaseGameMaster("Skyrim.esm", "fallout4")).toBe(false);
    expect(isBaseGameMaster("SkyrimVR.esm", "skyrimse")).toBe(false);
    expect(isBaseGameMaster("Fallout4_VR.esm", "fallout4")).toBe(false);
  });

  it("still answers false for a game it has never heard of", () => {
    // Unknown stays unknown. Inventing a list would be worse than refusing.
    expect(isBaseGameMaster("Skyrim.esm", "morrowind")).toBe(false);
  });
});

describe("readPluginHeader", () => {
  it("reads masters and flags from one open, and agrees with readPluginMasters", async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "eh-header-"));
    try {
      const hedr = subrecord("HEDR", Buffer.alloc(12));
      const body = Buffer.concat([hedr, subrecord("MAST", Buffer.from("Skyrim.esm\0", "latin1"))]);
      const head = Buffer.alloc(24);
      head.write("TES4", 0, 4, "latin1");
      head.writeUInt32LE(body.length, 4);
      // Bit 0 (master) and bit 9 (light) set.
      head.writeUInt32LE(0x201, 8);
      const file = path.join(dir, "Light.esp");
      await fsp.writeFile(file, Buffer.concat([head, body]));
      const read = await readPluginHeader(file, pluginCapabilityFor("skyrimse"));
      expect(read).toEqual({
        kind: "ok",
        masters: ["Skyrim.esm"],
        flags: { isLight: true, isMaster: true, isMedium: false },
      });
      expect(await readPluginMasters(file)).toEqual({ kind: "ok", masters: ["Skyrim.esm"] });
      expect((await readPluginHeader(path.join(dir, "missing.esp"), pluginCapabilityFor("skyrimse"))).kind).toBe(
        "not-found",
      );

      // The same bytes in Starfield: 0x200 is not its light bit. This file
      // carried its own copy of 0x200 and read every game that way.
      const sf = await readPluginHeader(file, pluginCapabilityFor("starfield"));
      expect(sf.kind === "ok" && sf.flags).toEqual({ isLight: false, isMaster: true, isMedium: false });

      // An unknown game: masters are still facts, flags are not.
      const unknown = await readPluginHeader(file, undefined);
      expect(unknown.kind === "ok" && unknown.masters).toEqual(["Skyrim.esm"]);
      expect(unknown.kind === "ok" && unknown.flags).toBeUndefined();
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });
});

/**
 * ──────────────────────────────────────────────────────────────────────
 * A SUBRECORD TOO BIG FOR ITS OWN SIZE FIELD.
 *
 * A subrecord's length is a uint16, so anything over 65,535 bytes cannot state
 * its own size. The format's answer is `XXXX`: a 4-byte subrecord whose data
 * is the uint32 real length of the subrecord that follows, and that following
 * subrecord writes 0 in its own size field.
 *
 * The walk did not know that, so it read the next subrecord as zero bytes long
 * and then parsed its PAYLOAD as more subrecords — garbage types, and a few
 * hundred kilobytes later a length that overruns the buffer. The overrun guard
 * then refused the whole file, which was the right call for what it could see
 * and the wrong answer for the file.
 *
 * Measured on this machine, over 2,486 real plugins: exactly two failed, and
 * they were `unofficial skyrim special edition patch.esp` and `Unofficial
 * Fallout 4 Patch.esp` — the most-installed plugin of each game and the
 * cornerstone of both collections here. Their MAST entries all sit BEFORE the
 * XXXX and had been read correctly; the refusal threw them away. Downstream:
 * the masters gate counted them unreadable, the curator's requirements pass
 * lost their masters, and the ESL flag tool could not read their header.
 *
 * Found by running the parser against every plugin on disk rather than by
 * reading it again (GP-1). The fixtures below are synthetic so the regression
 * is deterministic and does not need a 21 MB file.
 * ──────────────────────────────────────────────────────────────────────
 */
describe("a header carrying an oversized subrecord (XXXX)", () => {
  /** `XXXX` holding the real length of whatever comes next. */
  const xxxx = (realSize: number): Buffer => {
    const data = Buffer.alloc(4);
    data.writeUInt32LE(realSize, 0);
    return subrecord("XXXX", data);
  };

  /** A subrecord whose size field is 0 because an XXXX precedes it. */
  const oversized = (type: string, bytes: number): Buffer => {
    const head = Buffer.alloc(6);
    head.write(type, 0, 4, "latin1");
    head.writeUInt16LE(0, 4);
    // Filled with bytes that would look like subrecord types if walked wrongly
    // — which is exactly how the real failure produced its garbage.
    return Buffer.concat([head, Buffer.alloc(bytes, 0x41)]);
  };

  it("reads the masters of a plugin whose ONAM needs XXXX", async () => {
    // USSEP's real shape: HEDR, the masters, then XXXX + a ~100KB ONAM.
    const big = 70_000;
    const p = await write(
      "ussep-shaped.esp",
      tes4(
        Buffer.concat([
          hedr(),
          mast("Skyrim.esm"),
          mast("Update.esm"),
          xxxx(big),
          oversized("ONAM", big),
        ]),
      ),
    );
    expect(await readPluginMasters(p)).toEqual({
      kind: "ok",
      masters: ["Skyrim.esm", "Update.esm"],
    });
  });

  it("keeps reading subrecords AFTER the oversized one", async () => {
    // The length applies to exactly one subrecord. If it leaked to the next,
    // or the walk resumed at the wrong offset, this master would be lost —
    // and a lost master is the failure this whole file exists to prevent.
    const big = 70_000;
    const p = await write(
      "master-after-onam.esp",
      tes4(
        Buffer.concat([
          hedr(),
          mast("Skyrim.esm"),
          xxxx(big),
          oversized("ONAM", big),
          mast("Dawnguard.esm"),
        ]),
      ),
    );
    expect(await readPluginMasters(p)).toEqual({
      kind: "ok",
      masters: ["Skyrim.esm", "Dawnguard.esm"],
    });
  });

  it("refuses an XXXX that does not hold a 4-byte length", async () => {
    // Fail closed on a shape we do not understand: guessing at a length is
    // how the walk desynchronised in the first place.
    const p = await write(
      "bad-xxxx.esp",
      tes4(Buffer.concat([hedr(), mast("Skyrim.esm"), subrecord("XXXX", Buffer.alloc(2))])),
    );
    const read = await readPluginMasters(p);
    expect(read.kind).toBe("not-a-plugin");
    if (read.kind === "not-a-plugin") expect(read.why).toMatch(/XXXX/);
  });

  it("still refuses an oversized length that overruns the header", async () => {
    // The guard that caught the original desync has to keep working: an XXXX
    // claiming more than the header holds is corruption, not a big ONAM.
    const p = await write(
      "xxxx-overruns.esp",
      tes4(Buffer.concat([hedr(), mast("Skyrim.esm"), xxxx(500_000), oversized("ONAM", 10)])),
    );
    const read = await readPluginMasters(p);
    expect(read.kind).toBe("not-a-plugin");
    if (read.kind === "not-a-plugin") expect(read.why).toMatch(/runs past/);
  });
});
