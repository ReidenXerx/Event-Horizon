/**
 * ──────────────────────────────────────────────────────────────────────
 * What could be deleted, and — more importantly — what could not.
 *
 * Vortex never removes anything. Every version of every mod you have ever
 * downloaded stays in the download folder, and every superseded install stays
 * in staging. Measured on the real Skyrim profile: 163 GB of downloads, of
 * which 968 files across 371 mods are older versions of something — 73 GB.
 *
 * This is the planning half, and it is pure so that the dangerous half has
 * nothing to decide. It produces a report a human reads before anything is
 * touched; deleting is a separate, explicit act.
 *
 * ─── THE ORDER IS LOAD-BEARING ─────────────────────────────────────────
 * A mod entry is what HOLDS a reference to an archive. So an old version's
 * archive is not deletable while the old mod is still installed — remove the
 * mod first and the archive becomes an orphan, then it can go. The plan is
 * computed in that order and says so, because a curator who deletes archives
 * first is deleting the only copy of something Vortex still points at.
 *
 * ─── AND THE BUILD NEEDS ARCHIVES ──────────────────────────────────────
 * Event Horizon hashes the archive of every installed mod at build time. An
 * archive referenced by ANY mod record — enabled or not, any profile — is
 * never a candidate here. Getting that wrong recreates the "771 archives
 * missing" failure this project already had once.
 *
 * ─── AN ORPHAN IS NOT AUTOMATICALLY RUBBISH ────────────────────────────
 * An archive nothing references may be a superseded version, or it may be
 * something the curator downloaded on purpose and has not installed yet.
 * Those are indistinguishable by reference count alone, so they are split:
 * an orphan with a NEWER version of the same Nexus mod installed is
 * superseded; one with nothing installed is reported separately and never
 * selected by default. Deleting a deliberate download to save space is the
 * one outcome worse than not saving it.
 * ──────────────────────────────────────────────────────────────────────
 */

import {
  fileIdentity,
  identityCandidates,
  type CuratorMod,
} from "./profileActions";
import { stripTrailingVersion } from "./fileNameVersion";

/** One archive as Vortex's download store describes it. */
export type DownloadEntry = {
  /** Vortex's download id — what `mod.archiveId` points at. */
  id: string;
  fileName: string;
  bytes: number;
  /**
   * Nexus's own name for this FILE — not for the mod page.
   *
   * What separates two different files on one page from two versions of the
   * same file, and therefore what stands between an uninstalled addon and a
   * permanent delete. Absent on a download Vortex fetched without file
   * details; the file name then answers for it.
   */
  logicalFileName?: string;
  /**
   * The FILE's version as Nexus reported it, when the download record kept
   * one. Only used to cut the version out of the name; never compared.
   */
  version?: string;
  /** Nexus mod id, when Vortex recorded one. */
  nexusModId?: number;
  /** Nexus file id, when Vortex recorded one. */
  nexusFileId?: number;
};

/**
 * Why we believe one install supersedes another, strongest first.
 *
 * - `update-chain` — PROOF. Vortex writes `newestFileId` by walking Nexus's
 *   own file-update chain from the installed file, so when that lands on
 *   another install's file id, Nexus itself says this one replaces it.
 * - `same-file` — the same Nexus FILE at a lower version. Strong: an author
 *   keeps a file's name across version uploads and gives a different name to
 *   a different file.
 * - `same-page-only` — they share a mod id and nothing else. NOT evidence:
 *   one page ships a main file, optional files, variants and patches, and
 *   this is exactly the case that offered "Barbarian Bodypaints - CBBE" for
 *   deletion because "- Male" existed with a higher file id.
 */
export type SupersedeEvidence = "update-chain" | "same-file" | "same-page-only";

export type ModRemoval = {
  mod: CuratorMod;
  /** The installed version that replaces it. */
  supersededBy: CuratorMod;
  evidence: SupersedeEvidence;
};

export type ArchiveRemoval = {
  entry: DownloadEntry;
  /**
   * - `orphan-superseded` — nothing references it AND a newer version of the
   *   same Nexus mod is installed. Safe.
   * - `freed-by-removal`  — referenced only by a mod this plan removes, so it
   *   becomes an orphan once that removal happens.
   */
  reason: "orphan-superseded" | "freed-by-removal";
};

