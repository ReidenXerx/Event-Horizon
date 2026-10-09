/**
 * ──────────────────────────────────────────────────────────────────────
 * Which of a profile's mods belong in the collection.
 *
 * Vortex's staging folder is NOT the profile. It holds every mod ever
 * installed for the game: mods belonging to other profiles, mods this profile
 * has switched off, and superseded duplicate installs. Measured on the
 * curator's own Fallout 4 profile — 992 staging folders, 939 tracked by the
 * profile, of which 37 disabled, and **123 Nexus mods occupying 304 folders**.
 *
 * `getModsForProfile` already narrows staging to what the profile tracks, by
 * mod id rather than by folder name. This narrows it the rest of the way.
 *
 * ## Disabled mods are not part of the collection
 *
 * A profile IS its set of enabled mods — that is what a profile is for. A mod
 * the curator switched off is not something they are shipping, so it does not
 * belong in the package, and paying to hash, walk and verify it is waste.
 *
 * This also resolves duplicate identities for free. Two installs of the same
 * Nexus file produce the same `compareKey`, and a manifest cannot hold two
 * mods with one identity — that is 7 hard build errors on this profile. In
 * every one of those 7, exactly one copy is enabled, so scoping to enabled
 * removes the collision without needing a tie-break rule at all. The
 * both-enabled and neither-enabled cases do not occur here, but they are
 * reported rather than silently guessed at.
 *
 * ## Several ENABLED installs of the SAME mod are reported, not resolved
 *
 * An upgrade whose old folder was never removed leaves two enabled installs of
 * one mod at different versions. Worth telling the curator about; not worth
 * deciding for them, since a second install is occasionally deliberate.
 *
 * The trap is that a Nexus MOD PAGE is not a mod. One page routinely hosts many
 * distinct files that are all meant to be installed together — a base plus its
 * addons, four different guns, five icon packs. Grouping by page id and
 * flagging version differences therefore flags all of those: measured on the
 * curator's profile, **74 groups, and all 74 were different files**. A
 * detector with a 100% false-positive rate does not just waste the reader's
 * time, it teaches them to ignore the warnings that matter.
 *
 * So membership requires the same page id AND the same underlying mod, by
 * normalising Vortex's `<name>-<modId>-<version>-<timestamp>` folder
 * convention back to the name. That convention is not guaranteed, so when
 * normalisation fails the two look like different mods and nothing is
 * reported — under-reporting rather than crying wolf.
 * ──────────────────────────────────────────────────────────────────────
 */

import { createHash } from "crypto";

import type { AuditorMod } from "../getModsListForProfile";
import { externalArchiveCompareKey, nexusCompareKey } from "../identity/compareKey";

export type CollectionScope = {
  /** Mods that belong in the collection: the profile's enabled mods. */
  included: AuditorMod[];
  /** Excluded because the profile has them switched off. */
  excludedDisabled: AuditorMod[];
  /** Switched off in the profile but shipped anyway: the curator marked them optional. */
  includedDisabledOptional: AuditorMod[];
  /**
   * Vortex collections installed in this profile. Excluded outright — see
   * {@link scopeCollectionMods} for what they actually contain.
   */
  excludedCollections: AuditorMod[];
  /**
   * Identities that would still collide after scoping — i.e. more than one
   * ENABLED install of the same Nexus file. Empty on a healthy profile;
   * non-empty means the manifest will reject the build, so say so early.
   */
  collidingIdentities: DuplicateInstallGroup[];
  /**
   * The SAME mod installed more than once and left enabled. Advisory: usually
   * an upgrade whose old folder survived.
   */
  multipleInstalls: DuplicateInstallGroup[];
};

export type DuplicateInstallGroup = {
  /** `nexus:<modId>` for the version-level view, `nexus:<modId>:<fileId>` for identity. */
  key: string;
  mods: Array<{ id: string; name: string; version?: string; installationPath?: string }>;
};

/**
 * Reduce a staging folder name to the mod behind it.
 *
 * Vortex names an install folder `<name>-<modId>-<version>-<timestamp>` and
 * appends `.1`, `.2` … when the same archive is installed again. Stripping
 * both leaves the name, which is what distinguishes "the same mod twice" from
 * "two files off one mod page".
 */
function normalizeInstallName(m: AuditorMod): string {
  const raw = m.installationPath ?? m.name;
  const reinstall = /^(.*)\.\d+$/.exec(raw);
  const base = reinstall !== null ? reinstall[1]! : raw;
  return base
    .replace(/-\d+(-[0-9A-Za-z]+)*-\d{9,}$/, "")
    .trim()
    .toLowerCase();
}

