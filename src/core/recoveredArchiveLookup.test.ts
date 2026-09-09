/**
 * A recovered archive that nothing could open.
 *
 * "Re-download archives" fetches a missing archive WITHOUT reinstalling the
 * mod — deliberately, because reinstalling would re-run FOMODs the curator
 * answered once and is the exact condition under which Vortex drops files.
 * Vortex files the result as a NEW download with a NEW id, and archiveRecovery
 * declines to re-point the mod at it: writing to Vortex's own mod records is
 * not this extension's business.
 *
 * That decision stands. What was missing is the other half of it — having
 * declined to write the link into Vortex, we then threw it away, keeping only
 * the hash. So a recovered mod ended up identifiable and unreadable at once:
 * the manifest could name it, and every check that opens archive bytes could
 * not find it.
 *
 * Measured on a 773-mod Skyrim collection: 771 archives recovered, and the
 * build's self-check then skipped 772 of 773 mods — reported as "archive
 * missing from disk, or unreadable", which was false by the time it was
 * printed. FOMOD-omission and staging-drift verification were off for the
 * entire collection, and nothing failed.
 *
 * So these tests are about one question: after a recovery, can the file still
 * be found — in this session, and in the next one.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { __testPaths } from "../../test/stubs/vortex-api";
import { resolveModArchivePath } from "./archiveHashing";
import { applyRecovery } from "./archiveRecovery";
import type { RecoveryReport } from "./archiveRecovery";
import {
  applyCachedDownloadIds,
  applyCachedHashes,
  emptyArchiveHashCache,
  rememberArchiveHash,
} from "./archiveHashCache";
import type { AuditorMod } from "./getModsListForProfile";

const SHA = "a".repeat(64);

const mod = (id: string, over: Partial<AuditorMod> = {}): AuditorMod =>
  ({
    id,
    name: id,
    enabled: true,
    collectionIds: [],
    hasInstallerChoices: false,
    hasDetailedInstallerChoices: false,
    fomodSelections: [],
    rules: [],
    modType: "",
    fileOverrides: [],
    enabledINITweaks: [],
    installOrder: 0,
    ...over,
  }) as AuditorMod;

/** Vortex state with exactly the download records named. */
const stateWith = (files: Record<string, string>): any => ({
  persistent: { downloads: { files: Object.fromEntries(
    Object.entries(files).map(([id, localPath]) => [id, { localPath }]),
  ) } },
});

describe("resolveModArchivePath", () => {
  __testPaths.downloadPath = "/downloads";

  it("uses the mod's own record when it still resolves", () => {
    const state = stateWith({ live: "TheMod.7z", recovered: "Other.7z" });
    const path = resolveModArchivePath(
      state,
      { archiveId: "live", recoveredDownloadId: "recovered" },
      "skyrimse",
    );
    // The archive it was actually installed from wins. The recovered id is a
    // fallback and must never override a living record.
    expect(path).toContain("TheMod.7z");
  });

  it("falls back to the recovered download when the mod's record is dead", () => {
    // The real shape: the mod still names an archiveId, and that id is no
    // longer in Vortex's downloads at all.
    const state = stateWith({ recovered: "TheMod.7z" });
    const path = resolveModArchivePath(
      state,
      { archiveId: "long-gone", recoveredDownloadId: "recovered" },
      "skyrimse",
    );
    expect(path).toContain("TheMod.7z");
  });

  it("is still undefined when neither resolves", () => {
    expect(
      resolveModArchivePath(
        stateWith({}),
        { archiveId: "gone", recoveredDownloadId: "also-gone" },
        "skyrimse",
      ),
    ).toBeUndefined();
  });

  it("does not invent a path for a mod that never had an archive", () => {
    expect(
      resolveModArchivePath(stateWith({ x: "X.7z" }), {}, "skyrimse"),
    ).toBeUndefined();
  });
});

describe("applyRecovery", () => {
  const report = (downloadId: string): RecoveryReport => ({
    recovered: [
      {
        kind: "recovered",
        mod: mod("m1"),
        archiveSha256: SHA,
        downloadId,
        nexusModId: 100,
        nexusFileId: 200,
      },
    ],
    failed: [],
    unattemptable: [],
    aborted: false,
  });

  it("keeps the download id, not only the hash", () => {
    const [out] = applyRecovery([mod("m1", { archiveId: "dead" })], report("dl-9"));
    expect(out!.archiveSha256).toBe(SHA);
    // Without this the mod is identifiable and unopenable at the same time.
    expect(out!.recoveredDownloadId).toBe("dl-9");
  });

  it("makes the archive findable again in the same session", () => {
    const [out] = applyRecovery([mod("m1", { archiveId: "dead" })], report("dl-9"));
    const state = stateWith({ "dl-9": "Recovered.7z" });
    expect(resolveModArchivePath(state, out!, "skyrimse")).toContain(
      "Recovered.7z",
    );
  });

  it("leaves mods it did not recover alone", () => {
    const out = applyRecovery([mod("other")], report("dl-9"));
    expect(out[0]!.recoveredDownloadId).toBeUndefined();
    expect(out[0]!.archiveSha256).toBeUndefined();
  });
});

