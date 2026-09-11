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
 *
 * ─── QUIET WHILE AN INSTALL WRITES ─────────────────────────────────────
 * While an install — or a curator bulk run, which raises the same
 * `installBusy` flag — is running, the order is mid-rewrite: pin, sort,
 * re-pin, and the middle step is drift by design. The watcher does not judge
 * it then, takes down any notification (its Re-apply would write concurrently
 * with the install), and looks again the moment the flag drops. A re-apply
 * needs no such fence: it pins and writes with no sort in between, and the
 * look that follows reads the finished order.
 *
 * Every skip, every assessment and every re-apply is logged with the receipt
 * and profile it concerned, so a report of "it said drifted" can be answered
 * from the log alone.
 * ──────────────────────────────────────────────────────────────────────
 */

import type { types } from "@nexusmods/vortex-api";

import { ehLog } from "../logging/ehLog";
import { getEHRuntime } from "../../ui/runtime/ehRuntime";
import type { InstallReceipt } from "../../types/installLedger";
import { healingBlockedReason } from "./health";
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

/** The re-apply running right now, if one is. Set synchronously, so a double click sees it. */
let reapplyInFlight: Promise<HealOutcome> | undefined;

/**
 * Why a re-apply may not start right now, or undefined.
 *
 * The Doctor card's rule — `healingBlockedReason`: the heal re-runs a step of
 * the install pipeline, and two writers at once is how a collection gets
 * quietly corrupted — read from the runtime flag every install and curator
 * run raises, so the notification and the Home badge, which have no install
 * session to ask, refuse on the same grounds. And one re-apply at a time.
 */
export function reapplyBlockedReason(): string | undefined {
  if (getEHRuntime().getSnapshot().installBusy) return healingBlockedReason({ kind: "installing" });
  if (reapplyInFlight !== undefined) return "The curator's order is already being re-applied.";
  return undefined;
}

/**
 * Put the curator's order back: the install's own merge, no second sort.
 * Runs the Doctor heal so the two doors cannot disagree — and refuses first
 * while an install runs, while another re-apply runs, and unless this
 * receipt owns the order that is active right now.
 */
export function reapplyCuratorOrder(api: types.IExtensionApi, receipt: InstallReceipt): Promise<HealOutcome> {
  const blocked = reapplyBlockedReason();
  if (blocked !== undefined) {
    ehLog("info", "loadorder.reapply.refused", {
      why: getEHRuntime().getSnapshot().installBusy ? "install-running" : "already-running",
      package: receiptLabel(receipt),
    });
    return Promise.resolve({ kind: "blocked", reason: blocked });
  }
  const run = reapplyOwned(api, receipt);
  reapplyInFlight = run;
  const clear = (): void => {
    if (reapplyInFlight === run) reapplyInFlight = undefined;
  };
  run.then(clear, clear);
  return run;
}

async function reapplyOwned(api: types.IExtensionApi, receipt: InstallReceipt): Promise<HealOutcome> {
  const receipts = await readReceipts();
  const state = api.getState();
  const active = activeContextFromState(state);
  const status = assessReceiptOrder({ receipt, receipts, state });
  const where = {
    package: receiptLabel(receipt),
    gameId: receipt.gameId,
    receiptProfile: receipt.vortexProfileName,
    activeProfile: active.profileName ?? active.profileId,
  };
  if (!canReapply(status)) {
    ehLog("warn", "loadorder.reapply.refused", { why: status.kind, ...where });
    return {
      kind: "blocked",
      reason: `${describeLoadOrder(status).headline} Its order is not the one Vortex has active, so there is nothing to re-apply it into.`,
    };
  }
  const { runHeal } = await import("./runHeal");
  const outcome = await runHeal("repin-plugin-order", { api, gameId: receipt.gameId, receipt });
  ehLog(outcome.kind === "done" ? "info" : "warn", "loadorder.reapply.done", {
    ...where,
    before: status.kind,
    moved: status.kind === "drifted" ? status.drift.misordered.length : 0,
    outcome: outcome.kind,
    ...(outcome.kind === "blocked" ? { reason: outcome.reason } : { summary: outcome.summary }),
  });
  return outcome;
}

/**
 * Start watching. Idempotent per process.
 *
 * `api.onStateChange` and the runtime subscription have no teardown here, so
 * this registers exactly once and keeps what it last showed.
 */
