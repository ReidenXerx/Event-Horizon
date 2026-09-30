/**
 * ──────────────────────────────────────────────────────────────────────
 * When to ask a player to endorse the collection they play, and its mods
 * (owner poll, 2026-09-30).
 *
 * The "did it work?" question is once per revision and stays that way: it is
 * a vote on one revision. Endorsing is different. It is approval of the
 * collection and it counts toward its standing on Nexus, and a curator keeps
 * improving a collection for months after a player first said "not now". So
 * this one comes back, politely:
 *
 *  - only after the game was actually started through Play, and not before
 *    the second launch (nobody is asked about something they tried once);
 *  - "Not now" waits 3 days, then 7, 14, 30, and every 30 after that;
 *  - a new revision since the last question brings it back after 3 days,
 *    whatever the back-off had reached: that is the curator's work to show;
 *  - "Don't ask again" holds until the curator publishes a new revision;
 *  - once endorsed, never again.
 *
 * Endorsing the collection's MODS is the same machinery on its own, slower
 * clock (7, 14, 30, 60 days, from the third launch), offered only while at
 * least one of them is not endorsed yet.
 *
 * Pure: the caller loads and saves the store and reads the clock.
 * ──────────────────────────────────────────────────────────────────────
 */

export const DAY_MS = 24 * 60 * 60 * 1000;
export const ENDORSE_BACKOFF_DAYS = [3, 7, 14, 30] as const;
export const MODS_BACKOFF_DAYS = [7, 14, 30, 60] as const;
/** After a new revision: back soon, whatever the back-off had reached. */
export const NEW_REVISION_DAYS = 3;
export const ENDORSE_FIRST_AFTER_LAUNCHES = 2;
export const MODS_FIRST_AFTER_LAUNCHES = 3;

export type AskState = {
  lastAskedAt?: string;
  /** "Not now" answers since the last endorsement or new revision. */
  declines: number;
  /** "Don't ask again" was pressed while this revision was the newest. */
  neverUntilRevision?: number;
};

/** One collection the player has launched, across its revisions. */
export type CollectionPlay = {
  packageId: string;
  packageName: string;
  slug: string;
  gameDomain: string;
  /** Vortex's game id ("skyrimse"), which is NOT the Nexus domain ("skyrimspecialedition"). */
  gameId?: string;
  collectionId?: number;
  /** The newest revision launched, and when it was first launched. */
  revisionNumber: number;
  revisionSeenAt: string;
  launches: number;
  lastPlayedAt: string;
  endorsedAt?: string;
  endorse: AskState;
  mods: AskState;
};

export type LaunchFacts = Omit<CollectionPlay, "revisionSeenAt" | "launches" | "lastPlayedAt" | "endorse" | "mods" | "endorsedAt">;

/** Record one launch. A newer revision resets the back-off: it is new work to show. */
export function noteLaunch(prev: CollectionPlay | undefined, facts: LaunchFacts, at: string): CollectionPlay {
  if (prev === undefined) {
    return { ...facts, revisionSeenAt: at, launches: 1, lastPlayedAt: at, endorse: { declines: 0 }, mods: { declines: 0 } };
  }
  const newer = facts.revisionNumber > prev.revisionNumber;
  return {
    ...prev,
    ...facts,
    revisionNumber: Math.max(facts.revisionNumber, prev.revisionNumber),
    revisionSeenAt: newer ? at : prev.revisionSeenAt,
    launches: prev.launches + 1,
    lastPlayedAt: at,
    endorse: newer ? { ...prev.endorse, declines: 0 } : prev.endorse,
    mods: newer ? { ...prev.mods, declines: 0 } : prev.mods,
  };
}

function due(
  play: CollectionPlay,
  ask: AskState,
  backoff: readonly number[],
  firstAfter: number,
  now: number,
): boolean {
  if (play.launches < firstAfter) return false;
  if (ask.neverUntilRevision !== undefined && play.revisionNumber <= ask.neverUntilRevision) return false;
  if (ask.lastAskedAt === undefined) return true;
  const last = Date.parse(ask.lastAskedAt);
  const revisionSinceAsked = Date.parse(play.revisionSeenAt) > last;
  const days = revisionSinceAsked
    ? NEW_REVISION_DAYS
    : backoff[Math.min(Math.max(ask.declines - 1, 0), backoff.length - 1)]!;
  return now - last >= days * DAY_MS;
}

/** Whether to ask about endorsing the collection now. */
export function endorseDue(play: CollectionPlay, now: number): boolean {
  if (play.endorsedAt !== undefined) return false;
  return due(play, play.endorse, ENDORSE_BACKOFF_DAYS, ENDORSE_FIRST_AFTER_LAUNCHES, now);
}

/** Whether to offer endorsing the collection's mods now; the caller knows how many are left. */
export function modsDue(play: CollectionPlay, unendorsed: number, now: number): boolean {
  if (unendorsed <= 0) return false;
  return due(play, play.mods, MODS_BACKOFF_DAYS, MODS_FIRST_AFTER_LAUNCHES, now);
}

export type AskAnswer = "done" | "not-now" | "never";

/** Record an answer to either question. "done" on the collection means endorsed. */
export function noteAsk(play: CollectionPlay, which: "endorse" | "mods", answer: AskAnswer, at: string): CollectionPlay {
  const ask = play[which];
  const next: AskState =
    answer === "never"
      ? { ...ask, lastAskedAt: at, neverUntilRevision: play.revisionNumber }
      : answer === "not-now"
        ? { ...ask, lastAskedAt: at, declines: ask.declines + 1 }
        : { ...ask, lastAskedAt: at, declines: 0 };
  return {
    ...play,
    [which]: next,
    ...(which === "endorse" && answer === "done" ? { endorsedAt: at } : {}),
  };
}

/**
 * The one question to show, oldest-played first: endorsing a collection comes
 * before endorsing its mods, and only one is shown per visit.
 */
export function nextEndorsePrompt(
  plays: readonly CollectionPlay[],
  unendorsedMods: (packageId: string) => number,
  now: number,
): { kind: "endorse" | "mods"; play: CollectionPlay; count?: number } | undefined {
  const byRecent = [...plays].sort((a, b) => Date.parse(b.lastPlayedAt) - Date.parse(a.lastPlayedAt));
  for (const p of byRecent) if (endorseDue(p, now)) return { kind: "endorse", play: p };
  for (const p of byRecent) {
    const n = unendorsedMods(p.packageId);
    if (modsDue(p, n, now)) return { kind: "mods", play: p, count: n };
  }
  return undefined;
}

export const isCollectionPlay = (v: unknown): v is CollectionPlay => {
  const p = v as Partial<CollectionPlay> | undefined;
  return (
    typeof p?.packageId === "string" &&
    typeof p.slug === "string" &&
    typeof p.revisionNumber === "number" &&
    typeof p.launches === "number" &&
    typeof p.lastPlayedAt === "string" &&
    typeof p.endorse?.declines === "number" &&
    typeof p.mods?.declines === "number"
  );
};
