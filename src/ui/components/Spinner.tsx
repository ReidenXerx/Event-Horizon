/**
 * A small ring that turns. Sized in `em`, so it matches whatever text it
 * sits beside; coloured with `currentColor`, so it matches too.
 */

import * as React from "react";

export function Spinner(props: { className?: string; label?: string }): JSX.Element {
  return (
    <span
      className={["eh-spinner", props.className].filter(Boolean).join(" ")}
      role={props.label !== undefined ? "status" : undefined}
      aria-label={props.label}
      aria-hidden={props.label === undefined ? true : undefined}
    />
  );
}
