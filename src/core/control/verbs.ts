/**
 * What the control channel can do. One entry per verb; the server routes
 * `POST /v1/<verb>` here and runs them one at a time.
 *
 * Every verb reuses the wrapper Event Horizon's own installer already relies
 * on (deployAndWait, switchToProfile, purgeGameDeployment, uninstallMods, the
 * install primitives), so the channel inherits their scars rather than
 * relearning them: deploy-mods takes its callback FIRST, a profile switch is
 * confirmed by state when its event is missed, a purge is bounded because
 * nothing else can settle it.
 *
 * Mutating verbs pass through `guards.ts` first. Removal is allowed (owner,
 * 2026-09-26) but only of the exact ids named, and every reply says which of
 * them Event Horizon installed: the NS-2 question is answered in the reply
 * even where the owner has chosen to override it.
 */

import * as fs from "fs";
import * as path from "path";
import { actions, util } from "@nexusmods/vortex-api";
import type { types } from "@nexusmods/vortex-api";

import { gameExecutable, purgeGameDeployment, readDiscovery } from "../environment/vortexEnvironment";
import { getActiveGameId } from "../getModsListForProfile";
import { deployAndWait } from "../installer/runInstall";
import { switchToProfile } from "../installer/profile";
import { installFromExistingDownload, installNexusViaApi, uninstallMods } from "../installer/modInstall";
import type { VortexInstallerChoices } from "../installer/installerChoices";
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
  ) {
    super(message);
  }
}

