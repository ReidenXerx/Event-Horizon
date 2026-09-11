/**
 * The doctor's diagnosis, tested without a running Vortex — which is the whole
 * reason evaluateHealth is pure.
 *
 * The properties that matter are about honesty:
 *   - "unknown" is never rolled up as a pass
 *   - a weak check says it is weak rather than implying more
 *   - every failure names the pipeline step that repairs it
 */
import { describe, expect, it } from "vitest";

import {
  assessObservedLoadOrder,
  evaluateHealth,
  healingBlockedReason,
  overallHealth,
  type HealthObservations,
  type HealthReceiptView,
} from "./health";

/**
 * Plugin-order fixtures now carry `enabled`, because the check compares
 * enabled plugins only — that is the whole reason it stopped calling every
 * healthy install "drifted".
 */
const on = (...names: string[]): { name: string; enabled: boolean }[] =>
  names.map((name) => ({ name, enabled: true }));

const receipt = (over: Partial<HealthReceiptView> = {}): HealthReceiptView => ({
  packageName: "Ivy 2",
  packageVersion: "1.0.10",
  vortexProfileId: "prof-1",
  mods: [
    { vortexModId: "m1", compareKey: "nexus:1:1", name: "Alpha" },
    { vortexModId: "m2", compareKey: "nexus:2:2", name: "Beta" },
    { vortexModId: "m3", compareKey: "nexus:3:3", name: "Gamma" },
  ],
  rulesApplication: {
    appliedRuleCount: 291,
    baselinePluginOrder: [
      { name: "a.esp", enabled: true, light: true },
      { name: "b.esp", enabled: true, light: false },
      { name: "c.esp", enabled: true },
    ],
  },
  userlistApplication: { appliedRuleCount: 29, appliedGroupAssignmentCount: 84 },
  ...over,
});

const healthy = (over: Partial<HealthObservations> = {}): HealthObservations => ({
  existingProfileIds: ["prof-1"],
  activeProfileId: "prof-1",
  installedModIds: ["m1", "m2", "m3"],
  enabledModIds: ["m1", "m2", "m3"],
  driftedCompareKeys: [],
  currentPluginOrder: on("a.esp", "b.esp", "c.esp"),
  // Matches the recorded flags above. `c.esp` recorded none, so it is not
  // checked at all — absent is an unknown, never drift.
  currentPluginLightFlags: { "a.esp": true, "b.esp": false },
  currentModRuleCount: 291,
  currentUserlistRuleCount: 29,
  currentUserlistGroupAssignmentCount: 84,
  ...over,
});

const byId = (checks: ReturnType<typeof evaluateHealth>, id: string) =>
  checks.find((c) => c.id === id)!;

