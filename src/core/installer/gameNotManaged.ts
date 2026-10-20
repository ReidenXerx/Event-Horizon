/**
 * "You need to manage a game before installing this mod" is Vortex refusing
 * EVERY install, not this one: it finds no folder recorded for the game
 * (discovery path empty), or no active profile at all. A player who moved
 * Steam out of Program Files (2026-10-19, Meridia) got it for each mod while
 * Event Horizon blamed the extractor, the connection or the disk after eight.
 * The first one is the answer, so the install stops there and names it.
 */

const MARKERS = ["you need to manage a game", "you need to select a game"];

export function isGameNotManaged(err: unknown): boolean {
  const msg =
    err instanceof Error
      ? err.message
      : typeof err === "string"
        ? err
        : String((err as { message?: unknown })?.message ?? "");
  const lower = msg.toLowerCase();
  return MARKERS.some((m) => lower.includes(m));
}

export function describeGameNotManaged(opts: {
  modName: string;
  atIndex: number;
  total: number;
  gameName: string;
  /** The folder Vortex has for the game right now; undefined = none. */
  discoveredPath: string | undefined;
}): string {
  const where =
    opts.discoveredPath === undefined
      ? `Vortex has no folder recorded for ${opts.gameName} any more`
      : `Vortex did not accept ${opts.gameName} at ${opts.discoveredPath}`;
  return (
    `Stopped at mod ${opts.atIndex} of ${opts.total} ("${opts.modName}"): ` +
    `Vortex says "You need to manage a game before installing this mod". ${where}, ` +
    `so every remaining mod would fail the same way. This usually follows moving the game ` +
    `(or Steam) to another folder. It is not your extractor, connection or disk. ` +
    `In Vortex open Games, find ${opts.gameName} and click "Manage" (or "Manually set location" ` +
    `and pick the folder with the game's .exe), make it the active game, then press Continue ` +
    `on the collection: mods already installed are kept.`
  );
}
