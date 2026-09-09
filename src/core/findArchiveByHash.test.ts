/**
 * Recovering a mod's archive when Vortex's link to it is stale.
 *
 * ─── THE REAL CASE ──────────────────────────────────────────────────────────
 * BodyTalk was installed at 3.8 and updated IN PLACE to 4.0.1. Vortex
 * refreshed `version` and the Nexus `fileId` and left the staging folder named
 * `BodyTalk-72310-3-8-1687372211`, with `archiveName` pointing at the 3.8 file
 * — which is gone, along with its download record. The mod's `archiveId` names
 * a record that no longer exists, so the build could not open the archive: no
 * FOMOD parsed, no `readsPluginState`, and the install-order fix silently
 * skipped it. Ten mods on one 978-mod collection were in that state, and every
 * one of their archives was in the download folder the whole time.
 *
 * ─── WHY THE HASH DECIDES ───────────────────────────────────────────────────
 * On that same machine 224 Nexus modIds have MORE THAN ONE archive in the
 * folder. BodyTalk has `TBOS-BodyTalk4-72310-4-0-1` and
 * `TBOS-BodyTalk4-72310-4-0` side by side. A name or modId match picks a
 * version at random, and identifying a 4.0.1 staging folder against a 4.0
 * archive is worse than finding nothing: hundreds of files report unexplained,
 * the curator is told their mod is post-processed when it is not, and a wrong
 * hash can ship.
 *
 * "I could not check this" is honest. "I checked it against the wrong thing"
 * is a fabricated finding.
 */
import * as crypto from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { afterEach, describe, expect, it } from "vitest";

import { findArchiveByHash } from "./findArchiveByHash";

let dir: string | undefined;
afterEach(() => {
  if (dir !== undefined) fs.rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

/** A real file with real bytes, so the hash is a hash and not a fixture. */
const write = (name: string, contents: string): string => {
  const full = path.join(dir!, name);
  fs.writeFileSync(full, contents);
  return crypto.createHash("sha256").update(contents).digest("hex");
};

const makeDir = (): void => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "eh-archive-by-hash-"));
};

describe("finding an archive whose download record is stale", () => {
  it("finds the file the manifest's hash actually names", () => {
    makeDir();
    const want = write("TBOS-BodyTalk4-72310-4-0-1-1769451493.7z", "v4.0.1");

    return findArchiveByHash({
      downloadDir: dir!,
      wantSha256: want,
      nexusModId: 72310,
    }).then((hit) => {
      expect(hit).toBe(
        path.join(dir!, "TBOS-BodyTalk4-72310-4-0-1-1769451493.7z"),
      );
    });
  });

  it("picks the RIGHT version when two of the same mod are present", async () => {
    /**
     * THE assertion. Both files carry modId 72310 and both are plausible by
     * name; only the bytes tell them apart. This is the case that makes a
     * name- or id-based match unsafe, and it is not hypothetical — it is the
     * curator's actual download folder.
     */
    makeDir();
    /**
     * The decoy sorts FIRST on purpose. An earlier version of this test used
     * only the two real filenames, and `-4-0-1-` happens to sort before
     * `-4-0-17…` — so an implementation that returned the first modId match
     * without hashing passed it by accident (GP-4). The wrong answer has to
     * be the one a careless implementation reaches first, or the test is not
     * testing anything.
     */
    write("AAA-BodyTalk4-72310-3-8-1687372211.7z", "v3.8 — long gone");
    write("TBOS-BodyTalk4-72310-4-0-1754521707.zip", "v4.0 — the older one");
    const want = write("TBOS-BodyTalk4-72310-4-0-1-1769451493.7z", "v4.0.1");

    const hit = await findArchiveByHash({
      downloadDir: dir!,
      wantSha256: want,
      nexusModId: 72310,
    });

    expect(hit).toBe(
      path.join(dir!, "TBOS-BodyTalk4-72310-4-0-1-1769451493.7z"),
    );
  });

  it("answers 'not here' rather than offering a near miss", async () => {
    // A mod whose archive is genuinely gone must stay unexaminable. Returning
    // the wrong version would be a fabricated finding.
    makeDir();
    write("TBOS-BodyTalk4-72310-4-0-1754521707.zip", "v4.0 — the older one");

    const hit = await findArchiveByHash({
      downloadDir: dir!,
      wantSha256: crypto.createHash("sha256").update("v4.0.1").digest("hex"),
      nexusModId: 72310,
    });

    expect(hit).toBeUndefined();
  });

  it("ignores another mod's archive with the same bytes", async () => {
    /**
     * The modId narrows before the hash decides, and that ordering matters
     * for cost rather than correctness — a folder holds ~1,500 archives and
     * hashing all of them to answer for two is the reason this narrows at
     * all.
     */
    makeDir();
    const want = write("Something Else-99999-1-0-1700000000.7z", "shared");

    const hit = await findArchiveByHash({
      downloadDir: dir!,
      wantSha256: want,
      nexusModId: 72310,
    });

    expect(hit).toBeUndefined();
  });

  it("does not match a modId that is merely a substring", async () => {
    // `-72310-` is delimited on purpose: the bare number also appears inside
    // versions and the timestamps Vortex appends.
    makeDir();
    const want = write("Other-172310-1-0-1700000000.7z", "different mod");

    const hit = await findArchiveByHash({
      downloadDir: dir!,
      wantSha256: want,
      nexusModId: 72310,
    });

    expect(hit).toBeUndefined();
  });

  it("declines when there is no Nexus id to narrow by", async () => {
    /**
     * An external mod has no modId, so there is nothing to narrow with — and
     * scanning the whole folder would spend minutes to answer for one mod.
     * Declining is the honest answer, and the caller reports it as
     * unexaminable.
     */
    makeDir();
    const want = write("some-external-thing.7z", "bytes");

    const hit = await findArchiveByHash({
      downloadDir: dir!,
      wantSha256: want,
      nexusModId: undefined,
    });

    expect(hit).toBeUndefined();
  });

  it("survives a download folder that is not there", async () => {
    // It runs during a build over whatever the machine holds; throwing here
    // would take out the whole self-check pass.
    const hit = await findArchiveByHash({
      downloadDir: path.join(os.tmpdir(), "eh-definitely-not-a-real-dir-xyz"),
      wantSha256: "a".repeat(64),
      nexusModId: 72310,
    });

    expect(hit).toBeUndefined();
  });
});
