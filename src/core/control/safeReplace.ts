/**
 * The install verb's `"ifExisting": "replace"`, done so that a failed install
 * leaves the old mod where it was (Skyrim-collection, 2026-11-01).
 *
 * Vortex removes the old mod BEFORE its installer runs: both of its replace
 * paths (InstallManager.queryUserReplace -> replaceMod, and userVersionChoice
 * REPLACE) emit remove-mod first, read in app.asar. So:
 *  - a FOMOD wizard that was cancelled or refused a pick left nothing
 *    installed, and the old mod's rules and EH config entry were gone with it
 *    (CBBE 3BA Vanilla Outfits Redone, LOFE);
 *  - the name check and the previous-version check run one after the other
 *    and can each remove a different mod, so a Steam copy was replaced when
 *    the GOG copy installed from the same archive was meant (S.L.A.C.K.);
 *  - an update whose archive has a new name matched nothing and landed next
 *    to the old version, both on (APMF, Ride Along, MFO, ...).
 *
 * Here the new file installs as a mod of its own first. Only when it is
 * installed is the target removed and the new mod moved onto the target's
 * id. The id is what other mods' rules, EH's collection config and every
 * profile point at, which is why Vortex's own replace keeps it too.
 */
import type { types } from "@nexusmods/vortex-api";

export type PoolMod = {
  id: string;
  type?: string;
  state?: string;
  archiveId?: string;
  installationPath?: string;
  attributes?: Record<string, unknown>;
  rules?: unknown[];
  fileOverrides?: unknown;
};

export type ReplaceWhy = "asked" | "same archive" | "same name" | "same Nexus page";

export type ReplaceTarget =
  | { kind: "target"; id: string; why: ReplaceWhy }
  /** Nothing installed is this mod: a plain install. */
  | { kind: "none" }
  /** Several installed mods could be meant; the caller has to say which (`replaceModId`). */
  | { kind: "unclear"; candidates: Array<{ id: string; why: ReplaceWhy }> }
  /** `replaceModId` names a mod that is not installed. */
  | { kind: "missing"; id: string };

/**
 * Which installed mod a replace is about. The caller's `replaceModId` wins.
 * Otherwise every installed mod Vortex could treat as "this one" is a
 * candidate: the same archive, the install name the archive's file name
 * gives, or a file from the same Nexus page. One candidate is the target;
 * more than one is a question, never a guess: a GOG and a Steam copy, or a
 * main file and its optional patch, share a page.
 */
export function pickReplaceTarget(input: {
  pool: Record<string, PoolMod>;
  archiveId: string;
  /** The archive's file name without extension, lower case. */
  archiveBase?: string;
  nexusModId?: number;
  replaceModId?: string;
}): ReplaceTarget {
  const { pool } = input;
  if (input.replaceModId !== undefined) {
    return pool[input.replaceModId]?.state === "installed"
      ? { kind: "target", id: input.replaceModId, why: "asked" }
      : { kind: "missing", id: input.replaceModId };
  }
  const found: Array<{ id: string; why: ReplaceWhy }> = [];
  for (const m of Object.values(pool)) {
    if (m.state !== "installed" || m.type === "collection") continue;
    const why: ReplaceWhy | undefined =
      m.archiveId === input.archiveId
        ? "same archive"
        : input.archiveBase !== undefined && m.id.toLowerCase() === input.archiveBase
          ? "same name"
          : input.nexusModId !== undefined && Number(m.attributes?.["modId"]) === input.nexusModId
            ? "same Nexus page"
            : undefined;
    if (why !== undefined) found.push({ id: m.id, why });
  }
  found.sort((a, b) => a.id.localeCompare(b.id));
  if (found.length === 0) return { kind: "none" };
  if (found.length === 1) return { kind: "target", id: found[0]!.id, why: found[0]!.why };
  return { kind: "unclear", candidates: found };
}

/** What the update check recorded about the OLD file; carried over, it would call the new one outdated. */
const OLD_FILE_ONLY = ["newestFileId", "newestVersion", "newestChangelog", "lastUpdateTime"];

