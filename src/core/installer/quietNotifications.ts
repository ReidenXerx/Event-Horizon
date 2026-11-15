/**
 * ──────────────────────────────────────────────────────────────────────
 * Clear away prompts that are wrong to answer while we are driving.
 *
 * Installing a 967-mod collection makes Vortex raise one
 * "The mod X contains multiple plugins" notification per multi-plugin mod,
 * each offering [b]Show[/b] and [b]Enable all[/b]. A tester's screen filled
 * with them.
 *
 * ─── THIS IS NOT ABOUT TIDINESS ────────────────────────────────────────
 * "Enable all" is not merely noise during a collection install — it is the
 * wrong answer. The collection records exactly which plugins the curator had
 * enabled, and the driver applies that at the end. A user who works through
 * the notifications clicking "Enable all" turns plugins on that the curator
 * deliberately left off, and every file still verifies: the reproduction is
 * broken in the one way nothing downstream can detect.
 *
 * The people most likely to click them are the people least able to judge
 * that, which is what makes it worth handling rather than documenting.
 *
 * ─── PRECEDENT: VORTEX DOES EXACTLY THIS ───────────────────────────────
 * Its own collection post-processing carries the same code and the same
 * reason, verbatim from the shipped bundle:
 *
 *     // dismiss all "mod x contains multiple plugins" notifications because
 *     // we're enabling plugins automatically.
 *     state.session.notifications.notifications
 *       .filter((noti) => noti.id.startsWith("multiple-plugins-"))
 *       .forEach((noti) => api.dismissNotification(noti.id));
 *
 * So this is not a liberty taken with someone else's UI; it is the behaviour
 * Vortex already applies when a collection sets plugin enablement for the
 * user, which is precisely what we do.
 *
 * ─── AND IT STAYS NARROW ───────────────────────────────────────────────
 * Two ids, and only while the driver runs. Not a notification filter, not a
 * suppression setting, nothing that outlives the install, and nothing that
 * touches an error or a warning. Vortex's own comment concedes the
 * string-match may catch a notification from a mod outside the collection;
 * that is true here too.
 *
 * "Ready to install" was added on 2026-09-18. Vortex posts it when a download
 * finishes and the player has "Install mods when downloaded" off, and its
 * action is "Install All" — which installs THIS archive, the one the driver is
 * already installing, plus every other finished download in the list. Pressed
 * mid-install that is a second copy of a mod the driver just placed, and
 * Vortex meets the second one with "replace, or install as a variant?", the
 * modal nothing can pre-answer. A tester spent a whole run clicking these
 * because the driver used to depend on that setting; it no longer does (see
 * installNexusViaApi), so the prompt is now both wrong and unnecessary.
 *
 * "Deployment necessary" was added on 2026-09-15, after players on the Ivy
 * page answered Vortex mid-install. It offers Deploy, and a deploy the player
 * clicks mid-install is a wrong result: after the driver's purge before the
 * mirror it links half-mirrored mods and brings back Vortex's External Changes
 * dialog, where "Revert" undoes the mirror; earlier, it changes what the
 * installers still to come see. Vortex holds the same prompt back during its
 * own collection installs. The cost: Vortex raises it again only when its
 * "needs deploy" flag changes, so a run that ends before its own deploy has
 * to say so itself, and the install session does.
 * ──────────────────────────────────────────────────────────────────────
 */

import type { types } from "@nexusmods/vortex-api";

/**
 * Notification ids (prefixes) cleared while the driver runs.
 *
 * Deliberately short. Every entry needs the same argument the first one has:
 * that answering it during a driven install produces a WRONG result, not
 * merely an interruption. The arguments are in the header above.
 */
export const DRIVEN_INSTALL_NOISE = [
  "multiple-plugins-",
  "deployment-necessary",
  "ready-to-install-",
] as const;

/** Is this notification one we clear during an install? */
export function isNoisyDuringInstall(id: unknown): boolean {
  return (
    typeof id === "string" &&
    DRIVEN_INSTALL_NOISE.some((prefix) => id.startsWith(prefix))
  );
}

/**
 * The ids to dismiss, read out of Vortex's session state.
 *
 * Pure and separately testable: the selector is where a wrong answer would be
 * silent, and a shape we do not recognise must yield an empty list rather than
 * throw inside an install that is otherwise fine.
 */
export function selectNoisyNotificationIds(state: unknown): string[] {
  const list = (
    state as {
      session?: { notifications?: { notifications?: unknown } };
    }
  )?.session?.notifications?.notifications;
  if (!Array.isArray(list)) return [];
  const out: string[] = [];
  for (const n of list) {
    const id = (n as { id?: unknown })?.id;
    if (isNoisyDuringInstall(id)) out.push(id as string);
  }
  return out;
}

/**
 * ─── A REFUSAL THE RETRY PASS UNDID ────────────────────────────────────
 * Vortex reports a FOMOD that refuses ("Installer Prerequisits not
 * fulfilled: File 'anatomy.esp' is Active") with an error notification,
 * title "Installer reported errors", message = the attempt's mod id, and an
 * id it generates itself (shortid). The retry pass then installs the same
 * mod once its prerequisite is active — and the red notification stays,
 * telling the player a mod failed that is installed (Ivy Rev 29: Rapport,
 * Overture, Chemistry on EH 0.2.128).
 *
 * The ids are random, so they are attributed by DIFFERENCE: the ones present
 * after a failed attempt and not before it belong to that attempt. Only those
 * are dismissed, and only once the retry put that mod on disk; a mod that
 * fails again keeps its notification.
 */
export const INSTALLER_ERRORS_TITLE = "Installer reported errors";

/** Ids of Vortex's "Installer reported errors" notifications. Never throws. */
export function installerErrorNoticeIds(api: types.IExtensionApi): Set<string> {
  try {
    const list = (
      api.getState() as unknown as {
        session?: { notifications?: { notifications?: unknown } };
      }
    )?.session?.notifications?.notifications;
    if (!Array.isArray(list)) return new Set();
    const out = new Set<string>();
    for (const n of list) {
      const { id, title } = (n ?? {}) as { id?: unknown; title?: unknown };
      if (typeof id === "string" && title === INSTALLER_ERRORS_TITLE) out.add(id);
    }
    return out;
  } catch {
    return new Set();
  }
}

/** Ids in `after` that were not in `before`: what one attempt raised. */
export function noticesRaisedSince(before: ReadonlySet<string>, after: ReadonlySet<string>): string[] {
  return [...after].filter((id) => !before.has(id));
}

/** Dismiss the given ids. Returns how many were dismissed. Never throws. */
export function dismissNotices(api: types.IExtensionApi, ids: readonly string[]): number {
  try {
    const dismiss = api.dismissNotification;
    if (typeof dismiss !== "function") return 0;
    for (const id of ids) dismiss(id);
    return ids.length;
  } catch {
    return 0;
  }
}

/**
 * Clear them. Returns how many were dismissed. Never throws.
 *
 * Called repeatedly through a long install rather than once at the end,
 * because the point is that the user is not staring at a growing wall of
 * prompts for the hour it runs — dismissing them all afterwards would tidy the
 * screen only once the damage was available to be done.
 */
export function dismissNoisyNotifications(api: types.IExtensionApi): number {
  try {
    const dismiss = api.dismissNotification;
    if (typeof dismiss !== "function") return 0;
    const ids = selectNoisyNotificationIds(api.getState());
    for (const id of ids) dismiss(id);
    return ids.length;
  } catch {
    // Cosmetic work on someone else's UI must never be able to fail an
    // install that is otherwise going fine.
    return 0;
  }
}
