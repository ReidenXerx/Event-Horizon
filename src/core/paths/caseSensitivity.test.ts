/**
 * The probe, against real directories.
 *
 * `process.platform` is not the answer and gets it wrong in both directions
 * that matter: a Wine prefix on ext4 reports `win32` while the directory
 * underneath is case-sensitive, and macOS reports `darwin` while APFS is
 * usually case-INsensitive. Only the directory can say.
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  __resetCaseSensitivityCache,
  detectCaseSensitivity,
} from "./caseSensitivity";

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "eh-case-probe-"));
  __resetCaseSensitivityCache();
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("probing a real directory", () => {
  it("agrees with what the filesystem actually does", async () => {
    /**
     * Asserted against the SAME question asked directly, rather than against a
     * hard-coded expectation — the suite has to pass on a developer's NTFS, on
     * CI's ext4, and on a mac's APFS, and each gives a different right answer.
     * Hard-coding one would test the machine, not the code.
     */
    const probe = path.join(dir, "MixedCase.tmp");
    fs.writeFileSync(probe, "");
    const filesystemFolds = fs.existsSync(path.join(dir, "mixedcase.tmp"));
    fs.rmSync(probe, { force: true });

    const mode = await detectCaseSensitivity(dir);
    expect(mode).toBe(filesystemFolds ? "insensitive" : "sensitive");
  });

  it("leaves nothing behind", async () => {
    // It runs on the user's staging root. A probe file left in a mod folder
    // would be captured by the next build as one of the curator's files.
    await detectCaseSensitivity(dir);
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it("caches, so a 1755-mod install probes once", async () => {
    const first = await detectCaseSensitivity(dir);
    fs.rmSync(dir, { recursive: true, force: true });
    // The directory is gone; a second probe would have to fall back. The
    // cached answer is returned instead.
    expect(await detectCaseSensitivity(dir)).toBe(first);
  });
});

describe("when the directory cannot be asked", () => {
  it("falls back to SENSITIVE off Windows — the direction that cannot merge two files", async () => {
    /**
     * The asymmetry is deliberate. Guessing "insensitive" on a sensitive
     * filesystem merges two real files, which is how a verification passes on
     * the wrong bytes and how a mirror deletes the wrong one. Guessing
     * "sensitive" on an insensitive one only brings back cosmetic false
     * positives: noisy, harmless, and visible.
     */
    const gone = path.join(dir, "does", "not", "exist", "\0invalid");
    expect(await detectCaseSensitivity(gone, "linux")).toBe("sensitive");
  });

  it("falls back to insensitive on win32, where that is right essentially always", async () => {
    const gone = path.join(dir, "does", "not", "exist", "\0invalid");
    __resetCaseSensitivityCache();
    expect(await detectCaseSensitivity(gone, "win32")).toBe("insensitive");
  });
});

/**
 * `assumedCaseSensitivity` was deleted, and this is where its test used to be.
 *
 * Its last production caller was `adoptLocalArchive`, which now probes the
 * real download folder — being wrong in the false-POSITIVE direction there
 * stalls an install rather than costing a redundant copy, which is what the
 * old comment had accounted for. A helper with no callers is how this
 * codebase has repeatedly ended up with a documented guarantee that nothing
 * enforces.
 *
 * The platform fallback still exists as the private `fallbackFor`, and the
 * probe-failure cases above are what exercise it: they drive the probe at a
 * directory that is not there and assert the platform answer comes back.
 */
