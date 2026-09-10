/**
 * Play starts the script extender or refuses. The one thing this must never
 * do is what Vortex's Play does: quietly start the bare game executable when
 * the loader is not there. New Vegas is the curator's stated exception.
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { __testPaths } from "@nexusmods/vortex-api";
import { chooseLaunchTarget, launchGame } from "./launchGame";

const F4SE = { name: "Fallout 4 Script Extender (F4SE)", loader: "f4se_loader.exe", instructionsUrl: "https://f4se.silverlock.org/" };

describe("chooseLaunchTarget", () => {
  const base = {
    gameId: "fallout4",
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
    expect(chooseLaunchTarget({ ...base, gameId: "unknown", scriptExtender: undefined }).kind).toBe("refused");
  });

  it("starts New Vegas through its own executable", () => {
    const t = chooseLaunchTarget({ ...base, gameId: "falloutnv", executable: "FalloutNV.exe", scriptExtender: undefined, loaderExists: false });
    expect(t).toMatchObject({ kind: "ok", via: "game-executable", label: "FalloutNV.exe" });
  });
});

describe("launchGame", () => {
  let tmp: string;
  let game: string;
  const originalDocs = __testPaths.documentsPath;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "eh-play-"));
    game = path.join(tmp, "Fallout 4");
    fs.mkdirSync(game, { recursive: true });
    fs.writeFileSync(path.join(game, "Fallout4.exe"), "not really an exe");
    __testPaths.documentsPath = path.join(tmp, "Documents");
    const prefs = path.join(tmp, "Documents", "My Games", "Fallout4", "Fallout4Prefs.ini");
    fs.mkdirSync(path.dirname(prefs), { recursive: true });
    fs.writeFileSync(prefs, "");
  });
  afterEach(() => {
    __testPaths.documentsPath = originalDocs;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  const api = (activeGameId: string, run: (exe: string, args: string[], options: Record<string, unknown>) => Promise<void>) => {
    const runExecutable = vi.fn(run);
    return {
      runExecutable,
      api: {
        getState: () => ({
          settings: {
            profiles: { activeGameId },
            gameMode: { discovered: { fallout4: { path: game, store: "steam" } } },
          },
          session: { gameMode: { known: [{ id: "fallout4", name: "Fallout 4", executable: "Fallout4.exe" }] } },
        }),
        runExecutable,
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

  it("refuses when the game has never been started (preflight blocks)", async () => {
    fs.writeFileSync(path.join(game, "f4se_loader.exe"), "loader");
    fs.unlinkSync(path.join(tmp, "Documents", "My Games", "Fallout4", "Fallout4Prefs.ini"));
    const { api: a, runExecutable } = api("fallout4", async () => undefined);
    const outcome = await launchGame(a, "fallout4");
    expect(outcome.kind === "refused" ? outcome.title : "").toMatch(/never been started/);
    expect(runExecutable).not.toHaveBeenCalled();
  });

  it("starts the loader from the game folder and asks Vortex to deploy first", async () => {
    fs.writeFileSync(path.join(game, "f4se_loader.exe"), "loader");
    const { api: a, runExecutable } = api("fallout4", async (_exe, _args, options) => {
      (options["onSpawned"] as (pid: number) => void)(4242);
    });
    const outcome = await launchGame(a, "fallout4");
    expect(outcome).toEqual({ kind: "started", executable: path.join(game, "f4se_loader.exe"), via: "script-extender" });
    expect(runExecutable).toHaveBeenCalledTimes(1);
    const [exe, args, options] = runExecutable.mock.calls[0]!;
    expect(exe).toBe(path.join(game, "f4se_loader.exe"));
    expect(args).toEqual([]);
    expect(options).toMatchObject({ cwd: game, suggestDeploy: true, detach: true });
  });

  it("treats a cancelled deploy prompt as cancelled, not as an error", async () => {
    fs.writeFileSync(path.join(game, "f4se_loader.exe"), "loader");
    class UserCanceled extends Error {}
    const { api: a } = api("fallout4", async () => {
      throw new UserCanceled("canceled");
    });
    expect(await launchGame(a, "fallout4")).toEqual({ kind: "cancelled" });
  });
});
