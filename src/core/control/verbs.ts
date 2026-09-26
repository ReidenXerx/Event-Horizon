/**
 * What the control channel can do. One entry per verb; the server routes
 * `POST /v1/<verb>` here. Changes run one at a time; reads never wait.
 *
 * Every verb reuses the wrapper Event Horizon's own installer already relies
 * on (deployAndWait, switchToProfile, purgeGameDeployment, uninstallMods, the
 * install primitives), so the channel inherits their scars rather than
 * relearning them: deploy-mods takes its callback FIRST, a profile switch is
 * confirmed by state when its event is missed, a purge is bounded because
 * nothing else can settle it.
 *
 * ─── A SUCCESS IS A VERIFIED SUCCESS ────────────────────────────────────────
 * An agent must be able to act on `ok: true` without re-reading Vortex to
 * check. So every changing verb reads Vortex back after acting and fails with
 * a `*-unverified` / `*-incomplete` code when the result is not what it asked
 * for (a purge that left files, an install that is not "installed", a removal
 * that left a mod). What was checked is in `result.verified`. And every reply
 * carries `vortex`: the notifications Vortex raised while the command ran,
 * and any dialog left waiting for the user.
 *
 * Mutating verbs pass through `guards.ts` first. Removal is allowed (owner,
 * 2026-09-26) but only of the exact ids named, and every reply says which of
 * them Event Horizon installed: the NS-2 question is answered in the reply
 * even where the owner has chosen to override it.
 */

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { actions, selectors, util } from "@nexusmods/vortex-api";
import type { types } from "@nexusmods/vortex-api";

import { gameExecutable, purgeGameDeployment, readDiscovery } from "../environment/vortexEnvironment";
import { getActiveGameId } from "../getModsListForProfile";
import { deployAndWait } from "../installer/runInstall";
import { switchToProfile } from "../installer/profile";
import {
  installFromExistingDownload,
  installNexusViaApi,
  uninstallMods,
} from "../installer/modInstall";
import type { VortexInstallerChoices } from "../installer/installerChoices";
import { adoptLocalArchive } from "../installer/adoptLocalArchive";
import {
  ACTION_SET_PLUGIN_ENABLED,
  applyPluginOrder,
  dispatchRaw,
  readEnabledState,
  toPluginId,
} from "../installer/applyPluginOrder";
import { readUserPluginsTxt } from "../installer/checkPluginOrder";
import { ACTION_SET_AUTOSORT_ENABLED, readsAutoSort } from "../installer/autoSort";
import { countMods, deployBudgetMs } from "../installer/timeBudgets";
import { looksLikeWine } from "../proton/detect";
import { listReceipts } from "../installLedger";
import { getVortexUserDataPath } from "../paths/appDataPaths";
import { readPluginList } from "../curator/pluginPool";
import { collectDistinctModTypes } from "../deploymentManifest";
import { isProcessRunning } from "./gameProcess";
import { guardGameClosed, guardKnownMods, guardSetGamePath, type GuardResult } from "./guards";

export class ControlError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 400,
    /** Facts the caller needs even though the command failed (what DID happen). */
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

export type VerbBody = Record<string, unknown>;
export type Verb = {
  /** Changes the owner's setup: queued, and shown as a Vortex notification. */
  mutates: boolean;
  run: (api: types.IExtensionApi, body: VerbBody) => Promise<Record<string, unknown>>;
  /** One line for the notification, from the body and the result. */
  describe?: (body: VerbBody, result: Record<string, unknown>) => string;
};

// ─── small readers ─────────────────────────────────────────────────────────

const str = (v: unknown): string | undefined => (typeof v === "string" && v.length > 0 ? v : undefined);

function need(body: VerbBody, key: string): string {
  const v = str(body[key]);
  if (v === undefined) throw new ControlError("bad-request", `"${key}" (string) is required.`);
  return v;
}

function needIds(body: VerbBody): string[] {
  const ids = body["modIds"];
  if (!Array.isArray(ids) || ids.some((x) => typeof x !== "string" || x.length === 0)) {
    throw new ControlError("bad-request", `"modIds" must be a non-empty array of Vortex mod ids.`);
  }
  if (ids.length === 0) throw new ControlError("bad-request", `"modIds" is empty.`);
  return [...new Set(ids as string[])];
}

function enforce(g: GuardResult): void {
  if (!g.ok) throw new ControlError(g.code, g.message, 409);
}

function activeGame(api: types.IExtensionApi): string {
  const gameId = getActiveGameId(api.getState());
  if (gameId === undefined) throw new ControlError("no-game", "Vortex has no active game.", 409);
  return gameId;
}

function activeProfileId(api: types.IExtensionApi): string | undefined {
  const p = api.getState().settings?.profiles;
  return str(p?.activeProfileId) ?? str(p?.nextProfileId);
}

type ModRecord = {
  id: string;
  type?: string;
  state?: string;
  archiveId?: string;
  installationPath?: string;
  attributes?: Record<string, unknown>;
  rules?: unknown[];
};

function modPool(api: types.IExtensionApi, gameId: string): Record<string, ModRecord> {
  return ((api.getState() as { persistent?: { mods?: Record<string, Record<string, ModRecord>> } }).persistent?.mods?.[
    gameId
  ] ?? {}) as Record<string, ModRecord>;
}

type ProfileRecord = { id: string; name?: string; gameId?: string; modState?: Record<string, { enabled?: boolean }> };

function profiles(api: types.IExtensionApi): Record<string, ProfileRecord> {
  return ((api.getState() as { persistent?: { profiles?: Record<string, ProfileRecord> } }).persistent?.profiles ??
    {}) as Record<string, ProfileRecord>;
}

function needToDeploy(api: types.IExtensionApi, gameId: string): boolean {
  return (
    (api.getState() as { persistent?: { deployment?: { needToDeploy?: Record<string, boolean> } } }).persistent
      ?.deployment?.needToDeploy?.[gameId] === true
  );
}

async function gameRunning(api: types.IExtensionApi, gameId: string): Promise<{ running: boolean | undefined; exe?: string }> {
  const exe = gameExecutable(api.getState(), gameId, readDiscovery(api.getState(), gameId));
  if (exe === undefined) return { running: undefined };
  const exeName = path.basename(exe);
  return { running: await isProcessRunning(exeName), exe: exeName };
}

async function guardClosed(api: types.IExtensionApi, gameId: string, body: VerbBody): Promise<void> {
  const g = await gameRunning(api, gameId);
  enforce(guardGameClosed({ running: g.running, exeName: g.exe, assumeGameClosed: body["assumeGameClosed"] === true }));
}

/**
 * Files Vortex has deployed for this game right now, across every mod type.
 * `undefined` when any manifest could not be read: an unreadable manifest is
 * "unknown", and the game-folder guard refuses on unknown. (The builder's
 * `captureDeploymentManifests` skips failures, which is right for a build
 * and wrong for a safety check.)
 */
export async function deployedFileCount(api: types.IExtensionApi, gameId: string): Promise<number | undefined> {
  let total = 0;
  for (const modType of collectDistinctModTypes(api.getState(), gameId)) {
    try {
      const m = (await util.getManifest(api, modType, gameId)) as { files?: unknown[] } | undefined;
      total += Array.isArray(m?.files) ? m.files.length : 0;
    } catch {
      return undefined;
    }
  }
  return total;
}

/** Which of these mods Event Horizon installed, per its receipts. Unknown reads as "not ours". */
async function ownership(gameId: string, modIds: readonly string[]): Promise<Record<string, "eh-installed" | "not-eh">> {
  const ours = new Set<string>();
  for (const r of await listReceipts(getVortexUserDataPath()).catch(() => [])) {
    if (r.gameId !== gameId) continue;
    for (const m of r.mods ?? []) if (m.ownership === "installed" && m.vortexModId) ours.add(m.vortexModId);
    for (const m of r.retiredMods ?? []) ours.add(m.vortexModId);
  }
  return Object.fromEntries(modIds.map((id) => [id, ours.has(id) ? "eh-installed" : "not-eh"]));
}

function modName(m: ModRecord): string {
  const a = m.attributes ?? {};
  return str(a["customFileName"]) ?? str(a["name"]) ?? str(a["logicalFileName"]) ?? m.id;
}

function budget(api: types.IExtensionApi): number {
  return deployBudgetMs(countMods(api.getState()), { wine: looksLikeWine() });
}

// ─── Vortex's own voice: notifications and open dialogs ────────────────────

type VortexNotice = { id: string; type?: string; title?: string; message?: string };
type VortexDialog = { id: string; type?: string; title?: string; text?: string };

function notices(api: types.IExtensionApi): VortexNotice[] {
  const list = (api.getState() as { session?: { notifications?: { notifications?: unknown[] } } }).session
    ?.notifications?.notifications;
  return (Array.isArray(list) ? list : []).map((n) => {
    const x = n as Record<string, unknown>;
    return { id: String(x["id"]), type: str(x["type"]), title: str(x["title"]), message: str(x["message"]) };
  });
}

function openDialogs(api: types.IExtensionApi): VortexDialog[] {
  const list = (api.getState() as { session?: { notifications?: { dialogs?: unknown[] } } }).session?.notifications
    ?.dialogs;
  return (Array.isArray(list) ? list : []).map((d) => {
    const x = d as Record<string, unknown>;
    const c = (x["content"] ?? {}) as Record<string, unknown>;
    return {
      id: String(x["id"]),
      type: str(x["type"]),
      title: str(x["title"]),
      text: (str(c["text"]) ?? str(c["message"]) ?? str(c["bbcode"]))?.slice(0, 500),
    };
  });
}

/**
 * Vortex's "An older version of this mod is already installed" dialog
 * (InstallManager.userVersionChoice, read out of app.asar). Its buttons are
 * "Cancel", "Update all profiles" (REPLACE: every profile moves to the new
 * file, including ones for another install of the game) and "Update current
 * profile" (alongside: both versions stay, only the active profile switches).
 *
 * It cannot be pre-answered from an extension (the batch context that would
 * remember a choice is not exported), so it is answered when it appears,
 * through the same `closeDialog` the button calls.
 */
