/**
 * Collection build and draft upload, for the control channel: a release can
 * run while the curator sleeps (owner, 2026-09-27).
 *
 * Same pipeline the Build page's button runs, and the same upload its Nexus
 * panel runs, headless. What is deliberately NOT here:
 *   - no publish, ever: an upload makes a DRAFT revision, and publishing it is
 *     the curator's click on Nexus;
 *   - no new collection, from either side: a build under a name that has no
 *     collection config yet forks the identity (a rename is a new packageId),
 *     and an upload goes only to the Nexus collection this package is already
 *     bound to.
 * And refused outright, because each has already gone wrong once:
 *   - a version that is not newer than the last build (the same-version
 *     republish is the destructive path);
 *   - a package whose name differs from the live collection's (Vortex's upload
 *     renames the page, publicly, even for a draft);
 *   - a package whose config is not the most recently built of the configs
 *     bound to that collection (a stale pre-rename config also binds Ivy's).
 */

import * as path from "path";
import type { types } from "@nexusmods/vortex-api";

import { ControlError } from "./controlError";
import { ehLog } from "../logging/ehLog";
import { getCollectionsConfigDir, getCollectionsDir } from "../paths";
import { getEHRuntime } from "../../ui/runtime/ehRuntime";
import type { EhcollManifest } from "../../types/ehcoll";

type Body = Record<string, unknown>;
const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() !== "" ? v.trim() : undefined);

/** Numeric x.y.z compare; undefined when either side is not one. */
export function compareVersion(a: string, b: string): number | undefined {
  const p = (v: string): number[] | undefined => {
    const m = /^(\d+)\.(\d+)\.(\d+)/.exec(v.trim());
    return m === null ? undefined : [Number(m[1]), Number(m[2]), Number(m[3])];
  };
  const x = p(a);
  const y = p(b);
  if (x === undefined || y === undefined) return undefined;
  for (let i = 0; i < 3; i += 1) if (x[i] !== y[i]) return x[i]! > y[i]! ? 1 : -1;
  return 0;
}

/** Pure: may this version be built over the last one? */
export function guardVersion(version: string, lastBuilt: string | undefined, allowSame: boolean): string | undefined {
  if (lastBuilt === undefined) return undefined;
  const c = compareVersion(version, lastBuilt);
  if (c === undefined) return undefined;
  if (c > 0) return undefined;
  if (c === 0 && allowSame) return undefined;
  return c === 0
    ? `Version ${version} was already built. Rebuilding the same version is the destructive path for players who installed it; bump the version (or send allowSameVersion: true if you mean it).`
    : `Version ${version} is older than the last build, ${lastBuilt}. Send a newer version.`;
}

type Binding = { slug: string; packageId: string; lastBuiltAt?: string; lastBuiltName?: string; nexusId?: number; nexusSlug?: string };

/** Pure: is this package's config the one that should own uploads to this Nexus collection? */
export function guardBinding(args: {
  packageId: string;
  target: { id: number; slug: string };
  bindings: readonly Binding[];
}): string | undefined {
  const same = args.bindings.filter((b) => b.nexusId === args.target.id || b.nexusSlug === args.target.slug);
  const mine = same.find((b) => b.packageId === args.packageId);
  if (mine === undefined) {
    return `This package (${args.packageId}) is not bound to Nexus collection ${args.target.slug}. The first upload of a package is done by hand on the Build page.`;
  }
  const newer = same.filter((b) => b !== mine && (b.lastBuiltAt ?? "") > (mine.lastBuiltAt ?? ""));
  if (newer.length > 0) {
    return (
      `Collection ${args.target.slug} is also bound to "${newer[0]!.lastBuiltName ?? newer[0]!.slug}" (${newer[0]!.packageId}), built more recently than this package's ` +
      `config. This package looks like the stale one; build from "${newer[0]!.lastBuiltName ?? newer[0]!.slug}" instead.`
    );
  }
  return undefined;
}

async function bindings(): Promise<Binding[]> {
  const { listPublishedCollections, readNexusCollectionLink } = await import("../manifest/collectionConfig");
  const { promises: fs } = await import("fs");
  const dir = getCollectionsConfigDir();
  const list = await listPublishedCollections(dir);
  const out: Binding[] = [];
  for (const s of list) {
    let link: { id?: number; slug?: string } | undefined;
    try {
      link = readNexusCollectionLink((JSON.parse(await fs.readFile(s.configPath, "utf8")) as { nexusCollection?: unknown }).nexusCollection);
    } catch {
      link = undefined;
    }
    out.push({
      slug: s.slug,
      packageId: s.packageId,
      ...(s.lastBuiltAt !== undefined ? { lastBuiltAt: s.lastBuiltAt } : {}),
      ...(s.lastBuiltName !== undefined ? { lastBuiltName: s.lastBuiltName } : {}),
      ...(link?.id !== undefined ? { nexusId: link.id } : {}),
      ...(link?.slug !== undefined ? { nexusSlug: link.slug } : {}),
    });
  }
  return out;
}

