/**
 * Turns the control channel on and off, remembers the choice, and tells the
 * user about it once.
 *
 * Owner poll, 2026-09-26: off by default, visible and easy to reach (the
 * Agents page), plus a one-time popup that offers it. Every command that
 * changes something shows a Vortex notification, so nothing an agent does
 * is invisible.
 */

import * as path from "path";
import type { types } from "@nexusmods/vortex-api";

import { ehLog } from "../logging/ehLog";
import { getEventHorizonRoot } from "../paths/appDataPaths";
import { loadPreferences, updatePreferences } from "../preferences";
import { EXTENSION_VERSION } from "../../ui/version";
import { startControlServer, type ControlServer, type ControlVerb } from "./controlServer";
import { runVerb, VERBS } from "./verbs";

export const PROMO_ID = "control-channel-promo";

export type ControlStatus = {
  enabled: boolean;
  running: boolean;
  port?: number;
  infoFile: string;
  error?: string;
};

let server: ControlServer | undefined;
let lastError: string | undefined;
let transition: Promise<void> = Promise.resolve();
const listeners = new Set<(s: ControlStatus) => void>();

export function controlInfoFile(): string {
  return path.join(getEventHorizonRoot(), "control.json");
}

export function getControlStatus(): ControlStatus {
  const out: ControlStatus = {
    enabled: loadPreferences().controlChannel.enabled,
    running: server !== undefined,
    infoFile: controlInfoFile(),
  };
  if (server !== undefined) out.port = server.port;
  if (lastError !== undefined) out.error = lastError;
  return out;
}

export function onControlStatus(fn: (s: ControlStatus) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function emit(): void {
  const s = getControlStatus();
  for (const fn of listeners) fn(s);
}

function boundVerbs(api: types.IExtensionApi): Record<string, ControlVerb> {
  return Object.fromEntries(
    Object.entries(VERBS).map(([name, v]) => [
      name,
      { mutates: v.mutates, run: (body) => runVerb(api, name, body), ...(v.describe ? { describe: v.describe } : {}) },
    ]),
  );
}

async function start(api: types.IExtensionApi): Promise<void> {
  if (server !== undefined) return;
  try {
    server = await startControlServer({
      infoFile: controlInfoFile(),
      opsJournal: path.join(getEventHorizonRoot(), "control-ops.jsonl"),
      verbs: boundVerbs(api),
      version: EXTENSION_VERSION,
      onMutated: (summary) =>
        api.sendNotification?.({
          type: "info",
          title: "Event Horizon · agent",
          message: summary,
          displayMS: 6000,
        }),
      onFailed: (verb, message) =>
        api.sendNotification?.({
          type: "warning",
          title: `Event Horizon · agent: ${verb} refused`,
          message,
          displayMS: 10000,
        }),
    });
    lastError = undefined;
  } catch (err) {
    lastError = String((err as Error)?.message ?? err);
    ehLog("error", "control.start.fail", { err });
  }
}

async function stop(): Promise<void> {
  const s = server;
  server = undefined;
  await s?.close();
}

/** Startup: starts the channel only if the user turned it on before. */
export function startControlChannelIfEnabled(api: types.IExtensionApi): void {
  if (!loadPreferences().controlChannel.enabled) return;
  transition = transition.then(() => start(api)).then(emit);
}

export function setControlChannelEnabled(api: types.IExtensionApi, enabled: boolean): Promise<ControlStatus> {
  updatePreferences((p) => ({ ...p, controlChannel: { enabled } }));
  ehLog("info", "control.toggle", { enabled });
  transition = transition.then(() => (enabled ? start(api) : stop())).then(emit);
  return transition.then(() => getControlStatus());
}

/**
 * The one-time offer. Marked as shown BEFORE the dialog opens, so a crash or
 * a closed window never shows it twice. Skipped when already on.
 */
export async function showControlPromoOnce(api: types.IExtensionApi): Promise<void> {
  const prefs = loadPreferences();
  if (prefs.shownOnce[PROMO_ID] === true || prefs.controlChannel.enabled) return;
  updatePreferences((p) => ({ ...p, shownOnce: { ...p.shownOnce, [PROMO_ID]: true } }));
  if (typeof api.showDialog !== "function") return;
  const answer = await api.showDialog(
    "question",
    "New in Event Horizon: let your AI agents drive Vortex",
    {
      bbcode:
        "Event Horizon can open a private control channel on this PC so AI assistants you run " +
        "(Claude Code and similar) can deploy, purge, switch profiles, enable, install and remove mods for you, " +
        "without you clicking through Vortex.[br][/br][br][/br]" +
        "It listens only on this computer (127.0.0.1), needs a secret token that changes every start, and " +
        "refuses browsers. Every change it makes pops up as a notification here. It never deploys " +
        "while your game is running, and it will not move a game folder that still has mods deployed.[br][/br][br][/br]" +
        "It is [b]off[/b] until you turn it on. You can switch it any time on Event Horizon's [b]Agents[/b] page.",
    },
    [{ label: "Not now" }, { label: "Turn it on", default: true }],
  );
  if (answer?.action === "Turn it on") await setControlChannelEnabled(api, true);
}
