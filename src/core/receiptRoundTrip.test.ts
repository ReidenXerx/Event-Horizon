/**
 * `serializeReceipt` validates through `parseReceipt` BEFORE writing, so a
 * field the parser does not know is not lost on read — it is destroyed on the
 * way to disk and never exists at all.
 *
 * That is how `gameIniApplication` went missing. `shouldApplyGameIni` reads it
 * to decide whether the curator's INI settings have already been applied for
 * this package version; reading a field that can never be present turned
 * "apply once" into "apply on every install and every update", quietly
 * overwriting whatever the user had changed in between. Nothing failed, and
 * the only visible symptom was settings reverting.
 *
 * The parser is a whitelist. So this asserts every optional field survives a
 * real round trip, by name, and a new one added to the type without a parser
 * branch fails here instead of on someone's machine.
 */
import { describe, expect, it } from "vitest";

import { parseReceipt, serializeReceipt } from "./installLedger";
import type { InstallReceipt } from "../types/installLedger";

const base = (): InstallReceipt =>
  ({
    schemaVersion: 1,
    packageId: "11111111-2222-4333-8444-555555555555",
    packageVersion: "1.0.0",
    packageName: "Test Collection",
    gameId: "fallout4",
    installedAt: "1970-01-01T00:00:00.000Z",
    vortexProfileId: "profile-1",
    vortexProfileName: "Profile",
    installTargetMode: "fresh-profile",
    mods: [],
  }) as InstallReceipt;

/** What actually lands on disk, which is what the next install will read. */
const throughDisk = (r: InstallReceipt): InstallReceipt =>
  JSON.parse(serializeReceipt(r)) as InstallReceipt;

describe("install receipt round-trip", () => {
  it("keeps gameIniApplication, which the apply-once guard depends on", () => {
    // The REAL GameIniApplicationReceipt shape. The previous fixture invented
    // one (`packageVersion` / `appliedAt` / `files`) that the type does not
    // have, which made the test unfalsifiable for the thing it claims to
    // check: `gameIniApplication` is parsed by `passthroughObject`, so an
    // arbitrary object survives the round trip whether or not the real fields
    // do. It went unnoticed because tests were never typechecked.
    const gameIniApplication = {
      appliedCount: 310,
      alreadyMatchedCount: 12,
      changes: ["Fallout4.ini: bInvalidateOlderFiles 0 -> 1"],
      failed: [],
    };
    const out = throughDisk({ ...base(), gameIniApplication } as InstallReceipt);
    expect(out.gameIniApplication).toEqual(gameIniApplication);
  });

  it("keeps every other optional block", () => {
    const rulesApplication = { appliedRuleCount: 3, skippedRules: [] };
    const userlistApplication = { appliedCount: 1, skippedEntries: [] };
    const verifications = [{ compareKey: "k", name: "n", outcome: "ok" }];
    const out = throughDisk({
      ...base(),
      rulesApplication,
      userlistApplication,
      verifications,
    } as unknown as InstallReceipt);
    expect(out.rulesApplication).toEqual(rulesApplication);
    expect(out.userlistApplication).toEqual(userlistApplication);
    expect(out.verifications).toEqual(verifications);
  });

  it("keeps the identity fields the next install reconciles against", () => {
    // packageId and packageVersion decide whether the next run is an UPDATE of
    // this collection or a stranger, which drives orphan detection.
    const out = throughDisk(base());
    expect(out.packageId).toBe("11111111-2222-4333-8444-555555555555");
    expect(out.packageVersion).toBe("1.0.0");
    expect(out.installTargetMode).toBe("fresh-profile");
  });

  it("keeps a mod's stagingSetHash — the drift reference", () => {
    // The whole point of recording it: an UPDATE re-reads this receipt and
    // compares the hash against the files on disk. Destroyed at write, the
    // comparison silently has nothing to compare and every mod looks
    // unexamined — the same failure shape as gameIniApplication, where the
    // absent field made a guard that could never fire.
    const hash = "a".repeat(64);
    const mods = [
      {
        vortexModId: "mod-1",
        compareKey: "nexus:1:2",
        source: "nexus",
        name: "A Mod",
        installedAt: "1970-01-01T00:00:00.000Z",
        stagingSetHash: hash,
      },
    ];
    const out = throughDisk({ ...base(), mods } as unknown as InstallReceipt);
    expect(out.mods[0].stagingSetHash).toBe(hash);
  });

  it("keeps a mod with NO stagingSetHash absent, not empty", () => {
    // Absent means "we do not know what this looked like", which is a
    // different claim from "it has not changed". Coercing it to "" would make
    // an unknown compare unequal to everything and warn about every mod on
    // every update.
    const mods = [
      {
        vortexModId: "mod-1",
        compareKey: "nexus:1:2",
        source: "nexus",
        name: "A Mod",
        installedAt: "1970-01-01T00:00:00.000Z",
      },
    ];
    const out = throughDisk({ ...base(), mods } as unknown as InstallReceipt);
    expect(out.mods[0].stagingSetHash).toBeUndefined();
    expect("stagingSetHash" in out.mods[0]).toBe(false);
  });

  it("rejects a stagingSetHash that is not a sha256", () => {
    // It is compared for equality against a freshly computed hash. A
    // truncated or uppercase value would never match and would report drift
    // on a mod nobody touched.
    const mods = [
      {
        vortexModId: "mod-1",
        compareKey: "nexus:1:2",
        source: "nexus",
        name: "A Mod",
        installedAt: "1970-01-01T00:00:00.000Z",
        stagingSetHash: "NOTAHASH",
      },
    ];
    expect(() =>
      throughDisk({ ...base(), mods } as unknown as InstallReceipt),
    ).toThrow(/stagingSetHash/);
  });

  it("round-trips through parseReceipt unchanged a second time", () => {
    // Serialize is idempotent only if nothing is being dropped each pass. A
    // field that survives one trip and dies on the next is the same bug with
    // a longer fuse.
    const full = {
      ...base(),
      gameIniApplication: {
        packageVersion: "1.0.0",
        appliedAt: "1970-01-01T00:00:00.000Z",
        files: [],
      },
      rulesApplication: { appliedRuleCount: 0, skippedRules: [] },
    } as unknown as InstallReceipt;
    const once = throughDisk(full);
    const twice = parseReceipt(serializeReceipt(once));
    expect(twice).toEqual(once);
  });
});