async function latestPackage(name: string): Promise<string | undefined> {
  const [{ findBuiltPackages }, { slugify }] = await Promise.all([import("../../ui/pages/build/publishedDetails"), import("../../ui/pages/build/engine")]);
  const found = await findBuiltPackages(getCollectionsDir(), slugify(name));
  return found[0]?.fullPath;
}

async function readManifest(file: string): Promise<EhcollManifest> {
  const { readEhcoll } = await import("../manifest/readEhcoll");
  try {
    return (await readEhcoll(file)).manifest;
  } catch (err) {
    throw new ControlError("package-unreadable", `Could not read the package ${path.basename(file)}: ${String((err as Error)?.message ?? err)}`, 500);
  }
}

function summarize(m: EhcollManifest, file: string): Record<string, unknown> {
  const bundled = m.mods.filter((x) => (x.source as { bundled?: boolean }).bundled === true).map((x) => x.name);
  return {
    file: path.basename(file),
    packageId: m.package.id,
    name: m.package.name,
    version: m.package.version,
    author: m.package.author,
    game: { id: m.game.id, version: m.game.version, policy: m.game.versionPolicy, store: m.game.store, userOwnedMasters: m.game.userOwnedMasters },
    mods: m.mods.length,
    bundled,
    externalDependencies: (m.externalDependencies ?? []).map((d) => d.id),
  };
}

/** Resolves the package a caller means: `path`, or the newest build of collection `name`. */
async function packageFor(body: Body): Promise<string> {
  const explicit = str(body["path"]);
  if (explicit !== undefined) return explicit;
  const name = str(body["name"]);
  if (name === undefined) throw new ControlError("bad-request", `Send "name" (the collection's name) or "path" (a built package).`);
  const file = await latestPackage(name);
  if (file === undefined) throw new ControlError("no-package", `No built package for "${name}" in ${getCollectionsDir()}.`, 404);
  return file;
}

/**
 * This version's changelog, ready for the Nexus revision (owner, 2026-09-28:
 * the upload's one minus was an empty changelog on the draft).
 *
 * Not sent from here: Vortex has no event that sets a revision's changelog,
 * and Event Horizon never touches the player's Nexus login. Nexus's v2
 * GraphQL has `createChangelog(revisionId, description)`, which a caller with
 * an API key can post; `revisionId` is included for exactly that. The Build
 * page's own flow is the same text, pasted by hand.
 */
async function revisionChangelog(
  api: types.IExtensionApi,
  m: EhcollManifest,
  slug: string,
  revisionNumber: number | undefined,
): Promise<Record<string, unknown> | undefined> {
  const entries = m.package.changelog ?? [];
  const entry = entries.find((e) => e.version === m.package.version) ?? entries[0];
  if (entry === undefined) return undefined;
  const { renderChangelogBbcode, renderChangelogMarkdown } = await import("../changelog/changelog");
  let revisionId: unknown;
  if (revisionNumber !== undefined) {
    try {
      const res = (await api.emitAndAwait?.("get-nexus-collection-revision", slug, revisionNumber)) as unknown[] | undefined;
      revisionId = (res?.[0] as { id?: unknown } | undefined)?.id;
    } catch {
      revisionId = undefined;
    }
  }
  return {
    sentToNexus: false,
    why:
      "Vortex offers no way to set a revision's changelog, and Event Horizon never uses the Nexus login. " +
      "Post `markdown` with Nexus's GraphQL mutation createChangelog(revisionId, description) using an API key, " +
      "or paste it into the draft's changelog on Nexus.",
    version: entry.version,
    ...(revisionId !== undefined ? { revisionId } : {}),
    markdown: renderChangelogMarkdown(m.package.name, [entry]),
    bbcode: renderChangelogBbcode(entry),
  };
}

/** How many times collection.upload asks Nexus for the account's collections, and how long between. */
const UPLOAD_LOOKUP_ATTEMPTS = 4;
let uploadLookupWaitMs = 15_000;
/** Tests only. */
export function setUploadLookupWaitForTests(ms: number): void {
  uploadLookupWaitMs = ms;
}

