/**
 * A thorough run must not count a size-only check as verified.
 *
 * A build records a file with no `sha256` when reading it failed twice — an
 * antivirus holding a handle, a OneDrive placeholder that would not
 * rehydrate. The build warns; the manifest ships that file with a size and
 * nothing else.
 *
 * On the player's side that file was silently downgraded to a size check and
 * then counted in `verifiedCount` all the same, so the Done card said "N
 * files verified" at thorough level about files that had only been compared
 * on a number a same-size rewrite reproduces exactly. That is the one shape
 * an integrity check must never have: a count that claims work it skipped.
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as crypto from "crypto";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { __testPaths } from "@nexusmods/vortex-api";
import type { types } from "@nexusmods/vortex-api";

import { verifyModInstall } from "./verifyModInstall";
import type { EhcollStagingFile } from "../../types/ehcoll";

const MOD = "Hashless-1-0";
const GAME = "skyrimse";

let installRoot: string;
let stagingRoot: string;

beforeEach(() => {
  installRoot = fs.mkdtempSync(path.join(os.tmpdir(), "eh-hashless-"));
  __testPaths.installPath = installRoot;
  stagingRoot = path.join(installRoot, MOD);
  fs.mkdirSync(stagingRoot, { recursive: true });
});
afterEach(() => {
  fs.rmSync(installRoot, { recursive: true, force: true });
});

const api = (): types.IExtensionApi =>
  ({
    getState: () => ({
      persistent: { mods: { [GAME]: { [MOD]: { installationPath: MOD } } } },
    }),
  }) as unknown as types.IExtensionApi;

/** Write a file and return the manifest entry a thorough build would record. */
function place(rel: string, bytes: string, withHash: boolean): EhcollStagingFile {
  const abs = path.join(stagingRoot, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, bytes);
  const entry: EhcollStagingFile = { path: rel, size: bytes.length };
  if (withHash) {
    entry.sha256 = crypto.createHash("sha256").update(bytes).digest("hex");
  }
  return entry;
}

describe("a thorough run over a manifest with a hash-less file", () => {
  it("counts the hashed files as verified and reports the rest separately", async () => {
    const files = [
      place("a.esp", "aaaa", true),
      place("b.esp", "bbbb", true),
      place("c.bsa", "cccc", false),
    ];

    const result = await verifyModInstall({
      api: api(),
      gameId: GAME,
      vortexModId: MOD,
      expectedFiles: files,
      level: "thorough",
    });

    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    // Two, not three. The third was never hashed.
    expect(result.verifiedCount).toBe(2);
    expect(result.sizeOnlyCount).toBe(1);
  });

  it("still passes a file of the right size and wrong bytes — and says so", async () => {
    // This is exactly the failure the honest count exists to make visible:
    // the check CANNOT catch this, so it must not claim to have run.
    const files = [place("c.bsa", "cccc", false)];
    fs.writeFileSync(path.join(stagingRoot, "c.bsa"), "dddd");

    const result = await verifyModInstall({
      api: api(),
      gameId: GAME,
      vortexModId: MOD,
      expectedFiles: files,
      level: "thorough",
    });

    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    expect(result.verifiedCount).toBe(0);
    expect(result.sizeOnlyCount).toBe(1);
  });

  it("a fully hashed manifest reports nothing size-only", async () => {
    const files = [place("a.esp", "aaaa", true), place("b.esp", "bbbb", true)];

    const result = await verifyModInstall({
      api: api(),
      gameId: GAME,
      vortexModId: MOD,
      expectedFiles: files,
      level: "thorough",
    });

    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    expect(result.verifiedCount).toBe(2);
    expect(result.sizeOnlyCount).toBe(0);
  });

  it("a fast run counts every size check, because size is all it promised", async () => {
    const files = [place("a.esp", "aaaa", false), place("b.esp", "bbbb", false)];

    const result = await verifyModInstall({
      api: api(),
      gameId: GAME,
      vortexModId: MOD,
      expectedFiles: files,
      level: "fast",
    });

    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    expect(result.verifiedCount).toBe(2);
    expect(result.sizeOnlyCount).toBe(0);
  });
});