export type CleanupPlan = {
  /** Old mod entries to remove, via Vortex so its state stays consistent. */
  removeMods: ModRemoval[];
  /** Archives deletable once the removals above have happened. */
  deleteArchives: ArchiveRemoval[];
  bytesFreed: number;
  /**
   * Orphans with NO version of that mod installed.
   *
   * Reported, never planned. A download the curator made deliberately and has
   * not installed looks exactly like a leftover from here.
   */
  unclearOrphans: { entry: DownloadEntry }[];
  /**
   * Archives that ARE an installed mod's own, reached only by Nexus identity
   * because the mod's `archiveId` points at a download record that no longer
   * exists — the state an in-place mod update leaves behind.
   *
   * Never deletable, and deliberately not folded into `keptReferenced`: the
   * curator can repair these (a Downloads-tab rescan, or re-linking), and the
   * same broken link is what stops the build examining those mods' installers.
   */
  staleLinked: { entry: DownloadEntry }[];
  staleLinkedBytes: number;
  unclearBytes: number;
  /** Archives left alone because a mod still points at them. */
  keptReferenced: number;
};

/**
 * ──────────────────────────────────────────────────────────────────────
 * Installs that another install has actually replaced.
 *
 * ─── WHY THIS IS NO LONGER PART OF THE PLAN ────────────────────────────
 * It used to act on its own, and it was wrong twice over.
 *
 * A lower file id is not evidence of an older VERSION. A Nexus page ships a
 * main file and its optional patches under one mod id with different file
 * ids, so "the lower one is superseded" retires a patch the curator
 * installed deliberately. Worse, it ignored `enabled`: a curator who hits a
 * regression in v2 disables it and re-enables v1, and the plan then retired
 * v1 — the version actually in use.
 *
 * ─── AND WHY SHARING A PAGE IS NOT ENOUGH ──────────────────────────────
 * Even ranking candidates, "same mod id" produced plain false positives on a
 * real profile: `Barbarian Bodypaints - CBBE` was offered because
 * `- Male` existed with a higher file id, and `Community Overlays - Main`
 * because a `- Bugfix Patch` did. Both pairs are different FILES on one
 * page, not two versions of one file.
 *
 * So each candidate now carries the evidence behind it, and the two that
 * mean something — Nexus's own update chain, and the same file at a lower
 * version — are kept apart from the ones that mean nothing.
 *
 * This ranks candidates; it does not act. Removals stay the curator's tick.
 * ──────────────────────────────────────────────────────────────────────
 */
const EVIDENCE_RANK: Record<SupersedeEvidence, number> = {
  "update-chain": 3,
  "same-file": 2,
  "same-page-only": 1,
};

