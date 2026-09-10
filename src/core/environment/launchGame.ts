/**
 * ──────────────────────────────────────────────────────────────────────
 * Play — through the script extender, or not at all.
 *
 * Vortex's own Play button starts whatever executable its tool list has as
 * primary, and when that is not set up it quietly starts the vanilla game
 * executable instead. A script-extender collection started that way loads
 * with every SKSE/F4SE plugin inert and says nothing — testers reported
 * "broken collection" for a game that was simply started the wrong way.
 *
 * So Event Horizon's Play starts the extender's loader and nothing else. No
 * loader → it refuses and says why; it never falls back to the game exe.
 *
 * The one exception is the curator's: "excluding fnv bc there is specific
 * patcher that make vanilla exe works with script extending inside". It is a
 * field on the NVSE probe (`launchesGameExecutable`), not a list here.
 *
 * ─── WHAT VORTEX DOES WITH runExecutable (read from app.asar) ───────────
 *  - The promise settles when the process CLOSES, and a start hook that
 *    throws ProcessCanceled (a deploy prompt that failed) is swallowed into a
 *    RESOLVE. So a resolve without a spawn is "did not start", not success.
 *  - `onSpawned(child.pid)` fires straight after spawn(), before an async
 *    ENOENT/EACCES error arrives — with an undefined pid when it failed.
 *  - Vortex's own starter dispatches `setToolRunning` in onSpawned; that is
 *    what starts its ProcessMonitor, which is what stops a deploy or purge
 *    running under a live game. runExecutable alone does not, so we do.
 * ──────────────────────────────────────────────────────────────────────
 */

import * as fsp from "fs/promises";
import * as path from "path";

import { actions, selectors } from "@nexusmods/vortex-api";
import type { types } from "@nexusmods/vortex-api";

import { ehLog } from "../logging/ehLog";
import { scriptExtenderFor } from "../manifest/externalDependencies";
import { blockingChecks } from "./environmentChecks";
import { runEnvironmentPreflight } from "./preflight";
import { gatherPreflightFacts } from "./vortexEnvironment";

export type LaunchTarget =
  | {
      kind: "ok";
      executable: string;
      cwd: string;
      via: "script-extender" | "game-executable";
      label: string;
    }
  | { kind: "refused"; title: string; lines: string[]; steps: string[] };

export const VORTEX_PLAY_WARNING =
  "Do not use Vortex's Play button for this collection: it can start the game without the script extender and not tell you.";

type ScriptExtender = NonNullable<ReturnType<typeof scriptExtenderFor>>;

export function chooseLaunchTarget(input: {
  gameName: string;
  gameDir: string;
  executable: string | undefined;
  exeExists: boolean;
  scriptExtender: ScriptExtender | undefined;
  loaderExists: boolean;
}): LaunchTarget {
  const se = input.scriptExtender;
  if (se?.launchesGameExecutable === true) {
    if (input.executable !== undefined && input.exeExists) {
      return {
        kind: "ok",
        executable: path.join(input.gameDir, input.executable),
        cwd: input.gameDir,
        via: "game-executable",
        label: input.executable,
      };
    }
    return {
      kind: "refused",
      title: `${input.gameName}'s executable was not found.`,
      lines: [`Looked for ${input.executable ?? "(unknown executable)"} in ${input.gameDir}`],
      steps: [`Check the ${input.gameName} folder set in Vortex → Games.`],
    };
  }
  if (se === undefined) {
    return {
      kind: "refused",
      title: `Event Horizon only starts games through a script extender, and it knows none for ${input.gameName}.`,
      lines: [],
      steps: [],
    };
  }
  if (!input.loaderExists) {
    return {
      kind: "refused",
      title: `${se.name} is not in the ${input.gameName} folder.`,
      lines: [
        `Event Horizon starts ${input.gameName} only through ${se.loader}, and it is not in ${input.gameDir}.`,
        "Starting the game without it loads the collection with every script-extender plugin switched off, and nothing tells you.",
      ],
      steps: [
        `If the collection is installed and deployed, deploy again in Vortex; otherwise install ${se.name} from ${se.instructionsUrl}.`,
        VORTEX_PLAY_WARNING,
      ],
    };
  }
  return {
    kind: "ok",
    executable: path.join(input.gameDir, se.loader),
    cwd: input.gameDir,
    via: "script-extender",
    label: se.loader,
  };
}

export type LaunchOutcome =
  | { kind: "started"; executable: string; via: "script-extender" | "game-executable" }
  | { kind: "refused"; title: string; lines: string[]; steps: string[] }
  | { kind: "cancelled" };

async function isFile(p: string): Promise<boolean> {
  try {
    return (await fsp.stat(p)).isFile();
  } catch {
    return false;
  }
}

