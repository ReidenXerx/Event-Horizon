/**
 * Turns the control channel on and off, remembers the choice, and tells the
 * user about it once.
 *
 * Owner poll, 2026-09-26: off by default, visible and easy to reach (the
 * Agents page), plus a one-time popup that offers it. Every command that
 * changes something shows a Vortex notification, so nothing an agent does
 * is invisible.
 */

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import type { types } from "@nexusmods/vortex-api";

import { ehLog } from "../logging/ehLog";
import { getEventHorizonRoot } from "../paths/appDataPaths";
import { loadPreferences, updatePreferences } from "../preferences";
import { EXTENSION_VERSION } from "../../ui/version";
import { startControlServer, type ControlServer, type ControlVerb } from "./controlServer";
import { runVerb, VERBS } from "./verbs";
import { readOpsJournal, type OpRecord } from "./ops";
import { mcpLaunch, mergeDesktopConfig, type McpLaunch } from "./connectConfig";

/** v2: the newcomer pitch. A new id, so people who dismissed the technical v1 see it once. */
export const PROMO_ID = "control-channel-promo-2";

export type ControlStatus = {
  enabled: boolean;
  /** Vortex asks before an agent removes mods, purges or moves the game. */
  askFirst: boolean;
  running: boolean;
  port?: number;
  infoFile: string;
  error?: string;
};

let server: ControlServer | undefined;
let lastError: string | undefined;
let transition: Promise<void> = Promise.resolve();
const listeners = new Set<(s: ControlStatus) => void>();
const opListeners = new Set<(op: OpRecord) => void>();
let unsubscribeOps: (() => void) | undefined;

export function opsJournalFile(): string {
  return path.join(getEventHorizonRoot(), "control-ops.jsonl");
}

/** Newest first: the live log while the channel runs, the journal otherwise, so history shows even when it is off. */
export function getRecentOps(limit = 100): OpRecord[] {
  if (server !== undefined) return server.ops.list({ limit });
  return readOpsJournal(opsJournalFile(), limit).reverse();
}

/**
 * Withdraw a change still waiting in the queue, from the Agents page. Same
 * rule as the channel's `ops.cancel`: only `queued`; one already running is
 * never interrupted. Its queue slot sees it is no longer queued and runs
 * nothing.
 */
export function cancelQueuedOp(opId: string): boolean {
  const op = server?.ops.get(opId);
  if (server === undefined || op === undefined || op.status !== "queued") return false;
  server.ops.finish(op, {
    ok: false,
    code: "cancelled",
    message: "Cancelled from the Agents page before it started.",
    httpStatus: 409,
  });
  ehLog("info", "control.op.cancelled", { opId, verb: op.verb, by: "agents-page" });
  return true;
}

/** Every op as it is queued, starts and finishes. */
export function onControlOps(fn: (op: OpRecord) => void): () => void {
  opListeners.add(fn);
  return () => opListeners.delete(fn);
}

export function controlInfoFile(): string {
  return path.join(getEventHorizonRoot(), "control.json");
}

export function getControlStatus(): ControlStatus {
  const out: ControlStatus = {
    enabled: loadPreferences().controlChannel.enabled,
    askFirst: loadPreferences().controlChannel.askFirst,
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
      {
        mutates: v.mutates,
        ...(v.queue !== undefined ? { queue: v.queue } : {}),
        run: (body) => runVerb(api, name, body),
        ...(v.describe ? { describe: v.describe } : {}),
      },
    ]),
  );
}