export function findSupersededMods(
  mods: readonly CuratorMod[],
): ModRemoval[] {
  const byModId = new Map<number, CuratorMod[]>();
  for (const mod of mods) {
    if (mod.nexusModId === undefined || mod.nexusFileId === undefined) continue;
    const list = byModId.get(mod.nexusModId);
    if (list === undefined) byModId.set(mod.nexusModId, [mod]);
    else list.push(mod);
  }

  const out: ModRemoval[] = [];
  for (const group of byModId.values()) {
    if (group.length < 2) continue;

    /** Best claim so far per older install — strongest evidence wins. */
    const best = new Map<string, ModRemoval>();
    const consider = (
      older: CuratorMod,
      newer: CuratorMod,
      evidence: SupersedeEvidence,
    ): void => {
      if (older.id === newer.id) return;
      // Strictly older. Equal file ids are the SAME file installed twice —
      // redundant, but not a version question, and `findDuplicates` says so
      // with the confidence that case actually carries.
      if ((older.nexusFileId ?? 0) >= (newer.nexusFileId ?? 0)) return;
      // The rollback. An enabled install "superseded" by a disabled one is a
      // curator running an older version on purpose, and suggesting they
      // delete it inverts what they chose.
      if (older.enabled && !newer.enabled) return;
      const held = best.get(older.id);
      if (held === undefined || EVIDENCE_RANK[evidence] > EVIDENCE_RANK[held.evidence]) {
        best.set(older.id, { mod: older, supersededBy: newer, evidence });
      }
    };

    // 1. Nexus's own answer. `newestFileId` is the end of the update chain
    //    from THIS file; if another install is sitting on it, that install
    //    is this one's successor and no inference is involved.
    const byFileId = new Map<number, CuratorMod>();
    for (const mod of group) byFileId.set(mod.nexusFileId as number, mod);
    for (const mod of group) {
      if (mod.newestFileId === undefined) continue;
      const successor = byFileId.get(mod.newestFileId);
      if (successor !== undefined) consider(mod, successor, "update-chain");
    }

    /**
     * 2. The same FILE at a lower version. Grouped by the file's own name, so
     *    a variant is never compared against a different variant.
     *
     *    The name has its VERSION removed first, because authors put it
     *    there: `Addictol 1.0` and `Addictol 1.1` are one file, and grouping
     *    on the raw name puts them in separate buckets where neither can
     *    supersede the other. Vortex's own "Remove related" strips it the
     *    same way; `stripTrailingVersion` refuses the ambiguous cases that
     *    Vortex's unanchored version would mangle.
     *
     *    `fileIdentity` itself is deliberately NOT changed — it also keys
     *    update detection (`updateGroupKey`), and widening it there is a
     *    separate question with separate evidence.
     */
    const byIdentity = new Map<string, CuratorMod[]>();
    for (const mod of group) {
      const identity = fileIdentity(mod);
      if (identity === undefined) continue;
      const key = stripTrailingVersion(identity).toLowerCase();
      const list = byIdentity.get(key);
      if (list === undefined) byIdentity.set(key, [mod]);
      else list.push(mod);
    }
    for (const bucket of byIdentity.values()) {
      if (bucket.length < 2) continue;
      const sorted = [...bucket].sort(
        (a, b) => (b.nexusFileId ?? 0) - (a.nexusFileId ?? 0),
      );
      const newest = sorted[0] as CuratorMod;
      for (const older of sorted.slice(1)) consider(older, newest, "same-file");
    }

    // 3. Everything else that merely shares the page. Reported so nothing
    //    silently disappears, and labelled so nothing is mistaken for proof.
    const pageNewest = [...group].sort(
      (a, b) => (b.nexusFileId ?? 0) - (a.nexusFileId ?? 0),
    )[0] as CuratorMod;
    for (const mod of group) {
      if (best.has(mod.id)) continue;
      consider(mod, pageNewest, "same-page-only");
    }

    out.push(...best.values());
  }
  return out;
}

/** Candidates backed by something — Nexus's chain, or the same file. */
export function provenSupersedes(list: readonly ModRemoval[]): ModRemoval[] {
  return list.filter((r) => r.evidence !== "same-page-only");
}

/** Candidates that only share a mod page. A lead, and never more. */
export function unprovenSupersedes(list: readonly ModRemoval[]): ModRemoval[] {
  return list.filter((r) => r.evidence === "same-page-only");
}

/** The evidence, as the row says it. */
export function describeEvidence(evidence: SupersedeEvidence): string {
  if (evidence === "update-chain") return "Nexus update chain";
  if (evidence === "same-file") return "same file, older version";
  return "same page only";
}

/**
 * The whole plan, in the order it has to happen.
 *
 * `mods` must carry `archiveId` for the reference check to mean anything; a
 * mod whose archive is unknown protects nothing, so its archive is treated as
 * referenced rather than free.
 */
