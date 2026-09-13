/**
 * ──────────────────────────────────────────────────────────────────────
 * Measuring the same files twice should read them once.
 *
 * DynDOLOD output is commonly several gigabytes and almost never changes
 * between two versions of a collection. A bundled mod's identity is the hash
 * of the canonical zip its files make, and working that out reads every byte,
 * so each build keeps a small record of the answer under the hash of the files.
 *
 * Reuse is observed, not inferred: `reused` on the result, and a staging folder
 * changed BEHIND a record — which a reused measurement cannot see and a fresh
 * one must.
 * ──────────────────────────────────────────────────────────────────────
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { __testPaths } from "../../../test/stubs/vortex-api";
import {
  mergeRepackedBundles,
  repackBundledExternals,
  type RepackedBundle,
} from "./bundleFromStaging";
import { bundleFilesFromListing, listBundleFolder, writeBundleZip } from "./bundleZip";
import { computeStagingSetHash } from "./stagingSetHash";
import type { AuditorMod } from "../getModsListForProfile";
import type { CollectionConfig } from "./collectionConfig";

const mod = (over: Partial<AuditorMod> & { id: string }): AuditorMod =>
  ({
    name: over.id,
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

const config = (externalMods: CollectionConfig["externalMods"]): CollectionConfig =>
  ({ schemaVersion: 1, packageId: "p", externalMods }) as CollectionConfig;

let staging: string;
let workDir: string;
let lodsDir: string;
beforeEach(() => {
  staging = fs.mkdtempSync(path.join(os.tmpdir(), "eh-reuse-"));
  __testPaths.installPath = staging;
  workDir = path.join(staging, ".repack");
  lodsDir = path.join(staging, "lods");
  fs.mkdirSync(lodsDir, { recursive: true });
  fs.writeFileSync(path.join(lodsDir, "tamriel.bto"), "lod bytes");
});
afterEach(() => {
  fs.rmSync(staging, { recursive: true, force: true });
  __testPaths.installPath = "/stub/install";
});

/** The mod as the build's inspection recorded it: `sha` is the recorded hash of its one file. */
const lods = (sha: string | undefined): AuditorMod =>
  mod({
    id: "lods",
    name: "DynDOLOD_Output",
    installationPath: "lods",
    stagingFiles: [{ path: "tamriel.bto", size: 9, ...(sha !== undefined ? { sha256: sha } : {}) }],
  } as never);

const run = (m: AuditorMod, reuseRecords?: boolean): ReturnType<typeof repackBundledExternals> =>
  repackBundledExternals({
    state: {} as never,
    gameId: "skyrimse",
    mods: [m],
    config: config({ lods: { bundled: true } }),
    workDir,
    isExternal: () => true,
    ...(reuseRecords !== undefined ? { options: { reuseRecords } } : {}),
  });

/** What the folder's files make right now, measured independently of the build. */
const identityOf = async (dir: string): Promise<string> =>
  (await writeBundleZip(await bundleFilesFromListing(await listBundleFolder(dir)), undefined)).sha256;

const records = (): string[] =>
  fs.readdirSync(workDir).filter((f) => f.endsWith(".bundle.json")).sort();

/** The record for `lods(sha)`: keyed by the hash of the staging SET, not of its one file. */
const recordNameFor = (sha: string): string =>
  `lods-${computeStagingSetHash(lods(sha).stagingFiles ?? [])!}.bundle.json`;

