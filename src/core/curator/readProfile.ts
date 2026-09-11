/**
 * ──────────────────────────────────────────────────────────────────────
 * Read the curator's profile as the actions view needs to see it.
 *
 * Separate from `getModsForProfile` on purpose. That function builds the
 * COLLECTION snapshot — what a package records — and `impact` rates it
 * CRITICAL: 22 symbols across build, install, doctor, resolver and actions.
 * Update availability and endorsement are Vortex view-state that no package
 * should carry, so adding them there would push a field nobody else wants
 * through five subsystems. This reads the same store for a different purpose.
 *
 * ─── WHERE THE FREEZE LIVES ────────────────────────────────────────────
 * Vortex has no mod pin concept, so the frozen version is stored as a mod
 * attribute of our own, under a namespaced key. Vortex persists `attributes`
 * verbatim and ignores what it does not recognise, which is exactly the
 * property needed: it survives restarts, it travels with the mod, and nothing
 * in Vortex acts on it.
 *
 * A namespaced key matters more than it looks. `frozen` would be one Vortex
 * release away from colliding with a field of their own, and the collision
 * would look like the curator's freezes silently changing meaning.
 * ──────────────────────────────────────────────────────────────────────
 */

import type { types } from "@nexusmods/vortex-api";

import { getActiveProfileIdFromState } from "../getModsListForProfile";

import type { CuratorMod } from "./profileActions";

/** Our attribute key. Namespaced so Vortex can never grow one that collides. */
export const FROZEN_ATTRIBUTE = "eventHorizonFrozenAtVersion";

/** Numeric ids arrive as numbers or strings; only a real number is usable. */
function asNumber(raw: unknown): number | undefined {
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : undefined;
  if (typeof raw === "string" && raw.trim() !== "") {
    const n = Number(raw);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

function asString(raw: unknown): string | undefined {
  return typeof raw === "string" && raw !== "" ? raw : undefined;
}

/**
 * Every mod Vortex has for this game, in the view's shape.
 *
 * Reads the whole game rather than one profile's enabled set: a curator
 * deciding what to update or clean up needs to see the mod they disabled last
 * week, and a view that hid it would make "why is this still on disk?"
 * unanswerable from the page that exists to answer it.
 */
export function readCuratorMods(
  state: types.IState,
  gameId: string,
  /** Which mod ids the active profile has enabled. */
  enabledModIds: ReadonlySet<string>,
): CuratorMod[] {
  const byGame = (
    state as unknown as {
      persistent?: { mods?: Record<string, Record<string, unknown>> };
    }
  )?.persistent?.mods?.[gameId];
  if (byGame === undefined) return [];

  const out: CuratorMod[] = [];
  for (const [modId, raw] of Object.entries(byGame)) {
    const mod = raw as {
      attributes?: Record<string, unknown>;
      type?: unknown;
      archiveId?: unknown;
      installationPath?: unknown;
    };
    const attributes = mod?.attributes ?? {};
    out.push({
      id: modId,
      name: asString(attributes.name) ?? modId,
      enabled: enabledModIds.has(modId),
      modType: typeof mod?.type === "string" ? mod.type : "",
      ...opt("version", asString(attributes.version)),
      ...opt("newestVersion", asString(attributes.newestVersion)),
      // Vortex stores the Nexus mod id under `modId` on attributes, which is
      // NOT the same as the Vortex mod id used as the key above. Conflating
      // them is how an action ends up addressed to the wrong mod.
      ...opt("nexusModId", asNumber(attributes.modId ?? attributes.nexusId)),
      ...opt("nexusFileId", asNumber(attributes.fileId)),
      ...opt("newestFileId", asNumber(attributes.newestFileId)),
      // `"unknown"` is a VALUE, not an absence: Vortex uses it to say an
      // update exists whose file it cannot name. asNumber turns it into
      // undefined, which is indistinguishable from "no update known", so the
      // fact is preserved separately.
      ...(attributes.newestFileId === "unknown"
        ? { newestFileUnknown: true }
        : {}),
      ...opt("endorsed", asString(attributes.endorsed)),
      ...opt("source", asString(attributes.source)),
      // The FILE's name, which is what separates two different files on
      // one Nexus page from two versions of the same file.
      ...opt("logicalFileName", asString(attributes.logicalFileName)),
      ...opt("fileName", asString(attributes.fileName)),
      ...opt("downloadGame", asString(attributes.downloadGame)),
      ...opt("frozenAtVersion", asString(attributes[FROZEN_ATTRIBUTE])),
      ...opt("archiveId", asString(mod?.archiveId)),
      ...opt("installationPath", asString(mod?.installationPath)),
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** Include a key only when it has a value, so absent stays absent. */
function opt<K extends string, V>(
  key: K,
  value: V | undefined,
): Record<K, V> | Record<string, never> {
  return value === undefined ? {} : ({ [key]: value } as Record<K, V>);
}

/**
 * What freezing a mod writes, and what unfreezing clears.
 *
 * Returned rather than dispatched so the decision stays testable and the
 * Vortex call sits at the edge. `undefined` is Vortex's own idiom for
 * clearing an attribute.
 */
export function freezeAttribute(version: string | undefined): {
  key: string;
  value: string | undefined;
} {
  return { key: FROZEN_ATTRIBUTE, value: version };
}

/**
 * Which mods the game's active profile has switched on.
 *
 * Profile resolution is delegated to `getActiveProfileIdFromState` rather than
 * asking Vortex's selector directly, because that function already carries the
 * scar: the selector returns whichever profile is active GLOBALLY, so on a
 * machine with several games it silently answers for the wrong one, and a
 * build once reported "your active profile has no mods" against a profile the
 * user had never opened.
 *
 * An absent profile yields an empty set — every mod then reads as disabled,
 * which is true of a profile that does not exist and is the safe direction:
 * nothing is offered as ready to act on.
 */
export function readEnabledModIds(
  state: types.IState,
  gameId: string,
): Set<string> {
  const profileId = getActiveProfileIdFromState(state, gameId);
  if (profileId === undefined) return new Set();
  const modState = (
    state as unknown as {
      persistent?: {
        profiles?: Record<string, { modState?: Record<string, { enabled?: boolean }> }>;
      };
    }
  )?.persistent?.profiles?.[profileId]?.modState;
  if (modState === undefined) return new Set();
  return new Set(
    Object.entries(modState)
      .filter(([, entry]) => entry?.enabled === true)
      .map(([modId]) => modId),
  );
}
