/**
 * Requirements the curator dismissed, and the report without them.
 *
 * Mod authors use a page's Requirements section to advertise their other
 * mods, or list things that do not apply. A curator has to be able to say
 * "not this one" once and not see it again. Settled with the curator
 * (2026-09-12):
 *
 *   - Only a NEXUS requirement can be dismissed. A missing plugin master is
 *     a plugin the game will not load; that line always shows.
 *   - A dismissal is kept per mod PAGE (Nexus domain + mod id of the mod that
 *     lists it), not per Vortex install: updating the mod gives it a new
 *     install, and the dismissal must survive that.
 *   - It comes back only when the requirement itself changes ON NEXUS — the
 *     page it points at, its notes, its link. What changes on this machine
 *     (installed, enabled, which copy provides it) does not bring it back.
 *
 * Dismissed lines are taken out of the report in one place
 * ({@link applyDismissals}), so every reader — the Requires column, the
 * chips and tiles, "Make it work", the enable prompts — agrees without each
 * learning about dismissals.
 */

import type { CuratorMod } from "./profileActions";
import type { ModRequirement, RequirementsReport } from "./requirements";

export type DismissalEntry = {
  /** What Nexus said about the requirement when it was dismissed. */
  fingerprint: string;
  /** For a person reading the file. */
  name: string;
  dismissedAt: string;
};

export type DismissalStore = {
  version: 1;
  /** Dependent mod page ("skyrimspecialedition:12345") → requirement key → entry. */
  pages: Record<string, Record<string, DismissalEntry>>;
};

export const EMPTY_DISMISSALS: DismissalStore = { version: 1, pages: {} };

/** The page a mod's dismissals are kept under, or undefined for a mod with no Nexus page. */
export function dependentPageKey(mod: CuratorMod, activeGame: string, toDomain: (vortexGameId: string) => string = (id) => id): string | undefined {
  if (mod.nexusModId === undefined) return undefined;
  return `${toDomain(mod.downloadGame ?? activeGame)}:${mod.nexusModId}`;
}

/** Only what a mod's Nexus page lists; a plugin master always shows. */
export function isDismissible(q: ModRequirement): boolean {
  return q.source === "nexus";
}

type Kind = "page" | "external" | "dlc" | "unknown";

function kindOf(q: ModRequirement): Kind {
  if (q.status === "external") return "external";
  if (q.status === "dlc") return "dlc";
  if (q.status === "unknown-game") return "unknown";
  return "page";
}

/** Which requirement a dismissal is for: stable across everything this machine changes. */
export function requirementKey(q: ModRequirement): string {
  switch (kindOf(q)) {
    case "page":
      return `page:${q.gameDomain ?? "?"}:${q.nexusModId ?? "?"}`;
    case "unknown":
      return `unknown:${q.nexusModId ?? q.name}`;
    case "external":
      return `external:${q.url ?? q.name}`;
    case "dlc":
      return `dlc:${q.name}`;
  }
}

/**
 * What Nexus says about a requirement, and nothing this machine decides.
 *
 * For a line pointing at a Nexus page the status, the providers and even the
 * displayed name are local (the name falls back to an installed provider's),
 * so only the target, the link and the notes count: those are what the author
 * edits on the page.
 */
export function requirementFingerprint(q: ModRequirement): string {
  const kind = kindOf(q);
  const parts =
    kind === "page"
      ? { kind, target: `${q.gameDomain ?? "?"}:${q.nexusModId ?? "?"}`, url: q.url ?? "", notes: q.notes ?? "" }
      : { kind, name: q.name, target: q.nexusModId ?? "", url: q.url ?? "", notes: q.notes ?? "" };
  return JSON.stringify(parts);
}

export function dismissRequirement(store: DismissalStore, pageKey: string, q: ModRequirement, now: Date = new Date()): DismissalStore {
  if (!isDismissible(q)) return store;
  const page = { ...(store.pages[pageKey] ?? {}) };
  page[requirementKey(q)] = { fingerprint: requirementFingerprint(q), name: q.name, dismissedAt: now.toISOString() };
  return { version: 1, pages: { ...store.pages, [pageKey]: page } };
}

export function restoreRequirement(store: DismissalStore, pageKey: string, key: string): DismissalStore {
  const page = store.pages[pageKey];
  if (page === undefined || !(key in page)) return store;
  const { [key]: _gone, ...rest } = page;
  const pages = { ...store.pages };
  if (Object.keys(rest).length === 0) delete pages[pageKey];
  else pages[pageKey] = rest;
  return { version: 1, pages };
}

