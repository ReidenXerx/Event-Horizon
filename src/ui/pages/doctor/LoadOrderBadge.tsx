/**
 * One line of load-order state for a receipt row on the Home page: matches,
 * or how far off, with the fix beside it. Reads Vortex's plugin state, so it
 * is right the moment a sort changes it.
 */

import * as React from "react";

import { assessLoadOrder, currentOrderFromState, nativeNamesFromState, type LoadOrderStatus } from "../../../core/doctor/loadOrderStatus";
import { baselineOf, reapplyCuratorOrder } from "../../../core/doctor/loadOrderWatcher";
import type { InstallReceipt } from "../../../types/installLedger";
import { Button, Pill } from "../../components";
import { useToast } from "../../components/Toast";
import { useApi } from "../../state";

export function LoadOrderBadge(props: { receipt: InstallReceipt }): JSX.Element | null {
  const api = useApi();
  const toast = useToast();
  const [busy, setBusy] = React.useState(false);
  const [tick, setTick] = React.useState(0);
  const status = React.useMemo<LoadOrderStatus>(() => {
    const state = api.getState();
    return assessLoadOrder({
      baseline: baselineOf(props.receipt),
      current: currentOrderFromState(state),
      natives: nativeNamesFromState(state),
    });
    // `tick` re-reads after a re-apply.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, props.receipt, tick]);

  if (status.kind === "no-baseline" || status.kind === "not-applicable") return null;
  const drifted = status.kind === "drifted";
  const moved = drifted ? status.drift.misordered.length : 0;
  const missing = drifted ? status.drift.missing.length : 0;

  return (
    <span
      className="eh-row eh-row--sm eh-row--nowrap"
      onClick={(e): void => e.stopPropagation()}
      title={drifted ? "Vortex's sort replaced the curator's order for these plugins" : "The collection's plugins load in the curator's order"}
    >
      <Pill intent={drifted ? "danger" : "success"} plain>
        {drifted ? `load order: ${moved > 0 ? `${moved.toLocaleString()} moved` : `${missing.toLocaleString()} missing`}` : "load order ok"}
      </Pill>
      {drifted && (
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
