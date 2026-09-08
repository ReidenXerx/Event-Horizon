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
