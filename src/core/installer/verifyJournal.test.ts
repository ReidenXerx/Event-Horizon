/**
 * Verification that survives being stopped.
 *
 * ─── THE FIELD FAILURE ─────────────────────────────────────────────────────
 * "Gate to SovnGoon", 3,236 mods, 2026-09-17. Install 14.1 h, verification
 * another 4.85 h. The tester stopped a later run an hour into verification —
 * `outcome: aborted, phase: verifying-mods`, 1,258 of 3,236 — and all 1,258
 * proofs were lost, because verdicts lived only in an array the receipt is
 * written from at the very end.
 *
 * These tests are about the rules for reusing a proof, which is where this can
 * go wrong quietly: reusing one that no longer holds is worse than re-hashing.
 */
import * as fsp from "fs/promises";
import * as os from "os";
import * as path from "path";

import { afterEach, describe, expect, it } from "vitest";

import {
  appendVerifyJournal,
  clearVerifyJournal,
  readVerifyJournal,
  reusableVerifications,
  type VerifyJournalEntry,
} from "./verifyJournal";

const PKG = "0be2a2bc-bcb7-4eca-8e07-cfd71a406476";

const entry = (over: Partial<VerifyJournalEntry> = {}): VerifyJournalEntry => ({
  compareKey: "nexus:29725:548408",
  vortexModId: "Race-Based Textures (RBT)-29725",
  packageVersion: "1.1.8",
  level: "thorough",
  verifiedFileCount: 42,
  extraFileCount: 0,
  at: 1_700_000_000_000,
  ...over,
});

const noInstallTimes = new Map<string, number>();

describe("which proofs may be reused", () => {
  it("reuses a proof for the same mod, version and level", () => {
    const out = reusableVerifications({
      entries: [entry()],
      packageVersion: "1.1.8",
      level: "thorough",
      installedAt: noInstallTimes,
    });
    expect(out.get("nexus:29725:548408")?.verifiedFileCount).toBe(42);
  });

  it("drops a proof made for a different package version", () => {
    // The curator changed the collection; what was proven was proven about a
    // different file list.
    const out = reusableVerifications({
      entries: [entry({ packageVersion: "1.1.7" })],
      packageVersion: "1.1.8",
      level: "thorough",
      installedAt: noInstallTimes,
    });
    expect(out.size).toBe(0);
  });

  it("will not let a fast proof satisfy a thorough run", () => {
    expect(
      reusableVerifications({
        entries: [entry({ level: "fast" })],
        packageVersion: "1.1.8",
        level: "thorough",
        installedAt: noInstallTimes,
      }).size,
    ).toBe(0);
    // The other direction is sound: thorough proved everything fast would.
    expect(
      reusableVerifications({
        entries: [entry({ level: "thorough" })],
        packageVersion: "1.1.8",
        level: "fast",
        installedAt: noInstallTimes,
      }).size,
    ).toBe(1);
  });

  it("drops a proof for a mod that was re-installed after it", () => {
    // The one that makes this safe rather than merely fast: Vortex's own
    // installTime says the files on disk are not the files we proved.
    const out = reusableVerifications({
      entries: [entry({ at: 1_000 })],
      packageVersion: "1.1.8",
      level: "thorough",
      installedAt: new Map([["Race-Based Textures (RBT)-29725", 2_000]]),
    });
    expect(out.size).toBe(0);
  });

  it("keeps a proof made after the mod was installed", () => {
    const out = reusableVerifications({
      entries: [entry({ at: 3_000 })],
      packageVersion: "1.1.8",
      level: "thorough",
      installedAt: new Map([["Race-Based Textures (RBT)-29725", 2_000]]),
    });
    expect(out.size).toBe(1);
  });

  it("keeps a proof when Vortex recorded no install time at all", () => {
    // Vortex does not always write installTime. Refusing to trust the proof
    // then would disable resumption for whole collections to guard against a
    // re-install there is no evidence of.
    const out = reusableVerifications({
      entries: [entry()],
      packageVersion: "1.1.8",
      level: "thorough",
      installedAt: new Map([["some-other-mod", 9_000]]),
    });
    expect(out.size).toBe(1);
  });

  it("lets the newest proof for a mod win", () => {
    const out = reusableVerifications({
      entries: [entry({ verifiedFileCount: 1 }), entry({ verifiedFileCount: 99 })],
      packageVersion: "1.1.8",
      level: "thorough",
      installedAt: noInstallTimes,
    });
    expect(out.get("nexus:29725:548408")?.verifiedFileCount).toBe(99);
  });
});