const describe = (m: AuditorMod): DuplicateInstallGroup["mods"][number] => ({
  id: m.id,
  name: m.name,
  ...(m.version !== undefined ? { version: m.version } : {}),
  ...(m.installationPath !== undefined ? { installationPath: m.installationPath } : {}),
});

function groupBy(
  mods: AuditorMod[],
  key: (m: AuditorMod) => string | undefined,
): DuplicateInstallGroup[] {
  const buckets = new Map<string, AuditorMod[]>();
  for (const mod of mods) {
    const k = key(mod);
    if (k === undefined) continue;
    const bucket = buckets.get(k);
    if (bucket === undefined) buckets.set(k, [mod]);
    else bucket.push(mod);
  }
  return [...buckets.entries()]
    .filter(([, v]) => v.length > 1)
    .map(([k, v]) => ({ key: k, mods: v.map(describe) }))
    .sort((a, b) => a.key.localeCompare(b.key));
}

/**
 * Narrow a profile's mods to those the collection should contain.
 *
 * Pure and total: no I/O, and it never throws. A profile with nothing enabled
 * yields an empty `included`, which the caller should treat as "nothing to
 * build" rather than as an error from here.
 */
export function scopeCollectionMods(
  mods: AuditorMod[],
  /** A disabled mod that ships anyway: one the curator marked optional. */
  shipsWhenDisabled?: (mod: AuditorMod) => boolean,
): CollectionScope {
  const included: AuditorMod[] = [];
  const excludedDisabled: AuditorMod[] = [];
  const includedDisabledOptional: AuditorMod[] = [];
  const excludedCollections: AuditorMod[] = [];
  for (const mod of mods) {
    // A Vortex collection installed in the profile is a mod by Vortex's
    // bookkeeping and nothing like one in substance. Measured on a real
    // profile: 1185 staged files, 1119 of them under `bundled/` — the
    // payloads of eight OTHER mods it ships. Including it duplicated every
    // one of those mods (once as itself, once inside here), shipped the files
    // of a mod the curator had DISABLED, and gave the entry an identity no
    // user can reproduce: a collection is installed by Vortex from Nexus, so
    // there is no source archive to hash, ever.
    if (mod.modType === "collection") excludedCollections.push(mod);
    else if (mod.enabled) included.push(mod);
    else if (shipsWhenDisabled?.(mod) === true) {
      included.push(mod);
      includedDisabledOptional.push(mod);
    } else excludedDisabled.push(mod);
  }

  return {
    included,
    excludedDisabled,
    includedDisabledOptional,
    excludedCollections,
    // Exact identity — what buildManifest's compareKey rejects.
    collidingIdentities: groupBy(included, (m) =>
      m.nexusModId !== undefined && m.nexusFileId !== undefined
        ? nexusCompareKey(m.nexusModId, m.nexusFileId)
        : undefined,
    ),
    // The same mod, installed twice and both left on. Keyed by page id AND
    // normalised name, because one page hosts many genuinely distinct files.
    multipleInstalls: groupBy(included, (m) =>
      m.nexusModId !== undefined
        // NOT a compareKey despite the prefix: a grouping key for spotting
      // several installs of one mod PAGE. Pipe-delimited so it can never
      // be parsed as one by mistake.
      ? `nexus:${String(m.nexusModId)}|${normalizeInstallName(m)}`
        : undefined,
    ),
  };
}

/**
 * Identity collisions that only the archive HASH can reveal.
 *
 * `scopeCollectionMods` runs before hashing and can only compare Nexus ids, so
 * it cannot see two EXTERNAL mods installed from byte-identical archives. That
 * happens: on the curator's profile "Ivy'sPantiesSettings" and
 * "Ivy'sPantiesSettings-SteamDeck" are separate downloads — different
 * `archiveId`s — with the same sha256, so buildManifest gives them one
 * `external:<sha256>` compareKey and rejects the build.
 *
 * buildManifest already catches this, but only after the staging pass, which
 * cost 31 minutes on this profile. Running it the moment hashing finishes turns
 * a 45-minute failure into a 15-minute one.
 *
 * Externals with no archive get their identity from `stagingSetHash`, which
 * does not exist yet at this point — those collisions stay buildManifest's to
 * report.
 */
