/**
 * A label over a value — the tile every summary in this UI is made of.
 *
 * Seven components did this before, each with its own padding, its own
 * font size for the value and its own idea of which colour meant what:
 * `Tile` and `SummaryTile` in the install wizard, `Stat` on the build page,
 * `Tile` on the curator page, `StatusTile` on the dashboard, `Stat` on the
 * About page and `DetailTile` in the receipt modal. None was wrong; all were
 * different, and the difference is what "makeshift" looks like.
 *
 * Tone is for something that needs attention. Neutral is plain text: colour
 * on an ordinary fact makes the urgent one indistinguishable.
 */

import * as React from "react";

export type StatTone = "neutral" | "quiet" | "info" | "success" | "warning" | "danger";
export type StatSize = "sm" | "md" | "lg";

export interface StatTileProps {
  label: React.ReactNode;
  value: React.ReactNode;
  /** Small print under the value: an id, a path, a qualifier. */
  sub?: React.ReactNode;
  /** Set when the sub is an identifier rather than prose. */
  subMono?: boolean;
  tone?: StatTone;
  /** Value size: sm (body), md (xl), lg (2xl, for a hero number). */
  size?: StatSize;
  /** No box — for a status bar where the tiles sit inside a card already. */
  bare?: boolean;
  className?: string;
  title?: string;
}

export function StatTile(props: StatTileProps): JSX.Element {
  const { label, value, sub, subMono, tone = "neutral", size = "sm", bare, className, title } = props;
  const classes = [
    "eh-stat",
    tone !== "neutral" ? `eh-stat--${tone}` : undefined,
    size !== "sm" ? `eh-stat--${size}` : undefined,
    bare ? "eh-stat--bare" : undefined,
    className,
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <div className={classes} title={title}>
      <span className="eh-stat__label">{label}</span>
      <span className="eh-stat__value">{value}</span>
      {sub !== undefined && (
        <span className={subMono ? "eh-stat__sub eh-stat__sub--mono" : "eh-stat__sub"}>
          {sub}
        </span>
      )}
    </div>
  );
}

/** A row of tiles that fills its width; `min` is the narrowest a tile gets. */
export function StatGrid(props: {
  children: React.ReactNode;
  min?: number;
  className?: string;
}): JSX.Element {
  return (
    <div
      className={["eh-stat-grid", props.className].filter(Boolean).join(" ")}
      style={
        props.min !== undefined
          ? ({ ["--eh-grid-min" as string]: `${props.min}px` } as React.CSSProperties)
          : undefined
      }
    >
      {props.children}
    </div>
  );
}
