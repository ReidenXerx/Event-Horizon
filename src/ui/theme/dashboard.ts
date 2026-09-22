/**
 * The home dashboard: a cinematic hero over the collection's own artwork,
 * then dense panels of numbers.
 *
 * The art belongs to the curator, so the hero is built to survive not having
 * it: every rule that positions text over the image works the same when the
 * image is absent and a gradient takes its place. A dashboard whose layout
 * depends on a picture is a dashboard that breaks on the first collection
 * nobody designed.
 */
export const DASHBOARD_CSS = `
/* ── mode switch ─────────────────────────────────────────────────────── */
.eh-modes {
  display: flex;
  gap: 6px;
  align-items: center;
  justify-content: center;
  margin-bottom: var(--eh-sp-5);
}
.eh-mode {
  padding: 8px 22px;
  border-radius: 999px;
  border: 1px solid var(--eh-border-default);
  background: transparent;
  color: var(--eh-text-muted);
  font-size: 12px;
  font-weight: 600;
  letter-spacing: .08em;
  text-transform: uppercase;
  cursor: pointer;
  transition: background .18s ease, color .18s ease, box-shadow .18s ease;
}
.eh-mode:hover { color: var(--eh-text-primary); }
.eh-mode--on {
  background: linear-gradient(135deg, var(--eh-disk-hot), var(--eh-disk-pink));
  color: #1a0f2e;
  border-color: transparent;
  box-shadow: 0 6px 24px rgba(255, 77, 141, .32);
}

/* ── hero ────────────────────────────────────────────────────────────── */
.eh-dash-hero {
  position: relative;
  border-radius: var(--eh-radius-lg);
  overflow: hidden;
  border: 1px solid var(--eh-border-default);
  min-height: 300px;
  display: flex;
  align-items: flex-end;
  background:
    radial-gradient(120% 140% at 10% 0%, rgba(255, 138, 61, .18), transparent 55%),
    var(--eh-bg-raised);
}
.eh-dash-hero__art {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  object-fit: cover;
}
/* Keeps the text legible whatever the curator's picture happens to be. */
.eh-dash-hero__scrim {
  position: absolute;
  inset: 0;
  background: linear-gradient(90deg,
    rgba(10, 6, 20, .94) 0%,
    rgba(10, 6, 20, .78) 42%,
    rgba(10, 6, 20, .30) 100%);
}
.eh-dash-hero__inner {
  position: relative;
  width: 100%;
  padding: var(--eh-sp-5) var(--eh-sp-6);
  display: flex;
  flex-direction: column;
  gap: var(--eh-sp-3);
}
.eh-dash-hero__title {
  margin: 0;
  font-size: 40px;
  line-height: 1.05;
  font-weight: 800;
  color: var(--eh-text-primary);
}
.eh-dash-hero__stats {
  display: flex;
  align-items: center;
  gap: var(--eh-sp-5);
  flex-wrap: wrap;
  margin: var(--eh-sp-3) 0;
}

/* ── stat blocks ─────────────────────────────────────────────────────── */
.eh-stat { min-width: 92px; }
.eh-stat__key {
  font-size: 10px;
  font-weight: 600;
  letter-spacing: .14em;
  text-transform: uppercase;
  color: var(--eh-text-muted);
}
.eh-stat__value {
  font-size: 28px;
  line-height: 1.1;
  font-weight: 700;
  color: var(--eh-text-primary);
}
.eh-stat__value--sm { font-size: 20px; }
.eh-stat__sub { font-size: 11px; color: var(--eh-text-muted); }

/* ── panels ──────────────────────────────────────────────────────────── */
.eh-dash-grid {
  display: grid;
  gap: var(--eh-sp-4);
  grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
}
/*
 * Fixed-width columns, not 1fr: with one collection installed an auto-fit
 * grid stretched its single tile across the whole page, so the least
 * important thing on the screen became the largest.
 */
.eh-dash-tiles {
  display: grid;
  gap: var(--eh-sp-4);
  grid-template-columns: repeat(auto-fill, 260px);
  justify-content: start;
}
.eh-dash-tile {
  position: relative;
  border-radius: var(--eh-radius-md);
  border: 1px solid var(--eh-border-default);
  overflow: hidden;
  background: var(--eh-bg-raised);
  min-height: 150px;
  display: flex;
  flex-direction: column;
  justify-content: flex-end;
  cursor: pointer;
  text-align: left;
  padding: 0;
  color: inherit;
}
.eh-dash-tile__art {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  object-fit: cover;
  opacity: .55;
}
.eh-dash-tile__body {
  position: relative;
  padding: var(--eh-sp-4);
  background: linear-gradient(0deg, rgba(10, 6, 20, .92), rgba(10, 6, 20, .25));
}
.eh-dash-tile--plain {
  align-items: center;
  justify-content: center;
  text-align: center;
  cursor: default;
}

/* ── bars and legends ────────────────────────────────────────────────── */
.eh-meter {
  height: 8px;
  border-radius: 999px;
  background: rgba(255, 255, 255, .08);
  overflow: hidden;
}
.eh-meter > i {
  display: block;
  height: 100%;
  background: linear-gradient(90deg, var(--eh-disk-warm), var(--eh-disk-pink));
}
.eh-legend {
  display: flex;
  gap: var(--eh-sp-4);
  flex-wrap: wrap;
  margin-top: var(--eh-sp-2);
}
.eh-legend__item {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--eh-text-muted);
}
.eh-legend__dot {
  width: 9px;
  height: 9px;
  border-radius: 3px;
  display: inline-block;
}

/* ── chart text (SVG) ────────────────────────────────────────────────── */
.eh-ring-value { fill: var(--eh-text-primary); font-size: 26px; font-weight: 700; }
.eh-ring-label {
  fill: var(--eh-text-muted);
  font-size: 10px;
  font-weight: 600;
  letter-spacing: .14em;
  text-transform: uppercase;
}
.eh-ring-sub { fill: var(--eh-text-muted); font-size: 10px; }
/* Dark ink on the bright slice fills, which are light by design. */
.eh-slice-label { fill: #1b0f27; font-size: 13px; font-weight: 700; }
.eh-slice-value { fill: #1b0f27; font-size: 20px; font-weight: 700; opacity: .9; }
.eh-slice-hint { fill: #1b0f27; font-size: 11px; opacity: .75; }

/* ── curator cockpit ─────────────────────────────────────────────────── */
.eh-cockpit {
  display: grid;
  gap: var(--eh-sp-4);
  grid-template-columns: repeat(auto-fit, minmax(340px, 1fr));
}
.eh-cockpit__stats {
  display: flex;
  gap: var(--eh-sp-5);
  flex-wrap: wrap;
  margin: var(--eh-sp-3) 0;
}
.eh-spark-row {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: var(--eh-sp-3);
  margin-top: var(--eh-sp-3);
}

/* A button that is only a hit target; the ring inside it carries the look. */
.eh-plain-button {
  background: none;
  border: none;
  padding: 0;
  cursor: pointer;
  color: inherit;
  line-height: 0;
}
/* A row with its two ends pushed apart: a label and the figure it names. */
.eh-row--between {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: var(--eh-sp-3);
}
`;
