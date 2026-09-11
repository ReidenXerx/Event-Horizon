/**
 * Toast notification primitives. The host renders a stack of toasts
 * in the bottom-right corner of `.eh-app`; the context provider
 * exposes `useToast()` which returns `showToast({...})`.
 *
 * Toasts are non-blocking. They're ideal for:
 *   - "Receipt saved"
 *   - "Hashing 12 archives..."
 *   - "Profile switched to <name>"
 *
 * For anything that requires acknowledgement, use the ErrorReportModal
 * or a confirmation Modal instead.
 *
 * Two behaviours a user notices when they are missing:
 *   - The timer PAUSES while the pointer is over a toast, or keyboard focus
 *     is inside it. A 4-second toast with a path in it cannot be read in 4
 *     seconds; moving the mouse to it is the universal "wait, let me read
 *     that", and it used to vanish under the cursor. It resumes when both
 *     have left — see toastModel.ts for the clock, and for the version that
 *     never resumed at all.
 *   - A `danger` toast announces assertively (`role="alert"`); the rest are
 *     polite. Screen readers otherwise read "Receipt saved" and "Install
 *     failed" in the same voice.
 */

import * as React from "react";

import {
  createToastTimers,
  findDuplicateToast,
  toastDedupKey,
  type ToastHold,
  type ToastTimers,
} from "./toastModel";

export type ToastIntent = "success" | "info" | "warning" | "danger";

export interface ToastInput {
  intent?: ToastIntent;
  title?: React.ReactNode;
  message: React.ReactNode;
  /**
   * Auto-dismiss delay in ms. `0` means sticky (manual dismiss only).
   * Default: 4000ms; `danger` defaults to sticky, because an error that
   * disappears before it is read is an error nobody can act on.
   */
  ttl?: number;
  /** Optional action button (single). Clicking it dismisses the toast. */
  action?: { label: string; onClick: () => void };
}

interface ToastInstance extends ToastInput {
  id: number;
  /** Identical text toasts share it; `undefined` is never a duplicate. */
  key: string | undefined;
  ttl: number;
}

/** Max simultaneous toasts shown in the stack. Beyond this we drop the
 * oldest. We don't want a buggy loop covering the whole UI. */
const MAX_STACK = 5;

const DEFAULT_TTL = 4000;

interface ToastContextValue {
  show: (input: ToastInput) => number;
  dismiss: (id: number) => void;
}

const ToastContext = React.createContext<ToastContextValue | null>(null);

export function useToast(): (input: ToastInput) => number {
  const ctx = React.useContext(ToastContext);
  if (ctx === null) {
    return (): number => {
      // eslint-disable-next-line no-console
      console.warn("[Event Horizon] useToast() called outside ToastProvider");
      return -1;
    };
  }
  return ctx.show;
}

export function useToastDismiss(): (id: number) => void {
  const ctx = React.useContext(ToastContext);
  if (ctx === null) {
    return (): void => undefined;
  }
  return ctx.dismiss;
}

export interface ToastProviderProps {
  children: React.ReactNode;
}

