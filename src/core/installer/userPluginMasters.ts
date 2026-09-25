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
  return out;
}
