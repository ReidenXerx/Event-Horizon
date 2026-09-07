/**
 * ──────────────────────────────────────────────────────────────────────
 * A file the walk never saw leaves no trace — and that was load-bearing.
 *
 * Mirroring ("ship my files") DELETES files in the user's mod folder that the
 * curator's recorded listing does not mention. It only does so when the
 * listing is "provably whole", and the proof used to be "every recorded entry
 * carries a hash".
 *
 * That proof is false, and the gap is silent. A hashless entry appears only
 * for a file that WAS walked and could not be READ. A directory the walk could
 * not list produces no entries at all — no hash gap, nothing to notice — so
 * every real file beneath it is classified as the user's own junk and deleted
 * from their machine. The mirror then reports success and writes a drift
 * reference certifying the amputated folder.
 *
 * One unlistable `textures/` on the curator's disk — a path over MAX_PATH, a
 * cloud-sync placeholder, an antivirus handle — was enough to do that on every
 * user's machine.
 *
 * So the walk now REPORTS what it skipped, and completeness is recorded rather
 * than inferred from an absence.
 * ──────────────────────────────────────────────────────────────────────
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  walkStagingFolder,
  type UnreadablePath,
} from "./stagingFileWalker";

let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "eh-walk-"));
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

async function walk(): Promise<{
  files: string[];
  skipped: UnreadablePath[];
}> {
  const skipped: UnreadablePath[] = [];
  const files = await walkStagingFolder(root, undefined, (e) => skipped.push(e));
  return { files: files.map((f) => f.relativePath).sort(), skipped };
}

describe("walkStagingFolder completeness reporting", () => {
  it("reports nothing when it read everything", () => {
    // The normal case, and the only one in which deletion is safe. If this
    // ever reported a false skip, mirroring would stop deleting anything and
    // the failure would be invisible in the other direction.
    fs.mkdirSync(path.join(root, "Textures"), { recursive: true });
    fs.writeFileSync(path.join(root, "Textures", "rock.dds"), "bytes");
    fs.writeFileSync(path.join(root, "plugin.esp"), "plugin");

    return walk().then(({ files, skipped }) => {
      expect(files).toEqual(["Textures/rock.dds", "plugin.esp"]);
      expect(skipped).toEqual([]);
    });
  });

  it("REPORTS a directory it could not list, instead of silently shortening", async () => {
    /**
     * The finding itself. `readdir` is made to fail for ONE subdirectory —
     * which is what a path over MAX_PATH, a cloud-sync placeholder or an
     * antivirus handle does in the wild, none of which can be produced
     * reliably in a test on every machine.
     *
     * The assertion that matters is the pair: the files under it are absent
     * from the listing AND the skip is reported. Before this, only the first
     * half happened, and mirroring read the short list as "the curator does
     * not have these" and deleted the user's copies.
     */
    fs.mkdirSync(path.join(root, "Textures"), { recursive: true });
    fs.writeFileSync(path.join(root, "Textures", "rock.dds"), "bytes");
    fs.writeFileSync(path.join(root, "plugin.esp"), "plugin");

    const real = fs.promises.readdir;
    const spy = vi
      .spyOn(fs.promises, "readdir")
      .mockImplementation(async (dir: never, opts: never) => {
        if (String(dir).endsWith("Textures")) {
          throw Object.assign(new Error("EPERM: operation not permitted"), {
            code: "EPERM",
          });
        }
        return (real as never as typeof fs.promises.readdir)(dir, opts);
      });

    try {
      const { files, skipped } = await walk();
      expect(files).toEqual(["plugin.esp"]);
      expect(skipped).toHaveLength(1);
      expect(skipped[0]!.kind).toBe("dir");
      expect(skipped[0]!.path).toContain("Textures");
      expect(skipped[0]!.why).toContain("EPERM");
    } finally {
      spy.mockRestore();
    }
  });

  it("REPORTS a file it could not stat", async () => {
    // The second silent `continue`: readdir named the entry, stat failed.
    fs.writeFileSync(path.join(root, "kept.esp"), "kept");
    fs.writeFileSync(path.join(root, "vanished.esp"), "gone");

    const real = fs.promises.stat;
    const spy = vi
      .spyOn(fs.promises, "stat")
      .mockImplementation(async (target: never, opts: never) => {
        if (String(target).endsWith("vanished.esp")) {
          throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
        }
        return (real as never as typeof fs.promises.stat)(target, opts);
      });

    try {
      const { files, skipped } = await walk();
      expect(files).toEqual(["kept.esp"]);
      expect(skipped.map((e) => e.kind)).toEqual(["file"]);
      expect(skipped[0]!.path).toContain("vanished.esp");
    } finally {
      spy.mockRestore();
    }
  });

  it("does not report a symlink pointing outside the folder", async () => {
    /**
     * Deliberate exclusion, not a gap: a link out of the staging folder is
     * not part of this mod, and following it would capture someone else's
     * files. Reporting it would block mirroring for a mod that is complete.
     */
    fs.writeFileSync(path.join(root, "real.esp"), "real");
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "eh-outside-"));
    fs.writeFileSync(path.join(outside, "other.esp"), "other");
    try {
      fs.symlinkSync(path.join(outside, "other.esp"), path.join(root, "link.esp"));
    } catch {
      return; // Windows without developer mode: symlinks need elevation.
    }

    const { skipped } = await walk();
    expect(skipped).toEqual([]);
    fs.rmSync(outside, { recursive: true, force: true });
  });
});
