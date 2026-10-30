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
import * as os from "os";
import * as path from "path";
import { pipeline } from "stream/promises";
import { createWriteStream } from "fs";

import type { EhcollManifest } from "../../../types/ehcoll";
import type { InstallPlan } from "../../../types/installPlan";
import type { InstallReceipt } from "../../../types/installLedger";
import { findKeptOffOffers, readKeptOff, refuseNeededMasters, type KeptOffRefusal } from "../../../core/installer/keptOff";
import { modsOutsideCollection } from "../../../core/doctor/modsOutsideCollection";
import { getEventHorizonDir, getVortexUserDataPath } from "../../../core/paths/appDataPaths";
import { parsePluginsTxt } from "../../../core/comparePlugins";
import { openZipReader } from "../../../core/manifest/readZip";
import { stagingRootForModId } from "../../../core/stagingPath";
import { readPluginHeader } from "../../../core/manifest/pluginMasters";
import { ehLog } from "../../../core/logging/ehLog";

export type PreviousRevisionChoices = {
  keepOff: Array<{ compareKey: string; name: string; keep: boolean }>;
  refused: KeptOffRefusal[];
  carry: Array<{ vortexModId: string; name: string; carry: boolean }>;
  /**
   * Lowercased names of the plugins that were ticked in the previous
   * revision's profile. A carried mod's plugins get the same ticks in the new
   * profile, which starts with only the collection's plugins on (alasdairn,
   * 2026-10-31: ECV_Remnants.esp and SCOURGE came over with their mods on and
   * their plugins off).
   */
  previousEnabledPlugins?: string[];
};

type StateShape = {
  settings?: { profiles?: { activeProfileId?: string } };
  loadOrder?: Record<string, { enabled?: boolean; name?: string } | undefined>;
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

const isPlugin = (p: string): boolean => /\.(esp|esm|esl)$/i.test(p);

/**
 * The plugins ticked in a profile. Vortex holds the ACTIVE profile's list in
 * `state.loadOrder` and copies it into the profile's own folder when the
 * player switches away, so an inactive profile is read from that file.
 * Undefined when neither has an answer.
 */
async function enabledPluginsOf(s: StateShape, gameId: string, profileId: string): Promise<string[] | undefined> {
  if (s.settings?.profiles?.activeProfileId === profileId && s.loadOrder !== undefined) {
    return Object.entries(s.loadOrder)
      .filter(([, e]) => e?.enabled === true)
      .map(([id, e]) => (typeof e?.name === "string" && e.name !== "" ? e.name : id).toLowerCase());
  }
  try {
    const file = path.join(getVortexUserDataPath(), gameId, "profiles", profileId, "plugins.txt");
    // latin1: see parsePluginsTxt.
    return parsePluginsTxt(await fsp.readFile(file, "latin1"))
      .filter((p) => p.enabled)
      .map((p) => p.name.toLowerCase());
  } catch {
    return undefined;
  }
}

/**
 * Masters of the plugins inside bundled collection mods that are not in the
 * pool yet: they arrive with this revision, so there is no staging folder to
 * read (alasdairn, 2026-10-31: a kept-off Headcase's Abernathy Farmers was a
 * master of the bundled Connie patch, and the preview did not know).
 */
async function bundledMasters(
  packagePath: string,
  mods: ReadonlyArray<{ name: string; sha256: string }>,
  into: Map<string, string[]>,
): Promise<void> {
  const zip = await openZipReader(packagePath);
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "eh-masters-"));
  try {
    for (const m of mods) {
      const prefix = `bundled/${m.sha256}/`;
      for (const entry of zip.entries) {
        if (entry.isDirectory || !entry.name.startsWith(prefix) || !isPlugin(entry.name)) continue;
        const out = path.join(tmp, "plugin");
        await pipeline(await zip.openEntry(entry), createWriteStream(out));
        const read = await readPluginHeader(out, undefined).catch(() => undefined);
        if (read?.kind === "ok") into.set(path.posix.basename(entry.name).toLowerCase(), [...read.masters]);
      }
    }
  } finally {
    await zip.close().catch(() => undefined);
    await fsp.rm(tmp, { recursive: true, force: true }).catch(() => undefined);
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
  /** The package being installed, for the masters of bundled mods not installed yet. */
  packagePath?: string,
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
      const notInstalledBundled: Array<{ name: string; sha256: string }> = [];
      for (const r of resolutions) {
        if (offKeys.has(r.compareKey)) continue;
        const mod = manifest.mods.find((m) => m.compareKey === r.compareKey);
        if (r.existingModId === undefined) {
          const src = mod?.source as { kind?: string; bundled?: boolean; sha256?: string } | undefined;
          if (src?.kind === "external" && src.bundled === true && typeof src.sha256 === "string") {
            notInstalledBundled.push({ name: r.name, sha256: src.sha256 });
          }
          continue;
        }
        const root = stagingRootForModId(state as never, gameId, r.existingModId);
        if (mod === undefined || root === undefined) continue;
        for (const f of mod.state?.stagingFiles ?? []) {
          if (!isPlugin(f.path)) continue;
          const read = await readPluginHeader(path.join(root, ...f.path.split("/")), undefined).catch(() => undefined);
          if (read?.kind === "ok") mastersOf.set(path.basename(f.path).toLowerCase(), [...read.masters]);
        }
      }
      if (packagePath !== undefined && notInstalledBundled.length > 0) {
        await bundledMasters(packagePath, notInstalledBundled, mastersOf).catch((err: unknown) =>
          ehLog("warn", "install.previous-revision.bundled-masters-unread", { mods: notInstalledBundled.length, err }),
        );
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

    const previousEnabledPlugins = carry.length > 0 ? await enabledPluginsOf(s, gameId, receipt.vortexProfileId) : undefined;

    ehLog("info", "install.previous-revision.choices", {
      keepOff: offers.length,
      refused: refused.map((r) => ({ mod: r.name, neededBy: r.neededBy.slice(0, 3) })),
      carry: carry.length,
      previousProfileFound: modState !== undefined,
      previousEnabledPlugins: previousEnabledPlugins?.length ?? "unread",
    });
    if (offers.length === 0 && refused.length === 0 && carry.length === 0) return undefined;
    return {
      keepOff: offers.map((o) => ({ compareKey: o.compareKey, name: o.name, keep: true })),
      refused,
      carry,
      ...(previousEnabledPlugins !== undefined ? { previousEnabledPlugins } : {}),
    };
  } catch (err) {
    ehLog("warn", "install.previous-revision.choices-failed", { err });
    return undefined;
  }
}
