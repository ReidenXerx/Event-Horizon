/**
 * ──────────────────────────────────────────────────────────────────────
 * What a curator can act on across their whole profile, decided in one place.
 *
 * Vortex manages mods one at a time and ships exactly one bulk operation —
 * update — which installs concurrently and loses files while doing it. The
 * rest a curator does by hand, several hundred times, or not at all.
 *
 * This is the decision layer for a view that offers those actions properly.
 * Pure: it takes a snapshot of what Vortex knows and returns what could be
 * done. Nothing here touches Vortex, the network or a disk, so every rule
 * below is testable without any of them.
 *
 * ─── ITS OWN SHAPE, NOT AuditorMod ─────────────────────────────────────
 * `AuditorMod` is the COLLECTION snapshot and carries what a package needs;
 * update availability and endorsement are Vortex view-state that no package
 * should record. Extending it was also measured as the wrong move on its own
 * terms: `impact` on `getModsForProfile` reports CRITICAL — 22 symbols across
 * build, install, doctor, resolver and actions — so a field added for this
 * view would ripple through five subsystems that have no use for it.
 *
 * ─── VERSIONS ARE COMPARED BY FILE ID, NEVER BY VERSION STRING ─────────
 * "1.10" sorts below "1.9" as a string and above it as a version, and authors
 * write versions in whatever shape they like — "v2", "2.0.1a", "1.0-RC3", a
 * date. Nexus's file id is an integer that only increases, and Vortex already
 * records the installed one and the newest one. So "is there an update" is a
 * comparison of two integers, and the version strings are carried only to
 * SHOW the curator, never to decide.
 *
 * ─── A DUPLICATE IS A LEAD, NOT A VERDICT ──────────────────────────────
 * Two installs from one Nexus page is usually an old version left behind, and
 * legitimately it is a main file plus an optional one from the same page.
 * Those are indistinguishable from here and only the curator knows which they
 * are, so the ambiguous case is reported as something to look at. The
 * unambiguous one — the SAME FILE installed twice — is stated plainly.
 * ──────────────────────────────────────────────────────────────────────
 */

/** One mod as the curator view sees it, read from live Vortex state. */
export type CuratorMod = {
  /** Vortex's mod id — the handle every action needs. */
  id: string;
  name: string;
  enabled: boolean;
  /** Vortex modType. Empty string is the default (deploys to Data). */
  modType: string;
  /** Installed version, for display only. */
  version?: string;
  /** Newest version Nexus knows about, for display only. */
  newestVersion?: string;
  nexusModId?: number;
  nexusFileId?: number;
  /** Newest file id Nexus knows about, when it is a number. */
  newestFileId?: number;
  /**
   * Vortex recorded the newest file id as the literal string `"unknown"`.
   *
   * That is not missing data — it is Vortex asserting THERE IS AN UPDATE and
   * that it cannot name the file. Its own `updateState` tests this FIRST, and
   * renders the mod with the go-to-the-site icon rather than the download one.
   *
   * It used to vanish on the way in: the attribute is read with a numeric
   * coercion, `Number("unknown")` is NaN, and NaN became `undefined` — so a
   * mod Vortex was actively flagging arrived here looking like a mod with no
   * update information at all, and neither update list could see it.
   */
  newestFileUnknown?: boolean;
  /** Vortex's endorsement state: "Undecided" | "Endorsed" | "Abstained". */
  endorsed?: string;
  /**
   * The NEXUS FILE's own display name — not the mod page's.
   *
   * The distinction one Nexus page hides. A page hosts many different files:
   * "Barbarian Bodypaints - CBBE" and "Barbarian Bodypaints - Male" share mod
   * id 31826 and are not versions of each other at all. Vortex's own fallback
   * chain for naming a file is `logicalFileName → fileName → mod name`, and
   * this follows it.
   */
  logicalFileName?: string;
  /** The archive's file name, as a fallback identity. */
  fileName?: string;
  /**
   * The game a mod's FILE was downloaded for, when it differs from the one
   * being managed.
   *
   * The compatible-download case: a Skyrim LE file installed under Skyrim SE.
   * Vortex's own update path reads `attributes.downloadGame ?? gameId` before
   * asking Nexus for anything, because the download lives under the other
   * game's id.
   */
  downloadGame?: string;
  /**
   * Vortex's download id for the archive this mod was installed from.
   *
   * The cleanup planner's whole safety rule reads this: an archive any mod
   * points at is never deletable, because the build hashes it. Absent means
   * Vortex tracks no source, which protects nothing.
   */
  archiveId?: string;
  /**
   * OUR flag: the version the curator froze this mod at.
   *
   * Vortex has no mod pin concept — the only `pinned` in its API is for tools
   * — so this is an attribute of our own and means nothing to Vortex. It
   * cannot stop Vortex's own update button. What it does is keep the mod out
   * of OUR bulk update and make a version change afterwards visible.
   */
  frozenAtVersion?: string;
};

