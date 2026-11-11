/**
 * ──────────────────────────────────────────────────────────────────────
 * Let a game activation settle before an agent installs.
 *
 * Activating a game (a profile or game switch, or Vortex starting) makes
 * Vortex run refreshMods some seconds later: it compares the staging folder's
 * names (".installing" stripped) against the mods in its state. An install
 * that started in between has a folder whose mod Vortex has not added yet
 * (it adds it after the installer runs), so refreshMods lists it as "Mods
 * changed on disk", and that dialog quits Vortex on anything but "Apply
 * Changes" (read in app.asar). SMIM, 11-11: activation 20:48:24, install
 * 20:48:30, refresh 20:48:39, dialog left open in front of the owner.
 * ──────────────────────────────────────────────────────────────────────
 */

import type { types } from "@nexusmods/vortex-api";

import { ehLog } from "../logging/ehLog";

/** Measured 15 s on a healthy Vortex; a busy one is slower. */
export const ACTIVATION_SETTLE_MS = 45_000;

let lastActivation = 0;
let hooked = false;

/** Once per Vortex session: remember when a game was last activated. */
export function watchGameActivation(api: types.IExtensionApi): void {
  if (hooked) return;
  hooked = true;
  api.events.on("gamemode-activated", () => {
    lastActivation = Date.now();
  });
}

/** How long to wait still; 0 when no activation is recent. */
export function settleWaitMs(now: number, last: number, settleMs: number = ACTIVATION_SETTLE_MS): number {
  return last <= 0 ? 0 : Math.max(0, last + settleMs - now);
}

/** Waits out a recent activation; returns the milliseconds waited. */
export async function waitForActivationToSettle(verb: string): Promise<number> {
  const wait = settleWaitMs(Date.now(), lastActivation);
  if (wait <= 0) return 0;
  ehLog("info", "control.activation-settle.wait", { verb, waitMs: wait });
  await new Promise<void>((resolve) => setTimeout(resolve, wait));
  return wait;
}

/** Tests only. */
export function _setLastActivationForTest(ms: number): void {
  lastActivation = ms;
}
