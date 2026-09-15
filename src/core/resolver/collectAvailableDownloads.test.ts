/**
 * The resolver's `nexus-use-local-download` arm was unreachable: every call
 * site passed `availableDownloads: undefined`, so the "bytes are already here"
 * path never fired once.
 *
 * The cost was a STUCK install, not a slow one. A tester's run died after
 * Point Lookout downloaded but before it installed; on resume the resolver
 * could not see the archive, chose `nexus-download`, and Vortex — already
 * holding the file — did nothing and emitted no completion. It sat on
 * "downloading" a file that had finished downloading in the previous session.
 *
 * These pin the properties that decide whether that can happen again.
 */
import * as crypto from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  collectAvailableDownloads,
  describeDownloadScan,
} from "./collectAvailableDownloads";
import { emptyArchiveHashCache } from "../archiveHashCache";

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "eh-dl-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const write = (name: string, bytes: Buffer | string): string => {
  const p = path.join(dir, name);
  fs.writeFileSync(p, bytes);
  return p;
};
const sha = (b: Buffer | string): string =>
  crypto.createHash("sha256").update(b).digest("hex");

const state = (files: Record<string, unknown>): unknown => ({
  persistent: { downloads: { files } },
});

describe("finding the bytes that are already here", () => {
  it("hashes a finished download so the resolver can match it", async () => {
    // The whole point. Without this the resolver re-downloads a file it is
    // already holding, and on the tester's machine that hung.
    const bytes = Buffer.from("point lookout archive bytes");
    write("PointLookout.7z", bytes);
    const r = await collectAvailableDownloads({
      state: state({
        dl1: { game: "fallout4", localPath: "PointLookout.7z", size: bytes.length },
      }),
      gameId: "fallout4",
      downloadsDir: dir,
      cache: emptyArchiveHashCache(),
    });
    expect(r.downloads).toHaveLength(1);
    expect(r.downloads[0].sha256).toBe(sha(bytes));
    expect(r.downloads[0].archiveId).toBe("dl1");
    expect(r.hashed).toBe(1);
  });

  it("answers from the cache the second time, so a resume is cheap", async () => {
    // Hashing hundreds of archives is acceptable once. Doing it on every
    // resume is not, and the fingerprint cache is what makes the difference.
    const bytes = Buffer.from("some archive");
    write("A.7z", bytes);
    const s = state({ a: { game: "fallout4", localPath: "A.7z", size: bytes.length } });
    const first = await collectAvailableDownloads({
      state: s,
      gameId: "fallout4",
      downloadsDir: dir,
      cache: emptyArchiveHashCache(),
    });
    const second = await collectAvailableDownloads({
      state: s,
      gameId: "fallout4",
      downloadsDir: dir,
      cache: first.cache,
    });
    expect(first.hashed).toBe(1);
    expect(second.hashed).toBe(0);
    expect(second.fromCache).toBe(1);
    expect(second.downloads[0].sha256).toBe(first.downloads[0].sha256);
  });

  it("re-hashes when the bytes change, rather than trusting a stale entry", async () => {
    // The cache keys on path|size|mtime. A replaced archive must not be
    // matched against the hash of what used to be there — that installs the
    // wrong mod and looks like success.
    const p = write("B.7z", "original");
    const s = state({ b: { game: "fallout4", localPath: "B.7z" } });
    const first = await collectAvailableDownloads({
      state: s, gameId: "fallout4", downloadsDir: dir, cache: emptyArchiveHashCache(),
    });
    fs.writeFileSync(p, "replaced with different content");
    const second = await collectAvailableDownloads({
      state: s, gameId: "fallout4", downloadsDir: dir, cache: first.cache,
    });
    expect(second.hashed).toBe(1);
    expect(second.downloads[0].sha256).not.toBe(first.downloads[0].sha256);
    expect(second.downloads[0].sha256).toBe(sha("replaced with different content"));
  });
});

