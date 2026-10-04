/**
 * Which mod wins each contested file — recorded from the curator's own Vortex
 * deployment, and compared against the player's.
 *
 * ─── WHY ───────────────────────────────────────────────────────────────────
 * Every other check here asks whether the right FILES are in each mod's
 * staging folder. None asked which of several mods' copies of one path the
 * game actually gets. A player whose Ivy had been updated through several
 * revisions got "nailed" breasts on every new game; a fresh install fixed it
 * (alasdairn, 2026-10-04). Every mod's files would have verified. What the
 * install kept and a clean one did not was invisible, because nothing looked
 * at the deployment itself.
 *
 * Vortex writes `vortex.deployment.json` beside each deployment target: every
 * deployed file and the mod folder it came from. The build already captured
 * it (`deploymentManifests` in the snapshot) and never used it. This records,
 * for every path more than one collection mod ships ("contested"), the mod
 * whose copy the curator's game got; the player side reads its own manifest
 * and names every contested path where a different mod won or nothing did.
 *
 * Contested only: an uncontested file has one possible source, and the deep
 * scan already proves its bytes. Measured on Ivy 1.0.38: 67,839 files, 5,178
 * contested.
 */

import type { CapturedDeploymentManifest } from "../deploymentManifest";
import type { EhcollDeploymentWinner } from "../../types/ehcoll";

export type { EhcollDeploymentWinner };

export const normPath = (p: string): string => p.replace(/\\/g, "/").toLowerCase();

/**
 * Build side: the curator's winners for every contested path.
 *
 * `folderToKey` maps a Vortex mod folder (`installationPath`, which is what a
 * deployment manifest calls `source`) to the collection mod's compareKey. A
 * path whose curator winner is not a collection mod is left out: nothing a
 * player installs from the collection can reproduce it, so nothing about it
 * can be checked.
 */
export function recordDeploymentWinners(input: {
  mods: ReadonlyArray<{ compareKey: string; modType?: string; stagingPaths: readonly string[] }>;
  manifests: readonly CapturedDeploymentManifest[];
  folderToKey: ReadonlyMap<string, string>;
}): EhcollDeploymentWinner[] {
  const out: EhcollDeploymentWinner[] = [];
  for (const manifest of input.manifests) {
    const type = manifest.modType ?? "";
    const shippers = new Map<string, number>();
    for (const m of input.mods) {
      if ((m.modType ?? "") !== type) continue;
      for (const p of new Set(m.stagingPaths.map(normPath))) shippers.set(p, (shippers.get(p) ?? 0) + 1);
    }
    const byWinner = new Map<string, string[]>();
    for (const f of manifest.files) {
      const p = normPath(f.relPath);
      if ((shippers.get(p) ?? 0) < 2) continue;
      const key = input.folderToKey.get(f.source.toLowerCase());
      if (key === undefined) continue;
      const list = byWinner.get(key) ?? [];
      list.push(p);
      byWinner.set(key, list);
    }
    for (const [mod, paths] of [...byWinner].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
      out.push({ modType: type, mod, paths: paths.sort() });
    }
  }
  return out;
}

export type DeploymentFinding = {
  modType: string;
  path: string;
  /** The collection mod whose copy should be there. */
  expected: string;
  /**
   * What the player's game got instead: another mod's folder, or `undefined`
   * when Vortex deployed nothing at that path.
   */
  actual: string | undefined;
};

/**
 * Player side: every recorded contested path where the player's deployment
 * differs from the curator's.
 *
 * `keyToFolder` maps a collection compareKey to the player's Vortex mod folder
 * for it. A recorded winner the player does not have (skipped, failed) is not
 * judged — the install already reports a missing mod, and blaming each of its
 * files again would bury that one fact under hundreds of lines.
 */
export function judgeDeploymentWinners(input: {
  winners: readonly EhcollDeploymentWinner[];
  manifests: readonly CapturedDeploymentManifest[];
  keyToFolder: ReadonlyMap<string, string>;
}): DeploymentFinding[] {
  const deployed = new Map<string, Map<string, string>>();
  for (const m of input.manifests) {
    const byPath = new Map<string, string>();
    for (const f of m.files) byPath.set(normPath(f.relPath), f.source);
    deployed.set(m.modType ?? "", byPath);
  }
  const out: DeploymentFinding[] = [];
  for (const w of input.winners) {
    const folder = input.keyToFolder.get(w.mod);
    if (folder === undefined) continue;
    const byPath = deployed.get(w.modType);
    if (byPath === undefined) continue;
    for (const p of w.paths) {
      const actual = byPath.get(p);
      if (actual !== undefined && actual.toLowerCase() === folder.toLowerCase()) continue;
      out.push({ modType: w.modType, path: p, expected: w.mod, actual });
    }
  }
  return out;
}

/** Total recorded contested paths, for "N of M" lines. */
export const countRecordedPaths = (winners: readonly EhcollDeploymentWinner[]): number =>
  winners.reduce((n, w) => n + w.paths.length, 0);