export const OLDER_VERSION_TEXT = "An older version of this mod is already installed";
export const IF_EXISTING_ACTION: Record<string, string> = {
  alongside: "Update current profile",
  replace: "Update all profiles",
};

/**
 * The OTHER replace dialog: installing an archive whose mod is already in
 * the pool (InstallManager.queryUserReplace). "Install options" asks
 * Replace (every profile) or Install as variant; a variant then asks for a
 * name ("Install options - Name mod variant", input id "variant"). A variant
 * becomes mod `<oldId>+<name>`; Vortex disables the old variant in the
 * CURRENT profile only and leaves every other profile on it.
 */
export const REINSTALL_TITLE = "Install options";
export const REINSTALL_TEXT = "is already installed on your system";
export const VARIANT_NAME_TITLE = "Install options - Name mod variant";

type RawDialog = {
  id: string;
  type?: string;
  title?: string;
  text: string;
  actions: string[];
  /** The first text input's current value (the variant-name dialog pre-fills one). */
  inputDefault?: string;
};

export type DialogAnswer = { label: string; input?: Record<string, unknown> };

function rawDialogs(api: types.IExtensionApi): RawDialog[] {
  const list = (api.getState() as { session?: { notifications?: { dialogs?: unknown[] } } }).session?.notifications
    ?.dialogs;
  return (Array.isArray(list) ? list : []).map((d) => {
    const x = d as Record<string, unknown>;
    const c = (x["content"] ?? {}) as Record<string, unknown>;
    // Vortex keeps a dialog's buttons in state as their LABELS, plain strings
    // (showDialog: `actions.map(action => action.label)`). Objects are read too.
    const actions = Array.isArray(x["actions"]) ? (x["actions"] as unknown[]) : [];
    const inputs = Array.isArray(c["input"]) ? (c["input"] as Array<{ value?: unknown }>) : [];
    return {
      id: String(x["id"]),
      type: str(x["type"]),
      title: str(x["title"]),
      text: str(c["text"]) ?? str(c["message"]) ?? str(c["bbcode"]) ?? "",
      actions: actions.map((a) => (typeof a === "string" ? a : String((a as { label?: unknown } | null)?.label ?? ""))),
      ...(inputs[0]?.value !== undefined ? { inputDefault: String(inputs[0].value) } : {}),
    };
  });
}

export type AnswerPolicy = {
  ifExisting?: string;
  /** Name for a new variant (the variant-name dialog); its own pre-filled value when absent. */
  variantName?: string;
  /** The caller sent its own installer choices: do not let the old mod's pre-fill them. */
  ownChoices?: boolean;
};

/** What to press for this dialog under the caller's policy, or undefined to leave it to the user. */
export function answerFor(policy: AnswerPolicy, d: RawDialog): DialogAnswer | undefined {
  const ifExisting = policy.ifExisting;
  if (ifExisting === undefined || ifExisting === "ask") return undefined;
  // A Vortex that renamed its buttons gets no answer rather than a wrong one.
  const press = (label: string, input?: Record<string, unknown>): DialogAnswer | undefined =>
    d.actions.includes(label) ? { label, ...(input !== undefined ? { input } : {}) } : undefined;

  if (d.text.startsWith(OLDER_VERSION_TEXT)) {
    const label = IF_EXISTING_ACTION[ifExisting];
    return label === undefined ? undefined : press(label, { remember: false });
  }
  if (d.title === REINSTALL_TITLE && d.text.includes(REINSTALL_TEXT)) {
    const variant = ifExisting === "alongside";
    return press("Continue", {
      replace: !variant,
      variant,
      remember: false,
      // Vortex copies the OLD mod's installer choices onto the new one unless told not to.
      preserveChoices: policy.ownChoices !== true,
    });
  }
  if (d.title === VARIANT_NAME_TITLE && ifExisting === "alongside") {
    const name = policy.variantName ?? d.inputDefault;
    return name === undefined || name === "" ? undefined : press("Continue", { variant: name, remember: false });
  }
  return undefined;
}

type SeenDialog = { type?: string; title?: string; text: string; answer?: string; answeredBy?: "ifExisting" };

/**
 * Watches the store while a command runs: records every dialog that opens
 * (one answered mid-command otherwise leaves no trace) and answers the
 * older-version dialog when the caller said how.
 */
function watchDialogs(api: types.IExtensionApi, policy: AnswerPolicy): { seen: SeenDialog[]; stop: () => void } {
  const handled = new Set(rawDialogs(api).map((d) => d.id)); // already open before the command: not ours
  const seen: SeenDialog[] = [];
  const check = (): void => {
    for (const d of rawDialogs(api)) {
      if (handled.has(d.id)) continue;
      handled.add(d.id);
      const entry: SeenDialog = { type: d.type, title: d.title, text: d.text.slice(0, 500) };
      seen.push(entry);
      const answer = answerFor(policy, d);
      if (answer !== undefined) {
        entry.answer = answer.label + (answer.input?.["variant"] === true ? " (variant)" : answer.input?.["replace"] === true ? " (replace)" : typeof answer.input?.["variant"] === "string" ? ` (${String(answer.input["variant"])})` : "");
        entry.answeredBy = "ifExisting";
        // Not from inside the store listener: dispatching there re-enters it.
        setTimeout(() => api.closeDialog?.(d.id, answer.label, answer.input ?? {}), 0);
      }
    }
  };
  // A Redux store; the typings trim ThunkStore to dispatch/getState.
  const unsubscribe = (api.store as unknown as { subscribe?: (fn: () => void) => () => void } | undefined)?.subscribe?.(check);
  return { seen, stop: () => unsubscribe?.() };
}

/**
 * Runs a verb and attaches what Vortex said while it ran: new notifications
 * (an "error" one means something failed that no callback reported), every
 * dialog that opened (and how it was answered), and any dialog still open,
 * which is how an agent learns a FOMOD installer is waiting for the user.
 */
export async function runVerb(api: types.IExtensionApi, name: string, body: VerbBody): Promise<Record<string, unknown>> {
  const verb = VERBS[name];
  if (verb === undefined) throw new ControlError("no-such-verb", `Unknown verb ${name}.`, 404);
  const ifExisting = body["ifExisting"] === undefined ? undefined : String(body["ifExisting"]);
  if (ifExisting !== undefined && ifExisting !== "ask" && IF_EXISTING_ACTION[ifExisting] === undefined) {
    throw new ControlError("bad-request", `"ifExisting" must be "alongside", "replace" or "ask".`);
  }
  const before = new Set(notices(api).map((n) => n.id));
  const policy: AnswerPolicy = {
    ...(ifExisting !== undefined ? { ifExisting } : {}),
    ...(str(body["variantName"]) !== undefined ? { variantName: str(body["variantName"])! } : {}),
    ownChoices: body["choices"] !== undefined,
  };
  const watch = verb.mutates ? watchDialogs(api, policy) : undefined;
  const activity = (): Record<string, unknown> => ({
    notifications: notices(api)
      .filter((n) => !before.has(n.id) && n.type !== "activity")
      .map(({ type, title, message }) => ({ type, title, message })),
    dialogsSeen: watch?.seen ?? [],
    openDialogs: openDialogs(api).map(({ type, title, text }) => ({ type, title, text })),
  });
  try {
    const result = await verb.run(api, body);
    return verb.mutates ? { ...result, vortex: activity() } : result;
  } catch (err) {
    if (err instanceof ControlError) {
      throw new ControlError(err.code, err.message, err.status, { ...(err.details ?? {}), vortex: activity() });
    }
    throw new ControlError("vortex-error", String((err as Error)?.message ?? err), 500, { vortex: activity() });
  } finally {
    watch?.stop();
  }
}

// ─── the actions, each verified ────────────────────────────────────────────

async function purge(api: types.IExtensionApi, gameId: string): Promise<number> {
  if (getActiveGameId(api.getState()) !== gameId) {
    throw new ControlError("game-changed", "Vortex switched games before the purge; nothing was purged.", 409);
  }
  await purgeGameDeployment(api, { timeoutMs: budget(api) });
  const left = await deployedFileCount(api, gameId);
  if (left === undefined) {
    throw new ControlError("purge-unverified", "Vortex reported the purge done, but the deployment manifests could not be read.", 500);
  }
  if (left > 0) {
    throw new ControlError("purge-incomplete", `Vortex reported the purge done, but ${left} files are still deployed.`, 500, {
      deployedFilesAfter: left,
    });
  }
  return left;
}

/** How long Vortex's needToDeploy flag may lag the deploy callback before it counts. */
export let DEPLOY_FLAG_SETTLE_MS = 20000;
/** Tests shorten the settle windows. */
export function setSettleWindowsForTests(ms: number): void {
  DEPLOY_FLAG_SETTLE_MS = ms;
  PLUGIN_SETTLE_MS = ms;
  PLUGIN_QUIET_MS = ms;
}
/** How long plugin state must stay unchanged before an order is judged (autosort lands after a change). */
export let PLUGIN_QUIET_MS = 3000;
/** How long Vortex may take to reflect plugin changes in its state. */
export let PLUGIN_SETTLE_MS = 5000;

async function deploy(api: types.IExtensionApi, gameId: string): Promise<Record<string, unknown>> {
  const profileId = activeProfileId(api);
  if (profileId === undefined) throw new ControlError("no-profile", "Vortex has no active profile.", 409);
  await deployAndWait(api, profileId);
  const files = await deployedFileCount(api, gameId);
  // Vortex clears its "needs deploying" flag a few seconds AFTER the deploy
  // callback (measured live: failed at the callback, false 6 s later), so
  // the flag is given time to settle before it counts against the deploy.
  let stillNeeded = needToDeploy(api, gameId);
  for (let waited = 0; stillNeeded && waited < DEPLOY_FLAG_SETTLE_MS; waited += 250) {
    await new Promise((r) => setTimeout(r, 250));
    stillNeeded = needToDeploy(api, gameId);
  }
  if (files === undefined || stillNeeded) {
    throw new ControlError(
      "deploy-unverified",
      files === undefined
        ? "Vortex reported the deploy done, but the deployment manifests could not be read."
        : "Vortex reported the deploy done, but still says the game needs deploying.",
      500,
      { deployedFiles: files, deploymentNeeded: stillNeeded },
    );
  }
  return { profileId, deployedFiles: files, verified: { deploymentNeeded: false, deployedFiles: files } };
}