describe("evaluateHealth", () => {
  it("reports a fully intact collection as healthy", () => {
    const checks = evaluateHealth(receipt(), healthy());
    expect(checks.every((c) => c.status === "healthy")).toBe(true);
    expect(overallHealth(checks).status).toBe("healthy");
  });

  it("does not call a group-only collection's own entries a change", () => {
    /**
     * ─── THE REAL RECEIPT THIS SPLIT CAME FROM ────────────────────────
     * Meridia Panties v1.0.11 on a tester's machine: the install applied 501
     * group assignments and ZERO ordering rules, and 501 assignments were
     * still there. Nothing had drifted by any measure.
     *
     * The Doctor said "501 LOOT rules have been added since installing" and
     * counted the collection as not intact, because one check compared
     * `appliedRuleCount` (0) against the number of plugin ENTRIES (501) —
     * neither of which is the other. A curator was shown damage that did not
     * exist, on the page whose whole job is telling them whether it does.
     */
    const checks = evaluateHealth(
      receipt({
        userlistApplication: {
          appliedRuleCount: 0,
          appliedGroupAssignmentCount: 501,
        },
      }),
      healthy({
        currentUserlistRuleCount: 0,
        currentUserlistGroupAssignmentCount: 501,
      }),
    );

    expect(byId(checks, "userlist").status).toBe("healthy");
    expect(byId(checks, "userlist-groups").status).toBe("healthy");
    expect(overallHealth(checks).status).toBe("healthy");
  });

  it("still notices group assignments that really were lost", () => {
    // The split must not buy its silence by checking nothing. Losing the
    // group assignments wrecks load order as thoroughly as losing rules.
    const checks = evaluateHealth(
      receipt({
        userlistApplication: {
          appliedRuleCount: 0,
          appliedGroupAssignmentCount: 501,
        },
      }),
      healthy({
        currentUserlistRuleCount: 0,
        currentUserlistGroupAssignmentCount: 12,
      }),
    );

    const c = byId(checks, "userlist-groups");
    expect(c.status).not.toBe("healthy");
    expect(c.heal?.action).toBe("reapply-userlist");
  });

  it("says UNKNOWN for a receipt written before the group count existed", () => {
    // An older receipt has no number. Comparing against a zero we invented
    // would report every assignment as an addition — the same shape of lie
    // this split exists to remove.
    const checks = evaluateHealth(
      receipt({ userlistApplication: { appliedRuleCount: 0 } }),
      healthy({ currentUserlistGroupAssignmentCount: 501 }),
    );

    expect(byId(checks, "userlist-groups").status).toBe("unknown");
  });

  it("calls missing mods broken, and offers to reinstall exactly those", () => {
    const checks = evaluateHealth(
      receipt(),
      healthy({ installedModIds: ["m1"] }),
    );
    const c = byId(checks, "mods-present");
    expect(c.status).toBe("broken");
    expect(c.affectedCount).toBe(2);
    expect(c.detail).toEqual(["Beta", "Gamma"]);
    expect(c.heal?.action).toBe("reinstall-mods");
    expect(overallHealth(checks).status).toBe("broken");
  });

  it("does not report a missing mod as also disabled", () => {
    // Same fact twice reads as two problems and inflates the count.
    const checks = evaluateHealth(
      receipt(),
      healthy({ installedModIds: ["m1"], enabledModIds: ["m1"] }),
    );
    expect(byId(checks, "mods-enabled").status).toBe("healthy");
    expect(byId(checks, "mods-enabled").affectedCount).toBe(0);
  });

  it("treats a disabled mod as drift, not breakage", () => {
    const checks = evaluateHealth(
      receipt(),
      healthy({ enabledModIds: ["m1", "m2"] }),
    );
    const c = byId(checks, "mods-enabled");
    expect(c.status).toBe("drifted");
    expect(c.heal?.action).toBe("enable-mods");
    expect(overallHealth(checks).status).toBe("drifted");
  });

  it("is HEALTHY when the user simply has plugins of their own", () => {
    /**
     * The false positive that made this check useless. It bailed on
     * `a.length !== b.length` and reported "The order has 431 plugins; the
     * curator's had 412" — on an install that reproduced perfectly. Every
     * real profile has extra plugins, so it was red on every real machine,
     * which trains people to ignore the one diagnostic that matters.
     */
    const checks = evaluateHealth(
      receipt(),
      healthy({
        currentPluginOrder: on("a.esp", "mine1.esp", "b.esp", "mine2.esp", "c.esp"),
      }),
    );
    expect(byId(checks, "plugin-order").status).toBe("healthy");
  });

  it("ignores a disabled plugin sitting in the middle of the file", () => {
    // plugins.txt lists disabled plugins too; one loads nothing and takes no
    // slot, so its position cannot be drift.
    const checks = evaluateHealth(
      receipt(),
      healthy({
        currentPluginOrder: [
          { name: "a.esp", enabled: true },
          { name: "off.esp", enabled: false },
          { name: "b.esp", enabled: true },
          { name: "c.esp", enabled: true },
        ],
      }),
    );
    expect(byId(checks, "plugin-order").status).toBe("healthy");
  });

  it("ignores plugin-order casing, which is not stable across machines", () => {
    const checks = evaluateHealth(
      receipt(),
      healthy({ currentPluginOrder: on("A.esp", "B.ESP", "c.esp") }),
    );
    // Case-sensitive comparison would report drift on every entry and make
    // this check useless.
    expect(byId(checks, "plugin-order").status).toBe("healthy");
  });

  it("names which plugin is out of place, not which index differs", () => {
    // An absolute position is meaningless once the user has plugins of their
    // own — every index after the first extra one shifts. The actionable
    // fact is which plugin should load after which.
    const checks = evaluateHealth(
      receipt(),
      healthy({ currentPluginOrder: on("a.esp", "c.esp", "b.esp") }),
    );
    const c = byId(checks, "plugin-order");
    expect(c.status).toBe("drifted");
    expect(c.summary).toMatch(/1 of 3 shared plugins/);
    expect(c.detail.join(" ")).toMatch(/"c.esp" should load after "b.esp"/);
    expect(c.heal?.action).toBe("repin-plugin-order");
  });

  it("says a rule count check is only a count", () => {
    // A rule swapped for a different rule keeps the count identical. Claiming
    // more than this can detect is the false-green pattern.
    const checks = evaluateHealth(
      receipt(),
      healthy({ currentModRuleCount: 280 }),
    );
    const c = byId(checks, "mod-rules");
    expect(c.status).toBe("drifted");
    expect(c.summary).toMatch(/11 of 291/);
    expect(c.detail.join(" ")).toMatch(/Counts only/);
  });

  it("reports a vanished profile as broken with no automatic cure", () => {
    const checks = evaluateHealth(
      receipt(),
      healthy({ existingProfileIds: [], activeProfileId: undefined }),
    );
    const c = byId(checks, "profile");
    expect(c.status).toBe("broken");
    // A receipt cannot recreate a profile's mods, so offering a button would
    // be a lie.
    expect(c.heal).toBeUndefined();
  });

  it("offers to switch when the collection is fine but you are elsewhere", () => {
    const checks = evaluateHealth(
      receipt(),
      healthy({ activeProfileId: "other" }),
    );
    const c = byId(checks, "profile");
    expect(c.status).toBe("drifted");
    expect(c.heal?.action).toBe("switch-profile");
  });

  it("marks an unrun deep scan unknown, never healthy", () => {
    const checks = evaluateHealth(
      receipt(),
      healthy({ driftedCompareKeys: undefined }),
    );
    expect(byId(checks, "staging").status).toBe("unknown");
  });

  it("marks a pre-feature receipt unknown rather than passing it", () => {
    const checks = evaluateHealth(
      receipt({ rulesApplication: undefined, userlistApplication: undefined }),
      healthy(),
    );
    expect(byId(checks, "mod-rules").status).toBe("unknown");
    expect(byId(checks, "userlist").status).toBe("unknown");
    expect(byId(checks, "plugin-order").status).toBe("unknown");
  });

  it("truncates a long list without pretending it is complete", () => {
    const many = Array.from({ length: 40 }, (_, i) => ({
      vortexModId: `m${i}`,
      compareKey: `k${i}`,
      name: `Mod ${i}`,
    }));
    const checks = evaluateHealth(
      receipt({ mods: many }),
      healthy({ installedModIds: [], enabledModIds: [] }),
    );
    const c = byId(checks, "mods-present");
    expect(c.detail).toHaveLength(26);
    expect(c.detail[25]).toMatch(/and 15 more/);
    // The COUNT stays true even though the list is cut.
    expect(c.affectedCount).toBe(40);
  });
});

