/**
 * What the master gate hands the manifest for the install's Creation Club
 * check, read from real plugin headers on disk.
 *
 * The list must be absent when the gate learned nothing: an empty list is
 * "needs none", and a build that could not read a single plugin would tell
 * every player that.
 */
import * as fsp from "fs/promises";
import * as os from "os";
import * as path from "path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { gateOnMasters } from "./gateOnMasters";

const subrecord = (type: string, data: Buffer): Buffer => {
  const head = Buffer.alloc(6);
  head.write(type, 0, 4, "latin1");
  head.writeUInt16LE(data.length, 4);
  return Buffer.concat([head, data]);
};
const plugin = (masters: string[]): Buffer => {
  const body = Buffer.concat([
    subrecord("HEDR", Buffer.alloc(12)),
    ...masters.map((m) => subrecord("MAST", Buffer.from(`${m}\0`, "latin1"))),
  ]);
  const header = Buffer.alloc(24);
  header.write("TES4", 0, 4, "latin1");
  header.writeUInt32LE(body.length, 4);
  return Buffer.concat([header, body]);
};

let gameDir: string;
beforeEach(async () => {
  gameDir = await fsp.mkdtemp(path.join(os.tmpdir(), "eh-gate-"));
  await fsp.mkdir(path.join(gameDir, "Data"));
  await fsp.writeFile(path.join(gameDir, "Data", "Mod.esp"), plugin(["Skyrim.esm", "ccBGSSSE001-Fish.esm", "_ResourcePack.esl"]));
  await fsp.writeFile(path.join(gameDir, "Data", "Other.esp"), plugin(["Skyrim.esm", "ccbgssse001-fish.esm", "Mod.esp"]));
});
afterEach(async () => {
  await fsp.rm(gameDir, { recursive: true, force: true });
});

const shipped = [{ stagingFiles: [{ path: "Mod.esp" }, { path: "Other.esp" }] }];

describe("gateOnMasters — the Creation Club files for the manifest", () => {
  it("lists each file the plugins need and no collection can ship, once, sorted", async () => {
    const result = await gateOnMasters({
      gameId: "skyrimse",
      gameDir,
      pluginsTxtContent: "*Mod.esp\n*Other.esp\n",
      mods: shipped,
    });
    expect(result.refusal).toBeUndefined();
    expect(result.userOwnedMasters).toEqual(["_ResourcePack.esl", "ccBGSSSE001-Fish.esm"]);
  });

  it("records an empty list for plugins that need none", async () => {
    await fsp.writeFile(path.join(gameDir, "Data", "Mod.esp"), plugin(["Skyrim.esm"]));
    await fsp.writeFile(path.join(gameDir, "Data", "Other.esp"), plugin(["Skyrim.esm", "Mod.esp"]));
    const result = await gateOnMasters({ gameId: "skyrimse", gameDir, pluginsTxtContent: "*Mod.esp\n*Other.esp\n", mods: shipped });
    expect(result.userOwnedMasters).toEqual([]);
  });

  it("records nothing when no plugin could be read, or there was no plugin list", async () => {
    const unreadable = await gateOnMasters({ gameId: "skyrimse", gameDir, pluginsTxtContent: "*Gone.esp\n", mods: shipped });
    expect("userOwnedMasters" in unreadable).toBe(false);
    const noList = await gateOnMasters({ gameId: "skyrimse", gameDir, pluginsTxtContent: undefined, mods: shipped });
    expect("userOwnedMasters" in noList).toBe(false);
  });

  it("keeps what a partly readable profile shows: short of the truth, it can only miss a file", async () => {
    const result = await gateOnMasters({ gameId: "skyrimse", gameDir, pluginsTxtContent: "*Mod.esp\n*Gone.esp\n", mods: shipped });
    expect(result.userOwnedMasters).toEqual(["_ResourcePack.esl", "ccBGSSSE001-Fish.esm"]);
  });
});