async function identifyStore(gamePath: string): Promise<string | undefined> {
  try {
    const helper = (util as unknown as { GameStoreHelper?: { identifyStore?: (p: string) => Promise<string> } })
      .GameStoreHelper;
    return str(await helper?.identifyStore?.(gamePath));
  } catch {
    return undefined;
  }
}

/** Repoints the active game. The caller has already purged; this re-checks it anyway. */
async function setGamePath(
  api: types.IExtensionApi,
  gameId: string,
  body: VerbBody,
): Promise<Record<string, unknown>> {
  const newPath = path.resolve(need(body, "path"));
  const game = util.getGame(gameId) as { requiredFiles?: string[]; executable?: (p?: string) => string } | undefined;
  const required = game?.requiredFiles ?? [];
  const exists = fs.existsSync(newPath) && fs.statSync(newPath).isDirectory();
  const missing = exists ? required.filter((f) => !fs.existsSync(path.join(newPath, f))) : [];
  const before = readDiscovery(api.getState(), gameId);
  enforce(
    guardSetGamePath({
      deployedFiles: await deployedFileCount(api, gameId),
      newPath,
      newPathExists: exists,
      missingRequiredFiles: missing,
      currentPath: before.path,
    }),
  );
  // The store is the caller's to state when it knows better (a standalone exe
  // detects as nothing, or as the wrong store); otherwise Vortex's own detection.
  const store = str(body["store"]) ?? (await identifyStore(newPath));
  // Same rule as Vortex's own browseGameLocation: record the executable only
  // when this folder's differs from the game's default.
  let executable: string | undefined;
  try {
    const exe = game?.executable?.(newPath);
    executable = exe !== undefined && exe !== game?.executable?.() ? exe : undefined;
  } catch {
    executable = undefined;
  }
  api.store?.dispatch(actions.setGamePath(gameId, newPath, store as string, executable as string));
  const after = readDiscovery(api.getState(), gameId);
  if (after.path === undefined || path.resolve(after.path) !== newPath) {
    throw new ControlError("set-path-failed", `Vortex still reports ${after.path ?? "no path"} for ${gameId}.`, 500);
  }
  return {
    gameId,
    previousPath: before.path,
    previousStore: before.store,
    path: after.path,
    store: after.store,
    verified: { path: after.path, store: after.store },
  };
}

/**
 * Installs a download a second time as a SEPARATE mod: the archive is copied
 * under a new name and registered as a new download, so Vortex sees neither
 * the same archive (the replace/variant dialog) nor the same install name.
 * EH's own installAlongside technique; the original mod is untouched in
 * every profile.
 */
