/**
 * ──────────────────────────────────────────────────────────────────────
 * What the ESL repair counts, and what it says about it.
 *
 * The audit found this subsystem reporting confidently wrong things in the
 * one situation it exists for. Every case below is a real defect that shipped:
 *
 *   - a package with no recorded flags, or a Data folder it cannot read,
 *     produced NO message at all — the two ways the step fails completely
 *     were reported as silence, and the install said success;
 *   - `regularAfter` skipped every plugin whose flag was not recorded, so
 *     the more flags were missing the further the count fell below the truth,
 *     and the "your game will not start" alarm was deafest exactly when the
 *     flags had been lost;
 *   - disabled plugins were counted as consuming a load-order slot, which
 *     they do not, producing that alarm for profiles that launch fine;
 *   - setting and clearing the flag were one counter, and the message
 *     asserted the set-direction meaning for both — telling a user whose
 *     flags were REMOVED that those plugins "do not use a regular
 *     load-order slot".
 *
 * The render fixture in `renderScreens.test.ts` pins the happy-path sentence
 * as a hand-written literal, which tests the rendering and not the producing.
 * This file is the other half.
 * ──────────────────────────────────────────────────────────────────────
 */
import { describe, expect, it } from "vitest";

import {
  describePluginFlagRepair,
  type PluginFlagRepair,
} from "./applyPluginLightFlags";

const repair = (over: Partial<PluginFlagRepair> = {}): PluginFlagRepair => ({
  corrected: 0,
  set: 0,
  cleared: 0,
  correctedNames: [],
  alreadyCorrect: 0,
  unknown: 0,
  missing: 0,
  unreadable: [],
  failures: [],
  regularAfter: 0,
  ...over,
});

const said = (r: PluginFlagRepair): string =>
  (describePluginFlagRepair(r) ?? []).join(" ");

describe("total failure is never reported as silence", () => {
  it("speaks up when the package recorded no flags at all", () => {
    // The exact shape of the parser bug: every entry `unknown`, nothing
    // corrected, nothing failed, regularAfter 0 — so every existing
    // condition for a notice was false and the user was told nothing.
    const lines = describePluginFlagRepair(repair({ unknown: 817 }));
    expect(lines).toBeDefined();
    expect(lines!.join(" ")).toMatch(/no esl \(light\) flag was recorded/i);
  });

  it("speaks up when none of the plugins could be read from disk", () => {
    const lines = describePluginFlagRepair(repair({ missing: 817 }));
    expect(lines).toBeDefined();
    expect(lines!.join(" ")).toMatch(/None of the 817 plugins/);
    expect(lines!.join(" ")).toMatch(/Data folder/);
  });

  it("still says nothing when everything was already correct", () => {
    // The happy path stays quiet on purpose: announcing "restored 0 flags"
    // on every install teaches people to ignore the notice.
    expect(describePluginFlagRepair(repair({ alreadyCorrect: 817 }))).toBeUndefined();
  });
});

describe("the two directions are different claims", () => {
  it("says a slot was saved only when the flag was SET", () => {
    const lines = said(repair({ corrected: 6, set: 6, alreadyCorrect: 1 }));
    expect(lines).toMatch(/Restored the collection's ESL \(light\) flag on 6/);
    expect(lines).toMatch(/do not use a regular load-order slot/);
  });

  it("never claims a saved slot when the flag was CLEARED", () => {
    // Clearing consumes a slot. The old single counter printed the
    // set-direction sentence here, which is false in both halves.
    const lines = said(
      repair({ corrected: 3, cleared: 3, alreadyCorrect: 1, regularAfter: 100 }),
    );
    expect(lines).toMatch(/Removed the ESL \(light\) flag from 3/);
    expect(lines).toMatch(/uses a regular load-order slot/);
    expect(lines).not.toMatch(/do not use a regular load-order slot/);
  });

  it("reports both when a run did some of each", () => {
    const lines = said(repair({ corrected: 5, set: 3, cleared: 2 }));
    expect(lines).toMatch(/flag on 3/);
    expect(lines).toMatch(/from 2/);
  });
});

describe("the over-limit alarm", () => {
  it("fires above the 254 regular-plugin limit", () => {
    const lines = said(repair({ regularAfter: 255, alreadyCorrect: 1 }));
    expect(lines).toMatch(/will not start/);
    expect(lines).toMatch(/255/);
  });

  it("does not fire at the limit exactly", () => {
    expect(describePluginFlagRepair(repair({ regularAfter: 254, alreadyCorrect: 1 })))
      .toBeUndefined();
  });

  it("uses the game's own limit — Starfield's is 253", () => {
    // 254 regular is fine in Skyrim SE and one over in Starfield, where the
    // medium slot takes an index. The alarm used the Skyrim number for both.
    const lines = said(repair({ regularAfter: 254, regularLimit: 253, alreadyCorrect: 1 }));
    expect(lines).toMatch(/will not start/);
    expect(lines).toMatch(/limit of 253/);
  });
});

describe("a refusal is reported with its reason", () => {
  it("says why flags were not applied when the recorded bit is not the game's", () => {
    const lines = said(
      repair({ refused: { code: "bit-mismatch", reason: "read from 0x200, Starfield uses 0x100" } }),
    );
    expect(lines).toMatch(/not applied/);
    expect(lines).toMatch(/0x200, Starfield uses 0x100/);
  });

  it("stays quiet for a game that has no light plugins to restore", () => {
    expect(
      describePluginFlagRepair(repair({ refused: { code: "no-light-plugins", reason: "none" } })),
    ).toBeUndefined();
  });
});

describe("'not on disk' and 'could not open it' are different problems", () => {
  it("tells a locked plugin apart from a missing one", () => {
    /**
     * The reader used to collapse ENOENT, EPERM and EBUSY into one
     * `undefined`, so an install run while the game or xEdit holds the
     * plugins open reported them as "not on disk here" — sending the user to
     * look for files that were sitting right there. One of these is fixed by
     * closing a program and re-running; the other is not.
     */
    const lines = said(
      repair({
        alreadyCorrect: 5,
        missing: 2,
        unreadable: ["Locked.esp: EBUSY: resource busy or locked"],
      }),
    );
    expect(lines).toMatch(/2 plugin\(s\) in the collection are not on disk/);
    expect(lines).toMatch(/1 plugin\(s\) are on disk but could not be read/);
    expect(lines).toMatch(/Close the game/);
    expect(lines).toMatch(/Locked\.esp/);
  });

  it("speaks even when unreadable is the ONLY thing that happened", () => {
    // Nothing corrected, nothing failed, nothing missing — the old notice
    // returned undefined here and the install reported plain success while
    // every flag was left unapplied.
    const lines = describePluginFlagRepair(
      repair({ alreadyCorrect: 3, unreadable: ["A.esp: EPERM"] }),
    );
    expect(lines).toBeDefined();
    expect(lines!.join(" ")).toMatch(/could not be read/);
  });

  it("counts unreadable toward 'we learned nothing at all'", () => {
    // A Data folder we cannot open ANY of is the same total failure as one
    // where nothing exists, and must not be silent either.
    const lines = describePluginFlagRepair(
      repair({ unreadable: ["A.esp: EPERM", "B.esp: EPERM"] }),
    );
    expect(lines).toBeDefined();
    expect(lines!.join(" ")).toMatch(/None of the 2 plugins|could not be read/);
  });
});
