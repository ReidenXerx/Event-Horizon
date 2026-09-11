/**
 * One line of load-order state for a receipt row on the Home page: matches,
 * or how far off, with the fix beside it.
 *
 * Home lists every receipt on the machine, and Vortex holds ONE order — the
 * active game's active profile. So the badge first asks whether this
 * receipt's order is the one to judge at all, and says why not when it is
 * not: another game, another profile, or superseded by a newer install into
 * the same profile. Only the order's owner gets a verdict and a Re-apply;
 * the heal writes into whatever order is active.
 *
 * Live: it re-reads when Vortex's plugin order, plugin list or active profile
 * changes, not only when the page happens to re-render.
 */

import * as React from "react";

import { assessReceiptOrder, canReapply, type LoadOrderStatus } from "../../../core/doctor/loadOrderStatus";
import { reapplyCuratorOrder } from "../../../core/doctor/loadOrderWatcher";
import type { InstallReceipt } from "../../../types/installLedger";
import { Button, Pill, type PillIntent } from "../../components";
import { useToast } from "../../components/Toast";
import { useApi } from "../../state";

type StateWatchApi = { onStateChange?: (path: string[], cb: () => void) => void };

const listeners = new Set<() => void>();
let watched = false;

/**
 * `api.onStateChange` has no unsubscribe, so the paths are registered once
 * per process and fanned out to whichever badges are mounted — throttled,
 * because LOOT's sort lands as a burst of loadOrder changes.
 */
export function watchLoadOrderState(api: StateWatchApi, fn: () => void): () => void {
  listeners.add(fn);
  if (!watched && typeof api.onStateChange === "function") {
    watched = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const fire = (): void => {
      if (timer !== undefined) return;
      timer = setTimeout(() => {
        timer = undefined;
        for (const l of listeners) l();
      }, 500);
    };
    api.onStateChange(["loadOrder"], fire);
    api.onStateChange(["session", "plugins", "pluginList"], fire);
    api.onStateChange(["settings", "profiles", "activeProfileId"], fire);
  }
  return (): void => {
    listeners.delete(fn);
  };
}

/** What the pill says, or nothing at all when there is nothing to say. */
export function badgePill(status: LoadOrderStatus): { intent: PillIntent; text: string; title: string } | undefined {
  switch (status.kind) {
    case "no-baseline":
    case "not-applied":
    case "not-applicable":
      return undefined;
    case "not-active-game":
      return { intent: "neutral", text: "not the active game", title: `Installed for ${status.gameId}; switch Vortex to it to check the load order.` };
    case "other-profile":
      return { intent: "neutral", text: `installed in profile ${status.profileName}`, title: "The order you are on belongs to another profile." };
    case "superseded":
      return { intent: "neutral", text: `superseded by ${status.by}`, title: "A newer collection installed into this profile owns its load order." };
    case "matches":
      return { intent: "success", text: "load order ok", title: "The collection's plugins load in the curator's order" };
    case "drifted": {
      const moved = status.drift.misordered.length;
      return {
        intent: "danger",
        text: `load order: ${moved > 0 ? `${moved.toLocaleString()} moved` : `${status.drift.missing.length.toLocaleString()} missing`}`,
        title: "Vortex's sort replaced the curator's order for these plugins",
      };
    }
    default: {
      const exhaustive: never = status;
      void exhaustive;
      return undefined;
    }
  }
}

export function LoadOrderBadge(props: { receipt: InstallReceipt; receipts: readonly InstallReceipt[] }): JSX.Element | null {
  const api = useApi();
  const toast = useToast();
  const [busy, setBusy] = React.useState(false);
  const [tick, setTick] = React.useState(0);
  React.useEffect(() => watchLoadOrderState(api as StateWatchApi, () => setTick((t) => t + 1)), [api]);
  const status = React.useMemo<LoadOrderStatus>(
    () => assessReceiptOrder({ receipt: props.receipt, receipts: props.receipts, state: api.getState() }),
    // `tick` re-reads after a state change or a re-apply.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [api, props.receipt, props.receipts, tick],
  );

  const pill = badgePill(status);
  if (pill === undefined) return null;
  const offerReapply = status.kind === "drifted" && canReapply(status);

  return (
    <span className="eh-row eh-row--sm eh-row--nowrap" onClick={(e): void => e.stopPropagation()} title={pill.title}>
      <Pill intent={pill.intent} plain>
        {pill.text}
      </Pill>
      {offerReapply && (
        <Button
          size="sm"
          intent="primary"
          busy={busy}
          onClick={(): void => {
            setBusy(true);
            void reapplyCuratorOrder(api, props.receipt)
              .then((o) => {
                toast({ intent: o.kind === "done" ? "success" : "warning", message: o.kind === "done" ? o.summary : o.kind === "blocked" ? o.reason : o.summary });
              })
              .catch((err) => toast({ intent: "danger", message: `Could not re-apply: ${err instanceof Error ? err.message : String(err)}` }))
              .finally(() => {
                setBusy(false);
                setTick((t) => t + 1);
              });
          }}
        >
          Re-apply
        </Button>
      )}
    </span>
  );
}
