/**
 * Event Horizon keyframe library.
 *
 * Every animation in the app pulls from this file. Naming convention:
 *  - `eh-rotate-*`      : continuous rotation (logo, orbit decorations)
 *  - `eh-pulse-*`       : breathing scale/opacity loops
 *  - `eh-fade-*`        : entrance / exit transitions (used with
 *                         animation-fill-mode: both)
 *  - `eh-shimmer-*`     : translate-based gradient sweeps
 *  - `eh-warp-*`        : the signature "lensing pulse" — scale + blur
 *
 * All entrance keyframes start at 0 opacity and translate from a
 * direction; pair with `animation-fill-mode: both` so they hold their
 * end state after running.
 */

export const KEYFRAMES_CSS = `
@keyframes eh-rotate-cw {
  from { transform: rotate(0deg); }
  to   { transform: rotate(360deg); }
}

@keyframes eh-rotate-ccw {
  from { transform: rotate(360deg); }
  to   { transform: rotate(0deg); }
}

@keyframes eh-pulse-scale {
  0%, 100% { transform: scale(1); }
  50%      { transform: scale(1.04); }
}

@keyframes eh-pulse-opacity {
  0%, 100% { opacity: 0.55; }
  50%      { opacity: 1; }
}

@keyframes eh-pulse-glow {
  0%, 100% { filter: brightness(1) drop-shadow(0 0 8px rgba(255, 107, 61, 0.35)); }
  50%      { filter: brightness(1.15) drop-shadow(0 0 24px rgba(255, 107, 61, 0.6)); }
}

/* The raster mark's ambient loop: a small scale swell with the glow rising
   to meet it, so the two read as one breath rather than two effects. Scale
   tops out at 1.028 — enough to notice at 120px, small enough that it never
   nudges the layout around it. */
@keyframes eh-mark-breathe {
  0%, 100% {
    transform: scale(1);
    filter: drop-shadow(0 0 14px rgba(240, 56, 107, 0.22));
  }
  50% {
    transform: scale(1.028);
    filter: drop-shadow(0 0 26px rgba(240, 56, 107, 0.4));
  }
}
@keyframes eh-warp-pulse {
  0%, 88%, 100% {
    transform: scale(1);
    filter: blur(0);
  }
  92% {
    transform: scale(1.025);
    filter: blur(0.5px);
  }
  96% {
    transform: scale(0.995);
    filter: blur(0);
  }
}

@keyframes eh-shimmer-x {
  0%   { transform: translateX(-100%); }
  100% { transform: translateX(100%); }
}

@keyframes eh-fade-in {
  from { opacity: 0; }
  to   { opacity: 1; }
}

@keyframes eh-fade-up {
  from {
    opacity: 0;
    transform: translateY(16px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

@keyframes eh-fade-down {
  from {
    opacity: 0;
    transform: translateY(-16px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

@keyframes eh-fade-scale {
  from {
    opacity: 0;
    transform: scale(0.94);
  }
  to {
    opacity: 1;
    transform: scale(1);
  }
}

@keyframes eh-text-reveal {
  from {
    opacity: 0;
    transform: translateY(8px);
    filter: blur(6px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
    filter: blur(0);
  }
}

@keyframes eh-doppler-sweep {
  0% {
    opacity: 0;
    transform: rotate(0deg);
  }
  20% { opacity: 0.9; }
  80% { opacity: 0.9; }
  100% {
    opacity: 0;
    transform: rotate(360deg);
  }
}

@keyframes eh-orbit {
  from {
    transform: rotate(0deg) translateX(var(--eh-orbit-radius, 24px)) rotate(0deg);
  }
  to {
    transform: rotate(360deg) translateX(var(--eh-orbit-radius, 24px)) rotate(-360deg);
  }
}


@keyframes eh-progress-indeterminate {
  0%   { transform: translateX(-100%) scaleX(0.4); }
  50%  { transform: translateX(0%) scaleX(0.6); }
  100% { transform: translateX(100%) scaleX(0.4); }
}

/* Hash-scanner: a perpetually moving "lensing" sweep used to convey
   liveness during slow hashing passes (where determinate progress
   only ticks every few hundred ms / per-mod). Decoupled from progress
   so the user always sees motion. */
@keyframes eh-scanner-sweep {
  0%   { transform: translateX(-30%); }
  100% { transform: translateX(130%); }
}

/* Soft pulse used by hashing card to show the panel itself is "alive"
   even when the underlying numbers don't change. */
  50% {
    box-shadow:
      0 0 0 4px rgba(76, 201, 240, 0.10),
      var(--eh-shadow-card);
  }
}

@keyframes eh-spinner {
  from { transform: rotate(0deg); }
  to   { transform: rotate(360deg); }
}

@keyframes eh-slide-in-right {
  from {
    opacity: 0;
    transform: translateX(24px);
  }
  to {
    opacity: 1;
    transform: translateX(0);
  }
}
`;
