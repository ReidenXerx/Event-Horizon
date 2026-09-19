/**
 * Drift detection compares what is on disk against what the PREVIOUS INSTALL
 * left there — never against the curator's staging, which diverges from its
 * own archive in ways nobody notices and would promote their accident to
 * truth for every user.
 *
 * The selection rules carry most of the correctness. Each one excludes a case
 * where a mismatch would mean something other than drift, and getting any of
 * them wrong produces a warning on mods nobody touched — which is the failure
 * that makes people stop reading warnings.
 */
import { describe, expect, it } from "vitest";

import {
  describeStagingDrift,
  selectDriftCandidates,
} from "./detectStagingDrift";
import type { InstallReceiptMod } from "../../types/installLedger";
import type { EhcollMod } from "../../types/ehcoll";

const receiptMod = (
  compareKey: string,
  over: Partial<InstallReceiptMod> = {},
): InstallReceiptMod =>
  ({
    vortexModId: `vid-${compareKey}`,
    compareKey,
    source: "nexus",
    name: `Mod ${compareKey}`,
    installedAt: "1970-01-01T00:00:00.000Z",
    stagingSetHash: "a".repeat(64),
    ...over,
  }) as InstallReceiptMod;

const manifestMod = (compareKey: string): EhcollMod =>
  ({ compareKey, name: `Mod ${compareKey}` }) as unknown as EhcollMod;

describe("which mods are worth checking", () => {
  it("checks a mod that is unchanged between versions", () => {
    // The case the feature exists for: same mod, same identity, previously
    // installed by us, still in the collection.
    const out = selectDriftCandidates({
      receiptMods: [receiptMod("nexus:1:2")],
      manifestMods: [manifestMod("nexus:1:2")],
    });
    expect(out.map((c) => c.compareKey)).toEqual(["nexus:1:2"]);
    expect(out[0].expectedHash).toBe("a".repeat(64));
  });

  it("SKIPS a mod the curator updated", () => {
    // The loudest possible way to be wrong. compareKey encodes
    // nexus:modId:fileId, so a new fileId is a different key — an updated mod
    // is SUPPOSED to differ from what we installed, and reporting drift on it
    // would fire for every upgraded mod in the collection.
    const out = selectDriftCandidates({
      receiptMods: [receiptMod("nexus:1:2")],
      manifestMods: [manifestMod("nexus:1:999")],
    });
    expect(out).toEqual([]);
  });

  it("SKIPS a mod dropped from the collection", () => {
    // Being removed, not drifting.
    const out = selectDriftCandidates({
      receiptMods: [receiptMod("nexus:1:2")],
      manifestMods: [manifestMod("nexus:5:6")],
    });
    expect(out).toEqual([]);
  });

  it("SKIPS a mod with no recorded hash", () => {
    // An older receipt, a "fast" package, or a mod whose verification failed
    // so the previous install could not prove what it left. Unknown is not
    // "unchanged" — and it is not "changed" either.
    const out = selectDriftCandidates({
      receiptMods: [receiptMod("nexus:1:2", { stagingSetHash: undefined })],
      manifestMods: [manifestMod("nexus:1:2")],
    });
    expect(out).toEqual([]);
  });

  it("carries the vortexModId, so the caller knows where to look", () => {
    // The staging folder is found through Vortex's mod record, not the name.
    const out = selectDriftCandidates({
      receiptMods: [receiptMod("nexus:1:2", { vortexModId: "the-id" })],
      manifestMods: [manifestMod("nexus:1:2")],
    });
    expect(out[0].vortexModId).toBe("the-id");
  });

  it("handles a first install — no receipt, nothing to check", () => {
    expect(
      selectDriftCandidates({ receiptMods: [], manifestMods: [manifestMod("a")] }),
    ).toEqual([]);
  });

  it("scales to a real collection without accidental cross-matching", () => {
    // 900 unchanged, 54 updated. Only the unchanged ones are candidates.
    const unchanged = Array.from({ length: 900 }, (_, i) => `nexus:${i}:1`);
    const updated = Array.from({ length: 54 }, (_, i) => `nexus:${1000 + i}:1`);
    const out = selectDriftCandidates({
      receiptMods: [
        ...unchanged.map((k) => receiptMod(k)),
        ...updated.map((k) => receiptMod(k)),
      ],
      manifestMods: [
        ...unchanged.map(manifestMod),
        // same mods, new file ids
        ...updated.map((k) => manifestMod(k.replace(":1", ":2"))),
      ],
    });
    expect(out).toHaveLength(900);
  });
});

