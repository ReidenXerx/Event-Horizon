/**
 * alasdairn, Meridia 1.0.55 (2026-11-22): after a staging-folder Reinitialize
 * Vortex still listed 1,674 mods with no folders, and the preview adopted 433
 * of them as already installed.
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { folderPositivelyMissing, splitFolderlessMods } from "./folderlessMods";

const mod = (name: string, installationPath?: string) => ({ name, installationPath });

describe("mods Vortex lists without a staging folder", () => {
  it("drops a mod whose folder is gone and keeps one whose folder is there", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "eh-folderless-"));
    try {
      fs.mkdirSync(path.join(root, "Here-1-0"));
      const { present, folderless } = splitFolderlessMods(
        [mod("here", "Here-1-0"), mod("gone", "Gone-2-0")],
        root,
      );
      expect(present.map((m) => m.name)).toEqual(["here"]);
      expect(folderless.map((m) => m.name)).toEqual(["gone"]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps every mod when the staging root or folder name is unknown", () => {
    const never = () => true;
    expect(splitFolderlessMods([mod("a", "A")], undefined, never).present).toHaveLength(1);
    expect(splitFolderlessMods([mod("b")], "C:/staging", never).present).toHaveLength(1);
  });

  it("calls only 'not found' missing, never a check that failed another way", () => {
    expect(folderPositivelyMissing(path.join(os.tmpdir(), "eh-no-such-folder-" + process.pid))).toBe(true);
    expect(folderPositivelyMissing(os.tmpdir())).toBe(false);
  });

  it("filters the pool before both preview pipelines hash or resolve it", () => {
    const src = readFileSync(new URL("../../ui/pages/install/engine.ts", import.meta.url), "utf8");
    expect(src.split("withoutFolderlessMods(").length - 1).toBe(2);
    expect(src).not.toMatch(/const rawMods = getModsForGame\(/);
  });
});