describe("measuring a bundled mod", () => {
  it("names the mod by the zip its staging files make", async () => {
    const out = await run(lods("a".repeat(64)));
    expect(out.failed).toEqual([]);
    expect(out.bundles).toHaveLength(1);
    expect(out.bundles[0]!.sha256).toBe(await identityOf(lodsDir));
    expect(out.bundles[0]!.rootDir).toBe(lodsDir);
    expect(out.bundles[0]!.files).toBe(1);
    // Identity follows the bytes: the manifest must name what ships.
    expect(out.mods[0]!.archiveSha256).toBe(out.bundles[0]!.sha256);
  });

  it("reuses the measurement the second time, under the same identity", async () => {
    const first = await run(lods("a".repeat(64)));
    const second = await run(lods("a".repeat(64)));
    expect(first.bundles[0]!.reused).toBeUndefined();
    expect(second.bundles[0]!.reused).toBe(true);
    expect(second.bundles[0]!.sha256).toBe(first.bundles[0]!.sha256);
    expect(second.mods[0]!.archiveSha256).toBe(first.mods[0]!.archiveSha256);
  });

  it("reads again when the staging content has changed", async () => {
    // The expensive mistake this must never make: naming last week's LOD
    // output while shipping this week's.
    await run(lods("a".repeat(64)));
    fs.writeFileSync(path.join(lodsDir, "tamriel.bto"), "new lod bytes");
    const changed = await run(lods("b".repeat(64)));
    expect(changed.bundles[0]!.reused).toBeUndefined();
    expect(changed.bundles[0]!.sha256).toBe(await identityOf(lodsDir));
  });

  it("reads again when told not to trust records, which is the way past a wrong one", async () => {
    // The one change a record cannot see: bytes rewritten while the recorded
    // hashes stay put. Packaging refuses such a build; re-verifying everything
    // is how the curator gets past it.
    const first = await run(lods("a".repeat(64)));
    fs.writeFileSync(path.join(lodsDir, "tamriel.bto"), "rotted bytes!");
    const trusted = await run(lods("a".repeat(64)));
    expect(trusted.bundles[0]!.sha256).toBe(first.bundles[0]!.sha256);

    const reread = await run(lods("a".repeat(64)), false);
    expect(reread.bundles[0]!.reused).toBeUndefined();
    expect(reread.bundles[0]!.sha256).toBe(await identityOf(lodsDir));
    expect(reread.bundles[0]!.sha256).not.toBe(first.bundles[0]!.sha256);
    // And the record is corrected, so the next ordinary build is right too.
    expect((await run(lods("a".repeat(64)))).bundles[0]!.sha256).toBe(reread.bundles[0]!.sha256);
  });

  it("keeps only the newest record for that mod", async () => {
    await run(lods("a".repeat(64)));
    await run(lods("b".repeat(64)));
    expect(records()).toEqual([recordNameFor("b".repeat(64))]);
  });

  it("keeps no record when the staging set carries no hashes to key it on", async () => {
    // `computeStagingSetHash` refuses a partial capture, and refusing is right:
    // reuse would then be a guess about files nobody measured.
    await run(lods(undefined));
    const second = await run(lods(undefined));
    expect(second.bundles[0]!.reused).toBeUndefined();
    expect(records()).toEqual([]);
  });

  it("reads again when a record is half-written or from another bundle format", async () => {
    await run(lods("a".repeat(64)));
    const recordPath = path.join(workDir, recordNameFor("a".repeat(64)));

    fs.writeFileSync(recordPath, "{ half-writ");
    expect((await run(lods("a".repeat(64)))).bundles[0]!.reused).toBeUndefined();

    fs.writeFileSync(
      recordPath,
      JSON.stringify({ format: 0, sha256: "c".repeat(64), bytes: 1, files: 1 }),
    );
    const again = await run(lods("a".repeat(64)));
    expect(again.bundles[0]!.reused).toBeUndefined();
    expect(again.bundles[0]!.sha256).toBe(await identityOf(lodsDir));
  });

  it("deletes the archives the old cache left behind, and nothing else", async () => {
    fs.mkdirSync(workDir, { recursive: true });
    const legacy = [
      `lods-${"c".repeat(64)}.zip`,
      `lods-${"c".repeat(64)}.zip.json`,
      "other-uncacheable.zip",
    ];
    for (const f of legacy) fs.writeFileSync(path.join(workDir, f), "gigabytes, once");
    const othersRecord = path.join(workDir, `other-${"d".repeat(64)}.bundle.json`);
    fs.writeFileSync(othersRecord, "another collection's record");
    const stranger = path.join(workDir, "notes.txt");
    fs.writeFileSync(stranger, "not ours to judge");

    await run(lods("a".repeat(64)));

    for (const f of legacy) expect(fs.existsSync(path.join(workDir, f)), f).toBe(false);
    expect(fs.existsSync(othersRecord)).toBe(true);
    expect(fs.existsSync(stranger)).toBe(true);
  });
});

describe("folding a second repack pass into the first", () => {
  // The build-killer two audit lenses found independently. `repackBundledExternals`
  // measures every mod the CONFIG marks bundled, so a mid-build second pass returns
  // the already-bundled mods too — reused, with the SAME sha256. Concatenating them
  // made `packageEhcoll` reject the build: "Two bundled mods share sha256 ... this
  // should be impossible."
  const b = (modId: string, sha: string): RepackedBundle => ({
    modId,
    modName: modId,
    rootDir: `C:/staging/${modId}`,
    sha256: sha,
    bytes: 1,
    files: 1,
  });

  it("keeps ONE entry per mod when the second pass re-emits the first", () => {
    const merged = mergeRepackedBundles(
      [b("lods", "a".repeat(64)), b("grass", "b".repeat(64))],
      [b("lods", "a".repeat(64)), b("grass", "b".repeat(64)), b("new", "c".repeat(64))],
    );
    expect(merged).toHaveLength(3);
    const shas = merged.map((x) => x.sha256);
    expect(new Set(shas).size, "duplicate sha256 would fail packaging").toBe(3);
  });

  it("lets the second pass win, because it read the answers", () => {
    const merged = mergeRepackedBundles([b("m", "a".repeat(64))], [b("m", "d".repeat(64))]);
    expect(merged).toEqual([b("m", "d".repeat(64))]);
  });

  it("is a no-op when the second pass found nothing", () => {
    const first = [b("m", "a".repeat(64))];
    expect(mergeRepackedBundles(first, [])).toEqual(first);
  });
});
