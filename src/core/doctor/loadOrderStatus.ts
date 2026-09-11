/**
 * ──────────────────────────────────────────────────────────────────────
 * Is the curator's load order still what this machine loads?
 *
 * The install answers this once, at the end of the run. Nothing answered it
 * afterwards, and afterwards is when it changes: Vortex's auto-sort runs
 * LOOT on every deploy, a Sort click runs it by hand, a profile switch
 * loads another order entirely. Every file still verifies and the game
 * still starts — it just loads a different order than the curator tested,
 * silently, until the user opens Doctor and happens to read one card.
 *
 * ─── THE HYBRID, STATED ONCE ───────────────────────────────────────────
 * The collection PINS the curator's relative order for the plugins it
 * ships. The user's own plugins are not appended and not overwritten: LOOT
 * places them, and the re-pin keeps every one of those placements while
 * refilling the collection's slots with the curator's sequence (see
 * repinPluginOrder.ts). So "matches" here means the collection's plugins
 * load in the curator's order among themselves; extra plugins are expected
 * and never a fault.
 *
 * ─── WHOSE ORDER IS IT ─────────────────────────────────────────────────
 * Vortex's `loadOrder` is ONE order: the active profile's, of the active
 * game. A receipt describes an order pinned into ONE game and ONE profile.
 * Compared against anything else the answer is noise with a Re-apply button
 * on it — and that button writes into whatever order is active, because
 * Vortex's `set-plugin-list` handler takes no game and no profile.
 *
 * And two collections installed into the same profile can share plugins in
 * different orders. Settled with the user: the NEWEST install owns the order;
 * an older one is "superseded", with no drift, no notification and no
 * Re-apply — otherwise re-applying one drifts the other, forever.
 *
 * ─── OFF IS NOT OUT OF ORDER ───────────────────────────────────────────
 * A curator plugin the user switched off (or never got) is a different fact
 * from a sort that moved plugins, with a different fix. Settled with the
 * user: its own status, "N curator plugins off" — no drift notification, no
 * Re-apply offer (the re-apply keeps every plugin's enabled flag, so it
 * cannot turn one back on), and no wording that blames the sort.
 *
 * Pure. Every Vortex read is a function of the state handed in.
 * ──────────────────────────────────────────────────────────────────────
 */

import { readPluginList } from "../curator/pluginPool";
import { comparePluginOrder, type PluginOrderDrift, type PluginOrderEntry } from "../installer/checkPluginOrder";
import { repinCuratorOrder } from "../installer/repinPluginOrder";

const key = (name: string): string => name.trim().toLowerCase();

export type LoadOrderStatus =
  /** The receipt recorded no order (an old receipt, or a stopped install). */
  | { kind: "no-baseline" }
  /** The run recorded an order and was stopped before it applied it. */
  | { kind: "not-applied" }
  /** The receipt belongs to a game Vortex is not managing right now. */
  | { kind: "not-active-game"; gameId: string; activeGameId: string | undefined }
  /** Right game, but installed into a profile the user is not on. */
  | { kind: "other-profile"; profileName: string }
  /** A newer collection was installed into the same profile and owns the order. */
  | { kind: "superseded"; by: string }
  /** This game has no plugin list. */
  | { kind: "not-applicable" }
  | { kind: "matches"; owned: number; extra: number }
  /**
   * The order holds, but plugins the curator enabled are off or absent here.
   * Nothing was moved; nothing a re-apply can fix.
   */
  | { kind: "plugins-off"; owned: number; extra: number; missing: string[] }
  /** Collection plugins load out of the curator's order (and some may also be off). */
  | { kind: "drifted"; owned: number; extra: number; drift: PluginOrderDrift };

/** What an order check needs from a receipt. `InstallReceipt` satisfies it. */
export type OrderReceipt = {
  packageId: string;
  packageName: string;
  packageVersion?: string;
  gameId: string;
  vortexProfileId: string;
  vortexProfileName?: string;
  installedAt: string;
  rulesApplication?: { baselinePluginOrder?: readonly PluginOrderEntry[] };
  finishingSkipped?: readonly string[];
};

/** Which game and profile Vortex's `loadOrder` belongs to right now. */
export type ActiveContext = {
  gameId: string | undefined;
  profileId: string | undefined;
  profileName: string | undefined;
};

/**
 * Vortex keeps the active profile in `settings.profiles.activeProfileId`,
 * never on the profile object; the game is that profile's `gameId`.
 */
