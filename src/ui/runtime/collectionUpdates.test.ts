/**
 * Update: find the revision, resolve its address, download it through Vortex
 * with the revision recorded on the download, and open Event Horizon's install.
 *
 * The fake reproduces Vortex 2.6.3's event shapes: `emitAndAwait` resolves to
 * an array of handler results, `start-download` answers through a node-style
 * callback (and with an `AlreadyDownloaded` error for a file it has), and a
 * download record is `{ localPath, game, modInfo, state }`.
 */
import { EventEmitter } from "events";
import * as path from "path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  downloadRevision,
  getCollectionUpdateStore,
  pendingUpdateFor,
  startCollectionUpdate,
  type UpdateDeps,
} from "./collectionUpdates";
import { getEHRuntime } from "./ehRuntime";
import type { CollectionUpdate } from "../../core/nexus/collectionUpdates";

const DIR = path.join("D:", "Vortex", "vortexDownload", "fallout4");

const update = (packageId = "pkg-1"): CollectionUpdate => ({
  packageId,
  packageName: "Ivy's Panties",
  gameId: "fallout4",
  installed: { slug: "tumkz9", revisionNumber: 12, gameDomain: "fallout4", collectionId: 350133 },
  latestRevision: 13,
});

type StartDownloadCall = { uris: unknown; modInfo: any; fileName: unknown; redownload: unknown; options: unknown };

function fakeApi(opts: {
  revision?: unknown;
  urls?: unknown;
  startDownload?: (call: StartDownloadCall, cb: (err: unknown, id?: string) => void) => void;
  files?: Record<string, unknown>;
  activeGameId?: string;
  loggedIn?: boolean;
} = {}) {
  const events = new EventEmitter();
  const calls: StartDownloadCall[] = [];
  events.on("start-download", (uris, modInfo, fileName, cb, redownload, options) => {
    const call = { uris, modInfo, fileName, redownload, options };
    calls.push(call);
    (opts.startDownload ?? ((_c, done) => done(null, "dl-new")))(call, cb);
  });
  const notifications: Array<Record<string, unknown>> = [];
  const api = {
    events,
    getState: () => ({
      settings: { profiles: { activeGameId: opts.activeGameId ?? "fallout4" } },
      persistent: {
        nexus: opts.loggedIn === false ? {} : { userInfo: { name: "player" } },
        downloads: { files: opts.files ?? {} },
      },
    }),
    emitAndAwait: async (event: string, ..._args: unknown[]) => {
      if (event === "get-nexus-collection-revision") return opts.revision === undefined ? [] : [opts.revision];
      if (event === "resolve-collection-url") return opts.urls === undefined ? [] : [opts.urls];
      return [];
    },
    sendNotification: (n: Record<string, unknown>) => {
      notifications.push(n);
      return String(n.id);
    },
    dismissNotification: vi.fn(),
  };
  return { api: api as never, calls, notifications };
}

const REVISION = {
  id: 9001,
  revisionNumber: 13,
  downloadLink: "/v2/collections/350133/revisions/9001/download_link",
  collection: { id: 350133, name: "Ivy's Panties" },
};
const URLS = [{ URI: "https://cf-files.nexus-cdn.com/collections/ivy-rev13.zip", Name: "CDN" }];

const deps = (over: Partial<UpdateDeps> = {}): UpdateDeps => ({
  waitForDownload: async () => ({ localPath: "Ivy's Panties-rev13.zip" }),
  downloadDirFor: () => DIR,
  openInstall: vi.fn(async () => undefined),
  ...over,
});

afterEach(() => {
  getEHRuntime().setInstallBusy(false);
});

