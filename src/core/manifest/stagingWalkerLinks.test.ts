/**
 * ──────────────────────────────────────────────────────────────────────
 * A mod file held as a link must be captured whatever form the root path
 * arrives in — and a link into a SIBLING folder must not be.
 *
 * The walker decided "is this link inside the mod?" with
 * `realPath.startsWith(root)`. Three silent failures lived in that line:
 *
 *  1. `realpath` returns the LONG form; `root` can be the 8.3 SHORT form
 *     (`C:\Users\DUDUPH~1\…`), which GitHub's runners use and so do many
 *     real accounts. Every in-mod link then looked outside and vanished.
 *     EH's first public CI run went red on exactly this.
 *  2. No separator boundary: `…\ModsExtra\x` counted as inside `…\Mods`.
 *  3. A case-sensitive compare on a case-insensitive filesystem.
 *
 * A dropped file is worse than missing: the mirror classes the player's copy
 * as an extra and deletes it, then certifies the mod as verified.
 *
 * The short-form case is tested by passing a short root DIRECTLY, so it no
 * longer passes or fails depending on what the machine's TEMP happens to be.
 * The other two are deterministic on any Windows machine.
 * ──────────────────────────────────────────────────────────────────────
 */
import { execFileSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { walkStagingFolder, type UnreadablePath } from "./stagingFileWalker";

let base: string;
beforeEach(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), "eh-links-"));
});
afterEach(() => {
  fs.rmSync(base, { recursive: true, force: true });
});

const put = (dir: string, name: string, body: string): string => {
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, name);
  fs.writeFileSync(p, body);
  return p;
};

/** A file symlink, or skip the test: Windows needs Developer Mode or elevation. */
const linkOrSkip = (target: string, at: string, skip: () => void): boolean => {
  try {
    fs.symlinkSync(target, at, "file");
    return true;
  } catch {
    skip();
    return false;
  }
};

/**
 * The 8.3 short form of an existing folder, or `undefined` if the volume has
 * none.
 *
 * Through the COM object, which calls GetShortPathName. The obvious
 * `cmd /c for %I in ("…") do @echo %~sI` does NOT work from here: the
 * process API escapes the quotes, cmd receives a garbled path, and echoes it
 * back — different from the long form, so it passes a "did it change" check
 * while being no short form at all. It was the first version of this helper,
 * and the "~" assertion below is what caught it.
 */
const shortForm = (p: string): string | undefined => {
  if (process.platform !== "win32") return undefined;
  try {
    const out = execFileSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `(New-Object -ComObject Scripting.FileSystemObject).GetFolder('${p.replace(/'/g, "''")}').ShortPath`,
      ],
      { encoding: "utf8", windowsHide: true },
    ).trim();
    return out.includes("~") ? out : undefined;
  } catch {
    return undefined;
  }
};

const walk = async (
  root: string,
): Promise<{ files: string[]; skipped: UnreadablePath[] }> => {
  const skipped: UnreadablePath[] = [];
  const files = await walkStagingFolder(root, undefined, (e) => skipped.push(e));
  return { files: files.map((f) => f.relativePath).sort(), skipped };
};

describe("a link to another file of the same mod", () => {
  it("is captured when the root arrives in 8.3 short form", async (ctx) => {
    // The mod folder gets a name long enough that Windows gives it a short
    // alias, so the test does not depend on the user's own folder name.
    const mod = path.join(base, "A Rather Long Mod Folder Name");
    const real = put(mod, "a.ini", "[a]");
    if (!linkOrSkip(real, path.join(mod, "linked.ini"), () => ctx.skip())) return;

    const short = shortForm(mod);
    if (short === undefined) {
      // 8.3 name generation can be switched off on a volume. On such a disk
      // the bug cannot happen, so there is nothing to test — say so rather
      // than pass a test that measured nothing.
      ctx.skip();
      return;
    }
    expect(short).toContain("~");

    const { files, skipped } = await walk(short);
    expect(files).toEqual(["a.ini", "linked.ini"]);
    expect(skipped).toEqual([]);
  });

  it("is captured when the root arrives in different case", async (ctx) => {
    if (process.platform !== "win32") ctx.skip();
    const mod = path.join(base, "SomeMod");
    const real = put(mod, "a.ini", "[a]");
    if (!linkOrSkip(real, path.join(mod, "linked.ini"), () => ctx.skip())) return;

    const { files, skipped } = await walk(path.join(base, "SOMEMOD"));
    expect(files).toEqual(["a.ini", "linked.ini"]);
    expect(skipped).toEqual([]);
  });

  it("is captured from the long form too, which is what always worked", async (ctx) => {
    // The control. Without it the two above could pass for a reason that has
    // nothing to do with the path form.
    const mod = path.join(base, "SomeMod");
    const real = put(mod, "a.ini", "[a]");
    if (!linkOrSkip(real, path.join(mod, "linked.ini"), () => ctx.skip())) return;

    const { files } = await walk(mod);
    expect(files).toEqual(["a.ini", "linked.ini"]);
  });
});

describe("a link out of the mod", () => {
  it("into a SIBLING whose name starts the same is excluded, not captured", async (ctx) => {
    // `…\Mods` is a prefix of `…\ModsExtra`, so a bare startsWith called
    // this link inside the mod and captured another folder's file into it.
    const mod = path.join(base, "Mods");
    const sibling = path.join(base, "ModsExtra");
    put(mod, "own.ini", "[own]");
    const foreign = put(sibling, "foreign.ini", "[theirs]");
    if (!linkOrSkip(foreign, path.join(mod, "borrowed.ini"), () => ctx.skip())) return;

    const { files, skipped } = await walk(mod);
    expect(files).toEqual(["own.ini"]);
    // Excluded and NOT reported — see the next test for why.
    expect(skipped).toEqual([]);
  });

  it("is excluded without being reported, because the mod is complete without it", async (ctx) => {
    /**
     * The fix for this bug first reported outside links through
     * `onUnreadable`, as the handoff suggested. That broke a deliberate,
     * pinned decision (`captureCompleteness.test.ts`): `onUnreadable` is for
     * paths that belong to the mod and could not be read. A link out of the
     * folder does not belong to it, so reporting it would make the mirror
     * refuse to certify a mod that is whole. The bug was only ever the
     * CLASSIFICATION of in-mod and sibling links, never this silence.
     */
    const mod = path.join(base, "Mod");
    put(mod, "own.ini", "[own]");
    const outside = put(path.join(base, "elsewhere"), "x.ini", "[x]");
    if (!linkOrSkip(outside, path.join(mod, "out.ini"), () => ctx.skip())) return;

    const { files, skipped } = await walk(mod);
    expect(files).toEqual(["own.ini"]);
    expect(skipped).toEqual([]);
  });
});
