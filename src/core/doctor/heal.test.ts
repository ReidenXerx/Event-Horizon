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
  healNeedsManifest,
  matchEhcollFile,
  rebuildPluginOrder,
} from "./heal";
import type { HealAction } from "./health";

const ALL: HealAction[] = [
  "reinstall-mods",
  "enable-mods",
  "reapply-rules",
  "reapply-userlist",
  "repin-plugin-order",
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

describe("describeHeal", () => {
  it("describes every action", () => {
    for (const a of ALL) {
      const d = describeHeal(a);
      expect(d.title.length).toBeGreaterThan(0);
      expect(d.body.length).toBeGreaterThan(0);
      expect(d.confirm.length).toBeGreaterThan(0);
    }
  });

  it("warns that re-applying rules destroys the user's own", () => {
    // It replaces rather than merges — the collection's mandate. Someone who
    // spent an evening on their own conflict rules deserves to know before,
    // not after.
    expect(describeHeal("reapply-rules").body.toLowerCase()).toContain(
      "will be lost",
    );
    expect(describeHeal("reapply-userlist").body.toLowerCase()).toContain(
      "will be lost",
    );
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

describe("rebuildPluginOrder", () => {
  const current = [
    { name: "B.esp", enabled: true },
    { name: "A.esp", enabled: false },
    { name: "C.esp", enabled: true },
  ];

  it("restores the recorded order", () => {
    const out = rebuildPluginOrder(["A.esp", "B.esp", "C.esp"], current);
    expect(out.map((p) => p.name)).toEqual(["A.esp", "B.esp", "C.esp"]);
  });

  it("keeps each plugin's CURRENT enabled state, not a guess", () => {
    // The whole point. Enablement is a separate check with its own cure; a
    // repair that silently re-enables A.esp while claiming to fix ordering is
    // the surprise that makes people stop trusting heal buttons.
    const out = rebuildPluginOrder(["A.esp", "B.esp", "C.esp"], current);
    expect(out.find((p) => p.name === "A.esp")?.enabled).toBe(false);
    expect(out.find((p) => p.name === "B.esp")?.enabled).toBe(true);
  });

  it("matches case-insensitively, because plugins.txt casing is not stable", () => {
    // A case-sensitive lookup finds nothing and disables every plugin — the
    // single most destructive way this function could be wrong.
    const out = rebuildPluginOrder(["a.ESP", "b.esp"], [
      { name: "A.esp", enabled: true },
      { name: "B.ESP", enabled: true },
    ]);
    expect(out.every((p) => p.enabled)).toBe(true);
  });

  it("keeps plugins the user added, at the end", () => {
    // Dropping a plugin from plugins.txt is how you disable it. A repair that
    // quietly removes someone's own plugin is not a repair.
    const out = rebuildPluginOrder(["A.esp"], [
      { name: "A.esp", enabled: true },
      { name: "Mine.esp", enabled: true },
    ]);
    expect(out.map((p) => p.name)).toEqual(["A.esp", "Mine.esp"]);
    expect(out[1]!.enabled).toBe(true);
  });

  it("does not claim a plugin is enabled when it is not there at all", () => {
    // Asking Vortex to enable a plugin that does not exist is a different
    // failure from restoring an order.
    const out = rebuildPluginOrder(["Gone.esp"], []);
    expect(out).toEqual([{ name: "Gone.esp", enabled: false }]);
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
