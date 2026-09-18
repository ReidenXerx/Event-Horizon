/**
 * Two contracts with Vortex that its typings cannot state.
 *
 * `purge-mods` takes (allowFallback, callback) — read out of app.asar. The
 * deploy-mods event takes its callback FIRST, and emitting it the other way
 * round cost two testers a crash (see deployEventContract.test.ts). So the
 * double here THROWS on any other shape rather than tolerating it: a double
 * that agrees with the code cannot falsify the code.
 */
import { describe, expect, it, vi } from "vitest";

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

  it("gives up when the callback never comes, instead of waiting forever", async () => {
    /**
     * `emit` returns nothing, so the callback is the ONLY thing that can
     * settle this promise. A purge-mods with no listener, or a handler that
     * throws before calling back, used to leave it pending forever — the
     * driver wrapped its own purge in a budget for exactly this reason and
     * the clean-game path before an install did not.
     *
     * Not a cap on how long a purge may take: the caller sizes it from the
     * mod count, the same budget the deploy uses.
     */
    const api = { events: { emit: (): void => undefined } };
    vi.useFakeTimers();
    try {
      const p = purgeGameDeployment(api, { timeoutMs: 1_000 });
      const assertion = expect(p).rejects.toThrow(/did not answer the purge within 1s/);
      await vi.advanceTimersByTimeAsync(1_100);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it("still waits with no budget, which is what the driver's own wrapper relies on", async () => {
    const api = { events: { emit: (): void => undefined } };
    vi.useFakeTimers();
    try {
      let settled = false;
      void purgeGameDeployment(api).then(
        () => (settled = true),
        () => (settled = true),
      );
      await vi.advanceTimersByTimeAsync(60 * 60_000);
      expect(settled).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("ignores a callback that arrives after it gave up", async () => {
    // Vortex answering late must not resolve a promise already rejected, and
    // must not throw an unhandled anything.
    let late: ((err: unknown) => void) | undefined;
    const api = {
      events: {
        emit: (_e: string, _allow: unknown, cb: (err: unknown) => void): void => {
          late = cb;
        },
      },
    };
    vi.useFakeTimers();
    try {
      const p = purgeGameDeployment(api, { timeoutMs: 1_000 });
      const assertion = expect(p).rejects.toThrow(/did not answer/);
      await vi.advanceTimersByTimeAsync(1_100);
      await assertion;
      expect(() => late?.(null)).not.toThrow();
    } finally {
      vi.useRealTimers();
    }
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
