/**
 * ──────────────────────────────────────────────────────────────────────
 * The oldest Event Horizon that understands everything a package uses.
 *
 * Owner poll, 2026-10-06: warn in the preview when the player's EH is older
 * than what the collection needs, and let them continue. Ivy Rev 10 needed
 * 0.2.46; a player on an older EH got optional mods treated as required and
 * Creation patches switched off, with nothing saying why.
 *
 * Derived from the features the package actually uses, NOT from the version
 * that built it: a curator updating EH must not make every player see a
 * warning for a collection that needs nothing new. When a feature that an
 * older EH would mishandle is added, add its row here.
 * ──────────────────────────────────────────────────────────────────────
 */

import type { EhcollManifest } from "../../types/ehcoll";

export type NeededEventHorizon = { version: string; why: string[] };

/** Numeric dotted compare: -1, 0, 1; non-numeric parts count as 0. */
export function compareEhVersions(a: string, b: string): number {
  const pa = a.split(/[.-]/).map((p) => Number.parseInt(p, 10) || 0);
  const pb = b.split(/[.-]/).map((p) => Number.parseInt(p, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

export function neededEventHorizon(manifest: Pick<EhcollManifest, "mods" | "game">): NeededEventHorizon | undefined {
  const needs: Array<[string, string]> = [];
  const mods = manifest.mods;
  const files = mods.flatMap((m) => (m.state?.stagingFiles ?? []).map((f) => ({ f, m })));
  if (files.some(({ f }) => f.installerCondition !== undefined)) {
    needs.push(["0.2.40", "files a mod installs only when you have certain plugins"]);
  }
  if (mods.some((m) => m.state?.optional === true)) needs.push(["0.2.41", "optional mods"]);
  if ((manifest.game.optionalOwnedMasters?.length ?? 0) > 0) needs.push(["0.2.43", "optional Creations"]);
  if (
    files.some(
      ({ f, m }) =>
        f.installerCondition !== undefined &&
        ((m.source as { bundled?: boolean }).bundled === true || f.installerCondition.all === true),
    )
  ) {
    needs.push(["0.2.45", "bundled patches that check which plugins you own"]);
  }
  if (mods.some((m) => Object.keys(m.state?.mirrorFromArchiveAt ?? {}).length > 0)) {
    needs.push(["0.2.56", "mod files the curator moved to another folder"]);
  }
  if (mods.some((m) => m.state?.variant !== undefined)) {
    needs.push(["0.2.62", "a choice between versions of one mod"]);
  }
  if (mods.some((m) => (m.state?.volatileFiles?.length ?? 0) > 0)) {
    needs.push(["0.2.61", "mod files the game writes for your own setup"]);
  }
  if (needs.length === 0) return undefined;
  const version = needs.map(([v]) => v).reduce((a, b) => (compareEhVersions(a, b) >= 0 ? a : b));
  return { version, why: needs.map(([, w]) => w) };
}
