/**
 * Canonical filesystem roots for Event Horizon data.
 *
 * ─── THE TRAP THIS FILE EXISTS TO CLOSE ───────────────────────────────
 * Vortex exposes BOTH `appData` and `userData` via `util.getVortexPath`,
 * and they are not the same directory. They follow Electron's meanings:
 *
 *   getVortexPath("appData")  → %APPDATA%          (…/AppData/Roaming)
 *   getVortexPath("userData") → %APPDATA%/Vortex   (Vortex's own data dir)
 *
 * Every Event Horizon write used `appData` and then joined "event-horizon",
 * which put snapshots, diffs, packages and install receipts in
 * `%APPDATA%/event-horizon/` — a sibling of Vortex, not inside it. It
 * "worked" because reads used the same wrong root, so nothing ever failed;
 * it just littered the user's Roaming directory with data that Vortex would
 * never clean up and that no support request would think to look for.
 *
 * `draftStorage` had it right by accident, compensating with an explicit
 * `"Vortex"` path segment. That compensation is removed now that the root
 * is correct — keeping both would produce `%APPDATA%/Vortex/Vortex/…`.
 *
 * Rule: **nothing outside this file may call `getVortexPath("appData")`**
 * to locate Event Horizon data. Go through `getEventHorizonRoot()` or take
 * the root as a parameter.
 * ──────────────────────────────────────────────────────────────────────
 */

import { util } from "@nexusmods/vortex-api";
import * as path from "path";

/**
 * Vortex's per-user data directory — `%APPDATA%/Vortex` on Windows.
 *
 * This is the parent that every Event Horizon subdirectory hangs off. Call
 * sites historically named this `appDataPath`; the name is kept where it is
 * threaded through existing signatures to keep this change mechanical, but
 * the VALUE is now Vortex's userData, which is what those joins always meant.
 */
export function getVortexUserDataPath(): string {
  return util.getVortexPath("userData");
}

/** `%APPDATA%/Vortex/event-horizon` — the root of everything this extension writes. */
export function getEventHorizonRoot(): string {
  return path.join(getVortexUserDataPath(), "event-horizon");
}

/**
 * Subdirectory under the Event Horizon root.
 *
 * Named subdirs in use: `exports`, `diffs`, `plugin-diffs`, `collections`,
 * `drafts`, `installs`, `logs`.
 */
export function getEventHorizonDir(...segments: string[]): string {
  return path.join(getEventHorizonRoot(), ...segments);
}

/**
 * `%APPDATA%/Vortex/event-horizon/collections` — where built `.ehcoll`
 * packages land.
 *
 * Named rather than left as `getEventHorizonDir("collections")` at each call
 * site because five places were joining these segments independently, and one
 * of them was a button that opens the folder. A path that drifts is bad; a
 * button that confidently opens the *old* one is worse.
 */
export function getCollectionsDir(): string {
  return getEventHorizonDir("collections");
}

/** Per-collection config lives in a dot-directory beside the packages. */
export function getCollectionsConfigDir(): string {
  return path.join(getCollectionsDir(), ".config");
}
