/**
 * Knowing when ONE update has actually finished.
 *
 * The sequential bulk update is only sequential if this resolves at the right
 * moment. Resolving on someone else's install — the hazard the `acceptAny`
 * waiter carries — would hand the caller a mod it never asked about and let
 * the next install start on top of the running one.
 */
import { describe, expect, it, vi } from "vitest";

import {
  UpdateTimeout,
  installedIdentityReader,
  updateOneAndWait,
  type InstallEvents,
  type StartControls,
} from "./updateOneMod";
import type { types } from "@nexusmods/vortex-api";

/** A tiny emitter with the shape Vortex's api exposes. */
function emitter(): InstallEvents & {
  emit: (event: string, ...args: unknown[]) => void;
  count: () => number;
} {
  const handlers = new Map<string, Set<(...a: unknown[]) => void>>();
  return {
    on: (event, handler) => {
      const set = handlers.get(event) ?? new Set();
      set.add(handler);
      handlers.set(event, set);
    },
    removeListener: (event, handler) => {
      handlers.get(event)?.delete(handler);
    },
    emit: (event, ...args) => {
      for (const h of [...(handlers.get(event) ?? [])]) h(...args);
    },
    count: () => [...handlers.values()].reduce((n, s) => n + s.size, 0),
  };
}

const identity = (nexusModId: number, nexusFileId: number) => () => ({
  nexusModId,
  nexusFileId,
});

describe("waiting for the right install", () => {
  it("resolves with the new mod id once OUR mod lands", async () => {
    const events = emitter();
    const promise = updateOneAndWait({
      events,
      start: () => events.emit("did-install-mod", "skyrimse", "arc", "new-id"),
      readInstalled: identity(1090, 500),
      gameId: "skyrimse",
      nexusModId: 1090,
      toFileId: 500,
    });
    await expect(promise).resolves.toBe("new-id");
  });

  it("IGNORES an install of some other mod", async () => {
    // The hazard `acceptAny` carries. Vortex may be installing something the
    // user started; taking it would verify the wrong mod and let the next
    // update begin while ours is still writing.
    const events = emitter();
    const promise = updateOneAndWait({
      events,
      start: () => {
        events.emit("did-install-mod", "skyrimse", "arc", "someone-elses");
        events.emit("did-install-mod", "skyrimse", "arc", "ours");
      },
      readInstalled: (id) =>
        id === "ours"
          ? { nexusModId: 1090, nexusFileId: 500 }
          : { nexusModId: 999, nexusFileId: 1 },
      gameId: "skyrimse",
      nexusModId: 1090,
      toFileId: 500,
    });
    await expect(promise).resolves.toBe("ours");
  });

  it("ignores the SAME mod at the wrong file id", async () => {
    // An update to 500 is not satisfied by 499 arriving. Both halves match or
    // it is not the install we asked for.
    const events = emitter();
    const promise = updateOneAndWait({
      events,
      start: () => {
        events.emit("did-install-mod", "skyrimse", "arc", "old");
        events.emit("did-install-mod", "skyrimse", "arc", "new");
      },
      readInstalled: (id) => ({
        nexusModId: 1090,
        nexusFileId: id === "new" ? 500 : 499,
      }),
      gameId: "skyrimse",
      nexusModId: 1090,
      toFileId: 500,
    });
    await expect(promise).resolves.toBe("new");
  });

  it("ignores an install for a different game", async () => {
    const events = emitter();
    const promise = updateOneAndWait({
      events,
      start: () => {
        events.emit("did-install-mod", "fallout4", "arc", "wrong-game");
        events.emit("did-install-mod", "skyrimse", "arc", "right");
      },
      readInstalled: identity(1090, 500),
      gameId: "skyrimse",
      nexusModId: 1090,
      toFileId: 500,
    });
    await expect(promise).resolves.toBe("right");
  });

  it("listens BEFORE starting, so a fast install is not missed", async () => {
    // Vortex can finish a small mod from cache before the call that requested
    // it returns. A listener attached afterwards waits fifteen minutes for an
    // event that already fired.
    const events = emitter();
    let listenersAtStart = 0;
    const promise = updateOneAndWait({
      events,
      start: () => {
        listenersAtStart = events.count();
        events.emit("did-install-mod", "skyrimse", "arc", "id");
      },
      readInstalled: identity(1, 2),
      gameId: "skyrimse",
      nexusModId: 1,
      toFileId: 2,
    });
    await promise;
    expect(listenersAtStart).toBe(1);
  });
});

