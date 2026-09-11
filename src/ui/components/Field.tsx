/**
 * Form controls, drawn once.
 *
 * Every page had its own `<input className="eh-input">` beside a hand-made
 * label, and its checkboxes and radios were the browser's — which on this
 * dark surface render as solid white discs in BOTH states, so "picked" and
 * "not picked" looked the same in the decisions step. These wrap the native
 * elements (so forms, focus and screen readers keep working) and style them
 * through classes in theme/primitives.ts.
 *
 * `Field` owns the label ↔ control association, always by id: the control
 * gets `id`, the label gets `htmlFor`, and the hint/error become the
 * control's `aria-describedby`. A first version wrapped a plain child in the
 * <label> itself, which folded the hint INTO the accessible name — "Name
 * Curator-facing display name. Becomes the package name." — so one
 * mechanism only.
 */

import * as React from "react";

// ── Field: label + control + hint/error ─────────────────────────────────

export interface FieldProps {
  label: React.ReactNode;
  hint?: React.ReactNode;
  error?: React.ReactNode;
  required?: boolean;
  /** Label beside the control instead of above it. */
  inline?: boolean;
  /** The control's id; minted when absent. */
  id?: string;
  className?: string;
  /**
   * The control: a single element (it is given `id` and `aria-describedby`),
   * or a render prop for a control that needs to place them itself.
   */
  children: React.ReactElement | ((id: string, describedBy: string | undefined) => React.ReactNode);
}

export function Field(props: FieldProps): JSX.Element {
  const minted = React.useId();
  const id = props.id ?? minted;
  const classes = [
    "eh-field",
    props.inline ? "eh-field--inline" : undefined,
    props.error !== undefined ? "eh-field--invalid" : undefined,
    props.className,
  ]
    .filter(Boolean)
    .join(" ");
  const showHint = props.hint !== undefined && props.error === undefined;
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const describedBy =
    props.error !== undefined ? errorId : showHint ? hintId : undefined;
  const control =
    typeof props.children === "function"
      ? props.children(id, describedBy)
      : React.cloneElement(props.children, {
          id,
          "aria-describedby": describedBy,
          ...(props.error !== undefined ? { "aria-invalid": true } : {}),
        });
  return (
    <div className={classes}>
      <label className="eh-field__label" htmlFor={id}>
        {props.label}
        {props.required && (
          <span className="eh-field__required" aria-hidden="true">
            *
          </span>
        )}
      </label>
      {control}
      {showHint && (
        <span id={hintId} className="eh-field__hint">
          {props.hint}
        </span>
      )}
      {props.error !== undefined && (
        <span id={errorId} className="eh-field__error" role="alert">
          {props.error}
        </span>
      )}
    </div>
  );
}

// ── Input / Textarea / Select ───────────────────────────────────────────

type Omitted = "style" | "className";

export interface InputProps
  extends Omit<React.InputHTMLAttributes<HTMLInputElement>, Omitted> {
  mono?: boolean;
  small?: boolean;
  className?: string;
}

export const Input = React.forwardRef<HTMLInputElement, InputProps>(function Input(
  props,
  ref,
) {
  const { mono, small, className, ...rest } = props;
  return (
    <input
      ref={ref}
      className={["eh-input", mono ? "eh-input--mono" : undefined, small ? "eh-input--sm" : undefined, className]
        .filter(Boolean)
        .join(" ")}
      {...rest}
    />
  );
});

export interface TextareaProps
  extends Omit<React.TextareaHTMLAttributes<HTMLTextAreaElement>, Omitted> {
  className?: string;
}

export const Textarea = React.forwardRef<HTMLTextAreaElement, TextareaProps>(
  function Textarea(props, ref) {
    const { className, ...rest } = props;
    return (
      <textarea
        ref={ref}
        className={["eh-input", "eh-input--textarea", className].filter(Boolean).join(" ")}
        {...rest}
      />
    );
  },
);

export interface SelectProps
  extends Omit<React.SelectHTMLAttributes<HTMLSelectElement>, Omitted> {
  small?: boolean;
  /** Shrink to content instead of filling the row. */
  auto?: boolean;
  className?: string;
}

