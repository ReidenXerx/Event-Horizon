/**
 * Uploading through Vortex's own collection events.
 *
 * The fake here reproduces what Vortex 2.6.3 does, read from its bundled
 * source: `submit-collection` answers through a node-style callback, and
 * `emitAndAwait` resolves to the array of non-null handler results and never
 * rejects. A wrapper that assumed a promise from the emit, or a single value
 * from emitAndAwait, would pass against a friendlier fake and hang or misread
 * against Vortex.
 */
import { EventEmitter } from "events";

import { describe, expect, it, vi } from "vitest";

import {
  canUploadCollections,
  describeUploadError,
  isLoggedInToNexus,
  listOwnNexusCollections,
  nexusCollectionUrl,
  resolveNexusCollection,
  uploadToNexusCollection,
  type NexusCollectionLink,
} from "./collectionUpload";
import type { NexusCollectionInfo } from "./collectionPayload";

const INFO: NexusCollectionInfo = {
  info: { author: "DuduPhudu", authorUrl: "", name: "Ivy's Panties", domainName: "fallout4", gameVersions: ["1.10.163.0"] },
  mods: [
    { name: "UFO4P", version: "2.1.5", optional: false, domainName: "fallout4", source: { type: "bundle" } },
    {
      name: "RobCo Patches",
      version: "6.2",
      optional: false,
      domainName: "fallout4",
      source: { type: "nexus", modId: 69882, fileId: 123, updatePolicy: "exact" },
    },
  ],
};

const LOGGED_IN = { persistent: { nexus: { userInfo: { name: "DuduPhudu", userId: 1 } } } };

type Handler = (...args: unknown[]) => unknown;

function fakeApi(options: { state?: unknown; handlers?: Record<string, Handler>; asyncHandlers?: Record<string, Handler> } = {}) {
  const events = new EventEmitter();
  for (const [event, handler] of Object.entries(options.handlers ?? {})) events.on(event, handler);
  const asyncHandlers = options.asyncHandlers ?? {};
  // Vortex's emitAndAwait: collect non-null results, swallow failures.
  const emitAndAwait = async (event: string, ...args: unknown[]): Promise<unknown[]> => {
    const handler = asyncHandlers[event];
    if (handler === undefined) return [];
    try {
      const result = await handler(...args);
      return result === null || result === undefined ? [] : [result];
    } catch {
      return [];
    }
  };
  return { events, getState: () => options.state ?? LOGGED_IN, emitAndAwait } as never;
}

const EXISTING: NexusCollectionLink = { id: 350133, slug: "tumkz9", gameDomain: "fallout4", name: "Ivy's Panties" };

describe("before anything is sent", () => {
  it("reports a Vortex without collection uploads instead of waiting for an answer that never comes", async () => {
    const api = fakeApi();
    expect(canUploadCollections(api)).toBe(false);
    const outcome = await uploadToNexusCollection(api, { info: INFO, packagePath: "C:/out/ivy.zip" });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.failure.title).toMatch(/cannot upload collections/);
  });

  it("refuses when Vortex is not logged in, and never asks Vortex to upload", async () => {
    const submit = vi.fn();
    const api = fakeApi({ state: { persistent: { nexus: {} } }, handlers: { "submit-collection": submit } });
    const outcome = await uploadToNexusCollection(api, { info: INFO, packagePath: "C:/out/ivy.zip" });
    expect(outcome.ok).toBe(false);
    expect(submit).not.toHaveBeenCalled();
  });

  it("reads login from the user info Vortex shows, never from stored credentials", () => {
    // Credentials alone are not "logged in" to this check, because this code
    // must never read them.
    expect(isLoggedInToNexus({ confidential: { account: { nexus: { OAuthCredentials: {} } } } })).toBe(false);
    expect(isLoggedInToNexus(LOGGED_IN)).toBe(true);
    expect(isLoggedInToNexus({ persistent: { nexus: { userInfo: null } } })).toBe(false);
  });
});

describe("a successful upload", () => {
  it("makes a new collection when there is no target, and returns where it went", async () => {
    let seen: unknown[] = [];
    const api = fakeApi({
      handlers: {
        "submit-collection": (...args: unknown[]) => {
          seen = args;
          const cb = args[3] as (err: unknown, res?: unknown) => void;
          cb(null, { collection: { id: 400001, slug: "abc123" }, revision: { id: 9, revisionNumber: 1, revisionStatus: "draft" } });
        },
      },
    });
    const outcome = await uploadToNexusCollection(api, { info: INFO, packagePath: "C:/out/ivy.zip" });
    expect(seen[0]).toBe(INFO);
    expect(seen[1]).toBe("C:/out/ivy.zip");
    expect(seen[2]).toBeUndefined();
    expect(outcome).toEqual({
      ok: true,
      link: { id: 400001, slug: "abc123", gameDomain: "fallout4", name: "Ivy's Panties" },
      revisionNumber: 1,
      revisionStatus: "draft",
    });
  });

  it("adds a revision to an existing collection, keeping its slug when Nexus sends none", async () => {
    let collectionId: unknown;
    const api = fakeApi({
      handlers: {
        "submit-collection": (_info: unknown, _path: unknown, id: unknown, cb: unknown) => {
          collectionId = id;
          (cb as (err: unknown, res?: unknown) => void)(null, {
            collection: { id: 350133 },
            revision: { revisionNumber: 7, revisionStatus: "draft" },
          });
        },
      },
    });
    const outcome = await uploadToNexusCollection(api, { info: INFO, packagePath: "C:/out/ivy.zip", target: EXISTING });
    expect(collectionId).toBe(350133);
    expect(outcome.ok && outcome.link.slug).toBe("tumkz9");
    expect(outcome.ok && outcome.revisionNumber).toBe(7);
  });

  it("passes progress and the stop signal through to Vortex's uploader", async () => {
    const onProgress = vi.fn();
    const controller = new AbortController();
    const api = fakeApi({
      handlers: {
        "submit-collection": (...args: unknown[]) => {
          const options = args[4] as { onProgress: (a: number, b: number) => void; abortSignal: AbortSignal };
          expect(options.abortSignal).toBe(controller.signal);
          options.onProgress(50, 100);
          (args[3] as (err: unknown, res?: unknown) => void)(null, { collection: { id: 1, slug: "s" }, revision: {} });
        },
      },
    });
    await uploadToNexusCollection(api, { info: INFO, packagePath: "p.zip", onProgress, signal: controller.signal });
    expect(onProgress).toHaveBeenCalledWith(50, 100);
  });

  it("does not report success when Nexus does not say where the draft went", async () => {
    const api = fakeApi({
      handlers: {
        "submit-collection": (...args: unknown[]) => (args[3] as (e: unknown, r?: unknown) => void)(null, { revision: {} }),
      },
    });
    const outcome = await uploadToNexusCollection(api, { info: INFO, packagePath: "p.zip" });
    expect(outcome.ok).toBe(false);
  });
});

