/**
 * The deploy check against Vortex: reads the player's deployment and judges
 * it with deploymentWinners.ts. Shared by the Doctor and the end of an install
 * so the two can never disagree about the same game.
 */

import type { types } from "@nexusmods/vortex-api";

import type { EhcollManifest } from "../../types/ehcoll";
import type { DeployFinding } from "../manifest/deploymentWinners";

export type DeployCheckResult =
  | { kind: "not-checked"; why: string }
  | {
      kind: "checked";
      /** Contested paths compared against the curator's winner (0 for a package that recorded none). */
      judgedWinners: number;
      /** Collection-shipped paths checked for a mod from outside the collection. */
      judgedPaths: number;
      findings: DeployFinding[];
      /** One line per cause, for a person. */
      lines: string[];
      /** Some finding is a pair the collection's rules decide: re-applying them and deploying can fix it. */
      fixable: boolean;
    };

export async function checkDeployment(args: {
  api: types.IExtensionApi;
  gameId: string;
  manifest: Pick<EhcollManifest, "mods" | "rules" | "deployment">;
  /** The player's copy of each collection mod: from the receipt, or this run's installed list. */
  mods: ReadonlyArray<{ compareKey: string; vortexModId: string; name: string }>;
}): Promise<DeployCheckResult> {
  const [{ captureDeploymentManifests }, { judgeDeployment, describeDeployFindings }] = await Promise.all([
    import("../deploymentManifest"),
    import("../manifest/deploymentWinners"),
  ]);
  const state = args.api.getState();
  const pool =
    (state as unknown as { persistent?: { mods?: Record<string, Record<string, { installationPath?: string }>> } })
      .persistent?.mods?.[args.gameId] ?? {};

  // Only mods really in the pool. A receipt entry whose mod was removed is not
  // judged: its id is no longer a folder the game could deploy from.
  const keyToFolder = new Map<string, string>();
  const nameByKey = new Map<string, string>();
  for (const m of args.mods) {
    const entry = pool[m.vortexModId];
    if (entry === undefined) continue;
    keyToFolder.set(m.compareKey, entry.installationPath ?? m.vortexModId);
    nameByKey.set(m.compareKey, m.name);
  }
  if (keyToFolder.size === 0) {
    return { kind: "not-checked", why: "none of this collection's mods are installed in Vortex right now." };
  }

  const manifests = await captureDeploymentManifests(args.api, state, args.gameId);
  const report = judgeDeployment({
    winners: args.manifest.deployment?.winners ?? [],
    mods: args.manifest.mods.map((m) => ({
      compareKey: m.compareKey,
      ...(m.state?.modType !== undefined ? { modType: m.state.modType } : {}),
      ...(m.state?.enabled !== undefined ? { enabled: m.state.enabled } : {}),
      files: m.state?.stagingFiles ?? [],
    })),
    rules: args.manifest.rules ?? [],
    manifests,
    keyToFolder,
  });
  if (report.judgedPaths === 0 && report.judgedWinners === 0) {
    return {
      kind: "not-checked",
      why:
        report.undeployedTypes.length > 0
          ? "Vortex has not deployed this game (or it was just purged), so there is nothing to compare yet."
          : "the collection recorded no files to compare.",
    };
  }
  return {
    kind: "checked",
    judgedWinners: report.judgedWinners,
    judgedPaths: report.judgedPaths,
    findings: report.findings,
    lines: describeDeployFindings(report.findings, (k) => nameByKey.get(k) ?? k),
    fixable: report.findings.some((f) => f.kind === "wrong-winner" && f.ruled === true),
  };
}
