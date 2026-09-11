/**
 * Nothing here yet — said with a glyph, a title, one sentence, and the
 * action that changes it.
 */

import * as React from "react";

export interface EmptyStateProps {
  icon?: React.ReactNode;
  title: React.ReactNode;
  children?: React.ReactNode;
  actions?: React.ReactNode;
  className?: string;
}

export function EmptyState(props: EmptyStateProps): JSX.Element {
  return (
    <div className={["eh-empty", props.className].filter(Boolean).join(" ")}>
      {props.icon !== undefined && (
        <div className="eh-empty__icon" aria-hidden="true">
          {props.icon}
        </div>
      )}
      <div className="eh-empty__title">{props.title}</div>
      {props.children !== undefined && <div className="eh-empty__body">{props.children}</div>}
      {props.actions !== undefined && <div className="eh-empty__actions">{props.actions}</div>}
    </div>
  );
}
