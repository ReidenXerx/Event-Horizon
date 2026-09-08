/**
 * ──────────────────────────────────────────────────────────────────────
 * Put the curator's plugin order on disk, and let LOOT place everything else.
 *
 * ─── THE PREMISE THIS CORRECTS ─────────────────────────────────────────
 * The load-order strategy was "detect, don't pin", on the grounds that
 * plugins.txt cannot be written because Vortex and LOOT regenerate it. That is
 * false, and the evidence is in Vortex's own `gamebryo-plugin-management`:
 * `PluginPersistor.syncFromState` exists specifically to flush the redux
 * loadOrder hive to plugins.txt after a collection install — its error string
 * is "failed to write plugin state after collection install". The old
 * `pluginsTxt.ts` writer failed because it wrote the FILE, which Vortex owns;
 * the supported route is to write the STATE and ask Vortex to persist it.
 *
 * ─── PIN, THEN SORT ────────────────────────────────────────────────────
 * Three events, in this order:
 *
 *   1. `set-plugin-list` → dispatches `updatePluginOrder(names, false, …)`.
 *      Our plugins take the curator's exact order. Plugins the collection does
 *      not contain are APPENDED after ours, keeping their enabled state — the
 *      reducer says so: "now deal with the rest, appending them to the list".
 *
 *   2. `autosort-plugins` → LOOT. Vortex feeds it the plugin list sorted by
 *      the CURRENT order ("apply existing ordering (as far as available)"),
 *      and libloot's sort is topological with that input order as the
 *      tiebreak. So step 1 becomes the baseline: our relative order survives
 *      wherever nothing forces otherwise, while masters, the curator's userlist
 *      rules and the masterlist pull the user's extra plugins UP into their
 *      correct positions instead of leaving them stranded at the end.
 *
 *   3. `collection-postprocess-complete` → `syncFromState` writes plugins.txt.
 *
 * ─── WHY THE ORDER OF THOSE THREE IS THE WHOLE SAFETY ARGUMENT ─────────
 * Sorting can fail: LOOT refuses to sort at all when rules form a cycle
 * ("Cyclic interaction" → Vortex's "Plugins not sorted because of cyclic
 * rules"). That is exactly why the earlier "~399 explicit LOOT rules" idea was
 * rejected — a cycle meant NO sort, which is worse than drift.
 *
 * Pinning first removes that objection. If the sort fails, times out, or the
 * event does not exist, the pinned order is already in the hive and still gets
 * written. The cost of failure is the interleaving, never the order.
 *
 * ─── WHAT IT DOES NOT CLAIM ────────────────────────────────────────────
 * LOOT may move the curator's own plugins where its masterlist demands it — a
 * master-order violation, or simply a newer masterlist than the curator had.
 * That is LOOT being right, and it shows up in the drift report afterwards,
 * which is what makes that number diagnostic rather than decorative.
 * ──────────────────────────────────────────────────────────────────────
 */

import type { types } from "@nexusmods/vortex-api";

import { ehLog, beginOp } from "../logging/ehLog";
import type { EhcollPluginEntry } from "../../types/ehcoll";

/** Redux action from gamebryo-plugin-management: `(pluginName, enabled)`. */
const ACTION_SET_PLUGIN_ENABLED = "SET_PLUGIN_ENABLED";

/**
 * How long to wait for LOOT before giving up and keeping the pinned order.
 *
 * Sorting ~800 plugins is seconds natively and meaningfully slower under a
 * Wine prefix, so this is deliberately generous — but it MUST exist. The sort
 * is an event with a callback, and an event that never calls back would hang
 * the install at the very last step, after everything else succeeded.
 */
const SORT_TIMEOUT_MS = 10 * 60 * 1000;

export type PluginOrderApplication = {
  /** The curator's order reached Vortex's state. */
  pinned: boolean;
  /** LOOT ran and integrated plugins outside the collection. */
  sorted: boolean;
  /**
   * ─── ASKED, NOT CONFIRMED ───────────────────────────────────────────
   * `events.emit` is fire-and-forget, so this is set on the absence of a
   * synchronous throw and means "Vortex was asked to flush the order to
   * plugins.txt" — nothing more. It was named `written`, and every consumer
   * read it as an outcome: the notice stayed silent on
   * `pinned && sorted && written`, and Doctor's heal reported "Restored the
   * recorded order" on `pinned` alone.
   *
   * Renamed so the name cannot be misread. The driver confirms separately by
   * reading plugins.txt off disk — `readUserPluginsTxt`, which exists a few
   * lines later and whose own docblock says the point is to compare against
   * reality rather than against what state believes reality to be.
   */
  writeRequested: boolean;
  /** Plugins whose enabled state was corrected to match the curator's. */
  enabledCorrections: number;
  /** Why a step did not happen. Never silent. */
  notes: string[];
};