describe("a failed upload", () => {
  it("names the mod Nexus rejected, from its validation pointer", async () => {
    const rejection = Object.assign(new Error("Unprocessable Entity"), {
      name: "V3ApiError",
      status: 422,
      detail: "The collection manifest is invalid",
      validationErrors: [{ pointer: "/collection_data/collection_manifest/mods/1/source/file_id", detail: "file not found" }],
    });
    const api = fakeApi({
      handlers: { "submit-collection": (...args: unknown[]) => (args[3] as (e: unknown) => void)(rejection) },
    });
    const outcome = await uploadToNexusCollection(api, { info: INFO, packagePath: "p.zip", target: EXISTING });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.failure.kind).toBe("rejected");
      expect(outcome.failure.title).toMatch(/The collection manifest is invalid/);
      expect(outcome.failure.details).toEqual(['"RobCo Patches" (source/file_id): file not found']);
    }
  });

  it("says whose collection it is when Nexus answers 403", () => {
    const failure = describeUploadError(Object.assign(new Error("Forbidden"), { name: "V3ApiError", status: 403 }), INFO);
    expect(failure.details.join(" ")).toMatch(/account that owns it/);
  });

  it("treats a stopped transfer as cancelled, not failed", async () => {
    const controller = new AbortController();
    const api = fakeApi({
      handlers: {
        "submit-collection": (...args: unknown[]) => {
          controller.abort();
          (args[3] as (e: unknown) => void)(Object.assign(new Error("canceled"), { code: "cancellation" }));
        },
      },
    });
    const outcome = await uploadToNexusCollection(api, { info: INFO, packagePath: "p.zip", signal: controller.signal });
    expect(!outcome.ok && outcome.failure.kind).toBe("cancelled");
  });

  it("treats a cancellation Vortex reports on its own as cancelled too", () => {
    // Not every stop comes through this code's signal: Vortex's uploader
    // reports its own cancellations by code.
    const failure = describeUploadError(Object.assign(new Error("canceled"), { code: "cancellation" }), INFO);
    expect(failure.kind).toBe("cancelled");
  });

  it("turns a handler that throws into a failure rather than a rejected promise", async () => {
    const api = fakeApi({
      handlers: {
        "submit-collection": () => {
          throw new Error("boom");
        },
      },
    });
    const outcome = await uploadToNexusCollection(api, { info: INFO, packagePath: "p.zip" });
    expect(!outcome.ok && outcome.failure.title).toMatch(/boom/);
  });
});

describe("finding the curator's collections", () => {
  it("reads the slugs out of Vortex's list of latest revisions, skipping entries without one", async () => {
    const api = fakeApi({
      asyncHandlers: {
        "get-my-collections": () => [
          { revisionNumber: 3, collection: { slug: "tumkz9", name: "Ivy's Panties", game: { domainName: "fallout4" } } },
          { revisionNumber: 1, collection: {} },
          null,
        ],
      },
    });
    expect(await listOwnNexusCollections(api, "fallout4")).toEqual([
      { slug: "tumkz9", name: "Ivy's Panties", gameDomain: "fallout4", latestRevision: 3 },
    ]);
  });

  it("returns nothing, rather than throwing, when Vortex has no answer", async () => {
    expect(await listOwnNexusCollections(fakeApi(), "fallout4")).toEqual([]);
  });

  it("resolves a slug to the numeric id the upload needs", async () => {
    const api = fakeApi({
      asyncHandlers: {
        "get-nexus-collection": (slug: unknown) => ({ id: "350133", slug, name: "Ivy's Panties", game: { domainName: "fallout4" } }),
      },
    });
    expect(await resolveNexusCollection(api, "tumkz9")).toEqual(EXISTING);
  });

  it("gives no link when Nexus gives no usable id", async () => {
    const api = fakeApi({ asyncHandlers: { "get-nexus-collection": () => ({ slug: "tumkz9" }) } });
    expect(await resolveNexusCollection(api, "tumkz9")).toBeUndefined();
  });

  it("builds the page address of a collection and of one revision", () => {
    expect(nexusCollectionUrl(EXISTING)).toBe("https://www.nexusmods.com/games/fallout4/collections/tumkz9");
    expect(nexusCollectionUrl(EXISTING, 7)).toBe("https://www.nexusmods.com/games/fallout4/collections/tumkz9/revisions/7");
  });
});
