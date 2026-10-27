/**
 * Give the curator back their order without throwing away LOOT's.
 *
 * ─── WHY THERE IS A THIRD STEP ──────────────────────────────────────────────
 * The install pins the curator's plugin order, then runs LOOT's sort on top.
 * The sort is there for a good reason: the user has plugins the curator never
 * had, and LOOT knows where those belong and whether any master ordering is
 * violated. But the sort does not know it is finishing someone else's work, so
 * it re-sorts everything — including the plugins the collection owns and whose
 * order the curator spent their evening getting right.
 *
 * Measured on a real 1,755-mod install: 686 of 1,600 plugins ended up in a
 * different relative order from the curator's. The package carried 501 LOOT
 * GROUP assignments and zero explicit ordering rules, so groups constrained
 * the sort only coarsely and LOOT was free to disagree about the rest. The pin
 * had run, the sort had run, and the curator's order was still not what
 * loaded.
 *
 * ─── THE MERGE RULE ─────────────────────────────────────────────────────────
 * Take LOOT's finished order. The SLOTS it gave to plugins the collection owns
 * are refilled, in sequence, with the curator's order. Every other plugin
 * stays exactly where LOOT put it.
 *
 * So the user's own plugins keep the positions LOOT chose — including relative
 * to the collection's, because their slots do not move — and the collection's
 * plugins recover the curator's relative order among themselves. Neither side
 * has to lose for the other to win, because the two claims are about different
 * things: LOOT is placing plugins the curator never saw, the curator is
 * ordering the ones they did.
 */

/** Case- and whitespace-insensitive, as plugin names are in this domain. */
const key = (name: string): string => name.trim().toLowerCase();

/**
 * Rebuild the load order so the collection's plugins hold the curator's
 * relative order while everything else keeps LOOT's placement.
 *
 * @param curatorOrder plugin names in the order the curator had them
 * @param actualOrder  plugin names as LOOT left them, the full list
 * @returns the merged order — same members as `actualOrder`, reordered
 */
/**
 * Distinct names, in order, first spelling wins.
 *
 * `owned` and `present` are Sets, so multiplicity is erased — and the merge
 * fills one slot per OWNED position from a queue built through those Sets. Give
 * it `[A, A, B]` against a curator order of `[B, A]` and there are three owned
 * slots but only two queue entries: the third read is `undefined`, falls back
 * to the slot's own name, and the result is `[B, A, B]` — one `A.esp` lost from
 * the load order and a second `B.esp` invented. Written back, that is a plugin
 * silently dropped and a name listed twice.
 *
 * `parsePluginsTxt` trims and drops blanks and comments but never dedupes, so a
 * hand-edited or MO2-migrated plugins.txt arrives here exactly as written.
 *
 * A merge that cannot prove it preserved membership should not approximate.
 * This makes the precondition true instead.
 */
function distinct(names: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const name of names) {
    const k = key(name);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(name);
  }
  return out;
}

/**
 * What each plugin must load after, keyed by lowercased name: the masters of
 * the plugins the collection does NOT own, plus the player's own LOOT rules
 * ("load after") that involve one of those plugins.
 *
 * An entry for a plugin the collection DOES own lists only the player's
 * plugins it must follow (a player's rule "WCLI_Vault111.esp after The Labour
 * Exchange"). The collection's plugin still never moves; the player's plugin
 * moves above it. Rules between two of the collection's own plugins are not
 * listed: their order is the curator's.
 */
export type UserPluginMasters = Readonly<Record<string, readonly string[]>>;

export function repinCuratorOrder(
  curatorOrder: readonly string[],
  actualOrder: readonly string[],
  userMasters?: UserPluginMasters,
): string[] {
  // Deduped, so slot count and queue length are the same number by
  // construction and the fallback below is provably unreachable. See distinct.
  const curator = distinct(curatorOrder);
  const actual = distinct(actualOrder);
  const owned = new Set(curator.map(key));

  /**
   * The curator's sequence, narrowed to plugins that actually exist here.
   *
   * A plugin the curator had and the user does not must not consume a slot —
   * that would shift every later one and reintroduce the drift this exists to
   * remove.
   */
  const present = new Set(actual.map(key));
  const queue = curator.filter((n) => present.has(key(n)));

  const out: string[] = [];
  let next = 0;
  for (const name of actual) {
    if (owned.has(key(name))) {
      // A slot the collection owns. Fill it with the next curator plugin,
      // keeping the name spelled as it is on this machine — the merged list is
      // written back to Vortex, and a name it does not recognise is a name it
      // drops.
      // `queue.length` equals the number of owned slots exactly, because both
      // are |curator names that are also present|, counted over DISTINCT
      // names on each side. The fallback is unreachable and stays as a guard.
      const wanted = queue[next];
      next += 1;
      out.push(wanted ?? name);
    } else {
      out.push(name);
    }
  }
  return userMasters === undefined ? out : keepMastersAbove(out, owned, userMasters);
}

