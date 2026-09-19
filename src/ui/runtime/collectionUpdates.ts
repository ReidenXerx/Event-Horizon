/**
 * Collection updates for players: the check, what it found, and Update.
 *
 * Owner decision 2026-09-16: when Vortex starts, Event Horizon checks every
 * collection installed from a Nexus collection page; a newer published
 * revision gets a Vortex notification with Update, and the collection's card
 * shows the same button. Nothing else is checked (see core/nexus/
 * collectionUpdates.ts).
 *
 * ─── WHAT UPDATE DOES ──────────────────────────────────────────────────
 * The same three steps Vortex's own collection update takes, through the same
 * public events — find the revision, resolve its download address, download
 * it — and then, instead of Vortex's rule diff (a bulk install, which loses
 * files), the file goes to Event Horizon's install page. A new version installs
 * into its own profile and the old one stays switchable, so Update never
 * changes the player's working setup until they press Install.
 *
 * The download is registered with the revision on it (`modInfo.nexus.ids`),
 * exactly as the website's Install registers one, which is what lets the
 * receipt of the install that follows record the new revision in turn.
 */

import * as path from "path";

import { selectors, type types } from "@nexusmods/vortex-api";

import { listReceipts } from "../../core/installLedger";
import { ehLog } from "../../core/logging/ehLog";
import { findCollectionUpdates, type CollectionUpdate } from "../../core/nexus/collectionUpdates";
import { isLoggedInToNexus } from "../../core/nexus/collectionUpload";
import { getVortexUserDataPath } from "../../core/paths/appDataPaths";
import type { InstallReceipt } from "../../types/installLedger";
import { getEHRuntime } from "./ehRuntime";
import { getRouteRequest } from "./routeRequest";

export type CollectionUpdateListener = (updates: ReadonlyMap<string, CollectionUpdate>) => void;

/** What the last checks found, by package id, for the cards to show. */
class CollectionUpdateStore {
  private updates = new Map<string, CollectionUpdate>();
  private readonly checkedAt = new Map<string, number>();
  private readonly listeners = new Set<CollectionUpdateListener>();

  all(): ReadonlyMap<string, CollectionUpdate> {
    return this.updates;
  }

  lastCheckedAt(gameId: string): number {
    return this.checkedAt.get(gameId) ?? 0;
  }

  /**
   * Replace one game's results; other games' stay as they were checked.
   *
   * ─── ONLY WHAT WAS ANSWERED IS REPLACED ────────────────────────────
   * This dropped every prior result for the game and wrote the new list over
   * it, which is correct only when the new list is an ANSWER. An empty list
   * also comes back when Nexus could not be asked — logged out, offline, a
   * 503 — so a failed re-check silently removed an Update button that a
   * successful check had put there, and nothing on screen said a check had
   * failed. Unknown is not "up to date".
   *
   * `answeredSlugs` names the collections Nexus actually answered for. A
   * previously-found update for a slug that was NOT answered is kept exactly
   * as it was: the last thing anybody actually established.
   */
  replaceForGame(
    gameId: string,
    updates: readonly CollectionUpdate[],
    answeredSlugs: ReadonlySet<string>,
    at = Date.now(),
  ): void {
    const next = new Map(
      [...this.updates].filter(
        ([, u]) =>
          u.gameId !== gameId || !answeredSlugs.has(u.installed.slug),
      ),
    );
    for (const u of updates) next.set(u.packageId, u);
    this.updates = next;
    this.checkedAt.set(gameId, at);
    for (const listener of this.listeners) {
      try {
        listener(this.updates);
      } catch {
        /* one bad subscriber must not poison the others */
      }
    }
  }

  subscribe(listener: CollectionUpdateListener): () => void {
    this.listeners.add(listener);
    return (): void => {
      this.listeners.delete(listener);
    };
  }
}

let store: CollectionUpdateStore | undefined;

export function getCollectionUpdateStore(): CollectionUpdateStore {
  if (store === undefined) store = new CollectionUpdateStore();
  return store;
}

/**
 * The update to offer on this receipt's card, if it still applies.
 *
 * A check's result outlives the install it prompted: after updating to
 * revision 13 the receipt says 13 while the last check still says "13 is
 * newer". Judged against the receipt as it is now, the button disappears the
 * moment the update is installed, instead of at the next check.
 */