export function ToastProvider(props: ToastProviderProps): JSX.Element {
  const [toasts, setToasts] = React.useState<ToastInstance[]>([]);
  /**
   * The list, readable synchronously.
   *
   * `show()` used to assign the new id INSIDE the setState updater and arm
   * the timer after it, assuming the updater had already run. It has not,
   * whenever the call is made inside a React batch — a click handler, or
   * anything on a concurrent root after the first toast — so `show()`
   * returned -1 and the four-second toast became sticky. Measured on both
   * root kinds. The ref is the source of truth; state mirrors it for render.
   */
  const toastsRef = React.useRef<ToastInstance[]>([]);
  const counterRef = React.useRef(0);

  const commit = React.useCallback((next: ToastInstance[]): void => {
    toastsRef.current = next;
    setToasts(next);
  }, []);

  /** Read through a ref so the timers can be created once, before `dismiss` exists. */
  const expireRef = React.useRef<(id: number) => void>(() => undefined);
  const timersRef = React.useRef<ToastTimers | null>(null);
  if (timersRef.current === null) {
    timersRef.current = createToastTimers((id) => expireRef.current(id));
  }
  const timers = timersRef.current;

  const dismiss = React.useCallback(
    (id: number): void => {
      commit(toastsRef.current.filter((t) => t.id !== id));
      timers.forget(id);
    },
    [commit, timers],
  );
  expireRef.current = dismiss;

  const hold = React.useCallback(
    (id: number, why: ToastHold): void => timers.hold(id, why),
    [timers],
  );
  const release = React.useCallback(
    (id: number, why: ToastHold): void => timers.release(id, why),
    [timers],
  );

  const show = React.useCallback(
    (input: ToastInput): number => {
      const ttl = input.ttl ?? (input.intent === "danger" ? 0 : DEFAULT_TTL);
      const key = toastDedupKey(input);

      // Dedupe: an identical toast already on screen is kept and re-armed.
      const existing = findDuplicateToast(toastsRef.current, key);
      if (existing !== undefined) {
        timers.arm(existing.id, ttl);
        return existing.id;
      }

      counterRef.current += 1;
      const id = counterRef.current;
      let next = [...toastsRef.current, { ...input, id, key, ttl }];

      // Cap the stack: the oldest excess toasts (even sticky ones) go. An
      // error that matters belongs in the ErrorReportModal, not here.
      if (next.length > MAX_STACK) {
        const overflow = next.length - MAX_STACK;
        for (let i = 0; i < overflow; i++) timers.forget(next[i]!.id);
        next = next.slice(overflow);
      }
      commit(next);
      timers.arm(id, ttl);
      return id;
    },
    [commit, timers],
  );

  React.useEffect(() => (): void => timers.dispose(), [timers]);

  const value = React.useMemo<ToastContextValue>(
    () => ({ show, dismiss }),
    [show, dismiss],
  );

  return (
    <ToastContext.Provider value={value}>
      {props.children}
      <ToastHost toasts={toasts} onDismiss={dismiss} onHold={hold} onRelease={release} />
    </ToastContext.Provider>
  );
}

// ===========================================================================
// Host
// ===========================================================================

function ToastHost(props: {
  toasts: ToastInstance[];
  onDismiss: (id: number) => void;
  onHold: (id: number, why: ToastHold) => void;
  onRelease: (id: number, why: ToastHold) => void;
}): JSX.Element {
  return (
    <div className="eh-toast-host" aria-live="polite" role="region" aria-label="Notifications">
      {props.toasts.map((toast) => (
        <ToastCard
          key={toast.id}
          toast={toast}
          onDismiss={(): void => props.onDismiss(toast.id)}
          onHold={(why): void => props.onHold(toast.id, why)}
          onRelease={(why): void => props.onRelease(toast.id, why)}
        />
      ))}
    </div>
  );
}

function ToastCard(props: {
  toast: ToastInstance;
  onDismiss: () => void;
  onHold: (why: ToastHold) => void;
  onRelease: (why: ToastHold) => void;
}): JSX.Element {
  const { toast, onDismiss, onHold, onRelease } = props;
  const intent = toast.intent ?? "info";

  return (
    <div
      className={`eh-toast eh-toast--${intent}`}
      role={intent === "danger" ? "alert" : "status"}
      onMouseEnter={(): void => onHold("hover")}
      onMouseLeave={(): void => onRelease("hover")}
      onFocus={(): void => onHold("focus")}
      onBlur={(e): void => {
        // Focus moving from the action button to the close button is still
        // inside the toast; only focus leaving it releases the hold.
        const to = e.relatedTarget as Node | null;
        if (to !== null && e.currentTarget.contains(to)) return;
        onRelease("focus");
      }}
    >
      <div className="eh-fill">
        {toast.title !== undefined && <div className="eh-toast__title">{toast.title}</div>}
        <div className="eh-toast__message">{toast.message}</div>
        {toast.action !== undefined && (
          <button
            type="button"
            className="eh-button eh-button--ghost eh-button--sm eh-toast__action"
            onClick={(): void => {
              toast.action?.onClick();
              onDismiss();
            }}
          >
            {toast.action.label}
          </button>
        )}
      </div>
      <button
        type="button"
        className="eh-toast__close"
        aria-label="Dismiss notification"
        onClick={onDismiss}
      >
        ×
      </button>
    </div>
  );
}
