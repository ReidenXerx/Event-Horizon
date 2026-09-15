/**
 * What a published collection IS, without building it again.
 *
 * The dashboard card could only offer actions — Update, Rebuild, Delete — so
 * the only way to see what a collection actually contained was to start a
 * build and read the form, which loads and hashes the entire profile. That is
 * a minute of work to answer "how many mods was this, and which game version
 * did it want".
 *
 * Everything here is already on disk. Two sources, and they answer different
 * questions:
 *
 *   - the CONFIG says what the collection is set up to do next time — which
 *     external mods are flagged for bundling, what prerequisites it declares.
 *   - the PACKAGE says what was actually shipped — mod count, plugin count,
 *     the game version it demands of whoever installs it.
 *
 * They can disagree, and that is worth seeing: a bundle ticked after the last
 * build is a change waiting to ship.
 */

import * as fsp from "fs/promises";
import * as path from "path";

import { hasPackageManifest, readEhcoll } from "../../../core/manifest/readEhcoll";
import { packageFormatOf } from "../../../core/manifest/packageFileName";
import {
  summarizeBuiltMods,
  type BuiltModSummary,
} from "../../../core/curator/collectionDiff";
import type { PublishedCollectionSummary } from "../../../core/manifest/collectionConfig";
import type { CollectionConfig } from "../../../core/manifest/collectionConfig";

/** One built package on disk. */
export type BuiltPackage = {
  fileName: string;
  fullPath: string;
  bytes: number;
  builtAt: Date;
};

export type PublishedDetails = {
  /** Packages found for this slug, newest first. */
  packages: BuiltPackage[];
  /** External mods the curator flagged to be packed from staging. */
  bundledMods: string[];
  /** External mods with curator instructions attached. */
  modsWithInstructions: string[];
  /** Total external mods this collection knows about. */
  externalModCount: number;
  /** Prerequisites the collection declares (script extenders, ENB...). */
  prerequisites: string[];
  hasReadme: boolean;
  hasChangelog: boolean;
  /** Read from the newest package. Absent when none could be read. */
  shipped?: {
    version: string;
    mods: number;
    plugins: number;
    bundledArchives: number;
    gameId: string;
    gameVersion: string;
    gameVersionPolicy: string;
    verificationLevel: string;
    author: string;
  };
  /**
   * The shipped mod list, projected to what a diff needs.
   *
   * Lean on purpose: the manifest's own entries carry `state.stagingFiles`,
   * which on a 963-mod collection is every file of every mod, and this is held
   * in a React state while a details panel is open.
   */
  shippedMods?: BuiltModSummary[];
  /**
   * Why `shipped` is absent, when it is. A missing package is an ordinary
   * state (the curator moved or deleted it), not an error to hide.
   */
  shippedNote?: string;
};

/**
 * Every package this slug has produced, `.ehcoll` or `.zip`, newest first.
 *
 * Filenames are `<slug>-<version>.ehcoll`, and versions may contain dashes, so
 * a name alone is ambiguous: `ivy-2-1.0.3.ehcoll` is either slug `ivy` at
 * version `2-1.0.3` or slug `ivy-2` at version `1.0.3`. Both collections are
 * real on this curator's disk, with different package ids and different
 * release histories, so guessing wrong attributes one's builds to the other.
 *
 * Resolved by preferring the LONGEST known slug that matches — which is the
 * information the dashboard already has and the filename does not.
 */