export function pendingUpdateFor(
  receipt: InstallReceipt,
  update: CollectionUpdate | undefined,
): CollectionUpdate | undefined {
  const installed = receipt.nexusCollection;
  if (update === undefined || installed === undefined) return undefined;
  if (installed.slug !== update.installed.slug) return undefined;
  return update.latestRevision > installed.revisionNumber ? update : undefined;
}

/** A page visit re-asks Nexus at most this often; startup always asks. */
const RECHECK_AFTER_MS = 10 * 60 * 1000;

/**
 * Check the active game's collections, remember what was found, and — when
 * `notify` — tell the player through Vortex's notifications.
 */
export async function checkCollectionUpdates(
  api: types.IExtensionApi,
  options: { notify: boolean; force?: boolean },
): Promise<CollectionUpdate[]> {
  const updates = getCollectionUpdateStore();
  const gameId = selectors.activeGameId(api.getState());
  if (typeof gameId !== "string" || gameId === "") return [];
  if (options.force !== true && Date.now() - updates.lastCheckedAt(gameId) < RECHECK_AFTER_MS) {
    return [...updates.all().values()].filter((u) => u.gameId === gameId);
  }
  const receipts = (await listReceipts(getVortexUserDataPath())).filter((r) => r.gameId === gameId);
  const { updates: found, answeredSlugs } = await findCollectionUpdates(api, receipts);
  updates.replaceForGame(gameId, found, answeredSlugs);
  const trackedSlugs = new Set(
    receipts
      .map((r) => r.nexusCollection?.slug)
      .filter((slug): slug is string => slug !== undefined),
  );
  const unanswered = [...trackedSlugs].filter((slug) => !answeredSlugs.has(slug));
  ehLog("info", "collection-updates.found", {
    gameId,
    receipts: receipts.length,
    tracked: trackedSlugs.size,
    updates: found.map((u) => `${u.installed.slug} ${u.installed.revisionNumber}→${u.latestRevision}`),
    // Not "up to date": Nexus did not answer for these, so whatever was known
    // about them before still stands.
    unanswered,
  });
  if (options.notify) {
    for (const update of found) notifyUpdate(api, update);
  }
  return found;
}

function notifyUpdate(api: types.IExtensionApi, update: CollectionUpdate): void {
  api.sendNotification?.({
    id: `eh-collection-update-${update.packageId}`,
    type: "info",
    title: "Collection update",
    message:
      `${update.packageName}: revision ${update.latestRevision} is on Nexus ` +
      `(you have revision ${update.installed.revisionNumber}).`,
    actions: [
      {
        title: "Update",
        action: (dismiss: () => void) => {
          dismiss();
          void startCollectionUpdate(api, update);
        },
      },
    ],
  });
}

/** What Update needs from outside, replaceable in tests. */
export type UpdateDeps = {
  waitForDownload: (
    api: types.IExtensionApi,
    downloadId: string,
    signal: AbortSignal,
    onProgress: (received: number, total: number | undefined) => void,
    options: { fileName?: string; retry?: string },
  ) => Promise<{ localPath?: unknown }>;
  downloadDirFor: (api: types.IExtensionApi, gameId: string) => string | undefined;
  openInstall: (api: types.IExtensionApi, archivePath: string) => Promise<void>;
};

const defaultDeps: UpdateDeps = {
  waitForDownload: async (api, downloadId, signal, onProgress, options) => {
    const { waitForVortexDownload } = await import("../pages/install/fetchLink");
    return waitForVortexDownload(api, downloadId, signal, onProgress, options);
  },
  downloadDirFor: (api, gameId) => selectors.downloadPathForGame(api.getState(), gameId),
  openInstall: async (api, archivePath) => {
    const { getInstallSession } = await import("../pages/install/installSession");
    getInstallSession().pickFile(api, archivePath);
    getRouteRequest().request("install");
    api.events.emit("show-main-page", "event-horizon");
  },
};

const inFlight = new Set<string>();