describe("the file it keeps", () => {
  const dirs: string[] = [];
  const tmp = async (): Promise<string> => {
    const d = await fsp.mkdtemp(path.join(os.tmpdir(), "eh-verify-journal-"));
    dirs.push(d);
    return d;
  };

  afterEach(async () => {
    for (const d of dirs.splice(0)) await fsp.rm(d, { recursive: true, force: true });
  });

  it("round-trips what it appends", async () => {
    const dir = await tmp();
    await appendVerifyJournal(dir, PKG, entry());
    await appendVerifyJournal(dir, PKG, entry({ compareKey: "nexus:1:2" }));
    const back = await readVerifyJournal(dir, PKG);
    expect(back.map((e) => e.compareKey)).toEqual(["nexus:29725:548408", "nexus:1:2"]);
    expect(back[0]?.verifiedFileCount).toBe(42);
  });

  it("prunes proofs from other releases as it reads", async () => {
    /**
     * The journal is cleared only when a run SUCCEEDS, so a collection whose
     * installs keep being interrupted across releases accumulates lines that
     * `reusableVerifications` will drop anyway — forever. Filtering on read
     * bounds the file and keeps the pipeline reasoning about proofs that
     * could still apply.
     */
    const dir = await tmp();
    await appendVerifyJournal(dir, PKG, entry({ packageVersion: "1.0.0" }));
    await appendVerifyJournal(
      dir,
      PKG,
      entry({ compareKey: "nexus:1:2", packageVersion: "1.0.1" }),
    );

    expect(
      (await readVerifyJournal(dir, PKG, "1.0.1")).map((e) => e.compareKey),
    ).toEqual(["nexus:1:2"]);
    // Omitted, nothing is pruned — a caller inspecting the whole journal
    // wants all of it.
    expect(await readVerifyJournal(dir, PKG)).toHaveLength(2);
  });

  it("reads the lines before a truncated tail, which is the killed run's shape", async () => {
    const dir = await tmp();
    await appendVerifyJournal(dir, PKG, entry());
    const file = path.join(dir, "event-horizon", "install-ledger", "verify", `${PKG}.jsonl`);
    await fsp.appendFile(file, '{"compareKey":"nexus:3:4","vortexMo', "utf8");
    const back = await readVerifyJournal(dir, PKG);
    expect(back).toHaveLength(1);
    expect(back[0]?.compareKey).toBe("nexus:29725:548408");
  });

  it("treats a missing journal as no proofs, not as an error", async () => {
    expect(await readVerifyJournal(await tmp(), PKG)).toEqual([]);
  });

  it("is cleared when the receipt supersedes it", async () => {
    const dir = await tmp();
    await appendVerifyJournal(dir, PKG, entry());
    await clearVerifyJournal(dir, PKG);
    expect(await readVerifyJournal(dir, PKG)).toEqual([]);
    // Clearing a journal that is already gone is the normal case on a run
    // that never verified anything.
    await expect(clearVerifyJournal(dir, PKG)).resolves.toBeUndefined();
  });

  it("never throws when the path cannot be written", async () => {
    // A journal is a convenience. An install must not fail because one could
    // not be appended to.
    await expect(
      appendVerifyJournal("\0not-a-path", PKG, entry()),
    ).resolves.toBeUndefined();
  });
});
