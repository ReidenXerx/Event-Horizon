/**
 * This is the only code in the project that DELETES the user's own work, and
 * it deletes more than the collection touches: Vortex stores mod rules on the
 * mod and the LOOT userlist per game, so neither is scoped to a profile.
 *
 * The contract it has to keep is therefore narrow and absolute:
 *   - remove exactly what was captured, never more;
 *   - never run at all unless the backup was written first.
 *
 * Both are tested by making them fail.
 */
import { describe, expect, it } from "vitest";

import type { types } from "@nexusmods/vortex-api";

import {
  captureUserRuleState,
  describePurge,
  purgeUserRuleState,
} from "./purgeUserRules";

type Dispatched = { type: string; payload?: unknown };

/** A Vortex whose store records what it was asked to do. */
const fakeApi = (
  state: unknown,
  onDispatch?: (a: Dispatched) => void,
): { api: types.IExtensionApi; dispatched: Dispatched[] } => {
  const dispatched: Dispatched[] = [];
  const api = {
    getState: () => state,
    store: {
      dispatch: (a: Dispatched): void => {
        dispatched.push(a);
        onDispatch?.(a);
      },
    },
  } as unknown as types.IExtensionApi;
  return { api, dispatched };
};

const stateWith = (
  mods: Record<string, { rules?: unknown[] }>,
  userlist?: unknown,
): unknown => ({
  persistent: { mods: { fallout4: mods } },
  ...(userlist !== undefined ? { userlist } : {}),
});

describe("capturing what is about to be deleted", () => {
  it("records every rule on every mod, with the mod it belongs to", () => {
    const { api } = fakeApi(
      stateWith({
        a: { rules: [{ type: "after", reference: { id: "b" } }] },
        b: { rules: [{ type: "before", reference: { id: "c" } }] },
        c: {},
      }),
    );

    const snap = captureUserRuleState(api, "fallout4");
    expect(snap.modRules).toHaveLength(2);
    expect(snap.modRules.map((r) => r.modId).sort()).toEqual(["a", "b"]);
    expect(snap.gameId).toBe("fallout4");
  });

  it("copies the userlist rather than aliasing it", () => {
    // The backup has to survive the purge. If it held a reference into live
    // state, CLEAR_USERLIST would empty the backup too — and nobody would
    // notice until someone asked to be restored.
    const userlist = { plugins: [{ name: "a.esp", group: "Late" }], groups: [] };
    const { api } = fakeApi(stateWith({}, userlist));

    const snap = captureUserRuleState(api, "fallout4");
    (userlist.plugins as unknown[]).length = 0; // simulate the store emptying it

    expect((snap.userlist.plugins as unknown[])).toHaveLength(1);
  });

  it("returns an empty snapshot rather than throwing on a broken state", () => {
    const { api } = fakeApi(null);
    expect(captureUserRuleState(api, "fallout4").modRules).toEqual([]);
  });
});

describe("purging", () => {
  it("removes exactly the captured rules — not whatever state holds now", () => {
    // Driven by the snapshot on purpose. Re-reading state would let it delete
    // something it never recorded, which is a deletion with no way back.
    const { api, dispatched } = fakeApi(
      stateWith({ a: { rules: [{ type: "after", reference: { id: "b" } }] } }),
    );
    const snap = captureUserRuleState(api, "fallout4");

    const result = purgeUserRuleState(api, "fallout4", snap);

    expect(result.modRulesRemoved).toBe(1);
    expect(result.modsTouched).toBe(1);
    const removals = dispatched.filter((d) => d.type === "STUB_REMOVE_MOD_RULE");
    expect(removals).toHaveLength(1);
    expect(removals[0].payload).toMatchObject({
      gameId: "fallout4",
      modId: "a",
      rule: { type: "after", reference: { id: "b" } },
    });
  });

  it("clears the whole userlist with Vortex's own action", () => {
    // CLEAR_USERLIST, read out of the shipped gamebryo-plugin-management
    // bundle: `createAction('CLEAR_USERLIST')` with no payload transformer.
    // Inventing an action name here would fail silently — Redux ignores an
    // action no reducer knows.
    const { api, dispatched } = fakeApi(
      stateWith({}, { plugins: [{ name: "a.esp" }], groups: [] }),
    );
    const snap = captureUserRuleState(api, "fallout4");

    const result = purgeUserRuleState(api, "fallout4", snap);

    expect(result.userlistCleared).toBe(true);
    expect(dispatched.some((d) => d.type === "CLEAR_USERLIST")).toBe(true);
  });

  it("reports a refusal instead of pretending the purge was complete", () => {
    // A partly-purged machine still has some of the user's rules deciding
    // conflicts, which is the exact silent-divergence this feature exists to
    // stop. It has to be visible.
    const { api } = fakeApi(
      stateWith(
        { a: { rules: [{ type: "after", reference: { id: "b" } }] } },
        { plugins: [], groups: [] },
      ),
    );
    const snap = captureUserRuleState(api, "fallout4");
    const throwing = {
      getState: () => stateWith({}),
      store: {
        dispatch: (): void => {
          throw new Error("store is locked");
        },
      },
    } as unknown as types.IExtensionApi;

    const result = purgeUserRuleState(throwing, "fallout4", snap);
    expect(result.modRulesRemoved).toBe(0);
    expect(result.failures.length).toBeGreaterThan(0);
  });
});

