/**
 * Two contracts with Vortex that its typings cannot state.
 *
 * `purge-mods` takes (allowFallback, callback) — read out of app.asar. The
 * deploy-mods event takes its callback FIRST, and emitting it the other way
 * round cost two testers a crash (see deployEventContract.test.ts). So the
 * double here THROWS on any other shape rather than tolerating it: a double
 * that agrees with the code cannot falsify the code.
 */
import { describe, expect, it } from "vitest";

import { gameExecutable, purgeGameDeployment, readDiscovery } from "./vortexEnvironment";

function vortexLikeEvents(outcome: Error | null) {
  const emits: unknown[][] = [];
  return {
    emits,
    api: {
      events: {
        emit: (event: string, ...args: unknown[]): boolean => {
          emits.push([event, ...args]);
          if (event !== "purge-mods") throw new Error(`unexpected event ${event}`);
          const [allowFallback, callback] = args;
          if (typeof allowFallback !== "boolean" || typeof callback !== "function") {
            throw new TypeError("purge-mods expects (allowFallback: boolean, callback: function)");
          }
          setTimeout(() => (callback as (e: Error | null) => void)(outcome), 0);
          return true;
        },
      },
    },
  };
}

describe("purgeGameDeployment", () => {
  it("emits (false, callback) and resolves when Vortex calls back with null", async () => {
    const { api, emits } = vortexLikeEvents(null);
    await expect(purgeGameDeployment(api)).resolves.toBeUndefined();
    expect(emits).toHaveLength(1);
    // No fallback purge: a purge that failed normally must stop the install.
    expect(emits[0]?.[1]).toBe(false);
  });

  it("rejects with Vortex's error", async () => {
    const { api } = vortexLikeEvents(new Error("files were changed outside Vortex"));
    await expect(purgeGameDeployment(api)).rejects.toThrow(/changed outside Vortex/);
  });
});

describe("readDiscovery / gameExecutable", () => {
  const state = (discovered: Record<string, unknown>, known: unknown[] = []) => ({
    settings: { gameMode: { discovered: { fallout4: discovered } } },
    session: { gameMode: { known } },
  });

  it("reads Vortex's discovery record", () => {
    expect(readDiscovery(state({ path: "E:/Fallout 4", store: "steam", pathSetManually: true }), "fallout4")).toEqual({
      path: "E:/Fallout 4",
      store: "steam",
      pathSetManually: true,
    });
    expect(readDiscovery({}, "fallout4")).toEqual({});
  });

  it("prefers the discovered executable, then falls back to the known-game list", () => {
    const s = state({ path: "E:/Fallout 4", executable: "Fallout4VR.exe" }, [{ id: "fallout4", executable: "Fallout4.exe" }]);
    expect(gameExecutable(s, "fallout4", readDiscovery(s, "fallout4"))).toBe("Fallout4VR.exe");
    const t = state({ path: "E:/Fallout 4" }, [{ id: "fallout4", executable: "Fallout4.exe" }]);
    expect(gameExecutable(t, "fallout4", readDiscovery(t, "fallout4"))).toBe("Fallout4.exe");
    expect(gameExecutable(state({ path: "x" }), "fallout4", { path: "x" })).toBeUndefined();
  });
});
