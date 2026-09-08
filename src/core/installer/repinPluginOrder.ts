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
export function repinCuratorOrder(
  curatorOrder: readonly string[],
  actualOrder: readonly string[],
): string[] {
  const owned = new Set(curatorOrder.map(key));

  /**
   * The curator's sequence, narrowed to plugins that actually exist here.
   *
   * A plugin the curator had and the user does not must not consume a slot —
   * that would shift every later one and reintroduce the drift this exists to
   * remove.
   */
  const present = new Set(actualOrder.map(key));
  const queue = curatorOrder.filter((n) => present.has(key(n)));

  const out: string[] = [];
  let next = 0;
  for (const name of actualOrder) {
    if (owned.has(key(name))) {
      // A slot the collection owns. Fill it with the next curator plugin,
      // keeping the name spelled as it is on this machine — the merged list is
      // written back to Vortex, and a name it does not recognise is a name it
      // drops.
      const wanted = queue[next];
      next += 1;
      out.push(wanted ?? name);
    } else {
      out.push(name);
    }
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
