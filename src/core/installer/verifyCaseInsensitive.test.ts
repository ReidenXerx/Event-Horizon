/**
 * A path that differs only in case is the same file.
 *
 * ─── THE REPORT THIS COMES FROM ─────────────────────────────────────────────
 * A real 1,755-mod install finished successfully and told the user that eight
 * mods "did not end up matching the collection, even after reinstalling", with
 * a report ready to paste to the curator. FOUR of the eight were nothing but
 * letter case, and the tell was that the missing and extra counts matched
 * exactly every time:
 *
 *     CBBE 3BA                  missing 30 / extra 30   scripts/ vs Scripts/
 *     Recorder Bugfix Patch     missing  1 / extra  1   00000D70 vs 00000d70
 *     Project ja-Kha'jay        missing 16 / extra 16   /Male/ vs /male/
 *     Snazzy Location Resources missing 28 / extra 28   /smallroomsecond/ vs /SmallRoomSecond/
 *
 * The other four had missing files and NO extras — genuinely absent, and the
 * distinction these tests protect.
 *
 * The mirror pass in the same install had keyed by lowercased path since it
 * was written. Verification compared verbatim. One install, two answers to
 * "are these the same file".
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { __testPaths } from "@nexusmods/vortex-api";
import type { types } from "@nexusmods/vortex-api";

import { verifyModInstall } from "./verifyModInstall";
import type { EhcollStagingFile } from "../../types/ehcoll";

const MOD = "CBBE 3BA (3BBB)-30174-2-48-1740765899";
const GAME = "skyrimse";

let installRoot: string;
let stagingRoot: string;

beforeEach(() => {
  installRoot = fs.mkdtempSync(path.join(os.tmpdir(), "eh-case-"));
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

/** Write a file at the spelling the USER's extraction produced. */
function place(rel: string, bytes: string): void {
  const abs = path.join(stagingRoot, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, bytes);
}

/** What the CURATOR's manifest recorded, at their spelling. */
const expected = (p: string, bytes: string): EhcollStagingFile =>
  ({ path: p, size: bytes.length }) as EhcollStagingFile;

describe("the curator and the user spelled the path differently", () => {
  it("passes when only the CASE of a directory differs", () => {
    const bytes = "compiled papyrus";
    place("Scripts/Mus3BAddonMCM.pex", bytes);

    return verifyModInstall({
      api: api(),
      gameId: GAME,
      vortexModId: MOD,
      expectedFiles: [expected("scripts/Mus3BAddonMCM.pex", bytes)],
      level: "thorough",
    }).then((result) => {
      expect(result.kind).toBe("ok");
      // And it must not be counted as an EXTRA either — that is the other half
      // of the false pair, and it is what made the counts match.
      if (result.kind === "ok") expect(result.extraFiles).toEqual([]);
    });
  });

  it("passes when only the case of the FILENAME differs", async () => {
    // The Recorder Bugfix Patch case: one file, one report, entirely spurious.
    const bytes = "a facegen mesh";
    place("meshes/actors/character/facegendata/facegeom/x.esp/00000d70.nif", bytes);

    const result = await verifyModInstall({
      api: api(),
      gameId: GAME,
      vortexModId: MOD,
      expectedFiles: [
        expected(
          "meshes/actors/character/facegendata/facegeom/x.esp/00000D70.nif",
          bytes,
        ),
      ],
      level: "thorough",
    });
    expect(result.kind).toBe("ok");
  });

  it("matches across separators as well as case", async () => {
    // The manifest carries POSIX `/` from the walker; a Windows walk produces
    // `\`. Neither is a fact about the file.
    const bytes = "textures";
    place(path.join("textures", "KhajiitDiversity", "male", "body.dds"), bytes);

    const result = await verifyModInstall({
      api: api(),
      gameId: GAME,
      vortexModId: MOD,
      expectedFiles: [
        expected("textures\\KhajiitDiversity\\Male\\body.dds", bytes),
      ],
      level: "thorough",
    });
    expect(result.kind).toBe("ok");
  });
});

describe("what must STILL fail", () => {
  it("reports a genuinely missing file, with no extra to pair it with", async () => {
    /**
     * The other four reports in that run — Regional Merchants, Better Animals,
     * DynDOLOD TexGen Fixes, Helios — had missing files and NO extras. Those
     * are real, and a case-insensitive match must not swallow them.
     */
    place("textures/present.dds", "here");

    const result = await verifyModInstall({
      api: api(),
      gameId: GAME,
      vortexModId: MOD,
      expectedFiles: [
        expected("textures/present.dds", "here"),
        expected("meshes/absent.nif", "gone"),
      ],
      level: "thorough",
    });
    expect(result.kind).toBe("fail");
    if (result.kind === "fail") {
      expect(result.missingFiles).toEqual(["meshes/absent.nif"]);
      expect(result.extraFiles).toEqual([]);
    }
  });

  it("still catches different BYTES at a case-differing path", async () => {
    // Case-insensitivity decides which files to compare; it must not decide
    // that they match.
    place("Scripts/Foo.pex", "the wrong bytes entirely");

    const result = await verifyModInstall({
      api: api(),
      gameId: GAME,
      vortexModId: MOD,
      expectedFiles: [expected("scripts/Foo.pex", "short")],
      level: "thorough",
    });
    expect(result.kind).toBe("fail");
    if (result.kind === "fail") {
      expect(result.sizeMismatches.map((m) => m.path)).toEqual([
        "scripts/Foo.pex",
      ]);
    }
  });

  it("still reports a file the user has that the curator never recorded", async () => {
    place("textures/present.dds", "here");
    place("textures/mine.dds", "not the curator's");

    const result = await verifyModInstall({
      api: api(),
      gameId: GAME,
      vortexModId: MOD,
      expectedFiles: [expected("textures/present.dds", "here")],
      level: "thorough",
    });
    // Extras are informational, so this still passes — but the file must be
    // named, or "case-insensitive" has quietly become "ignore everything".
    expect(result.kind).toBe("ok");
    if (result.kind === "ok") {
      expect(result.extraFiles).toEqual(["textures/mine.dds"]);
    }
  });
});
