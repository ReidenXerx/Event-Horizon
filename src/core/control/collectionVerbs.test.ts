import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "eh-coll-"));
const CONFIG_DIR = path.join(ROOT, ".config");
fs.mkdirSync(CONFIG_DIR, { recursive: true });

const h = vi.hoisted(() => ({
  busy: { buildBusy: false, installBusy: false },
  setBuildBusy: vi.fn(),
  summaries: [] as Array<Record<string, unknown>>,
  manifests: new Map<string, any>(),
  built: [] as Array<{ fullPath: string }>,
  own: [] as Array<{ slug: string; name: string }>,
  upload: vi.fn(),
  remember: vi.fn(async () => true),
  ctx: undefined as any,
  pipeline: vi.fn(),
}));

vi.mock("../paths", async (orig) => ({
  ...(await orig<object>()),
  getCollectionsDir: () => ROOT,
  getCollectionsConfigDir: () => CONFIG_DIR,
}));
vi.mock("../../ui/runtime/ehRuntime", () => ({
  getEHRuntime: () => ({ getSnapshot: () => h.busy, setBuildBusy: h.setBuildBusy }),
}));
vi.mock("../manifest/collectionConfig", async (orig) => {
  const real = await orig<typeof import("../manifest/collectionConfig")>();
  return {
    readNexusCollectionLink: real.readNexusCollectionLink,
    listPublishedCollections: async () => h.summaries,
    findNexusCollectionLink: async (_dir: string, id: string) => {
      const s = h.summaries.find((x) => x["packageId"] === id);
      if (s === undefined) return undefined;
      return real.readNexusCollectionLink(JSON.parse(fs.readFileSync(String(s["configPath"]), "utf8")).nexusCollection);
    },
    rememberNexusCollectionLink: h.remember,
  };
});
vi.mock("../manifest/readEhcoll", () => ({
  readEhcoll: async (p: string) => {
    const m = h.manifests.get(p);
    if (m === undefined) throw new Error("no such package");
    return { manifest: m };
  },
}));
vi.mock("../../ui/pages/build/publishedDetails", () => ({ findBuiltPackages: async () => h.built }));
vi.mock("../nexus/collectionUpload", () => ({
  isLoggedInToNexus: () => true,
  listOwnNexusCollections: async () => h.own,
  uploadToNexusCollection: h.upload,
  nexusCollectionUrl: (l: { slug: string }, rev?: number) => `https://next.nexusmods.com/fallout4/collections/${l.slug}/revisions/${rev}`,
}));
vi.mock("../nexus/collectionPayload", () => ({
  toNexusCollectionInfo: (m: any) => ({ info: { name: m.package.name }, mods: [] }),
  nexusCollectionProblems: () => [],
}));
vi.mock("../../ui/pages/build/engine", () => ({
  slugify: (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
  loadBuildContext: async () => h.ctx,
  runBuildPipeline: h.pipeline,
  validateCuratorInput: (c: { version: string }) => (/^\d+\.\d+\.\d+$/.test(c.version) ? undefined : "Version must be x.y.z."),
}));

import { compareVersion, guardBinding, guardVersion } from "./collectionVerbs";
import { VERBS } from "./verbs";

const IVY = "0456490d-525b-49e3-92d2-5c6e617990be";
const STALE = "b4715cae-0000-0000-0000-000000000000";
const LINK = { id: 510658, slug: "dmt85e", gameDomain: "fallout4" };

function config(slug: string, packageId: string, lastBuiltAt: string, name: string, link?: object): Record<string, unknown> {
  const configPath = path.join(CONFIG_DIR, `${slug}.json`);
  fs.writeFileSync(configPath, JSON.stringify({ packageId, ...(link ? { nexusCollection: link } : {}) }));
  return { slug, packageId, lastBuiltAt, lastBuiltName: name, lastBuiltVersion: "1.0.41", configPath };
}

function manifest(file: string, packageId: string, name: string, version = "1.0.42"): string {
  const full = path.join(ROOT, file);
  h.manifests.set(full, {
    package: { id: packageId, name, version, author: "Dudu", description: "The one with the panties." },
    game: { id: "fallout4", version: "1.11.240", versionPolicy: "exact", store: "steam", userOwnedMasters: [] },
    mods: [{ name: "F4SE", source: { kind: "external", bundled: true } }, { name: "Ivy", source: { kind: "nexus" } }],
    externalDependencies: [],
  });
  return full;
}

const api = { getState: () => ({}), sendNotification: vi.fn() } as any;
const run = (verb: string, body: Record<string, unknown> = {}) => VERBS[verb]!.run(api, body);
const code = async (p: Promise<unknown>): Promise<string> => p.then(() => "no error", (e: { code?: string }) => String(e.code));

beforeEach(() => {
  h.busy = { buildBusy: false, installBusy: false };
  h.setBuildBusy.mockClear();
  h.upload.mockReset();
  h.remember.mockClear();
  h.pipeline.mockReset();
  h.manifests.clear();
  h.summaries = [
    config("ivy-s-panties-event-horizon", IVY, "2026-09-26T10:00:00Z", "Ivy's Panties - Event Horizon", LINK),
    config("ivy-panties", STALE, "2026-08-01T10:00:00Z", "Ivy Panties", LINK),
  ];
  h.own = [{ slug: "dmt85e", name: "Ivy's Panties - Event Horizon" }];
  h.built = [];
});

describe("version guard", () => {
  it("compares x.y.z numerically", () => {
    expect(compareVersion("1.0.10", "1.0.9")).toBe(1);
    expect(compareVersion("1.0.9", "1.0.9")).toBe(0);
    expect(compareVersion("abc", "1.0.0")).toBeUndefined();
  });
  it("refuses the same version unless asked, and always refuses an older one", () => {
    expect(guardVersion("1.0.42", "1.0.41", false)).toBeUndefined();
    expect(guardVersion("1.0.41", "1.0.41", false)).toMatch(/destructive/);
    expect(guardVersion("1.0.41", "1.0.41", true)).toBeUndefined();
    expect(guardVersion("1.0.40", "1.0.41", true)).toMatch(/older/);
    expect(guardVersion("1.0.0", undefined, false)).toBeUndefined();
  });
});

describe("binding guard", () => {
  const bindings = [
    { slug: "new", packageId: IVY, lastBuiltAt: "2026-09-26", nexusId: 510658, nexusSlug: "dmt85e" },
    { slug: "old", packageId: STALE, lastBuiltAt: "2026-08-01", lastBuiltName: "Ivy Panties", nexusId: 510658, nexusSlug: "dmt85e" },
  ];
  it("lets the most recently built bound config upload", () => {
    expect(guardBinding({ packageId: IVY, target: { id: 510658, slug: "dmt85e" }, bindings })).toBeUndefined();
  });
  it("refuses the stale config that also binds the collection", () => {
    expect(guardBinding({ packageId: STALE, target: { id: 510658, slug: "dmt85e" }, bindings })).toMatch(/stale/);
  });
  it("refuses a package bound elsewhere", () => {
    expect(guardBinding({ packageId: "other", target: { id: 510658, slug: "dmt85e" }, bindings })).toMatch(/not bound/);
  });
});

describe("collection.list / collection.manifest", () => {
  it("lists every config with its Nexus binding", async () => {
    const r = (await run("collection.list")) as { collections: Array<Record<string, unknown>> };
    expect(r.collections.map((c) => [c["packageId"], c["nexusSlug"]])).toEqual([
      [IVY, "dmt85e"],
      [STALE, "dmt85e"],
    ]);
  });
  it("summarizes the newest build of a named collection", async () => {
    const file = manifest("ivy-1.0.42.ehcoll", IVY, "Ivy's Panties - Event Horizon");
    h.built = [{ fullPath: file }];
    const r = await run("collection.manifest", { name: "Ivy's Panties - Event Horizon" });
    expect(r).toMatchObject({ packageId: IVY, version: "1.0.42", mods: 2, bundled: ["F4SE"], game: { version: "1.11.240", store: "steam" } });
  });
  it("says so when nothing was built", async () => {
    expect(await code(run("collection.manifest", { name: "Nothing" }))).toBe("no-package");
  });
});

describe("collection.upload: a draft, only where this package belongs", () => {
  const ok = { ok: true, link: LINK, revisionNumber: 43, revisionStatus: "draft" };

  it("uploads the newest build as a draft of its bound collection, under the live name", async () => {
    h.built = [{ fullPath: manifest("ivy.ehcoll", IVY, "Ivy's Panties - Event Horizon") }];
    h.upload.mockResolvedValue(ok);
    const r = await run("collection.upload", { name: "Ivy's Panties - Event Horizon", collection: "dmt85e" });
    expect(r).toMatchObject({ status: "draft", revisionNumber: 43, collection: "dmt85e" });
    expect(h.upload.mock.calls[0]![1]).toMatchObject({ target: LINK, info: { info: { name: "Ivy's Panties - Event Horizon" } } });
    expect(h.remember).toHaveBeenCalled();
  });

  it("returns this version's changelog, ready for the revision, with the revision's id", async () => {
    const file = manifest("ivy.ehcoll", IVY, "Ivy's Panties - Event Horizon", "1.0.37");
    h.manifests.get(file).package.changelog = [
      { version: "1.0.37", date: "2026-09-28T00:00:00.000Z", notes: "AE fixes and the Reapers reinstall." },
      { version: "1.0.36", date: "2026-09-27T00:00:00.000Z", notes: "Moved to AE." },
    ];
    h.built = [{ fullPath: file }];
    h.upload.mockResolvedValue(ok);
    const withRevision = { ...api, emitAndAwait: async (ev: string) => (ev === "get-nexus-collection-revision" ? [{ id: 9901 }] : []) };
    const r = (await VERBS["collection.upload"]!.run(withRevision, { name: "x" })) as any;
    expect(r.changelog).toMatchObject({ sentToNexus: false, version: "1.0.37", revisionId: 9901 });
    expect(r.changelog.markdown).toContain("AE fixes and the Reapers reinstall.");
    expect(r.changelog.markdown).not.toContain("Moved to AE.");
    expect(typeof r.changelog.bbcode).toBe("string");
  });

    it("refuses a package whose name differs from the live collection's (it would rename the page)", async () => {
    h.built = [{ fullPath: manifest("ivy.ehcoll", IVY, "Ivy's Panties AE") }];
    expect(await code(run("collection.upload", { name: "Ivy's Panties AE" }))).toBe("name-mismatch");
    expect(h.upload).not.toHaveBeenCalled();
  });

  it("with allowNameMismatch, uploads under the LIVE name so the page is not renamed", async () => {
    h.built = [{ fullPath: manifest("ivy.ehcoll", IVY, "Ivy's Panties AE") }];
    h.upload.mockResolvedValue(ok);
    await run("collection.upload", { name: "Ivy's Panties AE", allowNameMismatch: true });
    expect(h.upload.mock.calls[0]![1].info.info.name).toBe("Ivy's Panties - Event Horizon");
  });

  it("refuses the stale config's package that also binds the collection", async () => {
    h.built = [{ fullPath: manifest("old.ehcoll", STALE, "Ivy's Panties - Event Horizon") }];
    expect(await code(run("collection.upload", { name: "Ivy Panties" }))).toBe("stale-binding");
    expect(h.upload).not.toHaveBeenCalled();
  });

  it("never creates a collection: a package bound to none is refused", async () => {
    h.built = [{ fullPath: manifest("new.ehcoll", "fresh-id", "Something New") }];
    expect(await code(run("collection.upload", { name: "Something New" }))).toBe("not-bound");
    expect(h.upload).not.toHaveBeenCalled();
  });

  it("refuses when the caller expected a different collection", async () => {
    h.built = [{ fullPath: manifest("ivy.ehcoll", IVY, "Ivy's Panties - Event Horizon") }];
    expect(await code(run("collection.upload", { name: "x", collection: "abc123" }))).toBe("wrong-collection");
  });

  it("reports a failed upload as a failure", async () => {
    h.built = [{ fullPath: manifest("ivy.ehcoll", IVY, "Ivy's Panties - Event Horizon") }];
    h.upload.mockResolvedValue({ ok: false, failure: { kind: "rejected", title: "Nexus refused it.", details: ["bad mod"] } });
    expect(await code(run("collection.upload", { name: "x" }))).toBe("upload-failed");
    expect(h.remember).not.toHaveBeenCalled();
  });

  it("there is no publish verb", () => {
    expect(Object.keys(VERBS).filter((v) => /publish|release|delete/i.test(v))).toEqual([]);
  });
});

describe("collection.build", () => {
  beforeEach(() => {
    h.ctx = {
      configCreated: false,
      collectionConfig: {
        packageId: IVY,
        lastBuiltVersion: "1.0.41",
        lastBuiltAuthor: "Dudu",
        externalMods: { a: { choice: "bundle" } },
        readme: "READ ME",
        changelog: "old log",
        lastPackageFormat: 2,
      },
      defaultAuthor: "someone",
      gameVersion: "1.11.240",
      mods: [1, 2, 3],
      externalMods: [1],
      profileId: "ae",
    };
  });

  it("refuses a name that would start a new collection", async () => {
    h.ctx.configCreated = true;
    expect(await code(run("collection.build", { name: "Ivy AE", version: "1.0.42" }))).toBe("new-collection");
    expect(h.pipeline).not.toHaveBeenCalled();
  });

  it("refuses a version that is not newer than the last build", async () => {
    expect(await code(run("collection.build", { name: "Ivy", version: "1.0.41" }))).toBe("bad-version");
  });

  it("refuses while a build or install runs", async () => {
    h.busy = { buildBusy: false, installBusy: true };
    expect(await code(run("collection.build", { name: "Ivy", version: "1.0.42" }))).toBe("busy");
  });

  it("dryRun says what it would build and builds nothing", async () => {
    const r = await run("collection.build", { name: "Ivy", version: "1.0.42", dryRun: true });
    expect(r).toMatchObject({ dryRun: true, packageId: IVY, author: "Dudu", gameVersion: "1.11.240", mods: 3 });
    expect(h.pipeline).not.toHaveBeenCalled();
  });

  it("builds with the collection's own decisions, keeps the previous description, and verifies the package", async () => {
    h.built = [{ fullPath: manifest("prev.ehcoll", IVY, "Ivy", "1.0.41") }];
    const out = manifest("ivy-1.0.42.ehcoll", IVY, "Ivy", "1.0.42");
    h.pipeline.mockResolvedValue({ outputPath: out, outputBytes: 1234, warnings: [] });
    const r = await run("collection.build", { name: "Ivy", version: "1.0.42", changelog: "AE now" });
    const [, , curator, opts] = h.pipeline.mock.calls[0]!;
    expect(curator).toMatchObject({ name: "Ivy", version: "1.0.42", author: "Dudu", description: "The one with the panties.", gameVersion: "1.11.240" });
    expect(opts).toMatchObject({ externalMods: { a: { choice: "bundle" } }, readme: "READ ME", changelog: "AE now", packageFormat: 2 });
    expect(r).toMatchObject({ version: "1.0.42", bytes: 1234, verified: { packageId: true, version: true } });
    expect(h.setBuildBusy.mock.calls).toEqual([[true], [false]]);
  });

  it("maps the engine's refusal to build-refused and releases the busy flag", async () => {
    const e = new Error("A mod has no archive.");
    e.name = "BuildRefusedError";
    h.pipeline.mockRejectedValue(e);
    expect(await code(run("collection.build", { name: "Ivy", version: "1.0.42" }))).toBe("build-refused");
    expect(h.setBuildBusy.mock.calls.at(-1)).toEqual([false]);
  });
});
