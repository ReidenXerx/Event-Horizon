/**
 * HashingCard — visual liveness for slow per-mod operations.
 *
 * Used by both the Install loading step and the Build loading step
 * during the SHA-256 hashing pass over installed mod archives. The
 * pass can take many minutes for large profiles (hundreds of GB) and
 * each individual mod can take seconds to tens of seconds, so the
 * raw determinate progress alone *looks* frozen.
 *
 * This card combines three signals:
 *   1. A determinate gradient fill bound to `done / total`. Slow but
 *      truthful.
 *   2. A perpetually-running scanner shimmer ON TOP of the fill. The
 *      shimmer is the user's reassurance that the process isn't
 *      hung — it always moves regardless of how slow `done` ticks.
 *   3. The exact `done / total` counter and the name of the mod
 *      currently being hashed. Concrete is calming.
 *
 * Optional Cancel button (rendered when `onCancel` is supplied)
 * aborts the operation. Hashing is read-only so abort is always
 * safe — see `core/archiveHashing.ts`.
 */

import * as React from "react";

import { Button } from "./Button";

export interface HashingCardProps {
  title: string;
  /** Static subtitle shown beside the counter (e.g. step description). */
  subtitle?: React.ReactNode;
  done: number;
  total: number;
  /**
   * Name of the mod currently being processed. Truncated with
   * ellipsis on overflow.
   */
  currentItem?: string;
  /**
   * If provided, renders a Cancel button. Should call into an
   * AbortController.abort() chain.
   */
  onCancel?: () => void;
  /** Override the default "Cancel" button label. */
  cancelLabel?: string;
  /** Disable the Cancel button (e.g. during teardown). */
  cancelDisabled?: boolean;
}

export function HashingCard(props: HashingCardProps): JSX.Element {
  const {
    title,
    subtitle,
    done,
    total,
    currentItem,
    onCancel,
    cancelLabel = "Cancel",
    cancelDisabled,
  } = props;

  const ratio = total > 0 ? Math.min(1, Math.max(0, done / total)) : 0;
  const percent = total > 0 ? Math.round(ratio * 100) : 0;

  return (
    <div
      className="eh-hashing"
      role="status"
      aria-live="polite"
      aria-label={`${title}: ${done} of ${total}`}
    >
      <div>
        <h3 className="eh-hashing__title">{title}</h3>
        {subtitle !== undefined && (
          <p className="eh-hashing__subtitle">{subtitle}</p>
        )}
      </div>

      <div
        className="eh-hashing__scanner"
        style={{ ["--eh-progress" as string]: ratio.toString() }}
        aria-hidden="true"
      />

      <div className="eh-hashing__row">
        <span className="eh-hashing__counter">
          {done} / {total}
          <span className="eh-hashing__percent">({percent}%)</span>
        </span>
        {currentItem !== undefined && currentItem.length > 0 && (
          <span
            className="eh-hashing__current"
            title={currentItem}
          >
            <span className="eh-muted">now: </span>
            {currentItem}
          </span>
        )}
        {onCancel !== undefined && (
          <Button
            intent="ghost"
            size="sm"
            onClick={onCancel}
            disabled={cancelDisabled}
          >
            {cancelLabel}
          </Button>
        )}
      </div>
    </div>
  );
}
