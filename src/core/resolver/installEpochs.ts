/**
 * ──────────────────────────────────────────────────────────────────────
 * WHEN can a mod be installed — a decision, made where decisions live.
 *
 * Some FOMOD installers ask the game whether a plugin is ACTIVE, and Vortex
 * answers from live state: `getAllPlugins(activeOnly)` reads
 * `loadOrder[name].enabled`, and pre-filling the curator's `installerChoices`
 * does not suppress it. Proven by reading Vortex's shipped bundle — the
 * delegate is registered unconditionally and `choices` is one argument among
 * six, with no flag that turns condition evaluation off.
 *
 * So a mod naming a plugin THIS COLLECTION provides behaves differently
 * depending on where it happens to sit in the install order. Nobody chose that
 * ordering; it is `installOrder` ascending, recorded for determinism.
 *
 * ─── WHY THIS IS NOT THE RETRY PASS'S JOB ─────────────────────────────
 * `<moduleDependencies>` REFUSES, loudly, and the retry pass rescues it. One
 * real mod, 801 of 979, refused eleven times across the tester logs:
 * "Prerequisits not fulfilled: File 'aaf.esm' is Active OR File 'aaf.esp' is
 * Active" — with AAF in the same collection, uninstalled at that moment.
 *
 * The same `<fileDependency>` in a step's `<visible>` or a
 * `<conditionalFileInstalls>` pattern does NOT refuse. It takes a different
 * branch and installs a different FILE SET, and nothing fails — so nothing
 * retries. A population discovered by letting mods FAIL can never contain the
 * ones that do not fail.
 *
 * Measured on a real 978-mod collection: 96 archives carry a FOMOD script, 27
 * of those ask the game about a plugin, and 21 name a plugin the collection
 * itself ships. Exactly ONE of those 21 was the loud kind. The other twenty
 * are compatibility-patch installers — "You And What Army 2 Patch Hub",
 * "Munitions - Official Patch Repository", "Weapon Level List Patches FOMOD" —
 * whose entire job is to install a patch IF some plugin is present.
 *
 * ─── WHY IT LIVES IN THE RESOLVER ─────────────────────────────────────
 * It is a decision about a plan, computed from the manifest alone, and the
 * driver is orchestration. Putting it here means it can be reported without
 * installing anything: selecting a package in the wizard can say which mods
 * will wait and what they are waiting for, which is a dry run of the one thing
 * that decides install order.
 * ──────────────────────────────────────────────────────────────────────
 */

import { isBaseGameMaster } from "../manifest/pluginMasters";

import type { EhcollManifest } from "../../types/ehcoll";

/** One mod that cannot be installed until a plugin is active. */
export type DeferredMod = {
  compareKey: string;
  name: string;
  /**
   * The plugins it is waiting for — only those this collection actually
   * ships. A script often names dozens; the ones that matter are the ones
   * whose activation this install controls.
   */
  waitsFor: string[];
  /**
   * Which deferred layer it installs in, from 1. A mod waiting on a plugin
   * that ANOTHER deferred mod provides goes one layer later than that mod, so
   * the plugin is active by the time it asks.
   */
  layer: number;
};

export type InstallEpochs = {
  /** compareKeys that install first, in manifest order. */
  first: string[];
  /** compareKeys that install after the plugins are active: every layer, in layer order. */
  second: string[];
  /**
   * The deferred mods split into layers, each activated before it installs.
   *
   * One boundary was not enough (Meridia 1.0.24, 2026-10-02): Helios waits on
   * Obscure's College of Winterhold's plugin, and OCW is itself deferred, so
   * at the single boundary its plugin did not exist yet and Helios took the
   * "not installed" branch. Layer N waits only on plugins from layers before
   * it, so each boundary activates everything the next layer asks about.
   */
  layers: string[][];
  /** The deferred mods with their reasons, for the log and the report. */
  deferred: DeferredMod[];
  /**
   * Mods whose installer could not be examined at build time.
   *
   * They are in `first` — not deferring them is a decision, not an oversight.
   * "We could not look" is not evidence that a mod needs to wait, and moving
   * it on that basis would cost it its curated position for nothing. They are
   * named so a tester reading one log can tell this case apart from the 845
   * mods that were read and ask nothing.
   */
  unexamined: { compareKey: string; name: string }[];
};

/**
 * Split a manifest's mods into the two epochs.
 *
 * Pure, and total: a manifest whose mods declare nothing produces an empty
 * second epoch, which is the overwhelming majority and costs nothing anywhere
 * downstream.
 */
