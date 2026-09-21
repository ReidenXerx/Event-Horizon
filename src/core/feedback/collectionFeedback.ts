/**
 * ──────────────────────────────────────────────────────────────────────
 * "Did this collection work for you?" — asked after they have PLAYED.
 *
 * Nexus collections carry a per-revision success rate, and Vortex raises the
 * question itself when ITS collection installer finishes. Event Horizon
 * replaces that installer, so an Event Horizon install has never been able to
 * vote — the curator's success rate is built entirely from installs that did
 * not use the tool the collection ships with.
 *
 * ─── WHY IT WAITS FOR A LAUNCH ─────────────────────────────────────────
 * Vortex asks the moment the install finishes. At that moment the honest
 * answer is unknown: nobody has loaded a save. A player pressing "no" there
 * is reporting on the INSTALL, which Event Horizon already checks itself and
 * reports on the Done screen — and that vote is public, permanent, and about
 * the curator's collection rather than about the install.
 *
 * Event Horizon owns the Play button, so it knows something Vortex's
 * collection installer does not: whether the game was actually started. The
 * question waits for that. Decided with the curator, 2026-09-21.
 *
 * ─── WHAT IS REMEMBERED, AND WHY IT IS KEYED THIS WAY ──────────────────
 * The vote is about a REVISION, not a collection: revision 4 working says
 * nothing about revision 5, and Nexus records it per revision. So the key is
 * `<packageId>@<revisionNumber>` and a new revision asks again — once.
 *
 * "Asked and dismissed" is remembered as firmly as an answer. A question that
 * returns every time EH opens is a question people learn to close without
 * reading, and the next one that matters gets closed with it.
 * ──────────────────────────────────────────────────────────────────────
 */

import * as fsp from "fs/promises";
import * as path from "path";

import { ehLog } from "../logging/ehLog";

export const COLLECTION_FEEDBACK_FILE = "collection-feedback.json";

const SCHEMA = "event-horizon.collection-feedback/1";

/** What the player said, once they have said it. */
export type FeedbackAnswer = "worked" | "did-not-work";

export type FeedbackEntry = {
  /** The collection this is about, for showing a name without a receipt. */
  packageId: string;
  packageName: string;
  /** Nexus's revision NUMBER — the human one. The id is resolved at vote time. */
  revisionNumber: number;
  /** Nexus collection slug, so the vote can be sent and the page opened. */
  slug: string;
  gameDomain: string;
  /**
   * Nexus's numeric id for the COLLECTION, when the receipt recorded one.
   *
   * Needed only to endorse, and endorsing is the one thing that cannot be
   * done without it: `endorse-mod` finds the collection by matching this
   * against a Vortex mod's `attributes.collectionId`. Optional because older
   * receipts carry only the slug, and a missing id means the endorse button
   * is not offered rather than offered and broken.
   */
  collectionId?: number;
  /** ISO-8601 of the first launch of this revision through Event Horizon. */
  firstPlayedAt: string;
  /** Set once the player answers, or dismisses. Absent means still to ask. */
  answeredAt?: string;
  answer?: FeedbackAnswer;
  /** True when they dismissed rather than answered — still never asked again. */
  dismissed?: boolean;
  /** Set when the endorsement went through, so it is never offered twice. */
  endorsedAt?: string;
};

export type CollectionFeedbackStore = {
  schema: string;
  /** Keyed by `<packageId>@<revisionNumber>`. */
  entries: Record<string, FeedbackEntry>;
};

export const feedbackKey = (packageId: string, revisionNumber: number): string =>
  `${packageId}@${revisionNumber}`;

export const emptyFeedbackStore = (): CollectionFeedbackStore => ({
  schema: SCHEMA,
  entries: {},
});

/**
 * Record that this revision was played.
 *
 * The FIRST launch is what is kept: "they have played it" is the fact the
 * question waits on, and overwriting it on every launch would make a
 * dismissed question look new again. Returns the store unchanged when there
 * is already an entry, so this is safe to call on every single launch.
 */
export function notePlayed(
  store: CollectionFeedbackStore,
  entry: Omit<FeedbackEntry, "firstPlayedAt">,
  at: string,
): CollectionFeedbackStore {
  const key = feedbackKey(entry.packageId, entry.revisionNumber);
  if (store.entries[key] !== undefined) return store;
  return {
    schema: SCHEMA,
    entries: { ...store.entries, [key]: { ...entry, firstPlayedAt: at } },
  };
}

