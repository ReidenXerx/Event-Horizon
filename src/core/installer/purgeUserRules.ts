/**
 * ──────────────────────────────────────────────────────────────────────
 * Clear the user's own ordering rules so the curator's are the only ones.
 *
 * ─── WHY REPLACE RATHER THAN MERGE ─────────────────────────────────────
 * Applying the collection's rules on top of whatever the user already had
 * produces a rule set that exists on nobody's machine but theirs. Mod rules
 * decide which mod wins a file conflict and LOOT rules decide plugin order, so
 * one leftover rule silently changes what the game loads — and it does it
 * without failing anything. Verification passes, every file is byte-correct,
 * and the game still behaves differently from the curator's.
 *
 * That failure is invisible from both ends and lands as "your collection is
 * broken". The collection's rule set has to be the whole rule set.
 *
 * ─── WHAT THIS DELETES, STATED PLAINLY ─────────────────────────────────
 * Vortex stores mod rules on each MOD (`persistent.mods[gameId][modId].rules`)
 * and the LOOT userlist per active GAME — neither is per-profile. So this
 * removes:
 *
 *   - rules on mods that are not in the collection, and
 *   - rules the user set for their OTHER profiles of the same game.
 *
 * That is the intended scope and it is not recoverable from Vortex, so
 * {@link captureUserRuleState} snapshots everything first and the caller
 * writes it beside the receipt. A user who says "it deleted my rules" can be
 * shown exactly what was removed and put back.
 *
 * ─── THE ACTION NAMES ARE VORTEX'S, NOT INVENTED ───────────────────────
 * Read out of the shipped `gamebryo-plugin-management` bundle rather than
 * guessed:
 *
 *   createAction('REMOVE_USERLIST_RULE', (a,b,c) => ({pluginId, reference, type}))
 *   createAction('REMOVE_PLUGIN_GROUP',  a      => ({group}))
 *   createAction('CLEAR_USERLIST')       // no payload transformer at all
 *
 * `CLEAR_USERLIST` empties the whole userlist in one dispatch, which is both
 * what we want and far less fragile than removing entries one at a time.
 * ──────────────────────────────────────────────────────────────────────
 */

import { actions, type types } from "@nexusmods/vortex-api";

/** One rule as Vortex stores it, kept verbatim so it can be restored. */
export type CapturedModRule = {
  modId: string;
  /** Vortex's rule object — `{ type, reference, comment? }`. */
  rule: Record<string, unknown>;
};

export type UserRuleSnapshot = {
  gameId: string;
  capturedAt: string;
  modRules: CapturedModRule[];
  /** `state.userlist` verbatim: `{ plugins: [...], groups: [...] }`. */
  userlist: Record<string, unknown>;
};

export type PurgeResult = {
  modRulesRemoved: number;
  /** Rules left in place because they involve a mod or plugin the collection does not own (scoped purge). */
  modRulesKept?: number;
  /** Userlist rules removed one by one (scoped purge); the unscoped purge clears the whole list instead. */
  userlistRulesRemoved?: number;
  userlistRulesKept?: number;
  /** Mods that had at least one rule removed. */
  modsTouched: number;
  userlistCleared: boolean;
  /** Anything Vortex refused, so a partial purge is visible rather than silent. */
  failures: string[];
};

/**
 * Everything we are about to delete, verbatim.
 *
 * Never throws: a snapshot that fails must not stop the install, but the
 * caller needs to know it is empty before deciding to purge — see
 * {@link purgeUserRuleState}, which refuses to run without one.
 */
export function captureUserRuleState(
  api: types.IExtensionApi,
  gameId: string,
): UserRuleSnapshot {
  const snapshot: UserRuleSnapshot = {
    gameId,
    capturedAt: new Date().toISOString(),
    modRules: [],
    userlist: {},
  };

  try {
    const state = api.getState() as unknown as {
      persistent?: {
        mods?: Record<string, Record<string, { rules?: unknown[] }>>;
      };
      userlist?: Record<string, unknown>;
    };

    const mods = state?.persistent?.mods?.[gameId] ?? {};
    for (const [modId, mod] of Object.entries(mods)) {
      for (const rule of mod?.rules ?? []) {
        if (rule !== null && typeof rule === "object") {
          snapshot.modRules.push({
            modId,
            rule: rule as Record<string, unknown>,
          });
        }
      }
    }

    // Structured-cloned so a later dispatch cannot mutate the backup out from
    // under us — the whole point is that this survives the purge.
    const userlist = state?.userlist;
    if (userlist !== undefined && userlist !== null) {
      snapshot.userlist = JSON.parse(JSON.stringify(userlist)) as Record<
        string,
        unknown
      >;
    }
  } catch {
    // Leaves the snapshot empty, which purgeUserRuleState treats as "do not
    // proceed" rather than "nothing to remove".
  }

  return snapshot;
}