let started = false;
export function startLoadOrderWatcher(api: types.IExtensionApi): void {
  if (started) return;
  started = true;
  /** The receipt (game|profile|package) and drift signature last acted on. */
  let shown: { key: string; sig: string } | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running = false;
  /** A change arrived while a look was running; look again after it. */
  let rerun = false;
  /** The last skip logged, so a skip is one line and not one per tick. */
  let lastSkip = "";

  const dismiss = (why: string): void => {
    if (shown !== undefined && shown.sig !== "") {
      api.dismissNotification?.(LOAD_ORDER_NOTIFICATION_ID);
      ehLog("info", "loadorder.watch.dismissed", { why });
    }
    shown = undefined;
  };

  const skip = (reason: string, data: Record<string, unknown>): void => {
    const k = `${reason}|${JSON.stringify(data)}`;
    if (k === lastSkip) return;
    lastSkip = k;
    ehLog("info", "loadorder.watch.skip", { reason, ...data });
  };

  const look = async (): Promise<void> => {
    if (running) {
      // Dropping this would leave the state it was scheduled for unjudged
      // until some later change happened to come along.
      rerun = true;
      return;
    }
    running = true;
    try {
      if (getEHRuntime().getSnapshot().installBusy) {
        // Re-looked when the flag drops — see the runtime subscription.
        dismiss("install-running");
        skip("install-running", {});
        return;
      }
      const found = await assessActiveOrder(api);
      if (found.kind === "nothing") {
        // Nothing of ours to judge. A notification still up would carry a
        // Re-apply bound to another game's or profile's receipt.
        dismiss(found.reason);
        skip(found.reason, {
          activeGame: found.active.gameId,
          activeProfile: found.active.profileName ?? found.active.profileId,
          ...(found.elsewhere.length > 0 ? { installedIn: found.elsewhere } : {}),
        });
        return;
      }
      lastSkip = "";
      const { active, receipt, status } = found;
      const key = `${active.gameId}|${active.profileId}|${receipt.packageId}`;
      const sig = driftSignature(status);
      if (shown !== undefined && shown.key === key && shown.sig === sig) return;
      const wasShowing = shown !== undefined && shown.sig !== "";
      const where = { gameId: active.gameId, profile: active.profileName ?? active.profileId, package: receiptLabel(receipt) };
      ehLog("info", "loadorder.watch.assessed", {
        ...where,
        status: status.kind,
        ...(status.kind === "drifted" ? { moved: status.drift.misordered.length } : {}),
        ...(status.kind === "plugins-off" ? { off: status.missing.length } : {}),
        ...(found.superseded.length > 0 ? { supersedes: found.superseded } : {}),
      });
      shown = { key, sig };
      if (sig === "") {
        if (wasShowing) {
          api.dismissNotification?.(LOAD_ORDER_NOTIFICATION_ID);
          ehLog("info", "loadorder.watch.restored", { ...where, status: status.kind });
        }
        return;
      }
      const said = describeLoadOrder(status);
      ehLog("warn", "loadorder.watch.drifted", { ...where, headline: said.headline });
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
            action: (dismissIt): void => {
              void reapplyCuratorOrder(api, receipt).then(
                (outcome) => {
                  // A refusal leaves the notification up: the drift is still
                  // there, and the reason says when to try again.
                  if (outcome.kind !== "blocked") dismissIt();
                  api.sendNotification?.({
                    type: outcome.kind === "done" ? "success" : "warning",
                    message: outcome.kind === "done" ? outcome.summary : outcome.kind === "blocked" ? outcome.reason : outcome.summary,
                    displayMS: 8000,
                  });
                },
                (err) => {
                  ehLog("error", "loadorder.watch.reapply.fail", { ...where, err });
                  api.sendNotification?.({ type: "error", message: `Could not re-apply the load order: ${err instanceof Error ? err.message : String(err)}` });
                },
              );
            },
          },
          {
            title: "Open Event Horizon",
            action: (dismissIt): void => {
              api.events.emit("show-main-page", "Event Horizon");
              dismissIt();
            },
          },
        ],
      });
    } catch (err) {
      ehLog("warn", "loadorder.watch.fail", { err });
    } finally {
      running = false;
      if (rerun) {
        rerun = false;
        schedule(SETTLE_MS);
      }
    }
  };

  const schedule = (ms: number): void => {
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      void look();
    }, ms);
  };

  let wasBusy = getEHRuntime().getSnapshot().installBusy;
  getEHRuntime().subscribe((snap) => {
    if (snap.installBusy === wasBusy) return;
    wasBusy = snap.installBusy;
    if (snap.installBusy) {
      // Its Re-apply would now write concurrently with the install.
      dismiss("install-started");
    } else {
      // Judge what the run left now — not at whatever order change comes next.
      schedule(SETTLE_MS);
    }
  });

  api.onStateChange?.(["loadOrder"], () => schedule(SETTLE_MS));
  api.onStateChange?.(["settings", "profiles", "activeProfileId"], () => schedule(SETTLE_MS));
  // An install that just wrote a receipt changes what "matches" means.
  api.events.on("did-install-mod", () => schedule(SETTLE_MS));
  schedule(FIRST_LOOK_MS);
  ehLog("info", "loadorder.watch.start");
}
