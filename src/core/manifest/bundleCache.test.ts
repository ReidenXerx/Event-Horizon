/**
 * ──────────────────────────────────────────────────────────────────────
 * Reusing an earlier measurement of a bundle, and the ways that could go wrong.
 *
 * Wrong in the expensive direction: accept a record for files it does not
 * describe, and the build names an identity the package does not contain.
 * Packaging stops that build now — but a record this module accepted is the
 * only way to get there, so the acceptance rules are pinned here.
 *
 * Wrong in the cheap direction: fail to reuse, and the curator waits. That is
 * the direction every uncertainty here resolves towards.
 * ──────────────────────────────────────────────────────────────────────
 */
import { describe, expect, it } from "vitest";

import {
  bundleRecordName,
  isBundleRecordOfMod,
  isLegacyBundleArchive,
  recordMatches,
  sanitizeModId,
  staleBundleRecordsFor,
} from "./bundleCache";

const KEY_A = "a".repeat(64);
const KEY_B = "b".repeat(64);
const record = (over: Record<string, unknown> = {}): unknown => ({
  format: 1,
  sha256: KEY_A,
  bytes: 100,
  files: 3,
  ...over,
});

describe("naming a record after the files it describes", () => {
  it("carries both the mod and the content", () => {
    expect(bundleRecordName("mod-1", KEY_A)).toBe(`mod-1-${KEY_A}.bundle.json`);
  });

  it("gives different content a different name", () => {
    // The whole mechanism: a name that said only which mod could never be
    // trusted for reuse.
    expect(bundleRecordName("m", KEY_A)).not.toBe(bundleRecordName("m", KEY_B));
  });

  it("keeps a mod id usable as a filename", () => {
    expect(sanitizeModId("Ünsafe/name:v2")).toBe("_nsafe_name_v2");
  });
});

describe("which files belong to which mod", () => {
  it("claims its own records", () => {
    expect(isBundleRecordOfMod(`m-${KEY_A}.bundle.json`, "m")).toBe(true);
  });

  it("does NOT let one mod claim another whose id starts the same", () => {
    // Sweeping is a delete. "m" matching "m2"'s records would throw away one
    // that belongs to a different mod entirely.
    expect(isBundleRecordOfMod(`m2-${KEY_A}.bundle.json`, "m")).toBe(false);
  });

  it("ignores anything that is not one of its records, old archives included", () => {
    expect(isBundleRecordOfMod("m-notahash.bundle.json", "m")).toBe(false);
    expect(isBundleRecordOfMod(`m-${KEY_A}.zip`, "m")).toBe(false);
    expect(isBundleRecordOfMod(`m-${KEY_A}.zip.json`, "m")).toBe(false);
  });
});

describe("sweeping older records", () => {
  it("keeps the one in use and drops the rest", () => {
    expect(
      staleBundleRecordsFor({
        fileNames: [`m-${KEY_A}.bundle.json`, `m-${KEY_B}.bundle.json`],
        modId: "m",
        keep: `C:/cache/m-${KEY_A}.bundle.json`,
      }),
    ).toEqual([`m-${KEY_B}.bundle.json`]);
  });

  it("never touches another mod's records", () => {
    // The folder is shared by every collection. A build of one must not throw
    // away what another one would have reused.
    expect(
      staleBundleRecordsFor({
        fileNames: [`other-${KEY_B}.bundle.json`, `m-${KEY_B}.bundle.json`],
        modId: "m",
        keep: `C:/cache/m-${KEY_A}.bundle.json`,
      }),
    ).toEqual([`m-${KEY_B}.bundle.json`]);
  });

  it("drops nothing when the only record is the one in use", () => {
    expect(
      staleBundleRecordsFor({
        fileNames: [`m-${KEY_A}.bundle.json`],
        modId: "m",
        keep: `C:/cache/m-${KEY_A}.bundle.json`,
      }),
    ).toEqual([]);
  });
});

describe("the archives this folder held before bundles shipped loose", () => {
  it("recognises every shape the old cache wrote", () => {
    expect(isLegacyBundleArchive(`lods-${KEY_A}.zip`)).toBe(true);
    expect(isLegacyBundleArchive(`lods-${KEY_A}.zip.json`)).toBe(true);
    expect(isLegacyBundleArchive("lods-uncacheable.zip")).toBe(true);
  });

  it("leaves records, and anything it did not write, alone", () => {
    expect(isLegacyBundleArchive(`lods-${KEY_A}.bundle.json`)).toBe(false);
    expect(isLegacyBundleArchive("notes.zip")).toBe(false);
    expect(isLegacyBundleArchive(`lods-${KEY_A}.7z`)).toBe(false);
  });
});

describe("trusting a record", () => {
  it("accepts a complete one taken under this format", () => {
    expect(recordMatches(record(), 1)).toBe(true);
  });

  it("rejects one taken under another format, because the same files make a different zip", () => {
    expect(recordMatches(record({ format: 2 }), 1)).toBe(false);
    expect(recordMatches(record({ format: undefined }), 1)).toBe(false);
  });

  it("rejects a record with no usable hash or counts", () => {
    expect(recordMatches(record({ sha256: "nope" }), 1)).toBe(false);
    expect(recordMatches(record({ bytes: -1 }), 1)).toBe(false);
    expect(recordMatches(record({ bytes: "100" }), 1)).toBe(false);
    expect(recordMatches(record({ files: 1.5 }), 1)).toBe(false);
  });

  it("rejects something that is not a record at all", () => {
    expect(recordMatches(undefined, 1)).toBe(false);
    expect(recordMatches(null, 1)).toBe(false);
    expect(recordMatches("{}", 1)).toBe(false);
  });
});
