/**
 * Event Horizon button primitive.
 *
 * Three intents:
 *   - "primary"  : solid disk-orange → pink on hover (see theme).
 *   - "ghost"    : transparent w/ border, used for secondary actions.
 *   - "danger"   : red outline, used for destructive confirmations.
 *
 * Three sizes: "sm" / "md" (default) / "lg".
 *
 * `busy` is the state a button is in while the thing it started has not
 * finished: disabled, `aria-busy`, and a spinner in place of the leading
 * icon. Pages used to spell this as `disabled={busy}` plus a label swap,
 * which left the button looking merely unavailable rather than working.
 */

import * as React from "react";

import { Spinner } from "./Spinner";

export type ButtonIntent = "primary" | "ghost" | "danger";
export type ButtonSize = "sm" | "md" | "lg";

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  intent?: ButtonIntent;
  size?: ButtonSize;
  /**
   * Optional leading icon (ReactNode — already-rendered SVG, glyph,
   * or Vortex `<Icon />`).
   */
  leadingIcon?: React.ReactNode;
  trailingIcon?: React.ReactNode;
  fullWidth?: boolean;
  /** Working: disabled, announced as busy, spinner in the icon slot. */
  busy?: boolean;
}

export function Button(props: ButtonProps): JSX.Element {
  const {
    intent = "ghost",
    size = "md",
    leadingIcon,
    trailingIcon,
    fullWidth,
    busy,
    className,
    children,
    type,
    disabled,
    onClick,
    style: _omitInlineStyle,
    ...rest
  } = props;

  const classes = [
    "eh-button",
    `eh-button--${intent}`,
    size !== "md" ? `eh-button--${size}` : undefined,
    fullWidth ? "eh-button--full-width" : undefined,
    busy ? "eh-button--busy" : undefined,
    className,
  ]
    .filter(Boolean)
    .join(" ");

  const lead = busy ? <Spinner /> : leadingIcon;

  // Busy is NOT `disabled`: a focused button that becomes disabled drops
  // focus to the body, and when the work ends a keyboard user is nowhere.
  // The click is swallowed and the state announced instead.
  const handleClick = (event: React.MouseEvent<HTMLButtonElement>): void => {
    if (busy) {
      event.preventDefault();
      return;
    }
    onClick?.(event);
  };

  return (
    <button
      type={type ?? "button"}
      className={classes}
      disabled={disabled}
      aria-disabled={busy === true && !disabled ? true : undefined}
      aria-busy={busy === true ? true : undefined}
      onClick={handleClick}
      {...rest}
    >
      {lead !== undefined && (
        <span className="eh-button__icon" aria-hidden="true">
          {lead}
        </span>
      )}
      <span>{children}</span>
      {trailingIcon !== undefined && (
        <span className="eh-button__icon" aria-hidden="true">
          {trailingIcon}
        </span>
      )}
    </button>
  );
}