export type ApplyPluginOrderInput = {
  api: types.IExtensionApi;
  gameId: string;
  /** Only used for traceability — Vortex's handler ignores it. */
  collectionId: string;
  order: readonly EhcollPluginEntry[];
  /** Overridable so a test does not wait ten minutes on a fake that never calls back. */
  sortTimeoutMs?: number;
  /**
   * Pin and write, but do NOT run LOOT's sort.
   *
   * For the RE-PIN that follows the ordinary pin-sort pass: that pass exists
   * to let LOOT place plugins the curator never had, and the re-pin then gives
   * the collection's own plugins the curator's order back. Sorting again would
   * undo exactly what it just restored.
   */
  skipSort?: boolean;
  signal?: AbortSignal;
};

/**
 * Never throws. A load order we could not set is a worse install, not a failed
 * one — the mods are already on disk and correct by this point, and the drift
 * report will say what happened.
 */
export async function applyPluginOrder(
  input: ApplyPluginOrderInput,
): Promise<PluginOrderApplication> {
  const result: PluginOrderApplication = {
    pinned: false,
    sorted: false,
    writeRequested: false,
    enabledCorrections: 0,
    notes: [],
  };

  const op = beginOp("plugin-order", {
    gameId: input.gameId,
    entries: input.order.length,
  });

  if (input.order.length === 0) {
    result.notes.push("the collection recorded no plugin order");
    op.ok({ reason: "empty-order" });
    return result;
  }

  const events = (
    input.api as unknown as {
      events?: { emit?: (event: string, ...args: unknown[]) => void };
    }
  ).events;
  if (typeof events?.emit !== "function") {
    result.notes.push(
      "this Vortex has no event bus to set the plugin order through",
    );
    op.ok({ reason: "no-event-bus" });
    return result;
  }

  // ── 1. pin ────────────────────────────────────────────────────────────
  // `setEnabled: false` on purpose. Passing true would force-enable ours AND
  // DISABLE every plugin the user added themselves — silently switching off
  // mods they chose to install is not ours to do.
  try {
    events.emit(
      "set-plugin-list",
      input.order.map((p) => p.name),
      false,
    );
    result.pinned = true;
    ehLog("debug", "plugin-order.pin.ok", { entries: input.order.length });
  } catch (err) {
    result.notes.push(
      `could not set the plugin order: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    op.fail(err, { entries: input.order.length });
    return result;
  }

  // ── 1b. the curator's enabled state ───────────────────────────────────
  // `setEnabled: false` above means our plugins keep whatever state they had,
  // so a plugin the curator deliberately turned OFF would still load here.
  // One such plugin is enough to change what the game does.
  //
  // Only where it actually DIFFERS. Dispatching all 817 unconditionally was
  // 817 synchronous Redux actions — every one waking subscribers and the
  // plugin list's React tree — to change about one of them. It also made
  // `enabledCorrections` count dispatches rather than corrections, which is
  // the kind of number that reads as a finding and is really just a loop
  // bound.
  const currentEnabled = readEnabledState(input.api);
  let enabledCorrectionFailures = 0;
  for (const plugin of input.order) {
    if (input.signal?.aborted === true) break;
    const id = toPluginId(plugin.name);
    // `undefined` means Vortex has no entry for this plugin — it is not
    // deployed here, most likely because its mod failed to install. Setting a
    // state for it would invent an entry; the persistor writes only deployed
    // plugins anyway, so there is nothing to correct.
    if (currentEnabled[id] === undefined) continue;
    if (currentEnabled[id] === plugin.enabled) continue;
    try {
      dispatchRaw(input.api, ACTION_SET_PLUGIN_ENABLED, {
        pluginName: plugin.name,
        enabled: plugin.enabled,
      });
      result.enabledCorrections += 1;
    } catch (err) {
      // Individually unimportant; the count tells the caller how many landed.
      enabledCorrectionFailures += 1;
      ehLog("debug", "plugin-order.enabled-correction.fail", {
        plugin: plugin.name,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }
  if (result.enabledCorrections > 0 || enabledCorrectionFailures > 0) {
    ehLog("info", "plugin-order.enabled-corrections", {
      corrected: result.enabledCorrections,
      failed: enabledCorrectionFailures,
    });
  }

  // ── 2. sort ───────────────────────────────────────────────────────────
  if (input.skipSort === true) {
    ehLog("debug", "plugin-order.sort.skipped", {
      why: "re-pin: this order is the sort's result with the curator's own plugins restored",
    });
  } else if (input.signal?.aborted !== true) {
    const sortNote = await runLootSort(
      events.emit.bind(events),
      input.sortTimeoutMs ?? SORT_TIMEOUT_MS,
    );
    if (sortNote === undefined) {
      result.sorted = true;
      ehLog("info", "plugin-order.sort.ok", { entries: input.order.length });
    } else {
      result.notes.push(sortNote);
      ehLog("warn", "plugin-order.sort.degraded", { note: sortNote });
    }
  }

  // ── 3. write ──────────────────────────────────────────────────────────
  // Emitted even when the sort failed: the pinned order is in the hive and
  // deserves to reach disk. This is the step that makes any of it survive.
  try {
    events.emit(
      "collection-postprocess-complete",
      input.gameId,
      input.collectionId,
    );
    result.writeRequested = true;
    ehLog("debug", "plugin-order.write.ok", {});
  } catch (err) {
    result.notes.push(
      `Vortex would not flush the order to plugins.txt: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    ehLog("error", "plugin-order.write.fail", {
      err: err instanceof Error ? err.message : String(err),
    });
  }

  op.ok({
    pinned: result.pinned,
    sorted: result.sorted,
    writeRequested: result.writeRequested,
    enabledCorrections: result.enabledCorrections,
    notes: result.notes.length,
  });
  return result;
}

/** `undefined` when the sort succeeded, else why it did not. */
function runLootSort(
  emit: (event: string, ...args: unknown[]) => void,
  timeoutMs: number,
): Promise<string | undefined> {
  return new Promise<string | undefined>((resolve) => {
    let settled = false;
    const finish = (note: string | undefined): void => {
      if (settled) return;
      settled = true;
      resolve(note);
    };

    const timer = setTimeout(() => {
      ehLog("warn", "plugin-order.sort.timeout", { timeoutMs });
      finish(
        `LOOT did not finish sorting within ${Math.round(
          timeoutMs / 1000,
        )}s — the collection's own order was kept, but plugins outside it may ` +
          `sit at the end of the list`,
      );
    }, timeoutMs);
    // Node keeps the process alive for a pending timer; this one must not.
    (timer as unknown as { unref?: () => void }).unref?.();

    try {
      emit("autosort-plugins", true, (err: Error | null | undefined) => {
        clearTimeout(timer);
        if (err !== null && err !== undefined) {
          ehLog("warn", "plugin-order.sort.cycle", { err: err.message });
        }
        finish(
          err === null || err === undefined
            ? undefined
            : // A cycle is the expected failure and it is not ours to fix: the
              // user's masterlist disagrees with the curator's rules. The
              // pinned order stands.
              `LOOT could not sort: ${err.message}. The collection's own ` +
                `order was kept.`,
        );
      });
    } catch (err) {
      clearTimeout(timer);
      ehLog("error", "plugin-order.sort.emit-fail", {
        err: err instanceof Error ? err.message : String(err),
      });
      finish(
        `LOOT sorting is not available here: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  });
}

/**
 * Vortex's plugin id: lowercased, with a `.ghost` suffix stripped.
 *
 * Mirrors the extension's own `toPluginId`, which every one of its reducers
 * keys on. Comparing against a raw filename would miss every entry and make
 * the diff below think nothing matches — i.e. silently restore the
 * dispatch-everything behaviour this replaces.
 */
function toPluginId(name: string): string {
  const lower = name.toLowerCase();
  return lower.endsWith(".ghost") ? lower.slice(0, -".ghost".length) : lower;
}

/** Current enabled state per plugin id, or `{}` when unreadable. */
function readEnabledState(api: types.IExtensionApi): Record<string, boolean> {
  try {
    const state = api.getState() as unknown as {
      loadOrder?: Record<string, { enabled?: boolean }>;
    };
    const out: Record<string, boolean> = {};
    for (const [id, entry] of Object.entries(state?.loadOrder ?? {})) {
      if (typeof entry?.enabled === "boolean") out[id] = entry.enabled;
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * Dispatch a raw `{ type, payload }`.
 *
 * The same deliberate sidestep `applyUserlist` makes: these reducers are
 * registered by another extension, so there is no typed action creator to
 * import, and the runtime is an ordinary Redux store.
 */
function dispatchRaw(
  api: types.IExtensionApi,
  type: string,
  payload: Record<string, unknown>,
): void {
  const store = api.store as unknown as {
    dispatch?: (action: { type: string; payload: unknown }) => void;
  };
  if (typeof store?.dispatch !== "function") {
    throw new Error("no redux store available");
  }
  store.dispatch({ type, payload });
}

/**
 * One line for the install result, or `undefined` when it all worked.
 *
 * Silence on success is deliberate: "your load order was set correctly" is the
 * expected outcome, and a notice announcing it would compete with the ones
 * that need reading.
 */
export function describePluginOrderApplication(
  result: PluginOrderApplication,
): string[] | undefined {
  if (result.pinned && result.sorted && result.writeRequested) return undefined;
  if (!result.pinned && result.notes.length === 0) return undefined;

  const lines: string[] = [];
  if (!result.pinned) {
    lines.push(
      `The collection's plugin order could not be applied, so your existing ` +
        `order is unchanged.`,
    );
  } else if (!result.writeRequested) {
    lines.push(
      `The collection's plugin order was set in Vortex but may not have been ` +
        `written to plugins.txt. Sorting plugins in Vortex once will save it.`,
    );
  } else if (!result.sorted) {
    lines.push(
      `The collection's plugin order was applied. Plugins you added yourself ` +
        `could not be sorted into it, so they load after the collection.`,
    );
  }
  lines.push(...result.notes.map((n) => `  - ${n}`));
  return lines;
}
