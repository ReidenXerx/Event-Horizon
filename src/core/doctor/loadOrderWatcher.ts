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
 * ─── WHICH RECEIPT IS COMPARED ─────────────────────────────────────────
 * Vortex holds one order: the active game's active profile. The receipt
 * compared is the one that OWNS it — the newest install into that game and
 * profile that pinned an order (`orderOwner`). A receipt for another game or
 * another profile is never compared, and when there is no owner the
 * notification is dismissed: left up, its Re-apply would be bound to a
 * receipt whose order is not the one on screen.
 * ──────────────────────────────────────────────────────────────────────
 */

import type { types } from "@nexusmods/vortex-api";

import { ehLog } from "../logging/ehLog";
import { getEHRuntime } from "../../ui/runtime/ehRuntime";
import type { InstallReceipt } from "../../types/installLedger";
import {
  activeContextFromState,
  assessReceiptOrder,
  baselineOf,
  canReapply,
  describeLoadOrder,
  driftSignature,
  orderOwner,
  pinnedAnOrder,
  receiptLabel,
  type ActiveContext,
  type LoadOrderStatus,
} from "./loadOrderStatus";
import type { HealOutcome } from "./runHeal";

export { baselineOf };

export const LOAD_ORDER_NOTIFICATION_ID = "event-horizon-load-order-drift";

/** How long after the last loadOrder change to look: LOOT dispatches many. */
const SETTLE_MS = 2000;
/** The first look after start, so Vortex has loaded profiles and plugins. */
const FIRST_LOOK_MS = 8000;

/**
 * Every receipt on the machine.
 *
 * Read from disk each time: receipts are a handful of small files, and an
 * install that just finished must be seen without a restart.
 */
async function readReceipts(): Promise<InstallReceipt[]> {
  const [{ listReceipts }, { getVortexUserDataPath }] = await Promise.all([
    import("../installLedger"),
    import("../paths"),
  ]);
  return listReceipts(getVortexUserDataPath());
}

export type ActiveOrderLook =
  | {
      kind: "nothing";
      /** Why there is no receipt whose order this is. */
      reason: "no-active-game" | "no-receipt" | "other-profile";
      active: ActiveContext;
      /** Receipts for this game that live in other profiles, by label. */
      elsewhere: string[];
    }
  | {
      kind: "assessed";
      active: ActiveContext;
      receipt: InstallReceipt;
      status: LoadOrderStatus;
      /** Older installs into the same profile, which this one supersedes. */
      superseded: string[];
    };

/** The active order, against the receipt that owns it — or why there is none. */
export async function assessActiveOrder(api: types.IExtensionApi): Promise<ActiveOrderLook> {
  const state = api.getState();
  const active = activeContextFromState(state);
  if (active.gameId === undefined) return { kind: "nothing", reason: "no-active-game", active, elsewhere: [] };
  const receipts = await readReceipts();
  const owner = orderOwner(receipts, active);
  const sameGame = receipts.filter((r) => r.gameId === active.gameId && pinnedAnOrder(r));
  if (owner === undefined) {
    return {
      kind: "nothing",
      reason: sameGame.length > 0 ? "other-profile" : "no-receipt",
      active,
      elsewhere: sameGame.map((r) => `${receiptLabel(r)} in "${r.vortexProfileName}"`),
    };
  }
  return {
    kind: "assessed",
    active,
    receipt: owner,
    status: assessReceiptOrder({ receipt: owner, receipts, state }),
    superseded: sameGame.filter((r) => r !== owner && r.vortexProfileId === active.profileId).map(receiptLabel),
  };
}

/**
 * Put the curator's order back: the install's own merge, no second sort.
 * Runs the Doctor heal so the two doors cannot disagree — and refuses first
 * unless this receipt owns the order that is active right now.
 */
export async function reapplyCuratorOrder(api: types.IExtensionApi, receipt: InstallReceipt): Promise<HealOutcome> {
  const receipts = await readReceipts();
  const status = assessReceiptOrder({ receipt, receipts, state: api.getState() });
  if (!canReapply(status)) {
    ehLog("warn", "loadorder.reapply.refused", {
      package: receiptLabel(receipt),
      gameId: receipt.gameId,
      profile: receipt.vortexProfileName,
      status: status.kind,
    });
    return {
      kind: "blocked",
      reason: `${describeLoadOrder(status).headline} Its order is not the one Vortex has active, so there is nothing to re-apply it into.`,
    };
  }
  const { runHeal } = await import("./runHeal");
  return runHeal("repin-plugin-order", { api, gameId: receipt.gameId, receipt });
}

/**
 * Start watching. Idempotent per process.
 *
 * `api.onStateChange` has no unsubscribe, so this registers exactly once
 * and keeps what it last showed.
 */
let started = false;
export function startLoadOrderWatcher(api: types.IExtensionApi): void {
  if (started) return;
  started = true;
  /** The receipt (game|profile|package) and drift signature last acted on. */
  let shown: { key: string; sig: string } | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running = false;

  const look = async (): Promise<void> => {
    if (running) return;
    running = true;
    try {
      // Our own install or heal is rewriting the order; the middle of that
      // is drift by design.
      if (getEHRuntime().getSnapshot().installBusy) return;
      const found = await assessActiveOrder(api);
      if (found.kind === "nothing") {
        // Nothing of ours to judge. A notification still up would carry a
        // Re-apply bound to another game's or profile's receipt.
        if (shown !== undefined) {
          api.dismissNotification?.(LOAD_ORDER_NOTIFICATION_ID);
          shown = undefined;
        }
        return;
      }
      const { active, receipt, status } = found;
      const key = `${active.gameId}|${active.profileId}|${receipt.packageId}`;
      const sig = driftSignature(status);
      if (shown !== undefined && shown.key === key && shown.sig === sig) return;
      const wasShowing = shown !== undefined && shown.sig !== "";
      shown = { key, sig };
      if (sig === "") {
        if (wasShowing) {
          api.dismissNotification?.(LOAD_ORDER_NOTIFICATION_ID);
          ehLog("info", "loadorder.watch.restored", { gameId: active.gameId, profile: active.profileName, package: receiptLabel(receipt) });
        }
        return;
      }
      const said = describeLoadOrder(status);
      ehLog("warn", "loadorder.watch.drifted", { gameId: active.gameId, profile: active.profileName, package: receiptLabel(receipt), headline: said.headline });
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