describe("what the run did NOT do, and what it changed in the game folder", () => {
  /**
   * Both fields were added because the receipt was silent about them, and
   * both are read back later — so both are exactly the shape this file
   * exists to guard. A parser branch that is missing does not fail loudly; it
   * writes a receipt without the field and everything downstream reads a
   * complete, healthy install.
   */
  it("keeps finishingSkipped, so a stopped run does not read as a clean one", () => {
    const r = base();
    r.finishingSkipped = ["plugin order", "ESL flags", "game settings"];
    expect(throughDisk(r).finishingSkipped).toEqual([
      "plugin order",
      "ESL flags",
      "game settings",
    ]);
  });

  it("keeps pluginFlagChanges, which is the only record of an undo", () => {
    // The ESL repair rewrites bytes inside the user's game folder, and under
    // hardlink deployment those bytes belong to the owning mod — which is
    // usually a mod Event Horizon did not install. Losing this on the way to
    // disk means the change is permanent and unattributable.
    const r = base();
    r.pluginFlagChanges = [
      { plugin: "Foo.esp", wasLight: false },
      { plugin: "Bar.esp", wasLight: true },
    ];
    expect(throughDisk(r).pluginFlagChanges).toEqual([
      { plugin: "Foo.esp", wasLight: false },
      { plugin: "Bar.esp", wasLight: true },
    ]);
  });

  it("leaves both absent when the run did everything", () => {
    // Presence IS the signal for finishingSkipped, so an empty array written
    // on every ordinary run would make it meaningless.
    const clean = throughDisk(base());
    expect(clean.finishingSkipped).toBeUndefined();
    expect(clean.pluginFlagChanges).toBeUndefined();
  });
});

describe("a partial install, recorded rather than discarded", () => {
  /**
   * One failed mod used to mean NO receipt. A real run installed 978 of 979,
   * deployed them, and re-pinned the plugin order to zero drift — then wrote
   * nothing, so those 978 had no provenance, uninstall could not find them
   * (NS-2), and the next run forked another profile.
   *
   * The receipt now carries the failures, which makes it an honest partial
   * claim and gives the retry something to resume from. Like every other
   * optional field here, it has to survive `serializeReceipt` — which
   * validates through `parseReceipt`, so an unknown field is destroyed on the
   * way to disk rather than lost on read.
   */
  it("keeps failedMods, which is what the retry resumes from", () => {
    const r = base();
    r.failedMods = [
      {
        compareKey: "external:abc",
        name: "AAF_VanillaKinkyCreatureAnimations_Themes",
        reason:
          "Installer Prerequisits not fulfilled: File 'aaf.esm' is Active",
      },
    ];
    const back = throughDisk(r).failedMods;
    expect(back).toHaveLength(1);
    expect(back?.[0]?.name).toBe("AAF_VanillaKinkyCreatureAnimations_Themes");
    expect(back?.[0]?.reason).toMatch(/Prerequisits/);
    expect(back?.[0]?.compareKey).toBe("external:abc");
  });

  it("leaves it absent on a complete run, so presence IS the signal", () => {
    expect(throughDisk(base()).failedMods).toBeUndefined();
  });
});

