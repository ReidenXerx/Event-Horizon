/**
 * Every Nexus mod carries a MANDATORY `source.sha256` whose docblock promises
 * the installer "downloads via Nexus IDs, then verifies against this hash.
 * Mismatch ⇒ HARD FAIL". Nothing did. The field was read in exactly one place
 * — locating a bundled archive inside the package — and a downloaded archive
 * was never compared against it.
 *
 * The thing it guards against is real: a mod author re-uploads under the same
 * file id, Nexus serves the new bytes to a request naming the old one, and the
 * collection installs something the curator never tested. Every downstream
 * symptom then points somewhere other than the cause.
 */
import * as crypto from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  checkArchiveIdentity,
  describeArchiveIdentity,
} from "./checkArchiveIdentity";
import { archiveFileCacheKey, emptyArchiveHashCache } from "../archiveHashCache";
import { buildStoredZip, writeStoredZip } from "../manifest/storedZip.testutil";
import type { SevenZipApi } from "../manifest/sevenZip";

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "eh-archid-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const write = (name: string, contents: string): string => {
  const p = path.join(dir, name);
  fs.writeFileSync(p, contents);
  return p;
};
const sha = (s: string): string =>
  crypto.createHash("sha256").update(s).digest("hex");

describe("the check the docblock promised", () => {
  it("confirms an archive that IS what the curator built from", async () => {
    const body = "the exact bytes nexus served the curator";
    const p = write("mod.7z", body);
    const check = await checkArchiveIdentity({
      archivePath: p,
      expectedSha256: sha(body),
    });
    expect(check.kind).toBe("matches");
  });

  it("catches a re-upload — same file id, different bytes", async () => {
    // The failure this exists for. Without it the collection installs a mod
    // the curator never tested and nothing says so.
    //
    // A REAL archive, because a re-upload is an intact file with different
    // contents. The fixture used to be a text file, which is now correctly
    // read as `damaged` — a truncated download rather than a re-upload — so
    // the convenient fixture was testing the wrong verdict.
    const p = path.join(dir, "mod.zip");
    writeStoredZip(p, [{ name: "Data/thing.esp", body: "what nexus serves TODAY" }]);
    const actual = crypto
      .createHash("sha256")
      .update(fs.readFileSync(p))
      .digest("hex");

    const check = await checkArchiveIdentity({
      archivePath: p,
      expectedSha256: sha("what nexus served the curator"),
    });
    expect(check.kind).toBe("differs");
    if (check.kind === "differs") {
      expect(check.actual).toBe(actual);
    }
  });

  it("is case-insensitive about the recorded hash", async () => {
    // Hex is hex. A manifest hand-edited to uppercase must not read as a
    // re-upload — that would send a curator hunting a mod author for nothing.
    const body = "bytes";
    const p = write("mod.7z", body);
    const check = await checkArchiveIdentity({
      archivePath: p,
      expectedSha256: sha(body).toUpperCase(),
    });
    expect(check.kind).toBe("matches");
  });
});

describe("saying 'I cannot tell' instead of guessing", () => {
  it("no recorded hash", async () => {
    const p = write("mod.7z", "x");
    const check = await checkArchiveIdentity({
      archivePath: p,
      expectedSha256: undefined,
    });
    expect(check.kind).toBe("unknown");
    expect(check.kind === "unknown" && check.why).toMatch(/did not record/);
  });

  it("archive no longer on disk", async () => {
    const check = await checkArchiveIdentity({
      archivePath: undefined,
      expectedSha256: sha("x"),
    });
    expect(check.kind).toBe("unknown");
    expect(check.kind === "unknown" && check.why).toMatch(/no longer on disk/);
  });

  it("archive path exists but is a directory", async () => {
    const check = await checkArchiveIdentity({
      archivePath: dir,
      expectedSha256: sha("x"),
    });
    expect(check.kind).toBe("unknown");
  });

  it("never throws, whatever it is handed", async () => {
    // It runs while explaining another failure. An explanation that throws
    // leaves the user with strictly less than they had.
    await expect(
      checkArchiveIdentity({
        archivePath: path.join(dir, "nope", "gone.7z"),
        expectedSha256: sha("x"),
      }),
    ).resolves.toBeDefined();
  });
});

