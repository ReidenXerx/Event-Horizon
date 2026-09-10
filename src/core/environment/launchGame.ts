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
 * patcher that make vanilla exe works with script extending inside". New Vegas
 * is started through its own executable, which the NVSE patcher makes load the
 * extender.
 * ──────────────────────────────────────────────────────────────────────
 */

import * as fsp from "fs/promises";
import * as path from "path";

import { selectors } from "@nexusmods/vortex-api";
import type { types } from "@nexusmods/vortex-api";

import { ehLog } from "../logging/ehLog";
import { scriptExtenderFor } from "../manifest/externalDependencies";
import { blockingChecks } from "./environmentChecks";
import { runEnvironmentPreflight } from "./preflight";
import { gatherPreflightFacts } from "./vortexEnvironment";

/** Games started through their own executable. See the module docblock. */
export const LAUNCHES_GAME_EXECUTABLE: ReadonlySet<string> = new Set(["falloutnv"]);

export type LaunchTarget =
  | {
      kind: "ok";
      executable: string;
      cwd: string;
      via: "script-extender" | "game-executable";
      label: string;
    }
  | { kind: "refused"; title: string; lines: string[]; steps: string[] };

const VORTEX_PLAY_WARNING =
  "Do not use Vortex's Play button for this collection: it can start the game without the script extender and not tell you.";

export function chooseLaunchTarget(input: {
  gameId: string;
  gameName: string;
  gameDir: string;
  executable: string | undefined;
  exeExists: boolean;
  scriptExtender: { name: string; loader: string; instructionsUrl: string } | undefined;
  loaderExists: boolean;
}): LaunchTarget {
  if (LAUNCHES_GAME_EXECUTABLE.has(input.gameId)) {
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
  const se = input.scriptExtender;
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
  const name = (err as { name?: unknown; constructor?: { name?: unknown } })?.name;
  const ctor = (err as { constructor?: { name?: unknown } })?.constructor?.name;
  return [name, ctor].some((n) => n === "UserCanceled" || n === "ProcessCanceled");
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
    gameId,
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
    const started = (): void => {
      if (settled) return;
      settled = true;
      resolve({ kind: "started", executable: target.executable, via: target.via });
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
          ehLog("info", "play.spawned", { gameId, executable: target.executable, pid });
          started();
        },
        onExit: (code: number | null) => {
          // A loader exits as soon as it has started the game; a non-zero code
          // here is the loader failing, which is worth having in the log.
          ehLog(code === 0 ? "info" : "warn", "play.exit", { gameId, executable: target.executable, code });
        },
      })
      .then(started)
      .catch((err: unknown) => {
        if (isCancellation(err)) {
          ehLog("info", "play.cancelled", { gameId, error: String(err) });
          if (!settled) {
            settled = true;
            resolve({ kind: "cancelled" });
          }
          return;
        }
        ehLog("error", "play.failed", { gameId, executable: target.executable, error: String(err) });
        if (!settled) {
          settled = true;
          reject(err instanceof Error ? err : new Error(String(err)));
        }
      });
  });
}

export { VORTEX_PLAY_WARNING };
