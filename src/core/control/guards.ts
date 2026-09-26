/**
 * The control channel's refusals, as pure decisions.
 *
 * The owner chose "trusted + guards" (poll, 2026-09-26): commands run without
 * a click, so these rules are the only thing standing between an agent's
 * mistake and the owner's setup. Each one is enforced, not advised.
 */

export type GuardResult = { ok: true } | { ok: false; code: string; message: string };

const OK: GuardResult = { ok: true };
const refuse = (code: string, message: string): GuardResult => ({ ok: false, code, message });

/**
 * Anything that changes the game folder (deploy, purge, a game-folder change,
 * installs that deploy) waits for the game to close. Hardlinks change Data
 * live, so a deploy under a running game edits the files it has open.
 *
 * `running === undefined` is "could not tell". That refuses too unless the
 * caller explicitly says the game is closed: a guard that cannot see the
 * process list must not wave a deploy through on its own.
 */
export function guardGameClosed(args: {
  running: boolean | undefined;
  exeName: string | undefined;
  assumeGameClosed?: boolean;
}): GuardResult {
  const exe = args.exeName ?? "the game";
  if (args.running === true) {
    return refuse("game-running", `${exe} is running. Close the game first: this command changes its Data folder.`);
  }
  if (args.running === undefined && args.assumeGameClosed !== true) {
    return refuse(
      "game-state-unknown",
      `Could not tell whether ${exe} is running. Retry with "assumeGameClosed": true only if you know it is closed.`,
    );
  }
  return OK;
}

/**
 * The game folder may only change while nothing is deployed into it.
 * Vortex's own "Manually set location" repoints without purging (verified in
 * app.asar, `browseGameLocation`), which strands every hardlink in the old
 * folder. Here the check is the deployment manifests themselves, not a flag
 * saying a purge happened once.
 */
export function guardSetGamePath(args: {
  deployedFiles: number | undefined;
  newPath: string;
  newPathExists: boolean;
  missingRequiredFiles: readonly string[];
  currentPath: string | undefined;
}): GuardResult {
  if (args.deployedFiles === undefined) {
    return refuse("deployment-unknown", "Could not read the deployment manifests, so the purge cannot be confirmed.");
  }
  if (args.deployedFiles > 0) {
    return refuse(
      "not-purged",
      `${args.deployedFiles} files are still deployed into the current game folder. Purge first (or use game.switchInstall, which does).`,
    );
  }
  if (!args.newPathExists) return refuse("path-missing", `No folder at ${args.newPath}.`);
  if (args.missingRequiredFiles.length > 0) {
    return refuse(
      "not-a-game-folder",
      `${args.newPath} is missing the game's required files: ${args.missingRequiredFiles.join(", ")}.`,
    );
  }
  if (args.currentPath !== undefined && samePath(args.currentPath, args.newPath)) {
    return refuse("same-path", `The game already points at ${args.newPath}.`);
  }
  return OK;
}

/**
 * Mods are named by exact id; nothing is inferred. Every id must exist in
 * the game's pool, or nothing is removed: a typo must not turn a batch into
 * a partial change (or removal) the caller did not plan.
 */
export function guardKnownMods(args: {
  requested: readonly string[];
  pool: ReadonlySet<string>;
}): GuardResult {
  if (args.requested.length === 0) return refuse("no-mods", "No mod ids given.");
  const unknown = args.requested.filter((id) => !args.pool.has(id));
  if (unknown.length > 0) {
    return refuse("unknown-mods", `Not in this game's mod pool (nothing was changed): ${unknown.join(", ")}.`);
  }
  return OK;
}

export function samePath(a: string, b: string): boolean {
  const norm = (p: string): string => p.replace(/[\\/]+$/, "").replace(/\//g, "\\").toLowerCase();
  return norm(a) === norm(b);
}