describe("the driver records the reference and later uses it", () => {
  // Both halves have to exist or the feature is inert, and each is invisible
  // without the other: recording a hash nothing reads, or reading a hash
  // nothing records, both typecheck and both do nothing.
  const read = async (rel: string): Promise<string> => {
    const fs = await import("fs");
    const path = await import("path");
    return fs.readFileSync(path.join(__dirname, rel), "utf8");
  };

  it("records the hash ONLY for mods whose verification passed", async () => {
    // Verification passing is the proof that the manifest's file list
    // describes this disk. Without that condition the receipt would record a
    // fingerprint of files we never confirmed, and every later drift check
    // would compare against a fiction.
    const src = await read("runInstall.ts");
    expect(src).toMatch(/noteVerifiedOk\(/);
    expect(src).toMatch(/stagingSetHashFor\(/);
    expect(src).toMatch(/if \(!verifiedOkKeys\.has\(mod\.compareKey\)\) return \{\}/);
  });

  it("does NOT record it for the curator-diverged case", async () => {
    // There the disk deliberately does not match the manifest, so a
    // manifest-derived fingerprint would be wrong by construction.
    const src = await read("runInstall.ts");
    const branch = src.slice(src.indexOf('judgement.kind === "curator-diverged"'));
    expect(branch.slice(0, branch.indexOf("continue;"))).not.toContain(
      "noteVerifiedOk(",
    );
  });

  it("checks for drift after installing, not before", async () => {
    // These mods resolve as already-installed and are not touched by the run,
    // so the drift survives it — reporting afterwards describes something
    // still true.
    const src = await read("runInstall.ts");
    const drift = src.indexOf("await detectDrift(");
    const receipt = src.indexOf("const receipt = buildReceipt(");
    expect(drift).toBeGreaterThan(-1);
    expect(drift).toBeLessThan(receipt);
  });

  it("costs nothing on a first install", async () => {
    // No previous receipt means nothing to compare, and it must not walk a
    // single folder to discover that.
    const src = await read("runInstall.ts");
    const fn = src.slice(src.indexOf("async function detectDrift"));
    const body = fn.slice(0, fn.indexOf("\n}\n"));
    const readsReceipt = body.indexOf("await readReceipt(");
    const walks = body.indexOf("findDriftedMods(");
    expect(readsReceipt).toBeLessThan(walks);
    expect(body).toMatch(/previous === undefined\) return undefined/);
  });

  it("surfaces it, rather than logging it into the void", async () => {
    const src = await read("runInstall.ts");
    expect(src).toMatch(/stagingDriftNotice: driftNotice/);
    const fs = await import("fs");
    const path = await import("path");
    const steps = fs.readFileSync(
      path.join(__dirname, "..", "..", "ui", "pages", "install", "steps.tsx"),
      "utf8",
    );
    expect(steps).toMatch(/<StagingDriftNotice lines=\{result\.stagingDriftNotice/);
  });
});

describe("what the user is told", () => {
  const finding = (name: string) => ({
    compareKey: `k-${name}`,
    name,
    vortexModId: `v-${name}`,
  });

  it("says nothing when nothing drifted", () => {
    expect(describeStagingDrift([])).toBeUndefined();
  });

  it("describes rather than accuses", () => {
    // We genuinely do not know which of these the user did on purpose.
    // Telling someone their deliberate edit is damage is how they learn to
    // ignore the next warning.
    const lines = describeStagingDrift([finding("A Mod")])!.join(" ");
    expect(lines).toMatch(/nothing here is necessarily wrong/i);
    expect(lines).not.toMatch(/\b(corrupt|damaged|broken)\b/i);
  });

  it("states that we changed nothing, and offers both directions", () => {
    // The user must know the install did not silently repair anything, and
    // that keeping their version is a real option rather than the failure
    // branch.
    const lines = describeStagingDrift([finding("A Mod")])!.join(" ");
    expect(lines).toMatch(/Reinstalling any of these/i);
    expect(lines).toMatch(/leaving it keeps what is on disk/i);
    expect(lines).toMatch(/has changed nothing/i);
  });

  it("names the mods, capped, with a count for the rest", () => {
    const many = Array.from({ length: 40 }, (_, i) => finding(`Mod ${i}`));
    const lines = describeStagingDrift(many)!;
    expect(lines[0]).toContain("40 mods");
    expect(lines.join("\n")).toMatch(/and 30 more/);
    expect(lines.length).toBeLessThan(15);
  });

  it("reads correctly for exactly one mod", () => {
    // "1 mods ... they are unchanged" is the kind of thing that makes a
    // warning look automated and therefore ignorable.
    const lines = describeStagingDrift([finding("Solo")])!.join(" ");
    expect(lines).toContain("1 mod ");
    expect(lines).toMatch(/it is unchanged/);
    expect(lines).not.toMatch(/1 mods/);
  });
});

/**
 * ──────────────────────────────────────────────────────────────────────
 * Condition 4: the recorded hash and the fresh one must cover the SAME
 * FILE LIST, or they differ for a reason that is not drift.
 *
 * Condition 3 reasons that an unchanged `compareKey` implies an unchanged
 * list. It does not — the key encodes the archive, so a curator who narrows
 * which of that archive's files the collection records leaves it untouched
 * while the recorded set changes underneath. Both sides then digest different
 * lists, and the player is told a folder nobody touched was edited, with
 * advice to reinstall it. That is the failure that makes people stop reading
 * warnings, which this file's own header names.
 * ──────────────────────────────────────────────────────────────────────
 */
describe("a changed FILE LIST is not drift", () => {
  const file = (path: string) => ({ path, size: 1, sha256: "b".repeat(64) });
  const modWithFiles = (compareKey: string, paths: string[]): EhcollMod =>
    ({
      compareKey,
      name: `Mod ${compareKey}`,
      state: { stagingFiles: paths.map(file) },
    }) as unknown as EhcollMod;

  const pathsHashOf = async (paths: string[]): Promise<string> => {
    const { computeStagingPathSetHash } = await import(
      "../manifest/stagingSetHash"
    );
    return computeStagingPathSetHash(paths.map(file))!;
  };

  it("drops a mod whose recorded paths changed since the receipt", async () => {
    const before = await pathsHashOf(["Data/a.esp", "Data/b.esp"]);
    const out = selectDriftCandidates({
      receiptMods: [receiptMod("nexus:1:2", { stagingSetPaths: before })],
      // The curator now records only one of the two files.
      manifestMods: [modWithFiles("nexus:1:2", ["Data/a.esp"])],
    });
    expect(out).toEqual([]);
  });

  it("keeps a mod whose recorded paths are identical", async () => {
    const same = await pathsHashOf(["Data/a.esp", "Data/b.esp"]);
    const out = selectDriftCandidates({
      receiptMods: [receiptMod("nexus:1:2", { stagingSetPaths: same })],
      manifestMods: [modWithFiles("nexus:1:2", ["Data/b.esp", "Data/a.esp"])],
    });
    // Order must not matter — the digest sorts.
    expect(out).toHaveLength(1);
  });

  it("keeps a mod from a receipt written before the field existed", () => {
    // Unknown is not "changed". Dropping these would silently retire drift
    // detection for every player who has not reinstalled since.
    const out = selectDriftCandidates({
      receiptMods: [receiptMod("nexus:1:2")],
      manifestMods: [modWithFiles("nexus:1:2", ["Data/a.esp"])],
    });
    expect(out).toHaveLength(1);
  });
});