describe("overallHealth", () => {
  it("never reports 'all good' while a check has not run", () => {
    // The whole point of the five-state model: unknown is not a pass.
    const checks = evaluateHealth(
      receipt(),
      healthy({ driftedCompareKeys: undefined }),
    );
    const overall = overallHealth(checks);
    expect(overall.status).toBe("unknown");
    expect(overall.headline).toMatch(/have not run/);
  });

  it("lets broken outrank drifted", () => {
    const checks = evaluateHealth(
      receipt(),
      healthy({ installedModIds: ["m1"], enabledModIds: ["m1"], currentModRuleCount: 1 }),
    );
    expect(overallHealth(checks).status).toBe("broken");
    expect(overallHealth(checks).problems).toBeGreaterThan(1);
  });
});

describe("healingBlockedReason", () => {
  it("blocks while the driver is installing", () => {
    // Every heal re-runs a pipeline step that mutates Vortex. Two of them
    // writing at once corrupts a collection in a way neither half's own
    // verification would catch, because each looks individually correct.
    const why = healingBlockedReason({ kind: "installing" });
    expect(why).toBeDefined();
    expect(why).toMatch(/install is running/i);
  });

  it("allows healing during read-only phases", () => {
    // Blocking these would be superstition: nothing is being written.
    for (const kind of ["pick", "loading", "preview", "decisions", "confirm", "done"]) {
      expect(healingBlockedReason({ kind })).toBeUndefined();
    }
  });

  it("allows healing when there is no install session at all", () => {
    expect(healingBlockedReason(undefined)).toBeUndefined();
  });

  it("blocks when it cannot tell, rather than assuming safety", () => {
    // If we do not know what the installer is doing, the safe answer is not to
    // also start writing.
    expect(healingBlockedReason({} as unknown as { kind: unknown })).toBeDefined();
    expect(
      healingBlockedReason({ kind: 42 } as unknown as { kind: unknown }),
    ).toBeDefined();
  });
});

