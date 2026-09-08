/**
 * The argument order of `deploy-mods`, pinned against Vortex's real contract.
 *
 * ─── THE CRASH THIS EXISTS TO PREVENT ───────────────────────────────────────
 * Vortex registers the handler as, verbatim from `app.asar`:
 *
 *     events.on("deploy-mods", (callback, profileId, progressCB, deployOptions) =>
 *       callback.called || deploymentTimer.runNow(callback, …))
 *
 * The callback is FIRST. Every one of Vortex's own call sites agrees —
 * `emit("deploy-mods", cb)`, `emit("deploy-mods", ()=>{})`,
 * `emit("deploy-mods", cb, void 0, void 0, {...})`.
 *
 * We passed `(profileId, callback)`. Vortex took our profile-id STRING as its
 * callback and pushed it into the deployment debouncer, whose `schedule`
 * rejects `undefined` and `null` but not a string. On settle:
 *
 *     invokeCallbacks(localCallbacks, err) {
 *       localCallbacks.forEach((cb) => cb(err));   // TypeError: cb is not a function
 *
 * Vortex showed "An unrecoverable error occurred". Two testers, two machines,
 * both about thirty seconds after a SUCCESSFUL install — because the deploy
 * did run, and the crash is what happened when it finished.
 *
 * A type signature cannot catch this: `emit` is variadic `...args: any[]`.
 * Nothing but an assertion on the emitted arguments can.
 */
import { describe, expect, it } from "vitest";

import type { types } from "@nexusmods/vortex-api";

import { deployAndWait } from "./runInstall";

type Emitted = { event: string; args: unknown[] };

/** An api that records emits and answers `did-deploy` for the given profile. */
function recordingApi(profileId: string): {
  api: types.IExtensionApi;
  emits: Emitted[];
} {
  const emits: Emitted[] = [];
  const listeners = new Map<string, ((...a: unknown[]) => void)[]>();
  const api = {
    getState: () => ({
      settings: { profiles: { activeProfileId: profileId } },
      persistent: { mods: { skyrimse: {} } },
    }),
    events: {
      on: (evt: string, fn: (...a: unknown[]) => void) => {
        const l = listeners.get(evt) ?? [];
        l.push(fn);
        listeners.set(evt, l);
      },
      removeListener: (evt: string, fn: (...a: unknown[]) => void) => {
        const l = (listeners.get(evt) ?? []).filter((x) => x !== fn);
        listeners.set(evt, l);
      },
      emit: (event: string, ...args: unknown[]) => {
        emits.push({ event, args });
        if (event === "deploy-mods") {
          // Behave the way Vortex does: hand the FIRST argument to the
          // debouncer and call it when the deployment settles.
          const cb = args[0];
          setTimeout(() => {
            (cb as (e: null) => void)(null);
          }, 0);
        }
      },
    },
  } as unknown as types.IExtensionApi;
  return { api, emits };
}

describe("the deploy-mods event contract", () => {
  it("emits the CALLBACK first and the profile id second", async () => {
    const { api, emits } = recordingApi("prof-1");
    await deployAndWait(api, "prof-1");

    const deploy = emits.find((e) => e.event === "deploy-mods");
    expect(deploy).toBeDefined();
    // The exact assertion that fails on the bug: Vortex calls args[0] as a
    // function, so args[0] MUST be one.
    expect(typeof deploy!.args[0]).toBe("function");
    expect(deploy!.args[1]).toBe("prof-1");
  });

  it("survives Vortex invoking that first argument, as it really does", async () => {
    // The stub above calls `args[0](null)`. With the arguments the wrong way
    // round that is `"prof-1"(null)` — the TypeError the testers saw.
    const { api } = recordingApi("prof-1");
    await expect(deployAndWait(api, "prof-1")).resolves.toBeUndefined();
  });

  it("refuses to deploy a profile this run did not fill", async () => {
    // Deploying whatever Vortex happens to have active re-links a profile the
    // run has nothing to do with, and reports success for a collection whose
    // files were never linked into the game folder.
    const { api, emits } = recordingApi("someone-elses-profile");
    await expect(deployAndWait(api, "prof-1")).rejects.toThrow(
      /active profile changed/i,
    );
    expect(emits.find((e) => e.event === "deploy-mods")).toBeUndefined();
  });
});