export const COLLECTION_VERBS = {
  /** Every collection config on this machine: name, package id, last build, Nexus binding. */
  "collection.list": {
    mutates: false,
    run: async (): Promise<Record<string, unknown>> => ({ collections: await bindings() }),
  },

  /** A built package's manifest, summarized: `name` (newest build) or `path`. */
  "collection.manifest": {
    mutates: false,
    run: async (_api: types.IExtensionApi, body: Body): Promise<Record<string, unknown>> => {
      const file = await packageFor(body);
      return summarize(await readManifest(file), file);
    },
  },

  /**
   * Builds a collection, as the Build page's button does. `name` must be an
   * existing collection's exact name (a new name is a new identity: allowNew).
   * Author, description, readme, changelog, per-mod decisions and package
   * format default to the collection's own records; `dryRun` stops before
   * building and says what it would build.
   */
  "collection.build": {
    mutates: true,
    run: async (api: types.IExtensionApi, body: Body): Promise<Record<string, unknown>> => {
      const name = str(body["name"]);
      const version = str(body["version"]);
      if (name === undefined || version === undefined) throw new ControlError("bad-request", `"name" and "version" are required.`);
      const runtime = getEHRuntime().getSnapshot();
      if (runtime.buildBusy || runtime.installBusy) {
        throw new ControlError("busy", "Another build or install is running in Event Horizon. Try again when it ends.", 409);
      }
      const engine = await import("../../ui/pages/build/engine");
      const ctx = await engine.loadBuildContext(api, { nameOverride: name });
      if (ctx.configCreated && body["allowNew"] !== true) {
        throw new ControlError(
          "new-collection",
          `No collection is named "${name}" yet: building it would start a NEW collection (a new package id, no updates for existing players). Check collection.list for the exact name, or send allowNew: true if a new collection is the intent.`,
          409,
        );
      }
      const cfg = ctx.collectionConfig;
      const versionProblem = guardVersion(version, cfg.lastBuiltVersion, body["allowSameVersion"] === true);
      if (versionProblem !== undefined) throw new ControlError("bad-version", versionProblem, 409, { lastBuiltVersion: cfg.lastBuiltVersion });

      let previousDescription = "";
      const prev = await latestPackage(name);
      if (prev !== undefined) {
        try {
          previousDescription = (await readManifest(prev)).package.description ?? "";
        } catch {
          previousDescription = "";
        }
      }
      const curator = {
        name,
        version,
        author: str(body["author"]) ?? cfg.lastBuiltAuthor ?? ctx.defaultAuthor,
        description: typeof body["description"] === "string" ? (body["description"] as string) : previousDescription,
        gameVersion: str(body["gameVersion"]) ?? (ctx.gameVersion === "unknown" ? "" : ctx.gameVersion),
        gameVersionPolicy: (str(body["gameVersionPolicy"]) as "exact" | "minimum" | undefined) ?? "exact",
      };
      const invalid = engine.validateCuratorInput(curator);
      if (invalid !== undefined) throw new ControlError("bad-request", invalid);
      const plan = {
        packageId: cfg.packageId,
        name,
        version,
        lastBuiltVersion: cfg.lastBuiltVersion,
        author: curator.author,
        gameVersion: curator.gameVersion,
        gameVersionPolicy: curator.gameVersionPolicy,
        mods: ctx.mods.length,
        externalMods: ctx.externalMods.length,
        profileId: ctx.profileId,
      };
      if (body["dryRun"] === true) return { dryRun: true, ...plan };

      getEHRuntime().setBuildBusy(true);
      ehLog("info", "control.build.start", plan);
      try {
        const result = await engine.runBuildPipeline(api, ctx, curator, {
          externalMods: { ...cfg.externalMods },
          readme: typeof body["readme"] === "string" ? (body["readme"] as string) : (cfg.readme ?? ""),
          changelog: typeof body["changelog"] === "string" ? (body["changelog"] as string) : (cfg.changelog ?? ""),
          ...(cfg.lastPackageFormat !== undefined ? { packageFormat: cfg.lastPackageFormat } : {}),
          verificationLevel: "thorough",
          reverifyEverything: false,
        });
        const m = await readManifest(result.outputPath);
        return {
          ...summarize(m, result.outputPath),
          path: result.outputPath,
          bytes: result.outputBytes,
          warnings: result.warnings,
          verified: { packageId: m.package.id === cfg.packageId, version: m.package.version === version },
        };
      } catch (err) {
        if (err instanceof ControlError) throw err;
        const refused = err instanceof Error && err.name === "BuildRefusedError";
        throw new ControlError(refused ? "build-refused" : "build-failed", String((err as Error)?.message ?? err), refused ? 409 : 500);
      } finally {
        getEHRuntime().setBuildBusy(false);
      }
    },
    describe: (b: Body, r: Record<string, unknown>): string => `built ${String(b["name"])} ${String(r["version"] ?? b["version"])}`,
  },

  /**
   * Uploads a built package as a DRAFT revision of the Nexus collection it is
   * bound to. Never publishes and never creates a collection.
   *
   *   { name | path, collection? (slug, to confirm the target) }
   */
  "collection.upload": {
    mutates: true,
    run: async (api: types.IExtensionApi, body: Body): Promise<Record<string, unknown>> => {
      const file = await packageFor(body);
      const m = await readManifest(file);
      const up = await import("../nexus/collectionUpload");
      const payload = await import("../nexus/collectionPayload");
      const cfg = await import("../manifest/collectionConfig");
      if (!up.isLoggedInToNexus(api.getState())) throw new ControlError("not-logged-in", "Vortex is not logged in to Nexus.", 409);
      const link = await cfg.findNexusCollectionLink(getCollectionsConfigDir(), m.package.id);
      if (link === undefined) {
        throw new ControlError("not-bound", `This package (${m.package.id}) has never been uploaded, so it is bound to no Nexus collection. The first upload is done by hand on the Build page.`, 409);
      }
      const asked = str(body["collection"]);
      if (asked !== undefined && asked !== link.slug && asked !== String(link.id)) {
        throw new ControlError("wrong-collection", `This package is bound to Nexus collection ${link.slug}, not ${asked}.`, 409);
      }
      const bindingProblem = guardBinding({ packageId: m.package.id, target: { id: link.id, slug: link.slug }, bindings: await bindings() });
      if (bindingProblem !== undefined) throw new ControlError("stale-binding", bindingProblem, 409);

      /**
       * Asked again before giving up: right after Vortex starts, its Nexus
       * session can answer before it is fully signed in, and the list comes
       * back without the collection (Ivy Rev 14, 2026-10-09: not found on the
       * first try, found minutes later).
       */
      let own = await up.listOwnNexusCollections(api, m.game.id);
      let live = own.find((c) => c.slug === link.slug);
      for (let attempt = 2; live === undefined && attempt <= UPLOAD_LOOKUP_ATTEMPTS; attempt++) {
        ehLog("warn", "control.collection-upload.lookup-retry", { slug: link.slug, listed: own.length, attempt });
        await new Promise((r) => setTimeout(r, uploadLookupWaitMs));
        own = await up.listOwnNexusCollections(api, m.game.id);
        live = own.find((c) => c.slug === link.slug);
      }
      if (live === undefined) {
        throw new ControlError(
          "collection-not-found",
          `Nexus does not list collection ${link.slug} among this account's collections (${own.length} listed, asked ${UPLOAD_LOOKUP_ATTEMPTS} times).`,
          409,
        );
      }
      if (live.name !== m.package.name && body["allowNameMismatch"] !== true) {
        throw new ControlError(
          "name-mismatch",
          `The package is named "${m.package.name}" but the collection on Nexus is "${live.name}". An upload renames the Nexus page publicly, even for a draft. Build under "${live.name}", or send allowNameMismatch: true to upload under the live name without renaming.`,
          409,
        );
      }
      const info = payload.toNexusCollectionInfo(m);
      const named = { ...info, info: { ...info.info, name: live.name } };
      const problems = payload.nexusCollectionProblems(named).filter(Boolean);
      if (problems.length > 0) throw new ControlError("nexus-would-refuse", `Nexus would refuse this package: ${problems.join("; ")}`, 409);

      ehLog("info", "control.upload.start", { packageId: m.package.id, version: m.package.version, collection: link.slug });
      const outcome = await up.uploadToNexusCollection(api, { info: named, packagePath: file, target: link });
      if (!outcome.ok) {
        throw new ControlError("upload-failed", `${outcome.failure.title} ${outcome.failure.details.join(" ")}`.trim(), 500);
      }
      await cfg.rememberNexusCollectionLink(getCollectionsConfigDir(), m.package.id, outcome.link).catch(() => false);
      const url = up.nexusCollectionUrl(outcome.link, outcome.revisionNumber);
      const changelog = await revisionChangelog(api, m, outcome.link.slug, outcome.revisionNumber);
      api.sendNotification?.({ type: "success", title: "Draft uploaded to Nexus", message: `${live.name}: publish it on Nexus when it is ready.` });
      return {
        collection: outcome.link.slug,
        name: live.name,
        version: m.package.version,
        revisionNumber: outcome.revisionNumber,
        status: outcome.revisionStatus ?? "draft",
        url,
        note: "A DRAFT. Publishing it is the curator's click on Nexus.",
        ...(changelog !== undefined ? { changelog } : {}),
        verified: { draft: true, revisionNumber: outcome.revisionNumber },
      };
    },
    describe: (_b: Body, r: Record<string, unknown>): string => `uploaded ${String(r["name"])} ${String(r["version"])} as a draft (revision ${String(r["revisionNumber"])})`,
  },
};