describe("a supervised install makes drift ambiguous", () => {
  // The Doctor diagnoses against the receipt but repairs from the collection.
  // Those two references agree perfectly until the user changes an installer
  // answer on purpose — and then "reinstall" quietly restores the curator's.
  // The user was warned at install time; they are warned again at the moment
  // it would actually happen.
  const drifted = () => healthy({ driftedCompareKeys: ["nexus:1:1"] });

  it("says a difference may be deliberate when the user drove the installers", () => {
    const checks = evaluateHealth(
      receipt({ fomodReplayMode: "supervised" }),
      drifted(),
    );
    const staging = byId(checks, "staging");
    expect(staging.detail.join(" ").toLowerCase()).toContain("on purpose");
    expect(staging.detail.join(" ").toLowerCase()).toContain("curator");
  });

  it("still offers the repair rather than hiding it behind the caveat", () => {
    // A caveat is not a reason to withhold the fix. Most drift after a
    // supervised install is still ordinary drift.
    const checks = evaluateHealth(
      receipt({ fomodReplayMode: "supervised" }),
      drifted(),
    );
    expect(byId(checks, "staging").heal?.action).toBe("reinstall-mods");
  });

  it("says nothing of the sort after a silent install", () => {
    // Nothing could have deviated, so the note would be noise — and worse,
    // it would suggest the user's own change caused corruption they did not
    // cause.
    const checks = evaluateHealth(
      receipt({ fomodReplayMode: "silent" }),
      drifted(),
    );
    expect(byId(checks, "staging").detail.join(" ")).not.toContain("on purpose");
  });

  it("says nothing of the sort on an old receipt that never recorded it", () => {
    // Absent means "not recorded", not "supervised". Guessing would put a
    // speculative excuse on real corruption.
    const checks = evaluateHealth(receipt(), drifted());
    expect(byId(checks, "staging").detail.join(" ")).not.toContain("on purpose");
  });

  it("keeps the drifted mod names, caveat or not", () => {
    // The caveat is prepended to the list. Prepending must not replace it.
    const checks = evaluateHealth(
      receipt({ fomodReplayMode: "supervised" }),
      drifted(),
    );
    expect(byId(checks, "staging").detail).toContain("Alpha");
    expect(byId(checks, "staging").affectedCount).toBe(1);
  });
});