export function planCleanup(args: {
  mods: readonly CuratorMod[];
  downloads: readonly DownloadEntry[];
  /**
   * Mod ids the curator TICKED for removal. Nothing is removed otherwise.
   *
   * The planner deliberately does not choose these itself — a lower file id
   * does not prove an older version, and acting on that guess deleted a
   * patch the curator installed on purpose. `findSupersededMods` suggests;
   * this acts only on what came back.
   */
  removeModIds?: ReadonlySet<string>;
}): CleanupPlan {
  const { mods, downloads, removeModIds } = args;

  const chosen = removeModIds ?? new Set<string>();
  const removeMods = findSupersededMods(mods).filter((r) =>
    chosen.has(r.mod.id),
  );
  const removedIds = new Set(removeMods.map((r) => r.mod.id));

  // Every archive still spoken for AFTER the removals above.
  const stillReferenced = new Set<string>();
  for (const mod of mods) {
    if (removedIds.has(mod.id)) continue;
    if (mod.archiveId !== undefined && mod.archiveId !== "") {
      stillReferenced.add(mod.archiveId);
    }
  }
  // What the removed mods were holding — these become free, and are the only
  // reason the removal has to happen first.
  const freedByRemoval = new Set<string>();
  for (const removal of removeMods) {
    const archiveId = removal.mod.archiveId;
    if (archiveId !== undefined && archiveId !== "" && !stillReferenced.has(archiveId)) {
      freedByRemoval.add(archiveId);
    }
  }

  /**
   * ─── THE NEWEST FILE STILL INSTALLED, PER FILE — NOT PER PAGE ────────
   * Three rules have stood here. The first two were both too weak, and each
   * looked right until it was measured against a real profile.
   *
   * A Set of mod ids came first: "some version of this mod is installed" was
   * accepted as proof that an unreferenced download was superseded. It
   * destroyed exactly the files a curator most wants kept — a NEWER file
   * downloaded ahead of installing it, and every archive re-fetched by
   * archive recovery, which nothing references by `archiveId`, so all 771 of
   * them read as orphans of an installed page.
   *
   * A Map of mod id → newest installed file id came second. It fixed the
   * downloaded-ahead case and left the VARIANT case untouched, because a
   * page's newest file says nothing whatever about a DIFFERENT file on that
   * page. Measured on the real Fallout 4 profile: 18 mod pages ship
   * genuinely distinct files under one id — page 102734 hosts `Settlement
   * Visitors` and six separate `Visitor Addon …` files; page 64480, five
   * unrelated power-armor patches. Every uninstalled one of those was offered
   * for permanent deletion because some sibling had a higher file id.
   *
   * The mod half of this file already refused that inference: it groups by
   * `fileIdentity` before it compares versions. This is the same rule on the
   * archive half — newest installed file id per (page, FILE identity). Being
   * superseded now requires the same file, installed at a strictly newer
   * version, which is what the word was always supposed to mean.
   */
  const identityKey = (modId: number, identity: string): string =>
    `${modId}\u0000${identity}`;
  const newestInstalledFile = new Map<string, number>();
  for (const mod of mods) {
    if (removedIds.has(mod.id)) continue;
    if (mod.nexusModId === undefined || mod.nexusFileId === undefined) continue;
    for (const identity of identityCandidates(mod)) {
      const key = identityKey(mod.nexusModId, identity);
      const held = newestInstalledFile.get(key);
      if (held === undefined || mod.nexusFileId > held) {
        newestInstalledFile.set(key, mod.nexusFileId);
      }
    }
  }

  /**
   * ─── AN ARCHIVE CAN BE A MOD'S OWN, WITH A BROKEN LINK ────────────────
   * `stillReferenced` is keyed on `mod.archiveId`, and that link DIES when a
   * mod is updated in place: Vortex refreshes `version` and `nexusFileId` and
   * leaves `archiveId` pointing at the old download record, which was deleted
   * with the old file.
   *
   * The archive the mod actually uses then belongs to a record nothing points
   * at, so it reads as an orphan — and because its file id EQUALS the
   * installed one rather than being lower, it is not superseded either. It
   * lands in `unclearOrphans`, which the curator is told means "no version of
   * that mod is installed".
   *
   * That sentence is false for it. The mod IS installed; it is this exact
   * file. Ten archives on a real 978-mod collection were in that state,
   * including one whose mod the build could not examine at all.
   *
   * Nothing was ever at risk of deletion — an unclear orphan is never listed
   * and never selected — but a curator reading "N downloads have no version
   * installed" is being told something untrue about their own live archives,
   * and the reclaimable-space figure counts them.
   *
   * Matched on `(nexusModId, nexusFileId)` exactly. Not on the modId alone:
   * one page ships main files, variants and patches, and treating any of them
   * as "the installed one's archive" is the same-page fallacy this file was
   * twice rewritten to eliminate.
   */
  const installedIdentity = new Set<string>();
  for (const mod of mods) {
    if (removedIds.has(mod.id)) continue;
    if (mod.nexusModId === undefined || mod.nexusFileId === undefined) continue;
    installedIdentity.add(`${mod.nexusModId}:${mod.nexusFileId}`);
  }

  const deleteArchives: ArchiveRemoval[] = [];
  const unclearOrphans: { entry: DownloadEntry }[] = [];
  const staleLinked: { entry: DownloadEntry }[] = [];
  let keptReferenced = 0;

  for (const entry of downloads) {
    if (stillReferenced.has(entry.id)) {
      keptReferenced += 1;
      continue;
    }
    if (freedByRemoval.has(entry.id)) {
      deleteArchives.push({ entry, reason: "freed-by-removal" });
      continue;
    }
    /**
     * Before the orphan question: this IS an installed mod's archive, and the
     * only reason it looks unreferenced is a dead `archiveId`. Kept, counted
     * apart, and reported so the curator can repair the link rather than
     * wonder why a mod they use appears in a cleanup list.
     */
    if (
      entry.nexusModId !== undefined &&
      entry.nexusFileId !== undefined &&
      installedIdentity.has(`${entry.nexusModId}:${entry.nexusFileId}`)
    ) {
      staleLinked.push({ entry });
      continue;
    }
    // Orphan. "Superseded" means a STRICTLY NEWER version of THIS FILE is
    // installed — nothing weaker, and in particular not "a newer file exists
    // somewhere on this mod page". An archive we cannot place that way is not
    // evidence of anything, so it falls to `unclearOrphans`, which is
    // reported and never selected. A missing `nexusFileId`, a missing name,
    // or a name nothing installed shares are all unknowns, and an unknown is
    // never grounds for a permanent delete.
    let newestInstalled: number | undefined;
    if (entry.nexusModId !== undefined) {
      for (const identity of identityCandidates(entry)) {
        const held = newestInstalledFile.get(
          identityKey(entry.nexusModId, identity),
        );
        if (
          held !== undefined &&
          (newestInstalled === undefined || held > newestInstalled)
        ) {
          newestInstalled = held;
        }
      }
    }
    if (
      entry.nexusFileId !== undefined &&
      newestInstalled !== undefined &&
      entry.nexusFileId < newestInstalled
    ) {
      deleteArchives.push({ entry, reason: "orphan-superseded" });
    } else {
      unclearOrphans.push({ entry });
    }
  }

  return {
    removeMods,
    deleteArchives,
    bytesFreed: deleteArchives.reduce((n, a) => n + a.entry.bytes, 0),
    unclearOrphans,
    unclearBytes: unclearOrphans.reduce((n, o) => n + o.entry.bytes, 0),
    staleLinked,
    staleLinkedBytes: staleLinked.reduce((n, o) => n + o.entry.bytes, 0),
    keptReferenced,
  };
}

