/**
 * ──────────────────────────────────────────────────────────────────────
 * Finding a mod's archive when Vortex's LINK to it is stale.
 *
 * A mod points at its download through `archiveId`, a key into
 * `state.persistent.downloads.files`. That link dies in a way nothing repairs
 * and the curator never sees:
 *
 *   BodyTalk was installed at 3.8 and later UPDATED IN PLACE to 4.0.1. Vortex
 *   refreshed `version` and the Nexus `fileId`, and left the staging folder
 *   named `BodyTalk-72310-3-8-1687372211` with `archiveName` pointing at the
 *   3.8 file. That file is gone and its download record went with it, so the
 *   mod's `archiveId` names a record that no longer exists.
 *
 * On a real 978-mod collection ten mods were in that state, and not one could
 * be examined — no FOMOD parsed, no archive verified, no `readsPluginState`,
 * so the install-order fix silently skipped them. All ten archives were in the
 * download folder the whole time.
 *
 * ─── NARROW BY NAME, DECIDE BY HASH ───────────────────────────────────
 * The name is a HINT and never the answer, because on that same machine 224
 * Nexus modIds have MORE THAN ONE archive in the folder — BodyTalk itself has
 * `TBOS-BodyTalk4-72310-4-0-1` and `TBOS-BodyTalk4-72310-4-0` side by side.
 *
 * Matching on a name or a modId would therefore pick a VERSION AT RANDOM, and
 * identifying a 4.0.1 staging folder against a 4.0 archive is worse than
 * finding nothing: hundreds of files report as unexplained, the curator is
 * told their mod is post-processed when it is not, and the wrong hash can
 * ship. "I could not check this" is honest; "I checked it against the wrong
 * thing" is a fabricated finding.
 *
 * So the modId only NARROWS the candidates — typically from 1,500 files to
 * two or three — and the sha256 decides. That is the identity the manifest
 * already relies on (NS-4: identity and integrity are separate passes, and
 * this is squarely the identity one). Verified on the real case: the
 * collection records `0e368a85fd5985…` for BodyTalk, and hashing
 * `TBOS-BodyTalk4-72310-4-0-1-1769451493.7z` produces exactly that.
 *
 * Hashing the whole folder would also work and was rejected on cost: it is
 * ~1,500 archives on every build where any link is stale, to answer a question
 * a filename prefix answers for two or three of them.
 * ──────────────────────────────────────────────────────────────────────
 */

import * as fs from "fs";
import * as path from "path";

import { hashFileSha256 } from "./archiveHashing";
import { ehLog } from "./logging/ehLog";
import { isAbort } from "../utils/abortError";

/** Extensions Vortex will hand to an installer. */
const ARCHIVE = /\.(7z|zip|rar)$/i;

/**
 * The archive in `downloadDir` whose bytes hash to `wantSha256`, or
 * `undefined`.
 *
 * `nexusModId` narrows which files are read. Without one there is nothing to
 * narrow by and the answer is `undefined` rather than a folder-wide scan —
 * an external mod with no Nexus identity is a case this cannot help, and
 * saying so beats spending minutes to say it.
 */
export async function findArchiveByHash(args: {
  downloadDir: string;
  wantSha256: string;
  nexusModId: number | undefined;
  signal?: AbortSignal;
}): Promise<string | undefined> {
  const { downloadDir, wantSha256, nexusModId, signal } = args;
  if (nexusModId === undefined) return undefined;

  let names: string[];
  try {
    names = fs.readdirSync(downloadDir);
  } catch (err) {
    ehLog("warn", "archive-by-hash.unreadable-dir", {
      downloadDir,
      err,
      consequence:
        "a mod whose download record is stale stays unexaminable on this run " +
        "— reported as such rather than guessed at",
    });
    return undefined;
  }

  /**
   * Vortex names a Nexus download `<name>-<modId>-<version>-<timestamp>`, so
   * the id appears delimited. Matching the bare number would also hit a
   * version or a timestamp that happens to contain it.
   */
  const token = `-${nexusModId}-`;
  const candidates = names.filter(
    (n) => ARCHIVE.test(n) && n.includes(token),
  );
  if (candidates.length === 0) return undefined;

  const want = wantSha256.toLowerCase();
  for (const name of candidates) {
    if (signal?.aborted === true) return undefined;
    const full = path.join(downloadDir, name);
    try {
      const sha = await hashFileSha256(full, signal);
      if (sha.toLowerCase() !== want) continue;
      ehLog("info", "archive-by-hash.recovered", {
        modId: nexusModId,
        sha256: want,
        path: full,
        candidates: candidates.length,
        why:
          "Vortex's download record for this mod is stale — usually an " +
          "in-place update — but these bytes are in the download folder",
      });
      return full;
    } catch (err) {
      if (isAbort(err, signal)) return undefined;
      // A locked or half-written download cannot answer for itself; the next
      // candidate still can.
    }
  }

  ehLog("debug", "archive-by-hash.no-match", {
    modId: nexusModId,
    sha256: want,
    candidates: candidates.length,
    why: "no archive with these exact bytes is in the download folder",
  });
  return undefined;
}