/**
 * Download the newer revision and open Event Horizon's install on it.
 * Resolves when the install page has the file, or when it could not; every
 * outcome the player needs to know about is a notification.
 */
export async function startCollectionUpdate(
  api: types.IExtensionApi,
  update: CollectionUpdate,
  deps: UpdateDeps = defaultDeps,
): Promise<"opened" | "refused" | "failed"> {
  const notifyId = `eh-collection-update-${update.packageId}`;
  const refuse = (message: string): "refused" => {
    ehLog("info", "collection-update.refused", { packageId: update.packageId, message });
    api.sendNotification?.({ id: notifyId, type: "warning", title: "Collection update", message });
    return "refused";
  };

  if (inFlight.has(update.packageId)) return "refused";
  if (getEHRuntime().getSnapshot().installBusy) {
    return refuse("An install is running. Update when it has finished.");
  }
  if (selectors.activeGameId(api.getState()) !== update.gameId) {
    return refuse(`Switch Vortex to the game ${update.packageName} is for, then press Update again.`);
  }
  if (!isLoggedInToNexus(api.getState())) {
    return refuse("Vortex is not logged in to Nexus. Log in from Vortex's header, then press Update again.");
  }

  inFlight.add(update.packageId);
  const progressId = `eh-collection-update-download-${update.packageId}`;
  try {
    const archivePath = await downloadRevision(api, update, deps, (received, total) => {
      api.sendNotification?.({
        id: progressId,
        type: "activity",
        title: "Downloading collection update",
        message: `${update.packageName}, revision ${update.latestRevision}`,
        ...(total !== undefined && total > 0 ? { progress: Math.floor((received / total) * 100) } : {}),
      });
    });
    api.dismissNotification?.(progressId);
    /**
     * ─── CHECKED AGAIN, BECAUSE THE DOWNLOAD TOOK MINUTES ───────────────
     * The check before the download is the one that matters for "is it sane
     * to start", and it stops being true while the download runs — a
     * collection revision is hundreds of megabytes, and the player is free
     * to start installing something else in the meantime.
     *
     * `openInstall` calls `pickFile`, which resets the install wizard. Doing
     * that mid-run leaves the other install executing against the state it
     * captured while the wizard shows this collection's preview: its
     * progress and its result are both dropped, because the session is no
     * longer in the state that accepts them. The player sees a run that
     * never finishes and an install page that is not the one running, and
     * the obvious response — press Install again — is the worst one.
     *
     * The download is not wasted: it is in Vortex's download folder, so
     * pressing Update again once the other install has finished finds it
     * there rather than fetching it twice.
     */
    if (getEHRuntime().getSnapshot().installBusy) {
      return refuse(
        "An install started while this update was downloading. The file is " +
          "in your downloads — press Update again once that install has " +
          "finished.",
      );
    }
    await deps.openInstall(api, archivePath);
    ehLog("info", "collection-update.opened", {
      packageId: update.packageId,
      slug: update.installed.slug,
      from: update.installed.revisionNumber,
      to: update.latestRevision,
      archivePath,
    });
    return "opened";
  } catch (err) {
    api.dismissNotification?.(progressId);
    const message = err instanceof Error ? err.message : String(err);
    ehLog("warn", "collection-update.failed", { packageId: update.packageId, message });
    api.sendNotification?.({
      id: notifyId,
      type: "error",
      title: "Collection update failed",
      message: `${update.packageName}: ${message}`,
    });
    return "failed";
  } finally {
    inFlight.delete(update.packageId);
  }
}

type IDownloadUrl = { URI?: unknown };

