/**
 * ──────────────────────────────────────────────────────────────────────
 * What THIS build would change, shown while you are still filling the form.
 *
 * The diff already existed, and it was somewhere nobody stood: inside an
 * expanded published collection's details on the dashboard. A curator about
 * to press Build is on the form, and the one question they have there —
 * "what am I actually shipping that I was not shipping before?" — was two
 * screens away.
 *
 * ─── THE BASELINE IS THE LAST PACKAGE OF THIS SLUG ─────────────────────
 * Not the draft, not the config: the `.ehcoll` that was actually built. A
 * draft records intentions, and a curator's profile has moved underneath it
 * since. Only a built package is a statement of what users received.
 *
 * ─── AND "NO PREVIOUS BUILD" IS AN ANSWER, NOT A FAILURE ───────────────
 * A first build has nothing to diff against, and saying so is useful. So is
 * saying that the package could not be read. Those are three distinct
 * outcomes and the caller must be able to tell them apart, because rendering
 * "no changes" for any of them would be a lie about a package.
 * ──────────────────────────────────────────────────────────────────────
 */

import { slugifyPackageName } from "../../../core/manifest/packageFileName";
import {
  diffCollectionAgainstProfile,
  summarizeBuiltMods,
  type CollectionDiff,
} from "../../../core/curator/collectionDiff";
import type { AuditorMod } from "../../../core/getModsListForProfile";
import type { BuiltPackage } from "./publishedDetails";
import type { EhcollMod } from "../../../types/ehcoll";

export type BuildDiffOutcome =
  | {
      kind: "diff";
      diff: CollectionDiff;
      /** The version this is measured against. */
      againstVersion: string;
      fileName: string;
    }
  /** Nothing has been built under this name yet. */
  | { kind: "first-build" }
  /** A package exists but could not be read. Never silently "no changes". */
  | { kind: "unreadable"; fileName: string; why: string };

/** The manifest fields this needs, so a test does not build a whole package. */
type ReadPackage = (fullPath: string) => Promise<{
  manifest: { package: { version: string }; mods: readonly EhcollMod[] };
}>;

type FindPackages = (
  outputDir: string,
  slug: string,
  knownSlugs: readonly string[],
) => Promise<readonly BuiltPackage[]>;

/**
 * Diff the profile against the newest package built under this name.
 *
 * Both effects are injected. The decision — which package is the baseline,
 * and what each failure means — is the part worth testing, and it should not
 * need a zip on disk to exercise.
 */
export async function loadBuildDiff(args: {
  /** The collection name as typed in the form. */
  collectionName: string;
  outputDir: string;
  /** Other collections in the same folder, so a shared prefix cannot claim a build. */
  knownSlugs?: readonly string[];
  current: readonly AuditorMod[];
  findPackages: FindPackages;
  readPackage: ReadPackage;
  /**
   * Stat-only shapes of the live staging folders, keyed by Vortex mod id.
   *
   * Injected rather than computed here for two reasons: this module is
   * testable without a filesystem, and walking a thousand folders is a cost
   * the CALLER should decide to pay. Omitted, the staged-files axis does not
   * run — and the diff says so rather than implying those mods matched.
   */
  liveShapes?: () => Promise<ReadonlyMap<string, string>>;
}): Promise<BuildDiffOutcome> {
  // Guard the NAME, not the slug. `slugifyPackageName` falls back to the
  // literal "collection" for anything that slugs to nothing, so an unnamed
  // draft would go looking for `collection-*.ehcoll` and diff against a
  // different collection that happens to be called Collection.
  const named = (args.collectionName ?? "").trim();
  if (named === "") return { kind: "first-build" };
  const slug = slugifyPackageName(named);

  const packages = await args.findPackages(
    args.outputDir,
    slug,
    args.knownSlugs ?? [],
  );
  const newest = packages[0];
  if (newest === undefined) return { kind: "first-build" };

  try {
    const read = await args.readPackage(newest.fullPath);
    return {
      kind: "diff",
      diff: diffCollectionAgainstProfile({
        built: summarizeBuiltMods(read.manifest.mods),
        current: args.current,
        ...(args.liveShapes !== undefined
          ? { liveShapes: await args.liveShapes() }
          : {}),
      }),
      againstVersion: read.manifest.package.version,
      fileName: newest.fileName,
    };
  } catch (err) {
    return {
      kind: "unreadable",
      fileName: newest.fileName,
      why: err instanceof Error ? err.message : String(err),
    };
  }
}
