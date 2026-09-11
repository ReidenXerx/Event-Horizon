/**
 * DiffSectionBlock — reusable collapsible section for plugin diff categories.
 *
 * Renders a header with title, a count badge, and a toggle chevron.
 * The body can be shown or hidden by clicking anywhere on the header.
 * When `count` is 0 an "All clear" empty-state message is shown instead
 * of `children`.
 *
 * Future: pass `onPluginClick` down from the page so individual plugin
 * rows can navigate to the Vortex plugins tab when that API surface is
 * available.
 */

import * as React from "react";

import { Pill } from "./Pill";
import type { PillIntent } from "./Pill";

export interface DiffSectionBlockProps {
  title: string;
  count: number;
  /**
   * Pill intent for the count badge — defaults to `"warning"` when
   * count > 0, `"neutral"` when empty.
   */
  intent?: PillIntent;
  /** Start expanded. Defaults to `true`. */
  defaultExpanded?: boolean;
  children: React.ReactNode;
  /** Optional extra class on the outer wrapper. */
  className?: string;
}

export function DiffSectionBlock(props: DiffSectionBlockProps): JSX.Element {
  const {
    title,
    count,
    intent,
    defaultExpanded = true,
    children,
    className,
  } = props;

  const [expanded, setExpanded] = React.useState(defaultExpanded);

  const pillIntent: PillIntent = intent ?? (count > 0 ? "warning" : "neutral");
  const blockClass = [
    "eh-diff-block",
    expanded ? "eh-diff-block--expanded" : undefined,
    className,
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div className={blockClass}>
      <button
        type="button"
        className="eh-diff-block__header"
        aria-expanded={expanded}
        onClick={(): void => setExpanded((v) => !v)}
      >
        <span className="eh-diff-block__chevron" aria-hidden="true">
          {expanded ? "▾" : "▸"}
        </span>
        <span className="eh-diff-block__title">{title}</span>
        <Pill intent={pillIntent} className="eh-diff-block__badge">
          {count}
        </Pill>
      </button>

      {expanded && (
        <div className="eh-diff-block__body" role="region">
          {count === 0 ? (
            <p className="eh-diff-block__empty">No mismatches in this category.</p>
          ) : (
            children
          )}
        </div>
      )}
    </div>
  );
}
