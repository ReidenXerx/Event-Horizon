/**
 * The load order, as its own instrument.
 *
 * It was one health check among seven. It is the thing a collection is FOR
 * — the curator's order is what they tested — and the one thing Vortex
 * undoes on its own, so it gets a card that says the rule in plain words,
 * the state right now, what re-applying would move, and the button.
 */

import * as React from "react";

import { describeLoadOrder, type LoadOrderStatus } from "../../../core/doctor/loadOrderStatus";
import { Button, Callout, Card, LinkButton, Pill, type PillIntent } from "../../components";

const num = (n: number): string => n.toLocaleString();

const TONE_PILL: Record<"success" | "warning" | "danger" | "neutral", PillIntent> = {
  success: "success",
  warning: "warning",
  danger: "danger",
  neutral: "neutral",
};

export function LoadOrderCard(props: {
  packageName: string;
  status: LoadOrderStatus;
  /** What re-applying would move, when it would move anything. */
  preview?: { moves: Array<{ name: string; from: number; to: number }>; total: number };
  /** Vortex's auto-sort setting; undefined when it could not be read. */
  autoSortOn?: boolean;
  busy: boolean;
  /** Absent while an install runs (healing is blocked), with the reason. */
  blocked?: string;
  /** plugins.txt on disk has not caught up with Vortex's state. */
  fileMismatch?: boolean;
  onReapply: () => void;
  onDisableAutoSort?: () => void;
}): JSX.Element {
  const { status, preview } = props;
  const said = describeLoadOrder(status);
  const [showMoves, setShowMoves] = React.useState(false);
  const canAct = status.kind === "matches" || status.kind === "drifted";
  const drifted = status.kind === "drifted";

  return (
    <Card
      title="Load order"
      subtitle={`${props.packageName} — the curator's order, pinned; your own plugins placed by LOOT between them.`}
      actions={
        canAct ? (
          <Button
            intent={drifted ? "primary" : "ghost"}
            disabled={props.blocked !== undefined}
            busy={props.busy}
            title={props.blocked ?? "Refills the collection's slots with the curator's order; every other plugin stays where it is. No sort runs."}
            onClick={props.onReapply}
          >
            {drifted ? "Restore the curator's order" : "Re-apply the curator's order"}
          </Button>
        ) : undefined
      }
    >
      <div className="eh-stack">
        <div className="eh-row eh-row--sm">
          <Pill intent={TONE_PILL[said.tone]}>{status.kind === "matches" ? "matches" : status.kind === "drifted" ? "drifted" : "unknown"}</Pill>
          <span className="eh-strong">{said.headline}</span>
        </div>
        {props.fileMismatch === true && (
          <p className="eh-small eh-tone--warning">
            Read from Vortex&rsquo;s state. plugins.txt on disk does not match it yet — Vortex writes the file a moment
            after a change; if this stays, something edited the file by hand.
          </p>
        )}
        {said.detail.length > 0 && (
          <ul className="eh-list eh-stack eh-stack--xs">
            {said.detail.map((d) => (
              <li key={d} className="eh-small">
                {d}
              </li>
            ))}
          </ul>
        )}

        <p className="eh-note eh-prose">
          How it works: the collection ships the curator&rsquo;s relative order for the plugins it contains. Plugins you
          add yourself are neither appended nor overwritten — LOOT places them, and re-applying keeps every one of those
          places while putting the collection&rsquo;s plugins back in the curator&rsquo;s sequence. Vortex&rsquo;s Sort
          button, and automatic sorting on deploy, replace the pin with LOOT&rsquo;s answer for everything.
        </p>

        {preview !== undefined && preview.moves.length > 0 && (
          <div className="eh-stack eh-stack--xs">
            <span className="eh-small">
              Re-applying would move {num(preview.moves.length)} of {num(preview.total)} plugin(s).{" "}
              <LinkButton variant="xs" onClick={(): void => setShowMoves((v) => !v)}>
                {showMoves ? "hide" : "show which"}
              </LinkButton>
            </span>
            {showMoves && (
              <ul className="eh-list eh-list--plain eh-stack eh-stack--xs eh-mono eh-small">
                {preview.moves.slice(0, 40).map((m) => (
                  <li key={m.name}>
                    {m.name}: {m.from + 1} → {m.to + 1}
                  </li>
                ))}
                {preview.moves.length > 40 && <li className="eh-muted">and {num(preview.moves.length - 40)} more</li>}
              </ul>
            )}
          </div>
        )}

        {props.autoSortOn === true && (
          <Callout
            tone="warning"
            actions={
              props.onDisableAutoSort !== undefined ? (
                <Button size="sm" intent="ghost" onClick={props.onDisableAutoSort}>
                  Turn automatic sorting off
                </Button>
              ) : undefined
            }
          >
            Vortex&rsquo;s automatic plugin sorting is ON. Every deploy and every plugin you enable re-sorts with LOOT and
            undoes the curator&rsquo;s order again. Event Horizon warns you when that happens; turning it off keeps the
            order until you sort by hand.
          </Callout>
        )}
        {props.autoSortOn === false && (
          <p className="eh-small eh-muted">
            Automatic sorting is off. The order changes only when you sort by hand; Event Horizon warns you when it does.
          </p>
        )}
      </div>
    </Card>
  );
}
