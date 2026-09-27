/**
 * Files a FOMOD installer creates only when certain plugins are present.
 *
 * `conditionalFileInstalls` can hang a file on plugin files: Reapers' RobCo
 * Munitions patches install a 5.45mm leveled-list file only when one of 26
 * 5.45mm weapon plugins is active. Ivy 1.0.36 ships none of them, so a correct
 * install never creates that file, but the curator's staging had it from an
 * older install. The player's check then reported the mod "could not be
 * reproduced" (alasdairn, 2026-09-28).
 *
 * Owner poll, 2026-09-28: warn the curator at build time, explain it to the
 * player, and keep the file in the record (nothing is silently dropped).
 */

import type { FomodCondition } from "./fomodReplay";

/** A plugin's state as FOMOD asks it: active, installed but off, or not there. */
export type PluginState = "Active" | "Inactive" | "Missing";

/** Whether a condition holds for these flags and plugins. */
export function evaluateCondition(
  c: FomodCondition,
  flags: Readonly<Record<string, string>>,
  pluginState: (file: string) => PluginState,
): boolean {
  switch (c.kind) {
    case "file":
      return pluginState(c.file).toLowerCase() === c.state.trim().toLowerCase();
    case "flag":
      return (flags[c.flag] ?? "").trim().toLowerCase() === c.value.trim().toLowerCase();
    case "all":
      return c.terms.every((t) => evaluateCondition(t, flags, pluginState));
    case "any":
      return c.terms.some((t) => evaluateCondition(t, flags, pluginState));
  }
}

/** The plugins a condition wants active, for the sentence a person reads. */
export function pluginsWanted(c: FomodCondition): string[] {
  const out = new Set<string>();
  const walk = (x: FomodCondition): void => {
    if (x.kind === "file" && x.state.trim().toLowerCase() === "active") out.add(x.file);
    if (x.kind === "all" || x.kind === "any") x.terms.forEach(walk);
  };
  walk(c);
  return [...out].sort();
}

/**
 * The file's recorded condition, checked against the player's plugins:
 * true when NONE of the plugins it needs is active, so the installer could not
 * have created it. `needs` is the curator-side list (any one of them, since the
 * patterns that caused this are Or lists).
 */
export function installerConditionUnmet(
  needs: readonly string[],
  isActive: (plugin: string) => boolean,
): boolean {
  return needs.length > 0 && !needs.some((p) => isActive(p.toLowerCase()));
}

/** "needs A.esp" / "needs one of A.esp, B.esp and 24 more". */
export function describeNeeds(needs: readonly string[]): string {
  if (needs.length === 1) return `needs ${needs[0]}`;
  const shown = needs.slice(0, 3).join(", ");
  return needs.length > 3 ? `needs one of ${shown} and ${needs.length - 3} more` : `needs one of ${shown}`;
}