describe("the ESL flags, which decide whether the game starts", () => {
  it("is DRIFTED when a light flag was lost, and says what that costs", () => {
    /**
     * The failure this check exists for. The flag lives in the plugin file's
     * header, so a Vortex purge under copy deployment rewrites it from
     * staging and silently undoes the install's repair. On the profile this
     * was built for, 1421 of 1607 plugins are light — losing them puts the
     * setup roughly 1200 over the 254 limit and the game stops starting,
     * while every other check stays green.
     */
    const checks = evaluateHealth(
      receipt(),
      healthy({ currentPluginLightFlags: { "a.esp": false, "b.esp": false } }),
    );
    const c = byId(checks, "plugin-light-flags");
    expect(c.status).toBe("drifted");
    expect(c.affectedCount).toBe(1);
    expect(c.summary).toMatch(/lost the light flag/);
    expect(c.summary).toMatch(/purge/);
    expect(c.detail.join(" ")).toMatch(/a\.esp should be light/);
  });

  it("does not call an unreadable plugin drift", () => {
    // Absent from the on-disk map means we could not read that file. Treating
    // it as changed would report drift on a locked game folder.
    const checks = evaluateHealth(
      receipt(),
      healthy({ currentPluginLightFlags: { "b.esp": false } }),
    );
    expect(byId(checks, "plugin-light-flags").status).toBe("healthy");
  });

  it("is UNKNOWN, never healthy, when nothing could be read", () => {
    const checks = evaluateHealth(receipt(), healthy({ currentPluginLightFlags: undefined }));
    const c = byId(checks, "plugin-light-flags");
    expect(c.status).toBe("unknown");
    expect(c.summary).toMatch(/not the same as them being correct/);
  });

  it("is UNKNOWN when the package recorded no flags at all", () => {
    // A package built before the flags were carried. Saying "healthy" would
    // vouch for something never checked.
    const r = receipt();
    const stripped = {
      ...r,
      rulesApplication: {
        ...r.rulesApplication!,
        baselinePluginOrder: [{ name: "a.esp", enabled: true }],
      },
    };
    const checks = evaluateHealth(stripped, healthy());
    expect(byId(checks, "plugin-light-flags").status).toBe("unknown");
  });
});

/**
 * ──────────────────────────────────────────────────────────────────────
 * A receipt from a run that did not finish.
 *
 * The receipt used to assert exactly one thing: this collection IS installed.
 * It is now also written by a run that installed 978 of 979 mods, or one the
 * user stopped after the deploy — 978 mods with provenance beat 978 mods with
 * none (NS-2). Both facts were recorded and read by nothing, so every check
 * here treated a partial install as a complete healthy one.
 * ──────────────────────────────────────────────────────────────────────
 */
describe("a partial install, seen by the Doctor", () => {
  const observations = (over: Partial<HealthObservations> = {}) =>
    healthy(over);

  it("reports the mods that never installed at all", () => {
    /**
     * `receipt.mods` only ever held the mods that DID install, so
     * `mods-present` compared 978 against 978 and answered "healthy". The one
     * mod genuinely absent from the collection was invisible because it was
     * never written into the list being checked.
     */
    const checks = evaluateHealth(
      receipt({
        failedMods: [
          {
            name: "AAF_VanillaKinkyCreatureAnimations",
            reason: "Installer Prerequisits not fulfilled: File 'aaf.esm' is Active",
          },
        ],
      }),
      observations(),
    );

    const check = checks.find((c) => c.id === "install-incomplete");
    expect(check?.status).toBe("broken");
    expect(check?.summary).toMatch(/could not be installed/i);
    expect(check?.detail.join(" ")).toMatch(/AAF_VanillaKinky/);
  });

  it("stops mods-present from reading as a clean bill of health", () => {
    const checks = evaluateHealth(
      receipt({ failedMods: [{ name: "X", reason: "why" }] }),
      observations(),
    );

    const present = checks.find((c) => c.id === "mods-present");
    // Still healthy — the mods it placed ARE all there, which is true and
    // worth saying. What changes is that it no longer claims to speak for the
    // whole collection.
    expect(present?.status).toBe("healthy");
    expect(present?.summary).toMatch(/never installed at all/i);
  });

  it("does not call an unapplied load order 'drifted'", () => {
    /**
     * `baselinePluginOrder` is recorded unconditionally, OUTSIDE the
     * `stopBeforeWriting` gate — so a stopped run recorded an order it then
     * deliberately did not apply. Comparing against it reported the user's
     * plugins as drifted from a state that never existed on their machine,
     * and offered to heal it by applying the very order they had stopped.
     */
    const checks = evaluateHealth(
      receipt({ finishingSkipped: ["plugin order", "ESL flags"] }),
      observations({ currentPluginOrder: on("z.esp", "a.esp") }),
    );

    const order = checks.find((c) => c.id === "plugin-order");
    expect(order?.status).toBe("unknown");
    expect(order?.summary).toMatch(/before it applied the load order/i);
  });

  it("says nothing at all about a run that DID finish", () => {
    // Presence is the signal. A check that fires on every healthy install is
    // one people learn to skip.
    const checks = evaluateHealth(receipt(), observations());
    expect(checks.find((c) => c.id === "install-incomplete")).toBeUndefined();
  });
});

