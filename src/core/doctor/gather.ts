/**
 * Read the current state of the machine, so {@link evaluateHealth} can compare
 * it against the receipt.
 *
 * All the I/O and all the Vortex-shape guessing lives here, which is what
 * keeps the diagnosis itself pure and testable. The split is the point: this
 * file is hard to test and easy to reason about, the other one is the reverse.
 *
 * ─── EVERY READ FAILS SOFT, AND SAYS SO ────────────────────────────────
 * A reader that throws would take the whole health check down over one
 * unfamiliar state shape. A reader that returns a plausible-looking default
 * would be worse: `0` rules present reads as "all your rules are gone", which
 * is a false alarm that sends someone re-applying rules they never lost.
 *
 * So every field is `| undefined`, and `undefined` means "could not read this"
 * — which the checks render as `unknown` rather than as a pass or a failure.
 * That is the whole reason HealthStatus has five states.
 */

import type { types } from "@nexusmods/vortex-api";

import { beginOp, ehLog } from "../logging/ehLog";
import type { HealthObservations } from "./health";
import type { OrderReceipt, OrderStanding } from "./loadOrderStatus";

/** Profiles that exist for a game, by id. */
function readProfileIds(state: unknown, gameId: string): string[] {
  const profiles = (
    state as {
      persistent?: { profiles?: Record<string, { gameId?: string }> };
    }
  )?.persistent?.profiles;
  if (profiles === null || typeof profiles !== "object") return [];
  return Object.entries(profiles)
    .filter(([, p]) => p?.gameId === gameId)
    .map(([id]) => id);
}

function readInstalledModIds(state: unknown, gameId: string): string[] {
  const mods = (
    state as { persistent?: { mods?: Record<string, Record<string, unknown>> } }
  )?.persistent?.mods?.[gameId];
  if (mods === null || typeof mods !== "object" || mods === undefined) return [];
  return Object.keys(mods);
}

/**
 * Mods enabled in a specific profile.
 *
 * Note this reads the RECEIPT's profile, not the active one. A collection
 * installed into its own profile is still perfectly healthy while the user is
 * looking at a different profile — that is a separate check, and conflating
 * them would report every mod as disabled the moment someone switched away.
 */
function readEnabledModIds(state: unknown, profileId: string): string[] {
  const modState = (
    state as {
      persistent?: {
        profiles?: Record<string, { modState?: Record<string, { enabled?: boolean }> }>;
      };
    }
  )?.persistent?.profiles?.[profileId]?.modState;
  if (modState === null || typeof modState !== "object" || modState === undefined) {
    return [];
  }
  return Object.entries(modState)
    .filter(([, v]) => v?.enabled === true)
    .map(([id]) => id);
}

/** Total mod rules currently set for a game, across every mod. */
function countModRules(state: unknown, gameId: string): number | undefined {
  const mods = (
    state as {
      persistent?: { mods?: Record<string, Record<string, { rules?: unknown[] }>> };
    }
  )?.persistent?.mods?.[gameId];
  if (mods === null || typeof mods !== "object" || mods === undefined) {
    return undefined;
  }
  let total = 0;
  for (const mod of Object.values(mods)) {
    if (Array.isArray(mod?.rules)) total += mod.rules.length;
  }
  return total;
}

export interface GatherOptions {
  api: types.IExtensionApi;
  gameId: string;
  /** The profile the receipt says the collection lives in. */
  receiptProfileId: string;
  /**
   * Compare keys whose staging folders drifted, from a deep scan.
   *
   * Omitted on the cheap pass. Left `undefined` rather than `[]` because an
   * empty array means "checked, nothing drifted" and that is a much stronger
   * claim than "did not look".
   */
  driftedCompareKeys?: readonly string[];
  /**
   * The plugins the receipt recorded, so the ESL flags can be re-read from
   * disk and compared. Only entries carrying a `light` value are checked —
   * a package that recorded none gives nothing to check, which is "unknown"
   * rather than "fine".
   */
  recordedPlugins?: readonly { name: string; light?: boolean }[];
  /**
   * The receipt being diagnosed, and every receipt on the machine. Whether
   * its load order may be judged at all depends on both: Vortex holds one
   * order — the active game's active profile — and the newest install into
   * that profile owns it. Without them the order check falls back to the
   * profile comparison alone.
   */
  orderReceipt?: OrderReceipt;
  receipts?: readonly OrderReceipt[];
}