/** A mod with a newer file on Nexus, and nothing stopping it being taken. */
export type UpdateCandidate = {
  mod: CuratorMod;
  fromFileId: number;
  toFileId: number;
  fromVersion: string;
  toVersion: string;
};

const shown = (v: string | undefined): string => v ?? "unknown";

/**
 * Mods with a newer file available — at most ONE per Nexus page.
 *
 * ─── WHY ONE ──────────────────────────────────────────────────────────
 * Vortex leaves the old install in place when a mod updates, so a profile
 * accumulates several installs of the same mod. Measured on the real profile:
 * 165 "updatable" mods across far fewer actual mods, including two copies of
 * Animated Armoury — 7.0 and 8.1 — both offering to become 8.2.
 *
 * Updating both would install 8.2 TWICE and leave four copies where there
 * were two. The tool would be making the exact mess it exists to clean up.
 *
 * So each Nexus page contributes one candidate: the NEWEST install, which is
 * the one whose update produces something the curator wants. The older copies
 * are already visible as duplicates, and cleaning them up is a different
 * action with different consequences.
 *
 * Frozen mods are filtered HERE rather than at the call site, so no future
 * caller can offer to update one by forgetting to ask.
 */
/**
 * A mod Nexus says is out of date, that we cannot update FOR the curator.
 *
 * `newestVersion` and `newestFileId` are set by two different parts of
 * Vortex's update check and one can arrive without the other: the version
 * comes straight off the mod page, while the file id is resolved by walking
 * `files.file_updates`, a chain that is broken or absent for plenty of real
 * mods. Measured on the profile this was written for: 271 mods carrying a
 * `newestVersion` and not one `newestFileId` in the same state.
 */
export type ManualUpdate = {
  mod: CuratorMod;
  fromVersion: string;
  toVersion: string;
  /** The mod page, when we know the id — the only place they can act. */
  url?: string;
};

/**
 * ─── UPDATES WE CAN SEE BUT NOT TAKE ───────────────────────────────────
 * `findUpdatable` requires a `newestFileId`, because that is the argument
 * Vortex's `mod-update` event needs — without one there is nothing to ask
 * for. That requirement is correct and must not be relaxed.
 *
 * What was wrong is that such mods then appeared NOWHERE. A curator with a
 * hundred out-of-date mods saw a handful in the update list and reasonably
 * concluded the check was broken, when in fact those were the only ones that
 * could be automated. An update we cannot perform is still an update the
 * curator needs to know about — it is the difference between "you are up to
 * date" and "twelve of these need a visit to their mod page".
 *
 * Deliberately kept apart from `UpdateCandidate` rather than folded in with a
 * nullable file id: the bulk updater must never receive one of these, and a
 * separate type makes that a compile error instead of a runtime check.
 */
