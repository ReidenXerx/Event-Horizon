/**
 * ──────────────────────────────────────────────────────────────────────
 * The owner's click before an agent destroys anything (owner poll, 2026-09-30).
 *
 * An agent is told to ask before removing mods or purging, and a capable one
 * does. A hurried one does not, and "the agent was told to" is no comfort to a
 * player whose mod list is gone. So the command itself stops: Vortex shows
 * what exactly is about to happen, and only the person at the machine can
 * press Allow. No verb answers this dialog — the channel's dialog watcher
 * answers only the install dialogs it was told about, by their exact text.
 *
 * NS-2 is the reason for mods.remove in particular: most of a pool is mods
 * Event Horizon did not install, and the player's own click is the only
 * thing that may stand in for "the player chose this".
 *
 * On the Agents page the owner can turn the question off ("askFirst"), for
 * their own unattended agents. Off is a choice, never a default.
 * ──────────────────────────────────────────────────────────────────────
 */

import type { types } from "@nexusmods/vortex-api";

import { ehLog } from "../logging/ehLog";
import { loadPreferences } from "../preferences";
import { ControlError } from "./controlError";

export const CONSENT_TITLE_PREFIX = "An agent wants to";
export const ALLOW = "Allow";
export const DENY = "Deny";
/** Nobody answered: the command is refused, and the queue behind it moves on. */
export let CONSENT_TIMEOUT_MS = 10 * 60 * 1000;

export function setConsentTimeoutForTests(ms: number): void {
  CONSENT_TIMEOUT_MS = ms;
}

export type ConsentRequest = {
  /** Short, after "An agent wants to": "remove 3 mods". */
  action: string;
  /**
   * `replace-install`: the one question the owner may switch off on its own
   * ("Auto-allow agent replace installs", owner 2026-10-07). Every other
   * request always asks while askFirst is on.
   */
  kind?: "replace-install";
  /** Exactly what will happen, one line each: mod names, folders. */
  lines: string[];
  /** What cannot be undone, in one sentence. */
  consequence: string;
};

const SHOWN = 25;

/** Asks the person at the machine. Resolves on Allow; throws owner-denied / owner-no-answer otherwise. */
export async function askOwner(api: types.IExtensionApi, req: ConsentRequest): Promise<{ asked: boolean }> {
  const prefs = loadPreferences().controlChannel;
  if (!prefs.askFirst) {
    ehLog("info", "control.consent.skipped", { action: req.action, reason: "askFirst off" });
    return { asked: false };
  }
  if (req.kind === "replace-install" && prefs.autoAllowReplace) {
    // Logged with what was replaced: the recent-operations entry records the
    // install itself, this records that nobody was asked.
    ehLog("info", "control.consent.auto-allowed", {
      action: req.action,
      lines: req.lines.slice(0, SHOWN),
      reason: "auto-allow replace installs is on",
    });
    return { asked: false };
  }
  if (api.showDialog === undefined) {
    throw new ControlError("owner-no-answer", "Vortex cannot show the confirmation, so nothing was changed.", 409);
  }
  const title = `${CONSENT_TITLE_PREFIX} ${req.action}`;
  const shown = req.lines.slice(0, SHOWN);
  const text =
    `${shown.map((l) => `• ${l}`).join("\n")}` +
    (req.lines.length > SHOWN ? `\n• …and ${req.lines.length - SHOWN} more` : "") +
    `\n\n${req.consequence}\n\nAllow only if you asked your agent for this.`;
  ehLog("info", "control.consent.ask", { action: req.action, count: req.lines.length });

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), CONSENT_TIMEOUT_MS);
  });
  const answered = api
    .showDialog("question", title, { text }, [{ label: DENY }, { label: ALLOW }])
    .then((r: { action?: string } | undefined) => r?.action);
  const outcome = await Promise.race([answered, timedOut]);
  if (timer !== undefined) clearTimeout(timer);

  if (outcome === "timeout") {
    dismissConsent(api, title);
    ehLog("warn", "control.consent.timeout", { action: req.action });
    throw new ControlError(
      "owner-no-answer",
      `Nobody answered Vortex's confirmation within ${Math.round(CONSENT_TIMEOUT_MS / 60000)} minutes, so nothing was changed. ` +
        "Ask the user to be at the PC, then send the command again.",
      409,
    );
  }
  if (outcome !== ALLOW) {
    ehLog("info", "control.consent.denied", { action: req.action });
    throw new ControlError(
      "owner-denied",
      "The user pressed Deny in Vortex, so nothing was changed. Do not send it again unless they ask you to.",
      403,
    );
  }
  ehLog("info", "control.consent.allowed", { action: req.action });
  return { asked: true };
}

/** Closes our own confirmation after a timeout, pressing Deny. */
function dismissConsent(api: types.IExtensionApi, title: string): void {
  const dialogs = (api.getState() as { session?: { notifications?: { dialogs?: Array<{ id?: unknown; title?: unknown }> } } })
    .session?.notifications?.dialogs;
  for (const d of Array.isArray(dialogs) ? dialogs : []) {
    if (d.title === title && typeof d.id === "string") api.closeDialog?.(d.id, DENY, {});
  }
}