/** The revision's file in Vortex's download folder, downloading it if needed. */
export async function downloadRevision(
  api: types.IExtensionApi,
  update: CollectionUpdate,
  deps: Pick<UpdateDeps, "waitForDownload" | "downloadDirFor">,
  onProgress: (received: number, total: number | undefined) => void,
): Promise<string> {
  const { slug, gameDomain } = update.installed;
  const revisions = (await api.emitAndAwait("get-nexus-collection-revision", slug, update.latestRevision)) as unknown[];
  const revision = revisions?.[0] as {
    id?: unknown;
    revisionNumber?: unknown;
    downloadLink?: unknown;
    collection?: { id?: unknown; name?: unknown };
  } | undefined;
  if (revision === undefined || typeof revision.downloadLink !== "string" || revision.downloadLink === "") {
    throw new Error(`Nexus did not return revision ${update.latestRevision}. Check Vortex's notifications, then press Update again.`);
  }

  const resolved = (await api.emitAndAwait("resolve-collection-url", revision.downloadLink)) as unknown[];
  const uris = (Array.isArray(resolved?.[0]) ? (resolved[0] as IDownloadUrl[]) : [])
    .map((u) => u?.URI)
    .filter((u): u is string => typeof u === "string" && u !== "");
  if (uris.length === 0) {
    throw new Error(`Nexus gave no download address for revision ${update.latestRevision}. Press Update again later.`);
  }

  const name = typeof revision.collection?.name === "string" ? revision.collection.name : update.packageName;
  const fileName = `${safeFileName(name)}-rev${update.latestRevision}.zip`;
  const modInfo = {
    game: update.gameId,
    source: "nexus",
    name,
    nexus: {
      ids: {
        gameId: gameDomain,
        collectionId: revision.collection?.id ?? update.installed.collectionId,
        collectionSlug: slug,
        revisionId: revision.id,
        revisionNumber: typeof revision.revisionNumber === "number" ? revision.revisionNumber : update.latestRevision,
      },
      revisionInfo: revision,
    },
  };

  let downloadId: string;
  try {
    downloadId = await new Promise<string>((resolve, reject) => {
      /**
       * This waits only for Vortex to ACCEPT the download and hand back an id
       * — the transfer itself is waited on separately, and is allowed to take
       * as long as the file takes. So a short budget is right here, and its
       * absence was the failure shape: `emit` returns nothing, so a callback
       * that never comes left Update pending forever with no error.
       */
      const ACCEPT_MS = 60_000;
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(
          new Error(
            "Vortex did not start the download within 60s. Check its " +
              "notifications, then press Update again.",
          ),
        );
      }, ACCEPT_MS);
      api.events.emit(
        "start-download",
        uris,
        modInfo,
        fileName,
        (err: unknown, id?: string) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          if (err) reject(err);
          else resolve(id as string);
        },
        "never",
        { allowInstall: false },
      );
    });
  } catch (err) {
    // Downloaded before — by an earlier Update, or the website's Install —
    // and still in Vortex's list: use that file, the way Vortex's own update does.
    const e = err as { name?: unknown; fileName?: unknown };
    const files = (api.getState() as { persistent?: { downloads?: { files?: Record<string, { localPath?: unknown }> } } })
      ?.persistent?.downloads?.files ?? {};
    const existing = e?.name === "AlreadyDownloaded" ? Object.keys(files).find((id) => files[id]?.localPath === e.fileName) : undefined;
    if (existing === undefined) throw err;
    downloadId = existing;
  }

  const download = await deps.waitForDownload(api, downloadId, new AbortController().signal, onProgress, {
    fileName,
    retry: "press Update again",
  });
  const dir = deps.downloadDirFor(api, update.gameId);
  if (typeof dir !== "string" || dir === "" || typeof download.localPath !== "string") {
    throw new Error("Vortex did not say where it saved the download. Look in its Downloads tab.");
  }
  return path.join(dir, download.localPath);
}

function safeFileName(name: string): string {
  const cleaned = name.replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").trim();
  return cleaned === "" ? "collection" : cleaned;
}

/** How long after Vortex starts to check, so its Nexus login has settled. */
const STARTUP_DELAY_MS = 30_000;

/**
 * Check at startup and whenever the player switches game.
 *
 * Debounced: Vortex raises `gamemode-activated` while it starts, too, and two
 * checks seconds apart would ask Nexus twice for nothing.
 */
export function watchCollectionUpdates(api: types.IExtensionApi): void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const later = (why: string): void => {
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      checkCollectionUpdates(api, { notify: true, force: true }).catch((err: unknown) => {
        ehLog("warn", "collection-updates.check-failed", { why, err });
      });
    }, STARTUP_DELAY_MS);
  };
  later("startup");
  api.events.on("gamemode-activated", () => later("game switched"));
}