function isCancellation(err: unknown): boolean {
  const name = (err as { name?: unknown })?.name;
  const ctor = (err as { constructor?: { name?: unknown } })?.constructor?.name;
  return [name, ctor].some((n) => n === "UserCanceled" || n === "ProcessCanceled");
}

function runningTools(state: unknown): string[] {
  const running = (state as { session?: { base?: { toolsRunning?: Record<string, unknown> } } })?.session?.base
    ?.toolsRunning;
  return running !== undefined && running !== null ? Object.keys(running) : [];
}

export async function launchGame(api: types.IExtensionApi, gameId: string): Promise<LaunchOutcome> {
  const state = api.getState();
  const refuse = (title: string, lines: string[], steps: string[]): LaunchOutcome => {
    ehLog("warn", "play.refused", { gameId, title, lines, steps });
    return { kind: "refused", title, lines, steps };
  };

  const active = selectors.activeGameId(state);
  const facts = gatherPreflightFacts({ state, gameId });
  if (active !== gameId) {
    return refuse(
      `Vortex is managing ${active ?? "no game"} right now, not ${facts.gameName}.`,
      ["Play deploys the active game before starting it, so it has to be this one."],
      [`Switch Vortex to ${facts.gameName}, then press Play again.`],
    );
  }
  const running = runningTools(state);
  if (running.length > 0) {
    return refuse(
      "A game or tool started from Vortex is still running.",
      [`Running: ${running.join(", ")}`],
      ["Close it first — starting a second copy, or deploying under a running game, breaks both."],
    );
  }

  const report = await runEnvironmentPreflight(facts, { scanFolder: false, context: "play" });
  const blocked = blockingChecks(report.checks);
  if (blocked.length > 0) {
    const first = blocked[0]!;
    return refuse(first.title, [...first.lines, ...blocked.slice(1).map((c) => c.title)], first.steps);
  }
  const gameDir = report.gameDir;
  if (gameDir === undefined) {
    return refuse(`Vortex has no folder for ${facts.gameName}.`, [], []);
  }

  const se = scriptExtenderFor(gameId);
  const target = chooseLaunchTarget({
    gameName: facts.gameName,
    gameDir,
    executable: facts.executable,
    exeExists: facts.executable !== undefined && (await isFile(path.join(gameDir, facts.executable))),
    scriptExtender: se,
    loaderExists: se !== undefined && (await isFile(path.join(gameDir, se.loader))),
  });
  if (target.kind === "refused") return refuse(target.title, target.lines, target.steps);

  ehLog("info", "play.start", { gameId, executable: target.executable, cwd: target.cwd, via: target.via });
  return new Promise<LaunchOutcome>((resolve, reject) => {
    let settled = false;
    const settle = (outcome: LaunchOutcome | Error): void => {
      if (settled) return;
      settled = true;
      if (outcome instanceof Error) reject(outcome);
      else resolve(outcome);
    };
    api
      .runExecutable(target.executable, [], {
        cwd: target.cwd,
        // Vortex asks to deploy first when deployment is out of date — the
        // same prompt its own Play button shows.
        suggestDeploy: true,
        detach: true,
        shell: false,
        onSpawned: (pid?: number) => {
          if (typeof pid !== "number" || pid <= 0) {
            // spawn() failed; the error is on its way. Not started.
            ehLog("warn", "play.spawn-without-pid", { gameId, executable: target.executable });
            return;
          }
          ehLog("info", "play.spawned", { gameId, executable: target.executable, pid });
          const setToolRunning = (actions as unknown as {
            setToolRunning?: (exePath: string, started: number, exclusive: boolean) => unknown;
          }).setToolRunning;
          if (typeof setToolRunning === "function") {
            api.store?.dispatch(setToolRunning(target.executable, Date.now(), true) as never);
          }
          settle({ kind: "started", executable: target.executable, via: target.via });
        },
        onExit: (code: number | null) => {
          // A loader exits as soon as it has started the game; a non-zero code
          // here is the loader failing, which is worth having in the log.
          ehLog(code === 0 ? "info" : "warn", "play.exit", { gameId, executable: target.executable, code });
        },
      })
      .then(() => {
        if (!settled) {
          // Resolved without ever spawning: a start hook was cancelled and Vortex swallowed it.
          ehLog("warn", "play.not-started", { gameId, executable: target.executable });
          settle({ kind: "cancelled" });
        }
      })
      .catch((err: unknown) => {
        if (isCancellation(err)) {
          ehLog("info", "play.cancelled", { gameId, error: String(err) });
          settle({ kind: "cancelled" });
          return;
        }
        ehLog("error", "play.failed", { gameId, executable: target.executable, error: String(err) });
        settle(err instanceof Error ? err : new Error(String(err)));
      });
  });
}
