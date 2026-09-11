/**
 * Modal primitive for Event Horizon.
 *
 * Behaviour:
 *   - Renders an absolutely-positioned backdrop + a centered card, INSIDE
 *     `.eh-app` (no portal), so Vortex's chrome stays visible — a modal here
 *     is a question inside the extension, not a system dialog.
 *   - Esc closes by default; backdrop click closes by default. Both can be
 *     disabled for a question that must be answered in a word (see
 *     FomodModeModal, which does exactly that on purpose).
 *   - Focus is TRAPPED inside the card while it is open (Tab and Shift+Tab
 *     cycle), the first focusable element gets focus on open, and whatever
 *     had focus before is given it back on close. Without the last part a
 *     keyboard user who closed a modal landed at the top of the document.
 *   - When two modals stack — an error report over a confirmation — only the
 *     TOPMOST one handles Esc. Each used to listen on `window` in the capture
 *     phase, so one Esc closed both.
 *   - The scroll region behind the modal is locked while it is open, so the
 *     wheel over a long dialog does not scroll the page underneath.
 *
 * Stacking: the backdrop uses `--eh-z-modal`; toasts sit above at
 * `--eh-z-toast`, so a toast fired from a modal action shows over the
 * dimmed backdrop rather than under it.
 */

import * as React from "react";

export type ModalSize = "sm" | "md" | "lg" | "xl";

export interface ModalProps {
  open: boolean;
  onClose: () => void;
  title?: React.ReactNode;
  /** Optional text rendered under the title, in the secondary tone. */
  subtitle?: React.ReactNode;
  /** Footer (typically buttons). Right-aligned. */
  footer?: React.ReactNode;
  size?: ModalSize;
  closeOnEsc?: boolean;
  closeOnBackdropClick?: boolean;
  /**
   * Hide the close-X. Use for a blocking question whose every answer is a
   * button in the footer — a dismissal there would be an answer nobody gave.
   */
  hideCloseButton?: boolean;
  /** Accessible name when `title` is not plain text. */
  ariaLabel?: string;
  /** Extra class on the card, for a page that needs to size it. */
  className?: string;
  children?: React.ReactNode;
}

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Open modals, bottom to top. Module-level on purpose: two modals rendered by
 * unrelated components still need to agree on which one is on top.
 */
const openStack: symbol[] = [];
/** What `.eh-app__main` had for overflow-y before the first modal locked it. */
let lockedOverflow = "";

