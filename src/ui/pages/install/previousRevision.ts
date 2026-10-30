/**
 * The update preview's "From your previous revision" choices (alasdairn,
 * Ivy, 2026-10-31, approved):
 *
 *   - collection mods the player switched off: kept off by default;
 *   - the player's own mods that were on in the previous revision's profile:
 *     switched on in the new one by default.
 *
 * Both are remembered per collection for the next update. Read once, when the
 * plan is ready; never stops a preview (any failure offers nothing).
 */
import * as fsp from "fs/promises";
import * as path from "path";

import type { EhcollManifest } from "../../../types/ehcoll";
import type { InstallPlan } from "../../../types/installPlan";
import type { InstallReceipt } from "../../../types/installLedger";
import { findKeptOffOffers, readKeptOff, refuseNeededMasters, type KeptOffRefusal } from "../../../core/installer/keptOff";
import { modsOutsideCollection } from "../../../core/doctor/modsOutsideCollection";
import { getEventHorizonDir } from "../../../core/paths/appDataPaths";
import { stagingRootForModId } from "../../../core/stagingPath";
import { readPluginHeader } from "../../../core/manifest/pluginMasters";
import { ehLog } from "../../../core/logging/ehLog";

export type PreviousRevisionChoices = {
  keepOff: Array<{ compareKey: string; name: string; keep: boolean }>;
  refused: KeptOffRefusal[];
  carry: Array<{ vortexModId: string; name: string; carry: boolean }>;
};

type StateShape = {
  persistent?: {
    profiles?: Record<string, { modState?: Record<string, { enabled?: boolean }> } | undefined>;
    mods?: Record<string, Record<string, { type?: string; attributes?: Record<string, unknown> }>>;
  };
};

const carrySkipFile = (packageId: string): string => getEventHorizonDir("choices", `${packageId}.carry-skip.json`);

async function readCarrySkips(packageId: string): Promise<Set<string>> {
  try {
    const parsed = JSON.parse(await fsp.readFile(carrySkipFile(packageId), "utf8")) as { skip?: unknown };
    return new Set(Array.isArray(parsed.skip) ? parsed.skip.filter((k): k is string => typeof k === "string") : []);
  } catch {
    return new Set();
  }
}

/** Remember which of their own mods the player chose NOT to carry. Never throws. */
export async function saveCarrySkips(packageId: string, skip: readonly string[]): Promise<void> {
  try {
    await fsp.mkdir(getEventHorizonDir("choices"), { recursive: true });
    await fsp.writeFile(carrySkipFile(packageId), JSON.stringify({ skip: [...skip].sort() }, null, 2), "utf8");
  } catch (err) {
    ehLog("warn", "carry-skips.save-failed", { packageId, err });
  }
}

const existingIdOf = (decision: unknown): string | undefined => {
  const id = (decision as { existingModId?: unknown } | undefined)?.existingModId;
  return typeof id === "string" ? id : undefined;
};

export async function previousRevisionChoices(
  state: unknown,
  manifest: EhcollManifest,
  plan: InstallPlan,
  receipt: InstallReceipt | undefined,
): Promise<PreviousRevisionChoices | undefined> {
  if (receipt === undefined) return undefined;
  try {
    const s = state as StateShape;
    const gameId = manifest.game.id;
    const modState = s.persistent?.profiles?.[receipt.vortexProfileId]?.modState;
    const pool = s.persistent?.mods?.[gameId] ?? {};
    const remembered = await readKeptOff(manifest.package.id);
    const resolutions = plan.modResolutions.map((r) => ({
      compareKey: r.compareKey,
      name: r.name,
      decision: r.decision,
      existingModId: existingIdOf(r.decision),
    }));
    let offers = findKeptOffOffers({
      manifestMods: manifest.mods,
      resolutions,
      receipt,
      ...(modState !== undefined ? { previousModState: modState } : {}),
      remembered,
    });

    let refused: KeptOffRefusal[] = [];
    if (offers.length > 0) {
      // Masters of every other collection plugin already in the pool.
      const offKeys = new Set(offers.map((o) => o.compareKey));
      const mastersOf = new Map<string, string[]>();
      for (const r of resolutions) {
        if (offKeys.has(r.compareKey) || r.existingModId === undefined) continue;
        const mod = manifest.mods.find((m) => m.compareKey === r.compareKey);
        const root = stagingRootForModId(state as never, gameId, r.existingModId);
        if (mod === undefined || root === undefined) continue;
        for (const f of mod.state?.stagingFiles ?? []) {
          if (!/\.(esp|esm|esl)$/i.test(f.path)) continue;
          const read = await readPluginHeader(path.join(root, ...f.path.split("/")), undefined).catch(() => undefined);
          if (read?.kind === "ok") mastersOf.set(path.basename(f.path).toLowerCase(), [...read.masters]);
        }
      }
      ({ offers, refused } = refuseNeededMasters(offers, manifest.mods, mastersOf));
    }

    let carry: PreviousRevisionChoices["carry"] = [];
    if (plan.installTarget.kind === "fresh-profile" && modState !== undefined) {
      const skips = await readCarrySkips(manifest.package.id);
      const nowCollection = new Set(resolutions.map((r) => r.existingModId).filter((id): id is string => id !== undefined));
      carry = modsOutsideCollection({ receipt, mods: pool, modState })
        .extra.filter((m) => !nowCollection.has(m.vortexModId))
        .map((m) => ({ vortexModId: m.vortexModId, name: m.name, carry: !skips.has(m.vortexModId) }));
    }

    ehLog("info", "install.previous-revision.choices", {
      keepOff: offers.length,
      refused: refused.map((r) => ({ mod: r.name, neededBy: r.neededBy.slice(0, 3) })),
      carry: carry.length,
      previousProfileFound: modState !== undefined,
    });
    if (offers.length === 0 && refused.length === 0 && carry.length === 0) return undefined;
    return {
      keepOff: offers.map((o) => ({ compareKey: o.compareKey, name: o.name, keep: true })),
      refused,
      carry,
    };
  } catch (err) {
    ehLog("warn", "install.previous-revision.choices-failed", { err });
    return undefined;
  }
}
