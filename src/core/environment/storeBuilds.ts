/**
 * Game builds that are one release on different stores.
 *
 * Skyrim SE's last update is 1.6.1170 on Steam and 1.6.1179 on GOG: the same
 * game, numbered apart. A collection built on either runs on both, with the
 * store-specific DLLs picked per store at install. Comparing the numbers
 * alone told a Steam player that a GOG curator's revision needs a newer game
 * that Steam never shipped (leadsheet, Meridia Rev 12, 2026-10-16).
 */

/** The newest build each store ships, per Vortex game id. */
export const STORE_BUILDS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  skyrimse: { steam: "1.6.1170.0", gog: "1.6.1179.0" },
};

const numeric = (v: string): string | undefined => {
  const m = /^\s*(\d+(?:\.\d+)*)/.exec(v);
  if (m === null) return undefined;
  const parts = m[1]!.split(".").map(Number);
  while (parts.length > 3 && parts[parts.length - 1] === 0) parts.pop();
  return parts.join(".");
};

/**
 * Every store's number for the release `version` is, itself included in the
 * table's spelling. Empty when `version` is not one of the twinned builds.
 */
export function storeTwinsOf(gameId: string, version: string): string[] {
  const builds = Object.values(STORE_BUILDS[gameId] ?? {});
  const v = numeric(version);
  if (v === undefined || !builds.some((b) => numeric(b) === v)) return [];
  return [...builds];
}