export function activeContextFromState(state: unknown): ActiveContext {
  const s = state as {
    settings?: { profiles?: { activeProfileId?: unknown } };
    persistent?: { profiles?: Record<string, { gameId?: unknown; name?: unknown } | undefined> };
  };
  const none: ActiveContext = { gameId: undefined, profileId: undefined, profileName: undefined };
  const pid = s?.settings?.profiles?.activeProfileId;
  if (typeof pid !== "string" || pid === "") return none;
  const profile = s?.persistent?.profiles?.[pid];
  const gameId = typeof profile?.gameId === "string" && profile.gameId !== "" ? profile.gameId : undefined;
  if (gameId === undefined) return none;
  return { gameId, profileId: pid, profileName: typeof profile?.name === "string" ? profile.name : undefined };
}

/** The receipt's order in the shape the assessment reads. */
export function baselineOf(receipt: Pick<OrderReceipt, "rulesApplication">): PluginOrderEntry[] {
  return (receipt.rulesApplication?.baselinePluginOrder ?? []).map((e) => ({ name: e.name, enabled: e.enabled }));
}

/**
 * The run skipped its plugin-order phase. `finishingSkipped` carries the
 * phase names the driver stopped before; the order phase is "plugin order".
 */
export function skippedPluginOrder(finishingSkipped: readonly string[] | undefined): boolean {
  return (finishingSkipped ?? []).some((phase) => phase.toLowerCase().includes("plugin order"));
}

/** Did this install actually pin an order into its profile? */
export function pinnedAnOrder(receipt: OrderReceipt): boolean {
  return baselineOf(receipt).length > 0 && !skippedPluginOrder(receipt.finishingSkipped);
}

const installedAtMs = (r: OrderReceipt): number => {
  const ms = Date.parse(String(r.installedAt));
  return Number.isNaN(ms) ? Number.NEGATIVE_INFINITY : ms;
};

const sameReceipt = (a: OrderReceipt, b: OrderReceipt): boolean =>
  a.packageId === b.packageId && String(a.installedAt) === String(b.installedAt);

/**
 * The receipt that owns the active profile's order: the newest install into
 * this game AND profile that pinned one. Ties break on package id, so two
 * callers can never pick different owners from the same receipts.
 */
export function orderOwner<R extends OrderReceipt>(receipts: readonly R[], active: ActiveContext): R | undefined {
  if (active.gameId === undefined || active.profileId === undefined) return undefined;
  return receipts
    .filter((r) => r.gameId === active.gameId && r.vortexProfileId === active.profileId && pinnedAnOrder(r))
    .sort((a, b) => installedAtMs(b) - installedAtMs(a) || a.packageId.localeCompare(b.packageId))[0];
}

export type OrderStanding =
  | { kind: "owner" }
  | { kind: "not-active-game"; activeGameId: string | undefined }
  | { kind: "other-profile"; profileName: string }
  | { kind: "superseded"; by: string };

/** Human name for a receipt: "Ivy 2 v1.0.11". */
export function receiptLabel(r: Pick<OrderReceipt, "packageName" | "packageVersion">): string {
  return r.packageVersion !== undefined && r.packageVersion !== "" ? `${r.packageName} v${r.packageVersion}` : r.packageName;
}

/** May this receipt's order be judged — and re-applied — against the active one? */
export function standingOf(receipt: OrderReceipt, receipts: readonly OrderReceipt[], active: ActiveContext): OrderStanding {
  if (receipt.gameId !== active.gameId) return { kind: "not-active-game", activeGameId: active.gameId };
  if (receipt.vortexProfileId !== active.profileId) {
    return { kind: "other-profile", profileName: receipt.vortexProfileName || receipt.vortexProfileId };
  }
  const owner = orderOwner([receipt, ...receipts], active);
  if (owner !== undefined && !sameReceipt(owner, receipt)) return { kind: "superseded", by: receiptLabel(owner) };
  return { kind: "owner" };
}

/**
 * The order Vortex holds right now, natives excluded, as the persistor will
 * write it: by `loadOrder`, entries Vortex has not placed last. Undefined
 * when the plugin extension has listed nothing for this game.
 */
export function currentOrderFromState(state: unknown): PluginOrderEntry[] | undefined {
  const plugins = readPluginList(state);
  if (plugins.length === 0) return undefined;
  return plugins.filter((p) => !p.isNative).map((p) => ({ name: p.name, enabled: p.enabled }));
}

/** Names of the game's own plugins, from the same list. */
export function nativeNamesFromState(state: unknown): Set<string> {
  return new Set(
    readPluginList(state)
      .filter((p) => p.isNative)
      .map((p) => key(p.name)),
  );
}

