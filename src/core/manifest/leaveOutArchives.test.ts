/**
 * A bundled or mirrored mod ships without any file that is itself an archive,
 * and the file list the manifest records for it says the same, so every user's
 * install verifies, identifies and mirrors the mod as the package carries it.
 * A mod that does not ship keeps its list untouched.
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { leaveOutArchiveFiles } from "./leaveOutArchives";
import type { AuditorMod } from "../getModsListForProfile";

let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "eh-leave-out-"));
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

const ZIP = Buffer.from([0x50, 0x4b, 0x03, 0x04, 20, 0, 0, 0]);

const put = (rel: string, body: string | Buffer): void => {
  const full = path.join(root, ...rel.split("/"));
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, body);
};

const mod = (id: string, files: string[]): AuditorMod =>
  ({
    id,
    name: `Mod ${id}`,
    installationPath: id,
    stagingFiles: files.map((p) => ({ path: p, size: 1, sha256: "a".repeat(64) })),
  }) as unknown as AuditorMod;

describe("leaveOutArchiveFiles", () => {
  it("leaves archive files out of the mods that ship, judged by content, and says which", async () => {
    put("bundled/plugin.esp", "TES4");
    // A zip-based document, named like one: the bytes decide.
    put("bundled/docs/readme.docx", ZIP);
    put("mirrored/Lib/test/zipdir.dat", ZIP);
    put("mirrored/scripts/quest.pex", "pex");

    const out = await leaveOutArchiveFiles({
      mods: [mod("bundled", ["plugin.esp", "docs/readme.docx"]), mod("mirrored", ["Lib/test/zipdir.dat", "scripts/quest.pex"])],
      shippedModIds: new Set(["bundled", "mirrored"]),
      installRoot: root,
    });

    expect(out.mods.map((m) => m.stagingFiles?.map((f) => f.path))).toEqual([["plugin.esp"], ["scripts/quest.pex"]]);
    expect(out.leftOut).toEqual([
      { modId: "bundled", modName: "Mod bundled", path: "docs/readme.docx", format: "zip" },
      { modId: "mirrored", modName: "Mod mirrored", path: "Lib/test/zipdir.dat", format: "zip" },
    ]);
  });

  it("leaves a mod that does not ship exactly as it was, archives and all", async () => {
    put("nexus/readme.docx", ZIP);
    const nexus = mod("nexus", ["readme.docx"]);

    const out = await leaveOutArchiveFiles({ mods: [nexus], shippedModIds: new Set(), installRoot: root });

    expect(out.mods[0]).toBe(nexus);
    expect(out.leftOut).toEqual([]);
  });

  it("keeps a file it cannot open, for the step that reads it to name", async () => {
    fs.mkdirSync(path.join(root, "gone"));
    const shipped = mod("gone", ["vanished.zip"]);

    const out = await leaveOutArchiveFiles({ mods: [shipped], shippedModIds: new Set(["gone"]), installRoot: root });

    expect(out.mods[0]!.stagingFiles?.map((f) => f.path)).toEqual(["vanished.zip"]);
    expect(out.leftOut).toEqual([]);
  });
});