/**
 * ──────────────────────────────────────────────────────────────────────
 * Vortex's own answer to "does this mod have an update?", transcribed.
 *
 * Read out of the shipped bundle rather than inferred, because the curator
 * compares our list against Vortex's "Update available" filter and any mod in
 * theirs and not ours reads as us being broken — which, twice now, we were.
 *
 *     updateState(attributes):
 *       if (!truthy(attributes.source)) return "current";
 *       hasNewerVersion = versionClean(newestVersion) !== versionClean(version)
 *       return  newestFileId === "unknown"
 *            || (truthy(newestFileId) && truthy(fileId)
 *                && newestFileId.toString() !== fileId.toString())
 *            || hasNewerVersion
 *
 * THREE independent signals, ORed. We only ever read the second, and read it
 * as a NUMBER — so the first was destroyed by the coercion (`Number("unknown")`
 * is NaN) and the third only reached us through a separate list that needs a
 * `newestVersion` Vortex does not always have.
 *
 * Deliberately NOT transcribed: the `source` check. Vortex uses it to keep
 * non-Nexus mods out of a Nexus-shaped question; every mod that reaches these
 * lists is already scoped to a Nexus page by its caller, and adding it here
 * would only drop mods for a reason we cannot see from this data.
 *
 * The version comparison is looser here than Vortex's `versionClean`, which
 * runs semver coercion. Looser errs toward SHOWING a mod, and a curator who
 * sees one extra row loses a glance; a curator who sees one fewer ships a
 * collection with a stale mod in it. That asymmetry decides it.
 * ──────────────────────────────────────────────────────────────────────
 */
export function vortexReportsUpdate(mod: CuratorMod): boolean {
  // 1. "There is an update; I cannot name the file."
  if (mod.newestFileUnknown === true) return true;

  // 2. A different file id. DIFFERENT, not newer — see findUpdatable for why
  //    the automated path additionally demands newer.
  if (
    mod.newestFileId !== undefined &&
    mod.nexusFileId !== undefined &&
    mod.newestFileId !== mod.nexusFileId
  ) {
    return true;
  }

  // 3. A different version string.
  const newest = mod.newestVersion?.trim();
  const current = mod.version?.trim();
  if (newest !== undefined && newest.length > 0) {
    if (current === undefined) return true;
    if (newest.toLowerCase() !== current.toLowerCase()) return true;
  }
  return false;
}

export function findManualUpdates(
  mods: readonly CuratorMod[],
): ManualUpdate[] {
  const out: ManualUpdate[] = [];
  const seen = new Set<string>();

  for (const mod of mods) {
    if (mod.frozenAtVersion !== undefined) continue;
    // Anything the automated path can take belongs there, not here.
    if (
      mod.nexusFileId !== undefined &&
      mod.newestFileId !== undefined &&
      mod.newestFileId > mod.nexusFileId
    ) {
      continue;
    }
    /**
     * Vortex's own predicate, whole — not just the version half.
     *
     * This used to require a `newestVersion` that differed, which covered one
     * of Vortex's three signals and silently dropped the other two. The one
     * that hurt: `newestFileId === "unknown"` means "there is an update, go
     * to the page", which is EXACTLY a manual update and exactly what this
     * list is for. Those mods appeared in Vortex's filter with the
     * go-to-the-site icon and in neither of our lists.
     */
    if (!vortexReportsUpdate(mod)) continue;

    // One per FILE, not one per page — see `updateGroupKey`.
    const key = updateGroupKey(mod);
    if (key !== undefined) {
      if (seen.has(key)) continue;
      seen.add(key);
    }

    out.push({
      mod,
      fromVersion: shown(mod.version),
      // Vortex does not always know the version — that is what "unknown"
      // means — so this says what is true rather than inventing a number.
      toVersion: shown(mod.newestVersion),
      ...(mod.nexusModId !== undefined && mod.downloadGame !== undefined
        ? {
            url: `https://www.nexusmods.com/${mod.downloadGame}/mods/${mod.nexusModId}`,
          }
        : {}),
    });
  }

  return out;
}

