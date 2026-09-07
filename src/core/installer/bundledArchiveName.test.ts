/**
 * ──────────────────────────────────────────────────────────────────────
 * The name of the extracted bundled archive is the name of the user's mod.
 *
 * Vortex derives a mod's name — and therefore its staging FOLDER — from the
 * archive it installed. A bundled entry is `bundled/<sha256>.zip`, so
 * extracting it under that name gave a tester mod folders called
 * `b3d8853c…` and a reasonable question about what they were.
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

import {
  BUNDLED_ENTRY,
  BUNDLED_SHA,
  EHCOLL_WITH_BUNDLED,
} from "../manifest/readZip.fixtures";
import {
  bundledArchiveFileName,
  extractBundledFromEhcoll,
  safeRmTempDir,
} from "./modInstall";

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "eh-bundled-name-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const pkg = (): string => {
  const p = path.join(dir, "p.ehcoll");
  fs.writeFileSync(p, Buffer.from(EHCOLL_WITH_BUNDLED, "base64"));
  return p;
};

describe("bundledArchiveFileName", () => {
  it("uses the curator's mod name, keeping the entry's extension", () => {
    expect(
      bundledArchiveFileName(BUNDLED_ENTRY, "High_Poly_Head_v1.4_(SE)-80968"),
    ).toBe("High_Poly_Head_v1.4_(SE)-80968.zip");
  });

  it("falls back to the entry's own name when given none", () => {
    // The pre-existing behaviour, which every caller that has not been
    // taught the name must keep getting.
    expect(bundledArchiveFileName(BUNDLED_ENTRY, undefined)).toBe(
      `${BUNDLED_SHA}.zip`,
    );
  });

  it("takes the extension from the ENTRY, never from the mod name", () => {
    /**
     * The trap this function exists around. Vortex disambiguates duplicate
     * mod names by appending `.1`, `.2` — so the curator's mod is genuinely
     * called "IDE WHITERUN-149724-1-1746902603.1". That trailing `.1` is a
     * counter, not a file type, and treating it as one hands Vortex an
     * archive it cannot open.
     */
    expect(
      bundledArchiveFileName(BUNDLED_ENTRY, "IDE WHITERUN-149724-1-1746902603.1"),
    ).toBe("IDE WHITERUN-149724-1-1746902603.1.zip");
  });

  it("does not double the extension when the name already ends in it", () => {
    expect(bundledArchiveFileName(BUNDLED_ENTRY, "Cool Mod.zip")).toBe(
      "Cool Mod.zip",
    );
  });

  it("keeps a multi-part extension whole", () => {
    // The packager writes `.tar.gz` as one unit; splitting on the last dot
    // would name the file `.gz` and unpack one layer short.
    expect(
      bundledArchiveFileName(`bundled/${BUNDLED_SHA}.tar.gz`, "Some Mod"),
    ).toBe("Some Mod.tar.gz");
  });

  it("replaces characters Windows cannot put in a file name", () => {
    expect(bundledArchiveFileName(BUNDLED_ENTRY, 'a/b\\c:d*e?f"g<h>i|j')).toBe(
      "a_b_c_d_e_f_g_h_i_j.zip",
    );
  });

  it("falls back rather than writing a name that says nothing", () => {
    /**
     * A name made only of separators sanitises to `___`, which is a legal
     * file name and a useless one — it identifies neither the mod nor the
     * bytes. The entry's own sha at least identifies the bytes, so a name
     * with no letter or digit left in it is treated as no name at all.
     */
    expect(bundledArchiveFileName(BUNDLED_ENTRY, "///")).toBe(
      `${BUNDLED_SHA}.zip`,
    );
    expect(bundledArchiveFileName(BUNDLED_ENTRY, "   ")).toBe(
      `${BUNDLED_SHA}.zip`,
    );
    // One real character is enough — this is a floor, not a quality bar.
    expect(bundledArchiveFileName(BUNDLED_ENTRY, "|a|")).toBe("_a_.zip");
  });

  it("truncates a long name without losing the extension", () => {
    const out = bundledArchiveFileName(BUNDLED_ENTRY, "x".repeat(400));
    // Win32 MAX_PATH is spent on the temp dir before we get here.
    expect(out.length).toBeLessThan(140);
    expect(out.endsWith(".zip")).toBe(true);
  });
});

describe("extraction lands under the mod's name", () => {
  it("writes the archive as <mod name>.zip inside bundled/", async () => {
    const { extractedPath, tempDir } = await extractBundledFromEhcoll(
      pkg(),
      BUNDLED_ENTRY,
      "Vampire Armors and Weapons Retexture SE-96855",
    );
    try {
      expect(extractedPath).toBe(
        path.join(
          tempDir,
          "bundled",
          "Vampire Armors and Weapons Retexture SE-96855.zip",
        ),
      );
      // The returned path must be the file that EXISTS, not merely the one we
      // intended — the caller hands this straight to Vortex.
      expect(fs.existsSync(extractedPath)).toBe(true);
    } finally {
      await safeRmTempDir(tempDir);
    }
  });

  it("still preserves the entry's directory, which cleanup depends on", async () => {
    const { extractedPath, tempDir } = await extractBundledFromEhcoll(
      pkg(),
      BUNDLED_ENTRY,
      "Some Mod",
    );
    try {
      expect(path.dirname(extractedPath)).toBe(path.join(tempDir, "bundled"));
    } finally {
      await safeRmTempDir(tempDir);
    }
  });

  it("names the file after the entry it FOUND when recovering by sha", async () => {
    /**
     * The sha-recovery path asks for `bundled/<sha>.1` and finds
     * `bundled/<sha>.zip`. The extension we asked for is by definition the
     * wrong one — that is why we are in the recovery branch — so the file
     * must be named from what was found, or we write a zip called
     * "Some Mod.1" and leave Vortex to guess.
     */
    const { extractedPath, tempDir } = await extractBundledFromEhcoll(
      pkg(),
      `bundled/${BUNDLED_SHA}.1`,
      "IDE WHITERUN",
    );
    try {
      expect(path.basename(extractedPath)).toBe("IDE WHITERUN.zip");
      expect(fs.existsSync(extractedPath)).toBe(true);
    } finally {
      await safeRmTempDir(tempDir);
    }
  });
});
