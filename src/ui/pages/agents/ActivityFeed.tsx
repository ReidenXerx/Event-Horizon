/**
 * The live feed of what agents do through the control channel: every command
 * as it is queued, runs and lands, in words, with what Event Horizon checked
 * and what it answered on the user's behalf.
 *
 * The showcase of the channel (owner, 2026-09-26): the user watches the work
 * happen instead of doing it by hand.
 */

import * as React from "react";

import { Button, Card, StatGrid, StatTile } from "../../components";
import {
  getRecentOps,
  onControlOps,
} from "../../../core/control/controlService";
import type { OpRecord } from "../../../core/control/ops";
import { activityStats, presentOp, type OpView } from "./activity";

export type ActivityFeedProps = {
  /** Render these instead of the live log (the render harness). */
  initialOps?: OpRecord[];
  /** The clock the times are measured against (the render harness pins it). */
  now?: number;
};

export function ActivityFeed(props: ActivityFeedProps): JSX.Element {
  const [ops, setOps] = React.useState<OpRecord[]>(() => props.initialOps ?? getRecentOps(100));
  const [now, setNow] = React.useState<number>(() => props.now ?? Date.now());
  const [showReads, setShowReads] = React.useState(false);

  React.useEffect(() => {
    if (props.initialOps !== undefined) return undefined;
    return onControlOps(() => setOps(getRecentOps(100)));
  }, [props.initialOps]);

  // A running command's timer and every "12s ago" keep moving.
  React.useEffect(() => {
    if (props.now !== undefined) return undefined;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [props.now]);

  const views = ops.map((op) => presentOp(op, now)).filter((v) => showReads || v.mutates);
  const stats = activityStats(ops);
  const running = views.some((v) => v.tone === "running");

  return (
    <Card
      title={
        <span className="eh-row eh-row--sm">
          <span className={`eh-agent-live${running ? " eh-agent-live--on" : ""}`} aria-hidden="true" />
          Live activity
        </span>
      }
      subtitle="Every command an agent sends, as it happens: what it did, what Event Horizon checked, and what it answered for you."
      actions={
        <Button intent="ghost" size="sm" onClick={(): void => setShowReads(!showReads)}>
          {showReads ? "Hide reads" : "Show reads"}
        </Button>
      }
    >
      <div className="eh-stack eh-stack--lg">
        <StatGrid min={150}>
          <StatTile label="Changes made" value={String(stats.changes)} />
          <StatTile label="Verified in Vortex" value={String(stats.verified)} />
          <StatTile label="Refused safely" value={String(stats.refused)} />
          <StatTile label="Dialogs answered for you" value={String(stats.answered)} />
        </StatGrid>
        {views.length === 0 ? (
          <p className="eh-muted eh-agent-empty">
            Nothing yet. When an agent connects, every deploy, install and rule it sets shows up here as it happens.
          </p>
        ) : (
          <ol className="eh-agent-feed">
            {views.map((v) => (
              <OpLine key={v.id} view={v} />
            ))}
          </ol>
        )}
      </div>
    </Card>
  );
}

function OpLine(props: { view: OpView }): JSX.Element {
  const v = props.view;
  return (
    <li className={`eh-agent-op eh-agent-op--${v.tone}`}>
      <span className="eh-agent-op__marker" aria-hidden="true" />
      <div className="eh-agent-op__body">
        <div className="eh-agent-op__head">
          <span className="eh-agent-op__badge">{v.badge}</span>
          <span className="eh-agent-op__title">{v.title}</span>
          <span className="eh-agent-op__time">
            {v.duration !== undefined ? `${v.duration} · ` : ""}
            {v.when}
          </span>
        </div>
        {v.detail !== undefined && <p className="eh-agent-op__detail">{v.detail}</p>}
        {v.steps !== undefined && (
          <div className="eh-agent-steps">
            {v.steps.map((s) => (
              <span key={s.name} className={`eh-agent-step eh-agent-step--${s.state}`}>
                {s.name}
              </span>
            ))}
          </div>
        )}
        {v.chips.length > 0 && (
          <div className="eh-agent-chips">
            {v.chips.map((c, i) => (
              <span key={`${c.text}-${i}`} className={`eh-agent-chip eh-agent-chip--${c.tone}`}>
                {c.text}
              </span>
            ))}
          </div>
        )}
      </div>
    </li>
  );
}
