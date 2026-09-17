/**
 * ──────────────────────────────────────────────────────────────────────
 * What each cure needs, and what it is allowed to touch.
 *
 * The Doctor DIAGNOSES from the receipt — the only artefact describing a state
 * this machine actually reached. But most cures re-run a pipeline step, and
 * those steps read the MANIFEST. That asymmetry is the whole reason this file
 * exists: three of the six repairs need the `.ehcoll` on disk and three do
 * not, and offering a button that cannot work is worse than not offering it.
 *
 * ─── THE ONE THAT DELIBERATELY IGNORES DATA IT HAS ─────────────────────
 * `repin-plugin-order` re-pins the recorded ORDER, and `applyPluginOrder`
 * wants `EhcollPluginEntry[]` — name AND enabled.
 *
 * The receipt has both: `rulesApplication.baselinePluginOrder` is
 * `{ name, enabled }[]`, so the enabled flags are sitting right there. Using
 * them is the obvious move and the wrong one. They describe enablement AT
 * INSTALL TIME, so re-pinning with them would silently undo every plugin the
 * user has toggled since — while the button claims only to fix an ordering.
 * Enablement is a separate concern with its own check.
 *
 * So the ORDER comes from the receipt and each plugin's ENABLED flag comes
 * from the machine as it is right now. The ordering is restored, the user's
 * own decisions survive untouched, and the two checks stay orthogonal.
 * ──────────────────────────────────────────────────────────────────────
 */

import type { EhcollPluginEntry } from "../../types/ehcoll";
import { buildOutputFileName } from "../manifest/packageFileName";
import type { HealAction } from "./health";

/** A blank line between paragraphs, without an escape a tool can mangle. */
const NL2 = String.fromCharCode(10, 10);

/**
 * Does this cure need the collection package, or only the receipt?
 *
 * Exported and tested rather than inlined in the page because the answer
 * decides whether a button is offered at all, and getting it wrong in the
 * quiet direction — offering a repair we cannot perform — surfaces as a heal
 * that appears to do nothing.
 */
export function healNeedsManifest(action: HealAction): boolean {
  switch (action) {
    case "reapply-rules":
    case "reapply-userlist":
    case "reinstall-mods":
      return true;
    case "switch-profile":
    case "enable-mods":
    case "repin-plugin-order":
    // The receipt carries each plugin's name and the curator's flag, which is
    // everything the repair needs. Requiring the .ehcoll would hide the button
    // from exactly the user whose game has stopped starting.
    case "restore-light-flags":
      return false;
  }
}

/**
 * Must the user confirm this cure, or is pressing the button enough?
 *
 * Owner poll, 2026-09-18: a player who can see that their load order is wrong
 * should fix it with ONE press. A dialog between the diagnosis and the cure
 * buys nothing when the cure is reversible and touches nothing the player
 * owns — it just makes the tool feel like it is protecting itself.
 *
 * So the line is drawn at what cannot simply be pressed again:
 *
 *   • order, ESL flags, enabling mods, switching profile — all restore a
 *     recorded state, none removes anything, and every one of them can be
 *     undone by doing the opposite. One press.
 *   • reapply-rules REPLACES the player's own mod rules for this game, and
 *     reinstall-mods REMOVES and rebuilds mod folders and can take an hour.
 *     Both still ask, in the words that say what is lost.
 *
 * The userlist is the same act as the rules, one layer down (LOOT), so it
 * keeps its confirmation for the same reason.
 */
export function healNeedsConfirmation(action: HealAction): boolean {
  switch (action) {
    case "reapply-rules":
    case "reapply-userlist":
    case "reinstall-mods":
      return true;
    case "switch-profile":
    case "enable-mods":
    case "repin-plugin-order":
    case "restore-light-flags":
      return false;
  }
}

/**
 * What the user is agreeing to, in their words, before it happens.
 *
 * Every one of these writes to the machine, and several are slow. A button
 * labelled "Reinstall 3 changed mods" that silently also re-runs deployment is
 * a worse surprise than a slow one.
 *
 * Still written for every action, including the ones that no longer ask: the
 * body text is what a card shows under the button, and
 * {@link healNeedsConfirmation} decides only whether a dialog is raised.
 */
