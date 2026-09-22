/**
 * Event Horizon design tokens — "Gargantua" palette.
 *
 * Phase 5.0 foundation. Every UI surface in the extension reads from
 * these CSS custom properties, so theming is centralized and a future
 * "Penrose" / "Hawking" theme switch is a one-file change.
 *
 * Color philosophy:
 *  - Background tiers go from "deep void" (page chrome) through
 *    "cosmic dust" (raised surfaces) to "lensed plasma" (interactive
 *    accents). Each tier is intentionally cool to balance the warm
 *    accretion-disk accents.
 *  - The accretion-disk gradient (hot → warm → pink → magenta →
 *    violet) is the SAME left-to-right sweep across the disk in
 *    Interstellar's Gargantua, with Doppler-shifted heat on the
 *    near-side and cooler magenta on the far side.
 *  - The cyan accent doubles as gravitational-lensing color and as
 *    the focus-ring / link / "info" semantic — instantly readable
 *    against the warm disk.
 *
 * Motion philosophy:
 *  - Default ease is `cubic-bezier(0.22, 1, 0.36, 1)` (out-quart):
 *    fast start, gentle settle. Reads as "purposeful, not bouncy."
 *  - Bounce ease is reserved for tactile feedback (button press,
 *    pill tap). Never used for incoming content.
 *  - Durations are powers-of-1.75 from 160ms — perceptually even.
 *  - `--eh-dur-warp` (6s) is the slow-loop timer for ambient
 *    animations (logo rotation, starfield drift). Always tied to
 *    `prefers-reduced-motion: reduce` (overrides to `0s`).
 */

