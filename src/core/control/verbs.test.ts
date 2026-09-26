import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { util, __testGame } from "@nexusmods/vortex-api";

vi.mock("./gameProcess", () => ({ isProcessRunning: vi.fn(async () => false) }));

import { isProcessRunning } from "./gameProcess";
import { VERBS } from "./verbs";

const running = isProcessRunning as unknown as ReturnType<typeof vi.fn>;

const OG = fs.mkdtempSync(path.join(os.tmpdir(), "eh-og-"));
const AE = fs.mkdtempSync(path.join(os.tmpdir(), "eh-ae-"));
fs.writeFileSync(path.join(AE, "Fallout4.exe"), "");
fs.writeFileSync(path.join(OG, "Fallout4.exe"), "");

type Api = ReturnType<typeof fakeVortex>["api"];

/** A Vortex that answers the events and actions the verbs use, and records their order. */
function fakeVortex() {
  const log: string[] = [];
  const deployed = { n: 5 };
  const handlers = new Map<string, Set<(...a: unknown[]) => void>>();
  const state: any = {
    settings: {
      profiles: { activeGameId: "fallout4", activeProfileId: "og" },
      gameMode: { discovered: { fallout4: { path: OG, store: "gog", executable: "Fallout4.exe" } } },
    },
    persistent: {
      profiles: {
        og: { id: "og", name: "Ivy OG", gameId: "fallout4", modState: { a: { enabled: true } } },
        ae: { id: "ae", name: "Ivy AE", gameId: "fallout4", modState: {} },
        sky: { id: "sky", name: "Meridia", gameId: "skyrimse", modState: {} },
      },
      mods: {
        fallout4: {
          a: { id: "a", state: "installed", attributes: { name: "Mod A", version: "1.0", modId: 12, fileId: 34 } },
          b: { id: "b", state: "installed", attributes: { customFileName: "Mod B" } },
        },
      },
      downloads: {
        files: {
          d1: { localPath: "a.zip", state: "finished", game: ["fallout4"] },
          d2: { localPath: "s.zip", state: "finished", game: ["skyrimse"] },
        },
      },
    },
  };
  const fire = (ev: string, ...args: unknown[]): void => handlers.get(ev)?.forEach((fn) => fn(...args));
  const api = {
    getState: () => state,
    sendNotification: vi.fn(),
    events: {
      on: (ev: string, fn: (...a: unknown[]) => void) => {
        if (!handlers.has(ev)) handlers.set(ev, new Set());
        handlers.get(ev)!.add(fn);
      },
      removeListener: (ev: string, fn: (...a: unknown[]) => void) => handlers.get(ev)?.delete(fn),
      emit: (ev: string, ...args: unknown[]) => {
        if (ev === "purge-mods") {
          log.push("purge");
          setTimeout(() => {
            deployed.n = 0;
            (args[1] as (e: unknown) => void)(null);
          });
        }
        if (ev === "deploy-mods") {
          log.push(`deploy:${String(args[1])}`);
          setTimeout(() => {
            deployed.n = 9;
            (args[0] as (e: unknown) => void)(null);
          });
        }
      },
    },
    store: {
      dispatch: (a: { type: string; payload: any }) => {
        if (a.type === "STUB_SET_MOD_ENABLED") {
          state.persistent.profiles[a.payload.profileId].modState[a.payload.modId] = { enabled: a.payload.enabled };
        }
        if (a.type === "STUB_SET_NEXT_PROFILE") {
          log.push(`profile:${a.payload}`);
          state.settings.profiles.activeProfileId = a.payload;
          setTimeout(() => fire("profile-did-change", a.payload));
        }
        if (a.type === "STUB_SET_GAME_PATH") {
          log.push(`setPath:${path.basename(a.payload.gamePath)}`);
          const d = state.settings.gameMode.discovered[a.payload.gameId];
          Object.assign(d, { path: a.payload.gamePath, store: a.payload.store });
        }
      },
    },
  };
  return { api, state, log, deployed };
}

let v: ReturnType<typeof fakeVortex>;
const run = (verb: string, body: Record<string, unknown> = {}, api: Api = v.api) => VERBS[verb]!.run(api as any, body);

beforeEach(() => {
  v = fakeVortex();
  running.mockResolvedValue(false);
  __testGame.current = { requiredFiles: ["Fallout4.exe"], executable: () => "Fallout4.exe" };
  vi.spyOn(util, "getManifest").mockImplementation((async () => ({
    files: Array.from({ length: v.deployed.n }, () => ({})),
  })) as never);
});
afterEach(() => vi.restoreAllMocks());

