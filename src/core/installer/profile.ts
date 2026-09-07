/**
 * Vortex profile lifecycle helpers — Phase 3 slice 6.
 *
 * The driver isolates fresh-profile installs by creating a brand-new
 * Vortex profile, switching into it, and only enabling collection mods
 * there. The user's other profiles are never touched.
 *
 * Spec: docs/business/INSTALL_DRIVER.md (§ Profile lifecycle)
 *
 * ─── DESIGN NOTES ──────────────────────────────────────────────────────
 *  • Profile ids are random UUIDs. Vortex doesn't enforce any specific
 *    format — it uses `shortid` internally but treats the id as opaque.
 *    Crypto-strong UUIDs avoid collision worries entirely.
 *
 *  • `setNextProfile` is the *only* way to switch profiles cleanly.
 *    Vortex listens for the dispatch and runs full activation
 *    (purge → switch → activate). The handler is async; we wait for the
 *    canonical `profile-did-change` event documented in
 *    https://github.com/Nexus-Mods/vortex-api/blob/master/docs/EVENTS.md.
 *
 *  • Name collision handling is best-effort. If "Event Horizon — Foo"
 *    already exists we append " (2)", " (3)", etc. The user can rename
 *    later in Vortex's UI; the driver never blocks on this.
 * ──────────────────────────────────────────────────────────────────────
 */

import { randomBytes, randomUUID } from "crypto";
import { actions, types } from "@nexusmods/vortex-api";

import { looksLikeWine } from "./checkSevenZipHealth";
import { countMods, profileSwitchBudgetMs } from "./timeBudgets";

/**
 * Create a brand-new, empty Vortex profile and dispatch it into the
 * Redux store. The profile is created BUT NOT switched into — the
 * caller drives the switch via {@link switchToProfile}.
 *
 * @returns the profile descriptor that was created.
 */
export function createFreshProfile(
  api: types.IExtensionApi,
  gameId: string,
  suggestedName: string,
): { id: string; name: string } {
  const state = api.getState();
  const finalName = pickNonCollidingName(state, gameId, suggestedName);
  const id = randomUUID();

  const profile: types.IProfile = {
    id,
    gameId,
    name: finalName,
    modState: {},
    lastActivated: 0,
  };

  api.store?.dispatch(actions.setProfile(profile));

  return { id, name: finalName };
}

/**
 * Dispatch a profile switch and wait for Vortex to finish activating
 * the new profile (deployments purged + new profile applied).
 *
 * Cancellation:
 *  - If `signal` aborts before Vortex emits `profile-did-change`,
 *    the promise rejects with an `AbortError` immediately rather
 *    than waiting out the switch budget. Vortex's setNextProfile
 *    dispatch has already been issued at that point and we cannot
 *    cancel the underlying switch — but we *can* stop blocking the
 *    install driver, which is the part the user pays attention to.
 *    {@link runInstall} re-checks `state.settings.profiles.activeProfileId`
 *    in its abort-cleanup path so the eventual completion of the
 *    switch is reconciled with whatever profile state actually exists.
 *
 * @throws if the switch doesn't complete within
 *   {@link profileSwitchBudgetMs} (usually means Vortex hit a
 *   deployment lock the user must resolve manually) or if `signal`
 *   aborts.
 */