/**
 * The target's pool entry, now holding the new install: the new mod's files,
 * archive and attributes, with the target's id, rules and file overrides, and
 * the target's own attributes (notes, category...) where the new install has
 * none. The new mod's rules are dropped: Vortex copies the rules of whatever
 * mod it took for the previous version onto it, which is how one copy got
 * the other's.
 */
export function mergeReplacement(
  target: PoolMod,
  fresh: PoolMod,
  opts: { installationPath: string; archiveId?: string; label?: string },
): PoolMod {
  const kept = Object.fromEntries(
    Object.entries(target.attributes ?? {}).filter(([k]) => !OLD_FILE_ONLY.includes(k) && k !== "variant"),
  );
  const attributes: Record<string, unknown> = { ...kept, ...(fresh.attributes ?? {}) };
  // The temporary variant EH installed under is not the player's; the target's variant (if any) is.
  delete attributes["variant"];
  if (target.attributes?.["variant"] !== undefined) attributes["variant"] = target.attributes["variant"];
  if (opts.label !== undefined) {
    for (const k of ["customFileName", "name", "logicalFileName"]) {
      const v = attributes[k];
      if (typeof v === "string") attributes[k] = v.split(` (${opts.label})`).join("").split(opts.label).join("").trim();
    }
  }
  const entry: PoolMod = {
    ...fresh,
    id: target.id,
    installationPath: opts.installationPath,
    rules: target.rules ?? [],
    attributes,
  };
  if (opts.archiveId !== undefined) entry.archiveId = opts.archiveId;
  if (target.fileOverrides !== undefined) entry.fileOverrides = target.fileOverrides;
  else delete entry.fileOverrides;
  return entry;
}

export type EnabledByProfile = Record<string, Record<string, boolean>>;

/**
 * The on/off writes that put every profile back as it was, with the target
 * now meaning the new file. The target keeps each profile's state (Vortex's
 * replace moves every profile), except the active one when the caller said
 * `enable`. Mods the install switched off or on (Vortex's variant and
 * "Update current profile" both switch the old version off in the active
 * profile) go back. The temporary mod is forgotten everywhere.
 */
export function enabledAfterReplace(input: {
  before: EnabledByProfile;
  after: EnabledByProfile;
  targetId: string;
  freshId: string;
  activeProfileId?: string;
  enable?: boolean;
}): Array<{ profileId: string; modId: string; enabled: boolean }> {
  const writes: Array<{ profileId: string; modId: string; enabled: boolean }> = [];
  for (const [profileId, before] of Object.entries(input.before)) {
    const after = input.after[profileId] ?? {};
    const want =
      profileId === input.activeProfileId && input.enable !== undefined ? input.enable : before[input.targetId] === true;
    writes.push({ profileId, modId: input.targetId, enabled: want });
    for (const [modId, was] of Object.entries(before)) {
      if (modId === input.targetId || modId === input.freshId) continue;
      if ((after[modId] === true) !== was) writes.push({ profileId, modId, enabled: was });
    }
    for (const [modId, now] of Object.entries(after)) {
      if (modId === input.targetId || modId === input.freshId || modId in before) continue;
      if (now) writes.push({ profileId, modId, enabled: false });
    }
  }
  return writes;
}

/** Every profile of the game, as modId -> enabled. */
export function readEnabled(api: types.IExtensionApi, gameId: string): EnabledByProfile {
  const profiles =
    (api.getState() as { persistent?: { profiles?: Record<string, { gameId?: string; modState?: Record<string, { enabled?: boolean }> }> } })
      .persistent?.profiles ?? {};
  const out: EnabledByProfile = {};
  for (const [id, p] of Object.entries(profiles)) {
    if (p.gameId !== gameId) continue;
    out[id] = Object.fromEntries(Object.entries(p.modState ?? {}).map(([m, s]) => [m, s?.enabled === true]));
  }
  return out;
}