describe("state", () => {
  it("reports the active game, its mods with enablement, and only this game's profiles and downloads", async () => {
    const s = (await run("state")) as any;
    expect(s.gameId).toBe("fallout4");
    expect(s.game).toMatchObject({ path: OG, store: "gog", executable: "Fallout4.exe", running: false });
    expect(s.profile).toEqual({ id: "og", name: "Ivy OG" });
    expect(s.profiles.map((p: any) => p.id)).toEqual(["og", "ae"]);
    expect(s.mods).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "a", name: "Mod A", enabled: true, nexus: { modId: 12, fileId: 34 }, owner: "not-eh" }),
        expect.objectContaining({ id: "b", name: "Mod B", enabled: false }),
      ]),
    );
    expect(s.downloads.map((d: any) => d.id)).toEqual(["d1"]);
    expect(s.deployment.deployedFiles).toBe(5);
  });
});

describe("game.setPath", () => {
  it("refuses while files are still deployed, and changes nothing", async () => {
    await expect(run("game.setPath", { path: AE })).rejects.toMatchObject({ code: "not-purged" });
    expect(v.state.settings.gameMode.discovered.fallout4.path).toBe(OG);
  });

  it("refuses when a deployment manifest cannot be read (unknown is not zero)", async () => {
    v.deployed.n = 0;
    vi.spyOn(util, "getManifest").mockRejectedValue(new Error("EACCES") as never);
    await expect(run("game.setPath", { path: AE })).rejects.toMatchObject({ code: "deployment-unknown" });
  });

  it("refuses a folder without the game in it", async () => {
    v.deployed.n = 0;
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), "eh-empty-"));
    await expect(run("game.setPath", { path: empty })).rejects.toMatchObject({ code: "not-a-game-folder" });
  });

  it("refuses while the game runs, and when it cannot tell", async () => {
    v.deployed.n = 0;
    running.mockResolvedValue(true);
    await expect(run("game.setPath", { path: AE })).rejects.toMatchObject({ code: "game-running" });
    running.mockResolvedValue(undefined);
    await expect(run("game.setPath", { path: AE })).rejects.toMatchObject({ code: "game-state-unknown" });
  });

  it("repoints a purged game and records the store the caller named", async () => {
    v.deployed.n = 0;
    const r = await run("game.setPath", { path: AE, store: "steam" });
    expect(r).toMatchObject({ previousPath: OG, previousStore: "gog", path: AE, store: "steam" });
  });
});

describe("game.switchInstall", () => {
  it("purges, repoints, switches profile and deploys, in that order", async () => {
    const r = (await run("game.switchInstall", { path: AE, store: "steam", profileId: "ae" })) as any;
    expect(v.log).toEqual(["purge", "setPath:" + path.basename(AE), "profile:ae", "deploy:ae"]);
    expect(r).toMatchObject({ path: AE, profileId: "ae", steps: ["purge", "setPath", "profile", "deploy"], deployedFiles: 9 });
  });

  it("stops before repointing when the purge leaves files behind", async () => {
    v.api.events.emit = (ev: string, ...args: unknown[]) => {
      if (ev === "purge-mods") setTimeout(() => (args[1] as (e: unknown) => void)(null)); // files stay
    };
    await expect(run("game.switchInstall", { path: AE, profileId: "ae" })).rejects.toMatchObject({ code: "not-purged" });
    expect(v.state.settings.gameMode.discovered.fallout4.path).toBe(OG);
  });

  it("refuses a profile of another game before touching anything", async () => {
    await expect(run("game.switchInstall", { path: AE, profileId: "sky" })).rejects.toMatchObject({ code: "bad-profile" });
    expect(v.log).toEqual([]);
  });
});

describe("mods.setEnabled / mods.remove", () => {
  it("enables by exact id in the active profile", async () => {
    await run("mods.setEnabled", { modIds: ["b"], enabled: true });
    expect(v.state.persistent.profiles.og.modState.b).toEqual({ enabled: true });
  });

  it("changes nothing when any id is unknown", async () => {
    await expect(run("mods.setEnabled", { modIds: ["b", "nope"], enabled: true })).rejects.toMatchObject({
      code: "unknown-mods",
    });
    expect(v.state.persistent.profiles.og.modState.b).toBeUndefined();
  });

  it("removes nothing when any id is unknown", async () => {
    const remove = vi.spyOn(util, "removeMods");
    await expect(run("mods.remove", { modIds: ["a", "nope"] })).rejects.toMatchObject({ code: "unknown-mods" });
    expect(remove).not.toHaveBeenCalled();
  });

  it("removes the named mods and says whose they were", async () => {
    const remove = vi.spyOn(util, "removeMods").mockImplementation((async (_api: unknown, _g: string, ids: string[]) => {
      for (const id of ids) delete v.state.persistent.mods.fallout4[id];
    }) as never);
    const r = (await run("mods.remove", { modIds: ["a"] })) as any;
    expect(remove).toHaveBeenCalledWith(v.api, "fallout4", ["a"]);
    expect(r.removed).toEqual([{ id: "a", name: "Mod A", owner: "not-eh" }]);
    expect(r.notRemoved).toEqual([]);
  });
});