/**
 * ─── THE HAND-MAINTAINED LIST IS THE BUG ────────────────────────────────────
 * Every test above names one field. That is why this file was green while
 * `fomodReplayMode` — added after them — was being destroyed on the way to
 * disk: a test that enumerates cannot see what nobody remembered to enumerate,
 * and the header above promises exactly the coverage it did not have.
 *
 * The Doctor reads `fomodReplayMode` to decide whether to say "some of these
 * differences may be answers you changed on purpose" before offering to
 * reinstall. With the field gone, a supervised install's deliberate FOMOD
 * choices were silently reverted by a heal that never warned — the third time
 * this exact shape shipped, after `state.postProcessed` and
 * `gameIniApplication`.
 *
 * So the guard is now STRUCTURAL: populate every field the type declares and
 * assert the key set survives. A field added to `InstallReceipt` without a
 * parser branch fails here, by construction, without anyone remembering.
 */
describe("the whole receipt, not a list of fields somebody remembered", () => {
  /**
   * Every optional member of `InstallReceipt`, populated. Values are the real
   * shapes — `parseReceipt` validates several of them, so a placeholder would
   * be dropped for being malformed and the assertion would fail for the wrong
   * reason.
   */
  const fullyPopulated = (): InstallReceipt =>
    ({
      ...base(),
      fomodReplayMode: "supervised",
      mods: [
        {
          vortexModId: "mod-1",
          compareKey: "nexus:1:2",
          source: "nexus",
          name: "A Mod",
          installedAt: "1970-01-01T00:00:00.000Z",
          stagingSetHash: "a".repeat(64),
          ownership: "installed",
        },
      ],
      rulesApplication: {
        appliedRuleCount: 1,
        overwrittenUserRuleCount: 0,
        skippedRules: [],
        appliedLoadOrderCount: 1,
        skippedLoadOrderEntries: [],
        baselinePluginOrder: [{ name: "Foo.esp", enabled: true }],
      },
      userlistApplication: {
        appliedRuleCount: 1,
        appliedGroupAssignmentCount: 0,
        overwrittenGroupAssignmentCount: 0,
        appliedNewGroupCount: 0,
        appliedGroupRuleCount: 0,
        skippedUserlistEntries: [],
      },
      gameIniApplication: {
        appliedCount: 1,
        alreadyMatchedCount: 0,
        changes: ["Fallout4.ini: bInvalidateOlderFiles 0 -> 1"],
        failed: [],
      },
      verifications: [{ compareKey: "nexus:1:2", name: "A Mod", outcome: "ok" }],
      finishingSkipped: ["plugin order"],
      failedMods: [{ compareKey: "external:abc", name: "B Mod", reason: "why" }],
      pluginFlagChanges: [{ plugin: "Foo.esp", wasLight: false }],
    }) as unknown as InstallReceipt;

  it("carries EVERY field it was given to disk, by key set", () => {
    const full = fullyPopulated();
    const back = throughDisk(full);
    /**
     * Sorted key sets, not a deep equal: this is the assertion about the
     * WHITELIST specifically. A field whose value the parser reshapes is a
     * different (and separately tested) question; a field the parser has never
     * heard of vanishes from the key set, which is the failure that keeps
     * shipping.
     */
    expect(Object.keys(back).sort()).toEqual(Object.keys(full).sort());
  });

  it("proves the fixture is populated, so the key-set check cannot go vacuous", () => {
    /**
     * GP-7. If `fullyPopulated` ever drifts to omit an optional field, the
     * assertion above still passes — it would compare two identically
     * incomplete sets and report success. This is the anchor that makes the
     * previous test mean something, and it is why the count is written down.
     */
    const keys = Object.keys(fullyPopulated());
    for (const name of [
      "fomodReplayMode",
      "rulesApplication",
      "userlistApplication",
      "gameIniApplication",
      "verifications",
      "finishingSkipped",
      "failedMods",
      "pluginFlagChanges",
    ]) {
      expect(keys).toContain(name);
    }
  });

  it("keeps fomodReplayMode, which decides whether a heal warns first", () => {
    // Named as well as covered structurally: this is the one whose absence
    // reverted a user's deliberate FOMOD answers, and a named failure says so
    // where a key-set diff does not.
    const r = base();
    r.fomodReplayMode = "supervised";
    expect(throughDisk(r).fomodReplayMode).toBe("supervised");
  });

  it("drops a replay mode that is not one of the two", () => {
    // Validated rather than passed through: this value reaches `choicesFor`
    // and decides how a stranger's installer runs. An unrecognised string must
    // read as "not recorded", never as a mode.
    const r = {
      ...base(),
      fomodReplayMode: "whatever",
    } as unknown as InstallReceipt;
    expect(throughDisk(r).fomodReplayMode).toBeUndefined();
  });
});
