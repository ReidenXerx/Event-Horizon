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

import { ehLog } from "../logging/ehLog";
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

  /**
   * `api.store` is optional on Vortex's own typings, and `?.` turns a missing
   * store into a SILENT no-op that returns a profile id nothing was ever
   * created under. Every later step then addresses a profile that does not
   * exist, which is indistinguishable from "Vortex forgot the profile".
   */
  const dispatched = api.store !== undefined;
  api.store?.dispatch(actions.setProfile(profile));

  // "Event Horizon made a new profile and went there" was a real report, and
  // nothing in the log said which profile, under what name, or whether the
  // name it wanted was already taken. All three are here now.
  ehLog(dispatched ? "info" : "error", "profile.created", {
    id,
    name: finalName,
    suggestedName,
    // A renamed profile means one with the wanted name ALREADY EXISTED, which
    // is usually a previous install of the same collection.
    nameCollided: finalName !== suggestedName,
    gameId,
    dispatched,
    ...(dispatched
      ? {}
      : { consequence: "no Vortex store - the profile was NOT created" }),
  });

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
    // Not silent: "we never switched" and "we switched instantly" look the
    // same in a log that says nothing, and only one of them is a bug.
    ehLog("info", "profile.switch.skipped", {
      profileId,
      reason: "already active",
    });
    return;
  }

  // Pre-check abort before we even dispatch — saves a wasted round-trip.
  if (signal?.aborted) {
    throw makeAbortError("profile switch");
  }

  // A profile carries every mod's enabled state, so the switch scales with
  // the collection; under Wine it scales again. Like the deploy ceiling this
  // is a race against `profile-did-change`, so a larger budget costs nothing
  // when the switch is quick — it only delays giving up on a stuck one.
  const modCount = countMods(state);
  const wine = looksLikeWine();
  const budgetMs = profileSwitchBudgetMs(modCount, { wine });

  // The timeout message a user pastes says only "did not complete within Ns".
  // These are the numbers that decide whether N was ever going to be enough.
  ehLog("info", "profile.switch.start", {
    from: currentProfileId ?? "none",
    to: profileId,
    budgetMs,
    modCount,
    wine,
  });

  const startedAt = Date.now();
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
        // The switch DID happen; we only missed the event. Worth a line - a
        // run that reaches here is one listener away from a false timeout.
        ehLog("warn", "profile.switch.ok-via-state", {
          to: profileId,
          ms: Date.now() - startedAt,
          budgetMs,
          note:
            "budget expired but Vortex state shows the switch completed; " +
            "the profile-did-change event was missed",
        });
        settled = true;
        finalize();
        resolve();
        return;
      }

      // The failure the tester actually hit. Everything needed to tell "Vortex
      // was stuck" from "we gave up too early" from "it went somewhere else".
      ehLog("error", "profile.switch.timeout", {
        from: currentProfileId ?? "none",
        to: profileId,
        activeNow: finalActiveId ?? "none",
        budgetMs,
        modCount,
        wine,
        // A different id here is the whole answer: the switch worked, just not
        // to us - something else redirected it.
        switchedElsewhere:
          finalActiveId !== undefined && finalActiveId !== profileId,
      });

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
      if (newProfileId !== profileId) {
        // Vortex switched to a profile that is not ours while we were waiting
        // for ours. We keep waiting (it may still arrive), but this is the
        // single most useful line for "why did it end up in another profile".
        if (!settled) {
          ehLog("warn", "profile.switch.other-profile-activated", {
            waitingFor: profileId,
            activated: newProfileId,
            ms: Date.now() - startedAt,
          });
        }
        return;
      }
      if (settled) return;
      settled = true;
      finalize();
      ehLog("info", "profile.switch.ok", {
        to: profileId,
        ms: Date.now() - startedAt,
        budgetMs,
      });
      resolve();
    };

    api.events.on("profile-did-change", onChange);

    if (signal) {
      onAbort = (): void => {
        if (settled) return;
        settled = true;
        finalize();
        // Vortex's switch is already in flight and cannot be recalled; we stop
        // waiting on it. Which profile ends up active is then decided by
        // Vortex, not us, and that is worth having written down.
        ehLog("warn", "profile.switch.aborted", {
          to: profileId,
          ms: Date.now() - startedAt,
          note:
            "Vortex's switch was already dispatched and continues in the " +
            "background",
        });
        reject(makeAbortError("profile switch"));
      };
      signal.addEventListener("abort", onAbort);
    }

    if (api.store === undefined) {
      // Without this the promise simply waits out the full budget and reports
      // a timeout, blaming Vortex for a switch that was never dispatched.
      ehLog("error", "profile.switch.no-store", {
        to: profileId,
        consequence: "the switch was never dispatched; this will time out",
      });
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
  if (api.store === undefined) {
    // "EH installed the mods but they are all still disabled" was a real
    // report. If the store is missing, this call is a no-op for EVERY mod and
    // that is exactly what the user sees - so it must not be silent.
    ehLog("error", "profile.enable.no-store", {
      profileId,
      modId,
      consequence: "the mod was NOT enabled",
    });
    return;
  }
  api.store.dispatch(actions.setModEnabled(profileId, modId, true));
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
  if (api.store === undefined) {
    // The alongside install depends on this: without it BOTH copies of the
    // mod stay enabled and they fight over the same files.
    ehLog("error", "profile.disable.no-store", {
      profileId,
      modId,
      consequence: "the mod was NOT disabled",
    });
    return;
  }
  api.store.dispatch(actions.setModEnabled(profileId, modId, false));
}
