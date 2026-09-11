/**
 * Base styles for the Event Horizon UI shell.
 *
 * Scoped to `.eh-app` and descendants so we don't leak into Vortex's
 * own UI. Vortex's main app uses Bootstrap 3-era styling and a dense
 * dark theme; we deliberately diverge inside our own page chrome but
 * never restyle anything outside `.eh-app`.
 */

export const BASE_CSS = `
.eh-app {
  font-family: var(--eh-font-sans);
  font-size: var(--eh-text-md);
  line-height: var(--eh-leading-normal);
  color: var(--eh-text-primary);
  background: var(--eh-gradient-page);
  /* Vortex's MainPage container varies between block, flex column,
     and absolutely-positioned panes depending on the layout mode the
     user picked (Classic vs Modern). The only thing it consistently
     does is render us inside a positioned ancestor that fills the
     content region. So instead of betting on flex inheritance or
     height:100% (which silently collapses when the parent isn't
     a flex container), we pin every edge with inset:0 — this gives
     us a guaranteed definite height that our inner flex column can
     subdivide, which is what makes the main scroll region actually
     scrollable. */
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  width: 100%;
  height: 100%;
  overflow: hidden;
  isolation: isolate;
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
}

.eh-app *,
.eh-app *::before,
.eh-app *::after {
  box-sizing: border-box;
}

/* Element defaults are wrapped in :where() so they carry NO specificity: a
   component class must be able to override them. Without this ".eh-app h3"
   (0,1,1) beat ".eh-section__title" (0,1,0), and ".eh-app p" beat
   ".eh-note" - every section heading in a card came out at 22px and every
   note paragraph in the secondary colour instead of muted.
   (No backticks in here: this file IS a template literal.) */
:where(.eh-app) h1, :where(.eh-app) h2, :where(.eh-app) h3, :where(.eh-app) h4 {
  margin: 0;
  font-weight: 600;
  letter-spacing: var(--eh-tracking-tight);
  line-height: var(--eh-leading-tight);
  color: var(--eh-text-primary);
}

:where(.eh-app) h1 { font-size: var(--eh-text-3xl); }
:where(.eh-app) h2 { font-size: var(--eh-text-2xl); }
:where(.eh-app) h3 { font-size: var(--eh-text-xl); }
:where(.eh-app) h4 { font-size: var(--eh-text-lg); }

:where(.eh-app) p {
  margin: 0;
  color: var(--eh-text-secondary);
}

:where(.eh-app) a {
  color: var(--eh-cyan);
  text-decoration: none;
  transition: color var(--eh-dur-fast) var(--eh-easing);
}

:where(.eh-app) a:hover {
  color: var(--eh-cyan-bright);
  text-shadow: var(--eh-glow-cyan);
}

:where(.eh-app) code, :where(.eh-app) pre {
  font-family: var(--eh-font-mono);
  font-size: var(--eh-text-sm);
}

:where(.eh-app) code {
  padding: 1px 6px;
  background: var(--eh-bg-raised);
  border: 1px solid var(--eh-border-subtle);
  border-radius: var(--eh-radius-xs);
  color: var(--eh-cyan-bright);
}

/* Decorative starfield: pure-CSS dots via radial-gradient repetition.
   No image asset, no JS; renders crisp at any DPI. */
.eh-app::before {
  content: "";
  position: absolute;
  inset: 0;
  z-index: var(--eh-z-base);
  pointer-events: none;
  background-image:
    radial-gradient(1px 1px at 12% 8%,  rgba(255,255,255,0.65), transparent 50%),
    radial-gradient(1px 1px at 78% 12%, rgba(255,255,255,0.5),  transparent 50%),
    radial-gradient(1px 1px at 22% 38%, rgba(255,255,255,0.35), transparent 50%),
    radial-gradient(1px 1px at 53% 22%, rgba(255,255,255,0.55), transparent 50%),
    radial-gradient(1px 1px at 88% 47%, rgba(255,255,255,0.4),  transparent 50%),
    radial-gradient(1px 1px at 8%  72%, rgba(255,255,255,0.5),  transparent 50%),
    radial-gradient(1px 1px at 41% 81%, rgba(255,255,255,0.6),  transparent 50%),
    radial-gradient(1px 1px at 68% 67%, rgba(255,255,255,0.35), transparent 50%),
    radial-gradient(1.4px 1.4px at 92% 88%, rgba(255,255,255,0.6), transparent 50%),
    radial-gradient(1.4px 1.4px at 4% 52%,  rgba(255,255,255,0.5), transparent 50%);
  animation: eh-twinkle var(--eh-dur-warp) ease-in-out infinite;
  opacity: 0.7;
}

/* Faint nebular wash bottom-left for depth. Not animated. */
.eh-app::after {
  content: "";
  position: absolute;
  inset: 0;
  z-index: var(--eh-z-base);
  pointer-events: none;
  background:
    radial-gradient(
      circle at 15% 90%,
      rgba(95, 44, 165, 0.15) 0%,
      transparent 35%
    ),
    radial-gradient(
      circle at 90% 10%,
      rgba(76, 201, 240, 0.08) 0%,
      transparent 40%
    );
}

.eh-app__inner {
  position: relative;
  z-index: var(--eh-z-raised);
  display: flex;
  flex-direction: column;
  flex: 1 1 auto;
  /* min-height: 0 lets the flex child shrink below its intrinsic
     content size, which is what enables the inner main element to
     actually overflow + scroll. Without this Firefox happily grows
     the inner column past the parent's bounds. */
  min-height: 0;
  width: 100%;
  height: 100%;
}

.eh-app__main {
  flex: 1 1 auto;
  /* min-height: 0 here is the same dance: makes overflow-y:auto
     respect the parent's height instead of expanding to fit content. */
  min-height: 0;
  overflow-y: auto;
  overflow-x: hidden;
  scrollbar-gutter: stable;
}

.eh-app__main::-webkit-scrollbar {
  width: 10px;
  height: 10px;
}

.eh-app__main::-webkit-scrollbar-track {
  background: transparent;
}

.eh-app__main::-webkit-scrollbar-thumb {
  background: var(--eh-border-default);
  border-radius: var(--eh-radius-pill);
  border: 2px solid transparent;
  background-clip: padding-box;
}

.eh-app__main::-webkit-scrollbar-thumb:hover {
  background: var(--eh-border-strong);
  background-clip: padding-box;
}

/* Visible focus ring — required for keyboard a11y. We use a double
   ring (cyan glow + dark border) so it's visible on every surface. */
.eh-app *:focus-visible {
  outline: none;
  box-shadow:
    0 0 0 2px var(--eh-bg-base),
    0 0 0 4px var(--eh-cyan),
    var(--eh-glow-cyan);
  /* No border-radius here: the ring follows the element's own shape. Setting
     one turned a tabbed-to 16px checkbox into a circle (a radio, visually)
     and squared the modal's corners the moment it took focus. */
}

/* Remove the default outline on mouse-only interactions. */
.eh-app *:focus:not(:focus-visible) {
  outline: none;
}

/* Utility: gradient text fill (used for the brand wordmark). */
.eh-text-gradient {
  background: var(--eh-gradient-disk);
  -webkit-background-clip: text;
  background-clip: text;
  -webkit-text-fill-color: transparent;
  color: transparent;
}
`;