export const TOKENS_CSS = `
:root {
  /* ── Background tiers ─────────────────────────────────────────── */
  --eh-bg-deep: #08090b;
  --eh-bg-base: #0c0e11;
  --eh-bg-raised: #14171c;
  --eh-bg-elevated: #1b1f26;
  --eh-bg-overlay: rgba(8, 9, 11, 0.88);
  --eh-bg-glass: rgba(20, 23, 28, 0.66);

  /* ── Accretion disk gradient ──────────────────────────────────── */
  --eh-disk-hot: #ffb15c;
  --eh-disk-warm: #ff6b3d;
  --eh-disk-pink: #f0386b;
  --eh-disk-magenta: #a93289;
  --eh-disk-violet: #5f2ca5;

  /* Pre-baked gradients (for backgrounds, borders, text fills) */
  --eh-gradient-disk:
    linear-gradient(
      90deg,
      var(--eh-disk-hot) 0%,
      var(--eh-disk-warm) 22%,
      var(--eh-disk-pink) 48%,
      var(--eh-disk-magenta) 72%,
      var(--eh-disk-violet) 100%
    );
  /*
   * Flat, not a gradient. The nebula competed with the content for
   * attention: on the install preview it sat behind an orange warning
   * callout, which is the one thing on that screen that has to be seen
   * first. A neutral ground also makes the accretion-disk colours read
   * harder, so they can be spent on data and actions alone.
   */
  --eh-gradient-page: var(--eh-bg-base);

  /* ── Lensing accent (cool, electric) ──────────────────────────── */
  --eh-cyan: #4cc9f0;
  --eh-cyan-bright: #76e4f7;
  --eh-cyan-dim: #2d8aa9;

  /* Semantic alias for "this one is selected / interactive".
     Eight call sites across four pages already ask for --eh-accent; they were
     silently getting nothing, which invalidated the whole "border" shorthand
     and made selected and unselected states render identically. Pointing it at
     the lensing cyan keeps one place to retune the accent. */
  --eh-accent: #4cc9f0;
  --eh-accent-soft: rgba(76, 201, 240, 0.14);

  /* ── Singularity / void ───────────────────────────────────────── */
  --eh-void: #050309;

  /* ── Text ─────────────────────────────────────────────────────── */
  --eh-text-primary: #eef1f5;
  --eh-text-secondary: #a7adb8;
  /*
   * Measured, not chosen by eye. At #6f7681 the muted tier scored 4.22 on the
   * page, 3.92 on a card and 3.39 inside a warning callout — under the 4.5:1
   * that 11px text needs, and this tier carries every field hint, every
   * choice description, every table heading and every key in a key/value row.
   * At #878e99 the same grounds measure 5.85 / 5.44 / 4.70, and it is still
   * clearly a step below --eh-text-secondary.
   */
  --eh-text-muted: #878e99;
  --eh-text-disabled: #4b515a;
  --eh-text-inverse: #0c0e11;

  /* ── Semantic ─────────────────────────────────────────────────── */
  --eh-success: #3ddc84;
  --eh-success-glow: rgba(61, 220, 132, 0.35);
  --eh-warning: #ffb15c;
  --eh-warning-glow: rgba(255, 177, 92, 0.4);
  --eh-danger: #ff5b78;
  --eh-danger-glow: rgba(255, 91, 120, 0.4);
  --eh-info: #4cc9f0;
  --eh-info-glow: rgba(76, 201, 240, 0.4);

  /* ── Borders ──────────────────────────────────────────────────── */
  --eh-border-subtle: rgba(255, 255, 255, 0.05);
  --eh-border-default: rgba(255, 255, 255, 0.09);
  --eh-border-strong: rgba(255, 255, 255, 0.16);

  /* ── Glows / shadows ──────────────────────────────────────────── */
  /*
   * Kept as tokens so a component that WANTS a glow still has one to
   * ask for — the emphasis ring on the health gauge, for instance.
   * They are simply no longer the default dressing on every surface:
   * a border, a fill and a shadow each say "separate object", and
   * stamping all three on every block flattens the hierarchy instead
   * of building one.
   */
  --eh-glow-disk: 0 0 18px rgba(255, 107, 61, 0.28);
  --eh-glow-cyan: 0 0 14px rgba(76, 201, 240, 0.26);
  --eh-shadow-card: 0 1px 2px rgba(0, 0, 0, 0.4);
  --eh-shadow-modal: 0 20px 48px rgba(0, 0, 0, 0.6);
  /*
   * A no-op shadow, NOT the keyword "none".
   *
   * "box-shadow: none, <shadow>" is a parse error — none is legal only as
   * the sole value — so the whole declaration is dropped. The primary button
   * composes this token with the disk glow in one list, which measured as
   * boxShadow: "none" in the same Chromium the extension renders in: the
   * button silently lost the glow in both its resting and hover states, and
   * its shadow transition became dead. This value composes.
   */
  --eh-shadow-button: 0 0 0 0 transparent;

  /* ── Spacing scale (4px base, perceptual ramp) ────────────────── */
  --eh-sp-1: 4px;
  --eh-sp-2: 8px;
  --eh-sp-3: 12px;
  --eh-sp-4: 16px;
  --eh-sp-5: 18px;
  --eh-sp-6: 24px;
  --eh-sp-7: 32px;
  --eh-sp-8: 64px;
  --eh-sp-9: 96px;

  /* ── Radius ───────────────────────────────────────────────────── */
  --eh-radius-xs: 4px;
  --eh-radius-sm: 8px;
  --eh-radius-md: 10px;
  --eh-radius-lg: 12px;
  --eh-radius-xl: 18px;
  --eh-radius-pill: 9999px;

  /* ── Typography ───────────────────────────────────────────────── */
  --eh-font-sans:
    "Inter", "SF Pro Display", -apple-system, BlinkMacSystemFont,
    "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  --eh-font-mono:
    "JetBrains Mono", "SF Mono", Menlo, Monaco, Consolas,
    "Liberation Mono", "Courier New", monospace;

  --eh-text-xs: 11px;
  --eh-text-sm: 13px;
  --eh-text-md: 15px;
  --eh-text-lg: 18px;
  --eh-text-xl: 22px;
  --eh-text-2xl: 28px;
  --eh-text-3xl: 30px;
  --eh-text-4xl: 38px;
  --eh-text-hero: 44px;

  --eh-leading-tight: 1.2;
  --eh-leading-snug: 1.35;
  --eh-leading-normal: 1.55;
  --eh-leading-relaxed: 1.7;

  --eh-tracking-tight: -0.02em;
  --eh-tracking-normal: 0;
  --eh-tracking-wide: 0.04em;
  --eh-tracking-widest: 0.16em;

  /* ── Motion ───────────────────────────────────────────────────── */
  --eh-easing: cubic-bezier(0.22, 1, 0.36, 1);
  --eh-easing-in: cubic-bezier(0.55, 0, 0.85, 0);
  --eh-easing-bounce: cubic-bezier(0.34, 1.56, 0.64, 1);
  --eh-easing-linear: linear;

  --eh-dur-instant: 80ms;
  --eh-dur-fast: 160ms;
  --eh-dur-base: 280ms;
  --eh-dur-slow: 480ms;
  --eh-dur-deliberate: 720ms;
  /* Orbit speeds tuned so motion is *clearly* visible at a glance.
     20s orbit reads as static for the first few seconds — bump to
     ~12s/7s so the user immediately sees the disk turning. */
  --eh-dur-warp: 4500ms;
  --eh-dur-orbit: 12000ms;
  --eh-dur-orbit-fast: 7000ms;
  /* Ambient timers for the RASTER mark, which needs a different order of
     magnitude from the SVG above. That logo is radially even, so a 12s orbit
     reads as a turning disk; the artwork has a bright crescent and a star
     flare, and any landmark turning that fast reads as a loading spinner
     instead. A spinner is ~1s per revolution, so drift sits sixty times
     slower — visibly alive over a glance, never busy. */
  --eh-dur-drift: 60000ms;
  --eh-dur-breathe: 9000ms;

  /* ── Layout ───────────────────────────────────────────────────── */
  --eh-max-content: 1280px;
  --eh-nav-height: 56px;
  --eh-page-padding: var(--eh-sp-6);

  /* ── Z-index ──────────────────────────────────────────────────── */
  --eh-z-base: 0;
  --eh-z-raised: 10;
  --eh-z-nav: 50;
  --eh-z-overlay: 100;
  --eh-z-modal: 1000;
  --eh-z-toast: 2000;
}

/* Honor user preference: kill ambient motion + dampen entrance
   animations to a quick fade. Keep glows + colors intact.

   The first block rewrites our token vars (the path most of our
   components use). The second block is a universal safety net for
   ANY rule that hardcodes a duration in ms/s — we cap iterations at
   1 and slam duration to ~0 so a future component that forgets to
   use a token still respects the user's preference. */
@media (prefers-reduced-motion: reduce) {
  :root {
    --eh-dur-warp: 0s;
    --eh-dur-orbit: 0s;
    --eh-dur-orbit-fast: 0s;
    --eh-dur-drift: 0s;
    --eh-dur-breathe: 0s;
    --eh-dur-deliberate: var(--eh-dur-fast);
    --eh-dur-slow: var(--eh-dur-fast);
    --eh-dur-base: var(--eh-dur-fast);
  }

  /* Universal clamp. Anything in the EH UI that opted into an
     animation gets one quick frame; ambient loops collapse to a
     single iteration. We deliberately scope to .eh-* so we don't
     fight Vortex's own UI animations outside the extension. */
  [class*="eh-"],
  [class*="eh-"] *,
  [class*="eh-"]::before,
  [class*="eh-"]::after {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
    scroll-behavior: auto !important;
  }
}
`;