describe("what the user is told", () => {
  const snap = (plugins: number, groups = 0) => ({
    gameId: "fallout4",
    capturedAt: "1970-01-01T00:00:00.000Z",
    modRules: [],
    userlist: {
      plugins: Array.from({ length: plugins }, (_, i) => ({ name: `${i}.esp` })),
      groups: Array.from({ length: groups }, (_, i) => ({ name: `g${i}` })),
    },
  });

  it("says nothing when the user had no rules of their own", () => {
    // Clearing an empty userlist is a dispatch, not an event. Telling someone
    // their rules were deleted when they had none is a scary, content-free
    // notice that teaches them to ignore the rest.
    const out = describePurge(
      { modRulesRemoved: 0, modsTouched: 0, userlistCleared: true, failures: [] },
      snap(0),
      "C:/backup.json",
    );
    expect(out).toBeUndefined();
  });

  it("names the backup, because the deletion is only safe if it is findable", () => {
    const out = describePurge(
      { modRulesRemoved: 12, modsTouched: 5, userlistCleared: true, failures: [] },
      snap(3),
      "C:/eh/rule-backups/rules-fallout4-x.json",
    );
    expect(out!.join(" ")).toContain("rules-fallout4-x.json");
    expect(out!.join(" ")).toMatch(/12 mod rule\(s\) across 5 mod\(s\)/);
    expect(out!.join(" ")).toMatch(/LOOT rules were cleared/);
  });

  it("explains WHY, not just what", () => {
    // "We deleted your rules" invites a complaint. "so what loads is exactly
    // what the curator tested" answers it in the same breath.
    const out = describePurge(
      { modRulesRemoved: 1, modsTouched: 1, userlistCleared: false, failures: [] },
      snap(0),
      undefined,
    );
    expect(out!.join(" ")).toMatch(/what the curator tested/i);
  });

  it("does not claim the rules it cleared were the USER's", () => {
    // On every install after the first, what gets cleared is the rules THIS
    // collection applied last time. "We replaced your own rules" is then both
    // false and alarming — it reports our own bookkeeping as the user's loss,
    // on every single update.
    const out = describePurge(
      { modRulesRemoved: 291, modsTouched: 140, userlistCleared: true, failures: [] },
      snap(29),
      "C:/b.json",
    );
    expect(out!.join(" ")).not.toMatch(/your own/i);
    expect(out!.join(" ")).toMatch(/only ones in place/i);
  });

  it("does not claim LOOT rules were cleared when there were none", () => {
    const out = describePurge(
      { modRulesRemoved: 4, modsTouched: 2, userlistCleared: true, failures: [] },
      snap(0),
      "C:/b.json",
    );
    expect(out!.join(" ")).not.toMatch(/LOOT rules were cleared/);
  });
});