export function assessLoadOrder(args: {
  baseline: readonly PluginOrderEntry[] | undefined;
  current: readonly PluginOrderEntry[] | undefined;
  /** Lowercased native plugin names; excluded from both sides. */
  natives?: ReadonlySet<string>;
  /**
   * Whether this receipt's order is the one to compare at all. Omitted means
   * the caller established it; every live caller passes it.
   */
  standing?: OrderStanding;
  /** The receipt's game, for the "not the active game" wording. */
  gameId?: string;
}): LoadOrderStatus {
  const { baseline, current, standing } = args;
  if (baseline === undefined || baseline.length === 0) return { kind: "no-baseline" };
  if (standing !== undefined) {
    switch (standing.kind) {
      case "not-active-game":
        return { kind: "not-active-game", gameId: args.gameId ?? "another game", activeGameId: standing.activeGameId };
      case "other-profile":
        return { kind: "other-profile", profileName: standing.profileName };
      case "superseded":
        return { kind: "superseded", by: standing.by };
      case "owner":
        break;
    }
  }
  if (current === undefined) return { kind: "not-applicable" };
  const natives = args.natives ?? new Set<string>();
  const curator = baseline.filter((p) => !natives.has(key(p.name)));
  const user = current.filter((p) => !natives.has(key(p.name)));
  const drift = comparePluginOrder(curator, user);
  const owned = drift.compared;
  const extra = drift.extra.length;
  if (drift.misordered.length > 0) return { kind: "drifted", owned, extra, drift };
  if (drift.missing.length > 0) return { kind: "plugins-off", owned, extra, missing: drift.missing };
  return { kind: "matches", owned, extra };
}

/**
 * One receipt against Vortex's live state — the badge and the watcher.
 * Doctor reaches the same `assessLoadOrder` through its observations.
 */
export function assessReceiptOrder(args: {
  receipt: OrderReceipt;
  receipts: readonly OrderReceipt[];
  state: unknown;
}): LoadOrderStatus {
  const { receipt, receipts, state } = args;
  const baseline = baselineOf(receipt);
  if (baseline.length === 0) return { kind: "no-baseline" };
  if (skippedPluginOrder(receipt.finishingSkipped)) return { kind: "not-applied" };
  return assessLoadOrder({
    baseline,
    current: currentOrderFromState(state),
    natives: nativeNamesFromState(state),
    standing: standingOf(receipt, receipts, activeContextFromState(state)),
    gameId: receipt.gameId,
  });
}

/**
 * Only these statuses describe an order this receipt owns that a re-apply
 * can act on. `plugins-off` is excluded on purpose: the order already holds.
 */
export function canReapply(
  status: LoadOrderStatus,
): status is Extract<LoadOrderStatus, { kind: "matches" | "drifted" }> {
  return status.kind === "matches" || status.kind === "drifted";
}

/**
 * A stable fingerprint of a drift, so a watcher notifies on a CHANGE of
 * drift and not on every state tick while the same drift persists. Empty
 * when nothing is out of order.
 *
 * The misordered plugins only. A plugin switched off is not drift (see the
 * header), so toggling one while the order is also off must not re-announce
 * the same sort.
 */
export function driftSignature(status: LoadOrderStatus): string {
  if (status.kind !== "drifted") return "";
  const m = status.drift.misordered.map((x) => key(x.name)).sort();
  return `m:${m.join("|")}`;
}