/** Forget dismissals whose requirement has changed on Nexus: they already came back. */
export function pruneStale(store: DismissalStore, stale: ReadonlyArray<{ pageKey: string; requirementKey: string }>): DismissalStore {
  let out = store;
  for (const s of stale) out = restoreRequirement(out, s.pageKey, s.requirementKey);
  return out;
}

/** The file's contents, tolerant: an unreadable entry is dropped, never an error. */
export function parseDismissals(raw: string | null | undefined): DismissalStore {
  if (raw === null || raw === undefined || raw.trim() === "") return EMPTY_DISMISSALS;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return EMPTY_DISMISSALS;
  }
  const pagesIn = (parsed as { pages?: unknown } | null)?.pages;
  if (pagesIn === null || typeof pagesIn !== "object" || Array.isArray(pagesIn)) return EMPTY_DISMISSALS;
  const pages: DismissalStore["pages"] = {};
  for (const [pageKey, entries] of Object.entries(pagesIn as Record<string, unknown>)) {
    if (entries === null || typeof entries !== "object" || Array.isArray(entries)) continue;
    const page: Record<string, DismissalEntry> = {};
    for (const [key, e] of Object.entries(entries as Record<string, unknown>)) {
      const entry = e as Partial<DismissalEntry> | null;
      if (entry === null || typeof entry !== "object" || typeof entry.fingerprint !== "string") continue;
      page[key] = {
        fingerprint: entry.fingerprint,
        name: typeof entry.name === "string" ? entry.name : key,
        dismissedAt: typeof entry.dismissedAt === "string" ? entry.dismissedAt : "",
      };
    }
    if (Object.keys(page).length > 0) pages[pageKey] = page;
  }
  return { version: 1, pages };
}

export function serializeDismissals(store: DismissalStore): string {
  return `${JSON.stringify(store, null, 2)}\n`;
}

export type AppliedDismissals = {
  /** The report without dismissed lines — the same object when nothing was dismissed. */
  report: RequirementsReport;
  /** Vortex mod id → the lines dismissed from it, for the panel's "Dismissed" list. */
  dismissedByMod: ReadonlyMap<string, readonly ModRequirement[]>;
  /** Dismissals whose requirement changed on Nexus: shown again, and to be forgotten. */
  stale: ReadonlyArray<{ pageKey: string; requirementKey: string }>;
};

export function applyDismissals(args: {
  report: RequirementsReport;
  mods: readonly CuratorMod[];
  store: DismissalStore;
  pageKeyOf: (mod: CuratorMod) => string | undefined;
}): AppliedDismissals {
  const { report, store } = args;
  const dismissedByMod = new Map<string, ModRequirement[]>();
  const staleKeys = new Map<string, { pageKey: string; requirementKey: string }>();
  let byMod = report.byMod;
  let requiredBy = report.requiredBy;
  let changed = false;

  for (const mod of args.mods) {
    const entry = report.byMod.get(mod.id);
    if (entry === undefined) continue;
    const pageKey = args.pageKeyOf(mod);
    if (pageKey === undefined) continue;
    const page = store.pages[pageKey];
    if (page === undefined) continue;

    const kept: ModRequirement[] = [];
    const gone: ModRequirement[] = [];
    for (const q of entry.requirements) {
      const key = isDismissible(q) ? requirementKey(q) : undefined;
      const dismissal = key === undefined ? undefined : page[key];
      if (dismissal === undefined) {
        kept.push(q);
      } else if (dismissal.fingerprint === requirementFingerprint(q)) {
        gone.push(q);
      } else {
        kept.push(q);
        staleKeys.set(`${pageKey}\n${key}`, { pageKey, requirementKey: key! });
      }
    }
    if (gone.length === 0) continue;

    if (!changed) {
      byMod = new Map(report.byMod);
      requiredBy = new Map(report.requiredBy);
      changed = true;
    }
    byMod.set(mod.id, { ...entry, requirements: kept });
    dismissedByMod.set(mod.id, gone);
    // A provider stops counting this mod as a dependant only when no line
    // left on the mod still points at it (a master line can).
    for (const q of gone) {
      for (const providerId of q.satisfiedBy) {
        if (kept.some((k) => k.satisfiedBy.includes(providerId))) continue;
        const list = requiredBy.get(providerId);
        if (list === undefined) continue;
        const next = list.filter((id) => id !== mod.id);
        if (next.length === 0) requiredBy.delete(providerId);
        else requiredBy.set(providerId, next);
      }
    }
  }

  return {
    report: changed ? { ...report, byMod, requiredBy } : report,
    dismissedByMod,
    stale: [...staleKeys.values()],
  };
}
