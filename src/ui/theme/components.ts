/**
 * Component-scoped CSS for the Event Horizon UI primitives.
 *
 * Naming follows BEM-lite: `.eh-{component}__{element}--{modifier}`.
 * Modifier classes are additive — primary state lives on the base,
 * variants ride on top.
 */

export const COMPONENTS_CSS = `
/* ── Page wrapper ─────────────────────────────────────────────── */
.eh-page {
  width: 100%;
  max-width: var(--eh-max-content);
  margin: 0 auto;
  padding: var(--eh-page-padding);
  /* fill-mode BACKWARDS, not both: "both" keeps transform: translateY(0)
     after the entrance, and a transformed ancestor is the containing block
     for every position:absolute descendant — so a modal opened from inside
     the page sized its backdrop to the page CONTENT (3064px on a long list)
     and centred the card a screen and a half down, behind a scroll the modal
     itself had just locked. The natural state is the end state anyway. */
  animation: eh-fade-up var(--eh-dur-slow) var(--eh-easing) backwards;
}

/* The page header lives in primitives.ts with the rest of the page anatomy. */

/* ── Stagger helpers (parent gives N, children animate w/ delay) ─ */
.eh-stagger > *      { opacity: 0; animation: eh-fade-up var(--eh-dur-base) var(--eh-easing) both; }
.eh-stagger > *:nth-child(1) { animation-delay: 60ms; }
.eh-stagger > *:nth-child(2) { animation-delay: 140ms; }
.eh-stagger > *:nth-child(3) { animation-delay: 220ms; }
.eh-stagger > *:nth-child(4) { animation-delay: 300ms; }
.eh-stagger > *:nth-child(5) { animation-delay: 380ms; }
.eh-stagger > *:nth-child(6) { animation-delay: 460ms; }
.eh-stagger > *:nth-child(7) { animation-delay: 540ms; }
.eh-stagger > *:nth-child(8) { animation-delay: 620ms; }
.eh-stagger > *:nth-child(9) { animation-delay: 700ms; }

/* ── Nav (top bar) ────────────────────────────────────────────── */
.eh-nav {
  height: var(--eh-nav-height);
  display: flex;
  align-items: center;
  gap: var(--eh-sp-3);
  padding: 0 var(--eh-sp-6);
  background: var(--eh-bg-glass);
  backdrop-filter: blur(12px);
  -webkit-backdrop-filter: blur(12px);
  border-bottom: 1px solid var(--eh-border-subtle);
  position: sticky;
  top: 0;
  z-index: var(--eh-z-nav);
  animation: eh-fade-down var(--eh-dur-base) var(--eh-easing) both;
}

.eh-nav__brand {
  /* It is a <button> (it navigates home), so the reset lives here rather
     than inline on the one element that uses it. */
  appearance: none;
  background: transparent;
  border: 0;
  padding: 0;
  cursor: pointer;
  color: inherit;
  font: inherit;
  display: flex;
  align-items: center;
  gap: var(--eh-sp-3);
  margin-right: var(--eh-sp-5);
  user-select: none;
  border-radius: var(--eh-radius-sm);
}

.eh-nav__brand-text {
  font-size: var(--eh-text-md);
  font-weight: 700;
  letter-spacing: var(--eh-tracking-wide);
  text-transform: uppercase;
  white-space: nowrap;
}

.eh-nav__items {
  display: flex;
  align-items: center;
  gap: var(--eh-sp-1);
  flex: 1;
}

.eh-nav__item {
  appearance: none;
  background: transparent;
  border: 0;
  color: var(--eh-text-secondary);
  font-family: inherit;
  font-size: var(--eh-text-sm);
  font-weight: 500;
  padding: var(--eh-sp-2) var(--eh-sp-4);
  border-radius: var(--eh-radius-sm);
  cursor: pointer;
  position: relative;
  transition: color var(--eh-dur-fast) var(--eh-easing),
              background var(--eh-dur-fast) var(--eh-easing);
}

.eh-nav__item:hover {
  color: var(--eh-text-primary);
  background: var(--eh-border-subtle);
}

.eh-nav__item--active {
  color: var(--eh-text-primary);
}

.eh-nav__item--active::after {
  content: "";
  position: absolute;
  left: var(--eh-sp-4);
  right: var(--eh-sp-4);
  bottom: -2px;
  height: 2px;
  background: var(--eh-gradient-disk);
  border-radius: var(--eh-radius-pill);
  box-shadow: var(--eh-glow-disk);
  animation: eh-fade-in var(--eh-dur-base) var(--eh-easing) both;
}

.eh-nav__meta {
  margin-left: auto;
  display: flex;
  align-items: center;
  gap: var(--eh-sp-3);
  color: var(--eh-text-muted);
  font-size: var(--eh-text-xs);
  letter-spacing: var(--eh-tracking-wide);
  text-transform: uppercase;
}

/* ── Button ───────────────────────────────────────────────────── */
.eh-button {
  appearance: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: var(--eh-sp-2);
  padding: var(--eh-sp-3) var(--eh-sp-5);
  border: 1px solid var(--eh-border-default);
  border-radius: var(--eh-radius-sm);
  background: var(--eh-bg-raised);
  color: var(--eh-text-primary);
  font-family: inherit;
  font-size: var(--eh-text-sm);
  font-weight: 600;
  letter-spacing: var(--eh-tracking-wide);
  cursor: pointer;
  position: relative;
  overflow: hidden;
  transition:
    transform var(--eh-dur-fast) var(--eh-easing),
    background var(--eh-dur-fast) var(--eh-easing),
    border-color var(--eh-dur-fast) var(--eh-easing),
    box-shadow var(--eh-dur-fast) var(--eh-easing);
  user-select: none;
  white-space: nowrap;
}

.eh-button:hover:not(:disabled) {
  background: var(--eh-bg-elevated);
  border-color: var(--eh-border-strong);
  transform: translateY(-1px);
}

.eh-button:active:not(:disabled) {
  transform: translateY(0) scale(0.98);
  transition-duration: var(--eh-dur-instant);
}

.eh-button:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

/* Primary: solid disk-orange → disk pink on hover (smooth fill).
   No gradient/shimmer overlay — avoids a bright vertical edge artifact
   on the right. Border removed so a 1px hairline cannot sit on the fill. */
.eh-button--primary {
  background-color: var(--eh-disk-hot);
  background-image: none;
  border-width: 0;
  padding: calc(var(--eh-sp-3) + 1px) calc(var(--eh-sp-5) + 1px);
  color: var(--eh-text-inverse);
  box-shadow: var(--eh-shadow-button), var(--eh-glow-disk);
  transition:
    transform var(--eh-dur-fast) var(--eh-easing),
    background-color var(--eh-dur-base) var(--eh-easing),
    box-shadow var(--eh-dur-base) var(--eh-easing);
}

.eh-button--primary:hover:not(:disabled) {
  background-color: var(--eh-disk-pink);
  box-shadow:
    var(--eh-shadow-button),
    0 0 28px rgba(240, 56, 107, 0.55);
}

.eh-button--primary:active:not(:disabled) {
  transition-duration: var(--eh-dur-instant), var(--eh-dur-instant),
    var(--eh-dur-instant);
}

.eh-button--ghost {
  background: transparent;
  border-color: var(--eh-border-default);
}

.eh-button--ghost:hover:not(:disabled) {
  background: var(--eh-border-subtle);
}

.eh-button--danger {
  background: transparent;
  border-color: var(--eh-danger);
  color: var(--eh-danger);
}

.eh-button--danger:hover:not(:disabled) {
  background: rgba(255, 91, 120, 0.12);
  box-shadow: 0 0 16px var(--eh-danger-glow);
}

.eh-button--lg {
  padding: var(--eh-sp-4) var(--eh-sp-6);
  font-size: var(--eh-text-md);
}

.eh-button--sm {
  padding: var(--eh-sp-2) var(--eh-sp-3);
  font-size: var(--eh-text-xs);
}

/* Primary drops the 1px border — keep tap targets aligned with sm/lg. */
.eh-button--primary.eh-button--lg {
  padding: calc(var(--eh-sp-4) + 1px) calc(var(--eh-sp-6) + 1px);
}

.eh-button--primary.eh-button--sm {
  padding: calc(var(--eh-sp-2) + 1px) calc(var(--eh-sp-3) + 1px);
}

.eh-button--full-width {
  width: 100%;
}

/* The icon slot: was referenced by Button and declared nowhere, so a glyph
   sat on the text baseline instead of centring on the label. */
.eh-button__icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  line-height: 1;
  flex: none;
}

/* ── Card ─────────────────────────────────────────────────────── */
.eh-card {
  background: var(--eh-bg-raised);
  border: 1px solid var(--eh-border-default);
  border-radius: var(--eh-radius-lg);
  padding: var(--eh-sp-5);
  position: relative;
  overflow: hidden;
  transition:
    transform var(--eh-dur-base) var(--eh-easing),
    border-color var(--eh-dur-base) var(--eh-easing),
    box-shadow var(--eh-dur-base) var(--eh-easing);
}

.eh-card--interactive {
  cursor: pointer;
  user-select: none;
}

.eh-card--interactive:hover {
  transform: translateY(-2px);
  border-color: var(--eh-border-strong);
  box-shadow: var(--eh-shadow-card);
}

.eh-card--interactive:active {
  transform: translateY(0);
  transition-duration: var(--eh-dur-instant);
}

.eh-card--interactive::before {
  content: "";
  position: absolute;
  inset: 0;
  border-radius: inherit;
  padding: 1px;
  background: var(--eh-gradient-disk);
  -webkit-mask:
    linear-gradient(#fff 0 0) content-box,
    linear-gradient(#fff 0 0);
  -webkit-mask-composite: xor;
          mask-composite: exclude;
  opacity: 0;
  transition: opacity var(--eh-dur-base) var(--eh-easing);
  pointer-events: none;
}

.eh-card--interactive:hover::before {
  opacity: 0.6;
}

.eh-card__head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--eh-sp-3);
  margin-bottom: var(--eh-sp-3);
}

.eh-card__heading {
  flex: 1 1 auto;
  min-width: 0;
}

.eh-card__title {
  font-size: var(--eh-text-lg);
  font-weight: 600;
  margin: 0;
  letter-spacing: var(--eh-tracking-tight);
}

.eh-card__title--sm {
  font-size: var(--eh-text-md);
}

.eh-card__subtitle {
  margin: var(--eh-sp-1) 0 0 0;
  color: var(--eh-text-secondary);
  font-size: var(--eh-text-sm);
  line-height: var(--eh-leading-normal);
}

.eh-card__actions {
  flex: none;
  display: flex;
  align-items: center;
  gap: var(--eh-sp-2);
}

.eh-card--compact { padding: var(--eh-sp-4); }
/* A card that is the only thing on the page (a crash fallback). */
.eh-card--narrow { width: 100%; max-width: 540px; }

.eh-card--info    { border-color: color-mix(in srgb, var(--eh-info) 45%, transparent); }
.eh-card--success { border-color: color-mix(in srgb, var(--eh-success) 45%, transparent); }
.eh-card--warning { border-color: color-mix(in srgb, var(--eh-warning) 55%, transparent); }
.eh-card--danger  { border-color: color-mix(in srgb, var(--eh-danger) 55%, transparent); }

.eh-card__body {
  color: var(--eh-text-secondary);
  font-size: var(--eh-text-sm);
  line-height: var(--eh-leading-relaxed);
}

.eh-card__icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 44px;
  height: 44px;
  border-radius: var(--eh-radius-md);
  background: var(--eh-bg-elevated);
  color: var(--eh-disk-pink);
  margin-bottom: var(--eh-sp-4);
  font-size: 22px;
  border: 1px solid var(--eh-border-default);
  position: relative;
  overflow: hidden;
}

.eh-card__icon::after {
  content: "";
  position: absolute;
  inset: 0;
  background: var(--eh-gradient-disk);
  opacity: 0.18;
  pointer-events: none;
}

.eh-card__footer {
  margin-top: var(--eh-sp-4);
  padding-top: var(--eh-sp-3);
  border-top: 1px solid var(--eh-border-subtle);
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: var(--eh-text-xs);
  color: var(--eh-text-muted);
  letter-spacing: var(--eh-tracking-wide);
  text-transform: uppercase;
}

/* ── Pill ─────────────────────────────────────────────────────── */
.eh-pill {
  display: inline-flex;
  align-items: center;
  gap: var(--eh-sp-1);
  /* Asymmetric on purpose. The label is uppercase inside a line-height:1 box,
     so the caps occupy only the upper part of the em box and the descender
     space below them is empty. Equal padding therefore LOOKS bottom-heavy:
     measured 18px above the caps against 25px below at 7x zoom. One extra
     pixel on top optically centres the text in the pill. */
  padding: 3px var(--eh-sp-3) 2px;
  border-radius: var(--eh-radius-pill);
  background: var(--eh-bg-elevated);
  border: 1px solid var(--eh-border-default);
  color: var(--eh-text-secondary);
  font-size: var(--eh-text-xs);
  font-weight: 600;
  letter-spacing: var(--eh-tracking-wide);
  text-transform: uppercase;
  line-height: 1;
  white-space: nowrap;
}

.eh-pill__dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: currentColor;
  box-shadow: 0 0 6px currentColor;
  /* Never let the dot deform. It is a 6px flex item, and flex-shrink defaults
     to 1, so a cramped pill squashes the circle into an ellipse. */
  flex: none;
  /* align-items:center centres the dot on the flex line, but the uppercase caps
     beside it have their optical centre ABOVE that line - so a geometrically
     centred dot reads about a pixel low. Lift it onto the caps' centre. */
  transform: translateY(-0.5px);
}

/* A phrase, not a tag: sentence case, and it may wrap. */
.eh-pill--plain {
  text-transform: none;
  letter-spacing: var(--eh-tracking-normal);
  font-weight: 500;
  white-space: normal;
  line-height: var(--eh-leading-snug);
  padding: 2px var(--eh-sp-3);
}

.eh-pill--success { color: var(--eh-success); border-color: var(--eh-success-glow); }
.eh-pill--warning { color: var(--eh-warning); border-color: var(--eh-warning-glow); }
.eh-pill--danger  { color: var(--eh-danger);  border-color: var(--eh-danger-glow); }
.eh-pill--info    { color: var(--eh-cyan);    border-color: var(--eh-info-glow); }

/* ── Progress ring ────────────────────────────────────────────── */
.eh-ring {
  position: relative;
  width: var(--eh-ring-size, 64px);
  height: var(--eh-ring-size, 64px);
  display: inline-flex;
  align-items: center;
  justify-content: center;
}

.eh-ring__svg {
  position: absolute;
  inset: 0;
  transform: rotate(-90deg);
}

.eh-ring__track {
  fill: none;
  stroke: var(--eh-border-default);
  stroke-width: 4;
}

.eh-ring__bar {
  fill: none;
  stroke: url(#eh-ring-gradient);
  stroke-width: 4;
  stroke-linecap: round;
  filter: drop-shadow(0 0 4px var(--eh-disk-pink));
  transition: stroke-dashoffset var(--eh-dur-base) var(--eh-easing);
}

.eh-ring__indeterminate {
  animation: eh-spinner var(--eh-dur-warp) linear infinite;
  transform-origin: center;
}

.eh-ring__label {
  font-size: var(--eh-text-xs);
  font-weight: 700;
  color: var(--eh-text-primary);
  font-variant-numeric: tabular-nums;
}

/* ── Step dots (used in wizards) ──────────────────────────────── */
.eh-steps {
  display: inline-flex;
  align-items: center;
  gap: var(--eh-sp-2);
  padding: var(--eh-sp-2) var(--eh-sp-4);
  background: var(--eh-bg-elevated);
  border-radius: var(--eh-radius-pill);
  border: 1px solid var(--eh-border-default);
}

.eh-steps__dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--eh-border-strong);
  transition: all var(--eh-dur-base) var(--eh-easing);
}

.eh-steps__dot--active {
  width: 24px;
  border-radius: var(--eh-radius-pill);
  background: var(--eh-gradient-disk);
  box-shadow: var(--eh-glow-disk);
}

.eh-steps__dot--done {
  background: var(--eh-success);
  box-shadow: 0 0 6px var(--eh-success-glow);
}

/* ── Hero (used on HomePage) ──────────────────────────────────── */
.eh-hero {
  display: flex;
  flex-direction: column;
  align-items: center;
  text-align: center;
  padding: var(--eh-sp-8) var(--eh-sp-5) var(--eh-sp-7);
  gap: var(--eh-sp-4);
}

/* The dashboard's hero: a header, not a landing page. It sat this way as an
   inline override for months; the modifier is the same numbers, named. */
.eh-hero--compact {
  padding: var(--eh-sp-3) var(--eh-sp-5);
}

.eh-hero--compact .eh-hero__title {
  font-size: var(--eh-text-2xl);
}

.eh-hero__logo {
  position: relative;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  margin-bottom: var(--eh-sp-4);
  animation:
    eh-fade-scale var(--eh-dur-deliberate) var(--eh-easing) both;
}

/* Outer conic aura — pure CSS, no SVG. Spins continuously to make
   the dashboard logo *visibly* alive at a glance. The conic
   gradient is the same Gargantua palette the SVG uses, just
   rendered as a soft halo instead of the disk itself. */
.eh-hero__logo::before {
  content: "";
  position: absolute;
  inset: -16%;
  border-radius: 50%;
  background: conic-gradient(
    from 0deg,
    rgba(255, 177, 92, 0.0) 0%,
    rgba(255, 107, 61, 0.45) 18%,
    rgba(240, 56, 107, 0.55) 38%,
    rgba(169, 50, 137, 0.45) 60%,
    rgba(95, 44, 165, 0.30) 80%,
    rgba(255, 177, 92, 0.0) 100%
  );
  filter: blur(18px);
  opacity: 0.55;
  z-index: -1;
  animation: eh-rotate-cw var(--eh-dur-orbit) linear infinite;
  pointer-events: none;
}

/* Faint counter-rotating ring on top of the aura for parallax. */
.eh-hero__logo::after {
  content: "";
  position: absolute;
  inset: -6%;
  border-radius: 50%;
  border: 1px solid rgba(118, 228, 247, 0.20);
  box-shadow:
    inset 0 0 18px rgba(118, 228, 247, 0.10),
    0 0 24px rgba(118, 228, 247, 0.08);
  animation: eh-rotate-ccw var(--eh-dur-orbit) linear infinite;
  pointer-events: none;
}

@media (prefers-reduced-motion: reduce) {
  .eh-hero__logo::before,
  .eh-hero__logo::after {
    animation: none;
  }
}

.eh-hero__title {
  font-size: var(--eh-text-hero);
  font-weight: 800;
  letter-spacing: var(--eh-tracking-tight);
  line-height: var(--eh-leading-tight);
  animation: eh-text-reveal var(--eh-dur-deliberate) var(--eh-easing) 200ms both;
}

.eh-hero__tagline {
  font-size: var(--eh-text-xs);
  letter-spacing: var(--eh-tracking-widest);
  text-transform: uppercase;
  color: var(--eh-cyan);
  margin-bottom: var(--eh-sp-2);
  animation: eh-text-reveal var(--eh-dur-deliberate) var(--eh-easing) 80ms both;
}

/* ── CTA grid (3-up cards on Home) ────────────────────────────── */
.eh-cta-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
  gap: var(--eh-sp-5);
  max-width: 980px;
  margin: var(--eh-sp-7) auto 0;
  width: 100%;
}

/* ── Empty state ──────────────────────────────────────────────── */
.eh-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  text-align: center;
  padding: var(--eh-sp-8) var(--eh-sp-5);
  gap: var(--eh-sp-3);
  color: var(--eh-text-muted);
  min-height: 240px;
}

.eh-empty__icon {
  font-size: 48px;
  margin-bottom: var(--eh-sp-3);
  opacity: 0.4;
}

.eh-empty__title {
  font-size: var(--eh-text-lg);
  color: var(--eh-text-secondary);
}

/* ── Form inputs (used by BuildPage form fields) ──────────────── */
.eh-input {
  appearance: none;
  width: 100%;
  background: var(--eh-bg-base);
  color: var(--eh-text-primary);
  border: 1px solid var(--eh-border-subtle);
  border-radius: var(--eh-radius-sm);
  padding: var(--eh-sp-2) var(--eh-sp-3);
  font-size: var(--eh-text-sm);
  font-family: inherit;
  line-height: var(--eh-leading-snug);
  transition: border-color var(--eh-dur-base) var(--eh-easing),
              box-shadow var(--eh-dur-base) var(--eh-easing);
  box-sizing: border-box;
}

.eh-input::placeholder {
  color: var(--eh-text-muted);
}

.eh-input:hover {
  border-color: var(--eh-border-default);
}

.eh-input:focus,
.eh-input:focus-visible {
  outline: none;
  border-color: var(--eh-cyan);
  box-shadow: 0 0 0 3px rgba(76, 201, 240, 0.18);
}

.eh-input:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.eh-input--textarea {
  min-height: 64px;
  resize: vertical;
  font-family: var(--eh-font-mono);
  font-size: var(--eh-text-xs);
  line-height: var(--eh-leading-relaxed);
}

/* ── Hashing card (long, slow operation reassurance) ──────────────
   Used by BuildPage and InstallPage to show:
     - the "we're doing something" scanner sweep (always animating),
     - the exact "X / Y" counter (determinate),
     - the current item being processed (live updating).
   The combination is critical: progress can move very slowly when
   archives are huge, but the scanner gives immediate visual proof
   that the process isn't frozen. */
.eh-hashing {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: var(--eh-sp-3);
  padding: var(--eh-sp-5);
  background: var(--eh-bg-raised);
  border: 1px solid var(--eh-border-default);
  border-radius: var(--eh-radius-lg);
  overflow: hidden;
  animation: eh-card-pulse 3.2s ease-in-out infinite;
}

.eh-hashing__scanner {
  position: relative;
  height: 6px;
  width: 100%;
  background: var(--eh-bg-base);
  border-radius: var(--eh-radius-pill);
  overflow: hidden;
}

.eh-hashing__scanner::before {
  /* Determinate fill — tied to --eh-progress (0-1). */
  content: "";
  position: absolute;
  inset: 0;
  width: calc(var(--eh-progress, 0) * 100%);
  background: var(--eh-gradient-disk);
  border-radius: var(--eh-radius-pill);
  transition: width var(--eh-dur-base) var(--eh-easing);
  z-index: 1;
}

.eh-hashing__scanner::after {
  /* Always-on shimmer overlay so the user sees motion even when
     determinate progress hasn't ticked yet. */
  content: "";
  position: absolute;
  top: 0;
  left: 0;
  height: 100%;
  width: 25%;
  background: linear-gradient(
    90deg,
    transparent 0%,
    rgba(255, 255, 255, 0.55) 50%,
    transparent 100%
  );
  animation: eh-scanner-sweep 1.4s linear infinite;
  z-index: 2;
}

.eh-hashing__row {
  display: flex;
  align-items: center;
  gap: var(--eh-sp-3);
  flex-wrap: wrap;
}

.eh-hashing__counter {
  font-family: var(--eh-font-mono);
  font-size: var(--eh-text-md);
  color: var(--eh-cyan-bright);
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

.eh-hashing__percent {
  color: var(--eh-text-muted);
  margin-left: var(--eh-sp-2);
  font-size: var(--eh-text-sm);
}

.eh-hashing__current {
  flex: 1 1 200px;
  min-width: 0;
  color: var(--eh-text-secondary);
  font-size: var(--eh-text-sm);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.eh-hashing__title {
  margin: 0;
  font-size: var(--eh-text-lg);
  color: var(--eh-text-primary);
}

.eh-hashing__subtitle {
  margin: 0;
  color: var(--eh-text-secondary);
  font-size: var(--eh-text-sm);
}

@media (prefers-reduced-motion: reduce) {
  .eh-hashing { animation: none; }
  .eh-hashing__scanner::after {
    /* Don't kill the scanner entirely — it's the user's only proof
       that the process isn't frozen. Slow it instead. */
    animation-duration: 4s;
  }
}

/* ── DiffSectionBlock ─────────────────────────────────────────── */
.eh-diff-block {
  background: var(--eh-bg-raised);
  border: 1px solid var(--eh-border-default);
  border-radius: var(--eh-radius-lg);
  overflow: hidden;
  transition: border-color var(--eh-dur-fast) var(--eh-easing);
}

.eh-diff-block:hover {
  border-color: var(--eh-border-strong);
}

.eh-diff-block__header {
  display: flex;
  align-items: center;
  gap: var(--eh-sp-3);
  width: 100%;
  padding: var(--eh-sp-3) var(--eh-sp-4);
  background: transparent;
  border: none;
  color: var(--eh-text-primary);
  font-family: inherit;
  font-size: var(--eh-text-sm);
  font-weight: 600;
  cursor: pointer;
  text-align: left;
  transition: background var(--eh-dur-fast) var(--eh-easing);
}

.eh-diff-block__header:hover {
  background: var(--eh-bg-elevated);
}

.eh-diff-block--expanded .eh-diff-block__header {
  border-bottom: 1px solid var(--eh-border-subtle);
}

.eh-diff-block__chevron {
  color: var(--eh-text-muted);
  font-size: var(--eh-text-xs);
  width: 14px;
  flex-shrink: 0;
  transition: color var(--eh-dur-fast) var(--eh-easing);
}

.eh-diff-block__header:hover .eh-diff-block__chevron {
  color: var(--eh-text-secondary);
}

.eh-diff-block__title {
  flex: 1;
  letter-spacing: var(--eh-tracking-normal);
}

.eh-diff-block__badge {
  margin-left: auto;
}

.eh-diff-block__body {
  padding: var(--eh-sp-1) 0;
  max-height: 360px;
  overflow-y: auto;
}

.eh-diff-block__empty {
  padding: var(--eh-sp-3) var(--eh-sp-4);
  color: var(--eh-text-muted);
  font-size: var(--eh-text-sm);
  font-style: italic;
  margin: 0;
}

/* ── Plugin Diffs page ────────────────────────────────────────── */
.eh-plugin-diffs {
  display: flex;
  flex-direction: column;
  gap: var(--eh-sp-5);
}

/* Selector row */
.eh-plugin-diffs__selector-row {
  display: flex;
  align-items: center;
  gap: var(--eh-sp-3);
  padding: var(--eh-sp-3) var(--eh-sp-4);
  background: var(--eh-bg-raised);
  border: 1px solid var(--eh-border-default);
  border-radius: var(--eh-radius-lg);
  flex-wrap: wrap;
}

/* Meta row (reference / current paths) */
.eh-plugin-diffs__meta {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: var(--eh-sp-2) var(--eh-sp-4);
  padding: var(--eh-sp-3) var(--eh-sp-4);
  background: var(--eh-bg-glass);
  border: 1px solid var(--eh-border-subtle);
  border-radius: var(--eh-radius-md);
  font-size: var(--eh-text-xs);
  color: var(--eh-text-secondary);
}

.eh-plugin-diffs__meta-item {
  display: flex;
  align-items: baseline;
  gap: var(--eh-sp-2);
  min-width: 0;
}

.eh-plugin-diffs__meta-separator {
  font-size: var(--eh-text-xs);
  font-weight: 700;
  color: var(--eh-text-muted);
  letter-spacing: var(--eh-tracking-wide);
  padding: 0 var(--eh-sp-1);
  flex-shrink: 0;
}

/* Section blocks container */
.eh-plugin-diffs__blocks {
  display: flex;
  flex-direction: column;
  gap: var(--eh-sp-3);
}

/* Plugin list inside a section body */
.eh-plugin-diffs__plugin-list {
  list-style: none;
  margin: 0;
  padding: 0;
}

.eh-plugin-diffs__plugin-row {
  display: flex;
  align-items: center;
  gap: var(--eh-sp-3);
  padding: var(--eh-sp-2) var(--eh-sp-4);
  border-bottom: 1px solid var(--eh-border-subtle);
}

.eh-plugin-diffs__plugin-row:last-child {
  border-bottom: none;
}

.eh-plugin-diffs__plugin-row:hover {
  background: var(--eh-bg-elevated);
}

.eh-plugin-diffs__plugin-name {
  flex: 1;
  font-family: var(--eh-font-mono);
  font-size: var(--eh-text-xs);
  color: var(--eh-text-primary);
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.eh-plugin-diffs__plugin-name--clickable {
  appearance: none;
  background: transparent;
  border: none;
  padding: 0;
  cursor: pointer;
  font-family: var(--eh-font-mono);
  font-size: var(--eh-text-xs);
  color: var(--eh-cyan);
  text-align: left;
  transition: color var(--eh-dur-fast) var(--eh-easing);
}

.eh-plugin-diffs__plugin-name--clickable:hover {
  color: var(--eh-cyan-bright);
  text-decoration: underline;
}

.eh-plugin-diffs__change-detail {
  display: flex;
  align-items: center;
  gap: var(--eh-sp-2);
  flex-shrink: 0;
}

.eh-plugin-diffs__arrow {
  color: var(--eh-text-muted);
  font-size: var(--eh-text-xs);
}

.eh-plugin-diffs__position {
  font-family: var(--eh-font-mono);
  font-size: var(--eh-text-xs);
  color: var(--eh-cyan-dim);
  font-weight: 600;
}

.eh-plugin-diffs__report {
  display: flex;
  flex-direction: column;
  gap: var(--eh-sp-4);
}

/* ── Mod Diffs page ───────────────────────────────────────────── */
/* Shares the same visual language as .eh-plugin-diffs__* above.  */
.eh-mod-diffs {
  display: flex;
  flex-direction: column;
  gap: var(--eh-sp-5);
}

.eh-mod-diffs__selector-row {
  display: flex;
  align-items: center;
  gap: var(--eh-sp-3);
  padding: var(--eh-sp-3) var(--eh-sp-4);
  background: var(--eh-bg-raised);
  border: 1px solid var(--eh-border-default);
  border-radius: var(--eh-radius-lg);
  flex-wrap: wrap;
}

/* Snapshot metadata strip */
.eh-mod-diffs__meta {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-start;
  gap: var(--eh-sp-3) var(--eh-sp-5);
  padding: var(--eh-sp-3) var(--eh-sp-4);
  background: var(--eh-bg-glass);
  border: 1px solid var(--eh-border-subtle);
  border-radius: var(--eh-radius-md);
}

.eh-mod-diffs__meta-item {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--eh-sp-2);
}

.eh-mod-diffs__meta-date {
  font-size: var(--eh-text-xs);
  color: var(--eh-text-muted);
}

.eh-mod-diffs__meta-separator {
  font-size: var(--eh-text-xs);
  font-weight: 700;
  color: var(--eh-text-muted);
  letter-spacing: var(--eh-tracking-wide);
  padding: 0 var(--eh-sp-1);
  align-self: center;
}

/* Section blocks container */
.eh-mod-diffs__blocks {
  display: flex;
  flex-direction: column;
  gap: var(--eh-sp-3);
}

/* Mod list rows */
.eh-mod-diffs__mod-list {
  list-style: none;
  margin: 0;
  padding: 0;
}

.eh-mod-diffs__mod-row {
  display: flex;
  align-items: center;
  gap: var(--eh-sp-3);
  padding: var(--eh-sp-2) var(--eh-sp-4);
  border-bottom: 1px solid var(--eh-border-subtle);
}

.eh-mod-diffs__mod-row:last-child {
  border-bottom: none;
}

.eh-mod-diffs__mod-row:hover {
  background: var(--eh-bg-elevated);
}

.eh-mod-diffs__mod-name {
  flex: 1;
  font-size: var(--eh-text-sm);
  color: var(--eh-text-primary);
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.eh-mod-diffs__mod-version {
  font-size: var(--eh-text-xs);
  color: var(--eh-text-muted);
  font-family: var(--eh-font-mono);
  white-space: nowrap;
  flex-shrink: 0;
}

/* Changed mod rows */
.eh-mod-diffs__mod-row--changed {
  flex-direction: column;
  align-items: stretch;
  padding: 0;
}

.eh-mod-diffs__changed-header {
  display: flex;
  align-items: center;
  gap: var(--eh-sp-3);
  width: 100%;
  padding: var(--eh-sp-2) var(--eh-sp-4);
  background: transparent;
  border: none;
  color: var(--eh-text-primary);
  font-family: inherit;
  font-size: var(--eh-text-sm);
  cursor: pointer;
  text-align: left;
  transition: background var(--eh-dur-fast) var(--eh-easing);
}

.eh-mod-diffs__changed-header:hover {
  background: var(--eh-bg-elevated);
}

.eh-mod-diffs__changed-chevron {
  color: var(--eh-text-muted);
  font-size: var(--eh-text-xs);
  width: 14px;
  flex-shrink: 0;
}

.eh-mod-diffs__changed-count {
  margin-left: auto;
  font-size: var(--eh-text-xs);
  color: var(--eh-cyan-dim);
  font-weight: 600;
  white-space: nowrap;
  flex-shrink: 0;
}

/* Field diff rows inside a changed mod */
.eh-mod-diffs__field-list {
  list-style: none;
  margin: 0;
  padding: 0 0 var(--eh-sp-2) 0;
  background: var(--eh-bg-base);
  border-top: 1px solid var(--eh-border-subtle);
}

.eh-mod-diffs__field-row {
  display: flex;
  align-items: baseline;
  gap: var(--eh-sp-3);
  padding: var(--eh-sp-2) var(--eh-sp-4) var(--eh-sp-2) calc(var(--eh-sp-4) + 14px + var(--eh-sp-3));
  border-bottom: 1px solid var(--eh-border-subtle);
  flex-wrap: wrap;
}

.eh-mod-diffs__field-row:last-child {
  border-bottom: none;
}

.eh-mod-diffs__field-name {
  font-family: var(--eh-font-mono);
  font-size: var(--eh-text-xs);
  color: var(--eh-text-muted);
  font-weight: 600;
  min-width: 120px;
  flex-shrink: 0;
}

.eh-mod-diffs__field-values {
  display: flex;
  align-items: center;
  gap: var(--eh-sp-2);
  flex-wrap: wrap;
  flex: 1;
}

.eh-mod-diffs__field-value {
  font-family: var(--eh-font-mono);
  font-size: var(--eh-text-xs);
}

.eh-mod-diffs__field-value--ref {
  color: var(--eh-danger);
}

.eh-mod-diffs__field-value--cur {
  color: var(--eh-success);
}

.eh-mod-diffs__arrow {
  color: var(--eh-text-muted);
  font-size: var(--eh-text-xs);
  flex-shrink: 0;
}

.eh-mod-diffs__report {
  display: flex;
  flex-direction: column;
  gap: var(--eh-sp-4);
}

/* Match-tier badge + confidence (how a pair was matched) */
.eh-mod-diffs__tier-badge {
  font-size: var(--eh-text-xs);
  font-family: var(--eh-font-mono);
  color: var(--eh-text-muted);
  background: var(--eh-bg-elevated);
  border: 1px solid var(--eh-border-subtle);
  border-radius: 999px;
  padding: 1px var(--eh-sp-2);
  white-space: nowrap;
  flex-shrink: 0;
}

.eh-mod-diffs__tier-badge--fuzzy {
  color: var(--eh-warning, var(--eh-cyan-dim));
}

.eh-mod-diffs__confidence {
  font-size: var(--eh-text-xs);
  color: var(--eh-text-muted);
  margin-left: var(--eh-sp-1);
}

/* Category grouping inside an expanded changed mod */
.eh-mod-diffs__field-cat {
  display: block;
  font-size: var(--eh-text-xs);
  font-weight: 600;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--eh-text-muted);
  padding: var(--eh-sp-2) var(--eh-sp-4) var(--eh-sp-1)
    calc(var(--eh-sp-4) + 14px + var(--eh-sp-3));
}

.eh-mod-diffs__more-toggle {
  display: inline-flex;
  align-items: center;
  gap: var(--eh-sp-1);
  margin: var(--eh-sp-1) 0 0
    calc(var(--eh-sp-4) + 14px + var(--eh-sp-3));
  background: transparent;
  border: none;
  color: var(--eh-cyan-dim);
  font-family: inherit;
  font-size: var(--eh-text-xs);
  cursor: pointer;
  padding: var(--eh-sp-1) 0;
}

.eh-mod-diffs__more-toggle:hover {
  text-decoration: underline;
}

/* Matched-no-change list reuses mod-list; small tier suffix */
.eh-mod-diffs__mod-tier {
  margin-left: auto;
  font-size: var(--eh-text-xs);
  color: var(--eh-text-muted);
  font-family: var(--eh-font-mono);
  white-space: nowrap;
  flex-shrink: 0;
}
`;