export async function findBuiltPackages(
  outputDir: string,
  slug: string,
  /** Other collections sharing this folder. Longer matches win. */
  knownSlugs: readonly string[] = [],
): Promise<BuiltPackage[]> {
  let names: string[];
  try {
    names = await fsp.readdir(outputDir);
  } catch {
    return [];
  }
  const mine = slug.toLowerCase();
  const rivals = knownSlugs
    .map((s) => s.toLowerCase())
    .filter((s) => s !== mine && s.length > mine.length);

  const out: BuiltPackage[] = [];
  for (const name of names) {
    const lower = name.toLowerCase();
    const format = packageFormatOf(lower);
    if (!lower.startsWith(`${mine}-`) || format === undefined) continue;
    // A longer collection name also claims this file, and it is the better
    // claim: the extra characters are part of a real slug, not of a version.
    if (rivals.some((r) => lower.startsWith(`${r}-`))) continue;
    // A longer collection name also claims this file, and it is the better
    // claim: the extra characters are part of a real slug, not of a version.

    const fullPath = path.join(outputDir, name);
    // A .zip is a build only when manifest.json sits at its root; another zip
    // that happens to share the name is not one.
    if (format === "zip" && !(await hasPackageManifest(fullPath).catch(() => false))) continue;
    try {
      const st = await fsp.stat(fullPath);
      out.push({ fileName: name, fullPath, bytes: st.size, builtAt: st.mtime });
    } catch {
      /* vanished between readdir and stat — not worth reporting */
    }
  }
  return out.sort((a, b) => b.builtAt.getTime() - a.builtAt.getTime());
}

/** Names of external mods flagged for bundling, in a stable order. */
export function bundledModNames(config: CollectionConfig): string[] {
  return Object.entries(config.externalMods ?? {})
    .filter(([, entry]) => entry.bundled === true)
    .map(([id, entry]) => entry.name ?? id)
    .sort();
}

/** Names of external mods carrying curator instructions. */
export function modsWithInstructions(config: CollectionConfig): string[] {
  return Object.entries(config.externalMods ?? {})
    .filter(([, entry]) => (entry.instructions ?? "").trim().length > 0)
    .map(([id, entry]) => entry.name ?? id)
    .sort();
}

/**
 * Gather everything readable about a published collection.
 *
 * Never throws: a collection whose package was moved or deleted still has a
 * config worth showing, and a details panel that fails closed teaches the
 * curator not to open it.
 */
export async function loadPublishedDetails(args: {
  summary: PublishedCollectionSummary;
  config: CollectionConfig;
  outputDir: string;
  /** Slugs of the curator's other collections, so builds are not mis-claimed. */
  knownSlugs?: readonly string[];
}): Promise<PublishedDetails> {
  const { summary, config, outputDir } = args;
  const packages = await findBuiltPackages(
    outputDir,
    summary.slug,
    args.knownSlugs ?? [],
  );

  const details: PublishedDetails = {
    packages,
    bundledMods: bundledModNames(config),
    modsWithInstructions: modsWithInstructions(config),
    externalModCount: Object.keys(config.externalMods ?? {}).length,
    prerequisites: Object.entries(config.externalDependencies ?? {})
      .filter(([, entry]) => (entry as { include?: boolean }).include !== false)
      .map(([id]) => id)
      .sort(),
    hasReadme: (config.readme ?? "").trim().length > 0,
    hasChangelog: (config.changelog ?? "").trim().length > 0,
  };

  const newest = packages[0];
  if (newest === undefined) {
    details.shippedNote =
      "No built .ehcoll found for this collection — it may have been moved or deleted.";
    return details;
  }

  try {
    const read = await readEhcoll(newest.fullPath);
    const m = read.manifest;
    details.shipped = {
      version: m.package.version,
      mods: m.mods.length,
      plugins: m.plugins?.order?.length ?? 0,
      bundledArchives: read.bundledArchives.length,
      gameId: m.game.id,
      gameVersion: m.game.version,
      gameVersionPolicy: m.game.versionPolicy,
      verificationLevel: m.package.verificationLevel ?? "none",
      author: m.package.author,
    };
    details.shippedMods = summarizeBuiltMods(m.mods);
  } catch (err) {
    details.shippedNote = `Could not read ${newest.fileName}: ${
      err instanceof Error ? err.message : String(err)
    }`;
  }
  return details;
}
