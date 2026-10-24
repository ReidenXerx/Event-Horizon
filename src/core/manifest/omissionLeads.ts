/**
 * ──────────────────────────────────────────────────────────────────────
 * Which archive files are missing from staging *because Vortex lost them*?
 *
 * `verifyStagingAgainstArchive` already reports `archiveEntriesNotStaged` —
 * every archive entry whose content appears nowhere in the curator's staging
 * folder. That is the omission signal, and until now nothing consumed it,
 * because on its own it is not usable: measured at **8.5%** of entries on a
 * real profile and dominated by files that were never meant to be installed.
 *
 * The FOMOD script disambiguates it perfectly, but only **~17%** of archives
 * contain one — despite Vortex labelling almost every mod `installerType:
 * "fomod"`, which means "handled by the fomod installer", not "has a script".
 * So for ~83% of mods there is no declared expected set, and the question is
 * whether the raw signal can be split without one.
 *
 * It can, because the two populations have different SHAPES:
 *
 *  - A file that was never installed belongs to a directory that is absent in
 *    its ENTIRETY — an unselected option folder, a docs folder, `fomod/`.
 *    Nothing in it staged, because nothing in it was ever meant to.
 *  - A file Vortex LOST belongs to a directory that is otherwise present. A
 *    dropped write during a bulk install leaves a folder with holes in it —
 *    37 of 40 textures staged, three gone.
 *
 * Directory cohesion is therefore the discriminator, and it needs nothing but
 * the archive listing we already have. A wholly-absent directory is suppressed;
 * a partially-present one yields a lead.
 *
 * ## Presence is tested by PATH, not by content
 *
 * Containment (`verifyStagingAgainstArchive`) deliberately matches by content,
 * because a FOMOD renames files on install. That is right for its question —
 * "did these staged bytes come from the archive?" — and wrong for this one.
 * Measured over 60 real mods, content matching produced 169 high leads across
 * 10 mods, nearly all of them artefacts: the build passes staged files with no
 * crc, so matching degrades to SIZE ALONE and small `.ini` files collide with
 * unrelated same-size files, manufacturing half-present directories.
 *
 * Path matching removes that. Vortex strips a leading wrapper directory, so the
 * ARCHIVE path is usually the longer one (`01 Main/meshes/x.nif` staged as
 * `meshes/x.nif`); a FOMOD `destination` can add a prefix instead, so the tail
 * is compared in both directions.
 *
 * ## Archives that declare alternatives get no answer at all
 *
 * An archive containing a FOMOD script offers options, and this module cannot
 * tell an unchosen one from a lost file — parallel option folders even share
 * basenames, so the selected option's files tail-match the unselected ones and
 * manufacture partial directories. Measured: excluding FOMOD archives took the
 * raw signal from 750 entries to 36 and the leads from 77-in-6-mods to
 * 8-in-1-mod, while recall against simulated losses held at 93%.
 *
 * Those mods are not abandoned — they are exactly the ones `fomodReplay`
 * answers authoritatively. This module covers the ~83% it cannot.
 *
 * Extension cohesion sharpens it further. A folder of 40 staged `.dds` missing
 * three more `.dds` is a strong lead; the same folder missing one `.txt` is
 * almost certainly a readme that the installer skipped. So a missing entry
 * whose extension also appears among its STAGED siblings ranks `high`, and one
 * whose extension appears nowhere alongside it ranks `medium`.
 *
 * These are LEADS, never verdicts — the same discipline the rest of this area
 * follows. A wrong "missing" claim is worse than no claim: it sends the curator
 * to reinstall a mod that was never broken. Nothing here decides anything; it
 * ranks what a human should look at first.
 * ──────────────────────────────────────────────────────────────────────
 */

import type { ArchiveEntry, ArchiveListing } from "./archiveContents";

export type OmissionConfidence = "high" | "medium";

export type OmissionLead = {
  /** Archive path of the entry that never reached staging. */
  path: string;
  /** Its parent directory inside the archive; `""` at the archive root. */
  dir: string;
  /** How many archive entries live in that directory. */
  dirTotal: number;
  /** How many of them are absent from staging. */
  dirMissing: number;
  confidence: OmissionConfidence;
  /** Plain-language justification, safe to show a curator verbatim. */
  reason: string;
};

export type OmissionAnalysis = {
  /** Ranked: `high` first, then by how complete the surrounding folder is. */
  leads: OmissionLead[];
  /** Entries dropped as legitimately-not-installed. */
  suppressed: number;
  /** Directories absent in their entirety (the dominant benign case). */
  suppressedDirectories: number;
  /**
   * True when the archive carries a FOMOD script. No leads are produced:
   * absence cannot be distinguished from "not selected" without replaying it.
   */
  declaredAlternatives: boolean;
};

/**
 * Where a FOMOD script lives; case and nesting vary in the wild.
 *
 * Exported because every comparison of an archive against staging needs it:
 * a script means the archive's file set is a MENU, not a promise, so absence
 * from staging says nothing. Takes a bare entry list so callers that read a
 * listing for another purpose can ask without building an `ArchiveListing`.
 */
export function declaresAlternatives(listing: {
  entries: readonly { path: string }[];
}): boolean {
  return listing.entries.some((e) => {
    const p = e.path.toLowerCase();
    return p === "moduleconfig.xml" || p.endsWith("/moduleconfig.xml");
  });
}

/**
 * Archive entries with no staged counterpart, compared on path tails in both
 * directions so a stripped wrapper dir or an added FOMOD destination still
 * matches. Indexed by basename so this stays near-linear rather than comparing
 * every archive entry against every staged file.
 */