/**
 * ─── A USER'S PATCH MUST STILL LOAD AFTER ITS MASTER ────────────────────────
 * Refilling the collection's slots moves collection plugins, and LOOT placed
 * the user's plugins relative to where those USED to be. A user's patch for a
 * collection plugin sits one slot under it after the sort; if the curator's
 * order puts that plugin later among the collection's own, the refill carries
 * it past the patch. The patch then loads BEFORE its master, and the game
 * applies the master's records over the patch's, which silently undoes it.
 *
 * Measured 2026-09-25 on a tester's Ivy install: a one-record patch for
 * llamaCompanionHeatherv2.esp sorted to 310 with Heather at 309, and every
 * "Re-apply curator's order" put it at 290 with Heather at 291.
 *
 * So after the refill, each of the user's plugins that now sits above one of
 * its masters moves down to just below the last of them. Only the user's
 * plugins move: the collection's keep the curator's order, which is the whole
 * point of the re-pin. A plugin whose masters we could not read keeps LOOT's
 * slot, as before.
 *
 * ─── AND THE PLAYER'S OWN RULES HOLD TOO ────────────────────────────────────
 * The same refill undid a player's LOOT rule. Reported 2026-10-27 (Vex, Ivy):
 * a rule put WCLI_Vault111.esp after his own The Labour Exchange (both edit
 * Vault 111, and WCLI warns in game when an editor of it loads later); Sort
 * honoured it, and "Re-apply curator's order" put WCLI back above it. A rule
 * that a player's plugin loads after another is kept like a master (the
 * player's plugin moves down). A rule that one of the collection's plugins
 * loads after a player's plugin moves the PLAYER's plugin up, to just above
 * it, so the curator's order still stands. It does not move when that would
 * put it above one of its own masters; no order satisfies both.
 */
function keepMastersAbove(
  order: readonly string[],
  owned: ReadonlySet<string>,
  userMasters: UserPluginMasters,
): string[] {
  const out = [...order];
  const isOwned = (name: string): boolean => owned.has(key(name));
  const afterOf = (name: string): readonly string[] => userMasters[key(name)] ?? [];
  /** "C after U" pairs that cannot hold without breaking U's own masters. */
  const givenUp = new Set<string>();
  // Each move settles one plugin against one constraint; the cap stops a
  // CYCLE (A needs B, B needs A), which no order satisfies and the game
  // refuses anyway.
  for (let moves = 0; moves < out.length * 2; moves++) {
    const at = new Map(out.map((n, i) => [key(n), i] as const));
    const late = out.findIndex((name, i) => {
      if (isOwned(name)) return false;
      return afterOf(name).some((m) => (at.get(key(m)) ?? -1) > i);
    });
    if (late !== -1) {
      const name = out[late]!;
      const lastMaster = Math.max(...afterOf(name).map((m) => at.get(key(m)) ?? -1));
      out.splice(late, 1);
      // The removal shifted the master up one, so its old index is now the
      // slot right below it.
      out.splice(lastMaster, 0, name);
      continue;
    }
    // A collection plugin the player ruled to load after one of theirs.
    let raise: { from: number; to: number } | undefined;
    for (let c = 0; c < out.length && raise === undefined; c++) {
      const collectionPlugin = out[c]!;
      if (!isOwned(collectionPlugin)) continue;
      for (const theirs of afterOf(collectionPlugin)) {
        const u = at.get(key(theirs));
        if (u === undefined || u < c || isOwned(theirs)) continue;
        const pair = `${key(collectionPlugin)}>${key(theirs)}`;
        if (givenUp.has(pair)) continue;
        if (afterOf(theirs).some((m) => (at.get(key(m)) ?? -1) >= c)) {
          givenUp.add(pair);
          continue;
        }
        raise = { from: u, to: c };
        break;
      }
    }
    if (raise === undefined) return out;
    const [name] = out.splice(raise.from, 1);
    out.splice(raise.to, 0, name!);
  }
  return out;
}

/**
 * Did the merge actually change anything?
 *
 * Used to decide whether a second write is worth doing at all: re-pinning an
 * order that already matches costs a Vortex round trip and a plugins.txt
 * rewrite for nothing.
 */
export function orderDiffers(
  a: readonly string[],
  b: readonly string[],
): boolean {
  if (a.length !== b.length) return true;
  for (let i = 0; i < a.length; i++) {
    if (key(a[i]!) !== key(b[i]!)) return true;
  }
  return false;
}