/**
 * ──────────────────────────────────────────────────────────────────────
 * What counts as "the same thing" when collapsing duplicate update rows.
 *
 * The PAGE alone is wrong, and wrong in the direction that hides work. One
 * Nexus page ships a main file, optional files, variants and patches, each
 * with its own file id and its own updates — `fileIdentity`'s docblock names
 * the case that proved it, where a bodypaint's CBBE and Male variants looked
 * like an old version and its replacement. Collapsing by page meant a curator
 * running three different files from one page saw one row and updated one
 * file, believing they had done all three.
 *
 * So the key is page + file. Two installs of the SAME file still collapse —
 * that is a genuine duplicate and only needs one visit — while different
 * files on one page each get their own row.
 *
 * `undefined` means we cannot tell which file this is, and the caller must
 * NOT collapse on a guess: showing one row too many costs a glance, and
 * hiding one costs a mod left at the wrong version.
 * ──────────────────────────────────────────────────────────────────────
 */
export function updateGroupKey(mod: CuratorMod): string | undefined {
  if (mod.nexusModId === undefined) return undefined;
  const file = fileIdentity(mod);
  return file === undefined ? undefined : `${mod.nexusModId}::${file}`;
}

export function findUpdatable(mods: readonly CuratorMod[]): UpdateCandidate[] {
  const best = new Map<string, CuratorMod>();
  const noPage: CuratorMod[] = [];

  for (const mod of mods) {
    if (mod.frozenAtVersion !== undefined) continue;
    if (mod.nexusFileId === undefined || mod.newestFileId === undefined) continue;
    // Strictly greater, not merely different. Vortex can carry a stale
    // `newestFileId` from before a mod was updated by hand, and treating that
    // as an update would install a file OLDER than the one present — a
    // downgrade wearing an update's clothes.
    if (mod.newestFileId <= mod.nexusFileId) continue;

    const key = updateGroupKey(mod);
    if (key === undefined) {
      // No page, or no way to tell which FILE this is. Cannot be shown to be
      // a duplicate of anything, so it gets its own row rather than being
      // folded into a mod it may have nothing to do with.
      noPage.push(mod);
      continue;
    }
    const held = best.get(key);
    if (held === undefined || (mod.nexusFileId ?? 0) > (held.nexusFileId ?? 0)) {
      best.set(key, mod);
    }
  }

  return [...best.values(), ...noPage].map((mod) => ({
    mod,
    fromFileId: mod.nexusFileId!,
    toFileId: mod.newestFileId!,
    fromVersion: shown(mod.version),
    toVersion: shown(mod.newestVersion),
  }));
}

/**
 * Older installs that an update would otherwise duplicate.
 *
 * The other half of the rule above: these are NOT offered an update, and the
 * curator should be told why rather than left wondering where they went.
 */
export function findUpdateShadowed(
  mods: readonly CuratorMod[],
): { mod: CuratorMod; newerInstall: CuratorMod }[] {
  const offered = new Map(
    findUpdatable(mods).map((c) => [c.mod.id, c.mod] as const),
  );
  /**
   * Keyed the same way `findUpdatable` groups, and that is not optional: if
   * the two disagreed, a mod could be offered an update AND listed as
   * shadowed by it, or shadowed by a mod that is a different FILE from the
   * same page and has nothing to do with it.
   */
  const byFile = new Map<string, CuratorMod>();
  for (const candidate of offered.values()) {
    const key = updateGroupKey(candidate);
    if (key !== undefined) byFile.set(key, candidate);
  }

  const out: { mod: CuratorMod; newerInstall: CuratorMod }[] = [];
  for (const mod of mods) {
    if (mod.frozenAtVersion !== undefined) continue;
    if (mod.nexusModId === undefined || mod.nexusFileId === undefined) continue;
    if (mod.newestFileId === undefined || mod.newestFileId <= mod.nexusFileId) continue;
    if (offered.has(mod.id)) continue;
    const key = updateGroupKey(mod);
    if (key === undefined) continue;
    const newer = byFile.get(key);
    if (newer !== undefined) out.push({ mod, newerInstall: newer });
  }
  return out;
}