export function planInstallEpochs(manifest: EhcollManifest): InstallEpochs {
  /**
   * Plugins whose activation THIS INSTALL controls.
   *
   * Base-game masters are excluded because they are active before anything
   * installs — deferring a mod for `Fallout4.esm` would cost it its position
   * and buy nothing. A plugin the collection does not order is excluded for
   * the mirror-image reason: waiting will not make it active either.
   */
  const shipped = new Set(
    manifest.plugins.order
      .map((p) => p.name.toLowerCase())
      .filter((name) => !isBaseGameMaster(name, manifest.game.id)),
  );
  /** Which mod's staged files carry each plugin — the mod whose install makes it exist. */
  const providerOf = new Map<string, string>();
  for (const mod of manifest.mods) {
    for (const f of mod.state?.stagingFiles ?? []) {
      const base = f.path.replace(/\\/g, "/").split("/").pop()!.toLowerCase();
      if (/\.(esp|esm|esl)$/.test(base) && shipped.has(base) && !providerOf.has(base)) {
        providerOf.set(base, mod.compareKey);
      }
    }
  }
  const waitsForOf = new Map<string, string[]>();
  for (const mod of manifest.mods) {
    const named = mod.install?.readsPluginState ?? [];
    waitsForOf.set(mod.compareKey, named.filter((n) => shipped.has(n.toLowerCase())));
  }

  // 0 = first epoch. A deferred mod sits one layer after the deepest deferred
  // mod providing a plugin it waits on. A cycle (two installers each asking
  // about the other's plugin) is cut where it closes: no order satisfies both.
  const layerOf = new Map<string, number>();
  const visiting = new Set<string>();
  const layer = (key: string): number => {
    const known = layerOf.get(key);
    if (known !== undefined) return known;
    const waits = waitsForOf.get(key) ?? [];
    if (waits.length === 0) {
      layerOf.set(key, 0);
      return 0;
    }
    visiting.add(key);
    let deepest = 0;
    for (const plugin of waits) {
      const provider = providerOf.get(plugin.toLowerCase());
      if (provider === undefined || provider === key || visiting.has(provider)) continue;
      deepest = Math.max(deepest, layer(provider));
    }
    visiting.delete(key);
    const mine = deepest + 1;
    layerOf.set(key, mine);
    return mine;
  };

  const first: string[] = [];
  const byLayer: string[][] = [];
  const deferred: DeferredMod[] = [];
  const unexamined: { compareKey: string; name: string }[] = [];
  for (const mod of manifest.mods) {
    const waitsFor = waitsForOf.get(mod.compareKey) ?? [];
    if (waitsFor.length === 0) {
      first.push(mod.compareKey);
      // Reported from the same pass that decides, so the two can never
      // disagree — but deliberately NOT a reason to defer.
      if (mod.install?.installerUnexamined === true) {
        unexamined.push({ compareKey: mod.compareKey, name: mod.name });
      }
      continue;
    }
    const at = layer(mod.compareKey);
    (byLayer[at - 1] ??= []).push(mod.compareKey);
    deferred.push({ compareKey: mod.compareKey, name: mod.name, waitsFor, layer: at });
  }
  const layers = byLayer.filter((l) => l !== undefined && l.length > 0);
  return { first, second: layers.flat(), layers, deferred, unexamined };
}

/**
 * What to tell a curator or a tester, before anything is installed.
 *
 * Silent when nothing defers — a line saying "0 mods will wait" on every
 * install is one people learn to skip, and this one has to be read on the
 * occasions it is not zero.
 */
export function describeInstallEpochs(epochs: InstallEpochs): string[] {
  if (epochs.deferred.length === 0 && epochs.unexamined.length === 0) return [];

  const lines: string[] = [];

  if (epochs.deferred.length > 0) {
    lines.push(
      `${epochs.deferred.length} mod(s) will install in a second pass, after ` +
        `the collection's plugins are active. Their installers ask the game ` +
        `whether a plugin is present, so installing them earlier would give a ` +
        `different answer — usually a missing compatibility patch, with no ` +
        `error to notice.`,
    );
    for (const mod of epochs.deferred.slice(0, 10)) {
      lines.push(`  • "${mod.name}" waits for ${mod.waitsFor.join(", ")}`);
    }
    if (epochs.deferred.length > 10) {
      lines.push(`  • and ${epochs.deferred.length - 10} more.`);
    }
  }

  /**
   * Said even when nothing defers, which is why the guard above is an AND.
   * A build that examined nothing would otherwise print the most reassuring
   * message available — silence — at exactly the moment it knows least.
   */
  if (epochs.unexamined.length > 0) {
    lines.push(
      `${epochs.unexamined.length} mod(s) could not have their installer ` +
        `examined when this package was built, so it is NOT known whether ` +
        `they ask the game about another mod's plugin. They install in their ` +
        `normal position — being unreadable is not a reason to move a mod — ` +
        `but if one of them installs the wrong files, this is the first ` +
        `place to look.`,
    );
    for (const mod of epochs.unexamined.slice(0, 10)) {
      lines.push(`  • "${mod.name}"`);
    }
    if (epochs.unexamined.length > 10) {
      lines.push(`  • and ${epochs.unexamined.length - 10} more.`);
    }
  }

  return lines;
}
