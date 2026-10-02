/**
 * The call, not the value.
 *
 * Every bug this cycle lived one level above where the tests looked: the hash
 * cache was covered and its caller was not; the fingerprint was covered and
 * its wiring was not. `choicesFor` being right proves nothing about whether
 * anyone hands its result to Vortex — and the listener wrapper is a
 * transparent `(...args) => cb(...args)` shim, so a mistake here is silent:
 * Vortex installs with default options while the code looks like it replayed.
 *
 * So this asserts the emitted call itself, against the signature observed from
 * Vortex's own install:
 *
 *   start-install-download(downloadId, { allowAutoEnable, choices }, cb)
 */
import { EventEmitter } from "events";

import { describe, expect, it } from "vitest";

import { installFromExistingDownload } from "./modInstall";
import type { types } from "@nexusmods/vortex-api";

type Emitted = { event: string; args: unknown[] };

/**
 * A Vortex double that records emits and completes the install.
 *
 * `did-install-mod` is fired on the next tick because that is the real order:
 * the driver subscribes, emits, and only then does Vortex report back.
 */
function fakeApi(gameId: string, archiveId: string): {
  api: types.IExtensionApi;
  emitted: Emitted[];
} {
  const events = new EventEmitter();
  const emitted: Emitted[] = [];
  const realEmit = events.emit.bind(events);

  (events as unknown as { emit: (e: string, ...a: unknown[]) => boolean }).emit = (
    event: string,
    ...args: unknown[]
  ): boolean => {
    emitted.push({ event, args });
    if (event === "start-install-download") {
      setTimeout(() => realEmit("did-install-mod", gameId, archiveId, "new-mod-id"), 0);
    }
    return realEmit(event, ...args);
  };

  return {
    api: { events, getState: () => ({}) } as unknown as types.IExtensionApi,
    emitted,
  };
}

const choices = {
  type: "fomod",
  options: [
    { name: "Choose Options", groups: [{ name: "Patches", choices: [{ name: "AFT", idx: 2 }] }] },
  ],
};

describe("start-install-download call shape", () => {
  it("passes the curator's choices in the options bag Vortex expects", async () => {
    const { api, emitted } = fakeApi("fallout4", "dl-1");

    const result = await installFromExistingDownload(api, {
      gameId: "fallout4",
      archiveId: "dl-1",
      choices,
    });
    expect(result.vortexModId).toBe("new-mod-id");

    const call = emitted.find((e) => e.event === "start-install-download")!;
    expect(call.args[0]).toBe("dl-1");
    expect(call.args[1]).toEqual({
      allowAutoEnable: true,
      choices,
      unattended: true,
    });
    // Vortex passes a callback of its own; it is the only failure channel.
    expect(typeof call.args[2]).toBe("function");
  });

  it("leaves Vortex's defaults alone when a mod has no choices, but still passes the callback", async () => {
    // The other 840 mods in a collection must install exactly as before:
    // no options bag. The callback is what lets a refusal come back.
    const { api, emitted } = fakeApi("fallout4", "dl-2");

    await installFromExistingDownload(api, { gameId: "fallout4", archiveId: "dl-2" });

    const call = emitted.find((e) => e.event === "start-install-download")!;
    expect(call.args.slice(0, 2)).toEqual(["dl-2", undefined]);
    expect(typeof call.args[2]).toBe("function");
  });

  it("surfaces a refusal of a mod WITHOUT choices too (2026-10-02 hang)", async () => {
    // A FOMOD that refused on moduleDependencies left an agent's install op
    // running forever: the no-choices call carried no callback.
    const events = new EventEmitter();
    (events as unknown as { emit: (e: string, ...a: unknown[]) => boolean }).emit = ((
      event: string,
      ...args: unknown[]
    ): boolean => {
      if (event === "start-install-download") {
        const cb = args[2] as (err: Error) => void;
        setTimeout(() => cb(new Error("Installer reported errors: requires DX Adventurer Outfit.esp")), 0);
      }
      return true;
    }) as never;
    const api = { events, getState: () => ({}) } as unknown as types.IExtensionApi;

    await expect(
      installFromExistingDownload(api, { gameId: "fallout4", archiveId: "dl-4" }),
    ).rejects.toThrow(/requires DX Adventurer Outfit\.esp/);
  });

  it("surfaces a refusal through the callback instead of hanging", async () => {
    // Without the callback a refused install sits until the 90s stall
    // watchdog, and the real reason is discarded.
    const events = new EventEmitter();
    (events as unknown as { emit: (e: string, ...a: unknown[]) => boolean }).emit = ((
      event: string,
      ...args: unknown[]
    ): boolean => {
      if (event === "start-install-download") {
        const cb = args[2] as (err: Error) => void;
        setTimeout(() => cb(new Error("installer refused")), 0);
      }
      return true;
    }) as never;
    const api = { events, getState: () => ({}) } as unknown as types.IExtensionApi;

    await expect(
      installFromExistingDownload(api, {
        gameId: "fallout4",
        archiveId: "dl-3",
        choices,
      }),
    ).rejects.toThrow(/installer refused/);
  });
});