describe("what it refuses to offer", () => {
  it("skips a half-downloaded archive instead of hashing it", async () => {
    // On a resumed install a partially-fetched 2 GB file is exactly what is
    // sitting there. Its hash matches nothing, so reading it is pure waste —
    // and judging by BYTES ON DISK against the recorded size is evidence,
    // where a state string is a label about the bytes.
    write("Partial.7z", "only the first chunk");
    const r = await collectAvailableDownloads({
      state: state({
        p: { game: "fallout4", localPath: "Partial.7z", size: 999_999 },
      }),
      gameId: "fallout4",
      downloadsDir: dir,
      cache: emptyArchiveHashCache(),
    });
    expect(r.downloads).toEqual([]);
    expect(r.skipped.incomplete).toBe(1);
    expect(r.hashed).toBe(0);
  });

  it("skips downloads for a different game", async () => {
    write("Skyrim.7z", "x");
    const r = await collectAvailableDownloads({
      state: state({ s: { game: "skyrimse", localPath: "Skyrim.7z" } }),
      gameId: "fallout4",
      downloadsDir: dir,
      cache: emptyArchiveHashCache(),
    });
    expect(r.downloads).toEqual([]);
    expect(r.skipped.otherGame).toBe(1);
  });

  it("keeps a download valid for SEVERAL games", async () => {
    // Vortex writes `game` as a string OR an array. Handling only the string
    // form drops every multi-game download, which reads as the feature simply
    // not working.
    const bytes = Buffer.from("shared");
    write("Shared.7z", bytes);
    const r = await collectAvailableDownloads({
      state: state({
        m: { game: ["skyrimse", "fallout4"], localPath: "Shared.7z", size: bytes.length },
      }),
      gameId: "fallout4",
      downloadsDir: dir,
      cache: emptyArchiveHashCache(),
    });
    expect(r.downloads).toHaveLength(1);
  });

  it("skips an entry whose file is gone, without failing the scan", async () => {
    const bytes = Buffer.from("here");
    write("Here.7z", bytes);
    const r = await collectAvailableDownloads({
      state: state({
        gone: { game: "fallout4", localPath: "Gone.7z" },
        here: { game: "fallout4", localPath: "Here.7z", size: bytes.length },
      }),
      gameId: "fallout4",
      downloadsDir: dir,
      cache: emptyArchiveHashCache(),
    });
    // The surviving one must still be offered — one dead entry cannot cost
    // the others, or a single stale row re-downloads a whole collection.
    expect(r.downloads.map((d) => d.archiveId)).toEqual(["here"]);
    expect(r.skipped.missing).toBe(1);
  });

  it("survives a state shape it does not recognise", async () => {
    for (const s of [undefined, null, {}, { persistent: {} }, { persistent: { downloads: {} } }, "nope"]) {
      const r = await collectAvailableDownloads({
        state: s,
        gameId: "fallout4",
        downloadsDir: dir,
        cache: emptyArchiveHashCache(),
      });
      expect(r.downloads).toEqual([]);
    }
  });
});