async function start(api: types.IExtensionApi): Promise<void> {
  if (server !== undefined) return;
  try {
    server = await startControlServer({
      infoFile: controlInfoFile(),
      opsJournal: opsJournalFile(),
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
    unsubscribeOps = server.ops.subscribe((op) => {
      for (const fn of opListeners) fn(op);
    });
  } catch (err) {
    lastError = String((err as Error)?.message ?? err);
    ehLog("error", "control.start.fail", { err });
  }
}

async function stop(): Promise<void> {
  const s = server;
  server = undefined;
  unsubscribeOps?.();
  unsubscribeOps = undefined;
  await s?.close();
}

/** Startup: starts the channel only if the user turned it on before. */
export function startControlChannelIfEnabled(api: types.IExtensionApi): void {
  if (!loadPreferences().controlChannel.enabled) return;
  transition = transition.then(() => start(api)).then(emit);
}

/** Whether Vortex asks the person at the PC before an agent removes mods, purges or moves the game. */
export function setAgentAskFirst(askFirst: boolean): void {
  updatePreferences((p) => ({ ...p, controlChannel: { ...p.controlChannel, askFirst } }));
  ehLog("info", "control.ask-first", { askFirst });
  emit();
}

export function setControlChannelEnabled(api: types.IExtensionApi, enabled: boolean): Promise<ControlStatus> {
  updatePreferences((p) => ({ ...p, controlChannel: { ...p.controlChannel, enabled } }));
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
    "New in Event Horizon: just tell an AI what you want",
    {
      bbcode:
        "Modding without the clicking. Connect an AI assistant such as Claude to Vortex, then say what you want in plain " +
        "words:[br][/br][br][/br]" +
        "[i]“Install this mod and pick the right installer options for my setup.”[/i][br][/br]" +
        "[i]“My game crashes on startup. Find out why and fix it.”[/i][br][/br]" +
        "[i]“Make this texture mod win over the other one.”[/i][br][/br][br][/br]" +
        "It installs mods and answers their installers, fixes load order and conflicts, reads crash logs, and shows every " +
        "step on Event Horizon’s [b]Agents[/b] page. It checks each change really happened, asks before removing " +
        "anything, and never touches the game while it is running. It works only on this PC.[br][/br][br][/br]" +
        "It is [b]off[/b] until you turn it on. The Agents page connects Claude in one click.",
    },
    [{ label: "Not now" }, { label: "Turn it on", default: true }],
  );
  if (answer?.action === "Turn it on") await setControlChannelEnabled(api, true);
}

// ─── connecting an AI (the Agents page's "Connect your AI" card) ──────────

/** How an AI client starts the connector on THIS machine: Vortex's own exe, the deployed server script, this channel. */
export function connectorLaunch(): McpLaunch {
  return mcpLaunch({
    // In Vortex's renderer this is Vortex.exe, which runs the connector as plain Node.
    vortexExe: process.execPath,
    // dist/core/control -> dist/mcp/server.js, wherever the extension is installed.
    serverJs: path.resolve(__dirname, "..", "..", "mcp", "server.js"),
    controlFile: controlInfoFile(),
  });
}

export function claudeDesktopConfigPath(): string {
  const appData = process.env["APPDATA"] ?? path.join(os.homedir(), "AppData", "Roaming");
  return path.join(appData, "Claude", "claude_desktop_config.json");
}

/**
 * Every config file a Claude Desktop on this machine may read.
 *
 * The Microsoft Store build is packaged (MSIX): its writes to %APPDATA% land
 * in `%LOCALAPPDATA%\Packages\<Claude package>\LocalCache\Roaming`, and a
 * config file there shadows the real %APPDATA% one, so an entry written only to
 * the latter is never seen. 2026-10-04: a player pressed Add, restarted, and
 * Claude still saw nothing. Both locations are written when the packaged build
 * is present; the plain installer only has the first.
 */
export function claudeDesktopConfigPaths(): string[] {
  const out = [claudeDesktopConfigPath()];
  const local = process.env["LOCALAPPDATA"] ?? path.join(os.homedir(), "AppData", "Local");
  try {
    for (const pkg of fs.readdirSync(path.join(local, "Packages"))) {
      if (!/^(Anthropic\.)?Claude_/i.test(pkg)) continue;
      out.push(path.join(local, "Packages", pkg, "LocalCache", "Roaming", "Claude", "claude_desktop_config.json"));
    }
  } catch {
    // No Packages folder, or unreadable: the plain install path is all there is.
  }
  return out;
}

/** Adds Event Horizon to one Claude Desktop config file. See {@link addToClaudeDesktop}. */
function addToDesktopConfigFile(file: string): { ok: true } | { ok: false; message: string } {
  let existing: string | undefined;
  try {
    existing = fs.readFileSync(file, "utf8");
  } catch {
    existing = undefined;
  }
  const merged = mergeDesktopConfig(existing, connectorLaunch());
  if (!merged.ok) return { ok: false, message: merged.reason };
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (existing !== undefined) fs.writeFileSync(`${file}.before-event-horizon.bak`, existing, "utf8");
    fs.writeFileSync(file, merged.text, "utf8");
  } catch (err) {
    return { ok: false, message: `Could not write Claude Desktop's config: ${String((err as Error)?.message ?? err)}` };
  }
  ehLog("info", "control.connect.claude-desktop", { file, backedUp: existing !== undefined });
  return { ok: true };
}

/**
 * Adds Event Horizon to Claude Desktop's config, keeping everything else in
 * it and a backup of the file as it was. Refuses a file it cannot read rather
 * than overwrite the user's other servers. Writes every location a Desktop
 * here may read (see {@link claudeDesktopConfigPaths}); succeeds when one did.
 */
export function addToClaudeDesktop(): { ok: boolean; message: string; file: string } {
  const files = claudeDesktopConfigPaths();
  const results = files.map((f) => ({ file: f, result: addToDesktopConfigFile(f) }));
  const written = results.filter((r) => r.result.ok).map((r) => r.file);
  const failed = results.filter((r): r is { file: string; result: { ok: false; message: string } } => !r.result.ok);
  if (written.length === 0) {
    return { ok: false, message: failed[0]?.result.message ?? "Nothing was written.", file: files[0]! };
  }
  const store = written.length > 1 ? " (both the regular and the Microsoft Store locations)" : "";
  return {
    ok: true,
    message:
      `Added${store}. Quit Claude Desktop completely (right-click its tray icon → Quit) and open it again, ` +
      `then ask it anything about your mods.`,
    file: written[0]!,
  };
}