/**
 * Vortex holds ONE plugin order — the active game's active profile — and the
 * heal behind this check writes into whatever order is active. So the check
 * first asks whose order it is looking at, and it is the same assessment the
 * Load order card renders.
 */
describe("the plugin-order check asks whose order it is", () => {
  it("does not judge — or offer to re-apply into — another profile's order", () => {
    const checks = evaluateHealth(
      receipt({ vortexProfileName: "Ivy 2" }),
      healthy({ activeProfileId: "default", currentPluginOrderFromState: on("c.esp", "b.esp", "a.esp") }),
    );
    const c = byId(checks, "plugin-order");
    expect(c.status).toBe("not-applicable");
    expect(c.heal).toBeUndefined();
    expect(c.summary).toMatch(/"Ivy 2"/);
  });

  it("defers to a newer collection installed into the same profile", () => {
    const checks = evaluateHealth(
      receipt(),
      healthy({
        currentPluginOrderFromState: on("c.esp", "b.esp", "a.esp"),
        loadOrderStanding: { kind: "superseded", by: "Other v2.0.0" },
      }),
    );
    const c = byId(checks, "plugin-order");
    expect(c.status).toBe("not-applicable");
    expect(c.heal).toBeUndefined();
    expect(c.summary).toMatch(/Other v2\.0\.0/);
  });

  it("does not judge a receipt for a game Vortex is not managing", () => {
    const checks = evaluateHealth(
      receipt({ gameId: "skyrimse" }),
      healthy({
        currentPluginOrderFromState: on("c.esp", "b.esp", "a.esp"),
        loadOrderStanding: { kind: "not-active-game", activeGameId: "fallout4" },
      }),
    );
    const c = byId(checks, "plugin-order");
    expect(c.status).toBe("not-applicable");
    expect(c.heal).toBeUndefined();
    expect(c.summary).toMatch(/skyrimse/);
  });

  it("excludes the game's own plugins, exactly as the Load order card does", () => {
    // Vortex never writes natives to loadOrder; the curator's baseline has
    // them. Not excluding them read every native as a missing plugin.
    const r = receipt({
      rulesApplication: { baselinePluginOrder: [{ name: "Skyrim.esm", enabled: true }, ...on("a.esp", "b.esp", "c.esp")] },
    });
    const obs = healthy({ currentPluginOrderFromState: on("a.esp", "b.esp", "c.esp"), nativePluginNames: ["skyrim.esm"] });
    expect(byId(evaluateHealth(r, obs), "plugin-order").status).toBe("healthy");
    expect(assessObservedLoadOrder(r, obs).kind).toBe("matches");
  });

  it("decides 'not applicable' from the order it compares, not from the file", () => {
    // plugins.txt unreadable, Vortex's order present and drifted.
    const checks = evaluateHealth(
      receipt(),
      healthy({ currentPluginOrder: undefined, currentPluginOrderFromState: on("a.esp", "c.esp", "b.esp") }),
    );
    expect(byId(checks, "plugin-order").status).toBe("drifted");
  });
});
