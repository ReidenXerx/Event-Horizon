/**
 * Event Horizon card primitive.
 *
 * Two flavors:
 *   - Static card (default): just a styled container.
 *   - Interactive card (`onClick` provided): hoverable with a subtle
 *     gradient border-on-hover and tap feedback. Behaves as a button
 *     for keyboard a11y when interactive.
 *
 * Composition slots:
 *   - `icon`     : an optional ReactNode rendered in the icon block.
 *   - `title`    : card heading.
 *   - `subtitle` : a line or short paragraph under the heading, in the
 *                  secondary tone. Never truncated: pages put safety notes here.
 *   - `actions`  : controls on the heading's right (a button, a pill).
 *   - `children` : card body.
 *   - `footer`   : optional footer strip (small, uppercase by default).
 */

import * as React from "react";

export interface CardProps
  extends Omit<React.HTMLAttributes<HTMLDivElement>, "title"> {
  icon?: React.ReactNode;
  title?: React.ReactNode;
  subtitle?: React.ReactNode;
  actions?: React.ReactNode;
  footer?: React.ReactNode;
  onClick?: () => void;
  /**
   * Disables the interactive treatment even if `onClick` is set.
   * Useful for cards that look identical regardless of hover.
   */
  inert?: boolean;
  /** Tighter padding, for a card inside a card or a dense list. */
  compact?: boolean;
  /** Tint the border with a tone, for a card that IS a warning. */
  tone?: "neutral" | "info" | "success" | "warning" | "danger";
  /**
   * The heading element for `title`. A card that is a ROW under a section
   * heading is one level below it; the default h3 is for a card that is a
   * section of its own.
   */
  headingLevel?: 2 | 3 | 4;
  /** Smaller title, for a card that is one item in a list of many. */
  titleSize?: "md" | "sm";
}

export function Card(props: CardProps): JSX.Element {
  const {
    icon,
    title,
    subtitle,
    actions,
    footer,
    onClick,
    inert,
    compact,
    tone,
    headingLevel = 3,
    titleSize = "md",
    className,
    children,
    ...rest
  } = props;

  const isInteractive = onClick !== undefined && !inert;

  const classes = [
    "eh-card",
    isInteractive ? "eh-card--interactive" : undefined,
    compact ? "eh-card--compact" : undefined,
    tone !== undefined && tone !== "neutral" ? `eh-card--${tone}` : undefined,
    className,
  ]
    .filter(Boolean)
    .join(" ");

  const handleKeyDown = (
    event: React.KeyboardEvent<HTMLDivElement>,
  ): void => {
    if (!isInteractive) return;
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      onClick?.();
    }
  };

  const hasHeading = title !== undefined || actions !== undefined;

  return (
    <div
      className={classes}
      onClick={isInteractive ? onClick : undefined}
      onKeyDown={handleKeyDown}
      role={isInteractive ? "button" : undefined}
      tabIndex={isInteractive ? 0 : undefined}
      {...rest}
    >
      {icon !== undefined && (
        <div className="eh-card__icon" aria-hidden="true">
          {icon}
        </div>
      )}
      {hasHeading && (
        <div className="eh-card__head">
          <div className="eh-card__heading">
            {title !== undefined &&
              React.createElement(
                `h${headingLevel}`,
                {
                  className:
                    titleSize === "sm" ? "eh-card__title eh-card__title--sm" : "eh-card__title",
                },
                title,
              )}
            {subtitle !== undefined && <p className="eh-card__subtitle">{subtitle}</p>}
          </div>
          {actions !== undefined && <div className="eh-card__actions">{actions}</div>}
        </div>
      )}
      {children !== undefined && (
        <div className="eh-card__body">{children}</div>
      )}
      {footer !== undefined && (
        <div className="eh-card__footer">{footer}</div>
      )}
    </div>
  );
}
