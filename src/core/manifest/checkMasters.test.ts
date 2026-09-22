/**
 * The check that would have caught a broken collection before it shipped.
 *
 * A tester's game refused to start: "MEI - Patch - RaceCompatibility.esp
 * depends on RaceCompatibility.esm". Measured on the real 1,755-mod manifest,
 * `RaceCompatibility.esm` is provided by zero mods and appears nowhere in the
 * 1,607-entry plugin order, while two plugins requiring it ship enabled. It
 * worked on the curator's machine because they had the master from outside the
 * collection's scope.
 */
import { describe, expect, it } from "vitest";

import {
  checkMasters,
  describeMissingMasters,
  describeUserOwnedMasters,
  type PluginWithMasters,
} from "./checkMasters";

const p = (
  name: string,
  masters: string[] | undefined,
  enabled = true,
): PluginWithMasters => ({ name, enabled, masters });

describe("the RaceCompatibility case, exactly as it shipped", () => {
  it("catches a master no plugin in the collection provides", () => {
    const check = checkMasters(
      [
        p("Skyrim.esm", []),
        p("MEI - Patch - RaceCompatibility.esp", [
          "Skyrim.esm",
          "RaceCompatibility.esm",
        ]),
        p("AX ValSerano-RaceCompatibility.esp", [
          "Skyrim.esm",
          "RaceCompatibility.esm",
        ]),
      ],
      "skyrimse",
    );
    expect(check.missing).toHaveLength(2);
    expect(check.missing.map((m) => m.master)).toEqual([
      "RaceCompatibility.esm",
      "RaceCompatibility.esm",
    ]);
  });

  /**
   * ─── AND THE HALF THE FIXTURE ABOVE CANNOT REACH ──────────────────────
   * That fixture leaves the master out of the plugin list entirely, which is
   * the case that cannot fail (GP-4) — and NOT what the header describes. The
   * quoted scar is "it worked on the curator's machine because they had the
   * master from outside the collection's scope", i.e. the master IS in their
   * plugins.txt, enabled, and no mod in the collection ships it.
   *
   * `available` was built from that plugin list, so the gate found it and said
   * nothing. The caller passes the curator's WHOLE PROFILE, so this was the
   * live shape, not a corner of it.
   */
  it("catches a master the curator has enabled but the package does not ship", () => {
    const plugins = [
      p("Skyrim.esm", []),
      // Present and enabled in the curator's profile — and shipped by nothing.
      p("RaceCompatibility.esm", ["Skyrim.esm"]),
      p("MEI - Patch - RaceCompatibility.esp", [
        "Skyrim.esm",
        "RaceCompatibility.esm",
      ]),
    ];

    // What the gate did before it was told what the package provides.
    expect(checkMasters(plugins, "skyrimse").missing).toHaveLength(0);

    // The package ships the patch, not the master.
    const provided = new Set(["skyrim.esm", "mei - patch - racecompatibility.esp"]);
    const check = checkMasters(plugins, "skyrimse", provided);
    expect(check.missing).toEqual([
      {
        plugin: "MEI - Patch - RaceCompatibility.esp",
        master: "RaceCompatibility.esm",
      },
    ]);
  });

  it("still says nothing when the package really does ship the master", () => {
    // The tightening must not turn every collection into a refusal.
    const provided = new Set([
      "skyrim.esm",
      "racecompatibility.esm",
      "mei - patch - racecompatibility.esp",
    ]);
    const check = checkMasters(
      [
        p("Skyrim.esm", []),
        p("RaceCompatibility.esm", ["Skyrim.esm"]),
        p("MEI - Patch - RaceCompatibility.esp", [
          "Skyrim.esm",
          "RaceCompatibility.esm",
        ]),
      ],
      "skyrimse",
      provided,
    );
    expect(check.missing).toHaveLength(0);
  });

  it("does not turn base-game masters into refusals when a provided set is given", () => {
    /**
     * A package never ships Skyrim.esm, so intersecting with "what we ship"
     * would make every plugin in every collection missing its base masters —
     * the way to get this tightening catastrophically wrong. `checkMasters`
     * classifies base-game and Creation Club masters BEFORE it asks whether
     * the collection has them, which is what keeps that from happening.
     *
     * Measured against the real thing rather than argued: 1,586 shipped
     * Skyrim plugins and 785 Fallout 4 ones, checked against their real Data
     * folders, produced zero missing masters under this rule.
     */
    const check = checkMasters(
      [p("MyPatch.esp", ["Skyrim.esm", "Dawnguard.esm", "ccBGSSSE001-Fish.esm"])],
      "skyrimse",
      new Set(["mypatch.esp"]),
    );
    expect(check.missing).toHaveLength(0);
    expect(check.userOwned.map((m) => m.master)).toEqual(["ccBGSSSE001-Fish.esm"]);
  });

  it("groups the message by MASTER, because one absence breaks several plugins", () => {
    // Six lines that all say "add RaceCompatibility.esm" read as six problems.
    const check = checkMasters(
      [
        p("a.esp", ["RaceCompatibility.esm"]),
        p("b.esp", ["RaceCompatibility.esm"]),
        p("c.esp", ["RaceCompatibility.esm"]),
      ],
      "skyrimse",
    );
    const msg = describeMissingMasters(check);
    expect(msg).toContain("1 master file(s)");
    expect(msg).toContain("RaceCompatibility.esm — needed by a.esp, b.esp, c.esp");
    // And it says why it probably looks fine to the curator.
    expect(msg).toMatch(/outside this collection/);
  });
});