export function findHashedIdentityCollisions(
  mods: AuditorMod[],
): DuplicateInstallGroup[] {
  return groupBy(mods, (m) => {
    if (m.nexusModId !== undefined && m.nexusFileId !== undefined) {
      return nexusCompareKey(m.nexusModId, m.nexusFileId);
    }
    return m.archiveSha256 !== undefined
      ? externalArchiveCompareKey(m.archiveSha256)
      : undefined;
  });
}

/** Curator-facing lines for a post-hash collision set. */
export function describeHashedCollisions(
  groups: DuplicateInstallGroup[],
): string[] {
  return groups.map(
    (g) =>
      `${g.mods.length} mods were installed from the SAME archive and share one ` +
      `identity (${g.key.slice(0, 24)}…): ${g.mods
        .map((m) => `"${m.name}"`)
        .join(", ")}. A collection cannot contain the same archive twice — ` +
      `remove or disable all but one, or the build cannot be packaged.`,
  );
}

/** Curator-facing lines for {@link CollectionScope}. Empty when nothing to say. */
export function describeScope(scope: CollectionScope): string[] {
  const out: string[] = [];

  for (const col of scope.excludedCollections) {
    out.push(
      `"${col.name}" is a Vortex collection installed in this profile, not a ` +
        `mod, so it was left out. Its staging folder holds copies of other ` +
        `mods' files, which would have shipped them twice — and any INI tweaks ` +
        `it carries are not included either. The mods it installed are still ` +
        `in this collection in their own right.`,
    );
  }

  for (const group of scope.collidingIdentities) {
    out.push(
      `${group.mods.length} enabled installs share one identity (${group.key}): ` +
        `${group.mods.map((m) => `"${m.name}"`).join(", ")}. A collection cannot ` +
        `contain the same mod twice — disable or remove all but one before building.`,
    );
  }

  if (scope.multipleInstalls.length > 0) {
    const shown = scope.multipleInstalls.slice(0, 8);
    for (const group of shown) {
      out.push(
        `"${group.mods[0]!.name}" is installed ${group.mods.length} times and all ` +
          `copies are enabled (versions: ${group.mods
            .map((m) => m.version ?? "?")
            .join(", ")}). Usually an upgrade whose old folder was never removed — ` +
          `worth checking, but shipped as-is.`,
      );
    }
    if (scope.multipleInstalls.length > shown.length) {
      out.push(
        `${scope.multipleInstalls.length - shown.length} further mod(s) have ` +
          `multiple enabled installs; see the event-horizon log for the full list.`,
      );
    }
  }

  return out;
}

/**
 * A stable fingerprint of WHAT a collection was built from.
 *
 * Answers one question cheaply: has the profile moved since the last build?
 * Pure state, no disk — the dashboard can ask it on every render.
 *
 * ## Identity, not just membership
 *
 * This hashed mod ids alone at first, and it was wrong in the field: the
 * curator updated four mods, and the fingerprint did not move. Measured from
 * the dashboard's own diagnostics, before and after: `enabled: 954`, the same
 * 954 ids, the same hash. Updating a mod in Vortex does not necessarily mint a
 * new mod key — the entry survives and its version, file id and staging folder
 * change underneath it. A fingerprint over ids is blind to precisely the event
 * a curator is most likely to be shipping an update FOR.
 *
 * So each mod contributes what actually identifies the bytes it will ship:
 * its id, its version, the Nexus file it came from, and its staging folder.
 * Any of those moving is a different collection.
 *
 * It still covers only what Vortex records. A curator who edits a file inside
 * a staged mod changes what ships without changing any of these, so an
 * unchanged fingerprint means "the same mods, at the same versions", never
 * "the same bytes". Anything shown to a curator on the strength of it has to
 * say so.
 */
export function profileFingerprint(mods: readonly AuditorMod[]): string {
  // Every field is length-prefixed, so nothing collides by concatenating into
  // the same string — not two fields within a mod (id "ab" + version "c" vs
  // id "a" + version "bc"), and not two mods within a profile.
  const prefixed = (part: string): string => `${part.length}:${part}`;
  const parts = mods
    .map((m) =>
      [
        m.id,
        m.version ?? "",
        m.nexusFileId === undefined ? "" : String(m.nexusFileId),
        m.installationPath ?? "",
      ]
        .map(prefixed)
        .join(""),
    )
    .sort();
  const payload = parts.map(prefixed).join("");
  return createHash("sha256").update(payload).digest("hex");
}
