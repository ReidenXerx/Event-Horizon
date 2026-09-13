/**
 * Measuring gives every bundled mod its bundle's hash as its archive hash. A
 * mod the decisions step then takes off bundling has to go back to its own, or
 * the package names a download that no Nexus file matches.
 */
import { describe, expect, it } from "vitest";

import { restoreArchiveHashes } from "./bundleFromStaging";
import type { AuditorMod } from "../getModsListForProfile";

const OWN = "1".repeat(64);
const BUNDLE = "f".repeat(64);
const OTHER_BUNDLE = "e".repeat(64);

const mod = (id: string, archiveSha256?: string): AuditorMod =>
  ({ id, name: id, ...(archiveSha256 !== undefined ? { archiveSha256 } : {}) }) as AuditorMod;

describe("restoreArchiveHashes", () => {
  it("gives a mod taken off bundling the archive hash it had before measuring, and leaves the rest bundled", () => {
    const out = restoreArchiveHashes(
      [mod("switched", BUNDLE), mod("still-bundled", OTHER_BUNDLE)],
      new Set(["switched"]),
      new Map([
        ["switched", OWN],
        ["still-bundled", "2".repeat(64)],
      ]),
    );
    expect(out.map((m) => m.archiveSha256)).toEqual([OWN, OTHER_BUNDLE]);
  });

  it("leaves no bundle hash on a mod that had no archive hash before", () => {
    const [out] = restoreArchiveHashes([mod("local", BUNDLE)], new Set(["local"]), new Map([["local", undefined]]));
    expect(out).not.toHaveProperty("archiveSha256");
  });

  it("does not guess for a mod it holds no earlier hash for", () => {
    const [out] = restoreArchiveHashes([mod("unknown", BUNDLE)], new Set(["unknown"]), new Map());
    expect(out!.archiveSha256).toBe(BUNDLE);
  });
});