export function Modal(props: ModalProps): JSX.Element | null {
  const {
    open,
    onClose,
    title,
    subtitle,
    footer,
    size = "md",
    closeOnEsc = true,
    closeOnBackdropClick = true,
    hideCloseButton,
    ariaLabel,
    className,
    children,
  } = props;

  const cardRef = React.useRef<HTMLDivElement | null>(null);
  const idRef = React.useRef<symbol | null>(null);
  if (idRef.current === null) idRef.current = Symbol("modal");
  const titleId = React.useId();
  const subtitleId = React.useId();

  // Register in the stack for as long as we are open, and lock the scroll
  // region behind the FIRST modal, restoring it after the LAST: two modals
  // closing in one render restored child-first and left the page locked.
  React.useEffect(() => {
    if (!open) return;
    const id = idRef.current!;
    openStack.push(id);
    const main = cardRef.current
      ?.closest(".eh-app")
      ?.querySelector<HTMLElement>(".eh-app__main");
    if (main !== null && main !== undefined && openStack.length === 1) {
      lockedOverflow = main.style.overflowY;
      main.style.overflowY = "hidden";
    }
    return (): void => {
      const at = openStack.lastIndexOf(id);
      if (at !== -1) openStack.splice(at, 1);
      if (main !== null && main !== undefined && openStack.length === 0) {
        main.style.overflowY = lockedOverflow;
      }
    };
  }, [open]);

  // Esc: only the topmost open modal answers.
  React.useEffect(() => {
    if (!open || !closeOnEsc) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      if (openStack[openStack.length - 1] !== idRef.current) return;
      event.stopPropagation();
      onClose();
    };
    window.addEventListener("keydown", onKeyDown, true);
    return (): void => window.removeEventListener("keydown", onKeyDown, true);
  }, [open, closeOnEsc, onClose]);

  // Focus in on open, back out on close; trap Tab in between.
  React.useEffect(() => {
    if (!open) return;
    const card = cardRef.current;
    if (card === null) return;
    const previouslyFocused =
      typeof document !== "undefined" &&
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;

    // Body first, then footer, then the close-X: the first focusable in DOM
    // order was the × in the header, so every modal opened with Enter
    // meaning "dismiss".
    const first =
      card.querySelector<HTMLElement>(`.eh-modal__body ${FOCUSABLE.split(", ").join(", .eh-modal__body ")}`) ??
      card.querySelector<HTMLElement>(`.eh-modal__footer ${FOCUSABLE.split(", ").join(", .eh-modal__footer ")}`) ??
      card.querySelector<HTMLElement>(FOCUSABLE);
    (first ?? card).focus({ preventScroll: true });

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== "Tab") return;
      if (openStack[openStack.length - 1] !== idRef.current) return;
      const focusable = Array.from(
        card.querySelectorAll<HTMLElement>(FOCUSABLE),
      ).filter((el) => el.offsetParent !== null || el === card);
      if (focusable.length === 0) {
        event.preventDefault();
        card.focus();
        return;
      }
      const firstEl = focusable[0]!;
      const lastEl = focusable[focusable.length - 1]!;
      const active = document.activeElement;
      if (event.shiftKey && (active === firstEl || active === card)) {
        event.preventDefault();
        lastEl.focus();
      } else if (!event.shiftKey && active === lastEl) {
        event.preventDefault();
        firstEl.focus();
      }
    };
    card.addEventListener("keydown", onKeyDown);

    return (): void => {
      card.removeEventListener("keydown", onKeyDown);
      // Only hand focus back if it is still somewhere inside the modal (or
      // nowhere): a caller that moved focus deliberately keeps its choice.
      const active = document.activeElement;
      const stillInside =
        active === null || active === document.body || card.contains(active);
      if (stillInside && previouslyFocused !== null && previouslyFocused.isConnected) {
        previouslyFocused.focus({ preventScroll: true });
      }
    };
  }, [open]);

  if (!open) return null;

  const handleBackdropMouseDown = (event: React.MouseEvent<HTMLDivElement>): void => {
    if (!closeOnBackdropClick) return;
    if (event.target === event.currentTarget) onClose();
  };

  const hasHeader = title !== undefined || !hideCloseButton;
  const labelledBy = title !== undefined ? titleId : undefined;

  return (
    <div className="eh-modal-backdrop" onMouseDown={handleBackdropMouseDown}>
      <div
        ref={cardRef}
        className={["eh-modal", `eh-modal--${size}`, className].filter(Boolean).join(" ")}
        role="dialog"
        aria-modal="true"
        aria-labelledby={ariaLabel === undefined ? labelledBy : undefined}
        aria-label={ariaLabel}
        aria-describedby={subtitle !== undefined ? subtitleId : undefined}
        tabIndex={-1}
      >
        {hasHeader && (
          <header className="eh-modal__header">
            <div className="eh-fill">
              {title !== undefined && (
                <h3 id={titleId} className="eh-modal__title">
                  {title}
                </h3>
              )}
              {subtitle !== undefined && (
                <p id={subtitleId} className="eh-modal__subtitle">
                  {subtitle}
                </p>
              )}
            </div>
            {!hideCloseButton && (
              <button
                type="button"
                className="eh-modal__close"
                aria-label="Close"
                onClick={onClose}
              >
                ×
              </button>
            )}
          </header>
        )}
        <div className="eh-modal__body">{children}</div>
        {footer !== undefined && <footer className="eh-modal__footer">{footer}</footer>}
      </div>
    </div>
  );
}