export async function switchToProfile(
  api: types.IExtensionApi,
  profileId: string,
  signal?: AbortSignal,
): Promise<void> {
  const state = api.getState();
  const currentProfileId =
    state.settings?.profiles?.activeProfileId ?? state.settings?.profiles?.nextProfileId;

  if (currentProfileId === profileId) {
    return; // already active — no-op
  }

  // Pre-check abort before we even dispatch — saves a wasted round-trip.
  if (signal?.aborted) {
    throw makeAbortError("profile switch");
  }

  // A profile carries every mod's enabled state, so the switch scales with
  // the collection; under Wine it scales again. Like the deploy ceiling this
  // is a race against `profile-did-change`, so a larger budget costs nothing
  // when the switch is quick — it only delays giving up on a stuck one.
  const budgetMs = profileSwitchBudgetMs(countMods(state), {
    wine: looksLikeWine(),
  });

  await new Promise<void>((resolve, reject) => {
    let settled = false;
    let onAbort: (() => void) | undefined;

    const finalize = (): void => {
      api.events.removeListener("profile-did-change", onChange);
      clearTimeout(timeout);
      if (onAbort && signal) {
        signal.removeEventListener("abort", onAbort);
      }
    };

    const timeout = setTimeout(() => {
      if (settled) return;

      // Belt-and-braces: state is the source of truth for "current
      // profile", and the event channel can be out of order with it
      // (Vortex emits profile-did-change AFTER the dispatch is fully
      // applied, but a listener that registered too late or got
      // replaced can miss it). Re-read state directly before
      // declaring a failure — if Vortex has already switched, treat
      // it as success.
      const finalState = api.getState();
      const finalActiveId =
        finalState.settings?.profiles?.activeProfileId ??
        finalState.settings?.profiles?.nextProfileId;
      if (finalActiveId === profileId) {
        settled = true;
        finalize();
        resolve();
        return;
      }

      settled = true;
      finalize();
      reject(
        new Error(
          `Profile switch to "${profileId}" did not complete within ` +
            `${Math.round(budgetMs / 1000)}s. Check Vortex's notifications for ` +
            `a stuck deployment.`,
        ),
      );
    }, budgetMs);

    const onChange = (newProfileId: string): void => {
      if (newProfileId !== profileId || settled) return;
      settled = true;
      finalize();
      resolve();
    };

    api.events.on("profile-did-change", onChange);

    if (signal) {
      onAbort = (): void => {
        if (settled) return;
        settled = true;
        finalize();
        reject(makeAbortError("profile switch"));
      };
      signal.addEventListener("abort", onAbort);
    }

    api.store?.dispatch(actions.setNextProfile(profileId));
  });
}

/**
 * AbortError that matches the DOM AbortError shape (name === "AbortError")
 * so it survives the same `err.name === "AbortError"` checks the rest of
 * the codebase uses (see useErrorReporter, runInstall.checkAbort).
 */
function makeAbortError(operation: string): Error {
  const err = new Error(`${operation} aborted by user`);
  err.name = "AbortError";
  return err;
}

/**
 * Enable a mod inside a specific profile. Pure dispatch; does NOT
 * trigger deploy on its own (driver batches enables, then deploys
 * once at the end of the install).
 */
export function enableModInProfile(
  api: types.IExtensionApi,
  profileId: string,
  modId: string,
): void {
  api.store?.dispatch(actions.setModEnabled(profileId, modId, true));
}

// ===========================================================================
// Helpers
// ===========================================================================

/**
 * Walk the existing profile list for `gameId` and pick a name that
 * doesn't collide. Appends `" (2)"`, `" (3)"`, … until unique.
 *
 * The numeric suffix probe is bounded at {@link COLLIDING_NAME_PROBE_LIMIT}
 * to keep this O(1) for pathological state (a corrupted profile store
 * with thousands of name-conflicting entries shouldn't make profile
 * creation linear). After the probe limit we fall back to a
 * cryptographically-random hex suffix that's collision-resistant by
 * construction (4 bytes = 1 in 4 billion, so we'd need a profile
 * store with billions of EH-named profiles for a second collision —
 * not a real-world concern).
 */
export function pickNonCollidingName(
  state: types.IState,
  gameId: string,
  base: string,
): string {
  const profiles = state.persistent?.profiles ?? {};

  const existingNames = new Set<string>(
    Object.values(profiles)
      .filter((p): p is types.IProfile => Boolean(p) && p.gameId === gameId)
      .map((p) => p.name),
  );

  if (!existingNames.has(base)) return base;

  for (let suffix = 2; suffix < COLLIDING_NAME_PROBE_LIMIT; suffix++) {
    const candidate = `${base} (${suffix})`;
    if (!existingNames.has(candidate)) return candidate;
  }

  // Fallback — only reached if the user has 1000+ EH-prefixed profiles
  // with sequential collision suffixes (extreme corruption / abuse).
  // Cryptographic random suffix instead of Date.now() so two callers
  // running in the same millisecond don't collide on the fallback.
  const suffix = randomBytes(4).toString("hex");
  return `${base} (${suffix})`;
}

const COLLIDING_NAME_PROBE_LIMIT = 1000;

/**
 * Turn a mod OFF in one specific profile.
 *
 * The mirror of {@link enableModInProfile}, and the reason it exists is the
 * alongside install: when the curator's copy of a mod goes in beside the
 * user's, exactly one of the two should be active in the collection's profile.
 *
 * Profile-scoped by construction — `setModEnabled` takes a profile id — so the
 * user's other profiles keep the mod enabled exactly as they left it. This is
 * NOT an uninstall and must never be used as a substitute for one.
 */
export function disableModInProfile(
  api: types.IExtensionApi,
  profileId: string,
  modId: string,
): void {
  api.store?.dispatch(actions.setModEnabled(profileId, modId, false));
}
