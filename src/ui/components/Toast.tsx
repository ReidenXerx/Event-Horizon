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
 *   - The timer PAUSES while the pointer is over a toast. A 4-second toast
 *     with a path in it cannot be read in 4 seconds; moving the mouse to it
 *     is the universal "wait, let me read that", and it used to vanish
 *     under the cursor.
 *   - A `danger` toast announces assertively (`role="alert"`); the rest are
 *     polite. Screen readers otherwise read "Receipt saved" and "Install
 *     failed" in the same voice.
 */

import * as React from "react";

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
  /** Stable hash used to dedupe identical toasts back-to-back. */
  key: string;
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

interface Timer {
  handle: number;
  /** When the timer will fire, so a pause can compute what is left. */
  due: number;
  remaining: number;
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
  const timersRef = React.useRef<Map<number, Timer>>(new Map());

  const commit = React.useCallback((next: ToastInstance[]): void => {
    toastsRef.current = next;
    setToasts(next);
  }, []);

  const clearTimer = React.useCallback((id: number): void => {
    const t = timersRef.current.get(id);
    if (t !== undefined) {
      window.clearTimeout(t.handle);
      timersRef.current.delete(id);
    }
  }, []);

  const dismiss = React.useCallback(
    (id: number): void => {
      commit(toastsRef.current.filter((t) => t.id !== id));
      clearTimer(id);
    },
    [clearTimer, commit],
  );

  const arm = React.useCallback(
    (id: number, ms: number): void => {
      const paused = timersRef.current.get(id);
      if (paused !== undefined && paused.handle === -1) {
        // The pointer is over it: extend what resumes, do not restart the
        // clock under the cursor.
        paused.remaining = Math.max(paused.remaining, ms);
        return;
      }
      clearTimer(id);
      if (ms <= 0) return;
      const handle = window.setTimeout(() => dismiss(id), ms);
      timersRef.current.set(id, { handle, due: Date.now() + ms, remaining: ms });
    },
    [clearTimer, dismiss],
  );

  const pause = React.useCallback((id: number): void => {
    const t = timersRef.current.get(id);
    if (t === undefined) return;
    window.clearTimeout(t.handle);
    t.remaining = Math.max(500, t.due - Date.now());
    t.handle = -1;
  }, []);

  const resume = React.useCallback(
    (id: number): void => {
      const t = timersRef.current.get(id);
      if (t === undefined || t.handle !== -1) return;
      arm(id, t.remaining);
    },
    [arm],
  );

  const show = React.useCallback(
    (input: ToastInput): number => {
      const ttl = input.ttl ?? (input.intent === "danger" ? 0 : DEFAULT_TTL);
      const key = toastDedupKey(input);

      // Dedupe: an identical toast already on screen is kept and re-armed.
      const existing = toastsRef.current.find((t) => t.key === key);
      if (existing !== undefined) {
        arm(existing.id, ttl);
        return existing.id;
      }

      counterRef.current += 1;
      const id = counterRef.current;
      let next = [...toastsRef.current, { ...input, id, key, ttl }];

      // Cap the stack: the oldest excess toasts (even sticky ones) go. An
      // error that matters belongs in the ErrorReportModal, not here.
      if (next.length > MAX_STACK) {
        const overflow = next.length - MAX_STACK;
        for (let i = 0; i < overflow; i++) clearTimer(next[i]!.id);
        next = next.slice(overflow);
      }
      commit(next);
      arm(id, ttl);
      return id;
    },
    [arm, clearTimer, commit],
  );

  React.useEffect(() => {
    const timers = timersRef.current;
    return (): void => {
      for (const t of timers.values()) window.clearTimeout(t.handle);
      timers.clear();
    };
  }, []);

  const value = React.useMemo<ToastContextValue>(
    () => ({ show, dismiss }),
    [show, dismiss],
  );

  return (
    <ToastContext.Provider value={value}>
      {props.children}
      <ToastHost toasts={toasts} onDismiss={dismiss} onPause={pause} onResume={resume} />
    </ToastContext.Provider>
  );
}

// ===========================================================================
// Dedup
// ===========================================================================

/** Best-effort hash over the user-visible content of a toast. Two
 * toasts with the same intent + title + message dedupe, regardless of
 * action button. ReactNode -> string is intentionally shallow: we
 * stringify primitives and fall back to `[node]` so distinct elements
 * still hash distinctly via the surrounding intent/title slots. */
function toastDedupKey(input: ToastInput): string {
  return [
    input.intent ?? "info",
    nodeToText(input.title),
    nodeToText(input.message),
  // A separator, so ("a","bc") and ("ab","c") do not collide.
  ].join("\u0001");
}

function nodeToText(node: React.ReactNode): string {
  if (node === undefined || node === null) return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (typeof node === "boolean") return "";
  if (Array.isArray(node)) return node.map(nodeToText).join("");
  return "[node]";
}

// ===========================================================================
// Host
// ===========================================================================

function ToastHost(props: {
  toasts: ToastInstance[];
  onDismiss: (id: number) => void;
  onPause: (id: number) => void;
  onResume: (id: number) => void;
}): JSX.Element {
  return (
    <div className="eh-toast-host" aria-live="polite" role="region" aria-label="Notifications">
      {props.toasts.map((toast) => (
        <ToastCard
          key={toast.id}
          toast={toast}
          onDismiss={(): void => props.onDismiss(toast.id)}
          onPause={(): void => props.onPause(toast.id)}
          onResume={(): void => props.onResume(toast.id)}
        />
      ))}
    </div>
  );
}

function ToastCard(props: {
  toast: ToastInstance;
  onDismiss: () => void;
  onPause: () => void;
  onResume: () => void;
}): JSX.Element {
  const { toast, onDismiss } = props;
  const intent = toast.intent ?? "info";

  return (
    <div
      className={`eh-toast eh-toast--${intent}`}
      role={intent === "danger" ? "alert" : "status"}
      onMouseEnter={props.onPause}
      onMouseLeave={props.onResume}
      onFocus={props.onPause}
      onBlur={props.onResume}
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
