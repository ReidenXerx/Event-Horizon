/**
 * The install preview's side of versions of one mod (see
 * core/installer/variantGroups.ts): which versions start unpicked, and the
 * pick remembered when the install begins.
 */

import type { EhcollManifest } from "../../../types/ehcoll";
import { looksLikeWine } from "../../../core/proton/detect";
import {
  defaultVariantPicks,
  picksFromSkipped,
  readVariantPicks,
  saveVariantPicks,
  unpickedKeys,
  variantGroupsOf,
} from "../../../core/installer/variantGroups";
import { ehLog } from "../../../core/logging/ehLog";
import { detectHandheld } from "../../../core/environment/handheld";

/**
 * The versions a new preview leaves out: every member but the remembered
 * pick, else the low-end one on a Steam Deck / Proton install, else the first.
 */
export async function initialVariantSkips(manifest: Pick<EhcollManifest, "mods" | "package">): Promise<string[]> {
  const handheld = detectHandheld().handheld;
  // An optional mod for handhelds starts unticked anywhere else (owner poll, 2026-10-09).
  const handheldOnly = manifest.mods
    .filter((m) => m.state?.optional === true && m.state.optionalFor === "handheld" && m.state.variant === undefined)
    .map((m) => m.compareKey);
  const skipsForDevice = handheld ? [] : handheldOnly;
  const groups = variantGroupsOf(manifest.mods);
  if (groups.size === 0) return skipsForDevice;
  const remembered = await readVariantPicks(manifest.package.id);
  const lowEnd = handheld || looksLikeWine();
  const picks = defaultVariantPicks(groups, remembered, lowEnd);
  ehLog("info", "install.variants.preselected", {
    picks: Object.fromEntries([...picks].map(([g, m]) => [g, m.label])),
    remembered: Object.fromEntries(remembered),
    lowEndHardware: lowEnd,
  });
  return [...unpickedKeys(groups, picks), ...skipsForDevice];
}

/** Remember what the player picked, for the next update. Never stops an install. */
export function rememberVariantPicks(
  manifest: Partial<Pick<EhcollManifest, "mods" | "package">> | undefined,
  skipped: readonly string[],
): void {
  const groups = variantGroupsOf(manifest?.mods ?? []);
  if (groups.size === 0 || manifest?.package?.id === undefined) return;
  void saveVariantPicks(manifest.package.id, picksFromSkipped(groups, new Set(skipped)));
}