describe("surviving a Vortex restart", () => {
  it("round-trips the download id through the hash cache", () => {
    // The recovery writes each result as it lands; the next session reads it
    // back. If only the hash survives, the next build repeats the original bug
    // with no recovery run to blame it on.
    const cache = rememberArchiveHash(emptyArchiveHashCache(), {
      nexusModId: 100,
      nexusFileId: 200,
      sha256: SHA,
      at: new Date().toISOString(),
      downloadId: "dl-9",
    });

    const fresh = mod("m1", {
      archiveId: "dead",
      nexusModId: 100,
      nexusFileId: 200,
    });
    const { mods, filled } = applyCachedHashes([fresh], cache);
    expect(filled).toBe(1);
    expect(mods[0]!.archiveSha256).toBe(SHA);
    expect(mods[0]!.recoveredDownloadId).toBe("dl-9");

    const state = stateWith({ "dl-9": "Recovered.7z" });
    expect(resolveModArchivePath(state, mods[0]!, "skyrimse")).toContain(
      "Recovered.7z",
    );
  });

  it("still works for entries written before download ids were recorded", () => {
    // Older caches have a hash and nothing else. They must keep doing what
    // they always did rather than becoming an error.
    const cache = rememberArchiveHash(emptyArchiveHashCache(), {
      nexusModId: 100,
      nexusFileId: 200,
      sha256: SHA,
      at: new Date().toISOString(),
    });
    const { mods, filled } = applyCachedHashes(
      [mod("m1", { nexusModId: 100, nexusFileId: 200 })],
      cache,
    );
    expect(filled).toBe(1);
    expect(mods[0]!.archiveSha256).toBe(SHA);
    expect(mods[0]!.recoveredDownloadId).toBeUndefined();
  });
});

describe("applyCachedDownloadIds", () => {
  it("restores the link without inventing an identity", () => {
    // Runs before hashing, so it must NOT fill archiveSha256: a hash keyed by
    // Nexus ids would then stand in for a file that is present and readable,
    // and quietly outrank hashing the actual bytes.
    const cache = rememberArchiveHash(emptyArchiveHashCache(), {
      nexusModId: 100,
      nexusFileId: 200,
      sha256: SHA,
      at: new Date().toISOString(),
      downloadId: "dl-9",
    });
    const [out] = applyCachedDownloadIds(
      [mod("m1", { archiveId: "dead", nexusModId: 100, nexusFileId: 200 })],
      cache,
    );
    expect(out!.recoveredDownloadId).toBe("dl-9");
    expect(out!.archiveSha256).toBeUndefined();
  });

  it("returns the same array when there is nothing to restore", () => {
    const mods = [mod("m1")];
    expect(applyCachedDownloadIds(mods, emptyArchiveHashCache())).toBe(mods);
  });

  it("stops the early check reporting a recovered archive as missing", () => {
    // The regression in the shape the curator saw it: one second into the
    // build, after a successful recovery.
    const cache = rememberArchiveHash(emptyArchiveHashCache(), {
      nexusModId: 100,
      nexusFileId: 200,
      sha256: SHA,
      at: new Date().toISOString(),
      downloadId: "dl-9",
    });
    const raw = mod("m1", {
      archiveId: "dead",
      nexusModId: 100,
      nexusFileId: 200,
    });
    const state = stateWith({ "dl-9": "Recovered.7z" });

    expect(resolveModArchivePath(state, raw, "skyrimse")).toBeUndefined();
    const [restored] = applyCachedDownloadIds([raw], cache);
    expect(resolveModArchivePath(state, restored!, "skyrimse")).toContain(
      "Recovered.7z",
    );
  });
});

describe("every curator-side lookup goes through the resolver", () => {
  // A unit test cannot catch a caller that stops calling, and this bug WAS a
  // set of callers each asking the narrow question on its own. Same shape of
  // guard as locatePackage.test.ts.
  const CONSUMERS = [
    "core/manifest/runSelfChecks.ts",
    "ui/pages/build/engine.ts",
    "core/archiveRecovery.ts",
  ];

  const sources = CONSUMERS.map((rel) => ({
    rel,
    text: readFileSync(join(__dirname, "..", rel), "utf8"),
  }));

  it("finds the files it claims to check", () => {
    for (const s of sources) expect(s.text.length).toBeGreaterThan(0);
  });

  it("has no consumer resolving by archiveId alone", () => {
    // The exact pattern that skipped 772 of 773 mods.
    const offenders = sources
      .filter((s) => /getModArchivePath\(\s*state,\s*\w+\.archiveId/.test(s.text))
      .map((s) => s.rel);
    expect(offenders).toEqual([]);
  });

  it("routes each of them through resolveModArchivePath", () => {
    const offenders = sources
      .filter((s) => !s.text.includes("resolveModArchivePath"))
      .map((s) => s.rel);
    expect(offenders).toEqual([]);
  });
});