/**
 * Everything the checks need, read from Vortex and disk.
 *
 * Cheap by default: the only I/O is one plugins.txt read. The expensive part —
 * hashing every mod's files — is passed in by the caller when the user asks
 * for it.
 */
export async function gatherObservations(
  opts: GatherOptions,
): Promise<HealthObservations> {
  const { api, gameId, receiptProfileId } = opts;
  const op = beginOp("doctor.gather", {
    gameId,
    receiptProfileId,
    deepScan: opts.driftedCompareKeys !== undefined,
  });
  const state = api.getState();

  const [{ getActiveProfileId }, { readUserPluginsTxt }, { captureUserlist }] =
    await Promise.all([
      import("../getModsListForProfile"),
      import("../installer/checkPluginOrder"),
      import("../userlist"),
    ]);

  // Keeps `enabled`. Flattening to names here is what forced the health
  // check to compare positions blind and call every healthy install drifted.
  let currentPluginOrder: { name: string; enabled: boolean }[] | undefined;
  try {
    // Store-aware: a GOG Skyrim SE keeps plugins.txt under a different
    // folder, and reading the Steam name reports an empty order as though
    // the game simply had none.
    const { discoveredStore } = await import("../comparePlugins");
    const entries = await readUserPluginsTxt(gameId, discoveredStore(state, gameId));
    // undefined means "this game has no plugins.txt", which the check renders
    // as not-applicable rather than as a problem.
    currentPluginOrder = entries?.map((e) => ({ name: e.name, enabled: e.enabled }));
  } catch (err) {
    // Swallowed on purpose (see file header) — but silence here is exactly
    // what makes "no plugins.txt" indistinguishable from "could not read it".
    ehLog("debug", "doctor.gather.plugins-txt-unreadable", { gameId, err });
    currentPluginOrder = undefined;
  }

  /**
   * ─── COUNT WHAT EACH COUNTER ACTUALLY COUNTS ─────────────────────────
   * This was `captured.plugins.length` for both, with a comment saying it
   * matched `appliedRuleCount`. It does not: the install increments
   * `appliedRuleCount` once per ORDERING rule dispatched (after / req / inc)
   * and `appliedGroupAssignmentCount` once per SET_PLUGIN_GROUP, while
   * `plugins.length` counts ENTRIES — and one entry can carry a group, three
   * `after` rules, both, or neither.
   *
   * A collection that assigns groups and sets no ordering rules therefore
   * compared 0 against 501 and reported permanent drift on a healthy install.
   */
  let currentUserlistRuleCount: number | undefined;
  let currentUserlistGroupAssignmentCount: number | undefined;
  try {
    const captured = captureUserlist(state);
    currentUserlistRuleCount = captured.plugins.reduce(
      (n, p) =>
        n +
        (p.after?.length ?? 0) +
        (p.req?.length ?? 0) +
        (p.inc?.length ?? 0),
      0,
    );
    currentUserlistGroupAssignmentCount = captured.plugins.filter(
      (p) => p.group !== undefined && p.group !== "",
    ).length;
  } catch (err) {
    ehLog("debug", "doctor.gather.userlist-unreadable", { err });
    currentUserlistRuleCount = undefined;
    currentUserlistGroupAssignmentCount = undefined;
  }

  /**
   * ─── THE FLAGS AS THEY ARE ON DISK RIGHT NOW ───────────────────────
   * Read from the deployed plugin headers, not from Vortex's state, because
   * the flag IS the file's bytes and that is what the game parses at launch.
   *
   * Under copy deployment a Vortex purge rewrites those files from staging
   * and silently undoes the install's repair. Nothing re-checked, so a
   * profile could go hundreds of plugins over the 254 limit — the game stops
   * starting — while Doctor reported everything healthy.
   */
  let currentPluginLightFlags: Record<string, boolean> | undefined;
  try {
    const [{ readPluginFlags }, { getGameDirectory }] = await Promise.all([
      import("../manifest/pluginFlags"),
      import("../manifest/externalDependencies"),
    ]);
    const gameDir = getGameDirectory(state, gameId);
    const baseline = opts.recordedPlugins ?? [];
    // Only the plugins the package recorded a flag for: everything else is an
    // unknown, and an unknown is not drift.
    const wanted = baseline.filter((p) => p.light !== undefined);
    if (gameDir === undefined || wanted.length === 0) {
      currentPluginLightFlags = undefined;
    } else {
      const nodePath = await import("path");
      const found: Record<string, boolean> = {};
      for (const p of wanted) {
        const flags = await readPluginFlags(
          nodePath.join(gameDir, "Data", p.name),
        );
        // Absent stays absent — a plugin we could not read is not evidence
        // that its flag changed.
        if (flags !== undefined) found[p.name.toLowerCase()] = flags.isLight;
      }
      currentPluginLightFlags = found;
    }
  } catch (err) {
    ehLog("debug", "doctor.gather.light-flags-unreadable", { err });
    currentPluginLightFlags = undefined;
  }

  // Vortex's own order (what the watcher compares), and whether the file
  // on disk has caught up with it. Natives are excluded on the state side
  // because Vortex never writes them to loadOrder; the same set is dropped
  // from the file side so the two compare like with like.
  let currentPluginOrderFromState: { name: string; enabled: boolean }[] | undefined;
  let pluginsTxtMismatch: boolean | undefined;
  let nativePluginNames: string[] | undefined;
  let loadOrderStanding: OrderStanding | undefined;
  try {
    const { currentOrderFromState, nativeNamesFromState, activeContextFromState, standingOf } = await import(
      "./loadOrderStatus"
    );
    currentPluginOrderFromState = currentOrderFromState(state);
    const natives = nativeNamesFromState(state);
    nativePluginNames = [...natives];
    if (opts.orderReceipt !== undefined) {
      const active = activeContextFromState(state);
      loadOrderStanding = standingOf(opts.orderReceipt, opts.receipts ?? [], active);
      // Which receipt was compared against which order: without this a
      // report of "Doctor says drifted" cannot be told from one about the
      // wrong profile.
      ehLog("info", "doctor.gather.load-order-standing", {
        package: opts.orderReceipt.packageName,
        receiptGame: opts.orderReceipt.gameId,
        receiptProfile: opts.orderReceipt.vortexProfileName ?? opts.orderReceipt.vortexProfileId,
        activeGame: active.gameId,
        activeProfile: active.profileName ?? active.profileId,
        standing: loadOrderStanding.kind,
        ...(loadOrderStanding.kind === "superseded" ? { supersededBy: loadOrderStanding.by } : {}),
      });
    }
    if (currentPluginOrderFromState !== undefined && currentPluginOrder !== undefined) {
      const fileNonNative = currentPluginOrder
        .filter((p) => !natives.has(p.name.trim().toLowerCase()))
        .filter((p) => p.enabled)
        .map((p) => p.name.trim().toLowerCase());
      const stateEnabled = currentPluginOrderFromState.filter((p) => p.enabled).map((p) => p.name.trim().toLowerCase());
      pluginsTxtMismatch = fileNonNative.join("\n") !== stateEnabled.join("\n");
    }
  } catch (err) {
    ehLog("debug", "doctor.gather.state-order-unreadable", { err });
    currentPluginOrderFromState = undefined;
  }

  let activeProfileId: string | undefined;
  try {
    activeProfileId = getActiveProfileId(state);
  } catch (err) {
    ehLog("debug", "doctor.gather.active-profile-unreadable", { err });
    activeProfileId = undefined;
  }

  const observations: HealthObservations = {
    existingProfileIds: readProfileIds(state, gameId),
    activeProfileId,
    installedModIds: readInstalledModIds(state, gameId),
    enabledModIds: readEnabledModIds(state, receiptProfileId),
    driftedCompareKeys: opts.driftedCompareKeys,
    currentPluginOrder,
    ...(currentPluginOrderFromState !== undefined ? { currentPluginOrderFromState } : {}),
    ...(pluginsTxtMismatch !== undefined ? { pluginsTxtMismatch } : {}),
    ...(nativePluginNames !== undefined ? { nativePluginNames } : {}),
    ...(loadOrderStanding !== undefined ? { loadOrderStanding } : {}),
    currentModRuleCount: countModRules(state, gameId),
    currentUserlistRuleCount,
    currentUserlistGroupAssignmentCount,
    ...(currentPluginLightFlags !== undefined
      ? { currentPluginLightFlags }
      : {}),
  };
  op.ok({
    profiles: observations.existingProfileIds.length,
    installedMods: observations.installedModIds.length,
    enabledMods: observations.enabledModIds.length,
    driftedCompareKeys: observations.driftedCompareKeys?.length,
    pluginOrderEntries: observations.currentPluginOrder?.length,
    modRules: observations.currentModRuleCount,
    userlistRules: observations.currentUserlistRuleCount,
  });
  return observations;
}
