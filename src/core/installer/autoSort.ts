/**
 * ──────────────────────────────────────────────────────────────────────
 * Vortex's automatic plugin sorting must be off before a collection install.
 *
 * The sibling of `autoDeploy`, and for a sharper reason.
 *
 * ─── WHAT IT UNDOES ────────────────────────────────────────────────────
 * A collection's load order is the curator's, and reproducing it is most of
 * what this tool does. The install spends its last minutes on exactly that:
 * pin the curator's order, let LOOT sort, then RE-PIN the collection's plugins
 * into the slots LOOT gave them. On a real 979-mod install that took 364
 * misordered plugins to zero.
 *
 * Vortex's `autoSort` runs LOOT whenever the plugin list changes. It is on by
 * DEFAULT — `settings.plugins.autoSort` is initialised `true` in Vortex's own
 * bundle — so unless the user has turned it off, every one of those changes
 * re-imposes LOOT's answer over the curator's. The curator's order is not
 * wrong; it is a different answer to a question LOOT also has an opinion
 * about, and the whole point of installing a collection is to get theirs.
 *
 * ─── WHY IT IS NOT MERELY UNTIDY ───────────────────────────────────────
 * It is silent and it is late. Every file still verifies, every hash matches,
 * the receipt is clean — and the game loads a different order than the curator
 * tested. That is the same shape as the auto-deploy failure: nothing errors,
 * and nothing downstream can see it.
 *
 * It also strikes AFTER the install, whenever the user next enables a plugin
 * or deploys, which is why telling them once during the run is not enough and
 * the setting has to actually change.
 *
 * ─── OFFERED, NOT DONE ─────────────────────────────────────────────────
 * Same rule as auto-deploy: it is the user's Vortex, so it is offered rather
 * than set behind their back, and it stays off afterwards rather than being
 * quietly restored. A setting changed back at the end of an hour-long run is a
 * worse surprise than one left where the user agreed to put it.
 * ──────────────────────────────────────────────────────────────────────
 */

/**
 * Vortex's own state path, read out of its bundle rather than guessed:
 * `settings.plugins.autoSort`, initialised `true`.
 */
export function readsAutoSort(state: unknown): boolean | undefined {
  const value = (
    state as { settings?: { plugins?: { autoSort?: unknown } } }
  )?.settings?.plugins?.autoSort;
  return typeof value === "boolean" ? value : undefined;
}

/**
 * Should the install stop and ask about this?
 *
 * Only a definite `true`. A setting we cannot read is NOT "off", but it is not
 * grounds to interrupt someone either — the same fail-open rule the deployment
 * and auto-deploy gates use. Refusing a working install because a check could
 * not run does more damage than the thing it guards against.
 *
 * Games that drive load order purely through `plugins.txt` still sort through
 * this setting, so there is no game to exclude: if Vortex holds the flag, it
 * applies.
 */
export function blocksInstall(state: unknown): boolean {
  return readsAutoSort(state) === true;
}

/** The Redux action Vortex's plugin-management extension registers for it. */
export const ACTION_SET_AUTOSORT_ENABLED = "SET_AUTOSORT_ENABLED";

/**
 * What the user is told, and what they are agreeing to.
 *
 * Names the consequence rather than the setting: "autosort" means nothing to
 * someone who has never turned it on, and the thing they care about is whether
 * the collection plays the way the curator built it.
 */
export function describeAutoSortBlock(pluginCount: number): {
  title: string;
  body: string;
  confirm: string;
  decline: string;
} {
  const plugins =
    pluginCount > 0 ? `${pluginCount} plugin(s)` : "this collection's plugins";
  return {
    title: "Turn off automatic plugin sorting?",
    body:
      `Vortex sorts your plugins with LOOT automatically whenever the plugin ` +
      `list changes, and it is on by default.\n\n` +
      `This collection ships the curator's own load order for ${plugins}, and ` +
      `reproducing it is most of what this install does. Automatic sorting ` +
      `replaces that order with LOOT's — during the install, and again every ` +
      `time you enable a plugin or deploy afterwards.\n\n` +
      `Nothing breaks visibly when that happens: every file still verifies ` +
      `and the game still starts. It simply loads a different order than the ` +
      `curator tested, which is the one thing this tool exists to get right.\n\n` +
      `Event Horizon can turn automatic sorting off for you. It stays off ` +
      `afterwards — you can re-enable it in Vortex whenever you like, and you ` +
      `can still sort by hand at any time.`,
    confirm: "Turn it off and install",
    decline: "Leave it on",
  };
}
