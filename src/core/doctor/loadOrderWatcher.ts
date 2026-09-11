/**
 * ──────────────────────────────────────────────────────────────────────
 * Say so when the curator's load order stops being what loads.
 *
 * Vortex re-sorts plugins with LOOT on every deploy when auto-sort is on
 * (it is, by default), and on a Sort click regardless. The install's pin
 * and re-pin are undone in that instant, silently: nothing errors, every
 * file still verifies, and the game loads a different order than the
 * curator tested. Until now the only place that said so was one Doctor
 * card, read only when someone opened Doctor.
 *
 * This watches Vortex's plugin state and, on the TRANSITION into drift
 * (never on every tick of the same drift), raises one Vortex notification
 * with the fix on it. When the order comes back — the re-apply, or the
 * user's own Sort undone — the notification goes away by itself.
 *
 * Quiet while Event Horizon's own install or heal is writing the order:
 * the install pins, sorts and re-pins in three steps, and the middle one
 * is drift by design.
 * ──────────────────────────────────────────────────────────────────────
 */

import type { types } from "@nexusmods/vortex-api";

import { ehLog } from "../logging/ehLog";
import { getEHRuntime } from "../../ui/runtime/ehRuntime";
import type { InstallReceipt } from "../../types/installLedger";
import { assessLoadOrder, currentOrderFromState, describeLoadOrder, driftSignature, nativeNamesFromState, type LoadOrderStatus } from "./loadOrderStatus";
import type { HealOutcome } from "./runHeal";

export const LOAD_ORDER_NOTIFICATION_ID = "event-horizon-load-order-drift";

/** How long after the last loadOrder change to look: LOOT dispatches many. */
const SETTLE_MS = 2000;
/** The first look after start, so Vortex has loaded profiles and plugins. */
const FIRST_LOOK_MS = 8000;

/**
 * The newest receipt for a game that recorded a plugin order.
 *
 * Read from disk each time: receipts are a handful of small files, and an
 * install that just finished must be seen without a restart.
 */
export async function latestReceiptWithOrder(gameId: string): Promise<InstallReceipt | undefined> {
  const [{ listReceipts }, { getVortexUserDataPath }] = await Promise.all([
    import("../installLedger"),
    import("../paths"),
  ]);
  const receipts = await listReceipts(getVortexUserDataPath());
  return receipts
    .filter((r) => r.gameId === gameId && (r.rulesApplication?.baselinePluginOrder?.length ?? 0) > 0)
    .sort((a, b) => b.installedAt.localeCompare(a.installedAt))[0];
}

/** The receipt's order in the shape the assessment reads. */
export function baselineOf(receipt: InstallReceipt): { name: string; enabled: boolean }[] {
  return (receipt.rulesApplication?.baselinePluginOrder ?? []).map((e) => ({ name: e.name, enabled: e.enabled }));
}

/** Assess the active game's order from Vortex's state, against the newest receipt. */
export async function assessActiveGame(
  api: types.IExtensionApi,
): Promise<{ gameId: string; receipt: InstallReceipt; status: LoadOrderStatus } | undefined> {
  const state = api.getState();
  const gameId = activeGameIdOf(state);
  if (gameId === undefined) return undefined;
  const receipt = await latestReceiptWithOrder(gameId);
  if (receipt === undefined) return undefined;
  const status = assessLoadOrder({
    baseline: baselineOf(receipt),
    current: currentOrderFromState(state),
    natives: nativeNamesFromState(state),
  });
  return { gameId, receipt, status };
}

/**
 * Put the curator's order back: the install's own merge, no second sort.
 * Runs the Doctor heal so the two doors cannot disagree.
 */
export async function reapplyCuratorOrder(api: types.IExtensionApi, receipt: InstallReceipt): Promise<HealOutcome> {
  const { runHeal } = await import("./runHeal");
  return runHeal("repin-plugin-order", { api, gameId: receipt.gameId, receipt });
}

function activeGameIdOf(state: unknown): string | undefined {
  const s = state as { settings?: { profiles?: { activeProfileId?: string } }; persistent?: { profiles?: Record<string, { gameId?: string }> } };
  const pid = s?.settings?.profiles?.activeProfileId;
  if (pid === undefined) return undefined;
  const gameId = s?.persistent?.profiles?.[pid]?.gameId;
  return typeof gameId === "string" && gameId !== "" ? gameId : undefined;
}

/**
 * Start watching. Idempotent per process.
 *
 * `api.onStateChange` has no unsubscribe, so this registers exactly once
 * and keeps its own last-seen fingerprint per game.
 */
let started = false;
export function startLoadOrderWatcher(api: types.IExtensionApi): void {
  if (started) return;
  started = true;
  const lastSignature = new Map<string, string>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running = false;

  const look = async (): Promise<void> => {
    if (running) return;
    running = true;
    try {
      // Our own install or heal is rewriting the order; the middle of that
      // is drift by design.
      if (getEHRuntime().getSnapshot().installBusy) return;
      const found = await assessActiveGame(api);
      if (found === undefined) return;
      const { gameId, receipt, status } = found;
      const sig = driftSignature(status);
      const prev = lastSignature.get(gameId) ?? "";
      if (sig === prev) return;
      lastSignature.set(gameId, sig);
      if (sig === "") {
        api.dismissNotification?.(LOAD_ORDER_NOTIFICATION_ID);
        ehLog("info", "loadorder.watch.restored", { gameId });
        return;
      }
      const said = describeLoadOrder(status);
      ehLog("warn", "loadorder.watch.drifted", { gameId, package: receipt.packageName, headline: said.headline });
      api.sendNotification?.({
        id: LOAD_ORDER_NOTIFICATION_ID,
        type: "warning",
        title: "Your load order no longer matches the curator's",
        message:
          `${receipt.packageName}: ${said.headline}. Vortex's sort (automatic on deploy, or the Sort button) replaced ` +
          `the collection's pinned order. Your own plugins keep their places either way.`,
        displayMS: undefined,
        actions: [
          {
            title: "Re-apply curator's order",
            action: (dismiss): void => {
              void reapplyCuratorOrder(api, receipt).then(
                (outcome) => {
                  dismiss();
                  api.sendNotification?.({
                    type: outcome.kind === "done" ? "success" : "warning",
                    message: outcome.kind === "done" ? outcome.summary : outcome.kind === "blocked" ? outcome.reason : outcome.summary,
                    displayMS: 8000,
                  });
                },
                (err) => {
                  ehLog("error", "loadorder.watch.reapply.fail", { err });
                  api.sendNotification?.({ type: "error", message: `Could not re-apply the load order: ${err instanceof Error ? err.message : String(err)}` });
                },
              );
            },
          },
          {
            title: "Open Event Horizon",
            action: (dismiss): void => {
              api.events.emit("show-main-page", "Event Horizon");
              dismiss();
            },
          },
        ],
      });
    } catch (err) {
      ehLog("warn", "loadorder.watch.fail", { err });
    } finally {
      running = false;
    }
  };

  const schedule = (ms: number): void => {
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      void look();
    }, ms);
  };

  api.onStateChange?.(["loadOrder"], () => schedule(SETTLE_MS));
  api.onStateChange?.(["settings", "profiles", "activeProfileId"], () => schedule(SETTLE_MS));
  // An install that just wrote a receipt changes what "matches" means.
  api.events.on("did-install-mod", () => schedule(SETTLE_MS));
  schedule(FIRST_LOOK_MS);
  ehLog("info", "loadorder.watch.start");
}