describe("downloading a newer revision", () => {
  it("downloads through Vortex with the revision on the download, and never lets Vortex install it", async () => {
    /**
     * The revision on the download is what the NEXT receipt reads; without it
     * an updated install would become a file install and never be offered
     * another update. `allowInstall: false` keeps Vortex's bulk installer out.
     */
    const { api, calls } = fakeApi({ revision: REVISION, urls: URLS });
    const archivePath = await downloadRevision(api, update(), deps(), () => undefined);

    expect(archivePath).toBe(path.join(DIR, "Ivy's Panties-rev13.zip"));
    expect(calls).toHaveLength(1);
    expect(calls[0]!.uris).toEqual(["https://cf-files.nexus-cdn.com/collections/ivy-rev13.zip"]);
    expect(calls[0]!.fileName).toBe("Ivy's Panties-rev13.zip");
    expect(calls[0]!.redownload).toBe("never");
    expect(calls[0]!.options).toEqual({ allowInstall: false });
    expect(calls[0]!.modInfo.nexus.ids).toEqual({
      gameId: "fallout4",
      collectionId: 350133,
      collectionSlug: "tumkz9",
      revisionId: 9001,
      revisionNumber: 13,
    });
  });

  it("uses the file Vortex already has for that revision", async () => {
    const { api } = fakeApi({
      revision: REVISION,
      urls: URLS,
      files: { "dl-old": { localPath: "Ivy's Panties-rev13.zip" } },
      startDownload: (_call, cb) => cb(Object.assign(new Error("exists"), { name: "AlreadyDownloaded", fileName: "Ivy's Panties-rev13.zip" })),
    });
    const seen: string[] = [];
    await downloadRevision(api, update(), deps({
      waitForDownload: async (_api, id) => {
        seen.push(id);
        return { localPath: "Ivy's Panties-rev13.zip" };
      },
    }), () => undefined);
    expect(seen).toEqual(["dl-old"]);
  });

  it("says so when Nexus does not return the revision", async () => {
    const { api, calls } = fakeApi({ urls: URLS });
    await expect(downloadRevision(api, update(), deps(), () => undefined)).rejects.toThrow(/did not return revision 13/);
    expect(calls).toHaveLength(0);
  });

  it("says so when Nexus gives no download address", async () => {
    const { api, calls } = fakeApi({ revision: REVISION, urls: [] });
    await expect(downloadRevision(api, update(), deps(), () => undefined)).rejects.toThrow(/no download address/);
    expect(calls).toHaveLength(0);
  });

  it("makes a safe file name out of any collection name", async () => {
    const { api, calls } = fakeApi({
      revision: { ...REVISION, collection: { id: 1, name: 'Ivy: "Panties" / FO4?' } },
      urls: URLS,
    });
    await downloadRevision(api, update(), deps(), () => undefined);
    expect(calls[0]!.fileName).toBe("Ivy_ _Panties_ _ FO4_-rev13.zip");
  });
});

