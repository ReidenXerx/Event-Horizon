/**
 * Uploading a package to a Nexus collection, through Vortex.
 *
 * Event Horizon never talks to Nexus's upload API itself. Vortex's Nexus
 * integration already does all of it for its own collections — the upload
 * session, the multipart transfer for anything over 100 MiB, waiting for Nexus
 * to accept the file, then creating the collection or a revision of it — and it
 * does it with the login the curator already has. Going through its
 * `submit-collection` event means Event Horizon never holds a token.
 *
 * What an upload makes is a DRAFT revision. Nexus's API has no way to publish
 * one: publishing is the curator's own click on the website, so nothing here
 * can put a collection in front of the public.
 *
 * Measured against Vortex 2.6.3's bundled source (nexus_integration:
 * `onSubmitCollection` → `submitCollectionV3`, `onGetMyCollections`,
 * `onGetNexusCollection`).
 */

import type { types } from "@nexusmods/vortex-api";

import { beginOp, ehLog } from "../logging/ehLog";
import { isAbort } from "../../utils/abortError";
import {
  countNexusCollectionMods,
  describeNexusPointer,
  type NexusCollectionInfo,
} from "./collectionPayload";

/** A Nexus collection an Event Horizon collection uploads to. */
export type NexusCollectionLink = {
  /** Nexus's numeric collection id: what the upload API takes. */
  id: number;
  /** The short code in the page address, e.g. "tumkz9". */
  slug: string;
  /** Nexus's name for the game's site, e.g. "skyrimspecialedition". */
  gameDomain: string;
  /** The collection's name on Nexus when it was linked. Display only. */
  name?: string;
};

/** One of the curator's own collections, as Nexus lists them. */
export type OwnNexusCollection = {
  slug: string;
  name: string;
  gameDomain: string;
  latestRevision?: number;
};

export type NexusUploadFailure = {
  /**
   * `cancelled`: the curator stopped it. `rejected`: Nexus looked at the upload
   * and said no, with reasons. `failed`: it never got that far.
   */
  kind: "cancelled" | "rejected" | "failed";
  title: string;
  details: string[];
};

export type NexusUploadOutcome =
  | {
      ok: true;
      link: NexusCollectionLink;
      /** Absent only if Nexus did not say; the draft exists either way. */
      revisionNumber?: number;
      revisionStatus?: string;
    }
  | { ok: false; failure: NexusUploadFailure };

type NexusApi = Pick<types.IExtensionApi, "events" | "getState"> & {
  emitAndAwait?: (event: string, ...args: unknown[]) => PromiseLike<unknown>;
};

const SUBMIT_EVENT = "submit-collection";

/**
 * Whether Vortex is logged in to Nexus. Read from the user info Vortex keeps
 * for display, never from its stored credentials.
 */
export function isLoggedInToNexus(state: unknown): boolean {
  const nexus = (state as { persistent?: { nexus?: { userInfo?: unknown } } })?.persistent?.nexus;
  return nexus?.userInfo !== undefined && nexus.userInfo !== null;
}

/** Whether this Vortex can upload collections at all. */
export function canUploadCollections(api: Pick<types.IExtensionApi, "events">): boolean {
  // An emit nobody listens to returns quietly and never calls back, so asking
  // first is the difference between an error and a button that spins forever.
  const count = (api.events as { listenerCount?: (event: string) => number }).listenerCount;
  return typeof count === "function" && count.call(api.events, SUBMIT_EVENT) > 0;
}

/** The page of a collection, or of one revision of it. */
export function nexusCollectionUrl(link: Pick<NexusCollectionLink, "gameDomain" | "slug">, revisionNumber?: number): string {
  const base = `https://www.nexusmods.com/games/${link.gameDomain}/collections/${link.slug}`;
  return revisionNumber === undefined ? base : `${base}/revisions/${revisionNumber}`;
}

/**
 * The curator's own collections for a game.
 *
 * `emitAndAwait` never rejects: Vortex turns a failing handler into its own
 * error notification and resolves with what it has. So an empty list means
 * "none, or Nexus could not be asked", and the caller has to say both.
 */
export async function listOwnNexusCollections(api: NexusApi, gameId: string): Promise<OwnNexusCollection[]> {
  if (api.emitAndAwait === undefined) return [];
  const results = (await api.emitAndAwait("get-my-collections", gameId)) as unknown[] | undefined;
  const revisions = Array.isArray(results?.[0]) ? (results![0] as unknown[]) : [];
  const out: OwnNexusCollection[] = [];
  for (const raw of revisions) {
    const revision = raw as {
      revisionNumber?: unknown;
      collection?: { slug?: unknown; name?: unknown; game?: { domainName?: unknown } };
    } | null;
    const slug = revision?.collection?.slug;
    if (typeof slug !== "string" || slug === "") continue;
    const name = revision?.collection?.name;
    const domain = revision?.collection?.game?.domainName;
    out.push({
      slug,
      name: typeof name === "string" && name !== "" ? name : slug,
      gameDomain: typeof domain === "string" ? domain : "",
      ...(typeof revision?.revisionNumber === "number" ? { latestRevision: revision.revisionNumber } : {}),
    });
  }
  ehLog("info", "nexus-collection.list-own", { gameId, count: out.length });
  return out;
}

