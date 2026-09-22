/**
 * The one build finding that is not advisory.
 *
 * Everything else the self-check reports is a lead: worth a look, harmless to
 * ignore. This one says a mod WILL fail on every machine that installs it —
 * the staging holds files the archive cannot produce, so the user's install
 * can never match, and the driver's one reinstall attempt reproduces the same
 * archive and the same failure.
 *
 * It therefore names mods instead of counting them. A curator has to go and do
 * something about each one, and "25 mods diverged" does not tell them which.
 */
import { describe, expect, it } from "vitest";

import { describeUndeclaredPostProcessing } from "./runSelfChecks";
import type { SelfCheckReport } from "./selfCheckMod";

/** "These mods were answered, with no fingerprint recorded." */
const answered = (
  ids: string[],
): ReadonlyMap<string, { choice: "declare"; fingerprint?: string }> =>
  new Map(ids.map((id) => [id, { choice: "declare" as const }] as const));

const report = (
  modName: string,
  unexplained: number,
  modId = modName,
): SelfCheckReport =>
  ({
    modId,
    modName,
    depth: "replayed",
    notes: [],
    missing: [],
    unexplained,
    omissionLeads: [],
  }) as unknown as SelfCheckReport;

const none = answered([]);

describe("naming the mods that cannot verify", () => {
  it("says nothing when every mod is reproducible", () => {
    expect(
      describeUndeclaredPostProcessing([report("Clean", 0)], none),
    ).toBeUndefined();
  });

  it("names the worst offenders rather than only counting them", () => {
    const text = describeUndeclaredPostProcessing(
      [report("xlodgen-output", 1608), report("Pandora_sd", 817)],
      none,
    )!;
    expect(text).toContain("xlodgen-output");
    expect(text).toContain("1608");
    expect(text).toContain("2 mod(s)");
  });

  it("orders by how much of the mod is unreproducible", () => {
    const text = describeUndeclaredPostProcessing(
      [report("Small", 2), report("Huge", 900)],
      none,
    )!;
    expect(text.indexOf("Huge")).toBeLessThan(text.indexOf("Small"));
  });

  it("drops a mod once the curator declares it", () => {
    // The whole point of declaring. A curator who has answered must stop being
    // asked, or the warning becomes noise they learn to scroll past.
    const reports = [report("xlodgen", 1608, "mod-1")];
    expect(
      describeUndeclaredPostProcessing(reports, answered(["mod-1"])),
    ).toBeUndefined();
  });

  it("keeps warning about the ones still undeclared", () => {
    const text = describeUndeclaredPostProcessing(
      [report("Declared", 5, "mod-1"), report("Forgotten", 7, "mod-2")],
      answered(["mod-1"]),
    )!;
    expect(text).toContain("Forgotten");
    expect(text).not.toContain("Declared");
    expect(text).toContain("1 mod(s)");
  });

  it("states both remedies, because they are not equivalent", () => {
    // Declaring keeps the archive as the source and drops the curator's extra
    // files; bundling ships those files instead. A curator choosing between
    // them needs to know both exist.
    const text = describeUndeclaredPostProcessing([report("X", 3)], none)!;
    expect(text).toMatch(/postProcessed/);
    expect(text).toMatch(/bundled/i);
  });

  it("says what happens if they do neither", () => {
    const text = describeUndeclaredPostProcessing([report("X", 3)], none)!;
    expect(text).toMatch(/recorded as broken/i);
  });
});

/**
 * ──────────────────────────────────────────────────────────────────────
 * ONE SCREEN SUPERSEDED THE OTHER'S ADVICE.
 *
 * Since the decision gate landed, these same mods are shown as cards with
 * mirror / bundle / declare / drop — computed from the same `isSettled`
 * predicate this warning uses, so it fires on exactly the population the gate
 * just asked about. The curator answered on the gate and was then told, in the
 * build summary, to go and hand-edit a config file.
 *
 * Not merely redundant. A hand-written `postProcessed` carries no fingerprint,
 * and `isSettled` reads a missing one as "answered before fingerprints
 * existed" and honours it forever — so following the stale advice silences the
 * question permanently.
 * ──────────────────────────────────────────────────────────────────────
 */
describe("the advice matches the door the curator is standing at", () => {
  it("points at the decisions screen when this build asks", () => {
    const text = describeUndeclaredPostProcessing([report("X", 3)], none, true)!;
    expect(text).toContain("decisions screen");
    expect(text).not.toContain("postProcessed");
  });

  it("keeps the config instructions for a caller that does NOT ask", () => {
    // The render harness passes no handler, and for it editing the config
    // really is the only way through.
    const text = describeUndeclaredPostProcessing([report("X", 3)], none, false)!;
    expect(text).toContain('"postProcessed": true');
    expect(text).not.toContain("decisions screen");
  });

  it("still leads with the consequence either way", () => {
    // The wording that changes is the REMEDY, not the finding.
    for (const asks of [true, false]) {
      const text = describeUndeclaredPostProcessing([report("X", 3)], none, asks)!;
      expect(text).toContain("recorded as broken");
    }
  });
});