export type VerbBody = Record<string, unknown>;
export type Verb = {
  /** Changes the owner's setup: shown as a Vortex notification when it succeeds. */
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

type ModRecord = { id: string; type?: string; state?: string; archiveId?: string; attributes?: Record<string, unknown> };

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

async function purge(api: types.IExtensionApi, gameId: string): Promise<number | undefined> {
  if (getActiveGameId(api.getState()) !== gameId) {
    throw new ControlError("game-changed", "Vortex switched games before the purge; nothing was purged.", 409);
  }
  await purgeGameDeployment(api, { timeoutMs: budget(api) });
  return deployedFileCount(api, gameId);
}

async function deploy(api: types.IExtensionApi): Promise<string> {
  const profileId = activeProfileId(api);
  if (profileId === undefined) throw new ControlError("no-profile", "Vortex has no active profile.", 409);
  await deployAndWait(api, profileId);
  return profileId;
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
  return { gameId, previousPath: before.path, previousStore: before.store, path: after.path, store: after.store };
}

// ─── the verbs ─────────────────────────────────────────────────────────────

export const VERBS: Record<string, Verb> = {
  state: {
    mutates: false,
    run: async (api) => {
      const state = api.getState();
      const gameId = getActiveGameId(state);
      if (gameId === undefined) return { gameId: null };
      const discovery = readDiscovery(state, gameId);
      const profileId = activeProfileId(api);
      const prof = profiles(api);
      const modState = profileId !== undefined ? (prof[profileId]?.modState ?? {}) : {};
      const pool = modPool(api, gameId);
      const owner = await ownership(gameId, Object.keys(pool));
      const running = await gameRunning(api, gameId);
      const downloads = (state as unknown as { persistent?: { downloads?: { files?: Record<string, Record<string, unknown>> } } })
        .persistent?.downloads?.files ?? {};
      return {
        gameId,
        game: { path: discovery.path, store: discovery.store, executable: running.exe, running: running.running },
        profile: profileId !== undefined ? { id: profileId, name: prof[profileId]?.name } : null,
        profiles: Object.values(prof)
          .filter((p) => p.gameId === gameId)
          .map((p) => ({ id: p.id, name: p.name })),
        deployment: {
          needed: (state as { persistent?: { deployment?: { needToDeploy?: Record<string, boolean> } } }).persistent
            ?.deployment?.needToDeploy?.[gameId] === true,
          deployedFiles: await deployedFileCount(api, gameId),
        },
        mods: Object.values(pool).map((m) => {
          const a = m.attributes ?? {};
          return {
            id: m.id,
            name: modName(m),
            version: str(a["version"]),
            enabled: modState[m.id]?.enabled === true,
            type: m.type || undefined,
            nexus: a["modId"] !== undefined ? { modId: a["modId"], fileId: a["fileId"] } : undefined,
            source: str(a["source"]),
            archiveId: m.archiveId,
            owner: owner[m.id],
          };
        }),
        plugins: readPluginList(state).map((p) => ({
          name: p.name,
          enabled: p.enabled,
          loadOrder: p.loadOrder,
          modId: p.modId,
          native: p.isNative || undefined,
        })),
        downloads: Object.entries(downloads)
          .filter(([, d]) => ((d["game"] as string[] | undefined) ?? []).includes(gameId))
          .map(([id, d]) => ({
            id,
            fileName: d["localPath"],
            state: d["state"],
            nexus: (d["modInfo"] as { nexus?: { ids?: unknown } } | undefined)?.nexus?.ids,
          })),
      };
    },
  },

  purge: {
    mutates: true,
    run: async (api, body) => {
      const gameId = activeGame(api);
      await guardClosed(api, gameId, body);
      const left = await purge(api, gameId);
      return { gameId, deployedFilesAfter: left };
    },
    describe: (_b, r) => `purged ${String(r["gameId"])}`,
  },

  deploy: {
    mutates: true,
    run: async (api, body) => {
      const gameId = activeGame(api);
      await guardClosed(api, gameId, body);
      const profileId = await deploy(api);
      return { gameId, profileId, deployedFiles: await deployedFileCount(api, gameId) };
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
        throw new ControlError("not-applied", `Vortex did not apply the change for: ${notApplied.join(", ")}.`, 500);
      }
      return { profileId: profile.id, enabled: body["enabled"], modIds: ids, deployNeeded: true };
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
      const removed = ids.map((id) => ({ id, name: modName(pool[id]!), owner: owner[id] }));
      await uninstallMods(api, { gameId, modIds: ids });
      const still = ids.filter((id) => modPool(api, gameId)[id] !== undefined);
      return { gameId, removed: removed.filter((r) => !still.includes(r.id)), notRemoved: still };
    },
    describe: (_b, r) => `removed ${(r["removed"] as unknown[]).length} mod(s)`,
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
      return { profileId, name: target.name, gameId: target.gameId };
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
   * before the next; a failure names the step and what state it left.
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
          const e = err instanceof ControlError ? err : new ControlError("step-failed", String((err as Error)?.message ?? err), 500);
          throw new ControlError(e.code, `${name} failed after [${steps.join(" -> ") || "nothing"}]: ${e.message}`, e.status);
        }
      };
      const left = await step("purge", () => purge(api, gameId));
      if (left !== 0) {
        throw new ControlError("not-purged", `purge left ${left ?? "an unknown number of"} files deployed; stopped before repointing.`, 409);
      }
      const moved = await step("setPath", () => setGamePath(api, gameId, body));
      await step("profile", () => switchToProfile(api, profileId));
      await step("deploy", () => deploy(api));
      return { ...moved, profileId, steps, deployedFiles: await deployedFileCount(api, gameId) };
    },
    describe: (_b, r) => `switched ${String(r["gameId"])} to ${String(r["path"])}`,
  },

  /**
   * Installs into the active game, from Nexus (`nexus: {modId, fileId}`) or
   * from a download Vortex already has (`archiveId`). Without `choices`, a
   * FOMOD installer shows its dialog in Vortex and this waits for it.
   */
  install: {
    mutates: true,
    run: async (api, body) => {
      const gameId = activeGame(api);
      const choices = body["choices"] as VortexInstallerChoices | undefined;
      const unattended = body["unattended"] === true;
      const nexus = body["nexus"] as { modId?: unknown; fileId?: unknown } | undefined;
      let vortexModId: string;
      if (nexus !== undefined) {
        if (typeof nexus.modId !== "number" || typeof nexus.fileId !== "number") {
          throw new ControlError("bad-request", `"nexus" needs numeric modId and fileId.`);
        }
        ({ vortexModId } = await installNexusViaApi(api, {
          gameId,
          nexusModId: nexus.modId,
          nexusFileId: nexus.fileId,
          ...(choices !== undefined ? { choices } : {}),
          unattended,
        }));
      } else {
        const archiveId = need(body, "archiveId");
        ({ vortexModId } = await installFromExistingDownload(api, {
          gameId,
          archiveId,
          ...(choices !== undefined ? { choices } : {}),
          unattended,
        }));
      }
      const enable = body["enable"] !== false;
      const profileId = activeProfileId(api);
      if (enable && profileId !== undefined) api.store?.dispatch(actions.setModEnabled(profileId, vortexModId, true));
      const m = modPool(api, gameId)[vortexModId];
      return { gameId, vortexModId, name: m ? modName(m) : undefined, enabled: enable, deployNeeded: true };
    },
    describe: (_b, r) => `installed ${String(r["name"] ?? r["vortexModId"])}`,
  },
};