describe("reusing the hash the download scan already computed", () => {
  it("answers from the cache without re-reading the file", async () => {
    // On a resumed install this archive was very likely hashed minutes ago by
    // collectAvailableDownloads. Re-reading 2 GB to learn the same number is
    // the kind of heavy work that buys nothing.
    const p = write("mod.7z", "real contents");
    const stat = fs.statSync(p);
    const cache = emptyArchiveHashCache();
    // A deliberately WRONG hash in the cache: if the result follows it, the
    // cache was consulted; if it follows the file, it was not.
    cache.entries[archiveFileCacheKey(p, stat.size, stat.mtimeMs)] = {
      sha256: sha("something else entirely"),
      recoveredAt: new Date().toISOString(),
    };
    const check = await checkArchiveIdentity({
      archivePath: p,
      expectedSha256: sha("something else entirely"),
      cache,
    });
    expect(check.kind).toBe("matches");
  });

  it("falls back to hashing when the cache does not know this file", async () => {
    const body = "fresh";
    const p = write("mod.7z", body);
    const check = await checkArchiveIdentity({
      archivePath: p,
      expectedSha256: sha(body),
      cache: emptyArchiveHashCache(),
    });
    expect(check.kind).toBe("matches");
  });
});

describe("the driver actually asks, and tells the curator the answer", () => {
  // The failure being guarded: a check that exists and is never called. That
  // is precisely what happened to `source.sha256` itself — mandatory in the
  // schema, documented as a hard fail, read in exactly one unrelated place.
  const driver = async (): Promise<string> => {
    const fs = await import("fs");
    const path = await import("path");
    return fs.readFileSync(path.join(__dirname, "runInstall.ts"), "utf8");
  };

  it("consults the archive's identity when a mod cannot be reproduced", async () => {
    const src = await driver();
    expect(src).toMatch(/await checkArchiveIdentity\(/);
    expect(src).toMatch(/expectedSha256: manifestEntry\?\.source\.sha256/);
  });

  it("asks only AFTER the reinstall, not instead of it", async () => {
    // Hashing every archive up front would cost a full read per mod for a
    // question almost none of them raise.
    const src = await driver();
    const recover = src.indexOf("await tryRecoverFailedMod(");
    const check = src.indexOf("await checkArchiveIdentity(");
    expect(check).toBeGreaterThan(recover);
  });

  it("puts the verdict in the report the user sends", async () => {
    // Knowing the archive was re-uploaded is worthless in a log the curator
    // never sees. It has to be in the pasted text.
    const src = await driver();
    expect(src).toMatch(/describeArchiveIdentity\(archiveIdentity\)/);
  });

  it("logs a mismatch with both hashes", async () => {
    const src = await driver();
    expect(src).toMatch(/"install\.archive-identity"/);
    expect(src).toMatch(/expected: archiveIdentity\.expected/);
  });

  it("also checks the file the USER picked by hand", async () => {
    // The one path where bytes arrive by hand: browsed to a website,
    // downloaded something, pointed us at it. It was installed unexamined —
    // wrong version, wrong mod, half-finished download, all indistinguishable
    // from the right file and all recorded afterwards as the collection's mod.
    const src = await driver();
    const fn = src.slice(src.indexOf("function executePromptUserChoice"));
    const body = fn.slice(0, fn.indexOf("\n}\n"));
    expect(body).toMatch(/checkArchiveIdentity\(/);
    expect(body).toMatch(/archivePath: choice\.localPath/);
  });

  it("installs the picked file anyway — a note, not a refusal", async () => {
    // A browse-mode dependency legitimately resolves to a different-but-
    // equivalent build: a mirror, a repack, a page the author replaced. The
    // user made a deliberate choice we have no standing to overrule. What
    // they should not do is make it unknowingly.
    const src = await driver();
    const fn = src.slice(src.indexOf("function executePromptUserChoice"));
    const body = fn.slice(0, fn.indexOf("\n}\n"));
    const mismatch = body.indexOf('picked.kind === "differs"');
    const install = body.indexOf("await installFromLocalArchive(");
    expect(mismatch).toBeGreaterThan(-1);
    expect(install).toBeGreaterThan(-1);
    // The check happens FIRST, and the install still happens after it.
    expect(mismatch).toBeLessThan(install);
    expect(body).not.toMatch(/throw new Error\([^)]*picked/);
  });

  it("does not repeat the notice on a retry", async () => {
    // Telling a user twice about one thing invites the reasonable conclusion
    // that it happened twice.
    const src = await driver();
    expect(src).toMatch(/onNotice: \(\) => undefined/);
  });
});

describe("what the curator is told", () => {
  it("names a re-upload as the likely cause", async () => {
    // The explanation a curator can actually check, and the one they would
    // otherwise never think of.
    const text = describeArchiveIdentity({
      kind: "differs",
      expected: "a".repeat(64),
      actual: "b".repeat(64),
    });
    expect(text).toMatch(/re-uploaded under the same file id/i);
  });

  it("says a matching archive makes re-downloading pointless", async () => {
    // Stops the next suggestion before it is made: the same request fetches
    // the same bytes.
    const text = describeArchiveIdentity({ kind: "matches", sha256: "a".repeat(64) });
    expect(text).toMatch(/downloading it again would change nothing/i);
    expect(text).toMatch(/happened after the download/i);
  });

  it("shows enough hash to compare by eye, not the whole thing", async () => {
    const text = describeArchiveIdentity({
      kind: "differs",
      expected: "a".repeat(64),
      actual: "b".repeat(64),
    });
    expect(text).toContain("aaaaaaaaaaaaaaaa...");
    expect(text).not.toContain("a".repeat(64));
  });
});

/**
 * MICROSCOPE PASS 1 — a hash mismatch has TWO causes and the first version
 * named only one of them.
 *
 * "Bytes differ" is produced both by a re-upload under the same file id and by
 * a truncated download. The original wording told the user (and the curator)
 * that a re-upload was "the most likely cause" in both cases — a diagnostic
 * naming one cause out of two it could not distinguish, which is the failure
 * this project treats as worse than saying nothing, because it reads as
 * evidence. It also sent a curator report for a file the curator never touched.
 *
 * Only one of the two is fixed by downloading again, so the two must be told
 * apart before anyone is told what to do. Parsing the header does it.
 */
describe("a different archive is not the same thing as a broken one", () => {
  const brokenSevenZip = (): SevenZipApi =>
    ({
      list: () => {
        throw new Error("7z: cannot execute binary in this prefix");
      },
      add: async () => ({ code: 0 }),
      extractFull: async () => ({ code: 0 }),
    }) as unknown as SevenZipApi;

  it("says DIFFERS for an intact archive whose bytes are not the curator's", async () => {
    // A real, readable ZIP — just not the one the collection was built from.
    // This is the re-upload shape, and re-downloading genuinely cannot help.
    const p = path.join(dir, "mod.zip");
    writeStoredZip(p, [{ name: "Data/thing.esp", body: "a newer build" }]);

    const check = await checkArchiveIdentity({
      archivePath: p,
      expectedSha256: sha("what the curator had"),
      sevenZip: brokenSevenZip(),
    });

    expect(check.kind).toBe("differs");
  });

  it("says DAMAGED when no reader can open it", async () => {
    // A truncated download: the bytes differ AND the file is not parseable.
    // collectAvailableDownloads already skips incomplete downloads by size,
    // which is why we know partial files really occur here.
    const full = buildStoredZip([
      { name: "Data/thing.esp", body: "the real contents of this mod" },
    ]);
    const p = path.join(dir, "half.zip");
    fs.writeFileSync(p, full.subarray(0, Math.floor(full.length / 2)));

    const check = await checkArchiveIdentity({
      archivePath: p,
      expectedSha256: sha("what the curator had"),
      sevenZip: brokenSevenZip(),
    });

    expect(check.kind).toBe("damaged");
  });

  it("does not probe at all when the bytes match", async () => {
    // The probe exists to explain a mismatch. A matching archive is already
    // answered, and a broken 7z must not turn a clean result into a scary one.
    const body = "exactly what the curator had";
    const p = write("good.zip", body);

    const check = await checkArchiveIdentity({
      archivePath: p,
      expectedSha256: sha(body),
      sevenZip: brokenSevenZip(),
    });

    expect(check.kind).toBe("matches");
  });

  it("tells the user to re-download, and does NOT blame a re-upload", async () => {
    // The whole point of splitting the case. This text is what the user acts
    // on, so it must point at their download rather than the curator's mod.
    const text = describeArchiveIdentity({
      kind: "damaged",
      expected: "a".repeat(64),
      actual: "b".repeat(64),
      why: "no end of central directory record",
    });
    expect(text).toMatch(/damaged/i);
    expect(text).toMatch(/incomplete|corrupted/i);
    expect(text).not.toMatch(/re-uploaded/i);
  });
});

describe("the driver acts on the difference, and the user sees it", () => {
  // Both halves must exist or the split is inert, and each is invisible
  // without the other: a verdict nothing branches on, or a notice nothing
  // renders. Both typecheck. Five features in this codebase shipped exactly
  // that way before anyone noticed.
  const read = (rel: string): string =>
    fs.readFileSync(path.join(__dirname, rel), "utf8");

  it("routes a damaged archive AWAY from the curator report", async () => {
    // The finding itself: a truncated download is not the curator's problem,
    // and sending it to them asks them to hunt a mod they never changed.
    const src = read("runInstall.ts");
    const damaged = src.indexOf('archiveIdentity.kind === "damaged"');
    expect(damaged).toBeGreaterThan(-1);
    /**
     * Scoped to the branch, not to the whole file.
     *
     * This used to compare `indexOf("curatorReports.push(")` across all of
     * runInstall.ts, so it asserted "the damaged check appears before the
     * FIRST curator report anywhere in five thousand lines". Adding an
     * unrelated curator report earlier in the file broke it while the
     * property it protects was untouched — the third source-text guard in
     * this suite to fail on a spelling it was never testing.
     *
     * The real property is local: from the damaged check, the NEXT thing that
     * happens is a short-circuit, and no curator report is reached before it.
     */
    const nextReport = src.indexOf("curatorReports.push(", damaged);
    expect(nextReport).toBeGreaterThan(-1);
    // The original assertion, anchored to the report that FOLLOWS the damaged
    // check rather than to the first one in the file.
    expect(src.slice(damaged, nextReport)).toContain("continue;");
  });

  it("surfaces it as its own notice rather than logging it into the void", () => {
    expect(read("runInstall.ts")).toMatch(
      /damagedArchiveNotice: damagedArchives/,
    );
    const steps = fs.readFileSync(
      path.join(__dirname, "..", "..", "ui", "pages", "install", "steps.tsx"),
      "utf8",
    );
    expect(steps).toMatch(
      /<DamagedArchiveNotice lines=\{result\.damagedArchiveNotice/,
    );
  });

  it("reuses the download scan's hashes instead of re-reading gigabytes", () => {
    // `cache` is documented on this function precisely so "a mod already
    // hashed by the download scan is not read twice", and no caller passed
    // one. That was invisible while archivePathForMod was broken and this
    // check never ran — and became a full SHA-256 of every failed mod's
    // archive, on the machine least able to afford it, the moment it started
    // working. The numbers were already on disk from the scan.
    const src = read("runInstall.ts");
    expect(src).toMatch(/loadArchiveHashCache\(ctx\.appDataPath\)/);
    expect(src).toMatch(/cache: cachedHashes/);
  });

  it("keeps the hand-picked-archive branch exhaustive", () => {
    // This is a scar. Adding `damaged` silently un-warned the user who picks a
    // CORRUPT file by hand: that path tested only for "differs", so the new
    // variant fell through to no notice at all, and tsc was happy. The `never`
    // arm makes the next added variant a build error instead of a silence.
    const src = read("runInstall.ts");
    const branch = src.slice(src.indexOf("const pickedIsNotable"));
    expect(branch.slice(0, 2000)).toContain("const exhaustive: never = picked");
  });
});
