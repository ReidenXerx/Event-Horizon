/**
 * The tester's case, end to end, on real files.
 *
 * A 1755-mod install reported seven healthy mods as needing repair. Each had
 * exactly one difference: `SKSE/Plugins/<name>.log`, a file the SKSE plugin
 * appends to every time Skyrim starts — 460 bytes on the curator's machine,
 * 462 on the user's. That failed verification, which sent the mod to the
 * repair path, which correctly refused to touch a mod it had not installed
 * (NS-2) and reported it as unrepairable.
 *
 * These tests run against a REAL staging folder on disk and a manifest that
 * STILL LISTS the log — the shape of the packages already in testers' hands.
 * That is the half that matters: the fix has to work without a repack.
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { __testPaths } from "@nexusmods/vortex-api";
import type { types } from "@nexusmods/vortex-api";

import { verifyModInstall } from "./verifyModInstall";
import type { EhcollStagingFile } from "../../types/ehcoll";

const MOD = "Bug Fixes SSE-33261-10-1678780224";
const GAME = "skyrimse";

let installRoot: string;
let stagingRoot: string;

beforeEach(() => {
  installRoot = fs.mkdtempSync(path.join(os.tmpdir(), "eh-verify-"));
  __testPaths.installPath = installRoot;
  stagingRoot = path.join(installRoot, MOD);
  fs.mkdirSync(path.join(stagingRoot, "SKSE", "Plugins"), { recursive: true });
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

/** Write a file under the staging root and return its manifest entry. */
function place(rel: string, bytes: string): EhcollStagingFile {
  const abs = path.join(stagingRoot, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, bytes);
  return { path: rel.split(path.sep).join("/"), size: bytes.length } as EhcollStagingFile;
}

describe("verifying a mod whose only difference is a runtime log", () => {
  it("passes, even though the manifest still records the log", async () => {
    // Content: identical, as it is on a healthy machine.
    const dll = place("SKSE/Plugins/BugFixesSSE.dll", "REAL-CONTENT");
    // The log: recorded by the curator at 460 bytes, ours is longer because
    // this machine has launched the game more times. Nothing can fix that.
    place("SKSE/Plugins/BugFixesSSE.log", "x".repeat(462));
    const curatorLog = { path: "SKSE/Plugins/BugFixesSSE.log", size: 460 } as EhcollStagingFile;

    const result = await verifyModInstall({
      api: api(),
      gameId: GAME,
      vortexModId: MOD,
      // The manifest as it exists in packages ALREADY SHIPPED.
      expectedFiles: [dll, curatorLog],
      level: "thorough",
    });

    expect(result.kind).toBe("ok");
  });

  it("does not report the curator's log as MISSING when we have none", async () => {
    // The other way the same file breaks it: this machine never launched the
    // game, so the log does not exist here at all. Filtering only the on-disk
    // side would turn the size mismatch into a `missing`, which is worse —
    // missing is the signal that a reinstall could actually help.
    const dll = place("SKSE/Plugins/BugFixesSSE.dll", "REAL-CONTENT");
    const curatorLog = { path: "SKSE/Plugins/BugFixesSSE.log", size: 460 } as EhcollStagingFile;

    const result = await verifyModInstall({
      api: api(),
      gameId: GAME,
      vortexModId: MOD,
      expectedFiles: [dll, curatorLog],
      level: "thorough",
    });

    expect(result.kind).toBe("ok");
  });

  it("does not count Thumbs.db we happen to have as an EXTRA file", async () => {
    const dll = place("textures/armor/mongol/blade.dds", "PIXELS");
    place("textures/armor/mongol/Thumbs.db", "explorer junk");

    const result = await verifyModInstall({
      api: api(),
      gameId: GAME,
      vortexModId: MOD,
      expectedFiles: [dll],
      level: "thorough",
    });

    expect(result.kind).toBe("ok");
    if (result.kind === "ok") expect(result.extraFiles).toEqual([]);
  });

  it("STILL fails when real content differs", async () => {
    /**
     * The half that makes the rest of this trustworthy. Excluding volatile
     * files must not shade into excluding the failures verification exists to
     * find — an exclusion list is one careless line from silently passing
     * everything, and that failure looks exactly like success.
     */
    place("SKSE/Plugins/BugFixesSSE.dll", "TAMPERED");
    place("SKSE/Plugins/BugFixesSSE.log", "x".repeat(462));

    const result = await verifyModInstall({
      api: api(),
      gameId: GAME,
      vortexModId: MOD,
      expectedFiles: [
        { path: "SKSE/Plugins/BugFixesSSE.dll", size: 12 } as EhcollStagingFile,
        { path: "SKSE/Plugins/BugFixesSSE.log", size: 460 } as EhcollStagingFile,
      ],
      level: "thorough",
    });

    expect(result.kind).toBe("fail");
    if (result.kind === "fail") {
      // The .dll, and ONLY the .dll.
      expect(result.sizeMismatches.map((m) => m.path)).toEqual([
        "SKSE/Plugins/BugFixesSSE.dll",
      ]);
      // And the count no longer promises to have checked a file it skipped.
      expect(result.expectedCount).toBe(1);
    }
  });

  it("STILL reports a genuinely missing content file", async () => {
    place("SKSE/Plugins/BugFixesSSE.log", "x".repeat(462));

    const result = await verifyModInstall({
      api: api(),
      gameId: GAME,
      vortexModId: MOD,
      expectedFiles: [
        { path: "SKSE/Plugins/BugFixesSSE.dll", size: 12 } as EhcollStagingFile,
        { path: "SKSE/Plugins/BugFixesSSE.log", size: 460 } as EhcollStagingFile,
      ],
      level: "thorough",
    });

    expect(result.kind).toBe("fail");
    if (result.kind === "fail") {
      expect(result.missingFiles).toEqual(["SKSE/Plugins/BugFixesSSE.dll"]);
    }
  });
});
