/**
 * Where the game loads each active plugin, for diagnose.setup's master-after
 * check.
 *
 * The order is plugins.txt on disk, which the game reads. Vortex's loadOrder
 * number is not it: a plugin enabled before Vortex listed it keeps loadOrder
 * -1 (its SET_PLUGIN_ENABLED reducer), so it sorted FIRST and OSize.esp
 * (plugins.txt line 2009) "loaded before" OStim.esp (line 607) on alasdairn's
 * PC, 11-28. State order only places what the file lacks, after the file.
 */
export function loadPositions(
  enabled: ReadonlyArray<{ name: string; isNative?: boolean; loadOrder?: number }>,
  pluginsTxt: ReadonlyArray<{ name: string }> | undefined,
): Map<string, number> {
  const rank = (p: { loadOrder?: number }): number =>
    p.loadOrder !== undefined && p.loadOrder >= 0 ? p.loadOrder : Number.MAX_SAFE_INTEGER;
  const byState = [...enabled].sort((a, b) => rank(a) - rank(b));
  const fileIndex = new Map((pluginsTxt ?? []).map((e, i) => [e.name.toLowerCase(), i]));
  return new Map(
    byState.map((p, i) => {
      const id = p.name.toLowerCase();
      return [id, p.isNative === true ? -1 : (fileIndex.get(id) ?? fileIndex.size + i)];
    }),
  );
}

/**
 * Whether `dependant` loads before its `master`. The game loads every master
 * file (ESM flag, or a .esm/.esl name) before every non-master, wherever it is
 * listed; the ESL flag alone moves nothing (OSize.esp is ESL-flagged only).
 * Natives (position -1) always load first.
 */
export function loadsBeforeMaster(
  dependant: string,
  master: string,
  position: ReadonlyMap<string, number>,
  isMasterFlagged: (name: string) => boolean | undefined,
): boolean {
  const at = position.get(master.toLowerCase());
  if (at === undefined || at === -1) return false;
  const me = position.get(dependant.toLowerCase()) ?? 0;
  const block = (name: string): number => ((isMasterFlagged(name) ?? /\.es[ml]$/i.test(name)) ? 0 : 1);
  const mb = block(master);
  const db = block(dependant);
  return mb > db || (mb === db && at > me);
}
