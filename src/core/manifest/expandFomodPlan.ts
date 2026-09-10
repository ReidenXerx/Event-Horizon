/**
 * Turn FOMOD source specs into the concrete files a correct install produces.
 *
 * {@link replayFomod} deliberately stops at SOURCE specs, because expanding a
 * `<folder>` needs the archive listing. This is that join, and it is also where
 * `priority` finally means something.
 *
 * ─── PRIORITY BELONGS HERE, NOT IN THE REPLAY ─────────────────────────
 * FOMOD resolves overlapping installs by `priority`, and the obvious place to
 * apply it — while collecting specs — is wrong. `<folder>` specs overwhelmingly
 * install to the mod ROOT, so they all share the empty destination; resolving
 * there collapsed a real 25-choice install from 30 folders to one. Two folders
 * installing to the root do not conflict. Two FILES landing on the same
 * destination path do, and that is only knowable after expansion.
 *
 * ─── DESTINATION SEMANTICS ────────────────────────────────────────────
 * `<folder source="A" destination="B">` installs every archive entry under
 * `A/` to `B/<path relative to A>`; an empty or absent destination means the
 * mod root. `<file source="A/x.esp" destination="B/y.esp">` installs that one
 * entry to `B/y.esp`, falling back to its basename at the root.
 *
 * Comparison is case-insensitive throughout: FOMOD authors are inconsistent
 * about case, Windows does not care, and a case-sensitive compare would invent
 * mismatches on a correct install.
 */

import type { ArchiveEntry, ArchiveListing } from "./archiveContents";
import type { FomodFileSpec } from "./fomodReplay";

/** One file a correct install is expected to produce. */
export type ExpectedFile = {
  /** Destination path relative to the mod's staging root, POSIX-style. */
  path: string;
  /** The archive entry that supplies it. */
  entry: ArchiveEntry;
  /** Priority of the spec that won this destination. */
  priority: number;
};

export type ExpandResult = {
  files: ExpectedFile[];
  /**
   * Specs that matched nothing in the archive.
   *
   * A spec pointing at a path the archive does not contain means the script and
   * the archive disagree — usually our source-prefix matching being wrong, not
   * a broken mod. Surfaced so the caller can downgrade rather than report a
   * confidently empty expectation.
   */
  unmatchedSpecs: FomodFileSpec[];
  /** Destination paths that more than one spec wanted; resolved by priority. */
  contested: number;
};

const norm = (s: string): string => s.split("\\").join("/").toLowerCase();

/** Strip leading/trailing slashes so joins never double up. */
const trim = (s: string): string => s.replace(/^\/+/, "").replace(/\/+$/, "");

/**
 * ─── `.` IS THE MOD ROOT, NOT A FOLDER CALLED "." ──────────────────────
 * `trim` strips slashes and nothing else, so `destination="."` survived as a
 * path segment and every file under it was predicted at `./interface/...`.
 * The staged file is `interface/...`, the two never compared equal, and the
 * build reported the mod as missing almost everything it had installed.
 *
 * Measured on a real Skyrim collection: `Skyrim Extended Cut - Saints and
 * Seducers` declares `<folder source="00 Core Files" destination="." />` —
 * the FOMOD Creation Tool writes exactly that — and was reported "missing 115
 * of 120 files", with advice to reinstall a mod that was installed perfectly.
 *
 * Empty and `.` segments are dropped from BOTH sides of the join and from
 * sources, anywhere they appear: `./Textures`, `Textures/.`, `a//b`. `..` is
 * left alone on purpose — it would climb out of the mod folder, which is not
 * something to normalise quietly.
 */
const clean = (s: string): string =>
  s
    .split("/")
    .filter((segment) => segment !== "" && segment !== ".")
    .join("/");

function join(destination: string | undefined, relative: string): string {
  const base = clean((destination ?? "").split("\\").join("/"));
  const rel = clean(relative);
  if (base === "") return rel;
  return rel === "" ? base : `${base}/${rel}`;
}

/**
 * Expand replayed specs against an archive listing.
 *
 * Later specs of equal priority win, matching document-order-wins. Strictly
 * higher priority always wins regardless of order.
 */
export function expandFomodPlan(
  specs: FomodFileSpec[],
  listing: ArchiveListing,
): ExpandResult {
  // Pre-normalise once; a large archive is thousands of entries and every spec
  // would otherwise re-lower-case all of them.
  //
  // `norm` is for MATCHING ONLY. The emitted path is always sliced from the
  // archive's real `path`, because the expected path is compared against a real
  // staging folder and shown to a human — lower-casing the output would make a
  // correct prediction look wrong and read as gibberish.
  const entries = listing.entries.map((entry) => ({
    entry,
    norm: norm(entry.path),
    real: entry.path.split("\\").join("/"),
  }));

  const winners = new Map<string, ExpectedFile>();
  const unmatchedSpecs: FomodFileSpec[] = [];
  let contested = 0;

  for (const spec of specs) {
    const src = clean(norm(spec.source));
    let matched = 0;

    if (spec.isFolder) {
      const prefix = src === "" ? "" : `${src}/`;
      for (const { entry, norm: entryPath, real } of entries) {
        if (prefix !== "" && !entryPath.startsWith(prefix)) continue;
        // Slice the REAL path by the matched prefix length so casing survives.
        const relative = prefix === "" ? real : real.slice(prefix.length);
        if (relative === "") continue;
        matched += 1;
        place(join(spec.destination, relative), entry, spec.priority);
      }
    } else {
      const hit = entries.find((e) => e.norm === src);
      if (hit !== undefined) {
        matched = 1;
        // A file spec's destination is the full target path when given;
        // otherwise the file lands at the root under its own name.
        const destination = spec.destination;
        // `.` alone means the root, so it falls through to "own name at the
        // root" exactly like an empty destination does.
        const cleaned =
          destination === undefined
            ? ""
            : clean(destination.split("\\").join("/"));
        const target =
          cleaned !== "" ? cleaned : (hit.real.split("/").pop() ?? hit.real);
        place(target, hit.entry, spec.priority);
      }
    }

    if (matched === 0) unmatchedSpecs.push(spec);
  }

  function place(target: string, entry: ArchiveEntry, priority: number): void {
    const key = target.toLowerCase();
    const prev = winners.get(key);
    if (prev === undefined) {
      winners.set(key, { path: target, entry, priority });
      return;
    }
    contested += 1;
    // >= so a later spec of equal priority wins (document order).
    if (priority >= prev.priority) winners.set(key, { path: target, entry, priority });
  }

  return { files: Array.from(winners.values()), unmatchedSpecs, contested };
}
