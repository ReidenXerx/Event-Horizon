/**
 * Common page wrapper used by every Event Horizon page and wizard step.
 *
 * Responsibilities:
 *   - Apply the entrance animation (fade-up via CSS class).
 *   - Render an optional header: an eyebrow row (step dots, a status pill),
 *     the title, a subtitle, and actions on the right.
 *   - Render the page body in a max-content-width column.
 *
 * Pages compose `Page` so they all feel consistent (consistent padding,
 * consistent entrance, consistent header layout) without any page having to
 * remember the exact spacing tokens. The install and build wizards used to
 * carry their own header markup with slightly different sizes; they use this
 * one now, with the step indicator in `eyebrow`.
 */

import * as React from "react";

export interface PageProps {
  title?: React.ReactNode;
  subtitle?: React.ReactNode;
  /** A row above the title: step dots, a breadcrumb, a status pill. */
  eyebrow?: React.ReactNode;
  /** Optional right-side content for the header (typically buttons). */
  actions?: React.ReactNode;
  className?: string;
  children?: React.ReactNode;
}

export function Page(props: PageProps): JSX.Element {
  const { title, subtitle, eyebrow, actions, className, children } = props;

  const classes = ["eh-page", className].filter(Boolean).join(" ");

  const hasHeader =
    title !== undefined || subtitle !== undefined || actions !== undefined;

  return (
    <div className={classes}>
      {eyebrow !== undefined && <div className="eh-page__eyebrow">{eyebrow}</div>}
      {hasHeader && (
        <header className="eh-page__header">
          <div className="eh-page__heading">
            {title !== undefined && <h1 className="eh-page__title">{title}</h1>}
            {subtitle !== undefined && <p className="eh-page__subtitle">{subtitle}</p>}
          </div>
          {actions !== undefined && <div className="eh-page__actions">{actions}</div>}
        </header>
      )}
      {children}
    </div>
  );
}