/**
 * The numeric id behind a collection's slug.
 *
 * Nexus's list of the curator's collections carries slugs only, and uploading
 * a revision needs the number, so linking a collection is two questions.
 */
export async function resolveNexusCollection(api: NexusApi, slug: string): Promise<NexusCollectionLink | undefined> {
  if (api.emitAndAwait === undefined) return undefined;
  const results = (await api.emitAndAwait("get-nexus-collection", slug)) as unknown[] | undefined;
  const collection = results?.[0] as {
    id?: unknown;
    slug?: unknown;
    name?: unknown;
    game?: { domainName?: unknown };
  } | undefined;
  const id = Number(collection?.id);
  if (!Number.isInteger(id) || id <= 0) {
    ehLog("warn", "nexus-collection.resolve.no-id", { slug, answered: collection !== undefined });
    return undefined;
  }
  return {
    id,
    slug: typeof collection?.slug === "string" ? collection.slug : slug,
    gameDomain: typeof collection?.game?.domainName === "string" ? collection.game.domainName : "",
    ...(typeof collection?.name === "string" ? { name: collection.name } : {}),
  };
}

type SubmitResponse = {
  collection?: { id?: unknown; slug?: unknown };
  revision?: { revisionNumber?: unknown; revisionStatus?: unknown };
};

/**
 * Upload a package as a new draft revision of `target`, or as a new collection
 * when there is no target. Resolves with the outcome; never rejects.
 */
export function uploadToNexusCollection(
  api: NexusApi,
  input: {
    info: NexusCollectionInfo;
    packagePath: string;
    target?: NexusCollectionLink;
    onProgress?: (transferred: number, total: number) => void;
    signal?: AbortSignal;
  },
): Promise<NexusUploadOutcome> {
  const { info, target } = input;
  const op = beginOp("nexus-collection.upload", {
    target: target === undefined ? "new collection" : `${target.slug} (${target.id})`,
    domain: info.info.domainName,
    mods: countNexusCollectionMods(info),
  });

  if (!canUploadCollections(api)) {
    const failure: NexusUploadFailure = {
      kind: "failed",
      title: "This Vortex cannot upload collections.",
      details: ["Update Vortex, then try again."],
    };
    op.fail(new Error("no submit-collection listener"));
    return Promise.resolve({ ok: false, failure });
  }
  if (!isLoggedInToNexus(api.getState())) {
    op.fail(new Error("not logged in"));
    return Promise.resolve({
      ok: false,
      failure: {
        kind: "failed",
        title: "Vortex is not logged in to Nexus.",
        details: ["Log in from Vortex's header, then upload again."],
      },
    });
  }

  return new Promise<NexusUploadOutcome>((resolve) => {
    let settled = false;
    /**
     * ─── A SILENCE BUDGET, NOT A TIME LIMIT ────────────────────────────
     * A collection package is gigabytes and an upload legitimately takes
     * hours, so a wall-clock cap would kill the healthy case — the same
     * reasoning the install watchdog settled on.
     *
     * What is NOT legitimate is silence. Vortex reports bytes through
     * `onProgress`, so every tick re-arms this; it can only fire when nothing
     * has moved for a quarter of an hour. Before this, `callback` was the
     * ONLY thing that could settle the promise, so an upload handler that
     * threw before calling back, or a Nexus request that never returned, left
     * the Upload button spinning with no error — the exact failure
     * `canUploadCollections` was written to prevent one line earlier.
     */
    const QUIET_MS = 15 * 60_000;
    let quiet: ReturnType<typeof setTimeout> | undefined;
    const done = (): void => {
      if (quiet !== undefined) clearTimeout(quiet);
      input.signal?.removeEventListener("abort", onAbort);
    };
    const armQuiet = (): void => {
      if (quiet !== undefined) clearTimeout(quiet);
      quiet = setTimeout(() => {
        if (settled) return;
        settled = true;
        done();
        const err = new Error(
          `Vortex reported nothing about this upload for ${QUIET_MS / 60_000} minutes. ` +
            `It may still be running — check Vortex's notifications before uploading again.`,
        );
        op.fail(err, { kind: "stalled" });
        resolve({
          ok: false,
          failure: {
            kind: "failed",
            title: "The upload stopped reporting progress.",
            details: [err.message],
          },
        });
      }, QUIET_MS);
    };
    function onAbort(): void {
      if (settled) return;
      settled = true;
      done();
      const failure = describeUploadError(
        new Error("cancelled"),
        info,
        input.signal,
      );
      op.fail(new Error("cancelled"), { kind: failure.kind, reasons: failure.details.length });
      resolve({ ok: false, failure });
    }
    const callback = (err: unknown, response?: SubmitResponse): void => {
      if (settled) return;
      settled = true;
      done();
      if (err !== null && err !== undefined) {
        const failure = describeUploadError(err, info, input.signal);
        op.fail(err, { kind: failure.kind, reasons: failure.details.length });
        resolve({ ok: false, failure });
        return;
      }
      const outcome = toOutcome(response, info, target);
      if (outcome.ok) {
        op.ok({ slug: outcome.link.slug, id: outcome.link.id, revision: outcome.revisionNumber, status: outcome.revisionStatus });
      } else {
        op.fail(new Error(outcome.failure.title));
      }
      resolve(outcome);
    };
    try {
      input.signal?.addEventListener("abort", onAbort, { once: true });
      armQuiet();
      api.events.emit(SUBMIT_EVENT, info, input.packagePath, target?.id, callback, {
        // Every byte Vortex reports re-arms the silence budget, and the
        // caller's own progress handler still runs exactly as before.
        onProgress: (transferred: number, total: number): void => {
          armQuiet();
          input.onProgress?.(transferred, total);
        },
        abortSignal: input.signal,
      });
    } catch (err) {
      callback(err);
    }
  });
}