describe("the install pipelines actually pass it to the resolver", () => {
  // This is the test whose absence let the bug live for the life of the
  // project. `availableDownloads: undefined` typechecks perfectly, the arm it
  // disables is never reached, and nothing anywhere objects — the resolver
  // simply behaves as though the user's download folder were empty.
  //
  // Source assertions because the pipelines need a live Vortex. That is the
  // same reason the gap was invisible.
  // EVERY file that builds a UserSideState. The first version of this suite
  // read only engine.ts while its assertions said "neither pipeline" and "both
  // pipelines" — and the Vortex action registered in index.ts went on passing
  // `availableDownloads: undefined` for the whole time these tests were green.
  // A guard that names more than it inspects is worse than no guard: it is
  // read as coverage.
  const read = async (...rel: string[]): Promise<string> => {
    const fsm = await import("fs");
    const pathm = await import("path");
    return fsm.readFileSync(pathm.join(__dirname, "..", "..", ...rel), "utf8");
  };
  const engine = (): Promise<string> =>
    read("ui", "pages", "install", "engine.ts");
  // The toolbar install action was the second pipeline until it was removed
  // on 2026-09-15; the page's engine is the only one left to inspect.
  const pipelines = async (): Promise<Array<[string, string]>> => [
    ["engine.ts", await engine()],
  ];

  it("no pipeline hardcodes it to undefined any more", async () => {
    for (const [name, src] of await pipelines()) {
      // Comments may mention the old value while explaining it; code must not.
      const code = src
        .split("\n")
        .filter((l) => !/^\s*(\*|\/\/)/.test(l))
        .join("\n");
      expect(code, `${name} still passes availableDownloads: undefined`).not.toMatch(
        /availableDownloads:\s*undefined/,
      );
    }
  });

  it("every pipeline scans before resolving, not after", async () => {
    // A scan that runs after the plan is built is a scan whose results the
    // plan never saw.
    for (const [name, src] of await pipelines()) {
      const scans = [...src.matchAll(/await scanAvailableDownloads\(/g)];
      const resolves = [...src.matchAll(/resolveInstallPlan\(/g)];
      expect(scans.length, `${name} never scans`).toBeGreaterThan(0);
      expect(resolves.length, `${name} never resolves`).toBe(scans.length);
      for (let i = 0; i < scans.length; i += 1) {
        expect(
          scans[i].index,
          `${name}: scan ${i} runs after its resolve`,
        ).toBeLessThan(resolves[i].index!);
      }
    }
  });

  it("both pipelines use the SAME scanner, not a copy each", async () => {
    // The duplicate is how the two drifted apart in the first place. One
    // implementation in core, imported by both, is the only shape of this fix
    // that cannot be applied to one path and forgotten on the other.
    for (const [name, src] of await pipelines()) {
      expect(src, `${name} does not import the shared scanner`).toMatch(
        /import \{ scanAvailableDownloads \} from ".*core\/resolver\/scanAvailableDownloads"/,
      );
    }
    expect(await read("ui", "pages", "install", "engine.ts")).not.toMatch(
      /async function scanAvailableDownloads/,
    );
  });

  it("a failed scan degrades to the old behaviour rather than failing the install", async () => {
    // The status quo IS undefined. A download scan that throws must cost a
    // re-download, never an install.
    const src = await read("core", "resolver", "scanAvailableDownloads.ts");
    const fn = src.slice(src.indexOf("export async function scanAvailableDownloads"));
    expect(fn.slice(0, fn.indexOf("\n}\n"))).toMatch(/catch[\s\S]*return undefined/);
  });
});

describe("reporting", () => {
  it("counts what it passed over, so an empty result is explainable", async () => {
    // "The resolver saw 3 of your 400 downloads" is a bug report. Without
    // counts it is an invisible one.
    write("Good.7z", "g");
    const r = await collectAvailableDownloads({
      state: state({
        good: { game: "fallout4", localPath: "Good.7z" },
        other: { game: "skyrimse", localPath: "Good.7z" },
        gone: { game: "fallout4", localPath: "Missing.7z" },
      }),
      gameId: "fallout4",
      downloadsDir: dir,
      cache: emptyArchiveHashCache(),
    });
    const text = describeDownloadScan(r);
    expect(text).toContain("1 usable");
    expect(text).toMatch(/other game/);
    expect(text).toMatch(/missing/);
  });

  it("reports progress, so a multi-minute first scan is not a frozen window", async () => {
    write("1.7z", "a");
    write("2.7z", "b");
    const seen: number[] = [];
    await collectAvailableDownloads({
      state: state({
        a: { game: "fallout4", localPath: "1.7z" },
        b: { game: "fallout4", localPath: "2.7z" },
      }),
      gameId: "fallout4",
      downloadsDir: dir,
      cache: emptyArchiveHashCache(),
      onProgress: (done, total) => {
        seen.push(done);
        expect(total).toBe(2);
      },
    });
    expect(seen).toEqual([1, 2]);
  });

  it("stops promptly when aborted", async () => {
    // Hashing is the long pole; a cancel that is not honoured here is a
    // cancel the user does not get.
    write("1.7z", "a");
    const ac = new AbortController();
    ac.abort();
    const r = await collectAvailableDownloads({
      state: state({ a: { game: "fallout4", localPath: "1.7z" } }),
      gameId: "fallout4",
      downloadsDir: dir,
      cache: emptyArchiveHashCache(),
      signal: ac.signal,
    });
    expect(r.downloads).toEqual([]);
  });
});