export const Select = React.forwardRef<HTMLSelectElement, SelectProps>(function Select(
  props,
  ref,
) {
  const { small, auto, className, children, ...rest } = props;
  return (
    <select
      ref={ref}
      className={["eh-select", small ? "eh-select--sm" : undefined, auto ? "eh-select--auto" : undefined, className]
        .filter(Boolean)
        .join(" ")}
      {...rest}
    >
      {children}
    </select>
  );
});

// ── Checkbox / Radio ────────────────────────────────────────────────────

export interface ChoiceProps
  extends Omit<React.InputHTMLAttributes<HTMLInputElement>, Omitted | "type"> {
  /** Text beside the box. Omit for a bare control (a table's tick column). */
  label?: React.ReactNode;
  description?: React.ReactNode;
  /** Tri-state for a "select all" over a partial selection. */
  indeterminate?: boolean;
  className?: string;
}

function useIndeterminate(
  ref: React.RefObject<HTMLInputElement>,
  indeterminate: boolean | undefined,
): void {
  React.useEffect(() => {
    if (ref.current !== null) ref.current.indeterminate = indeterminate === true;
  }, [ref, indeterminate]);
}

function ChoiceControl(props: {
  kind: "checkbox" | "radio";
  choice: ChoiceProps;
  forwarded: React.ForwardedRef<HTMLInputElement>;
}): JSX.Element {
  const { label, description, indeterminate, className, disabled, ...rest } = props.choice;
  const inner = React.useRef<HTMLInputElement>(null);
  React.useImperativeHandle(props.forwarded, () => inner.current as HTMLInputElement);
  useIndeterminate(inner, indeterminate);

  const control = (
    <input
      ref={inner}
      type={props.kind}
      className={props.kind === "radio" ? "eh-check eh-check--radio" : "eh-check"}
      disabled={disabled}
      {...rest}
    />
  );
  if (label === undefined) {
    return className === undefined ? control : <span className={className}>{control}</span>;
  }
  return (
    <label
      className={["eh-choice", disabled ? "eh-choice--disabled" : undefined, className]
        .filter(Boolean)
        .join(" ")}
    >
      {control}
      <span className="eh-choice__text">
        <span>{label}</span>
        {description !== undefined && <span className="eh-choice__desc">{description}</span>}
      </span>
    </label>
  );
}

export const Checkbox = React.forwardRef<HTMLInputElement, ChoiceProps>(function Checkbox(
  props,
  ref,
) {
  return <ChoiceControl kind="checkbox" choice={props} forwarded={ref} />;
});

export const Radio = React.forwardRef<HTMLInputElement, ChoiceProps>(function Radio(
  props,
  ref,
) {
  return <ChoiceControl kind="radio" choice={props} forwarded={ref} />;
});

// ── ChoiceCard: a whole card that is one option ─────────────────────────

export interface ChoiceCardProps {
  kind?: "radio" | "checkbox";
  checked: boolean;
  onChange: () => void;
  label: React.ReactNode;
  sub?: React.ReactNode;
  disabled?: boolean;
  name?: string;
  className?: string;
  /** Content below the label that is part of the option (a file picker). */
  children?: React.ReactNode;
}

export function ChoiceCard(props: ChoiceCardProps): JSX.Element {
  const { kind = "radio", checked, onChange, label, sub, disabled, name, className, children } = props;
  const classes = [
    "eh-choice-card",
    checked ? "eh-choice-card--checked" : undefined,
    disabled ? "eh-choice-card--disabled" : undefined,
    className,
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <label className={classes}>
      <input
        type={kind}
        className={kind === "radio" ? "eh-check eh-check--radio" : "eh-check"}
        checked={checked}
        onChange={onChange}
        disabled={disabled}
        name={name}
      />
      <span className="eh-fill">
        <span className="eh-choice-card__label">{label}</span>
        {sub !== undefined && <span className="eh-choice-card__sub">{sub}</span>}
        {children}
      </span>
    </label>
  );
}

// ── Chip: a toggling filter pill ────────────────────────────────────────

export function Chip(props: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
  className?: string;
  title?: string;
}): JSX.Element {
  return (
    <button
      type="button"
      className={["eh-chip", props.active ? "eh-chip--active" : undefined, props.className]
        .filter(Boolean)
        .join(" ")}
      aria-pressed={props.active}
      onClick={props.onClick}
      title={props.title}
    >
      {props.children}
    </button>
  );
}
