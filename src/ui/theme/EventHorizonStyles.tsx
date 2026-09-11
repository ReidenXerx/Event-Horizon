/**
 * Single source of CSS truth for the Event Horizon UI.
 *
 * All theme files (`tokens`, `keyframes`, `base`, `components`,
 * `logo`) export plain CSS strings. This component concatenates them
 * and renders them in one `<style>` tag at the top of our React tree.
 *
 * Why inline `<style>` instead of importing `.css` files?
 *   The extension is built with plain `tsc` (no bundler / loader).
 *   tsc cannot bundle CSS and Vortex's runtime won't resolve
 *   `import "./foo.css"` magic. Inline strings ship as part of the
 *   compiled JS, no extra build pipeline required.
 *
 * Idempotency: the `<style>` carries a stable `id` so React's render
 * never produces duplicates even if the EventHorizonMainPage is
 * mounted/unmounted multiple times. Vortex tends to keep mainPages
 * mounted but defensive against re-mount churn.
 */

import * as React from "react";

import { TOKENS_CSS } from "./tokens";
import { KEYFRAMES_CSS } from "./keyframes";
import { BASE_CSS } from "./base";
import { COMPONENTS_CSS } from "./components";
import { PRIMITIVES_CSS } from "./primitives";
import { UTILITIES_CSS } from "./utilities";
import { LOGO_CSS } from "./logo";

const STYLE_ID = "eh-styles";

/**
 * Exported so the render harness photographs the SAME stylesheet, in the same
 * order, that the extension ships. Not part of the theme's public API.
 */
export const COMBINED_CSS = [
  TOKENS_CSS,
  KEYFRAMES_CSS,
  BASE_CSS,
  COMPONENTS_CSS,
  PRIMITIVES_CSS,
  // After components: a utility should be able to override a component's
  // default spacing at a call site, which is the whole point of having them.
  UTILITIES_CSS,
  LOGO_CSS,
].join("\n\n");

export function EventHorizonStyles(): JSX.Element {
  return (
    <style
      id={STYLE_ID}
      dangerouslySetInnerHTML={{ __html: COMBINED_CSS }}
    />
  );
}