/** Record the answer — or the dismissal, which counts just as much. */
export function noteAnswered(
  store: CollectionFeedbackStore,
  key: string,
  outcome: { answer?: FeedbackAnswer; dismissed?: boolean },
  at: string,
): CollectionFeedbackStore {
  const existing = store.entries[key];
  if (existing === undefined) return store;
  return {
    schema: SCHEMA,
    entries: {
      ...store.entries,
      [key]: {
        ...existing,
        answeredAt: at,
        ...(outcome.answer !== undefined ? { answer: outcome.answer } : {}),
        ...(outcome.dismissed === true ? { dismissed: true } : {}),
      },
    },
  };
}

export function noteEndorsed(
  store: CollectionFeedbackStore,
  key: string,
  at: string,
): CollectionFeedbackStore {
  const existing = store.entries[key];
  if (existing === undefined) return store;
  return {
    schema: SCHEMA,
    entries: { ...store.entries, [key]: { ...existing, endorsedAt: at } },
  };
}

/**
 * The one collection to ask about, or nothing.
 *
 * ONE, deliberately. Someone who installed three collections and played them
 * all should not open Event Horizon to a stack of questions; the oldest
 * unanswered launch is asked first and the rest wait their turn, which also
 * means each answer is given some thought rather than clicked through.
 */
export function nextToAsk(
  store: CollectionFeedbackStore,
): { key: string; entry: FeedbackEntry } | undefined {
  const pending = Object.entries(store.entries)
    .filter(([, e]) => e.answeredAt === undefined)
    .sort(
      (a, b) =>
        Date.parse(a[1].firstPlayedAt) - Date.parse(b[1].firstPlayedAt),
    );
  const first = pending[0];
  return first === undefined ? undefined : { key: first[0], entry: first[1] };
}

/**
 * A collection that was answered "worked" and has not been endorsed.
 *
 * Separate from the rating on purpose: they are different things on Nexus —
 * a rating is per revision and says whether it worked, an endorsement is an
 * approval of the collection. Nobody is asked to endorse something they just
 * said did not work.
 */
export function nextToOfferEndorsement(
  store: CollectionFeedbackStore,
): { key: string; entry: FeedbackEntry } | undefined {
  const hit = Object.entries(store.entries).find(
    ([, e]) => e.answer === "worked" && e.endorsedAt === undefined,
  );
  return hit === undefined ? undefined : { key: hit[0], entry: hit[1] };
}

const isEntry = (v: unknown): v is FeedbackEntry => {
  const e = v as Partial<FeedbackEntry> | undefined;
  return (
    typeof e?.packageId === "string" &&
    typeof e.revisionNumber === "number" &&
    typeof e.slug === "string" &&
    typeof e.firstPlayedAt === "string"
  );
};

/** Never throws: a feedback file that cannot be read is one nobody answered. */
export async function loadFeedback(
  dataDir: string,
): Promise<CollectionFeedbackStore> {
  try {
    const raw = await fsp.readFile(
      path.join(dataDir, COLLECTION_FEEDBACK_FILE),
      "utf8",
    );
    const parsed = JSON.parse(raw) as Partial<CollectionFeedbackStore>;
    const entries: Record<string, FeedbackEntry> = {};
    for (const [k, v] of Object.entries(parsed?.entries ?? {})) {
      // Validated on the way IN, so a hand-edited file cannot make the UI
      // ask about a collection that does not exist.
      if (isEntry(v)) entries[k] = v;
    }
    return { schema: SCHEMA, entries };
  } catch {
    return emptyFeedbackStore();
  }
}

/**
 * Never throws. Losing this file costs one repeated question, never a wrong
 * vote — the vote itself is sent to Nexus and answered there.
 */
export async function saveFeedback(
  dataDir: string,
  store: CollectionFeedbackStore,
): Promise<void> {
  try {
    await fsp.mkdir(dataDir, { recursive: true });
    const target = path.join(dataDir, COLLECTION_FEEDBACK_FILE);
    const tmp = `${target}.tmp`;
    await fsp.writeFile(tmp, `${JSON.stringify(store, null, 2)}\n`, "utf8");
    await fsp.rename(tmp, target);
  } catch (err) {
    ehLog("warn", "collection-feedback.save.failed", {
      err,
      consequence: "the question may be asked again next time; nothing is lost",
    });
  }
}