/** Bytes as something a person reads. */
export function formatSize(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(0)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}


/**
 * ──────────────────────────────────────────────────────────────────────
 * The two acts a curator decides separately.
 *
 * One plan came back holding both, and the view showed them as one flow —
 * which made the safe thing look dangerous and the dangerous thing look
 * routine. They are not the same act:
 *
 * - An ORPHAN archive is a download no installed mod points at, with a newer
 *   version of that same mod present. Deleting it changes nothing about the
 *   setup, and it is where nearly all the space is.
 * - Removing an OLD INSTALL changes the setup. It needs the curator's
 *   judgment, because a lower Nexus file id is not proof of an older version
 *   — one page ships a main file and its optional patches under one mod id.
 *   Its archive only becomes free afterwards, which is why the order matters.
 *
 * Splitting them is the whole readability fix: two questions with different
 * answers, asked separately.
 * ──────────────────────────────────────────────────────────────────────
 */

/** Archives already free — deletable without removing anything first. */
export function orphanArchives(plan: CleanupPlan): ArchiveRemoval[] {
  return plan.deleteArchives.filter((a) => a.reason === "orphan-superseded");
}

/** Archives that only become free once this plan's removals have happened. */
export function archivesFreedByRemoval(plan: CleanupPlan): ArchiveRemoval[] {
  return plan.deleteArchives.filter((a) => a.reason === "freed-by-removal");
}

/**
 * A plan carrying exactly the removals and archives given, bytes recomputed.
 *
 * `bytesFreed` is recomputed rather than carried over, because a narrowed
 * plan that kept the original total would put a number on the Apply button
 * that no longer describes what Apply does — the one place a stale figure is
 * read as a promise.
 */
export function cleanupSubset(args: {
  plan: CleanupPlan;
  removeMods: readonly ModRemoval[];
  deleteArchives: readonly ArchiveRemoval[];
}): CleanupPlan {
  const { plan, removeMods, deleteArchives } = args;
  return {
    ...plan,
    removeMods: [...removeMods],
    deleteArchives: [...deleteArchives],
    bytesFreed: deleteArchives.reduce((n, a) => n + a.entry.bytes, 0),
  };
}

/** Keep only the archives the curator ticked. */
export function tickedArchives(
  archives: readonly ArchiveRemoval[],
  ids: ReadonlySet<string>,
): ArchiveRemoval[] {
  return archives.filter((a) => ids.has(a.entry.id));
}