/** One headline and the lines under it, for a card or a notification. */
export function describeLoadOrder(status: LoadOrderStatus): {
  tone: "success" | "warning" | "danger" | "neutral";
  headline: string;
  detail: string[];
} {
  switch (status.kind) {
    case "no-baseline":
      return {
        tone: "neutral",
        headline: "This install recorded no plugin order, so there is nothing to compare against.",
        detail: [],
      };
    case "not-applied":
      return {
        tone: "neutral",
        headline: "This install was stopped before it applied the load order, so there is nothing to compare against.",
        detail: [],
      };
    case "not-active-game":
      return {
        tone: "neutral",
        headline: `Installed for ${status.gameId}, which is not the game Vortex is managing right now.`,
        detail: [`Switch Vortex to ${status.gameId} to check this collection's load order.`],
      };
    case "other-profile":
      return {
        tone: "neutral",
        headline: `Installed in profile "${status.profileName}", not the one you are on.`,
        detail: [`The order you are looking at belongs to another profile. Switch to "${status.profileName}" to check this collection's.`],
      };
    case "superseded":
      return {
        tone: "neutral",
        headline: `Superseded by ${status.by}, installed into this profile later — that collection owns the load order now.`,
        detail: [],
      };
    case "not-applicable":
      return { tone: "neutral", headline: "This game has no plugin list to order.", detail: [] };
    case "matches":
      return {
        tone: "success",
        headline: `Matches the curator: ${status.owned.toLocaleString()} collection plugin(s) load in their order`,
        detail:
          status.extra > 0
            ? [`${status.extra.toLocaleString()} plugin(s) of your own sit between them where LOOT placed them.`]
            : [],
      };
    case "plugins-off": {
      const n = status.missing.length;
      return {
        tone: "warning",
        headline: `${curatorPluginsOff(n)}: enabled in the collection, not enabled or not installed here`,
        detail: [
          `${status.missing.slice(0, 5).join(", ")}${n > 5 ? ` and ${(n - 5).toLocaleString()} more` : ""}.`,
          `The ${status.owned.toLocaleString()} that are on load in the curator's order. Re-applying the order does not turn a plugin back on — enable it in Vortex if switching it off was not deliberate.`,
        ],
      };
    }
    case "drifted": {
      const d = status.drift;
      const detail: string[] = [];
      for (const m of d.misordered.slice(0, 6)) detail.push(`"${m.name}" should load after "${m.expectedAfter}"`);
      if (d.misordered.length > 6) detail.push(`and ${d.misordered.length - 6} more out of place.`);
      if (d.missing.length > 0) {
        detail.push(
          `Also off or not installed here: ${d.missing.slice(0, 5).join(", ")}` +
            (d.missing.length > 5 ? ` and ${d.missing.length - 5} more` : "") +
            `.`,
        );
      }
      return {
        tone: "danger",
        headline: `${d.misordered.length.toLocaleString()} of ${status.owned.toLocaleString()} collection plugins no longer load in the curator's order`,
        detail,
      };
    }
    default: {
      const exhaustive: never = status;
      void exhaustive;
      return { tone: "neutral", headline: "", detail: [] };
    }
  }
}

/** "1 curator plugin off", "3 curator plugins off" — the card's and the badge's words. */
export function curatorPluginsOff(n: number): string {
  return `${n.toLocaleString()} curator plugin${n === 1 ? "" : "s"} off`;
}

/**
 * The order a re-apply writes. ONE function, called by the heal and by the
 * preview, so the card cannot list one order while the button writes another.
 *
 * It could, and did: the preview merged only the ENABLED recorded plugins
 * while the heal merged every recorded name, and the preview read Vortex's
 * state while the heal read plugins.txt. Baseline [A, D(off), B] against
 * [D, B, A] previewed [D, A, B] and wrote [A, D, B] — divergent exactly when
 * the card was warning that the file lagged the state.
 *
 * The install's rule, which runInstall's re-pin applies with every name in
 * the manifest's plugin order, disabled ones included: every recorded plugin
 * owns its slot, so one the curator shipped switched off keeps the curator's
 * position for the day the user turns it on; the user's own plugins keep
 * theirs. Enabled flags are the CURRENT ones — an ordering operation asserts
 * no enabled state.
 *
 * `current` is Vortex's state (currentOrderFromState): the order the Doctor
 * compares, the watcher reads, and the re-apply asks Vortex to persist.
 */
export function buildRepinOrder(
  baseline: readonly PluginOrderEntry[],
  current: readonly PluginOrderEntry[],
): PluginOrderEntry[] {
  const merged = repinCuratorOrder(
    baseline.map((p) => p.name),
    current.map((p) => p.name),
  );
  const enabled = new Map(current.map((p) => [key(p.name), p.enabled] as const));
  // `merged` holds exactly current's members, so every lookup hits; the
  // fallback never invents an enabled plugin.
  return merged.map((name) => ({ name, enabled: enabled.get(key(name)) ?? false }));
}

/**
 * What re-applying would do to the CURRENT order, before it does it: which
 * plugins move, and where. `buildRepinOrder`, so the preview cannot disagree
 * with the act — provided it is handed the same `current` (Vortex's state).
 */
export function previewRepin(
  baseline: readonly PluginOrderEntry[],
  current: readonly PluginOrderEntry[],
): { moves: Array<{ name: string; from: number; to: number }>; total: number } {
  const currentNames = current.map((p) => p.name);
  const merged = buildRepinOrder(baseline, current).map((p) => p.name);
  const before = new Map(currentNames.map((n, i) => [key(n), i]));
  const moves: Array<{ name: string; from: number; to: number }> = [];
  merged.forEach((name, to) => {
    const from = before.get(key(name));
    if (from !== undefined && from !== to) moves.push({ name, from, to });
  });
  return { moves, total: merged.length };
}
