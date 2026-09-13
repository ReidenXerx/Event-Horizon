/**
 * ──────────────────────────────────────────────────────────────────────
 * The name of a bundled mod's archive is the name of the user's mod.
 *
 * Vortex derives a mod's name — and therefore its staging FOLDER — from the
 * archive it installed. A bundled mod is named by its sha256 inside the
 * package, so writing its archive under that name gave a tester mod folders
 * called `b3d8853c…` and a reasonable question about what they were.
 *
 * The cosmetic complaint was the smaller half.
 * `enrichInstalledModsWithStagingSetHashes` only hashes installed mods whose
 * NAME matches an external manifest entry, and `b3d8853c…` matches nothing.
 * So no staging-set hash was ever computed, the resolver's second identity
 * rung could not fire, and every bundled external mod was reinstalled on
 * every resume. From the tester's log, on a resume with 1,105 mods already
 * installed and 29 external mods in the manifest:
 *
 *     resolver.staging-hashes.done {"wanted":29,"candidates":0,"enriched":0}
 *
 * Zero candidates, on every run in the file.
 * ──────────────────────────────────────────────────────────────────────
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { bundleEntries, writePackage } from "../manifest/bundlePackage.testutil";
import {
  bundledArchiveFileName,
  writeBundledArchive,
  safeRmTempDir,
} from "./modInstall";

const SHA = "b3d8853c".padEnd(64, "0");

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "eh-bundled-name-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("bundledArchiveFileName", () => {
  it("uses the curator's mod name", () => {
    expect(bundledArchiveFileName(SHA, "High_Poly_Head_v1.4_(SE)-80968")).toBe(
      "High_Poly_Head_v1.4_(SE)-80968.zip",
    );
  });

  it("falls back to the bundle's sha when given no name", () => {
    expect(bundledArchiveFileName(SHA, undefined)).toBe(`${SHA}.zip`);
  });

  it("always names a .zip, whatever the mod name happens to end in", () => {
    /**
     * The trap this function exists around. Vortex disambiguates duplicate mod
     * names by appending `.1`, `.2` — so the curator's mod is genuinely called
     * "IDE WHITERUN-149724-1-1746902603.1". That trailing `.1` is a counter,
     * not a file type, and neither is a `.7z` left over in a mod's name: the
     * archive is always the bundle's zip.
     */
    expect(bundledArchiveFileName(SHA, "IDE WHITERUN-149724-1-1746902603.1")).toBe(
      "IDE WHITERUN-149724-1-1746902603.1.zip",
    );
    expect(bundledArchiveFileName(SHA, "Old Mod.7z")).toBe("Old Mod.7z.zip");
  });

  it("does not double the extension when the name already ends in it", () => {
    expect(bundledArchiveFileName(SHA, "Cool Mod.zip")).toBe("Cool Mod.zip");
    expect(bundledArchiveFileName(SHA, "Loud Mod.ZIP")).toBe("Loud Mod.ZIP");
  });

  it("replaces characters Windows cannot put in a file name", () => {
    expect(bundledArchiveFileName(SHA, 'a/b\\c:d*e?f"g<h>i|j')).toBe(
      "a_b_c_d_e_f_g_h_i_j.zip",
    );
  });

  it("falls back rather than writing a name that says nothing", () => {
    /**
     * A name made only of separators sanitises to `___`, which is a legal file
     * name and a useless one — it identifies neither the mod nor the bytes.
     * The sha at least identifies the bytes, so a name with no letter or digit
     * left in it is treated as no name at all.
     */
    expect(bundledArchiveFileName(SHA, "///")).toBe(`${SHA}.zip`);
    expect(bundledArchiveFileName(SHA, "   ")).toBe(`${SHA}.zip`);
    // One real character is enough — this is a floor, not a quality bar.
    expect(bundledArchiveFileName(SHA, "|a|")).toBe("_a_.zip");
  });

  it("truncates a long name without losing the extension", () => {
    const out = bundledArchiveFileName(SHA, "x".repeat(400));
    // Win32 MAX_PATH is spent on the temp dir before we get here.
    expect(out.length).toBeLessThan(140);
    expect(out.endsWith(".zip")).toBe(true);
  });
});

describe("the archive lands under the mod's name", () => {
  it("writes <mod name>.zip inside bundled/, which cleanup depends on", async () => {
    const { folder, entries } = await bundleEntries({ "Vampire.esp": "TES4 vampire bytes" });
    const { extractedPath, tempDir } = await writeBundledArchive(
      writePackage(dir, "p.ehcoll", entries),
      folder,
      "Vampire Armors and Weapons Retexture SE-96855",
    );
    try {
      expect(extractedPath).toBe(
        path.join(tempDir, "bundled", "Vampire Armors and Weapons Retexture SE-96855.zip"),
      );
      // The returned path must be the file that EXISTS, not merely the one we
      // intended — the caller hands this straight to Vortex.
      expect(fs.existsSync(extractedPath)).toBe(true);
    } finally {
      await safeRmTempDir(tempDir);
    }
  });
});