async function installFromCopy(
  api: types.IExtensionApi,
  gameId: string,
  archiveId: string,
  label: string,
  choices: VortexInstallerChoices | undefined,
  unattended: boolean,
): Promise<{ vortexModId: string }> {
  const state = api.getState() as unknown as {
    persistent?: { downloads?: { files?: Record<string, { localPath?: string }> } };
  };
  const localPath = state.persistent?.downloads?.files?.[archiveId]?.localPath;
  const folder = (selectors as unknown as { downloadPathForGame?: (s: unknown, g: string) => string }).downloadPathForGame?.(
    api.getState(),
    gameId,
  );
  if (localPath === undefined || folder === undefined) {
    throw new ControlError("no-such-download", `No local file for download ${archiveId}.`, 404);
  }
  const source = path.join(folder, localPath);
  if (!fs.existsSync(source)) throw new ControlError("no-such-download", `The download's file is missing: ${source}.`, 404);
  const safeLabel = label.replace(/[<>:"/\\|?*]/g, "_").slice(0, 40);
  const ext = path.extname(source);
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "eh-control-copy-"));
  try {
    const staged = path.join(tempDir, `${path.basename(source, ext)} (${safeLabel})${ext}`);
    fs.copyFileSync(source, staged);
    const adopted = await adoptLocalArchive(api, { gameId, archivePath: staged });
    return await installFromExistingDownload(api, {
      gameId,
      archiveId: adopted.archiveId,
      ...(choices !== undefined ? { choices } : {}),
      unattended,
    });
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

/**
 * Downloads a Nexus file WITHOUT installing it and returns its download id.
 * The same call downloadNexusArchiveOnly makes (`nexusDownload` with
 * allowInstall=false), which returns the file PATH; the silent-replace check
 * needs the id.
 */
async function nexusDownloadOnly(api: types.IExtensionApi, gameId: string, modId: number, fileId: number): Promise<string | undefined> {
  const dl = (api as unknown as { ext?: { nexusDownload?: (...a: unknown[]) => Promise<unknown> } }).ext?.nexusDownload;
  if (typeof dl !== "function") return undefined;
  const id = await dl(gameId, modId, fileId, undefined, false);
  return typeof id === "string" && id.length > 0 ? id : undefined;
}

/**
 * Mods an install of this download would collide with: installed from the same
 * archive, or already holding the install name Vortex derives from its file
 * name (the archive name without extension, the usual case). Either one sends
 * Vortex down queryUserReplace.
 */
function existingFor(api: types.IExtensionApi, gameId: string, archiveId: string): string[] {
  const dl = (api.getState() as unknown as { persistent?: { downloads?: { files?: Record<string, { localPath?: string }> } } })
    .persistent?.downloads?.files?.[archiveId];
  const base = dl?.localPath !== undefined ? path.basename(dl.localPath, path.extname(dl.localPath)).toLowerCase() : undefined;
  return Object.values(modPool(api, gameId))
    .filter((m) => m.state === "installed" && (m.archiveId === archiveId || (base !== undefined && m.id.toLowerCase() === base)))
    .map((m) => m.id);
}

function modSummary(m: ModRecord, enabled: boolean, owner?: string): Record<string, unknown> {
  const a = m.attributes ?? {};
  return {
    id: m.id,
    name: modName(m),
    version: str(a["version"]),
    enabled,
    state: m.state,
    type: m.type || undefined,
    nexus: a["modId"] !== undefined ? { modId: a["modId"], fileId: a["fileId"] } : undefined,
    source: str(a["source"]),
    archiveId: m.archiveId,
    ...(owner !== undefined ? { owner } : {}),
  };
}

function enabledMap(api: types.IExtensionApi, profileId: string | undefined): Record<string, { enabled?: boolean }> {
  return profileId !== undefined ? (profiles(api)[profileId]?.modState ?? {}) : {};
}

function downloadsFor(api: types.IExtensionApi, gameId: string): Array<Record<string, unknown>> {
  const files =
    (api.getState() as unknown as { persistent?: { downloads?: { files?: Record<string, Record<string, unknown>> } } })
      .persistent?.downloads?.files ?? {};
  return Object.entries(files)
    .filter(([, d]) => ((d["game"] as string[] | undefined) ?? []).includes(gameId))
    .map(([id, d]) => ({
      id,
      fileName: d["localPath"],
      state: d["state"],
      size: d["size"],
      nexus: (d["modInfo"] as { nexus?: { ids?: unknown } } | undefined)?.nexus?.ids,
    }));
}

// ─── rules and conflicts (mirrors Vortex's mod-dependency-manager) ─────────

type ModRule = { type?: string; reference?: Record<string, unknown> };

/** Rule types that settle a file conflict, per mod-dependency-manager's own check. */
const ORDER_RULES = ["before", "after", "conflicts"];
const RULE_TYPES = ["before", "after", "conflicts", "requires", "recommends"];

/** Does this rule's reference point at `mod`? Vortex's own matcher when present, else the id. */
function refersTo(mod: ModRecord, reference: Record<string, unknown> | undefined): boolean {
  if (reference === undefined) return false;
  const test = (util as unknown as { testModReference?: (m: unknown, r: unknown) => boolean }).testModReference;
  if (typeof test === "function") {
    try {
      return test(mod, reference) === true;
    } catch {
      // Fall through to the id: a matcher that throws must not read as "no rule".
    }
  }
  return reference["id"] === mod.id;
}

/**
 * Is the conflict between these two mods settled by a rule on either side?
 * Vortex's own test (mod-dependency-manager, `re`): a before/after/conflicts
 * rule on one mod whose reference matches the other.
 */
function orderRuleBetween(pool: Record<string, ModRecord>, a: string, b: string): { on: string; type: string } | undefined {
  for (const [from, to] of [
    [a, b],
    [b, a],
  ] as const) {
    const src = pool[from];
    const dst = pool[to];
    if (src === undefined || dst === undefined) continue;
    const hit = ((src.rules ?? []) as ModRule[]).find((r) => ORDER_RULES.includes(String(r.type)) && refersTo(dst, r.reference));
    if (hit !== undefined) return { on: from, type: String(hit.type) };
  }
  return undefined;
}

type ConflictPair = {
  modId: string;
  modName: string;
  otherId: string;
  otherName: string;
  files: number;
  sampleFiles: string[];
  resolved: boolean;
  rule?: { on: string; type: string };
  /** Every contested file; kept for the identical check, not sent. */
  allFiles: string[];
  /** Byte-identical in both mods' staging: a conflict nothing needs to settle. */
  identical?: boolean;
};

/** Vortex's computed file conflicts, one entry per pair. `undefined` when Vortex has not computed them. */
function conflictPairs(api: types.IExtensionApi, gameId: string): ConflictPair[] | undefined {
  const raw = (api.getState() as { session?: { dependencies?: { conflicts?: Record<string, unknown[]> } } }).session
    ?.dependencies?.conflicts;
  if (raw === undefined || raw === null) return undefined;
  const pool = modPool(api, gameId);
  const seen = new Set<string>();
  const out: ConflictPair[] = [];
  for (const [modId, list] of Object.entries(raw)) {
    for (const c of Array.isArray(list) ? list : []) {
      const x = c as { otherMod?: { id?: string }; files?: unknown[] };
      const otherId = x.otherMod?.id;
      if (otherId === undefined) continue;
      const key = [modId, otherId].sort().join("\u0000");
      if (seen.has(key)) continue;
      seen.add(key);
      const rule = orderRuleBetween(pool, modId, otherId);
      const files = Array.isArray(x.files) ? x.files.map(String) : [];
      out.push({
        modId,
        modName: pool[modId] ? modName(pool[modId]!) : modId,
        otherId,
        otherName: pool[otherId] ? modName(pool[otherId]!) : otherId,
        files: files.length,
        sampleFiles: files.slice(0, 10),
        allFiles: files,
        resolved: rule !== undefined,
        ...(rule !== undefined ? { rule } : {}),
      });
    }
  }
  return out;
}

/**
 * Are the files these two mods fight over byte-identical in staging? Then the
 * conflict is Vortex's to report and nobody's to fix: whichever wins, the game
 * gets the same bytes (live: an Anatomy build and its dev copy, 6 files, same
 * md5). `undefined` when it cannot be told: a file missing, one too big to
 * hash in a reply, too many files, or no staging folder. Unknown is never
 * reported as identical.
 */
async function identicalInStaging(
  api: types.IExtensionApi,
  gameId: string,
  pair: ConflictPair,
  files: readonly string[],
): Promise<boolean | undefined> {
  const root = (selectors as unknown as { installPathForGame?: (s: unknown, g: string) => string }).installPathForGame?.(
    api.getState(),
    gameId,
  );
  const pool = modPool(api, gameId);
  const a = pool[pair.modId]?.installationPath;
  const b = pool[pair.otherId]?.installationPath;
  if (root === undefined || a === undefined || b === undefined || files.length === 0 || files.length > IDENTICAL_MAX_FILES) {
    return undefined;
  }
  const { hashFileSha256 } = await import("../archiveHashing");
  for (const f of files) {
    const pa = path.join(root, a, f);
    const pb = path.join(root, b, f);
    let sa: fs.Stats;
    let sb: fs.Stats;
    try {
      [sa, sb] = [fs.statSync(pa), fs.statSync(pb)];
    } catch {
      return undefined;
    }
    if (sa.size !== sb.size) return false;
    if (sa.size > IDENTICAL_MAX_BYTES) return undefined;
    if ((await hashFileSha256(pa)) !== (await hashFileSha256(pb))) return false;
  }
  return true;
}
const IDENTICAL_MAX_FILES = 200;
const IDENTICAL_MAX_BYTES = 256 * 1024 * 1024;

function versionMatchFor(mod: ModRecord, match: unknown): string {
  const version = str(mod.attributes?.["version"]);
  if (match === undefined || match === "any" || version === undefined) return "*";
  if (match === "compatible") return `^${version}`;
  if (match === "exact") return version;
  throw new ControlError("bad-request", `"versionMatch" must be "any", "compatible" or "exact".`);
}

// ─── plugins (gamebryo-plugin-management's state, through EH's own writer) ──

type PluginWant = { name: string; enabled: boolean };

function parsePluginWants(raw: unknown, key: string): PluginWant[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new ControlError("bad-request", `"${key}" must be a non-empty array of {name, enabled}.`);
  }
  return raw.map((x, i) => {
    const e = x as { name?: unknown; enabled?: unknown };
    if (typeof e?.name !== "string" || e.name === "" || typeof e.enabled !== "boolean") {
      throw new ControlError("bad-request", `"${key}[${i}]" needs a string name and a boolean enabled.`);
    }
    return { name: e.name, enabled: e.enabled };
  });
}

/** Plugins act on the ACTIVE profile only: it is the one whose list lives in Vortex's state. */
function pluginProfile(api: types.IExtensionApi, body: VerbBody): string {
  const active = activeProfileId(api);
  const asked = str(body["profileId"]);
  if (active === undefined) throw new ControlError("no-profile", "Vortex has no active profile.", 409);
  if (asked !== undefined && asked !== active) {
    throw new ControlError(
      "not-active-profile",
      `Plugin state lives in the ACTIVE profile (${active}). Switch to ${asked} first (game.switchInstall when it belongs to another install).`,
      409,
    );
  }
  return active;
}

type PluginCheck = { unknown: string[]; wrongEnabled: string[]; outOfOrder: number };

/** Compares Vortex's plugin state with what was asked. `checkOrder` compares the relative order of known plugins. */
function checkPlugins(api: types.IExtensionApi, wants: readonly PluginWant[], checkOrder: boolean): PluginCheck {
  const known = new Map(readPluginList(api.getState()).map((p) => [toPluginId(p.name), p]));
  const unknown: string[] = [];
  const wrongEnabled: string[] = [];
  let outOfOrder = 0;
  let last = -Infinity;
  for (const w of wants) {
    const p = known.get(toPluginId(w.name));
    if (p === undefined) {
      unknown.push(w.name);
      continue;
    }
    // A game's own master is always enabled and never in loadOrder: asking to disable it is not a mismatch Vortex can fix.
    if (!p.isNative && p.enabled !== w.enabled) wrongEnabled.push(w.name);
    if (checkOrder && typeof p.loadOrder === "number") {
      if (p.loadOrder < last) outOfOrder += 1;
      last = p.loadOrder;
    }
  }
  return { unknown, wrongEnabled, outOfOrder };
}

async function settlePlugins(
  api: types.IExtensionApi,
  wants: readonly PluginWant[],
  checkOrder: boolean,
): Promise<PluginCheck> {
  let c = checkPlugins(api, wants, checkOrder);
  for (let waited = 0; (c.wrongEnabled.length > 0 || c.outOfOrder > 0) && waited < PLUGIN_SETTLE_MS; waited += 250) {
    await new Promise((r) => setTimeout(r, 250));
    c = checkPlugins(api, wants, checkOrder);
  }
  return c;
}

/**
 * Waits until Vortex's plugin state stops changing: quiet for PLUGIN_QUIET_MS,
 * capped at 10x that. Vortex's autosort runs LOOT a moment AFTER a plugin
 * change, so an order read straight after an apply can be a state that is
 * about to be replaced (live: verified "as given", re-sorted seconds later).
 */
async function waitForQuietPlugins(api: types.IExtensionApi): Promise<void> {
  const slice = (): unknown => (api.getState() as { loadOrder?: unknown }).loadOrder;
  let last = slice();
  let quietFor = 0;
  for (let waited = 0; quietFor < PLUGIN_QUIET_MS && waited < PLUGIN_QUIET_MS * 10; waited += 250) {
    await new Promise((r) => setTimeout(r, 250));
    const now = slice();
    quietFor = now === last ? quietFor + 250 : 0;
    last = now;
  }
}

/** What plugins.txt on DISK says, after Vortex has had a moment to flush it. The game reads this file, not Vortex's state. */
async function pluginsTxtOnDisk(api: types.IExtensionApi, gameId: string, wants: readonly PluginWant[]): Promise<Record<string, unknown>> {
  const store = readDiscovery(api.getState(), gameId).store;
  const expectActive = new Set(wants.filter((w) => w.enabled).map((w) => toPluginId(w.name)));
  let file = await readUserPluginsTxt(gameId, store);
  for (let waited = 0; waited < PLUGIN_SETTLE_MS; waited += 500) {
    const active = new Set((file ?? []).filter((e) => e.enabled).map((e) => toPluginId(e.name)));
    if (file !== undefined && [...expectActive].every((id) => active.has(id))) break;
    await new Promise((r) => setTimeout(r, 500));
    file = await readUserPluginsTxt(gameId, store);
  }
  if (file === undefined) return { read: false };
  const active = new Set(file.filter((e) => e.enabled).map((e) => toPluginId(e.name)));
  const missingActive = wants.filter((w) => w.enabled && !active.has(toPluginId(w.name))).map((w) => w.name);
  // Relative order of the asked-for plugins as the FILE has them: the game loads this, whatever Vortex's state says.
  const pos = new Map(file.map((e, i) => [toPluginId(e.name), i]));
  let outOfOrder = 0;
  let last = -1;
  const firstOutOfOrder: string[] = [];
  for (const w of wants) {
    const p = pos.get(toPluginId(w.name));
    if (p === undefined) continue;
    if (p < last) {
      outOfOrder += 1;
      if (firstOutOfOrder.length < 20) firstOutOfOrder.push(w.name);
    }
    last = Math.max(last, p);
  }
  return {
    read: true,
    entries: file.length,
    active: active.size,
    missingActive: missingActive.slice(0, 50),
    missingActiveCount: missingActive.length,
    outOfOrder,
    firstOutOfOrder,
  };
}

const lc = (v: unknown): string => String(v ?? "").toLowerCase();
const limitOf = (body: VerbBody, dflt: number): number => Math.max(1, Math.min(Number(body["limit"]) || dflt, 5000));

// ─── the verbs ─────────────────────────────────────────────────────────────

export const VERBS: Record<string, Verb> = {
  /**
   * A compact summary by default; `include: ["mods","plugins","downloads"]`
   * adds the long lists (a thousand-mod setup is a big reply).
   */
  state: {
    mutates: false,
    run: async (api, body) => {
      const state = api.getState();
      const gameId = getActiveGameId(state);
      if (gameId === undefined) return { gameId: null };
      const include = new Set(Array.isArray(body["include"]) ? (body["include"] as string[]) : String(body["include"] ?? "").split(","));
      const discovery = readDiscovery(state, gameId);
      const profileId = activeProfileId(api);
      const prof = profiles(api);
      const modState = enabledMap(api, profileId);
      const pool = modPool(api, gameId);
      const running = await gameRunning(api, gameId);
      const plugins = readPluginList(state);
      const downloads = downloadsFor(api, gameId);
      const enabledMods = Object.keys(pool).filter((id) => modState[id]?.enabled === true).length;
      const deployedFiles = await deployedFileCount(api, gameId);
      const vortexFlag = needToDeploy(api, gameId);
      /**
       * Vortex's own flag is not the whole answer: after a game folder is
       * repointed by hand it reads false while nothing at all is deployed
       * (measured on the owner's AE switch: 961 enabled mods, 0 files, flag
       * false). Enabled mods with zero deployed files need a deploy whatever
       * the flag says.
       */
      const emptyButEnabled = deployedFiles === 0 && enabledMods > 0;
      const out: Record<string, unknown> = {
        gameId,
        game: { path: discovery.path, store: discovery.store, executable: running.exe, running: running.running },
        profile: profileId !== undefined ? { id: profileId, name: prof[profileId]?.name } : null,
        profiles: Object.values(prof)
          .filter((p) => p.gameId === gameId)
          .map((p) => ({ id: p.id, name: p.name })),
        plugins: { autoSort: readsAutoSort(state) },
        deployment: {
          needed: vortexFlag || emptyButEnabled,
          vortexFlag,
          deployedFiles,
          ...(emptyButEnabled && !vortexFlag
            ? { reason: `${enabledMods} mods are enabled but nothing is deployed; Vortex's own flag says otherwise` }
            : {}),
        },
        counts: {
          mods: Object.keys(pool).length,
          enabledMods,
          plugins: plugins.length,
          enabledPlugins: plugins.filter((p) => p.enabled).length,
          downloads: downloads.length,
        },
        vortex: {
          notifications: notices(api)
            .filter((n) => n.type !== "activity")
            .map(({ type, title, message }) => ({ type, title, message })),
          openDialogs: openDialogs(api).map(({ type, title, text }) => ({ type, title, text })),
        },
      };
      if (include.has("mods")) {
        const owner = await ownership(gameId, Object.keys(pool));
        out["mods"] = Object.values(pool).map((m) => modSummary(m, modState[m.id]?.enabled === true, owner[m.id]));
      }
      if (include.has("plugins")) {
        out["plugins"] = plugins.map((p) => ({
          name: p.name,
          enabled: p.enabled,
          loadOrder: p.loadOrder,
          modId: p.modId,
          native: p.isNative || undefined,
        }));
      }
      if (include.has("downloads")) out["downloads"] = downloads;
      return out;
    },
  },

  /** Filter the active game's mods: `name` (substring), `nexusModId`, `enabled`, `owner`, `limit`. */
  "mods.find": {
    mutates: false,
    run: async (api, body) => {
      const gameId = activeGame(api);
      const pool = modPool(api, gameId);
      const modState = enabledMap(api, activeProfileId(api));
      const owner = await ownership(gameId, Object.keys(pool));
      const name = body["name"] !== undefined ? lc(body["name"]) : undefined;
      const nexusModId = body["nexusModId"] !== undefined ? Number(body["nexusModId"]) : undefined;
      const enabled = body["enabled"] === undefined ? undefined : body["enabled"] === true || body["enabled"] === "true";
      const matches = Object.values(pool)
        .map((m) => modSummary(m, modState[m.id]?.enabled === true, owner[m.id]))
        .filter(
          (m) =>
            (name === undefined || lc(m["name"]).includes(name) || lc(m["id"]).includes(name)) &&
            (nexusModId === undefined || Number((m["nexus"] as { modId?: unknown } | undefined)?.modId) === nexusModId) &&
            (enabled === undefined || m["enabled"] === enabled) &&
            (body["owner"] === undefined || m["owner"] === body["owner"]),
        );
      const limit = limitOf(body, 200);
      return { gameId, total: matches.length, mods: matches.slice(0, limit), truncated: matches.length > limit };
    },
  },

  /** Everything Vortex holds about one mod, plus its plugins and which profiles enable it. */
  "mod.get": {
    mutates: false,
    run: async (api, body) => {
      const gameId = activeGame(api);
      const id = need(body, "id");
      const m = modPool(api, gameId)[id];
      if (m === undefined) throw new ControlError("no-such-mod", `No mod ${id} in ${gameId}.`, 404);
      const owner = (await ownership(gameId, [id]))[id];
      return {
        ...modSummary(m, enabledMap(api, activeProfileId(api))[id]?.enabled === true, owner),
        installationPath: m.installationPath,
        attributes: m.attributes ?? {},
        rules: m.rules ?? [],
        enabledIn: Object.values(profiles(api))
          .filter((p) => p.gameId === gameId && p.modState?.[id]?.enabled === true)
          .map((p) => ({ id: p.id, name: p.name })),
        plugins: readPluginList(api.getState())
          .filter((p) => p.modId === id)
          .map((p) => ({ name: p.name, enabled: p.enabled, loadOrder: p.loadOrder })),
      };
    },
  },

  /** Every mod rule on a mod, and every rule other mods hold on it. */
  "mods.rules": {
    mutates: false,
    // `{id}` for one mod, or `{modIds: [...]}` for several (the shape mods.setEnabled takes).
    run: async (api, body) => {
      const gameId = activeGame(api);
      const pool = modPool(api, gameId);
      const refName = (ref: Record<string, unknown> | undefined): string | undefined => {
        const target = Object.values(pool).find((m) => refersTo(m, ref));
        return target !== undefined ? target.id : undefined;
      };
      const one = (id: string): Record<string, unknown> => {
        const mod = pool[id]!;
        return {
          id,
          name: modName(mod),
          rules: ((mod.rules ?? []) as ModRule[]).map((r) => ({ type: r.type, reference: r.reference, resolvesTo: refName(r.reference) })),
          heldByOthers: Object.values(pool)
            .filter((m) => m.id !== id)
            .flatMap((m) =>
              ((m.rules ?? []) as ModRule[]).filter((r) => refersTo(mod, r.reference)).map((r) => ({ from: m.id, fromName: modName(m), type: r.type })),
            ),
        };
      };
      if (body["modIds"] !== undefined) {
        const ids = needIds(body);
        enforce(guardKnownMods({ requested: ids, pool: new Set(Object.keys(pool)) }));
        return { gameId, mods: ids.map(one) };
      }
      const id = need(body, "id");
      if (pool[id] === undefined) throw new ControlError("no-such-mod", `No mod ${id} in ${gameId}.`, 404);
      return one(id);
    },
  },

  /** Plugins in load order: `enabled`, `name` (substring), `limit`. */
  plugins: {
    mutates: false,
    run: async (api, body) => {
      const name = body["name"] !== undefined ? lc(body["name"]) : undefined;
      const enabled = body["enabled"] === undefined ? undefined : body["enabled"] === true || body["enabled"] === "true";
      const list = readPluginList(api.getState()).filter(
        (p) => (name === undefined || lc(p.name).includes(name)) && (enabled === undefined || p.enabled === enabled),
      );
      const limit = limitOf(body, 2000);
      return {
        total: list.length,
        plugins: list.slice(0, limit).map((p) => ({ name: p.name, enabled: p.enabled, loadOrder: p.loadOrder, modId: p.modId })),
        truncated: list.length > limit,
      };
    },
  },

  /** The active game's downloads: `name` (substring), `state`, `limit`. */
  downloads: {
    mutates: false,
    run: async (api, body) => {
      const gameId = activeGame(api);
      const name = body["name"] !== undefined ? lc(body["name"]) : undefined;
      const list = downloadsFor(api, gameId).filter(
        (d) => (name === undefined || lc(d["fileName"]).includes(name)) && (body["state"] === undefined || d["state"] === body["state"]),
      );
      const limit = limitOf(body, 500);
      return { gameId, total: list.length, downloads: list.slice(0, limit), truncated: list.length > limit };
    },
  },

  /**
   * Vortex's own computed file conflicts (for the ENABLED mods of the active
   * profile), one entry per pair, with whether a rule settles each. The
   * "There are unresolved file conflicts" notification names no mods; this
   * does. `modId?` narrows to one mod, `unresolvedOnly?` to what still needs
   * a rule.
   */
  conflicts: {
    mutates: false,
    run: async (api, body) => {
      const gameId = activeGame(api);
      const pairs = conflictPairs(api, gameId);
      if (pairs === undefined) {
        return { gameId, calculated: false, note: "Vortex has not calculated conflicts yet (it does so after a deploy).", pairs: [] };
      }
      const modId = str(body["modId"]);
      const unresolvedOnly = body["unresolvedOnly"] === true || body["unresolvedOnly"] === "true";
      const list = pairs.filter(
        (p) => (modId === undefined || p.modId === modId || p.otherId === modId) && (!unresolvedOnly || !p.resolved),
      );
      const limit = limitOf(body, 500);
      const shown = list.slice(0, limit);
      // Unresolved pairs get the identical check (capped): those are the ones an agent would otherwise go and fix.
      let checked = 0;
      for (const p of shown) {
        if (p.resolved || checked >= 100) continue;
        checked += 1;
        const same = await identicalInStaging(api, gameId, p, p.allFiles);
        if (same !== undefined) p.identical = same;
      }
      return {
        gameId,
        calculated: true,
        total: list.length,
        unresolved: pairs.filter((p) => !p.resolved).length,
        unresolvedDifferent: shown.filter((p) => !p.resolved && p.identical !== true).length,
        pairs: shown.map(({ allFiles: _all, ...p }) => p),
        truncated: list.length > limit,
      };
    },
  },

  /**
   * The last GOOD plugin list Event Horizon's wipe guard saved for a profile
   * (default: the active one): names, order, enabled. Feed its entries to
   * plugins.apply to restore it.
   */
  "plugins.lastGood": {
    mutates: false,
    run: async (api, body) => {
      const profileId = str(body["profileId"]) ?? activeProfileId(api);
      if (profileId === undefined) throw new ControlError("no-profile", "No profile given and none active.", 409);
      const { loadSnapshot } = await import("../doctor/pluginWipeGuard");
      const s = loadSnapshot(profileId);
      if (s === undefined) throw new ControlError("no-snapshot", `No saved plugin list for profile ${profileId} yet.`, 404);
      const order = [...s.entries].sort((a, b) => (a.loadOrder ?? 1e9) - (b.loadOrder ?? 1e9));
      return { profileId, gameId: s.gameId, savedAt: s.savedAt, active: s.active, order: order.map((e) => ({ name: e.name, enabled: e.enabled })) };
    },
  },

  /** What Vortex is showing right now: notifications, and dialogs waiting for the user. */
  "vortex.notifications": {
    mutates: false,
    run: async (api) => ({
      notifications: notices(api).map(({ type, title, message }) => ({ type, title, message })),
      openDialogs: openDialogs(api).map(({ type, title, text }) => ({ type, title, text })),
    }),
  },

  purge: {
    mutates: true,
    run: async (api, body) => {
      const gameId = activeGame(api);
      await guardClosed(api, gameId, body);
      const left = await purge(api, gameId);
      return { gameId, deployedFilesAfter: left, verified: { deployedFiles: left } };
    },
    describe: (_b, r) => `purged ${String(r["gameId"])}`,
  },

  deploy: {
    mutates: true,
    run: async (api, body) => {
      const gameId = activeGame(api);
      await guardClosed(api, gameId, body);
      return { gameId, ...(await deploy(api, gameId)) };
    },
    describe: (_b, r) => `deployed ${String(r["gameId"])}`,
  },

  "mods.setEnabled": {
    mutates: true,
    run: async (api, body) => {
      const gameId = activeGame(api);
      const ids = needIds(body);
      if (typeof body["enabled"] !== "boolean") throw new ControlError("bad-request", `"enabled" (boolean) is required.`);
      const profileId = str(body["profileId"]) ?? activeProfileId(api);
      const profile = profileId !== undefined ? profiles(api)[profileId] : undefined;
      if (profile === undefined || profile.gameId !== gameId) {
        throw new ControlError("bad-profile", `Profile ${profileId ?? "(none)"} is not a ${gameId} profile.`, 409);
      }
      enforce(guardKnownMods({ requested: ids, pool: new Set(Object.keys(modPool(api, gameId))) }));
      for (const id of ids) api.store?.dispatch(actions.setModEnabled(profile.id, id, body["enabled"] as boolean));
      const now = profiles(api)[profile.id]?.modState ?? {};
      const notApplied = ids.filter((id) => (now[id]?.enabled === true) !== body["enabled"]);
      if (notApplied.length > 0) {
        throw new ControlError("not-applied", `Vortex did not apply the change for: ${notApplied.join(", ")}.`, 500, {
          applied: ids.filter((id) => !notApplied.includes(id)),
          notApplied,
        });
      }
      return {
        profileId: profile.id,
        enabled: body["enabled"],
        modIds: ids,
        deployNeeded: true,
        verified: { enabledState: body["enabled"], modIds: ids },
      };
    },
    describe: (b) => `${b["enabled"] ? "enabled" : "disabled"} ${(b["modIds"] as unknown[]).length} mod(s)`,
  },

  "mods.remove": {
    mutates: true,
    run: async (api, body) => {
      const gameId = activeGame(api);
      const ids = needIds(body);
      const pool = modPool(api, gameId);
      enforce(guardKnownMods({ requested: ids, pool: new Set(Object.keys(pool)) }));
      await guardClosed(api, gameId, body);
      const owner = await ownership(gameId, ids);
      const described = ids.map((id) => ({ id, name: modName(pool[id]!), owner: owner[id] }));
      await uninstallMods(api, { gameId, modIds: ids });
      const after = modPool(api, gameId);
      const removed = described.filter((d) => after[d.id] === undefined);
      const notRemoved = described.filter((d) => after[d.id] !== undefined);
      if (notRemoved.length > 0) {
        throw new ControlError(
          "remove-incomplete",
          `${notRemoved.length} of ${ids.length} mods are still in the pool: ${notRemoved.map((d) => d.id).join(", ")}.`,
          500,
          { removed, notRemoved },
        );
      }
      return { gameId, removed, notRemoved: [], verified: { goneFromPool: ids } };
    },
    describe: (_b, r) => `removed ${(r["removed"] as unknown[]).length} mod(s)`,
  },

  /**
   * Adds or removes a mod rule: `source` loads `type` (before/after/conflicts/
   * requires/recommends) `reference`. Mirrors Vortex's own conflict editor:
   * an order rule first replaces any before/after/conflicts rule the source
   * already has on that mod, so the pair never carries two contradicting
   * ones. Read back from Vortex before it answers.
   *
   *   { source, type, reference, versionMatch?: "any"|"compatible"|"exact" }
   *   { source, reference, remove: true, type? }
   */
  "mods.rule": {
    mutates: true,
    run: async (api, body) => {
      const gameId = activeGame(api);
      const source = need(body, "source");
      const reference = need(body, "reference");
      if (source === reference) throw new ControlError("bad-request", "A mod cannot have a rule on itself.");
      enforce(guardKnownMods({ requested: [source, reference], pool: new Set(Object.keys(modPool(api, gameId))) }));
      const remove = body["remove"] === true;
      const type = str(body["type"]);
      if (!remove && (type === undefined || !RULE_TYPES.includes(type))) {
        throw new ControlError("bad-request", `"type" must be one of ${RULE_TYPES.join(", ")}.`);
      }
      const pool = modPool(api, gameId);
      const src = pool[source]!;
      const ref = pool[reference]!;
      const existing = ((src.rules ?? []) as ModRule[]).filter((r) => refersTo(ref, r.reference));
      const toRemove = remove
        ? existing.filter((r) => type === undefined || r.type === type)
        : ORDER_RULES.includes(type!)
          ? existing.filter((r) => ORDER_RULES.includes(String(r.type)))
          : existing.filter((r) => r.type === type);
      for (const r of toRemove) api.store?.dispatch(actions.removeModRule(gameId, source, r as never));
      let added: ModRule | undefined;
      if (!remove) {
        added = { type, reference: { id: reference, versionMatch: versionMatchFor(ref, body["versionMatch"]) } };
        api.store?.dispatch(actions.addModRule(gameId, source, added as never));
      }

      // Read back what Vortex now holds for this pair.
      const after = modPool(api, gameId);
      const now = ((after[source]?.rules ?? []) as ModRule[]).filter((r) => refersTo(after[reference]!, r.reference));
      const ok = remove
        ? !now.some((r) => type === undefined || r.type === type)
        : now.some((r) => r.type === type) &&
          (!ORDER_RULES.includes(type!) || now.filter((r) => ORDER_RULES.includes(String(r.type))).length === 1);
      if (!ok) {
        throw new ControlError("rule-unverified", `Vortex's rules for ${source} -> ${reference} are not what was asked.`, 500, {
          rulesOnPair: now,
        });
      }
      // The other mod may carry its own order rule on this one; say so, since two
      // rules that disagree make a cycle Vortex will complain about.
      const otherSide = ((after[reference]?.rules ?? []) as ModRule[])
        .filter((r) => ORDER_RULES.includes(String(r.type)) && refersTo(after[source]!, r.reference))
        .map((r) => ({ type: r.type }));
      const pair = conflictPairs(api, gameId)?.find(
        (p) => (p.modId === source && p.otherId === reference) || (p.modId === reference && p.otherId === source),
      );
      return {
        gameId,
        source,
        reference,
        ...(remove ? { removed: toRemove.length } : { type, replaced: toRemove.map((r) => r.type) }),
        /** Only the rules between these two mods. */
        rulesOnPair: now.map((r) => ({ type: r.type, reference: r.reference })),
        /** Every rule the source mod holds, on any mod. */
        sourceRules: ((after[source]?.rules ?? []) as ModRule[]).map((r) => ({ type: r.type, reference: r.reference })),
        otherSideRules: otherSide,
        conflict: pair === undefined ? null : { files: pair.files, resolved: pair.resolved },
        deployNeeded: true,
        verified: { rulesOnPair: now.map((r) => r.type) },
      };
    },
    describe: (b) =>
      b["remove"] === true
        ? `removed a rule ${String(b["source"])} -> ${String(b["reference"])}`
        : `rule: ${String(b["source"])} ${String(b["type"])} ${String(b["reference"])}`,
  },

  /**
   * Enable or disable plugins by name in the ACTIVE profile. Names Vortex
   * does not list are reported, not failed. Read back from Vortex's state,
   * and plugins.txt on disk is checked once Vortex has flushed it.
   *
   *   { names: [...], enabled, profileId? }
   */
  "plugins.setEnabled": {
    mutates: true,
    run: async (api, body) => {
      const gameId = activeGame(api);
      const profileId = pluginProfile(api, body);
      const names = body["names"];
      if (!Array.isArray(names) || names.length === 0 || names.some((n) => typeof n !== "string" || n === "")) {
        throw new ControlError("bad-request", `"names" must be a non-empty array of plugin file names.`);
      }
      if (typeof body["enabled"] !== "boolean") throw new ControlError("bad-request", `"enabled" (boolean) is required.`);
      const wants = (names as string[]).map((name) => ({ name, enabled: body["enabled"] as boolean }));
      const current = readEnabledState(api);
      let changed = 0;
      for (const w of wants) {
        const id = toPluginId(w.name);
        if (current[id] === undefined || current[id] === w.enabled) continue;
        dispatchRaw(api, ACTION_SET_PLUGIN_ENABLED, { pluginName: w.name, enabled: w.enabled });
        changed += 1;
      }
      api.events.emit("collection-postprocess-complete", gameId, "event-horizon-control");
      const check = await settlePlugins(api, wants, false);
      if (check.wrongEnabled.length > 0) {
        throw new ControlError("plugins-unverified", `${check.wrongEnabled.length} plugins did not take the new state.`, 500, {
          wrongEnabled: check.wrongEnabled,
          unknown: check.unknown,
        });
      }
      const disk = await pluginsTxtOnDisk(api, gameId, wants);
      return {
        gameId,
        profileId,
        changed,
        unknown: check.unknown,
        pluginsTxt: disk,
        verified: { state: "matches", pluginsTxt: disk["read"] === true && disk["missingActiveCount"] === 0 },
      };
    },
    describe: (b, r) => `${b["enabled"] ? "enabled" : "disabled"} ${String(r["changed"])} plugin(s)`,
  },

  /**
   * Replays a known plugin list into the ACTIVE profile: order AND enabled
   * state, through the same writer EH's installer uses (pin via
   * set-plugin-list without disabling the user's own plugins, correct only
   * the enabled states that differ, flush plugins.txt). `sort: true` lets
   * LOOT place plugins the list does not mention afterwards; default off, so
   * the list is kept exactly.
   *
   *   { order: [{name, enabled}, ...], profileId?, sort? }
   */
  "plugins.apply": {
    mutates: true,
    run: async (api, body) => {
      const gameId = activeGame(api);
      const profileId = pluginProfile(api, body);
      const wants = parsePluginWants(body["order"], "order");
      const sort = body["sort"] === true;
      const applied = await applyPluginOrder({
        api,
        gameId,
        collectionId: "event-horizon-control",
        order: wants.map((w) => ({ name: w.name, enabled: w.enabled })),
        skipSort: !sort,
      });
      if (!applied.pinned) {
        throw new ControlError("plugins-not-applied", applied.notes.join("; ") || "Vortex did not take the order.", 500, {
          notes: applied.notes,
        });
      }
      // A LOOT sort may legitimately move plugins, so order is only checked when the list is meant to be kept exactly.
      const autoSort = readsAutoSort(api.getState());
      await settlePlugins(api, wants, !sort); // the apply itself landed
      await waitForQuietPlugins(api); // ...and whatever Vortex's autosort does next has happened
      const check = checkPlugins(api, wants, !sort);
      const resortHint =
        autoSort === true && !sort
          ? "Vortex's autosort is ON and re-sorted after the apply: an exact order only survives it through LOOT " +
            "userlist rules (plugins.rule) or with autosort off (plugins.setAutoSort)."
          : undefined;
      if (check.wrongEnabled.length > 0 || check.outOfOrder > 0) {
        throw new ControlError(
          check.wrongEnabled.length === 0 && resortHint !== undefined ? "resorted-after-apply" : "plugins-unverified",
          `${check.wrongEnabled.length} plugins have the wrong enabled state and ${check.outOfOrder} are out of order` +
            (resortHint !== undefined ? `. ${resortHint}` : "."),
          500,
          {
            wrongEnabled: check.wrongEnabled.slice(0, 100),
            outOfOrder: check.outOfOrder,
            unknown: check.unknown,
            autoSort,
            notes: applied.notes,
          },
        );
      }
      const disk = await pluginsTxtOnDisk(api, gameId, wants);
      if (!sort && disk["read"] === true && Number(disk["outOfOrder"]) > 0) {
        throw new ControlError(
          "plugins-txt-order",
          `Vortex's state has the order, but plugins.txt on disk has ${String(disk["outOfOrder"])} of the plugins out of it` +
            (resortHint !== undefined ? `. ${resortHint}` : "."),
          500,
          { pluginsTxt: disk, autoSort },
        );
      }
      return {
        gameId,
        profileId,
        entries: wants.length,
        enabledCorrections: applied.enabledCorrections,
        sorted: applied.sorted,
        autoSort,
        unknown: check.unknown,
        notes: applied.notes,
        pluginsTxt: disk,
        verified: {
          state: "matches",
          order: sort ? "sorted by LOOT" : "as given, after Vortex went quiet",
          pluginsTxt: disk["read"] === true && disk["missingActiveCount"] === 0 && (sort || disk["outOfOrder"] === 0),
        },
      };
    },
    describe: (_b, r) => `applied a ${String(r["entries"])}-plugin list`,
  },

  /**
   * A LOOT userlist rule between two plugins: the kind of order that SURVIVES
   * Vortex's autosort, which a pinned order does not. Through the installer's
   * own applyUserlist (verified in state.userlist).
   *
   *   { name, type: "after"|"before"|"requires"|"incompatible", reference, sort? }
   *   { name, type, reference, remove: true }
   *
   * "before" is stored the way LOOT stores it: `reference` loads after `name`.
   * `sort: true` runs LOOT now and checks the two plugins came out in that order.
   */
  "plugins.rule": {
    mutates: true,
    run: async (api, body) => {
      const gameId = activeGame(api);
      const name = need(body, "name");
      const reference = need(body, "reference");
      const type = need(body, "type");
      if (!["after", "before", "requires", "incompatible"].includes(type)) {
        throw new ControlError("bad-request", `"type" must be after, before, requires or incompatible.`);
      }
      if (toPluginId(name) === toPluginId(reference)) throw new ControlError("bad-request", "A plugin cannot have a rule on itself.");
      // LOOT's storage: `owner` carries the list, `target` is in it.
      const [owner, target] = type === "before" ? [reference, name] : [name, reference];
      const kind = type === "requires" ? "req" : type === "incompatible" ? "inc" : "after";
      const listOf = (): string[] => {
        const pl = ((api.getState() as { userlist?: { plugins?: Array<Record<string, unknown>> } }).userlist?.plugins ?? []).find(
          (p) => typeof p["name"] === "string" && toPluginId(p["name"] as string) === toPluginId(owner),
        );
        const list = (pl?.[kind] as unknown[] | undefined) ?? [];
        return list.map((r) => toPluginId(typeof r === "string" ? r : String((r as { name?: unknown })?.name ?? "")));
      };
      const has = (): boolean => listOf().includes(toPluginId(target));

      if (body["remove"] === true) {
        if (has()) {
          dispatchRaw(api, "REMOVE_USERLIST_RULE", {
            pluginId: owner,
            reference: target,
            type: kind === "req" ? "requires" : kind === "inc" ? "incompatible" : "after",
          });
        }
        if (has()) throw new ControlError("plugin-rule-unverified", `The ${type} rule ${owner} -> ${target} is still in LOOT's userlist.`, 500);
        return { gameId, name, type, reference, removed: true, verified: { inUserlist: false } };
      }

      const { applyUserlist } = await import("../installer/applyUserlist");
      const r = applyUserlist({ api, userlist: { plugins: [{ name: owner, [kind]: [target] }], groups: [] } });
      if (!has()) {
        throw new ControlError(
          "plugin-rule-unverified",
          r.skipped[0]?.reason ?? `LOOT's userlist does not show ${owner} ${kind} ${target}.`,
          500,
          { skipped: r.skipped },
        );
      }
      const out: Record<string, unknown> = {
        gameId,
        name,
        type,
        reference,
        stored: { plugin: owner, [kind]: target },
        autoSort: readsAutoSort(api.getState()),
        verified: { inUserlist: true },
      };
      if (body["sort"] === true && kind === "after") {
        await new Promise<void>((resolve, reject) =>
          api.events.emit("autosort-plugins", true, (err: Error | null | undefined) => (err ? reject(err) : resolve())),
        );
        await waitForQuietPlugins(api);
        const pos = new Map(readPluginList(api.getState()).map((p) => [toPluginId(p.name), p.loadOrder]));
        const a = pos.get(toPluginId(owner));
        const b = pos.get(toPluginId(target));
        const ordered = typeof a === "number" && typeof b === "number" ? a > b : undefined;
        if (ordered === false) {
          throw new ControlError("plugin-rule-not-effective", `After LOOT's sort ${owner} still loads before ${target}.`, 500, {
            positions: { [owner]: a, [target]: b },
          });
        }
        out["sortedNow"] = { positions: { [owner]: a, [target]: b }, ordered };
      }
      return out;
    },
    describe: (b) =>
      b["remove"] === true
        ? `removed LOOT rule ${String(b["name"])} ${String(b["type"])} ${String(b["reference"])}`
        : `LOOT rule: ${String(b["name"])} ${String(b["type"])} ${String(b["reference"])}`,
  },

  /**
   * LOOT userlist as Vortex holds it: every plugin entry (group, after,
   * requires, incompatible) and the user's groups. `name?` narrows to rules
   * that mention that plugin, on either side.
   */
  "plugins.rules": {
    mutates: false,
    run: async (api, body) => {
      const ul = (api.getState() as { userlist?: { plugins?: Array<Record<string, unknown>>; groups?: Array<Record<string, unknown>> } })
        .userlist;
      const names = (v: unknown): string[] =>
        (Array.isArray(v) ? v : []).map((r) => (typeof r === "string" ? r : String((r as { name?: unknown })?.name ?? "")));
      const plugins = (ul?.plugins ?? []).map((p) => ({
        name: String(p["name"] ?? ""),
        ...(p["group"] !== undefined ? { group: String(p["group"]) } : {}),
        after: names(p["after"]),
        requires: names(p["req"]),
        incompatible: names(p["inc"]),
      }));
      const want = str(body["name"]);
      const mentions = (p: (typeof plugins)[number]): boolean =>
        want === undefined ||
        [p.name, ...p.after, ...p.requires, ...p.incompatible].some((n) => toPluginId(n) === toPluginId(want));
      return {
        autoSort: readsAutoSort(api.getState()),
        plugins: plugins.filter(mentions),
        groups: (ul?.groups ?? []).map((g) => ({ name: String(g["name"] ?? ""), after: names(g["after"]) })),
      };
    },
  },

  /** Puts a plugin in a LOOT group (userlist), read back. The group must exist (LOOT's masterlist or the user's). */
  "plugins.setGroup": {
    mutates: true,
    run: async (api, body) => {
      const name = need(body, "name");
      const group = need(body, "group");
      const { applyUserlist } = await import("../installer/applyUserlist");
      const r = applyUserlist({ api, userlist: { plugins: [{ name, group }], groups: [] } });
      const now = ((api.getState() as { userlist?: { plugins?: Array<Record<string, unknown>> } }).userlist?.plugins ?? []).find(
        (p) => typeof p["name"] === "string" && toPluginId(p["name"] as string) === toPluginId(name),
      )?.["group"];
      if (now !== group) {
        throw new ControlError("plugin-group-unverified", r.skipped[0]?.reason ?? `LOOT's userlist shows group ${String(now)} for ${name}.`, 500, {
          skipped: r.skipped,
        });
      }
      return { name, group, verified: { group: now } };
    },
    describe: (b) => `put ${String(b["name"])} in LOOT group ${String(b["group"])}`,
  },

  /**
   * Runs LOOT's sort now (the same event Vortex's Sort button fires) and
   * reports what moved.
   */
  "plugins.sort": {
    mutates: true,
    run: async (api) => {
      const before = new Map(readPluginList(api.getState()).map((p) => [p.name, p.loadOrder]));
      await new Promise<void>((resolve, reject) =>
        api.events.emit("autosort-plugins", true, (err: Error | null | undefined) => (err ? reject(err) : resolve())),
      );
      await waitForQuietPlugins(api);
      const moved = readPluginList(api.getState())
        .filter((p) => before.get(p.name) !== p.loadOrder)
        .map((p) => ({ name: p.name, from: before.get(p.name), to: p.loadOrder }));
      return { moved: moved.slice(0, 300), movedCount: moved.length, truncated: moved.length > 300 };
    },
    describe: (_b, r) => `ran LOOT sort (${String(r["movedCount"])} moved)`,
  },

  /** Vortex's plugin autosort on or off (`settings.plugins.autoSort`), read back. */
  "plugins.setAutoSort": {
    mutates: true,
    run: async (api, body) => {
      if (typeof body["enabled"] !== "boolean") throw new ControlError("bad-request", `"enabled" (boolean) is required.`);
      dispatchRaw(api, ACTION_SET_AUTOSORT_ENABLED, body["enabled"] as unknown as Record<string, unknown>);
      const now = readsAutoSort(api.getState());
      if (now !== body["enabled"]) {
        throw new ControlError("autosort-unverified", `Vortex reports autosort ${String(now)} after setting ${String(body["enabled"])}.`, 500);
      }
      return { autoSort: now, verified: { autoSort: now } };
    },
    describe: (b) => `turned plugin autosort ${b["enabled"] ? "on" : "off"}`,
  },

  "profile.switch": {
    mutates: true,
    run: async (api, body) => {
      const profileId = need(body, "profileId");
      const target = profiles(api)[profileId];
      if (target === undefined) throw new ControlError("bad-profile", `No profile ${profileId}.`, 404);
      // A switch deploys (Vortex's auto-deploy), so the game must be closed.
      await guardClosed(api, target.gameId ?? activeGame(api), body);
      await switchToProfile(api, profileId);
      const active = activeProfileId(api);
      if (active !== profileId) {
        throw new ControlError("switch-unverified", `Vortex reports profile ${active ?? "none"} active, not ${profileId}.`, 500);
      }
      return { profileId, name: target.name, gameId: target.gameId, verified: { activeProfile: active } };
    },
    describe: (_b, r) => `switched to profile ${String(r["name"] ?? r["profileId"])}`,
  },

  "game.setPath": {
    mutates: true,
    run: async (api, body) => {
      const gameId = activeGame(api);
      await guardClosed(api, gameId, body);
      return setGamePath(api, gameId, body);
    },
    describe: (_b, r) => `set the ${String(r["gameId"])} folder to ${String(r["path"])}`,
  },

  /**
   * One install to another, in the only safe order: purge while still pointed
   * at the old folder, repoint, switch profile, deploy. Each step is checked
   * before the next; a failure names the step and the steps that completed.
   */
  "game.switchInstall": {
    mutates: true,
    run: async (api, body) => {
      const gameId = activeGame(api);
      const profileId = need(body, "profileId");
      const target = profiles(api)[profileId];
      if (target === undefined || target.gameId !== gameId) {
        throw new ControlError("bad-profile", `Profile ${profileId} is not a ${gameId} profile.`, 409);
      }
      await guardClosed(api, gameId, body);
      const steps: string[] = [];
      const step = async <T>(name: string, fn: () => Promise<T>): Promise<T> => {
        try {
          const out = await fn();
          steps.push(name);
          return out;
        } catch (err) {
          const e =
            err instanceof ControlError ? err : new ControlError("step-failed", String((err as Error)?.message ?? err), 500);
          throw new ControlError(e.code, `${name} failed after [${steps.join(" -> ") || "nothing"}]: ${e.message}`, e.status, {
            ...(e.details ?? {}),
            failedStep: name,
            completedSteps: [...steps],
          });
        }
      };
      await step("purge", () => purge(api, gameId));
      const moved = await step("setPath", () => setGamePath(api, gameId, body));
      await step("profile", async () => {
        await switchToProfile(api, profileId);
        if (activeProfileId(api) !== profileId) {
          throw new ControlError("switch-unverified", `Vortex reports profile ${activeProfileId(api) ?? "none"} active.`, 500);
        }
      });
      const deployed = await step("deploy", () => deploy(api, gameId));
      return {
        ...moved,
        profileId,
        steps,
        deployedFiles: deployed["deployedFiles"],
        verified: {
          path: moved["path"],
          store: moved["store"],
          activeProfile: profileId,
          deploymentNeeded: false,
          deployedFiles: deployed["deployedFiles"],
        },
      };
    },
    describe: (_b, r) => `switched ${String(r["gameId"])} to ${String(r["path"])}`,
  },

  /**
   * Installs into the active game, from Nexus (`nexus: {modId, fileId}`) or
   * from a download Vortex already has (`archiveId`). Without `choices`, a
   * FOMOD installer shows its dialog in Vortex and this waits for it; use
   * `async: true` and watch `vortex.openDialogs` to see that happen.
   */
  install: {
    mutates: true,
    run: async (api, body) => {
      const gameId = activeGame(api);
      const choices = body["choices"] as VortexInstallerChoices | undefined;
      const unattended = body["unattended"] === true;
      const nexus = body["nexus"] as { modId?: unknown; fileId?: unknown } | undefined;
      let vortexModId!: string;
      const asCopy = str(body["asCopy"]);
      let archiveId: string | undefined;
      if (nexus !== undefined) {
        if (typeof nexus.modId !== "number" || typeof nexus.fileId !== "number") {
          throw new ControlError("bad-request", `"nexus" needs numeric modId and fileId.`);
        }
        if (!unattended && asCopy === undefined) {
          // Attended: Vortex asks about anything already installed, and ifExisting answers it.
          ({ vortexModId } = await installNexusViaApi(api, {
            gameId,
            nexusModId: nexus.modId,
            nexusFileId: nexus.fileId,
            ...(choices !== undefined ? { choices } : {}),
            unattended,
          }));
        } else {
          // Unattended or a copy: download first, so the silent-replace check below
          // sees the archive BEFORE Vortex decides anything about it.
          archiveId = await nexusDownloadOnly(api, gameId, nexus.modId, nexus.fileId);
          if (archiveId === undefined) {
            throw new ControlError("download-failed", `Vortex could not download ${nexus.modId}:${nexus.fileId}.`, 500);
          }
        }
      } else {
        archiveId = need(body, "archiveId");
      }
      if (archiveId !== undefined) {
        const collides = existingFor(api, gameId, archiveId);
        /**
         * ─── THE SILENT REPLACE ─────────────────────────────────────────────
         * Installing an archive whose mod is already in the pool (the same
         * archive, or one whose install name is already taken), unattended and
         * with different choices, is what Vortex's queryUserReplace calls a
         * DEPENDENCY reinstall: outside a collection session it picks
         * "replace" with no dialog at all (read in app.asar), and replace
         * swaps the mod in EVERY profile. Refused unless that is what the
         * caller asked for; `asCopy` is the way to get a second copy.
         */
        if (collides.length > 0 && unattended && asCopy === undefined && body["ifExisting"] !== "replace") {
          throw new ControlError(
            "would-replace-everywhere",
            `Mod ${collides.join(", ")} is already installed from this archive (or under its name). An unattended ` +
              `reinstall makes Vortex REPLACE it in every profile, silently. Send "asCopy": "<label>" to install a ` +
              `separate copy (no dialogs), drop "unattended" to be asked, or send "ifExisting": "replace" if replacing ` +
              `everywhere is the intent.`,
            409,
            { existing: collides, archiveId },
          );
        }
        if (asCopy !== undefined) {
          ({ vortexModId } = await installFromCopy(api, gameId, archiveId, asCopy, choices, unattended));
        } else {
          ({ vortexModId } = await installFromExistingDownload(api, {
            gameId,
            archiveId,
            ...(choices !== undefined ? { choices } : {}),
            unattended,
          }));
        }
      }
      const m = modPool(api, gameId)[vortexModId];
      if (m === undefined || m.state !== "installed") {
        throw new ControlError(
          "install-unverified",
          `Vortex finished the install, but mod ${vortexModId} is ${m === undefined ? "not in the pool" : `in state "${String(m.state)}"`}.`,
          500,
          { vortexModId },
        );
      }
      const enable = body["enable"] !== false;
      const profileId = activeProfileId(api);
      if (enable && profileId !== undefined) {
        api.store?.dispatch(actions.setModEnabled(profileId, vortexModId, true));
        if (enabledMap(api, profileId)[vortexModId]?.enabled !== true) {
          throw new ControlError("enable-unverified", `Mod ${vortexModId} installed, but Vortex did not enable it.`, 500, {
            vortexModId,
            installed: true,
          });
        }
      }
      return {
        gameId,
        vortexModId,
        name: modName(m),
        version: str(m.attributes?.["version"]),
        enabled: enable,
        deployNeeded: true,
        verified: { inPool: true, state: m.state, enabledIn: enable ? profileId : undefined },
      };
    },
    describe: (_b, r) => `installed ${String(r["name"] ?? r["vortexModId"])}`,
  },
};