/** A frozen mod, and whether the freeze still holds. */
export type FrozenMod = {
  mod: CuratorMod;
  frozenAtVersion: string;
  /** Present when the installed version no longer matches the frozen one. */
  driftedTo?: string;
  /** True when Nexus has something newer — the freeze is doing work. */
  updateWithheld: boolean;
};

/**
 * Every frozen mod, with the freeze's current standing.
 *
 * The drift arm is the entire point of freezing. We cannot stop Vortex
 * updating a mod from its own UI, so the guarantee is not "it cannot change"
 * but "you will know if it did" — and a promise to notice is only kept if
 * something actually looks.
 */
export function findFrozen(mods: readonly CuratorMod[]): FrozenMod[] {
  const out: FrozenMod[] = [];
  for (const mod of mods) {
    if (mod.frozenAtVersion === undefined) continue;
    const drifted =
      mod.version !== undefined && mod.version !== mod.frozenAtVersion;
    out.push({
      mod,
      frozenAtVersion: mod.frozenAtVersion,
      ...(drifted ? { driftedTo: mod.version } : {}),
      updateWithheld:
        mod.nexusFileId !== undefined &&
        mod.newestFileId !== undefined &&
        mod.newestFileId > mod.nexusFileId,
    });
  }
  return out;
}

/** Mods that can be endorsed: from Nexus, and not answered yet. */
export function findEndorsable(mods: readonly CuratorMod[]): CuratorMod[] {
  return mods.filter(
    (m) =>
      m.nexusModId !== undefined &&
      // Vortex writes "Undecided" for untouched and leaves the field absent on
      // mods it has never asked about. Both mean "not answered".
      (m.endorsed === undefined || m.endorsed === "Undecided"),
  );
}

export type DuplicateGroup = {
  nexusModId: number;
  mods: CuratorMod[];
  /**
   * - `same-file` — the identical Nexus file installed more than once. There
   *                 is no reading where both copies are wanted.
   * - `same-page` — one page, different files. Could be an old version left
   *                 behind, could be a main file plus an optional one. A lead
   *                 for the curator, never a verdict from us.
   */
  kind: "same-file" | "same-page";
};

/**
 * Installs that share a Nexus mod id.
 *
 * Reported in two kinds because they deserve different confidence. One
 * "duplicates" number would sit a legitimate main-plus-patch pair next to a
 * genuinely stale copy and invite the curator to delete either.
 */
export function findDuplicates(mods: readonly CuratorMod[]): DuplicateGroup[] {
  const byModId = new Map<number, CuratorMod[]>();
  for (const mod of mods) {
    if (mod.nexusModId === undefined) continue;
    const list = byModId.get(mod.nexusModId);
    if (list === undefined) byModId.set(mod.nexusModId, [mod]);
    else list.push(mod);
  }

  const out: DuplicateGroup[] = [];
  for (const [nexusModId, group] of byModId) {
    if (group.length < 2) continue;
    // One distinct file id across two or more installs means the same file
    // twice. `undefined` counts as one value, which is right: two installs
    // that both lack a file id are still indistinguishable from each other.
    const fileIds = new Set(group.map((m) => m.nexusFileId));
    out.push({
      nexusModId,
      mods: group,
      kind: fileIds.size === 1 ? "same-file" : "same-page",
    });
  }
  return out.sort((a, b) => a.nexusModId - b.nexusModId);
}

