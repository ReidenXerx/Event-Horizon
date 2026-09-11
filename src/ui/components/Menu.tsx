/**
 * An overflow menu: one button, a list of actions that are rarely wanted.
 *
 * Built on <details>/<summary> so it opens and closes without JavaScript
 * and the summary is a real button for the keyboard; a click outside or
 * Escape closes it, and choosing an item closes it. Nothing in it is ever
 * the primary action of a page — that is the point of putting it here.
 */

import * as React from "react";

export interface MenuItem {
  label: React.ReactNode;
  onSelect: () => void;
  disabled?: boolean;
  /** One line under the label, muted. */
  hint?: React.ReactNode;
  tone?: "danger";
}

export interface MenuProps {
  /** The summary button's text. */
  label: React.ReactNode;
  items: readonly MenuItem[];
  /** Right-align the popover under the button (the usual, at a row's end). */
  align?: "start" | "end";
  className?: string;
}

export function Menu(props: MenuProps): JSX.Element {
  const ref = React.useRef<HTMLDetailsElement>(null);

  React.useEffect(() => {
    const el = ref.current;
    if (el === null) return;
    const onDoc = (e: MouseEvent): void => {
      if (el.open && !el.contains(e.target as Node)) el.open = false;
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape" && el.open) el.open = false;
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, []);

  return (
    <details
      ref={ref}
      className={["eh-menu", props.align === "start" ? "eh-menu--start" : undefined, props.className]
        .filter(Boolean)
        .join(" ")}
    >
      <summary className="eh-button eh-button--ghost eh-menu__summary">{props.label}</summary>
      <div className="eh-menu__list" role="menu">
        {props.items.map((item, i) => (
          <button
            key={i}
            type="button"
            role="menuitem"
            className={["eh-menu__item", item.tone === "danger" ? "eh-menu__item--danger" : undefined].filter(Boolean).join(" ")}
            disabled={item.disabled}
            onClick={(): void => {
              if (ref.current !== null) ref.current.open = false;
              item.onSelect();
            }}
          >
            <span>{item.label}</span>
            {item.hint !== undefined && <span className="eh-menu__hint">{item.hint}</span>}
          </button>
        ))}
      </div>
    </details>
  );
}
