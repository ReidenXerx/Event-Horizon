/**
 * A titled region inside a page: heading, optional count, optional one-line
 * description, optional actions on the right, then the content.
 *
 * The preview step had two of its three headings as 22px h2s and the third
 * as an 11px uppercase label, because each was written by hand. A section is
 * one level of hierarchy, and every section on a page is the same level.
 */

import * as React from "react";

import { Pill, type PillIntent } from "./Pill";

export interface SectionProps {
  title: React.ReactNode;
  /** A count beside the title, as a pill. */
  count?: number;
  countIntent?: PillIntent;
  description?: React.ReactNode;
  actions?: React.ReactNode;
  /** Smaller title, for a section nested inside a card. */
  size?: "md" | "sm";
  /** Colour the heading with a verdict: the "What to try" of an error. */
  tone?: "success" | "warning" | "danger";
  className?: string;
  /** Accessible landmark name; defaults to the title when it is a string. */
  ariaLabel?: string;
  children?: React.ReactNode;
}

export function Section(props: SectionProps): JSX.Element {
  const { title, count, countIntent, description, actions, size = "md", tone, className, children } = props;
  const titleId = React.useId();
  return (
    <section
      className={["eh-section", tone !== undefined ? `eh-section--${tone}` : undefined, className]
        .filter(Boolean)
        .join(" ")}
      // A landmark per top-level section; a small one nested in a card is
      // not a region of the page, and six of them made a landmark list
      // nobody could navigate.
      aria-labelledby={size === "md" && props.ariaLabel === undefined ? titleId : undefined}
      aria-label={size === "md" ? props.ariaLabel : undefined}
    >
      <header className="eh-section__header">
        <h3
          id={titleId}
          className={size === "sm" ? "eh-section__title eh-section__title--sm" : "eh-section__title"}
        >
          {title}
        </h3>
        {count !== undefined && (
          <Pill intent={countIntent ?? (count > 0 ? "info" : "neutral")}>
            {count.toLocaleString()}
          </Pill>
        )}
        {description !== undefined && <p className="eh-section__desc">{description}</p>}
        {actions !== undefined && <div className="eh-section__actions">{actions}</div>}
      </header>
      {children}
    </section>
  );
}
