/**
 * CSS for the second generation of primitives — the ones that used to be
 * re-derived by hand in every page.
 *
 * Measured before this file existed: 525 inline `style={{…}}` blocks across
 * src/ui, five independent "stat tile" components, three section headers,
 * two warning panels, and a Modal, Toast and DataTable that carried every
 * pixel inline. Each was a slightly different answer to the same question,
 * and none of them could be reviewed as a design because there was no one
 * place the design lived.
 *
 * Everything here reads tokens only. A value that is not a token is a bug
 * (see tokens.test.ts for the audit that catches an undeclared one) — with one
 * exception, the tinted backgrounds, which are `color-mix()` over a token
 * because a semantic colour at 10% alpha is not worth a token of its own.
 *
 * Naming is the same BEM-lite as components.ts: `.eh-{block}__{elem}--{mod}`.
 */

export const PRIMITIVES_CSS = `
/* ── Page header (the same header on every page and wizard step) ─── */
.eh-page__header {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: var(--eh-sp-4);
  flex-wrap: wrap;
  margin-bottom: var(--eh-sp-5);
}

.eh-page__heading {
  flex: 1 1 320px;
  min-width: 0;
}

/* The row above the title: step dots, a breadcrumb, a status pill. */
.eh-page__eyebrow {
  display: flex;
  align-items: center;
  gap: var(--eh-sp-2);
  margin-bottom: var(--eh-sp-4);
  flex-wrap: wrap;
}

.eh-page__title {
  /* 2xl, not 3xl: the extension lives in a pane, not a landing page, and the
     wizards already used 2xl — so the two page kinds no longer disagree. */
  font-size: var(--eh-text-2xl);
  font-weight: 700;
  letter-spacing: var(--eh-tracking-tight);
  line-height: var(--eh-leading-tight);
  margin: 0;
}

.eh-page__subtitle {
  margin: var(--eh-sp-2) 0 0 0;
  color: var(--eh-text-secondary);
  font-size: var(--eh-text-md);
  line-height: var(--eh-leading-relaxed);
  max-width: 72ch;
}

.eh-page__actions {
  display: flex;
  align-items: center;
  gap: var(--eh-sp-2);
  flex-wrap: wrap;
  justify-content: flex-end;
}

/* ── Section: a titled region inside a page ───────────────────────── */
.eh-section {
  display: flex;
  flex-direction: column;
  gap: var(--eh-sp-3);
}

.eh-section__header {
  display: flex;
  align-items: baseline;
  gap: var(--eh-sp-3);
  flex-wrap: wrap;
}

.eh-section__title {
  margin: 0;
  font-size: var(--eh-text-lg);
  font-weight: 600;
  letter-spacing: var(--eh-tracking-tight);
  color: var(--eh-text-primary);
}

.eh-section__title--sm {
  font-size: var(--eh-text-md);
}

/* The section that IS the page: its heading is the page title. */
.eh-section--page .eh-section__title {
  font-size: var(--eh-text-2xl);
  font-weight: 700;
}
.eh-section--page .eh-section__desc {
  color: var(--eh-text-secondary);
  font-size: var(--eh-text-md);
}

/* A section whose heading carries a verdict ("What to try" on an error). */
.eh-section--success .eh-section__title { color: var(--eh-success); }
.eh-section--warning .eh-section__title { color: var(--eh-warning); }
.eh-section--danger  .eh-section__title { color: var(--eh-danger); }

.eh-section__desc {
  margin: 0;
  color: var(--eh-text-muted);
  font-size: var(--eh-text-sm);
  flex: 1 1 240px;
  min-width: 0;
  max-width: 72ch;
}

.eh-section__actions {
  margin-left: auto;
  display: flex;
  gap: var(--eh-sp-2);
  align-items: center;
}

/* ── Stat tile: a label over a value ──────────────────────────────── */
.eh-stat {
  display: flex;
  flex-direction: column;
  gap: var(--eh-sp-1);
  min-width: 0;
  padding: var(--eh-sp-3) var(--eh-sp-4);
  background: var(--eh-bg-base);
  border: 1px solid var(--eh-border-subtle);
  border-radius: var(--eh-radius-md);
}

/* Bare: the same anatomy with no box, for a status bar. */
.eh-stat--bare {
  padding: 0;
  background: transparent;
  border: 0;
}

.eh-stat__label {
  color: var(--eh-text-muted);
  font-size: var(--eh-text-xs);
  text-transform: uppercase;
  letter-spacing: var(--eh-tracking-widest);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.eh-stat__value {
  color: var(--eh-text-primary);
  font-size: var(--eh-text-md);
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  line-height: var(--eh-leading-snug);
  overflow-wrap: anywhere;
}

.eh-stat--lg .eh-stat__value {
  font-size: var(--eh-text-2xl);
  font-weight: 700;
  line-height: var(--eh-leading-tight);
}

.eh-stat--md .eh-stat__value {
  font-size: var(--eh-text-xl);
}

.eh-stat__sub {
  color: var(--eh-text-muted);
  font-size: var(--eh-text-xs);
  overflow-wrap: anywhere;
}

.eh-stat__sub--mono {
  font-family: var(--eh-font-mono);
}

/* Colour is for something that needs attention; neutral reads as text. */
.eh-stat--info    .eh-stat__value { color: var(--eh-cyan); }
.eh-stat--success .eh-stat__value { color: var(--eh-success); }
.eh-stat--warning .eh-stat__value { color: var(--eh-warning); }
.eh-stat--danger  .eh-stat__value { color: var(--eh-danger); }
.eh-stat--quiet   .eh-stat__value { color: var(--eh-text-secondary); font-weight: 500; }

/* A row of tiles that fills its width and wraps without leaving an orphan
   at a different size from its siblings. */
.eh-stat-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(var(--eh-grid-min, 150px), 1fr));
  gap: var(--eh-sp-3);
}

/* ── Grid utility ─────────────────────────────────────────────────── */
.eh-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(var(--eh-grid-min, 240px), 1fr));
  gap: var(--eh-sp-4);
}
.eh-grid--tight { gap: var(--eh-sp-3); }

/* Body copy should not run the full 1280px: past ~75 characters the eye
   loses the line. Apply to any prose block that sits outside a card. */
.eh-prose {
  max-width: 72ch;
}

/* ── Callout: a message with a tone ───────────────────────────────── */
.eh-callout {
  display: flex;
  gap: var(--eh-sp-3);
  align-items: flex-start;
  padding: var(--eh-sp-3) var(--eh-sp-4);
  border: 1px solid var(--eh-border-default);
  border-left-width: 3px;
  border-radius: var(--eh-radius-md);
  background: var(--eh-bg-raised);
  color: var(--eh-text-primary);
  font-size: var(--eh-text-sm);
  line-height: var(--eh-leading-relaxed);
}

.eh-callout__icon {
  flex: none;
  line-height: 1;
  margin-top: 3px;
  font-size: var(--eh-text-md);
}

.eh-callout__body {
  flex: 1 1 auto;
  min-width: 0;
}

.eh-callout__title {
  display: block;
  font-weight: 600;
  margin-bottom: var(--eh-sp-1);
}

.eh-callout__actions {
  display: flex;
  gap: var(--eh-sp-2);
  flex-wrap: wrap;
  margin-top: var(--eh-sp-3);
}

.eh-callout--info {
  border-color: color-mix(in srgb, var(--eh-info) 45%, transparent);
  border-left-color: var(--eh-info);
  background: color-mix(in srgb, var(--eh-info) 8%, var(--eh-bg-raised));
}
.eh-callout--info .eh-callout__icon { color: var(--eh-info); }

.eh-callout--success {
  border-color: color-mix(in srgb, var(--eh-success) 45%, transparent);
  border-left-color: var(--eh-success);
  background: color-mix(in srgb, var(--eh-success) 8%, var(--eh-bg-raised));
}
.eh-callout--success .eh-callout__icon { color: var(--eh-success); }

.eh-callout--warning {
  border-color: color-mix(in srgb, var(--eh-warning) 45%, transparent);
  border-left-color: var(--eh-warning);
  background: color-mix(in srgb, var(--eh-warning) 8%, var(--eh-bg-raised));
}
.eh-callout--warning .eh-callout__icon { color: var(--eh-warning); }

.eh-callout--danger {
  border-color: color-mix(in srgb, var(--eh-danger) 45%, transparent);
  border-left-color: var(--eh-danger);
  background: color-mix(in srgb, var(--eh-danger) 8%, var(--eh-bg-raised));
}
.eh-callout--danger .eh-callout__icon { color: var(--eh-danger); }

/* ── Notice: a labelled finding on a report (Done screen, Doctor) ─── */
.eh-notice {
  padding: var(--eh-sp-3) var(--eh-sp-4);
  background: var(--eh-bg-base);
  border: 1px solid var(--eh-border-subtle);
  border-radius: var(--eh-radius-md);
  display: flex;
  flex-direction: column;
  gap: var(--eh-sp-2);
}

.eh-notice__head {
  display: flex;
  gap: var(--eh-sp-3);
  align-items: flex-start;
}

.eh-notice__head .eh-pill {
  flex: none;
  margin-top: 1px;
}

.eh-notice__summary {
  flex: 1 1 auto;
  min-width: 0;
  color: var(--eh-text-secondary);
  font-size: var(--eh-text-sm);
  line-height: var(--eh-leading-normal);
}

.eh-notice--warning { border-color: color-mix(in srgb, var(--eh-warning) 45%, transparent); }
.eh-notice--danger  { border-color: color-mix(in srgb, var(--eh-danger) 45%, transparent); }
.eh-notice--success { border-color: color-mix(in srgb, var(--eh-success) 35%, transparent); }
.eh-notice--info    { border-color: color-mix(in srgb, var(--eh-info) 35%, transparent); }

/* ── Severity dot ─────────────────────────────────────────────────── */
.eh-dot {
  display: inline-block;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex: none;
  background: var(--eh-text-muted);
}
.eh-dot--info    { background: var(--eh-info); }
.eh-dot--success { background: var(--eh-success); }
.eh-dot--warning { background: var(--eh-warning); }
.eh-dot--danger  { background: var(--eh-danger); }
.eh-dot--glow    { box-shadow: 0 0 8px currentColor; }
.eh-dot--lg      { width: 10px; height: 10px; }

/* ── Link button: an action that reads as text ────────────────────── */
.eh-link-button {
  appearance: none;
  display: inline-flex;
  align-items: center;
  gap: var(--eh-sp-1);
  background: none;
  border: 0;
  padding: 0;
  margin: 0;
  color: var(--eh-cyan);
  font: inherit;
  font-size: var(--eh-text-sm);
  font-weight: 500;
  cursor: pointer;
  text-align: left;
  border-radius: var(--eh-radius-xs);
  transition: color var(--eh-dur-fast) var(--eh-easing);
}

.eh-link-button:hover:not(:disabled) {
  color: var(--eh-cyan-bright);
  text-decoration: underline;
  text-underline-offset: 3px;
}

.eh-link-button:disabled {
  color: var(--eh-text-disabled);
  cursor: not-allowed;
}

.eh-link-button--xs {
  font-size: var(--eh-text-xs);
}

/* The "SHOW DETAILS (3)" style: uppercase, tracked, small. */
.eh-link-button--caps {
  font-size: var(--eh-text-xs);
  font-weight: 600;
  letter-spacing: var(--eh-tracking-wide);
  text-transform: uppercase;
}

.eh-link-button--danger { color: var(--eh-danger); }
.eh-link-button--danger:hover:not(:disabled) { color: var(--eh-danger); }
.eh-link-button--muted { color: var(--eh-text-secondary); }

/* ── Spinner ──────────────────────────────────────────────────────── */
.eh-spinner {
  display: inline-block;
  width: 1em;
  height: 1em;
  flex: none;
  border-radius: 50%;
  border: 2px solid color-mix(in srgb, currentColor 25%, transparent);
  border-top-color: currentColor;
  animation: eh-spinner 0.8s linear infinite;
}

.eh-button--busy {
  cursor: progress;
  opacity: 0.75;
}

.eh-button--busy:hover {
  transform: none;
}

/* ── Details (native disclosure, styled once) ─────────────────────── */
.eh-details > summary {
  cursor: pointer;
  list-style: none;
  display: inline-flex;
  align-items: center;
  gap: var(--eh-sp-2);
  color: var(--eh-text-secondary);
  font-size: var(--eh-text-sm);
  user-select: none;
  border-radius: var(--eh-radius-xs);
}

.eh-details > summary::-webkit-details-marker {
  display: none;
}

.eh-details > summary::before {
  content: "\\25B8";
  display: inline-block;
  color: var(--eh-text-muted);
  font-size: var(--eh-text-xs);
  width: 12px;
  transition: transform var(--eh-dur-fast) var(--eh-easing);
}

.eh-details[open] > summary::before {
  transform: rotate(90deg);
}

.eh-details > summary:hover {
  color: var(--eh-text-primary);
}

.eh-details__body {
  margin-top: var(--eh-sp-2);
  padding-left: calc(12px + var(--eh-sp-2));
}

/* ── Form controls ────────────────────────────────────────────────── */
.eh-field {
  display: flex;
  flex-direction: column;
  gap: var(--eh-sp-1);
  min-width: 0;
}

.eh-field--inline {
  flex-direction: row;
  align-items: center;
  gap: var(--eh-sp-3);
}

.eh-field__label {
  white-space: nowrap;
  color: var(--eh-text-secondary);
  font-size: var(--eh-text-xs);
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: var(--eh-tracking-widest);
}

.eh-field__required {
  color: var(--eh-disk-warm);
  margin-left: 2px;
}

.eh-field__hint {
  color: var(--eh-text-muted);
  font-size: var(--eh-text-xs);
  line-height: var(--eh-leading-normal);
}

.eh-field__error {
  color: var(--eh-danger);
  font-size: var(--eh-text-xs);
}

.eh-field--invalid .eh-input,
.eh-field--invalid .eh-select {
  border-color: var(--eh-danger);
}

/* A row of fields sharing one line. */
.eh-form-row {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(var(--eh-grid-min, 200px), 1fr));
  gap: var(--eh-sp-3) var(--eh-sp-4);
}

/* A value the page has judged wrong, said on the control itself. */
.eh-input[aria-invalid="true"],
.eh-select[aria-invalid="true"] {
  border-color: var(--eh-warning);
}

.eh-input--mono {
  font-family: var(--eh-font-mono);
  font-size: var(--eh-text-xs);
}

.eh-input--sm {
  padding: 2px var(--eh-sp-2);
  font-size: var(--eh-text-xs);
}

/* Select: the native control with our chrome and a drawn chevron. Was
   copied verbatim into two page-scoped classes; this is the one copy. */
.eh-select {
  appearance: none;
  width: 100%;
  background-color: var(--eh-bg-base);
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='8' viewBox='0 0 12 8'%3E%3Cpath d='M1 1l5 5 5-5' stroke='%237a7898' fill='none' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E");
  background-repeat: no-repeat;
  background-position: right var(--eh-sp-3) center;
  border: 1px solid var(--eh-border-subtle);
  border-radius: var(--eh-radius-sm);
  color: var(--eh-text-primary);
  font-family: inherit;
  font-size: var(--eh-text-sm);
  line-height: var(--eh-leading-snug);
  padding: var(--eh-sp-2) var(--eh-sp-7) var(--eh-sp-2) var(--eh-sp-3);
  cursor: pointer;
  transition: border-color var(--eh-dur-fast) var(--eh-easing),
              box-shadow var(--eh-dur-fast) var(--eh-easing);
}

.eh-select:hover { border-color: var(--eh-border-default); }

.eh-select:focus,
.eh-select:focus-visible {
  outline: none;
  border-color: var(--eh-cyan);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--eh-cyan) 18%, transparent);
}

.eh-select:disabled { opacity: 0.5; cursor: not-allowed; }

.eh-select--sm {
  padding: 2px var(--eh-sp-6) 2px var(--eh-sp-2);
  font-size: var(--eh-text-xs);
  background-position: right var(--eh-sp-2) center;
}

.eh-select--auto { width: auto; }

/* Options inherit nothing from the select in Chromium; colour them. */
.eh-select option {
  background: var(--eh-bg-elevated);
  color: var(--eh-text-primary);
}

/* Checkbox and radio: drawn by us, so they match on every platform and
   read correctly on a dark surface (the native ones rendered as solid
   white discs in both states). */
.eh-check {
  appearance: none;
  -webkit-appearance: none;
  flex: none;
  width: 16px;
  height: 16px;
  margin: 0;
  display: inline-grid;
  place-content: center;
  background: var(--eh-bg-base);
  border: 1px solid var(--eh-border-strong);
  border-radius: var(--eh-radius-xs);
  cursor: pointer;
  transition: background var(--eh-dur-fast) var(--eh-easing),
              border-color var(--eh-dur-fast) var(--eh-easing);
}

.eh-check::before {
  content: "";
  width: 10px;
  height: 10px;
  transform: scale(0);
  transition: transform var(--eh-dur-fast) var(--eh-easing-bounce);
  background: var(--eh-text-inverse);
  clip-path: polygon(14% 44%, 0 65%, 50% 100%, 100% 16%, 80% 0%, 43% 62%);
}

.eh-check:checked {
  background: var(--eh-cyan);
  border-color: var(--eh-cyan);
}

.eh-check:checked::before { transform: scale(1); }

/* Checkboxes only: a RADIO whose group has no checked member also matches
   :indeterminate, and every unanswered option rendered as a filled dash. */
input[type="checkbox"].eh-check:indeterminate {
  background: var(--eh-cyan);
  border-color: var(--eh-cyan);
}

input[type="checkbox"].eh-check:indeterminate::before {
  transform: scale(1);
  clip-path: polygon(0 40%, 100% 40%, 100% 60%, 0 60%);
}

.eh-check:hover:not(:disabled) { border-color: var(--eh-cyan); }
.eh-check:disabled { opacity: 0.45; cursor: not-allowed; }

.eh-check--radio {
  border-radius: 50%;
}

.eh-check--radio::before {
  clip-path: none;
  border-radius: 50%;
  width: 6px;
  height: 6px;
  background: var(--eh-text-inverse);
}

/* A control with its label beside it. */
.eh-choice {
  display: inline-flex;
  align-items: flex-start;
  gap: var(--eh-sp-2);
  cursor: pointer;
  font-size: var(--eh-text-sm);
  color: var(--eh-text-primary);
  line-height: var(--eh-leading-normal);
}

.eh-choice .eh-check { margin-top: 3px; }

.eh-choice--disabled { cursor: not-allowed; opacity: 0.6; }

.eh-choice__text {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.eh-choice__desc {
  color: var(--eh-text-muted);
  font-size: var(--eh-text-xs);
}

/* A choice that is a whole card: the radio-option list of a decision. */
.eh-choice-card {
  display: flex;
  gap: var(--eh-sp-3);
  align-items: flex-start;
  padding: var(--eh-sp-3);
  background: transparent;
  border: 1px solid var(--eh-border-subtle);
  border-radius: var(--eh-radius-sm);
  cursor: pointer;
  transition: background var(--eh-dur-fast) var(--eh-easing),
              border-color var(--eh-dur-fast) var(--eh-easing);
}

.eh-choice-card:hover { border-color: var(--eh-border-default); }

.eh-choice-card--checked {
  background: var(--eh-bg-elevated);
  border-color: var(--eh-accent);
}

.eh-choice-card--disabled { cursor: not-allowed; opacity: 0.6; }
/* The selected look on a container whose control is only PART of it. */
.eh-choice-card--static { cursor: default; }
.eh-choice-card--static:hover { border-color: var(--eh-border-subtle); }
.eh-choice-card--static.eh-choice-card--checked:hover { border-color: var(--eh-accent); }

.eh-choice-card .eh-check { margin-top: 2px; }

.eh-choice-card__label {
  display: block;
  color: var(--eh-text-primary);
  font-size: var(--eh-text-sm);
  font-weight: 600;
}

.eh-choice-card__sub {
  display: block;
  color: var(--eh-text-muted);
  font-size: var(--eh-text-xs);
  margin-top: 2px;
  overflow-wrap: anywhere;
}

/* A pill that toggles: filter chips. */
.eh-chip {
  appearance: none;
  display: inline-flex;
  align-items: center;
  gap: var(--eh-sp-1);
  padding: var(--eh-sp-1) var(--eh-sp-3);
  background: var(--eh-bg-base);
  border: 1px solid var(--eh-border-default);
  border-radius: var(--eh-radius-pill);
  color: var(--eh-text-secondary);
  font-family: inherit;
  font-size: var(--eh-text-sm);
  cursor: pointer;
  transition: background var(--eh-dur-fast) var(--eh-easing),
              border-color var(--eh-dur-fast) var(--eh-easing),
              color var(--eh-dur-fast) var(--eh-easing);
}

.eh-chip:hover { border-color: var(--eh-border-strong); color: var(--eh-text-primary); }

.eh-chip--active {
  background: var(--eh-accent-soft);
  border-color: var(--eh-accent);
  color: var(--eh-text-primary);
}

/* ── Modal ────────────────────────────────────────────────────────── */
.eh-modal-backdrop {
  position: absolute;
  inset: 0;
  z-index: var(--eh-z-modal);
  background: var(--eh-bg-overlay);
  backdrop-filter: blur(8px);
  -webkit-backdrop-filter: blur(8px);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: var(--eh-sp-5);
  animation: eh-fade-in var(--eh-dur-base) var(--eh-easing) both;
}

.eh-modal {
  width: 100%;
  max-width: var(--eh-modal-width, 560px);
  max-height: calc(100% - var(--eh-sp-6));
  background: var(--eh-bg-raised);
  border: 1px solid var(--eh-border-default);
  border-radius: var(--eh-radius-lg);
  box-shadow: var(--eh-shadow-modal);
  display: flex;
  flex-direction: column;
  overflow: hidden;
  outline: none;
  /* backwards, not both: a held scale(1) made this card the containing block
     for a nested modal's backdrop, which then dimmed and centred inside the
     outer card and was clipped by its overflow. */
  animation: eh-fade-scale var(--eh-dur-base) var(--eh-easing) backwards;
}

.eh-modal--sm { --eh-modal-width: 420px; }
.eh-modal--md { --eh-modal-width: 560px; }
.eh-modal--lg { --eh-modal-width: 760px; }
.eh-modal--xl { --eh-modal-width: 960px; }

.eh-modal__header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--eh-sp-4);
  padding: var(--eh-sp-5) var(--eh-sp-5) var(--eh-sp-3);
  border-bottom: 1px solid var(--eh-border-subtle);
}

.eh-modal__title {
  margin: 0;
  font-size: var(--eh-text-lg);
  font-weight: 600;
  color: var(--eh-text-primary);
}

.eh-modal__subtitle {
  margin: var(--eh-sp-1) 0 0 0;
  color: var(--eh-text-secondary);
  font-size: var(--eh-text-sm);
  line-height: var(--eh-leading-normal);
}

.eh-modal__close {
  appearance: none;
  flex: none;
  background: transparent;
  border: 0;
  color: var(--eh-text-muted);
  font-size: var(--eh-text-xl);
  line-height: 1;
  cursor: pointer;
  padding: var(--eh-sp-1) var(--eh-sp-2);
  margin: calc(-1 * var(--eh-sp-1)) calc(-1 * var(--eh-sp-2)) 0 0;
  border-radius: var(--eh-radius-sm);
  transition: color var(--eh-dur-fast) var(--eh-easing),
              background var(--eh-dur-fast) var(--eh-easing);
}

.eh-modal__close:hover {
  color: var(--eh-text-primary);
  background: var(--eh-border-subtle);
}

.eh-modal__body {
  /* 1 1 auto, NOT flex:1 — a zero basis made the body contribute nothing to
     the card's height, so it shrank to header + footer with the content
     scrolling in a sliver. See the modal history for the clipped stat cards. */
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  padding: var(--eh-sp-5);
}

.eh-modal__footer {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: var(--eh-sp-2);
  flex-wrap: wrap;
  padding: var(--eh-sp-4) var(--eh-sp-5);
  border-top: 1px solid var(--eh-border-subtle);
  background: var(--eh-bg-base);
}

/* ── Toast ────────────────────────────────────────────────────────── */
.eh-toast-host {
  position: absolute;
  right: var(--eh-sp-5);
  bottom: var(--eh-sp-5);
  z-index: var(--eh-z-toast);
  display: flex;
  flex-direction: column;
  gap: var(--eh-sp-2);
  pointer-events: none;
  width: min(380px, calc(100% - 2 * var(--eh-sp-5)));
}

.eh-toast {
  pointer-events: auto;
  position: relative;
  background: var(--eh-bg-elevated);
  border: 1px solid var(--eh-border-default);
  border-left: 3px solid var(--eh-info);
  border-radius: var(--eh-radius-md);
  box-shadow: var(--eh-shadow-card);
  padding: var(--eh-sp-3) var(--eh-sp-4);
  display: flex;
  gap: var(--eh-sp-3);
  align-items: flex-start;
  animation: eh-slide-in-right var(--eh-dur-base) var(--eh-easing) both;
  backdrop-filter: blur(6px);
  -webkit-backdrop-filter: blur(6px);
}

.eh-toast--info    { border-left-color: var(--eh-info); }
.eh-toast--success { border-left-color: var(--eh-success); }
.eh-toast--warning { border-left-color: var(--eh-warning); }
.eh-toast--danger  { border-left-color: var(--eh-danger); }

.eh-toast__title {
  font-weight: 600;
  color: var(--eh-text-primary);
  font-size: var(--eh-text-sm);
  margin-bottom: var(--eh-sp-1);
}

.eh-toast__message {
  color: var(--eh-text-secondary);
  font-size: var(--eh-text-sm);
  line-height: var(--eh-leading-snug);
  overflow-wrap: anywhere;
}

.eh-toast__action {
  margin-top: var(--eh-sp-2);
}

.eh-toast__close {
  appearance: none;
  flex: none;
  background: transparent;
  border: 0;
  color: var(--eh-text-muted);
  cursor: pointer;
  font-size: var(--eh-text-md);
  line-height: 1;
  padding: 0;
  border-radius: var(--eh-radius-xs);
}

.eh-toast__close:hover { color: var(--eh-text-primary); }

/* ── Data table ───────────────────────────────────────────────────── */
.eh-table-toolbar {
  display: flex;
  align-items: center;
  gap: var(--eh-sp-3);
  margin-bottom: var(--eh-sp-2);
  font-size: var(--eh-text-xs);
  color: var(--eh-text-secondary);
  flex-wrap: wrap;
}

.eh-table-wrap {
  max-height: var(--eh-table-max-height, 420px);
  overflow: auto;
  border: 1px solid var(--eh-border-default);
  border-radius: var(--eh-radius-md);
  background: var(--eh-bg-base);
}

.eh-table {
  width: 100%;
  border-collapse: separate;
  border-spacing: 0;
  table-layout: fixed;
  font-size: var(--eh-text-sm);
}

.eh-table th,
.eh-table td {
  padding: var(--eh-sp-2) var(--eh-sp-3);
  text-align: left;
  vertical-align: middle;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.eh-table th {
  /* A column's width comes from its spec, as a custom property. */
  width: var(--eh-col-width, auto);
  position: sticky;
  top: 0;
  z-index: 1;
  background: var(--eh-bg-raised);
  color: var(--eh-text-muted);
  font-size: var(--eh-text-xs);
  font-weight: 600;
  letter-spacing: var(--eh-tracking-wide);
  text-transform: uppercase;
  border-bottom: 1px solid var(--eh-border-default);
}

/* The filter row sits under the header row; both are sticky. */
.eh-table__filters th {
  top: var(--eh-table-head-height, 33px);
  padding-top: var(--eh-sp-1);
  padding-bottom: var(--eh-sp-2);
  text-transform: none;
  letter-spacing: 0;
}

.eh-table__sort {
  appearance: none;
  background: none;
  border: 0;
  padding: 0;
  margin: 0;
  color: inherit;
  font: inherit;
  letter-spacing: inherit;
  text-transform: inherit;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  gap: var(--eh-sp-1);
  max-width: 100%;
  border-radius: var(--eh-radius-xs);
}

.eh-table__sort:hover { color: var(--eh-text-primary); }

.eh-table__sort-glyph {
  font-size: 9px;
  opacity: 0.35;
}

.eh-table__sort--active { color: var(--eh-text-primary); }
.eh-table__sort--active .eh-table__sort-glyph { opacity: 1; color: var(--eh-cyan); }

.eh-table td {
  border-top: 1px solid var(--eh-border-subtle);
  color: var(--eh-text-primary);
}

.eh-table tbody tr:first-child td { border-top: 0; }

.eh-table--selectable tbody tr { cursor: pointer; }

.eh-table--selectable tbody tr:hover td { background: var(--eh-bg-raised); }

.eh-table__row--selected td {
  background: color-mix(in srgb, var(--eh-cyan) 10%, var(--eh-bg-base));
}

.eh-table--selectable tbody tr.eh-table__row--selected:hover td {
  background: color-mix(in srgb, var(--eh-cyan) 14%, var(--eh-bg-base));
}

/* The tick column: wide enough for the box, and never an ellipsis - the
   cell rule above cuts anything that overflows, and a 16px box plus padding
   in a 36px cell photographed as a checkbox followed by "…". */
.eh-table__tick {
  text-overflow: clip;
  text-align: center;
}

/* Column widths live on the HEADER cell, and the generic th rule above sets
   width from the column spec - so these are qualified with th, or they lose
   on order and a fixed-layout table hands the tick column a third of the
   width (photographed: a 230px gap before the first column). */
.eh-table th.eh-table__tick { width: 44px; }
.eh-table th.eh-table__actions { width: var(--eh-col-width, auto); }

.eh-table__actions { text-align: right; }

.eh-table__empty {
  color: var(--eh-text-secondary);
  white-space: normal;
}

.eh-table__num { text-align: right; font-variant-numeric: tabular-nums; }

/* ── Empty state ──────────────────────────────────────────────────── */
.eh-empty__body {
  color: var(--eh-text-muted);
  font-size: var(--eh-text-sm);
  max-width: 48ch;
  line-height: var(--eh-leading-relaxed);
}

.eh-empty__actions {
  display: flex;
  gap: var(--eh-sp-2);
  margin-top: var(--eh-sp-2);
  flex-wrap: wrap;
  justify-content: center;
}

/* ── Actions row that stays reachable on a long step ──────────────── */
.eh-actions--sticky {
  position: sticky;
  bottom: 0;
  z-index: var(--eh-z-raised);
  margin: var(--eh-sp-5) calc(-1 * var(--eh-page-padding)) calc(-1 * var(--eh-page-padding));
  padding: var(--eh-sp-3) var(--eh-page-padding);
  background: var(--eh-bg-glass);
  backdrop-filter: blur(12px);
  -webkit-backdrop-filter: blur(12px);
  border-top: 1px solid var(--eh-border-subtle);
}

/* The "clear" beside the ticked count in a sticky action bar. */
.eh-actions__clear { margin-left: var(--eh-sp-2); }

/* ── Key / value line (was .eh-field; a form field owns that now) ─── */
.eh-kv {
  display: flex;
  gap: var(--eh-sp-2);
  flex-wrap: wrap;
  font-size: var(--eh-text-sm);
}

.eh-kv__label {
  color: var(--eh-text-muted);
  min-width: 132px;
}



/* Multi-line text that must keep its line breaks. */
.eh-pre-line { white-space: pre-line; }
.eh-pre-wrap { white-space: pre-wrap; overflow-wrap: anywhere; }

.eh-list--spaced > li + li { margin-top: var(--eh-sp-2); }

.eh-details--danger > summary { color: var(--eh-danger); }
.eh-details--danger > summary:hover { color: var(--eh-danger); }

/* ── Drop zone: the first thing the install wizard shows ──────────── */
.eh-dropzone {
  display: flex;
  flex-direction: column;
  align-items: center;
  text-align: center;
  gap: var(--eh-sp-5);
  padding: var(--eh-sp-7) var(--eh-sp-5);
  background: var(--eh-bg-glass);
  border: 1px dashed var(--eh-border-default);
  border-radius: var(--eh-radius-lg);
  transition: background var(--eh-dur-fast) var(--eh-easing),
              border-color var(--eh-dur-fast) var(--eh-easing);
  animation: eh-fade-up var(--eh-dur-deliberate) var(--eh-easing) both;
}

.eh-dropzone--active {
  background: var(--eh-accent-soft);
  border: 2px dashed var(--eh-accent);
}

.eh-dropzone__title {
  margin: 0;
  color: var(--eh-text-primary);
  font-size: var(--eh-text-xl);
}

.eh-dropzone__hint {
  margin: var(--eh-sp-2) 0 0 0;
  color: var(--eh-text-secondary);
  font-size: var(--eh-text-sm);
  max-width: 48ch;
}

/* ── Progress panel: a ring beside what is happening ──────────────── */
.eh-progress-panel {
  display: flex;
  align-items: center;
  gap: var(--eh-sp-5);
  padding: var(--eh-sp-6);
  background: var(--eh-bg-raised);
  border: 1px solid var(--eh-border-default);
  border-radius: var(--eh-radius-lg);
}

.eh-progress-panel__title {
  display: block;
  color: var(--eh-text-primary);
  font-size: var(--eh-text-lg);
  font-weight: 600;
}

/* The phases of a run, as a row of small chips. */
.eh-phase-trail {
  display: flex;
  flex-wrap: wrap;
  gap: var(--eh-sp-2);
  list-style: none;
  margin: var(--eh-sp-3) 0 0 0;
  padding: 0;
}

.eh-phase-trail__phase {
  font-size: var(--eh-text-xs);
  font-family: var(--eh-font-mono);
  padding: 2px var(--eh-sp-2);
  border-radius: var(--eh-radius-sm);
  border: 1px solid var(--eh-border-subtle);
  color: var(--eh-text-muted);
  opacity: 0.55;
}

.eh-phase-trail__phase--done {
  color: var(--eh-text-secondary);
  opacity: 1;
}

.eh-phase-trail__phase--active {
  color: var(--eh-cyan);
  border-color: var(--eh-cyan);
  background: var(--eh-bg-raised);
  opacity: 1;
}

/* The last few lines a long run said. */
.eh-activity {
  margin: 0;
  padding: 0;
  list-style: none;
  font-family: var(--eh-font-mono);
  font-size: var(--eh-text-xs);
  color: var(--eh-text-muted);
}

.eh-activity > li { padding: 1px 0; overflow-wrap: anywhere; }

.eh-activity > li:first-child { color: var(--eh-text-secondary); }

/* ── Option card: one of N ways forward, each with its own button ─── */
.eh-option-card {
  display: flex;
  flex-direction: column;
  gap: var(--eh-sp-2);
  height: 100%;
  padding: var(--eh-sp-4);
  border-radius: var(--eh-radius-md);
  background: var(--eh-bg-elevated);
  border: 1px solid var(--eh-border-subtle);
}

.eh-option-card__cta {
  margin-top: auto;
  padding-top: var(--eh-sp-2);
}

/* ── Thin determinate bar ─────────────────────────────────────────── */
.eh-bar {
  height: 6px;
  border-radius: var(--eh-radius-pill);
  background: var(--eh-bg-elevated);
  overflow: hidden;
}

.eh-bar__fill {
  height: 100%;
  width: calc(var(--eh-progress, 0) * 100%);
  background: var(--eh-accent);
  transition: width var(--eh-dur-fast) linear;
}

/* A block that scrolls instead of pushing the page down. */
.eh-scroll {
  max-height: var(--eh-scroll-max, 220px);
  overflow-y: auto;
}

.eh-details--warning > summary { color: var(--eh-warning); }
.eh-details--warning > summary:hover { color: var(--eh-warning); }

/* ── Diff line: a name and a detail held apart ────────────────────── */
.eh-diff-line {
  display: flex;
  justify-content: space-between;
  gap: var(--eh-sp-3);
  /* Inside a diff block, whose header is padded sp-4: rows flush against the
     block's edge photographed as text hanging off the card. */
  padding: 2px var(--eh-sp-4);
  font-size: var(--eh-text-sm);
}

.eh-diff-line__name {
  color: var(--eh-text-primary);
  min-width: 0;
  overflow-wrap: anywhere;
}

.eh-diff-line__detail {
  color: var(--eh-text-muted);
  font-family: var(--eh-font-mono);
  font-size: var(--eh-text-xs);
  white-space: nowrap;
}

/* ── Grid table: a few columns, rows that hold controls ───────────── */
.eh-grid-table {
  border: 1px solid var(--eh-border-subtle);
  border-radius: var(--eh-radius-sm);
  overflow: hidden;
}

.eh-grid-table__head,
.eh-grid-table__row {
  display: grid;
  /* The middle column was "auto", so the header row (no control in it) and the
     body rows (a 9rem select) computed different widths and the headings sat
     over the wrong columns. Fixed fractions line them up. */
  grid-template-columns: var(--eh-grid-table-cols, minmax(0, 2fr) minmax(9rem, 1fr) minmax(0, 3fr));
  gap: var(--eh-sp-3);
  align-items: start;
}

.eh-grid-table__head {
  padding: var(--eh-sp-2) var(--eh-sp-3);
  background: var(--eh-bg-base);
  color: var(--eh-text-muted);
  font-size: var(--eh-text-xs);
  text-transform: uppercase;
  letter-spacing: var(--eh-tracking-widest);
}

.eh-grid-table__row {
  padding: var(--eh-sp-3);
  border-top: 1px solid var(--eh-border-subtle);
}

/* The source dropdown in the external-mods table needs a floor so a
   narrow column does not squash "From website" to a sliver. */
.eh-source-choice { min-width: 9rem; }

/* ── Decision card: a question, then its settled answer ───────────── */
.eh-decision {
  padding: var(--eh-sp-3);
  background: var(--eh-bg-raised);
  border: 1px solid var(--eh-border-default);
  border-radius: var(--eh-radius-md);
  box-shadow: var(--eh-shadow-card);
}

.eh-decision--settled {
  background: var(--eh-bg-base);
  border-color: var(--eh-border-subtle);
  box-shadow: none;
  opacity: 0.6;
}

.eh-decision__index {
  color: var(--eh-text-muted);
  font-variant-numeric: tabular-nums;
  margin-right: var(--eh-sp-2);
}

/* An option among several, each carrying its own button. */
.eh-option {
  display: flex;
  flex-direction: column;
  gap: var(--eh-sp-1);
  padding: var(--eh-sp-2);
  border: 1px solid var(--eh-border-subtle);
  border-radius: var(--eh-radius-sm);
}

/* ── Centred stack: a ring, a headline, a line, a button ──────────── */
.eh-centred {
  display: flex;
  flex-direction: column;
  align-items: center;
  text-align: center;
  gap: var(--eh-sp-4);
  padding: var(--eh-sp-5);
}

/* The whole pane, with its one card in the middle (a crash fallback). */
.eh-centred--page {
  min-height: 70vh;
  justify-content: center;
}
`;
