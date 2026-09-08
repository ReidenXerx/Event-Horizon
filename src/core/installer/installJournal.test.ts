/**
 * The journal answers one question — "did WE put this mod here?" — and the
 * repair path deletes mods based on the answer, so every way it can be wrong
 * matters more than usual.
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as vortexApi from "@nexusmods/vortex-api";

import {
  appendJournalEntry,
  clearJournal,
  getJournalDir,
  logJournalSummary,
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

const entry = (over: Record<string, unknown> = {}) =>
  ({
    compareKey: "nexus:116422:576517",
    vortexModId: "mod-1",
    kind: "installed",
    decision: "nexus-download",
    at: "2026-09-07T12:00:00Z",
    ...over,
  }) as import("./installJournal").JournalEntry;

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

  it("does NOT own a mod it merely adopted", () => {
    /**
     * The safety property. An adopted mod matched the curator's bytes when we
     * looked, so we used the user's copy instead of installing a second one —
     * but it is still THEIRS. Byte-identical today is an edited mod next
     * month, and ownership here authorises an uninstall.
     */
    expect(
      ownedModIds([entry({ kind: "adopted" })], new Set(["mod-1"])),
    ).toEqual(new Set());
  });

  it("treats a record with an unreadable kind as adopted", () => {
    // The reading that withholds deletion rights. A record we cannot parse is
    // exactly the one not to act destructively on.
    expect(
      ownedModIds([entry({ kind: "something-new" })], new Set(["mod-1"])),
    ).toEqual(new Set());
  });
});

describe("logJournalSummary", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(vortexApi, "log").mockImplementation(() => undefined);
    // Re-spying an already-spied method hands back the SAME spy with its call
    // history, so without this a later test reads an earlier test's line.
    logSpy.mockClear();
  });

  /** The payload of the one `install.journal.read` line this call produced. */
  const summary = (): Record<string, unknown> => {
    const call = logSpy.mock.calls.find(
      (c) => c[1] === "[Event Horizon] install.journal.read",
    );
    expect(call).toBeDefined();
    return call![2] as Record<string, unknown>;
  };

  it("does not count ADOPTED mods as deleted", () => {
    /**
     * The shape of a real run: 1 mod we installed, 3 we merely recognised, and
     * every one of them still present. The old arithmetic subtracted an
     * installed-only set from the full journal length and reported the three
     * adopted mods as `goneSinceRecorded: 3` — "the user deleted three mods" —
     * about a machine where nothing had been deleted at all.
     */
    const journal = [
      entry({ vortexModId: "ours-1", kind: "installed" }),
      entry({ vortexModId: "theirs-1", kind: "adopted" }),
      entry({ vortexModId: "theirs-2", kind: "adopted" }),
      entry({ vortexModId: "theirs-3", kind: "adopted" }),
    ];
    const live = new Set(["ours-1", "theirs-1", "theirs-2", "theirs-3"]);

    logJournalSummary(PKG, journal, live);

    expect(summary()).toMatchObject({
      entries: 4,
      installedByUs: 1,
      installedStillPresent: 1,
      installedGone: 0,
      adopted: 3,
      adoptedStillPresent: 3,
      adoptedGone: 0,
    });
  });

  it("counts a mod WE installed that has since disappeared", () => {
    // The case the number exists for, and the only one that changes what a
    // resume may do: our own mod is gone, so its repair right is gone with it.
    const journal = [
      entry({ vortexModId: "ours-1", kind: "installed" }),
      entry({ vortexModId: "ours-2", kind: "installed" }),
      entry({ vortexModId: "theirs-1", kind: "adopted" }),
    ];

    logJournalSummary(PKG, journal, new Set(["ours-1", "theirs-1"]));

    expect(summary()).toMatchObject({
      installedByUs: 2,
      installedStillPresent: 1,
      installedGone: 1,
      adopted: 1,
      adoptedStillPresent: 1,
      adoptedGone: 0,
    });
  });

  it("reports an adopted mod that vanished separately, not as one of ours", () => {
    logJournalSummary(
      PKG,
      [
        entry({ vortexModId: "ours-1", kind: "installed" }),
        entry({ vortexModId: "theirs-1", kind: "adopted" }),
      ],
      new Set(["ours-1"]),
    );

    const s = summary();
    expect(s).toMatchObject({ adoptedGone: 1, installedGone: 0 });
    // The two must never be summed into one figure: only ours carries a
    // consequence, and a combined number cannot be acted on.
    expect(s.installedGone).not.toBe(s.adoptedGone);
  });
});