/** Headline counts, so the page can be read before it is used. */
export function summarizeProfile(mods: readonly CuratorMod[]): {
  total: number;
  enabled: number;
  updatable: number;
  frozen: number;
  frozenDrifted: number;
  endorsable: number;
  duplicateGroups: number;
} {
  const frozen = findFrozen(mods);
  return {
    total: mods.length,
    enabled: mods.filter((m) => m.enabled).length,
    updatable: findUpdatable(mods).length,
    frozen: frozen.length,
    frozenDrifted: frozen.filter((f) => f.driftedTo !== undefined).length,
    endorsable: findEndorsable(mods).length,
    duplicateGroups: findDuplicates(mods).length,
  };
}


/**
 * ──────────────────────────────────────────────────────────────────────
 * Which FILE an install came from, as distinct from which page.
 *
 * A Nexus mod id names a page; a page ships a main file, optional files,
 * variants and patches, each with its own file id. Treating "same page" as
 * "same file" is what made a bodypaint's CBBE and Male variants look like an
 * old version and its replacement.
 *
 * `logicalFileName` is Nexus's own name for the file and is preferred. The
 * fallback cuts the archive name at THIS MOD'S OWN ID, which Nexus appends
 * along with the version and upload timestamp — so it uses an id we already
 * hold rather than assuming a filename shape. When neither is available the
 * answer is `undefined`, and callers must not invent one.
 * ──────────────────────────────────────────────────────────────────────
 */
export function fileIdentity(mod: CuratorMod): string | undefined {
  const logical = mod.logicalFileName?.trim();
  if (logical !== undefined && logical !== "") return logical.toLowerCase();

  const file = mod.fileName?.trim();
  if (file === undefined || file === "" || mod.nexusModId === undefined) {
    return undefined;
  }
  const marker = `-${mod.nexusModId}-`;
  const at = file.lastIndexOf(marker);
  // `at === 0` would mean the whole name is the suffix, which identifies
  // nothing. Anything shorter than a character is not a name.
  return at <= 0 ? undefined : file.slice(0, at).toLowerCase();
}

/**
 * ─── EVERY NAME THIS FILE COULD ANSWER TO ──────────────────────────────
 * `fileIdentity` picks ONE name, preferring Nexus's own. That is right for
 * grouping installs against each other: both sides are mods, and both were
 * filled by the same code path, so they agree on which name exists.
 *
 * Comparing an INSTALL against a DOWNLOAD is not that case. The install
 * carries `attributes.logicalFileName`, which Vortex writes at install time;
 * the download carries whatever `modInfo.nexus.fileInfo` held when it was
 * fetched, and either can be missing on either side. Picking one name per
 * side and comparing the picks would then silently never match — which reads
 * as "nothing is superseded" and quietly turns the archive cleanup off
 * without erroring. A rule that fails closed AND silently is worse than the
 * one it replaced.
 *
 * So both names are kept and a match on EITHER is a match. The false positive
 * this admits would need two DIFFERENT files on one Nexus page to carry the
 * same name, which is the one thing the name exists to prevent.
 */
export function identityCandidates(file: {
  logicalFileName?: string;
  fileName?: string;
  nexusModId?: number;
}): Set<string> {
  const out = new Set<string>();

  const logical = file.logicalFileName?.trim();
  if (logical !== undefined && logical !== "") out.add(logical.toLowerCase());

  const name = file.fileName?.trim();
  if (name !== undefined && name !== "" && file.nexusModId !== undefined) {
    // Cut at THIS FILE'S OWN mod id, which Nexus appends along with the
    // version and upload timestamp. Everything Vortex adds after that point
    // — the extension, and the `.1` it appends to a re-download — is on the
    // far side of the cut and cannot disturb the name.
    const marker = `-${file.nexusModId}-`;
    const at = name.lastIndexOf(marker);
    if (at > 0) out.add(name.slice(0, at).toLowerCase());
  }

  return out;
}
