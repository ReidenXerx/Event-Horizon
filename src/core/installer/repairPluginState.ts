/**
 * ─── A REPAIR ASKS THE SAME QUESTION THE INSTALL DID ─────────────────────
 * Some FOMOD installers pick files by asking whether a plugin is ACTIVE.
 * The main install answers that with epochs (`installEpochs.ts`): those mods
 * go in after the plugins they ask about are switched on.
 *
 * The repair pass had no such step. cloud_16493, Ivy 1.0.64 (2026-11-19):
 * the repair reinstalled UAP, which left Deathclaw_nude.esp inactive, and six
 * seconds later reinstalled Immersive Deathclaws, whose installer picks its
 * UAP build only when Deathclaw_nude.esp is active. It landed the Plain build
 * again, failed verification again, and the curator was sent a report about
 * an archive that was byte-identical to theirs.
 *
 * So before a repair reinstalls such a mod, the plugins its installer reads
 * are switched on: only the ones the curator had enabled, because the
 * collection's own plugin state is the answer the curator's install saw.
 */
import type { EhcollManifest, EhcollMod } from "../../types/ehcoll";

/**
 * Names of the plugins to switch on before reinstalling `mod`, spelled as the
 * collection's plugin order spells them. Empty for a mod whose installer asks
 * about no plugin, which is almost every mod.
 */
export function pluginsToActivateBeforeRepair(
  manifest: Pick<EhcollManifest, "plugins">,
  mod: Pick<EhcollMod, "install"> | undefined,
): string[] {
  const reads = new Set(
    (mod?.install?.readsPluginState ?? []).map((n) => n.toLowerCase()),
  );
  if (reads.size === 0) return [];
  return manifest.plugins.order
    .filter((p) => p.enabled && reads.has(p.name.toLowerCase()))
    .map((p) => p.name);
}
