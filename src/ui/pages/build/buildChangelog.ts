/**
 * The changelog for the build that is running: prepared before the package is
 * written, so it ships inside it, and recorded beside the config only once the
 * package exists (engine.ts).
 *
 * What it compares with, in order:
 *   1. the history kept beside the collection config, the normal case;
 *   2. the newest package of this collection already on disk, for a collection
 *      whose history began after its last release (every collection built
 *      before this existed). Only a package with the SAME package id and a
 *      DIFFERENT version counts: a rebuild of the version being built is not
 *      what came before it, and a package from another collection that shares
 *      a name prefix is not this one's history. That package's own changelog,
 *      if it has one, becomes the history;
 *   3. nothing, which makes this a first release.
 *
 * Disk access is injected so the choice between those is testable without a
 * filesystem.
 */

import * as fsp from "fs/promises";

import {
  recordBuild,
  renderChangelogBbcode,
  renderChangelogMarkdown,
  snapshotManifest,
  type ChangelogEntry,
  type ChangelogHistory,
  type ChangelogSnapshot,
} from "../../../core/changelog/changelog";
import { loadChangelogHistory } from "../../../core/changelog/changelogHistory";
import type { EhcollManifest } from "../../../types/ehcoll";
import { findBuiltPackages, type BuiltPackage } from "./publishedDetails";

export type PreparedChangelog = {
  entry: ChangelogEntry;
  /** The history to keep once the package exists. */
  history: ChangelogHistory;
  /** CHANGELOG.md for the package: every version. */
  markdown: string;
  /** This version only, as markdown. */
  entryMarkdown: string;
  /** This version only, as BBCode for a Nexus mod page. */
  bbcode: string;
  /** Why this reads as a first release when an earlier package exists but could not be read. */
  note?: string;
};

export type PrepareChangelogInput = {
  configDir: string;
  slug: string;
  outputDir: string;
  manifest: EhcollManifest;
  /** What the curator typed for this version. */
  notes: string;
  /** How many older packages to open looking for the previous version. */
  maxPackagesRead?: number;
  loadHistory?: (configDir: string, slug: string) => Promise<ChangelogHistory | undefined>;
  knownSlugs?: () => Promise<string[]>;
  findPackages?: (
    outputDir: string,
    slug: string,
    knownSlugs: readonly string[],
  ) => Promise<BuiltPackage[]>;
  readManifest?: (fullPath: string) => Promise<EhcollManifest>;
};

export async function prepareChangelog(
  args: PrepareChangelogInput,
): Promise<PreparedChangelog> {
  const next = snapshotManifest(args.manifest);
  let history = await (args.loadHistory ?? loadChangelogHistory)(args.configDir, args.slug);
  let previousPackage: ChangelogSnapshot | undefined;
  let note: string | undefined;
  if (history?.last === undefined) {
    const found = await findPreviousPackage(args, next.version);
    previousPackage = found.snapshot;
    note = found.note;
    if (history === undefined && found.entries !== undefined && found.entries.length > 0) {
      history = { schema: 1, entries: found.entries };
    }
  }
  const recorded = recordBuild(history, next, {
    date: args.manifest.package.createdAt,
    notes: args.notes,
    ...(previousPackage !== undefined ? { previousPackage } : {}),
  });
  const title = args.manifest.package.name;
  return {
    entry: recorded.entry,
    history: recorded.history,
    markdown: renderChangelogMarkdown(title, recorded.history.entries),
    entryMarkdown: renderChangelogMarkdown(title, [recorded.entry]),
    bbcode: renderChangelogBbcode(recorded.entry),
    ...(previousPackage === undefined && note !== undefined ? { note } : {}),
  };
}

async function findPreviousPackage(
  args: PrepareChangelogInput,
  version: string,
): Promise<{ snapshot?: ChangelogSnapshot; entries?: ChangelogEntry[]; note?: string }> {
  const known = await (args.knownSlugs ?? ((): Promise<string[]> => slugsIn(args.configDir)))();
  const packages = await (args.findPackages ?? findBuiltPackages)(args.outputDir, args.slug, known);
  const read = args.readManifest ?? readPackageManifest;
  const limit = args.maxPackagesRead ?? 3;
  let note: string | undefined;
  let opened = 0;
  for (const pkg of packages) {
    if (opened >= limit) break;
    opened += 1;
    let manifest: EhcollManifest;
    try {
      manifest = await read(pkg.fullPath);
    } catch (err) {
      note =
        `The previous package "${pkg.fileName}" could not be read, so this ` +
        `version's changelog is written as a first release: ` +
        `${err instanceof Error ? err.message : String(err)}`;
      continue;
    }
    if (manifest.package.id !== args.manifest.package.id) continue;
    if (manifest.package.version === version) continue;
    return {
      snapshot: snapshotManifest(manifest),
      ...(manifest.package.changelog !== undefined ? { entries: manifest.package.changelog } : {}),
    };
  }
  return note !== undefined ? { note } : {};
}

async function readPackageManifest(fullPath: string): Promise<EhcollManifest> {
  const { readEhcoll } = await import("../../../core/manifest/readEhcoll");
  return (await readEhcoll(fullPath)).manifest;
}

/** The other collections sharing this folder, so a shared name prefix cannot claim a package. */
async function slugsIn(configDir: string): Promise<string[]> {
  try {
    return (await fsp.readdir(configDir))
      .filter((f) => f.endsWith(".json") && !f.startsWith("."))
      .map((f) => f.slice(0, -".json".length));
  } catch {
    return [];
  }
}
