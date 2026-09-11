/**
 * The Done screen's COMPOSITION — what the user sees first, and whether
 * anything defined here reaches them at all.
 *
 * This screen accumulated eight notice cards, one per feature, each added by
 * someone who cared about their own. Flat, visually identical, and ordered by
 * the order the driver happened to produce them — so "your download is
 * corrupted, replace it" rendered below "the collection wrote your INI
 * settings" and looked exactly like it. Eight equal cards is eight cards
 * nobody triages.
 *
 * Source assertions because rendering this needs a live Vortex, which is the
 * same reason the ordering was never noticed.
 */
import * as fs from "fs";
import * as path from "path";

import { describe, expect, it } from "vitest";

import { reconcileMods } from "./steps";

const steps = (): string =>
  fs.readFileSync(path.join(__dirname, "steps.tsx"), "utf8");

describe("every mod is accounted for, or the screen says it is not", () => {
  // Six independent counters that do not visibly add up read as a UI hiding
  // something — and on the real run they genuinely did not: a 963-mod
  // collection reported "installed 958, skipped 1", leaving four mods the
  // reader could only find by subtracting and never learn the fate of.
  it("balances when everything is accounted for", () => {
    const r = reconcileMods({ total: 963, installed: 900, carried: 60, skipped: 3 });
    expect(r.accounted).toBe(963);
    expect(r.missing).toBe(0);
    expect(r.parts).toBe("900 installed + 60 already had + 3 skipped");
  });

  it("reports mods that are unaccounted for", () => {
    const r = reconcileMods({ total: 963, installed: 958, carried: 0, skipped: 1 });
    expect(r.missing).toBe(4);
  });

  it("reports DOUBLE-COUNTING as a negative rather than clamping it", () => {
    // Clamping to zero would turn a broken tally into a clean one, which is
    // the same class of lie as the gap it replaces.
    const r = reconcileMods({ total: 10, installed: 8, carried: 3, skipped: 1 });
    expect(r.missing).toBe(-2);
  });

  it("names only the buckets that have anything in them", () => {
    // "958 installed + 0 already had + 0 skipped" invites the reader to check
    // arithmetic that was never in question.
    expect(
      reconcileMods({ total: 5, installed: 5, carried: 0, skipped: 0 }).parts,
    ).toBe("5 installed");
  });
});

describe("nothing defined here is invisible", () => {
  it("every *Notice component is actually rendered", () => {
    // THE recurring bug in this codebase, generalised into a guard. Five
    // separate features shipped as correct code that nothing called, and two
    // of them were notices built and then rendered by nobody: the value is
    // computed, the component exists, the type checks, and the user is never
    // told. A per-notice test catches it only for the notices someone
    // remembered to write a test for — this catches the next one too.
    const src = steps();
    const declared = [...src.matchAll(/^function (\w+Notice)\(/gm)].map(
      (m) => m[1],
    );
    expect(declared.length).toBeGreaterThan(4); // the file really does define them

    const orphans = declared.filter(
      (name) => !new RegExp(`<${name}[\\s/>]`).test(src),
    );
    expect(orphans, `defined but never rendered: ${orphans.join(", ")}`).toEqual(
      [],
    );
  });
});

describe("what needs the user comes before what merely informs them", () => {
  const positionOf = (src: string, tag: string): number => {
    const at = src.indexOf(`<${tag}`);
    expect(at, `${tag} is not rendered at all`).toBeGreaterThan(-1);
    return at;
  };

  it("puts every action notice above the folded notes", () => {
    // A corrupted download the user can fix, files in the wrong folder that
    // may not load, a load order that differs, mods that changed under them,
    // and a report worth sending — none of these belong below a disclosure
    // about INI tweaks.
    const src = steps();
    const notes = positionOf(src, "InstallNotes");
    for (const tag of [
      "DamagedArchiveNotice",
      "ModTypeNotice",
      "PluginOrderNotice",
      "StagingDriftNotice",
      "CuratorReportsNotice",
    ]) {
      expect(positionOf(src, tag), `${tag} renders below the notes`).toBeLessThan(
        notes,
      );
    }
  });

  it("leads with the broken download and ends with the report to send", () => {
    // Ordered by consequence: what the user can fix right now first, and the
    // one whose payoff is someone else's last.
    const src = steps();
    const damaged = positionOf(src, "DamagedArchiveNotice");
    for (const tag of [
      "ModTypeNotice",
      "PluginOrderNotice",
      "StagingDriftNotice",
      "CuratorReportsNotice",
    ]) {
      expect(damaged).toBeLessThan(positionOf(src, tag));
    }
    const report = positionOf(src, "CuratorReportsNotice");
    for (const tag of ["ModTypeNotice", "PluginOrderNotice", "StagingDriftNotice"]) {
      expect(report).toBeGreaterThan(positionOf(src, tag));
    }
  });
});

describe("folding without hiding", () => {
  it("names each folded note in the summary rather than only counting them", () => {
    // "3 notes" makes the user open it to find out whether it matters, which
    // is exactly the cost folding was supposed to save. Naming them lets the
    // fold stay shut.
    const src = steps();
    const fn = src.slice(src.indexOf("function InstallNotes"));
    const body = fn.slice(0, fn.indexOf("\nfunction "));
    expect(body).toMatch(/present\.map\(\(p\) => p\.label\)\.join\(", "\)/);
    for (const label of ["INI tweaks", "game settings", "files you supplied"]) {
      expect(body).toContain(label);
    }
  });

  it("renders nothing at all when there are no notes", () => {
    // An empty disclosure on a clean install is scaffolding pretending to be
    // information.
    const src = steps();
    const fn = src.slice(src.indexOf("function InstallNotes"));
    expect(fn.slice(0, fn.indexOf("\nfunction "))).toMatch(
      /present\.length === 0\) return null/,
    );
  });

  it("folds a notice's own detail lines once they stop being a glance", () => {
    // A drifted-mod list runs to eleven lines and a curator report to a
    // paragraph. Several of those expanded at once is the wall this screen
    // was.
    const src = steps();
    expect(src).toMatch(/const INLINE_LINE_LIMIT = \d/);
    const fn = src.slice(src.indexOf("function NoticeLines"));
    const body = fn.slice(0, fn.indexOf("\nfunction "));
    expect(body).toMatch(/lines\.length <= INLINE_LINE_LIMIT\) return body/);
    // The behaviour is the fold, not the tag's exact spelling: the element
    // gained a class when the disclosure was styled once for the whole UI.
    expect(body).toMatch(/<details[ >]/);
  });
});
