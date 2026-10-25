/**
 * Ivy Rev 26 (alasdairn, 2026-10-25): MoreBeards.esp and three other plugins
 * verified "fail" (hash mismatch, same size). Each differed from the curator's
 * copy only by the light flag — which the same install's ESL flag step, run
 * after verification, set to the curator's value. The end state was right and
 * the receipt said broken.
 */
import { createHash } from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { __testPaths } from "@nexusmods/vortex-api";
import type { types } from "@nexusmods/vortex-api";

import { verifyModInstall } from "./verifyModInstall";
import { pluginCapabilityFor, sha256WithLightFlag } from "../manifest/pluginFlags";
import type { EhcollStagingFile } from "../../types/ehcoll";

const MOD = "MoreHairstyles-Beards";
const GAME = "fallout4";
const capability = pluginCapabilityFor(GAME)!;

let installRoot: string;
let stagingRoot: string;

beforeEach(() => {
  installRoot = fs.mkdtempSync(path.join(os.tmpdir(), "eh-verify-flag-"));
  __testPaths.installPath = installRoot;
  stagingRoot = path.join(installRoot, MOD);
  fs.mkdirSync(stagingRoot, { recursive: true });
});
afterEach(() => {
  fs.rmSync(installRoot, { recursive: true, force: true });
});

const api = (): types.IExtensionApi =>
  ({
    getState: () => ({ persistent: { mods: { [GAME]: { [MOD]: { installationPath: MOD } } } } }),
  }) as unknown as types.IExtensionApi;

function plugin(flags: number, body = "records"): Buffer {
  const head = Buffer.alloc(12);
  head.write("TES4", 0, "latin1");
  head.writeUInt32LE(64, 4);
  head.writeUInt32LE(flags >>> 0, 8);
  return Buffer.concat([head, Buffer.from(body.repeat(50))]);
}
const sha = (b: Buffer): string => createHash("sha256").update(b).digest("hex");

/** The archive's copy is light; the curator's is not. */
function setup(onDisk: Buffer): EhcollStagingFile {
  fs.writeFileSync(path.join(stagingRoot, "MoreBeards.esp"), onDisk);
  const curator = plugin(0x1);
  return { path: "MoreBeards.esp", size: curator.length, sha256: sha(curator) } as EhcollStagingFile;
}

const pending = {
  capability,
  lightOf: (p: string) => (p.toLowerCase() === "morebeards.esp" ? false : undefined),
};

describe("a plugin that differs only by the light flag the install writes next", () => {
  it("verifies when the flag step will make it the curator's file", async () => {
    const expected = setup(plugin(0x1 | 0x200));
    const result = await verifyModInstall({
      api: api(),
      gameId: GAME,
      vortexModId: MOD,
      expectedFiles: [expected],
      pendingLightFlags: pending,
      level: "thorough",
    });
    expect(result.kind).toBe("ok");
  });

  it("still fails without the pending flags (the Rev 26 receipt)", async () => {
    const expected = setup(plugin(0x1 | 0x200));
    const result = await verifyModInstall({
      api: api(),
      gameId: GAME,
      vortexModId: MOD,
      expectedFiles: [expected],
      level: "thorough",
    });
    expect(result.kind).toBe("fail");
  });

  it("still fails when anything besides the flag differs", async () => {
    const expected = setup(plugin(0x1 | 0x200, "RECORDS"));
    const result = await verifyModInstall({
      api: api(),
      gameId: GAME,
      vortexModId: MOD,
      expectedFiles: [expected],
      pendingLightFlags: pending,
      level: "thorough",
    });
    expect(result.kind).toBe("fail");
  });

  it("still fails when the curator's flag is the one already on disk", async () => {
    // Flag the step would write = light; the file is light; the curator's copy
    // is not. Clearing nothing cannot reach the curator's hash.
    const expected = setup(plugin(0x1 | 0x200));
    const result = await verifyModInstall({
      api: api(),
      gameId: GAME,
      vortexModId: MOD,
      expectedFiles: [expected],
      pendingLightFlags: { capability, lightOf: () => true },
      level: "thorough",
    });
    expect(result.kind).toBe("fail");
  });
});

describe("sha256WithLightFlag", () => {
  it("hashes the file as it will be after the flag is written, without writing it", async () => {
    const file = path.join(stagingRoot, "x.esp");
    const light = plugin(0x1 | 0x200);
    fs.writeFileSync(file, light);
    expect(await sha256WithLightFlag(file, false, capability)).toBe(sha(plugin(0x1)));
    expect(await sha256WithLightFlag(file, true, capability)).toBe(sha(light));
    expect(fs.readFileSync(file).equals(light)).toBe(true);
  });

  it("has no answer for a file that is not a plugin", async () => {
    const file = path.join(stagingRoot, "readme.esp");
    fs.writeFileSync(file, "not a plugin at all");
    expect(await sha256WithLightFlag(file, false, capability)).toBeUndefined();
  });
});
