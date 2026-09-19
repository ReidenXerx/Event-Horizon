/**
 * ──────────────────────────────────────────────────────────────────────
 * "This mod was installed from a file that is not the collection's" has to
 * outlive the run that discovered it.
 *
 * `suppliedArchiveMismatches` is filled only by the pick path, so on an
 * update — where an external mod whose identity has not changed resolves as
 * already-installed and nobody is asked for a file — the map is empty for it
 * and the new receipt replaced the old one WITHOUT the field. The fact
 * survived exactly one run, while the field's own comment promises that its
 * consequence outlives the run and the player will not remember it.
 *
 * Everything downstream went quiet with it: the Doctor's log bundle stopped
 * listing the mod, and the mirror lost the sentence connecting "these files
 * fail every update" to the download the player chose once, months ago.
 *
 * A source test because `buildReceipt` takes a DriverContext and half the
 * installer with it; the rule is three lines and each clause is the part that
 * can go wrong.
 * ──────────────────────────────────────────────────────────────────────
 */
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const src = (): string =>
  readFileSync(new URL("./runInstall.ts", import.meta.url), "utf8");

describe("a supplied-archive mismatch is carried across runs", () => {
  const helper = (): string => {
    const body = src();
    const at = body.indexOf("const suppliedArchiveFor = (");
    expect(at, "the carry-forward helper must exist").toBeGreaterThan(-1);
    return body.slice(at, at + 700);
  };

  it("prefers THIS run's answer when the player was asked again", () => {
    // A re-pick is the current truth, including a re-pick that matched: the
    // absence of a mismatch this run means they found the right file.
    expect(helper()).toContain(
      "const thisRun = args.suppliedArchiveMismatches?.get(m.compareKey);",
    );
    expect(helper()).toContain("if (thisRun !== undefined) return thisRun;");
  });

  it("carries the previous one ONLY for a mod this run did not install", () => {
    expect(helper()).toContain(
      'if (!m.fromDecision.endsWith("already-installed")) return undefined;',
    );
    expect(helper()).toContain("return previousSupplied.get(m.compareKey);");
  });

  it("builds the carry-forward map from the previous receipt's entries", () => {
    const body = src();
    expect(body).toContain("const previousSupplied = new Map(");
    expect(body).toContain("previousMods: previousReceiptMods,");
  });

  it("no longer writes the field straight from this run's map alone", () => {
    // The shape of the bug: one lookup, no notion of whether the question was
    // re-asked, so an update always dropped it.
    expect(src()).not.toContain(
      "...(args.suppliedArchiveMismatches?.get(m.compareKey) !== undefined",
    );
  });
});