export function findNotStaged(
  listing: ArchiveListing,
  stagedPaths: readonly string[],
): ArchiveEntry[] {
  const byBase = new Map<string, string[]>();
  for (const raw of stagedPaths) {
    const lower = raw.toLowerCase();
    const base = lower.slice(lower.lastIndexOf("/") + 1);
    const bucket = byBase.get(base);
    if (bucket === undefined) byBase.set(base, [lower]);
    else bucket.push(lower);
  }
  return listing.entries.filter((entry) => {
    const a = entry.path.toLowerCase();
    const base = a.slice(a.lastIndexOf("/") + 1);
    const candidates = byBase.get(base);
    if (candidates === undefined) return true;
    return !candidates.some(
      (s) => s === a || a.endsWith(`/${s}`) || s.endsWith(`/${a}`),
    );
  });
}

/** Installer metadata. Present in the archive, never installed. */
export function isInstallerMetadata(archivePath: string): boolean {
  const lower = archivePath.toLowerCase();
  return lower.startsWith("fomod/") || lower.includes("/fomod/");
}

function dirOf(archivePath: string): string {
  const idx = archivePath.lastIndexOf("/");
  return idx === -1 ? "" : archivePath.slice(0, idx);
}

function extOf(archivePath: string): string {
  const base = archivePath.slice(archivePath.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  return dot <= 0 ? "" : base.slice(dot).toLowerCase();
}

/**
 * Report archive files that never reached staging and are not explained by the
 * archive's own shape.
 *
 * @param listing every entry in the archive
 * @param stagedPaths the curator's staged file paths, archive-relative and
 *                    POSIX-separated
 */
export function findOmissionLeads(
  listing: ArchiveListing,
  stagedPaths: readonly string[],
): OmissionAnalysis {
  const empty = {
    leads: [] as OmissionLead[],
    suppressed: 0,
    suppressedDirectories: 0,
  };
  if (declaresAlternatives(listing)) {
    return { ...empty, declaredAlternatives: true };
  }
  const notStaged = findNotStaged(listing, stagedPaths);
  if (notStaged.length === 0) {
    return { ...empty, declaredAlternatives: false };
  }

  const missingPaths = new Set(notStaged.map((e) => e.path));

  // Per directory: how many entries the ARCHIVE has, and which of them staged.
  const dirTotals = new Map<string, number>();
  const dirStagedExts = new Map<string, Set<string>>();
  for (const entry of listing.entries) {
    const dir = dirOf(entry.path);
    dirTotals.set(dir, (dirTotals.get(dir) ?? 0) + 1);
    if (!missingPaths.has(entry.path)) {
      let exts = dirStagedExts.get(dir);
      if (exts === undefined) {
        exts = new Set<string>();
        dirStagedExts.set(dir, exts);
      }
      exts.add(extOf(entry.path));
    }
  }

  const dirMissing = new Map<string, number>();
  for (const entry of notStaged) {
    const dir = dirOf(entry.path);
    dirMissing.set(dir, (dirMissing.get(dir) ?? 0) + 1);
  }

  const leads: OmissionLead[] = [];
  let suppressed = 0;
  const suppressedDirs = new Set<string>();

  for (const entry of notStaged) {
    const dir = dirOf(entry.path);
    const total = dirTotals.get(dir) ?? 0;
    const missing = dirMissing.get(dir) ?? 0;
    const stagedInDir = total - missing;

    if (isInstallerMetadata(entry.path)) {
      suppressed += 1;
      continue;
    }

    // The dominant benign case: nothing from this directory staged at all, so
    // it was an unselected option or a docs folder rather than a partial
    // extraction. Suppressed wholesale — this is the 8.5% noise floor.
    if (stagedInDir === 0) {
      suppressed += 1;
      suppressedDirs.add(dir);
      continue;
    }

    const stagedExts = dirStagedExts.get(dir) ?? new Set<string>();
    const ext = extOf(entry.path);
    const siblingSharesExtension = stagedExts.has(ext);
    const pct = Math.round((stagedInDir / total) * 100);

    leads.push({
      path: entry.path,
      dir,
      dirTotal: total,
      dirMissing: missing,
      confidence: siblingSharesExtension ? "high" : "medium",
      reason: siblingSharesExtension
        ? `${stagedInDir} of ${total} files in "${dir || "the archive root"}" are ` +
          `installed (${pct}%), including others of the same ${ext || "extensionless"} ` +
          `type — a partially extracted folder is what a lost write looks like.`
        : `${stagedInDir} of ${total} files in "${dir || "the archive root"}" are ` +
          `installed (${pct}%), but nothing else of its ${ext || "extensionless"} ` +
          `type is — more likely a file the installer skips than one that was lost.`,
    });
  }

  // High confidence first; within a tier the fullest directories lead, because
  // one hole in an otherwise complete folder is the sharpest signal there is.
  leads.sort((a, b) => {
    if (a.confidence !== b.confidence) return a.confidence === "high" ? -1 : 1;
    const aFull = (a.dirTotal - a.dirMissing) / a.dirTotal;
    const bFull = (b.dirTotal - b.dirMissing) / b.dirTotal;
    if (aFull !== bFull) return bFull - aFull;
    return a.path.localeCompare(b.path);
  });

  return {
    leads,
    suppressed,
    suppressedDirectories: suppressedDirs.size,
    declaredAlternatives: false,
  };
}