describe("the driver's safety interlock", () => {
  // The load-bearing one. Deleting rules is acceptable ONLY because they were
  // saved first; if the backup fails, the purge must not happen, and the
  // install must carry on with the user's rules intact rather than abort.
  const read = async (rel: string): Promise<string> => {
    const fs = await import("fs");
    const path = await import("path");
    return fs.readFileSync(path.join(__dirname, rel), "utf8");
  };

  it("purges only when a backup was written", async () => {
    const src = await read("runInstall.ts");
    const backup = src.indexOf("ruleBackupPath = await writeRuleBackup(");
    const guard = src.indexOf("if (ruleBackupPath !== undefined) {");
    const purge = src.indexOf("purgeUserRuleState(api,");
    expect(backup).toBeGreaterThan(-1);
    expect(guard).toBeGreaterThan(backup);
    expect(purge).toBeGreaterThan(guard);
  });

  it("clears the user's rules BEFORE applying the collection's", async () => {
    // Applying first and clearing after would delete the rules we just wrote.
    const src = await read("runInstall.ts");
    expect(src.indexOf("purgeUserRuleState(api,")).toBeLessThan(
      src.indexOf("applyModRules({"),
    );
    expect(src.indexOf("purgeUserRuleState(api,")).toBeLessThan(
      src.indexOf("applyUserlist({"),
    );
  });

  it("writes the backup atomically and never overwrites an older one", async () => {
    // A half-written backup that looks complete is worse than none, because
    // the purge proceeds on the strength of it. And a second install must not
    // clobber the backup holding the user's ORIGINAL rules.
    const src = await read("runInstall.ts");
    const fn = src.slice(src.indexOf("async function writeRuleBackup"));
    const body = fn.slice(0, fn.indexOf("\nfunction "));
    expect(body).toMatch(/\.tmp/);
    expect(body).toMatch(/fsp\.rename\(tmp, file\)/);
    expect(body).toMatch(/snapshot\.capturedAt/);
  });

  it("surfaces the deletion rather than logging it into the void", async () => {
    const src = await read("runInstall.ts");
    expect(src).toMatch(/rulesPurgeNotice/);
    const fs = await import("fs");
    const path = await import("path");
    const steps = fs.readFileSync(
      path.join(__dirname, "..", "..", "ui", "pages", "install", "steps.tsx"),
      "utf8",
    );
    expect(steps).toMatch(/<RulesPurgeNotice[\s\S]{0,120}result\.rulesPurgeNotice/);
  });
});

describe("a scoped purge keeps the player's own rules (alasdairn, 2026-10-31)", () => {
  it("removes only rules between two collection mods and LOOT rules between two collection plugins", () => {
    const mods = {
      cotap: { attributes: { logicalFileName: "CoTaP" }, rules: [{ type: "before", reference: { id: "teob" } }] },
      teob: { attributes: { fileMD5: "md5-teob" }, rules: [{ type: "after", reference: { logicalFileName: "HisTextures" } }] },
      his: { attributes: { logicalFileName: "HisTextures" }, rules: [{ type: "after", reference: { id: "cotap" } }] },
      lady: { rules: [{ type: "after", reference: { fileMD5: "md5-teob" } }] },
    };
    const userlist = {
      plugins: [
        { name: "Collection.esp", after: ["Other Collection.esp", { name: "His Patch.esp" }] },
        { name: "His Patch.esp", after: ["Collection.esp"] },
      ],
      groups: [],
    };
    const { api, dispatched } = fakeApi(stateWith(mods, userlist));
    const snap = captureUserRuleState(api, "fallout4");
    const result = purgeUserRuleState(api, "fallout4", snap, {
      modIds: new Set(["cotap", "teob"]),
      mods,
      plugins: new Set(["collection.esp", "other collection.esp"]),
    });

    expect(result.modRulesRemoved).toBe(1); // cotap before teob
    expect(result.modRulesKept).toBe(3); // teob -> his mod, his mod's, an outside mod's
    expect(result.userlistRulesRemoved).toBe(1); // Collection.esp after Other Collection.esp
    expect(result.userlistRulesKept).toBe(2);
    expect(result.userlistCleared).toBe(false);
    expect(dispatched.some((a) => a.type === "CLEAR_USERLIST")).toBe(false);
    expect(dispatched.filter((a) => a.type === "REMOVE_USERLIST_RULE")).toEqual([
      { type: "REMOVE_USERLIST_RULE", payload: { pluginId: "Collection.esp", reference: "Other Collection.esp", type: "after" } },
    ]);
    expect(describePurge(result, snap, "C:/backup.json")?.join(" ")).toContain("5 rule(s) on your own mods and plugins were kept");
  });
});
