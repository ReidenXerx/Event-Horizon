import * as fs from "fs/promises";
import * as path from "path";

import type { AuditorMod } from "../core/getModsListForProfile";
import { publicNote } from "./curator/readProfile";
import type { CapturedDeploymentManifest } from "./deploymentManifest";
import type { CapturedLoadOrderEntry } from "./loadOrder";

export async function exportModsToJsonFile(params: {
  mods: AuditorMod[];
  gameId: string;
  profileId: string;
  outputDir: string;
  /**
   * Optional deployment manifests captured at export time. When provided,
   * embedded into the snapshot under `deploymentManifests`. Omitted from
   * the JSON entirely when undefined (keeps older-format-compatible
   * snapshots when capture was skipped or failed).
   */
  deploymentManifests?: CapturedDeploymentManifest[];
  /**
   * Optional per-game load order captured at export time. Always emitted
   * when provided (even if empty), so reference snapshots from
   * LoadOrder-API games carry it. Omitted from the JSON entirely when
   * undefined (forward-compat with future captures and pre-slice-4 files).
   */
  loadOrder?: CapturedLoadOrderEntry[];
}) {
  const { gameId, profileId, outputDir, deploymentManifests, loadOrder } =
    params;
  const mods = params.mods.map(withoutPrivateNote);

  await fs.mkdir(outputDir, { recursive: true });

  const fileName = `event-horizon-mods-${gameId}-${profileId}-${Date.now()}.json`;
  const filePath = path.join(outputDir, fileName);

  const enabledMods = mods.filter((m) => m.enabled);
  const disabledMods = mods.filter((m) => !m.enabled);

  const payload: Record<string, unknown> = {
    exportedAt: new Date().toISOString(),
    gameId,
    profileId,
    count: mods.length,
    mods,
    enabledMods,
    disabledMods,
  };

  if (deploymentManifests !== undefined) {
    payload.deploymentManifests = deploymentManifests;
  }

  if (loadOrder !== undefined) {
    payload.loadOrder = loadOrder;
  }

  await fs.writeFile(filePath, JSON.stringify(payload, null, 2), "utf8");

  return filePath;
}

/**
 * A mod as it may leave the machine: the curator's note only when it is
 * marked for users.
 *
 * `curatorNote` is read from the mod as written, and a note is private unless
 * it starts with `@users` (settled with the user; see `publicNote`). The
 * export is a file people attach to bug reports and share, so a private note
 * is dropped here the same way the manifest drops it. A public note is kept
 * whole, marker included, so anything reading the snapshot back sees the same
 * note `publicNote` would ship.
 */
function withoutPrivateNote(mod: AuditorMod): AuditorMod {
  if (mod.curatorNote === undefined) return mod;
  if (publicNote(mod.curatorNote) !== undefined) return mod;
  const { curatorNote: _private, ...rest } = mod;
  void _private;
  return rest;
}