describe("pressing Update", () => {
  it("opens Event Horizon's install on the downloaded revision", async () => {
    const { api } = fakeApi({ revision: REVISION, urls: URLS });
    const d = deps();
    expect(await startCollectionUpdate(api, update("pkg-open"), d)).toBe("opened");
    expect(d.openInstall).toHaveBeenCalledWith(api, path.join(DIR, "Ivy's Panties-rev13.zip"));
  });

  it("refuses while an install is running, and downloads nothing", async () => {
    getEHRuntime().setInstallBusy(true);
    const { api, calls, notifications } = fakeApi({ revision: REVISION, urls: URLS });
    expect(await startCollectionUpdate(api, update("pkg-busy"), deps())).toBe("refused");
    expect(calls).toHaveLength(0);
    expect(String(notifications[0]?.message)).toMatch(/install is running/);
  });

  it("refuses for a collection of a game Vortex is not managing", async () => {
    const { api, calls } = fakeApi({ revision: REVISION, urls: URLS, activeGameId: "skyrimse" });
    expect(await startCollectionUpdate(api, update("pkg-game"), deps())).toBe("refused");
    expect(calls).toHaveLength(0);
  });

  it("refuses while Vortex is logged out", async () => {
    const { api, calls } = fakeApi({ revision: REVISION, urls: URLS, loggedIn: false });
    expect(await startCollectionUpdate(api, update("pkg-login"), deps())).toBe("refused");
    expect(calls).toHaveLength(0);
  });

  it("tells the player what failed instead of failing quietly", async () => {
    const { api, notifications } = fakeApi({ urls: URLS });
    const d = deps();
    expect(await startCollectionUpdate(api, update("pkg-fail"), d)).toBe("failed");
    expect(d.openInstall).not.toHaveBeenCalled();
    const error = notifications.find((n) => n.type === "error");
    expect(String(error?.message)).toMatch(/Ivy's Panties: Nexus did not return revision 13/);
  });
});

describe("what the checks found", () => {
  const answered = (...slugs: string[]) => new Set(slugs);

  it("replaces one game's updates and keeps the other game's", () => {
    const store = getCollectionUpdateStore();
    const skyrim = { ...update("pkg-skyrim"), gameId: "skyrimse" };
    store.replaceForGame("skyrimse", [skyrim], answered("tumkz9"));
    store.replaceForGame("fallout4", [update("pkg-fo4")], answered("tumkz9"));
    // Nexus answered for this game and said it is current.
    store.replaceForGame("fallout4", [], answered("tumkz9"));
    expect([...store.all().keys()]).toEqual(["pkg-skyrim"]);
    store.replaceForGame("skyrimse", [], answered("tumkz9"));
  });

  /**
   * The failure this exists for: a startup check finds revision 13 and shows
   * an Update button; ten minutes later a page visit re-checks, Nexus 503s or
   * the session has lapsed, and the button silently disappears with nothing
   * saying a check failed. Unknown is not "up to date" — the curator side of
   * this product already refuses that conflation, and the player cannot go
   * and look for themselves.
   */
  it("KEEPS a known update when the re-check could not ask about it", () => {
    const store = getCollectionUpdateStore();
    store.replaceForGame("fallout4", [update("pkg-fo4")], answered("tumkz9"));
    // Nothing answered: not logged in, offline, or a 503.
    store.replaceForGame("fallout4", [], answered());
    expect([...store.all().keys()]).toEqual(["pkg-fo4"]);
    store.replaceForGame("fallout4", [], answered("tumkz9"));
    expect([...store.all().keys()]).toEqual([]);
  });

  it("only keeps the slugs that went unanswered, not the whole game", () => {
    const store = getCollectionUpdateStore();
    const other = {
      ...update("pkg-other"),
      installed: { ...update("pkg-other").installed, slug: "kqrokq" },
    };
    store.replaceForGame("fallout4", [update("pkg-fo4"), other], answered("tumkz9", "kqrokq"));
    // One answered and current, the other not answered at all.
    store.replaceForGame("fallout4", [], answered("tumkz9"));
    expect([...store.all().keys()]).toEqual(["pkg-other"]);
    store.replaceForGame("fallout4", [], answered("kqrokq"));
  });
});

describe("the update a card offers", () => {
  const receiptAt = (revisionNumber?: number) =>
    ({
      packageId: "pkg-card",
      ...(revisionNumber !== undefined
        ? { nexusCollection: { slug: "tumkz9", revisionNumber, gameDomain: "fallout4" } }
        : {}),
    }) as never;

  it("is offered while the installed revision is older", () => {
    expect(pendingUpdateFor(receiptAt(12), update("pkg-card"))?.latestRevision).toBe(13);
  });

  it("disappears once that revision is installed, without waiting for the next check", () => {
    expect(pendingUpdateFor(receiptAt(13), update("pkg-card"))).toBeUndefined();
  });

  it("is never offered to a file install, or for another collection", () => {
    expect(pendingUpdateFor(receiptAt(), update("pkg-card"))).toBeUndefined();
    const other = { ...update("pkg-card"), installed: { ...update("pkg-card").installed, slug: "kqrokq" } };
    expect(pendingUpdateFor(receiptAt(12), other)).toBeUndefined();
  });
});

describe("when Vortex never accepts the download", () => {
  it("gives up after a minute instead of leaving Update pending forever", async () => {
    /**
     * `emit` returns nothing, so the callback is the only thing that can
     * settle this. A `start-download` nobody answers used to leave the Update
     * button waiting with no error and no notification.
     *
     * Short on purpose: this waits only for Vortex to ACCEPT the download and
     * hand back an id. The transfer itself is waited on separately and may
     * take as long as the file takes.
     */
    const events = new EventEmitter();
    events.on("get-nexus-collection-revision", () => undefined);
    const api = {
      events,
      getState: () => ({ persistent: { downloads: { files: {} } } }),
      emitAndAwait: async (event: string) =>
        event === "get-nexus-collection-revision"
          ? [{ id: 1, revisionNumber: 13, downloadLink: "https://nexus/dl", collection: { id: 350133, name: "Ivy" } }]
          : [[{ URI: "https://cf-files.nexus-cdn.com/x.zip" }]],
    } as never;

    vi.useFakeTimers();
    try {
      const p = downloadRevision(api, update(), deps(), () => undefined);
      const assertion = expect(p).rejects.toThrow(/did not start the download within 60s/);
      await vi.advanceTimersByTimeAsync(61_000);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });
});

/**
 * ──────────────────────────────────────────────────────────────────────
 * The download takes minutes, and "no install is running" stops being true.
 *
 * `openInstall` calls `pickFile`, which resets the install wizard. Doing that
 * mid-run leaves the other install executing against the state it captured
 * while the wizard shows this collection's preview — its progress and its
 * result are both dropped, because the session is no longer in the state that
 * accepts them. The player sees a run that never finishes next to an install
 * page that is not the one running, and presses Install again.
 * ──────────────────────────────────────────────────────────────────────
 */
describe("an install that starts while the update downloads", () => {
  it("refuses to hijack the wizard, and keeps the downloaded file", async () => {
    const { api } = fakeApi({ revision: REVISION, urls: URLS });
    const d = deps({
      // The install begins while this "download" is in flight.
      waitForDownload: vi.fn(async () => {
        getEHRuntime().setInstallBusy(true);
        return { localPath: "Ivy's Panties-rev13.zip" };
      }),
    });

    expect(await startCollectionUpdate(api, update("pkg-busy"), d)).toBe(
      "refused",
    );
    expect(d.openInstall).not.toHaveBeenCalled();
  });

  it("still opens the install when nothing else started", async () => {
    // The guard must not fire on the ordinary path.
    const { api } = fakeApi({ revision: REVISION, urls: URLS });
    const d = deps();
    expect(await startCollectionUpdate(api, update("pkg-free"), d)).toBe(
      "opened",
    );
    expect(d.openInstall).toHaveBeenCalled();
  });
});
