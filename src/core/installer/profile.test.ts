/**
 * Tests for the profile spine.
 *
 * This module had no test file at all, which is why three of its four exported
 * functions could turn into silent no-ops without anything noticing:
 * `api.store` is OPTIONAL on Vortex's typings, and every dispatch here went
 * through `api.store?.dispatch(...)`. When the store is absent that reads as
 * "enable this mod" and does nothing, for every mod, with no error — the exact
 * shape of a real report ("Event Horizon installed them but they are all still
 * disabled").
 *
 * So the assertions below are about the two things that were unobservable:
 * that the dispatch actually happens when it can, and that its ABSENCE is
 * reported when it cannot.
 *
 * Why spy on `vortexLog` rather than on `ehLog`: `ehLog` is called through an
 * imported binding, so replacing the export on the module object does not
 * intercept the call. `ehLog`'s own second sink is `vortexLog`, which IS
 * mockable, and asserting on it proves the whole path ran rather than that a
 * spy was installed.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

import * as vortexApi from "@nexusmods/vortex-api";
import type { types } from "@nexusmods/vortex-api";

import {
  createFreshProfile,
  disableModInProfile,
  enableModInProfile,
  pickNonCollidingName,
  switchToProfile,
} from "./profile";

type Dispatched = { type: string; payload?: unknown };

function apiWithStore(state: unknown): {
  api: types.IExtensionApi;
  dispatched: Dispatched[];
} {
  const dispatched: Dispatched[] = [];
  const api = {
    getState: () => state,
    store: { dispatch: (a: Dispatched) => dispatched.push(a) },
    events: { on: () => undefined, removeListener: () => undefined },
  } as unknown as types.IExtensionApi;
  return { api, dispatched };
}

function apiWithoutStore(state: unknown): types.IExtensionApi {
  return {
    getState: () => state,
    // store deliberately absent — this is the shape the bug wore.
    events: { on: () => undefined, removeListener: () => undefined },
  } as unknown as types.IExtensionApi;
}

/** Log lines this call produced, as `[level, event]` pairs. */
function logCalls(spy: ReturnType<typeof vi.spyOn>): string[][] {
  return spy.mock.calls.map((c) => [String(c[0]), String(c[1])]);
}

describe("enableModInProfile", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(vortexApi, "log").mockImplementation(() => undefined);
    // Re-spying an already-spied method returns the SAME spy with its call
    // history intact, so without this the next test finds the previous test's
    // line and passes against the wrong evidence. (It did.)
    logSpy.mockClear();
  });

  it("dispatches setModEnabled(true) when there is a store", () => {
    const { api, dispatched } = apiWithStore({});
    enableModInProfile(api, "profile-1", "mod-a");
    expect(dispatched).toEqual([
      { type: "STUB_SET_MOD_ENABLED", payload: { profileId: "profile-1", modId: "mod-a", enabled: true } },
    ]);
  });

  it("reports, rather than silently doing nothing, when there is no store", () => {
    enableModInProfile(apiWithoutStore({}), "profile-1", "mod-a");
    // The spy MUST have been called — an assertion that only checks the
    // absence of a throw would pass against the old silent version.
    expect(logSpy).toHaveBeenCalled();
    expect(logCalls(logSpy)).toContainEqual(["error", "[Event Horizon] profile.enable.no-store"]);
  });
});

describe("disableModInProfile", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(vortexApi, "log").mockImplementation(() => undefined);
    // Re-spying an already-spied method returns the SAME spy with its call
    // history intact, so without this the next test finds the previous test's
    // line and passes against the wrong evidence. (It did.)
    logSpy.mockClear();
  });

  it("dispatches setModEnabled(false) when there is a store", () => {
    const { api, dispatched } = apiWithStore({});
    disableModInProfile(api, "profile-1", "mod-a");
    expect(dispatched).toEqual([
      { type: "STUB_SET_MOD_ENABLED", payload: { profileId: "profile-1", modId: "mod-a", enabled: false } },
    ]);
  });

  it("reports when there is no store", () => {
    disableModInProfile(apiWithoutStore({}), "profile-1", "mod-a");
    expect(logSpy).toHaveBeenCalled();
    expect(logCalls(logSpy)).toContainEqual(["error", "[Event Horizon] profile.disable.no-store"]);
  });
});

describe("createFreshProfile", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(vortexApi, "log").mockImplementation(() => undefined);
    // Re-spying an already-spied method returns the SAME spy with its call
    // history intact, so without this the next test finds the previous test's
    // line and passes against the wrong evidence. (It did.)
    logSpy.mockClear();
  });

  it("records the profile it created, and that the wanted name was free", () => {
    const { api, dispatched } = apiWithStore({ persistent: { profiles: {} } });
    const created = createFreshProfile(api, "skyrimse", "EH - Meridia");

    expect(created.name).toBe("EH - Meridia");
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]!.type).toBe("STUB_SET_PROFILE");

    const call = logSpy.mock.calls.find(
      (c) => c[1] === "[Event Horizon] profile.created",
    );
    expect(call).toBeDefined();
    expect(call![2]).toMatchObject({
      name: "EH - Meridia",
      suggestedName: "EH - Meridia",
      nameCollided: false,
      gameId: "skyrimse",
      dispatched: true,
    });
  });

  it("records that the name COLLIDED when a profile already had it", () => {
    // The collision is the interesting case: a renamed profile means a
    // previous install of the same collection is still there, which is most
    // of the answer to "why is there a second one?".
    const state = {
      persistent: {
        profiles: {
          old: { id: "old", gameId: "skyrimse", name: "EH - Meridia" },
        },
      },
    };
    const { api } = apiWithStore(state);
    const created = createFreshProfile(api, "skyrimse", "EH - Meridia");

    expect(created.name).toBe("EH - Meridia (2)");
    const call = logSpy.mock.calls.find(
      (c) => c[1] === "[Event Horizon] profile.created",
    );
    expect(call![2]).toMatchObject({
      name: "EH - Meridia (2)",
      suggestedName: "EH - Meridia",
      nameCollided: true,
    });
  });

  it("says the profile was NOT created when there is no store", () => {
    createFreshProfile(apiWithoutStore({ persistent: { profiles: {} } }), "skyrimse", "EH - X");
    const call = logSpy.mock.calls.find(
      (c) => c[1] === "[Event Horizon] profile.created",
    );
    expect(call![0]).toBe("error");
    expect(call![2]).toMatchObject({ dispatched: false });
  });
});

