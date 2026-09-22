/**
 * What each cure needs, and what it must not touch.
 *
 * Every one of these writes to a machine with 900 mods on it, so the failure
 * mode that matters is not "the button errored" — it is "the button worked and
 * changed something else too".
 */
import { describe, expect, it } from "vitest";

import { buildOutputFileName } from "../manifest/packageFileName";
import {
  describeHeal,
  healNeedsConfirmation,
  healNeedsManifest,
  matchEhcollFile,} from "./heal";
import type { HealAction } from "./health";

/**
 * Every action in the union. `restore-light-flags` was missing here while the
 * union had it, which quietly excused it from both checks below — the exact
 * hole those checks exist to close.
 */
const ALL: HealAction[] = [
  "reinstall-mods",
  "enable-mods",
  "reapply-rules",
  "reapply-userlist",
  "repin-plugin-order",
  "restore-light-flags",
  "switch-profile",
];

describe("healNeedsManifest", () => {
  it("splits the six cures the way the data actually splits", () => {
    // The receipt records the profile, the mod ids and the plugin order, so
    // those three repair from it alone. The other three re-run pipeline steps
    // that read the manifest, which lives in the .ehcoll.
    expect(ALL.filter((a) => !healNeedsManifest(a)).sort()).toEqual([
      "enable-mods",
      "repin-plugin-order",
      // The receipt carries each plugin's name and the curator's flag, so this
      // one needs no manifest either — it was simply missing from this list
      // while the union already had it.
      "restore-light-flags",
      "switch-profile",
    ]);
    expect(ALL.filter(healNeedsManifest).sort()).toEqual([
      "reapply-rules",
      "reapply-userlist",
      "reinstall-mods",
    ]);
  });

  it("answers for every action", () => {
    // A missing case returns undefined, which is falsy, which would silently
    // offer a manifest-backed repair with no manifest.
    for (const a of ALL) expect(typeof healNeedsManifest(a)).toBe("boolean");
  });
});

describe("healNeedsConfirmation", () => {
  it("asks only for the cures that take something away", () => {
    /**
     * Owner poll, 2026-09-18: a player looking at "your load order is wrong"
     * should fix it with ONE press. A dialog in front of a reversible repair
     * protects nothing and reads as the tool hesitating.
     *
     * The rule is unchanged; which cures it selects was corrected once each
     * cure was measured against what it actually does:
     *
     *  - `reapply-rules` / `reapply-userlist` do NOT replace what the player
     *    set. `applyModRules` removes only a user rule on the same source mod
     *    pointing at the same target — which it then re-adds as the
     *    collection's — and `applyUserlist` clears nothing whatsoever. Both
     *    are repeatable, so both stopped asking.
     *  - `restore-light-flags` writes bytes into plugin files in the game
     *    folder and `HealAction` has no inverse for it. It asks.
     */
    expect(ALL.filter((a) => !healNeedsConfirmation(a)).sort()).toEqual([
      "enable-mods",
      "reapply-rules",
      "reapply-userlist",
      "repin-plugin-order",
      "switch-profile",
    ]);
    expect(ALL.filter(healNeedsConfirmation).sort()).toEqual([
      "reinstall-mods",
      "restore-light-flags",
    ]);
  });

  it("answers for every action", () => {
    // Same trap as above, opposite direction: a missing case is falsy, which
    // would run a destructive repair with no question asked.
    for (const a of ALL) expect(typeof healNeedsConfirmation(a)).toBe("boolean");
  });

  it("still describes every cure, including the ones that no longer ask", () => {
    // The body text is what a card can show under the button; only the dialog
    // went away.
    for (const a of ALL) {
      const d = describeHeal(a);
      expect(d.title.length).toBeGreaterThan(0);
      expect(d.body.length).toBeGreaterThan(0);
      expect(d.confirm.length).toBeGreaterThan(0);
    }
  });
});

describe("describeHeal", () => {
  it("describes every action", () => {
    for (const a of ALL) {
      const d = describeHeal(a);
      expect(d.title.length).toBeGreaterThan(0);
      expect(d.body.length).toBeGreaterThan(0);
      expect(d.confirm.length).toBeGreaterThan(0);
    }
  });

  it("scopes the rule replacement to what actually gets replaced", () => {
    /**
     * These two said "rules you added yourself will be lost", and neither
     * cure does that: `applyModRules` removes a user rule only when it sits on
     * the same source mod AND references the same target as the collection's,
     * and `applyUserlist` removes nothing at all. Overstating destruction is
     * not the safe direction — it scares a player off a cheap, repeatable
     * repair, and it was the stated premise for a confirmation dialog that
     * therefore should not have existed.
     */
    const rules = describeHeal("reapply-rules").body.toLowerCase();
    expect(rules).not.toContain("will be lost");
    expect(rules).toContain("contradicts");

    const userlist = describeHeal("reapply-userlist").body.toLowerCase();
    expect(userlist).not.toContain("will be lost");
    expect(userlist).toContain("nothing already in your userlist is removed");
  });

  it("warns that reinstalling restores the curator's installer answers", () => {
    // The receipt/manifest asymmetry, at the exact moment it bites: a user who
    // deliberately answered a FOMOD differently loses that here.
    expect(describeHeal("reinstall-mods").body.toLowerCase()).toContain(
      "installer answers",
    );
  });

  it("promises that repinning does not touch what is enabled", () => {
    expect(describeHeal("repin-plugin-order").body.toLowerCase()).toContain(
      "enabled is left exactly as it is",
    );
  });

  it("says plainly that switching profiles installs nothing", () => {
    // The least destructive of the six, and it should not read like the rest.
    const body = describeHeal("switch-profile").body.toLowerCase();
    expect(body).toContain("nothing is installed or removed");
    expect(body).not.toContain("will be lost");
  });
});

