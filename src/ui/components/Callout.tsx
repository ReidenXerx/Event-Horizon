/**
 * A message with a tone: the warning under a form, the notice that another
 * pipeline is running, the error a step could not get past.
 *
 * The ARIA role follows the tone unless the caller says otherwise: `danger`
 * is an alert (announced at once), everything else is a status (announced
 * when convenient). A warning panel that appears mid-flow and says nothing
 * to a screen reader is a warning half the audience never gets.
 */

import * as React from "react";

export type CalloutTone = "neutral" | "info" | "success" | "warning" | "danger";

export interface CalloutProps {
  tone?: CalloutTone;
  title?: React.ReactNode;
  /** Glyph in the leading slot. Defaults per tone; pass `null` for none. */
  icon?: React.ReactNode | null;
  actions?: React.ReactNode;
  /** `silent`: no live region — body prose that must not be announced twice. */
  role?: "alert" | "status" | "silent";
  className?: string;
  children?: React.ReactNode;
}

const DEFAULT_ICON: Record<CalloutTone, string | null> = {
  neutral: null,
  info: "ℹ",
  success: "✓",
  warning: "⚠",
  danger: "⚠",
};

export function Callout(props: CalloutProps): JSX.Element {
  const { tone = "neutral", title, actions, className, children } = props;
  const icon = props.icon === undefined ? DEFAULT_ICON[tone] : props.icon;
  const role =
    props.role === "silent"
      ? undefined
      : (props.role ?? (tone === "danger" ? "alert" : "status"));
  return (
    <div
      className={["eh-callout", tone !== "neutral" ? `eh-callout--${tone}` : undefined, className]
        .filter(Boolean)
        .join(" ")}
      role={role}
    >
      {icon !== null && (
        <span className="eh-callout__icon" aria-hidden="true">
          {icon}
        </span>
      )}
      <div className="eh-callout__body">
        {title !== undefined && <strong className="eh-callout__title">{title}</strong>}
        {children}
        {actions !== undefined && <div className="eh-callout__actions">{actions}</div>}
      </div>
    </div>
  );
}