describe("switchToProfile", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(vortexApi, "log").mockImplementation(() => undefined);
    // Re-spying an already-spied method returns the SAME spy with its call
    // history intact, so without this the next test finds the previous test's
    // line and passes against the wrong evidence. (It did.)
    logSpy.mockClear();
  });

  it("says it skipped, rather than returning silently, when already active", async () => {
    const api = apiWithoutStore({
      settings: { profiles: { activeProfileId: "p-1" } },
    });
    await switchToProfile(api, "p-1");
    expect(logCalls(logSpy)).toContainEqual([
      "info",
      "[Event Horizon] profile.switch.skipped",
    ]);
  });

  it("logs the budget and the mod count it was sized from, then the result", async () => {
    const handlers: ((id: string) => void)[] = [];
    const dispatched: Dispatched[] = [];
    const api = {
      getState: () => ({
        settings: { profiles: { activeProfileId: "p-0" } },
        persistent: { mods: { skyrimse: { a: {}, b: {}, c: {} } } },
      }),
      store: {
        dispatch: (a: Dispatched) => {
          dispatched.push(a);
          // Vortex answers a setNextProfile with profile-did-change; the stub
          // does the same so the switch completes instead of timing out.
          for (const h of [...handlers]) h("p-1");
        },
      },
      events: {
        on: (_evt: string, h: (id: string) => void) => handlers.push(h),
        removeListener: (_evt: string, h: (id: string) => void) => {
          const i = handlers.indexOf(h);
          if (i >= 0) handlers.splice(i, 1);
        },
      },
    } as unknown as types.IExtensionApi;

    await switchToProfile(api, "p-1");

    expect(dispatched.map((d) => d.type)).toEqual(["STUB_SET_NEXT_PROFILE"]);

    const start = logSpy.mock.calls.find(
      (c) => c[1] === "[Event Horizon] profile.switch.start",
    );
    expect(start).toBeDefined();
    expect(start![2]).toMatchObject({ from: "p-0", to: "p-1" });
    // A budget that is not a number is the hard-coded-ceiling regression.
    expect(typeof (start![2] as { budgetMs: unknown }).budgetMs).toBe("number");

    // And an END. A start with no end is the shape that reads as "still
    // running" to anyone holding only the log.
    expect(logCalls(logSpy)).toContainEqual([
      "info",
      "[Event Horizon] profile.switch.ok",
    ]);
  });

  it("names the profile that was activated when it is not the one we wanted", async () => {
    // The decisive line for "why did Event Horizon end up in another
    // profile": Vortex activated something else while we were waiting.
    const handlers: ((id: string) => void)[] = [];
    const api = {
      getState: () => ({ settings: { profiles: { activeProfileId: "p-0" } } }),
      store: {
        dispatch: () => {
          for (const h of [...handlers]) h("someone-elses-profile");
        },
      },
      events: {
        on: (_evt: string, h: (id: string) => void) => handlers.push(h),
        removeListener: (_evt: string, h: (id: string) => void) => {
          const i = handlers.indexOf(h);
          if (i >= 0) handlers.splice(i, 1);
        },
      },
    } as unknown as types.IExtensionApi;

    const controller = new AbortController();
    const promise = switchToProfile(api, "p-1", controller.signal);
    controller.abort();
    await expect(promise).rejects.toThrow();

    const call = logSpy.mock.calls.find(
      (c) => c[1] === "[Event Horizon] profile.switch.other-profile-activated",
    );
    expect(call).toBeDefined();
    expect(call![2]).toMatchObject({
      waitingFor: "p-1",
      activated: "someone-elses-profile",
    });
  });
});

describe("pickNonCollidingName", () => {
  it("returns the base name when nothing holds it", () => {
    const state = { persistent: { profiles: {} } } as unknown as types.IState;
    expect(pickNonCollidingName(state, "skyrimse", "EH - A")).toBe("EH - A");
  });

  it("ignores profiles belonging to a DIFFERENT game", () => {
    // Profile names only have to be unique per game; treating another game's
    // profile as a collision would rename for no reason and make the
    // `nameCollided` signal above lie about a previous install.
    const state = {
      persistent: {
        profiles: { x: { id: "x", gameId: "fallout4", name: "EH - A" } },
      },
    } as unknown as types.IState;
    expect(pickNonCollidingName(state, "skyrimse", "EH - A")).toBe("EH - A");
  });
});