describe("matchEhcollFile", () => {
  // Built with the packager's own function so the test cannot drift from the
  // thing it is describing.
  const real = buildOutputFileName("Ivy 2", "1.0.9");

  it("finds the package the packager would have written", () => {
    expect(real).toBe("ivy-2-1.0.9.ehcoll");
    expect(matchEhcollFile([real, "other-1.0.0.ehcoll"], "Ivy 2", "1.0.9")).toBe(
      real,
    );
  });

  it("matches the version EXACTLY", () => {
    // Healing from a different release applies rules and answers the user
    // never installed — worse than asking them to point at the file.
    const files = ["ivy-2-1.0.8.ehcoll", "ivy-2-1.0.10.ehcoll"];
    expect(matchEhcollFile(files, "Ivy 2", "1.0.9")).toBeUndefined();
  });

  it("survives a slug that no longer matches, when it is unambiguous", () => {
    expect(
      matchEhcollFile(["renamed-collection-1.0.9.ehcoll"], "Ivy 2", "1.0.9"),
    ).toBe("renamed-collection-1.0.9.ehcoll");
  });

  it("refuses to guess between two candidates", () => {
    // Two packages carrying the same version is exactly when picking one is
    // most tempting and least defensible.
    expect(
      matchEhcollFile(["a-1.0.9.ehcoll", "b-1.0.9.ehcoll"], "Ivy 2", "1.0.9"),
    ).toBeUndefined();
  });

  it("is case-insensitive about the filename", () => {
    expect(matchEhcollFile(["IVY-2-1.0.9.EHCOLL"], "Ivy 2", "1.0.9")).toBe(
      "IVY-2-1.0.9.EHCOLL",
    );
  });

  it("finds nothing in an empty directory rather than throwing", () => {
    expect(matchEhcollFile([], "Ivy 2", "1.0.9")).toBeUndefined();
  });

  it("finds the package under the .zip name a Nexus page serves, and prefers the packager's own name", () => {
    // Nexus quarantines files named .ehcoll, so the package a user took from
    // a collection's page is a .zip with the same bytes.
    const zipped = real.replace(/\.ehcoll$/, ".zip");
    expect(matchEhcollFile(["other-1.0.0.zip", zipped], "Ivy 2", "1.0.9")).toBe(zipped);
    expect(matchEhcollFile([zipped, real], "Ivy 2", "1.0.9")).toBe(real);
    expect(matchEhcollFile([zipped, "other-1.0.9.ehcoll"], "Ivy 2", "1.0.9")).toBe(zipped);
    expect(matchEhcollFile(["renamed-collection-1.0.9.zip"], "Ivy 2", "1.0.9")).toBe("renamed-collection-1.0.9.zip");
    expect(matchEhcollFile(["a-1.0.9.zip", "b-1.0.9.ehcoll"], "Ivy 2", "1.0.9")).toBeUndefined();
  });
});

describe("restoring ESL flags", () => {
  it("does NOT need the .ehcoll", () => {
    /**
     * The point of offering it. The receipt carries each plugin's name and
     * the curator's flag, so the repair needs nothing else — and the user who
     * needs this is the one whose game stopped starting, who may no longer
     * have the package to hand. Requiring the manifest would hide the button
     * from exactly them.
     */
    expect(healNeedsManifest("restore-light-flags")).toBe(false);
  });

  it("warns about locked files before doing it, not after", () => {
    // A plugin another program holds open cannot be rewritten, and that is
    // the commonest reason this heal half-fails. Saying it in the
    // confirmation costs nothing; saying it afterwards costs a re-run.
    const d = describeHeal("restore-light-flags");
    expect(d.title).toMatch(/ESL/);
    expect(d.body).toMatch(/xEdit|LOOT/);
    expect(d.body).toMatch(/254/);
    expect(d.confirm).toMatch(/Restore/);
  });

  it("says no mod content changes, because none does", () => {
    // It rewrites one header bit. A user agreeing to a "repair" deserves to
    // know it is not a reinstall.
    expect(describeHeal("restore-light-flags").body).toMatch(
      /Nothing is reinstalled/,
    );
  });
});