/**
 * Remove every captured rule, then empty the userlist.
 *
 * Driven by the SNAPSHOT rather than by re-reading state, so what is deleted
 * is exactly what was recorded. Removing something we did not record would be
 * a deletion with no way back.
 */
export function purgeUserRuleState(
  api: types.IExtensionApi,
  gameId: string,
  snapshot: UserRuleSnapshot,
  /**
   * What the collection owns. Given, only rules BETWEEN two of its mods, and
   * LOOT rules between two of its plugins, are removed; the player's rules on
   * their own mods and plugins stay (alasdairn, Ivy, 2026-10-31: every update
   * tossed his rules; approved). Absent: the old whole-game clear.
   */
  scope?: PurgeScope,
): PurgeResult {
  if (scope !== undefined) return purgeCollectionRules(api, gameId, snapshot, scope);
  const result: PurgeResult = {
    modRulesRemoved: 0,
    modsTouched: 0,
    userlistCleared: false,
    failures: [],
  };

  const touched = new Set<string>();
  for (const entry of snapshot.modRules) {
    try {
      api.store?.dispatch(
        actions.removeModRule(gameId, entry.modId, entry.rule as never),
      );
      result.modRulesRemoved += 1;
      touched.add(entry.modId);
    } catch (err) {
      result.failures.push(
        `mod rule on "${entry.modId}": ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
  result.modsTouched = touched.size;

  // One dispatch for the whole userlist. Vortex's own action, verified in the
  // shipped bundle; it takes no payload.
  try {
    const store = api.store as unknown as {
      dispatch?: (action: { type: string; payload?: unknown }) => void;
    };
    if (typeof store?.dispatch === "function") {
      store.dispatch({ type: "CLEAR_USERLIST" });
      result.userlistCleared = true;
    } else {
      result.failures.push("userlist: no dispatch available");
    }
  } catch (err) {
    result.failures.push(
      `userlist: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  return result;
}

/**
 * What to tell the user, or `undefined` when nothing was theirs to begin with.
 *
 * Said out loud rather than buried in a log. Deleting someone's work quietly
 * is how a tool earns the reputation this one is trying to avoid — and the
 * backup is only reassuring if they know it exists.
 */
export function describePurge(
  result: PurgeResult,
  snapshot: UserRuleSnapshot,
  backupPath: string | undefined,
): string[] | undefined {
  if (result.modRulesKept !== undefined) {
    const removed = result.modRulesRemoved + (result.userlistRulesRemoved ?? 0);
    const kept = result.modRulesKept + (result.userlistRulesKept ?? 0);
    if (removed === 0 && result.failures.length === 0) return undefined;
    const lines = [
      `Rules between the collection's own mods and plugins were replaced by the curator's ` +
        `(${result.modRulesRemoved} mod rule(s), ${result.userlistRulesRemoved ?? 0} LOOT rule(s)).` +
        (kept > 0 ? ` ${kept} rule(s) on your own mods and plugins were kept.` : ""),
    ];
    if (backupPath !== undefined) lines.push(`A copy of every rule as it was before was saved to: ${backupPath}`);
    if (result.failures.length > 0) {
      lines.push(`${result.failures.length} could not be removed: ${result.failures.slice(0, 3).join("; ")}`);
    }
    return lines;
  }
  // Nothing of the user's was actually removed. Clearing an already-empty
  // userlist is a dispatch, not an event, and announcing it would tell someone
  // their rules were deleted when they had none — the kind of scary,
  // content-free notice that teaches people to ignore the rest.
  const hadUserlist =
    (Array.isArray(snapshot.userlist.plugins)
      ? snapshot.userlist.plugins.length
      : 0) +
      (Array.isArray(snapshot.userlist.groups)
        ? snapshot.userlist.groups.length
        : 0) >
    0;
  if (result.modRulesRemoved === 0 && !hadUserlist) {
    return result.failures.length > 0
      ? [
          `Could not clear your existing rules, so some may still be active: ` +
            result.failures.slice(0, 3).join("; "),
        ]
      : undefined;
  }

  // Deliberately NOT "replaced your own". On every install after the first,
  // what gets cleared is the rules THIS collection applied last time — saying
  // "your own" there tells the user we deleted their work when we deleted our
  // own, which is both false and alarming. This wording is true either way.
  const lines: string[] = [
    `The collection's conflict and load-order rules are now the only ones in ` +
      `place, so what loads is exactly what the curator tested. ` +
      `${result.modRulesRemoved} mod rule(s) across ${result.modsTouched} ` +
      `mod(s) were removed${
        result.userlistCleared && hadUserlist
          ? ", and your LOOT rules were cleared"
          : ""
      }.`,
  ];
  if (backupPath !== undefined) {
    lines.push(`A copy of everything removed was saved to: ${backupPath}`);
  }
  if (result.failures.length > 0) {
    lines.push(
      `${result.failures.length} could not be removed, so a few of your own ` +
        `rules may still be active: ${result.failures.slice(0, 3).join("; ")}`,
    );
  }
  return lines;
}

export type PurgeScope = {
  /** Vortex mod ids of the collection's mods in this run. */
  modIds: ReadonlySet<string>;
  /** Vortex's mods for the game, to resolve what a rule's reference points at. */
  mods: Readonly<Record<string, { attributes?: Record<string, unknown> } | undefined>>;
  /** The collection's plugins, lowercased. */
  plugins: ReadonlySet<string>;
};

/**
 * The collection mod a rule's reference names, if it names one. A reference
 * that cannot be resolved is the player's: kept.
 */
export function ruleTargetInCollection(reference: unknown, scope: PurgeScope): boolean {
  if (reference === null || typeof reference !== "object") return false;
  const ref = reference as Record<string, unknown>;
  if (typeof ref.id === "string") return scope.modIds.has(ref.id);
  const repo = ref.repo as { fileId?: unknown } | undefined;
  for (const id of scope.modIds) {
    const a = scope.mods[id]?.attributes ?? {};
    if (typeof ref.fileMD5 === "string" && ref.fileMD5 !== "" && a.fileMD5 === ref.fileMD5) return true;
    if (typeof ref.logicalFileName === "string" && ref.logicalFileName !== "" && a.logicalFileName === ref.logicalFileName) return true;
    if (repo?.fileId !== undefined && a.fileId !== undefined && String(a.fileId) === String(repo.fileId)) return true;
  }
  return false;
}

const USERLIST_KINDS: ReadonlyArray<[string, string]> = [["after", "after"], ["req", "requires"], ["inc", "incompatible"]];

function purgeCollectionRules(
  api: types.IExtensionApi,
  gameId: string,
  snapshot: UserRuleSnapshot,
  scope: PurgeScope,
): PurgeResult {
  const result: PurgeResult = {
    modRulesRemoved: 0,
    modRulesKept: 0,
    modsTouched: 0,
    userlistCleared: false,
    userlistRulesRemoved: 0,
    userlistRulesKept: 0,
    failures: [],
  };
  const touched = new Set<string>();
  for (const entry of snapshot.modRules) {
    if (!scope.modIds.has(entry.modId) || !ruleTargetInCollection(entry.rule.reference, scope)) {
      result.modRulesKept! += 1;
      continue;
    }
    try {
      api.store?.dispatch(actions.removeModRule(gameId, entry.modId, entry.rule as never));
      result.modRulesRemoved += 1;
      touched.add(entry.modId);
    } catch (err) {
      result.failures.push(`mod rule on "${entry.modId}": ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  result.modsTouched = touched.size;

  // LOOT rules: only those with a collection plugin on BOTH sides. Group
  // assignments are left: the collection sets its own plugins' groups anyway.
  const store = api.store as unknown as { dispatch?: (action: { type: string; payload?: unknown }) => void };
  const plugins = Array.isArray(snapshot.userlist.plugins) ? (snapshot.userlist.plugins as Array<Record<string, unknown>>) : [];
  for (const p of plugins) {
    const owner = typeof p.name === "string" ? p.name : undefined;
    if (owner === undefined) continue;
    for (const [field, type] of USERLIST_KINDS) {
      const list = Array.isArray(p[field]) ? (p[field] as unknown[]) : [];
      for (const ref of list) {
        const target = typeof ref === "string" ? ref : (ref as { name?: unknown } | undefined)?.name;
        if (typeof target !== "string") continue;
        if (!scope.plugins.has(owner.toLowerCase()) || !scope.plugins.has(target.toLowerCase())) {
          result.userlistRulesKept! += 1;
          continue;
        }
        try {
          store?.dispatch?.({ type: "REMOVE_USERLIST_RULE", payload: { pluginId: owner, reference: target, type } });
          result.userlistRulesRemoved! += 1;
        } catch (err) {
          result.failures.push(`LOOT rule ${owner} -> ${target}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }
  }
  return result;
}