function toOutcome(
  response: SubmitResponse | undefined,
  info: NexusCollectionInfo,
  target: NexusCollectionLink | undefined,
): NexusUploadOutcome {
  const id = Number(response?.collection?.id ?? target?.id);
  // Nexus returns a slug when it creates a collection and none for a revision
  // of one that exists, whose slug the link already holds.
  const slug = typeof response?.collection?.slug === "string" ? response.collection.slug : target?.slug;
  if (!Number.isInteger(id) || id <= 0 || slug === undefined) {
    return {
      ok: false,
      failure: {
        kind: "failed",
        title: "Nexus accepted the upload but did not say where it went.",
        details: ["Look for a new draft among your collections on Nexus before uploading again."],
      },
    };
  }
  const revisionNumber = response?.revision?.revisionNumber;
  const revisionStatus = response?.revision?.revisionStatus;
  return {
    ok: true,
    link: {
      id,
      slug,
      gameDomain: target?.gameDomain || info.info.domainName,
      name: info.info.name,
    },
    ...(typeof revisionNumber === "number" ? { revisionNumber } : {}),
    ...(typeof revisionStatus === "string" ? { revisionStatus } : {}),
  };
}

/**
 * What went wrong, in terms the curator can act on.
 *
 * Errors cross from Vortex's code, so they are recognised by shape rather than
 * class: Nexus's API errors are named `V3ApiError` and carry the server's
 * validation items; a stopped transfer has the code `cancellation`.
 */
export function describeUploadError(err: unknown, info: NexusCollectionInfo, signal?: AbortSignal): NexusUploadFailure {
  const e = err as {
    name?: unknown;
    message?: unknown;
    code?: unknown;
    status?: unknown;
    detail?: unknown;
    validationErrors?: unknown;
  } | null;
  const message = typeof e?.message === "string" ? e.message : String(err);

  // Vortex's uploader reports its own stops by code; everything else is the
  // shared abort check.
  if (isAbort(err, signal) || e?.code === "cancellation") {
    return { kind: "cancelled", title: "Upload stopped. Nothing was added to Nexus.", details: [] };
  }

  if (e?.name === "V3ApiError") {
    const status = typeof e.status === "number" ? e.status : undefined;
    const detail = typeof e.detail === "string" && e.detail !== "" ? e.detail : message;
    const items = Array.isArray(e.validationErrors) ? e.validationErrors : [];
    const details = items.map((item) => {
      const v = item as { pointer?: unknown; detail?: unknown };
      const where = describeNexusPointer(typeof v.pointer === "string" ? v.pointer : undefined, info);
      return `${where}: ${typeof v.detail === "string" ? v.detail : "rejected"}`;
    });
    if (status === 403) {
      details.push("Nexus says this account cannot change that collection. Upload it from the account that owns it.");
    } else if (status === 404) {
      details.push("Nexus cannot find that collection. It may have been deleted; pick another or create a new one.");
    }
    return { kind: "rejected", title: `Nexus rejected the upload: ${detail}`, details };
  }

  if (/not logged in/i.test(message)) {
    return {
      kind: "failed",
      title: "Vortex is not logged in to Nexus.",
      details: ["Log in from Vortex's header, then upload again."],
    };
  }

  return { kind: "failed", title: `The upload failed: ${message}`, details: [] };
}
