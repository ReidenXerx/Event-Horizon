/**
 * Plugins the shipped load order names that the package does not provide.
 *
 * ─── THE CASE THIS WAS WRITTEN FOR ──────────────────────────────────────
 * Measured on a real published package (Meridia 1.0.23, 1,597 plugins): the
 * order names `synthesis.esp`, `dynamiccontainerloot.esp` and
 * `meridia_addn_index_fixes.esp`, and no mod in the collection ships any of
 * them. They are the curator's own generated output, distributed by hand
 * through links on the collection page — a deliberate arrangement — but the
 * package neither carries them nor asks for them, so Event Horizon never
 * mentioned them to anyone. A player who does not follow those links ends up
 * with a load order missing a Synthesis patch, silently.
 *
 * ─── WHY THE EXISTING GATE DID NOT CATCH IT ─────────────────────────────
 * `gateOnMasters` asks whether the plugins that EXIST have the masters they
 * declare. That is a different question from whether the package provides the
 * plugins its own order names, and the second one had no check at all.
 *
 * It WARNS and never refuses (owner poll, 2026-09-22): shipping output files
 * by hand is a real, chosen workflow, and refusing would have blocked every
 * build of a collection that works.
 */

import { isBaseGameMaster, isCreationClubMaster } from "./pluginMasters";
import { toPosix } from "../paths/modPath";
import type { EhcollManifest } from "../../types/ehcoll";

const basename = (p: string): string => {
  const posix = toPosix(p);
  return posix.slice(posix.lastIndexOf("/") + 1);
};

const PLUGIN = /\.(esp|esm|esl)$/i;

/**
 * Load-order entries no mod in the package provides, lowercased.
 *
 * The game's own masters and Creation Club files are excluded: they are
 * supposed to come from the game, not from the collection.
 */
export function unprovidedPlugins(
  manifest: Pick<EhcollManifest, "game" | "mods" | "plugins">,
): string[] {
  const order = manifest.plugins?.order ?? [];
  if (order.length === 0) return [];

  const provided = new Set<string>();
  for (const mod of manifest.mods) {
    for (const file of mod.state.stagingFiles ?? []) {
      const name = basename(file.path).toLowerCase();
      if (PLUGIN.test(name)) provided.add(name);
    }
  }

  const out: string[] = [];
  for (const entry of order) {
    const name = (typeof entry === "string" ? entry : entry.name).toLowerCase();
    if (name === "" || provided.has(name)) continue;
    if (isBaseGameMaster(name, manifest.game.id) || isCreationClubMaster(name)) continue;
    out.push(name);
  }
  return out;
}

/** What the CURATOR is told, at build time. Empty when there is nothing to say. */
export function describeUnprovidedPlugins(names: readonly string[]): string[] {
  if (names.length === 0) return [];
  const shown = names.slice(0, 8);
  return [
    `${names.length} plugin(s) in this collection's load order are not shipped by any mod in ` +
      `it: ${shown.join(", ")}${names.length > shown.length ? `, and ${names.length - shown.length} more` : ""}. ` +
      `That is normal for output you distribute yourself — a Synthesis or LOD patch, your own ` +
      `merges — and it means players only get them if they follow your instructions. Anyone who ` +
      `does not ends up with a load order missing those files, and nothing in the install says so.`,
  ];
}

/** What the PLAYER is told, on the Done screen. */
export function describeMissingFromPackage(names: readonly string[]): string[] {
  if (names.length === 0) return [];
  const shown = names.slice(0, 8);
  return [
    `${names.length} plugin(s) in this collection's load order are not part of the package: ` +
      `${shown.join(", ")}${names.length > shown.length ? `, and ${names.length - shown.length} more` : ""}. ` +
      `The curator distributes those separately — their collection page says where to get them. ` +
      `Your load order has a place for each one; until you add them, those places are empty.`,
  ];
}
