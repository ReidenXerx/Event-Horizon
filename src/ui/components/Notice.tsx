/**
 * A labelled finding on a report: a pill naming the kind of thing, a
 * one-sentence summary beside it, and optional detail below.
 *
 * The Done screen lists up to a dozen of these — plugin flags restored,
 * rules replaced, a mod that could not be reproduced. The tone colours the
 * border only; the pill carries the word.
 */

import * as React from "react";

import { Pill, type PillIntent } from "./Pill";

export interface NoticeProps {
  label: string;
  intent: PillIntent;
  summary: React.ReactNode;
  className?: string;
  children?: React.ReactNode;
}

export function Notice(props: NoticeProps): JSX.Element {
  const { label, intent, summary, className, children } = props;
  return (
    <div
      className={["eh-notice", intent !== "neutral" ? `eh-notice--${intent}` : undefined, className]
        .filter(Boolean)
        .join(" ")}
    >
      <div className="eh-notice__head">
        <Pill intent={intent}>{label}</Pill>
        <span className="eh-notice__summary">{summary}</span>
      </div>
      {children}
    </div>
  );
}