describe("what must NOT be reported", () => {
  it("ignores the base game's own masters", () => {
    // Every user has these; a collection never ships them.
    const check = checkMasters(
      [p("x.esp", ["Skyrim.esm", "Update.esm", "Dawnguard.esm"])],
      "skyrimse",
    );
    expect(check.missing).toEqual([]);
  });

  it("uses the right base masters per game", () => {
    // `Fallout4.esm` is not a Skyrim master and vice versa — a shared list
    // would silently excuse a genuinely missing master on the other game.
    expect(
      checkMasters([p("x.esp", ["Fallout4.esm"])], "fallout4").missing,
    ).toEqual([]);
    expect(
      checkMasters([p("x.esp", ["Fallout4.esm"])], "skyrimse").missing,
    ).toHaveLength(1);
  });

  it("treats Creation Club content as the USER's to own, never a build error", () => {
    /**
     * Bought per account. The curator cannot ship it and the user may not have
     * it, so it is a real prerequisite — and blocking the build would demand a
     * fix that does not exist.
     */
    const check = checkMasters(
      [p("x.esp", ["ccBGSSSE001-Fish.esm", "ccQDRSSE001-SurvivalMode.esl"])],
      "skyrimse",
    );
    expect(check.missing).toEqual([]);
    expect(check.userOwned).toHaveLength(2);
    expect(describeUserOwnedMasters(check)[0]).toMatch(/Creation Club/);
  });

  it("ignores DISABLED plugins — they do not load, so they cannot break", () => {
    const check = checkMasters(
      [p("off.esp", ["Nothing.esm"], false), p("on.esp", [])],
      "skyrimse",
    );
    expect(check.missing).toEqual([]);
    expect(check.checked).toBe(1);
  });

  it("matches master names case-insensitively", () => {
    // The engine does not distinguish them, and a plugin's header spelling
    // routinely differs from the file's.
    const check = checkMasters(
      [p("RACECOMPATIBILITY.ESM", []), p("x.esp", ["racecompatibility.esm"])],
      "skyrimse",
    );
    expect(check.missing).toEqual([]);
  });
});

describe("a master that ships but is switched OFF", () => {
  it("counts as missing, which is what Vortex's own dialog says", () => {
    // "Some of the enabled plugins depend on others that are NOT ENABLED."
    // Present-but-disabled is exactly as absent as never shipped.
    const check = checkMasters(
      [p("Base.esm", [], false), p("x.esp", ["Base.esm"])],
      "skyrimse",
    );
    expect(check.missing).toEqual([{ plugin: "x.esp", master: "Base.esm" }]);
  });
});

describe("a plugin whose header could not be read", () => {
  it("is reported as UNKNOWN, never as having no masters", () => {
    /**
     * The difference between "this needs nothing" and "we could not look" is
     * the difference between a check that ran and one that quietly did not.
     * Collapsing them would let a locked plugin pass the build.
     */
    const check = checkMasters([p("locked.esp", undefined)], "skyrimse");
    expect(check.missing).toEqual([]);
    expect(check.unreadable).toEqual(["locked.esp"]);
  });
});

describe("a Creation Club master the CURATOR happens to own", () => {
  /**
   * The classification order used to be: is it shipped and enabled? → is it
   * base-game? → is it Creation Club? That absorbed a whole class of
   * prerequisite. A curator who owns `ccBGSSSE001-Fish.esm` has it enabled in
   * their own plugin list, so `available.has(key)` matched and the check said
   * nothing — while the installing user, who never bought that Creation Club
   * content, gets a game that will not load and a collection that reported
   * itself perfectly healthy.
   *
   * "Does the collection ship this" and "can the user be expected to have
   * this" are different questions, and the second has to be answered first.
   */
  it("is reported as the user's prerequisite, not silently absorbed", () => {
    const check = checkMasters(
      [
        // The curator has it, enabled, in their own load order.
        { name: "ccBGSSSE001-Fish.esm", enabled: true, masters: [] },
        { name: "MyPatch.esp", enabled: true, masters: ["ccBGSSSE001-Fish.esm"] },
      ],
      "skyrimse",
    );
    expect(check.missing).toEqual([]);
    expect(check.userOwned).toEqual([
      { plugin: "MyPatch.esp", master: "ccBGSSSE001-Fish.esm" },
    ]);
  });

  it("still says nothing about a base-game master the curator has", () => {
    // Every user has these, so they are neither missing nor a prerequisite.
    const check = checkMasters(
      [
        { name: "Skyrim.esm", enabled: true, masters: [] },
        { name: "MyPatch.esp", enabled: true, masters: ["Skyrim.esm"] },
      ],
      "skyrimse",
    );
    expect(check.missing).toEqual([]);
    expect(check.userOwned).toEqual([]);
  });

  it("still passes a master the collection genuinely ships", () => {
    // The ordering change must not turn ordinary shipped masters into noise.
    const check = checkMasters(
      [
        { name: "SomeMod.esm", enabled: true, masters: [] },
        { name: "MyPatch.esp", enabled: true, masters: ["SomeMod.esm"] },
      ],
      "skyrimse",
    );
    expect(check.missing).toEqual([]);
    expect(check.userOwned).toEqual([]);
  });
});
