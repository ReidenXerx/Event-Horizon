/**
 * The masters of the user's OWN plugins, for the re-pin (see keepMastersAbove
 * in repinPluginOrder).
 *
 * The state this extension reads (`session.plugins.pluginList`, `loadOrder`)
 * carries no masters: the bundled gamebryo-plugin-management keeps them in its
 * own parse cache and in component props (read from its index.cjs, Vortex
 * 2.7). So they are read here, from the
 * file Vortex lists for each plugin, and only for plugins the collection does
 * not own: those are the ones that can end up above a collection plugin they
 * depend on. A plugin we cannot read is simply absent, and keeps LOOT's slot.
 */
import { readPluginList } from "../curator/pluginPool";
import { readPluginHeader } from "../manifest/pluginMasters";
import type { UserPluginMasters } from "./repinPluginOrder";

const key = (name: string): string => name.trim().toLowerCase();

export async function readUserPluginMasters(
  state: unknown,
  curatorNames: readonly string[],
): Promise<UserPluginMasters> {
  const owned = new Set(curatorNames.map(key));
  const out: Record<string, string[]> = {};
  for (const p of readPluginList(state)) {
    if (p.isNative || owned.has(key(p.name)) || p.filePath === undefined) continue;
    try {
      const read = await readPluginHeader(p.filePath, undefined);
      if (read.kind === "ok" && read.masters.length > 0) out[key(p.name)] = [...read.masters];
    } catch {
      // Unreadable is the same answer as unknown: LOOT's slot stands.
    }
  }
  addPlayerRules(state, owned, out);
  return out;
}

/**
 * The player's own LOOT "load after" rules (Vortex's `state.userlist`, which
 * the Plugins tab writes and LOOT's Sort honours), for every rule with one of
 * the player's plugins on either side. A rule between two of the collection's
 * own plugins is left out: re-applying the curator's order means that order.
 */
function addPlayerRules(state: unknown, owned: ReadonlySet<string>, out: Record<string, string[]>): void {
  const plugins = (state as { userlist?: { plugins?: unknown } } | undefined)?.userlist?.plugins;
  if (!Array.isArray(plugins)) return;
  for (const entry of plugins as Array<{ name?: unknown; after?: unknown }>) {
    if (typeof entry?.name !== "string" || !Array.isArray(entry.after)) continue;
    const self = key(entry.name);
    for (const ref of entry.after as unknown[]) {
      const name = typeof ref === "string" ? ref : (ref as { name?: unknown } | undefined)?.name;
      if (typeof name !== "string" || name.trim() === "") continue;
      if (owned.has(self) && owned.has(key(name))) continue;
      const list = (out[self] ??= []);
      if (!list.some((m) => key(m) === key(name))) list.push(name);
    }
  }
}