describe("not leaking, and not hanging", () => {
  it("removes its listener once resolved", async () => {
    // A run over nine hundred mods would otherwise leave nine hundred behind.
    const events = emitter();
    await updateOneAndWait({
      events,
      start: () => events.emit("did-install-mod", "skyrimse", "a", "id"),
      readInstalled: identity(1, 2),
      gameId: "skyrimse",
      nexusModId: 1,
      toFileId: 2,
    });
    expect(events.count()).toBe(0);
  });

  it("gives up rather than hanging the whole run", async () => {
    vi.useFakeTimers();
    const events = emitter();
    const promise = updateOneAndWait({
      events,
      start: () => undefined,
      readInstalled: identity(1, 2),
      gameId: "skyrimse",
      nexusModId: 1,
      toFileId: 2,
      timeoutMs: 1000,
    });
    const assertion = expect(promise).rejects.toBeInstanceOf(UpdateTimeout);
    await vi.advanceTimersByTimeAsync(1001);
    await assertion;
    expect(events.count()).toBe(0);
    vi.useRealTimers();
  });

  it("rejects immediately when already cancelled, without starting", async () => {
    const controller = new AbortController();
    controller.abort();
    const start = vi.fn();
    await expect(
      updateOneAndWait({
        events: emitter(),
        start,
        readInstalled: identity(1, 2),
        gameId: "skyrimse",
        nexusModId: 1,
        toFileId: 2,
        signal: controller.signal,
      }),
    ).rejects.toThrow("cancelled");
    expect(start).not.toHaveBeenCalled();
  });

  it("surfaces a start that threw instead of waiting on it", async () => {
    await expect(
      updateOneAndWait({
        events: emitter(),
        start: () => {
          throw new Error("nexus said no");
        },
        readInstalled: identity(1, 2),
        gameId: "skyrimse",
        nexusModId: 1,
        toFileId: 2,
      }),
    ).rejects.toThrow("nexus said no");
  });
});

describe("a start that learns more after it returned", () => {
  it("widen accepts any file of the page and restarts the clock", async () => {
    // The refused-download fallback: the user now picks the file, and the
    // wait must not expire on what was left of the direct clock.
    vi.useFakeTimers();
    try {
      const events = emitter();
      let controls: StartControls | undefined;
      const promise = updateOneAndWait({
        events,
        start: (c) => {
          controls = c;
        },
        readInstalled: identity(42, 999),
        gameId: "skyrimse",
        nexusModId: 42,
        toFileId: 500,
        timeoutMs: 1000,
      });
      await vi.advanceTimersByTimeAsync(900);
      controls!.widen({ anyFile: true, timeoutMs: 5000 });
      await vi.advanceTimersByTimeAsync(2000);
      events.emit("did-install-mod", "skyrimse", "arc", "picked");
      await expect(promise).resolves.toBe("picked");
    } finally {
      vi.useRealTimers();
    }
  });

  it("fail ends the wait with the start's own error and removes the listener", async () => {
    const events = emitter();
    const promise = updateOneAndWait({
      events,
      start: (c) => {
        queueMicrotask(() => c.fail(new Error("Download not finished")));
      },
      readInstalled: identity(1, 2),
      gameId: "skyrimse",
      nexusModId: 1,
      toFileId: 2,
    });
    await expect(promise).rejects.toThrow("Download not finished");
    expect(events.count()).toBe(0);
  });
});

describe("reading back what Vortex installed", () => {
  const state = (mods: Record<string, unknown>): types.IState =>
    ({ persistent: { mods: { skyrimse: mods } } }) as unknown as types.IState;

  it("reads the Nexus pair off the mod's attributes", () => {
    const read = installedIdentityReader(
      () => state({ m: { attributes: { modId: 1090, fileId: 500 } } }),
      "skyrimse",
    );
    expect(read("m")).toEqual({ nexusModId: 1090, nexusFileId: 500 });
  });

  it("coerces the string form Vortex sometimes stores", () => {
    const read = installedIdentityReader(
      () => state({ m: { attributes: { modId: "7", fileId: "8" } } }),
      "skyrimse",
    );
    expect(read("m")).toEqual({ nexusModId: 7, nexusFileId: 8 });
  });

  it("returns undefined for a mod Vortex does not have", () => {
    expect(
      installedIdentityReader(() => state({}), "skyrimse")("nope"),
    ).toBeUndefined();
  });

  it("READS THE STATE AT CALL TIME, not when it was built", () => {
    // The bug this signature exists to prevent. The caller built the reader
    // once, before the run, from `api.getState()` — and Redux state is
    // immutable, so every later lookup searched a state in which the mod
    // Vortex had just installed did not exist. The identity check failed on
    // the right mod, `did-install-mod` was discarded as somebody else's, and
    // the bulk update stopped after one mod for fifteen silent minutes.
    let live = state({});
    const read = installedIdentityReader(() => live, "skyrimse");

    // Built before the mod exists — exactly the real ordering.
    expect(read("new-mod")).toBeUndefined();

    live = state({ "new-mod": { attributes: { modId: 187578, fileId: 799404 } } });
    expect(read("new-mod")).toEqual({
      nexusModId: 187578,
      nexusFileId: 799404,
    });
  });
});