export function describeHeal(action: HealAction): {
  title: string;
  body: string;
  /** Label for the confirming button. */
  confirm: string;
} {
  switch (action) {
    case "restore-light-flags":
      return {
        title: "Restore the collection's ESL flags?",
        body:
          "This rewrites one header bit in the plugin files that no longer " +
          "carry the flag the curator had. Nothing is reinstalled and no mod " +
          "content changes." +
          NL2 +
          "Light (ESL) plugins share a single load-order index instead of " +
          "taking one of the 254 available, which is what lets a large " +
          "collection load at all. A Vortex purge under copy deployment " +
          "rewrites plugins from staging and undoes this, which is the usual " +
          "reason it is needed." +
          NL2 +
          "Close the game and any xEdit or LOOT windows first — a plugin " +
          "another program is holding open cannot be changed.",
        confirm: "Restore flags",
      };
    case "switch-profile":
      return {
        title: "Switch to the collection's profile?",
        body:
          "Vortex will switch to the profile this collection was installed " +
          "into. Nothing is installed or removed — you can switch back at " +
          "any time.",
        confirm: "Switch profile",
      };
    case "enable-mods":
      return {
        title: "Re-enable the collection's mods?",
        body:
          "Every mod the collection installed will be enabled again in its " +
          "profile. Mods you added yourself are not touched.",
        confirm: "Enable mods",
      };
    case "repin-plugin-order":
      return {
        title: "Restore the recorded plugin order?",
        body:
          "The plugin order is set back to what this collection installed. " +
          "Which plugins are enabled is left exactly as it is now — this " +
          "changes the order only.",
        confirm: "Restore order",
      };
    case "reapply-rules":
      return {
        title: "Re-apply the collection's mod rules?",
        body:
          "The collection's conflict rules replace the rules currently set " +
          "for this game — the same thing the install did. Rules you added " +
          "yourself will be lost.",
        confirm: "Re-apply rules",
      };
    case "reapply-userlist":
      return {
        title: "Re-apply the collection's LOOT rules?",
        body:
          "The collection's LOOT userlist replaces what is set now, exactly " +
          "as the install did. LOOT rules you added yourself will be lost.",
        confirm: "Re-apply LOOT rules",
      };
    case "reinstall-mods":
      return {
        title: "Reinstall the mods that changed?",
        body:
          "Each changed mod is installed again from the collection. This " +
          "downloads and extracts, so it can take a while — and it restores " +
          "the curator's installer answers, replacing any you changed " +
          "yourself.",
        confirm: "Reinstall",
      };
  }
}

/**
 * Rebuild the plugin order to re-pin, from the receipt's names and the
 * machine's current enable flags.
 *
 * Matching is case-insensitive because plugins.txt casing is not stable across
 * machines or Vortex versions — the same reason the order COMPARISON ignores
 * it. A case-sensitive lookup here would silently treat every plugin as
 * unknown and disable the lot.
 *
 * Plugins present now but absent from the receipt are kept, at the end. They
 * are almost always the user's own additions, and dropping a plugin from
 * plugins.txt is how you disable it — a repair that quietly uninstalls
 * someone's extra plugin while claiming to fix an ordering is not a repair.
 */
export function rebuildPluginOrder(
  /** Recorded plugin NAMES, in order. The receipt's enabled flags are
   * deliberately not passed — see the header. */
  recordedOrder: readonly string[],
  currentlyPresent: readonly { name: string; enabled: boolean }[],
): EhcollPluginEntry[] {
  const enabledByLowerName = new Map<string, boolean>();
  for (const p of currentlyPresent) {
    enabledByLowerName.set(p.name.toLowerCase(), p.enabled);
  }

  const out: EhcollPluginEntry[] = [];
  const placed = new Set<string>();
  for (const name of recordedOrder) {
    const key = name.toLowerCase();
    placed.add(key);
    out.push({
      name,
      // Absent from the machine entirely: it cannot be enabled, and claiming
      // it is would ask Vortex to enable a plugin that is not there.
      enabled: enabledByLowerName.get(key) ?? false,
    });
  }

  for (const p of currentlyPresent) {
    if (placed.has(p.name.toLowerCase())) continue;
    out.push({ name: p.name, enabled: p.enabled });
  }

  return out;
}

/**
 * Which package in a directory belongs to this receipt.
 *
 * Filenames are `<slug>-<version>.ehcoll`, and the slug is derived from the
 * package name, so this is a match rather than a lookup. The same package
 * taken from a Nexus page is a `.zip` (Nexus quarantines files named
 * `.ehcoll`), so that name counts too; the packager's own name wins when both
 * are there. Version is matched EXACTLY: healing from a different version of
 * the collection would apply rules and answers the user never installed,
 * which is a worse outcome than asking them to point at the file.
 */
export function matchEhcollFile(
  filenames: readonly string[],
  packageName: string,
  packageVersion: string,
): string | undefined {
  // Built by the SAME function the packager writes with, not a copy of its
  // rules — a second implementation would agree today and drift later,
  // surfacing as a Doctor that cannot find a package sitting in front of it.
  const built = buildOutputFileName(packageName, packageVersion).toLowerCase();
  for (const wanted of [built, built.replace(/\.ehcoll$/, ".zip")]) {
    const exact = filenames.find((f) => f.toLowerCase() === wanted);
    if (exact !== undefined) return exact;
  }

  // Fall back to "any file whose name carries this exact version", which
  // survives a slug rule that has drifted since the package was built. Only
  // when it is unambiguous — two candidates means we do not know, and
  // guessing which collection to heal from is not a risk worth taking.
  const suffixes = [`-${packageVersion}.ehcoll`, `-${packageVersion}.zip`].map((s) => s.toLowerCase());
  const candidates = filenames.filter((f) =>
    suffixes.some((suffix) => f.toLowerCase().endsWith(suffix)),
  );
  return candidates.length === 1 ? candidates[0] : undefined;
}
