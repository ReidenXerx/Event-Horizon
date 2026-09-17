/**
 * Play starts the script extender or refuses. The one thing this must never
 * do is what Vortex's Play does: quietly start the bare game executable when
 * the loader is not there. New Vegas is the curator's stated exception.
 *
 * And it must never claim a start that did not happen: Vortex's runExecutable
 * swallows a cancelled start hook into a resolve, and calls onSpawned without
 * a pid when spawn() failed (both read out of app.asar).
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { __testPaths, actions } from "@nexusmods/vortex-api";
import { chooseLaunchTarget, launchGame } from "./launchGame";

const F4SE = {
  name: "Fallout 4 Script Extender (F4SE)",
  loader: "f4se_loader.exe",
  instructionsUrl: "https://f4se.silverlock.org/",
  launchesGameExecutable: false,
};

describe("chooseLaunchTarget", () => {
  const base = {
    gameName: "Fallout 4",
    gameDir: "E:/Games/Fallout 4",
    executable: "Fallout4.exe",
    exeExists: true,
    scriptExtender: F4SE,
    loaderExists: true,
  };

  it("starts the loader", () => {
    expect(chooseLaunchTarget(base)).toMatchObject({ kind: "ok", via: "script-extender", label: "f4se_loader.exe" });
  });

  it("refuses without the loader — even though the game exe is right there", () => {
    const t = chooseLaunchTarget({ ...base, loaderExists: false });
    expect(t.kind).toBe("refused");
    expect(t.kind === "refused" ? t.steps.join(" ") : "").toMatch(/Vortex's Play/);
  });

  it("refuses for a game with no known script extender", () => {
    expect(chooseLaunchTarget({ ...base, scriptExtender: undefined }).kind).toBe("refused");
  });

  it("starts New Vegas through its own executable, because its probe says so", () => {
    const t = chooseLaunchTarget({
      ...base,
      executable: "FalloutNV.exe",
      scriptExtender: { name: "NVSE", loader: "nvse_loader.exe", instructionsUrl: "x", launchesGameExecutable: true },
      loaderExists: false,
    });
    expect(t).toMatchObject({ kind: "ok", via: "game-executable", label: "FalloutNV.exe" });
  });
});

describe("launchGame", () => {
  let tmp: string;
  let game: string;
  let prefs: string;
  const originalDocs = __testPaths.documentsPath;
  const stubActions = actions as unknown as Record<string, unknown>;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "eh-play-"));
    game = path.join(tmp, "Fallout 4");
    fs.mkdirSync(game, { recursive: true });
    fs.writeFileSync(path.join(game, "Fallout4.exe"), "not really an exe");
    __testPaths.documentsPath = path.join(tmp, "Documents");
    prefs = path.join(tmp, "Documents", "My Games", "Fallout4", "Fallout4Prefs.ini");
    fs.mkdirSync(path.dirname(prefs), { recursive: true });
    // What Fallout 4's launcher writes: hardware settings.
    fs.writeFileSync(prefs, "[Display]\niSize W=1920\niSize H=1080\n");
    stubActions["setToolRunning"] = (exePath: string, started: number, exclusive: boolean) => ({
      type: "SET_TOOL_RUNNING",
      payload: { exePath, started, exclusive },
    });
  });
  afterEach(() => {
    __testPaths.documentsPath = originalDocs;
    delete stubActions["setToolRunning"];
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  const api = (
    activeGameId: string,
    run: (exe: string, args: string[], options: Record<string, unknown>) => Promise<void>,
    toolsRunning: Record<string, unknown> = {},
  ) => {
    const runExecutable = vi.fn(run);
    const dispatch = vi.fn();
    return {
      runExecutable,
      dispatch,
      api: {
        getState: () => ({
          settings: {
            profiles: { activeGameId },
            gameMode: { discovered: { fallout4: { path: game, store: "steam" } } },
          },
          session: {
            base: { toolsRunning },
            gameMode: { known: [{ id: "fallout4", name: "Fallout 4", executable: "Fallout4.exe" }] },
          },
        }),
        runExecutable,
        store: { dispatch },
      } as never,
    };
  };

  it("never runs anything when the loader is missing", async () => {
    const { api: a, runExecutable } = api("fallout4", async () => undefined);
    const outcome = await launchGame(a, "fallout4");
    expect(outcome.kind).toBe("refused");
    expect(runExecutable).not.toHaveBeenCalled();
  });

  it("refuses when Vortex is managing a different game", async () => {
    fs.writeFileSync(path.join(game, "f4se_loader.exe"), "loader");
    const { api: a, runExecutable } = api("skyrimse", async () => undefined);
    expect((await launchGame(a, "fallout4")).kind).toBe("refused");
    expect(runExecutable).not.toHaveBeenCalled();
  });

  it("refuses while a game or tool Vortex started is still running", async () => {
    fs.writeFileSync(path.join(game, "f4se_loader.exe"), "loader");
    const { api: a, runExecutable } = api("fallout4", async () => undefined, { "fallout4.exe": { pid: 1 } });
    const outcome = await launchGame(a, "fallout4");
    expect(outcome.kind === "refused" ? outcome.title : "").toMatch(/still running/);
    expect(runExecutable).not.toHaveBeenCalled();
  });

  it("refuses when the game has never been started (preflight blocks)", async () => {
    fs.writeFileSync(path.join(game, "f4se_loader.exe"), "loader");
    fs.unlinkSync(prefs);
    const { api: a, runExecutable } = api("fallout4", async () => undefined);
    const outcome = await launchGame(a, "fallout4");
    expect(outcome.kind === "refused" ? outcome.title : "").toMatch(/never been started/);
    expect(runExecutable).not.toHaveBeenCalled();
  });

  it("refuses when the settings file exists but was not written by the launcher", async () => {
    fs.writeFileSync(path.join(game, "f4se_loader.exe"), "loader");
    fs.writeFileSync(prefs, "[Archive]\nbInvalidateOlderFiles=1\n");
    const { api: a, runExecutable } = api("fallout4", async () => undefined);
    const outcome = await launchGame(a, "fallout4");
    expect(outcome.kind === "refused" ? outcome.title : "").toMatch(/not created by the game/);
    expect(runExecutable).not.toHaveBeenCalled();
  });

  // The Discord player, 2026-09-16: Steam moved Fallout 4 to next-gen and F4SE exited with code 1, unexplained.
  it("refuses before starting a game whose version no longer fits the collection on the active profile", async () => {
    fs.writeFileSync(path.join(game, "f4se_loader.exe"), "loader");
    const appDataPath = path.join(tmp, "AppData");
    const { serializeReceipt, getReceiptPath } = await import("../installLedger");
    const receipt = {
      schemaVersion: 1,
      packageId: "0456490d-525b-49e3-92d2-5c6e617990be",
      packageVersion: "1.0.32",
      packageName: "Ivy's Panties - Event Horizon",
      gameId: "fallout4",
      installedAt: "2026-09-17T00:00:00.000Z",
      vortexProfileId: "profile-ivy",
      vortexProfileName: "Ivy",
      installTargetMode: "fresh-profile",
      mods: [],
      gameVersion: { required: "1.10.163.0", policy: "exact" },
    };
    const file = getReceiptPath(appDataPath, receipt.packageId);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, serializeReceipt(receipt as never));
    const runExecutable = vi.fn(async () => undefined);
    const a = {
      getState: () => ({
        settings: {
          profiles: { activeGameId: "fallout4", activeProfileId: "profile-ivy" },
          gameMode: { discovered: { fallout4: { path: game, store: "steam", version: "1.10.984.0" } } },
        },
        session: { base: { toolsRunning: {} }, gameMode: { known: [{ id: "fallout4", name: "Fallout 4", executable: "Fallout4.exe" }] } },
      }),
      runExecutable,
      store: { dispatch: vi.fn() },
    } as never;
    const outcome = await launchGame(a, "fallout4", { appDataPath });
    expect(outcome.kind === "refused" ? outcome.title : outcome.kind).toBe(
      "Fallout 4 is version 1.10.984.0, but Ivy's Panties - Event Horizon was built for 1.10.163.0.",
    );
    expect(runExecutable).not.toHaveBeenCalled();
  });

  it("starts the loader from the game folder, asks Vortex to deploy first, and tells Vortex it runs", async () => {
    fs.writeFileSync(path.join(game, "f4se_loader.exe"), "loader");
    const { api: a, runExecutable, dispatch } = api("fallout4", async (_exe, _args, options) => {
      (options["onSpawned"] as (pid: number) => void)(4242);
    });
    const outcome = await launchGame(a, "fallout4");
    expect(outcome).toEqual({ kind: "started", executable: path.join(game, "f4se_loader.exe"), via: "script-extender" });
    const [exe, args, options] = runExecutable.mock.calls[0]!;
    expect(exe).toBe(path.join(game, "f4se_loader.exe"));
    expect(args).toEqual([]);
    expect(options).toMatchObject({ cwd: game, suggestDeploy: true, detach: true });
    // Vortex's own starter does this; without it deploy/purge run under a live game.
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ type: "SET_TOOL_RUNNING", payload: expect.objectContaining({ exePath: path.join(game, "f4se_loader.exe"), exclusive: true }) }),
    );
  });

  it("treats a cancelled deploy prompt as cancelled, not as an error", async () => {
    fs.writeFileSync(path.join(game, "f4se_loader.exe"), "loader");
    class UserCanceled extends Error {}
    const { api: a } = api("fallout4", async () => {
      throw new UserCanceled("canceled");
    });
    expect(await launchGame(a, "fallout4")).toEqual({ kind: "cancelled" });
  });

  it("does not claim a start when Vortex resolves without ever spawning", async () => {
    fs.writeFileSync(path.join(game, "f4se_loader.exe"), "loader");
    const { api: a, dispatch } = api("fallout4", async () => undefined);
    expect(await launchGame(a, "fallout4")).toEqual({ kind: "cancelled" });
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("does not claim a start when spawn failed (no pid), and reports the error", async () => {
    fs.writeFileSync(path.join(game, "f4se_loader.exe"), "loader");
    const { api: a, dispatch } = api("fallout4", async (_exe, _args, options) => {
      (options["onSpawned"] as (pid?: number) => void)(undefined);
      throw Object.assign(new Error("spawn EACCES"), { code: "EACCES" });
    });
    await expect(launchGame(a, "fallout4")).rejects.toThrow(/EACCES/);
    expect(dispatch).not.toHaveBeenCalled();
  });
});
