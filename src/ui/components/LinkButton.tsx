/**
 * An action that reads as text: "Show details (3)", "Clear filters",
 * "Show all 214". A real `<button>` — keyboard-reachable, focus-ringed —
 * that does not look like one, because a row of six bordered buttons is
 * noise where a row of six links is a list.
 */

import * as React from "react";

export interface LinkButtonProps
  extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, "style"> {
  /** `caps`: uppercase and tracked, for a disclosure under a card body. */
  variant?: "default" | "caps" | "xs";
  tone?: "accent" | "danger" | "muted";
}

export function LinkButton(props: LinkButtonProps): JSX.Element {
  const { variant = "default", tone = "accent", className, type, children, ...rest } = props;
  const classes = [
    "eh-link-button",
    variant !== "default" ? `eh-link-button--${variant}` : undefined,
    tone !== "accent" ? `eh-link-button--${tone}` : undefined,
    className,
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <button type={type ?? "button"} className={classes} {...rest}>
      {children}
    </button>
  );
}
