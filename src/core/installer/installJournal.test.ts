/**
 * The journal answers one question — "did WE put this mod here?" — and the
 * repair path deletes mods based on the answer, so every way it can be wrong
 * matters more than usual.
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  appendJournalEntry,
  clearJournal,
  getJournalDir,
  ownedModIds,
  readJournal,
} from "./installJournal";

const PKG = "00000000-0000-4000-8000-000000000000";

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "eh-journal-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const entry = (over: Record<string, unknown> = {}) => ({
  compareKey: "nexus:116422:576517",
  vortexModId: "mod-1",
  decision: "nexus-download",
  at: "2026-09-07T12:00:00Z",
  ...over,
});

describe("appendJournalEntry / readJournal", () => {
  it("records what a run installed, in order", async () => {
    await appendJournalEntry(dir, PKG, entry());
    await appendJournalEntry(dir, PKG, entry({ vortexModId: "mod-2" }));

    const journal = await readJournal(dir, PKG);
    expect(journal.map((e) => e.vortexModId)).toEqual(["mod-1", "mod-2"]);
  });

  it("survives the run being killed mid-write", async () => {
    /**
     * The whole reason this is JSONL. A run is killed at an arbitrary moment,
     * so the last line is routinely a half-written record — and that is
     * precisely the run whose earlier lines are worth having. A parser that
     * threw on the tail would discard everything the run did.
     */
    await appendJournalEntry(dir, PKG, entry());
    await appendJournalEntry(dir, PKG, entry({ vortexModId: "mod-2" }));
    const file = path.join(getJournalDir(dir), `${PKG}.jsonl`);
    fs.appendFileSync(file, '{"compareKey":"nexus:1:2","vortexMo');

    const journal = await readJournal(dir, PKG);
    expect(journal.map((e) => e.vortexModId)).toEqual(["mod-1", "mod-2"]);
  });

  it("skips a record with no mod id rather than trusting a blank", async () => {
    // A blank id would match nothing, but an entry that PARSES and carries
    // `undefined` could sail into ownedModIds and be compared against a set.
    const file = path.join(getJournalDir(dir), `${PKG}.jsonl`);
    fs.mkdirSync(getJournalDir(dir), { recursive: true });
    fs.writeFileSync(file, '{"compareKey":"nexus:1:2"}\n');

    expect(await readJournal(dir, PKG)).toEqual([]);
  });

  it("is empty, not an error, when no run has written one", async () => {
    // The normal case: a first install, or one that finished and cleared it.
    expect(await readJournal(dir, PKG)).toEqual([]);
  });

  it("keeps collections apart", async () => {
    await appendJournalEntry(dir, PKG, entry());
    expect(await readJournal(dir, "11111111-1111-4111-8111-111111111111"))
      .toEqual([]);
  });

  it("is cleared when the receipt takes over", async () => {
    await appendJournalEntry(dir, PKG, entry());
    await clearJournal(dir, PKG);
    expect(await readJournal(dir, PKG)).toEqual([]);
  });

  it("clearing one that was never written is not an error", async () => {
    await expect(clearJournal(dir, PKG)).resolves.toBeUndefined();
  });
});

describe("ownedModIds", () => {
  it("returns the mods we installed that are still there", () => {
    expect(
      ownedModIds(
        [entry(), entry({ vortexModId: "mod-2" })],
        new Set(["mod-1", "mod-2", "someone-elses"]),
      ),
    ).toEqual(new Set(["mod-1", "mod-2"]));
  });

  it("DROPS a mod the user has deleted since we recorded it", () => {
    /**
     * The load-bearing case. Vortex reuses nothing about a removed mod's id,
     * but the journal is a record of a past action, not a promise the mod is
     * still there. Reporting a deleted mod as ours would let the repair path
     * uninstall whatever holds that id now, which is the exact class of harm
     * the journal was added to prevent.
     */
    expect(ownedModIds([entry()], new Set(["a-different-mod"]))).toEqual(
      new Set(),
    );
  });

  it("owns nothing when the journal is empty", () => {
    expect(ownedModIds([], new Set(["mod-1"]))).toEqual(new Set());
  });
});
