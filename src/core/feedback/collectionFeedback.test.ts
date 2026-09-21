/**
 * The rules that decide whether a public, permanent vote gets asked for.
 *
 * Every one of these is about NOT asking: not before they played, not twice,
 * not again after a dismissal, not for a revision they already answered, and
 * never for an endorsement of something they said did not work.
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  COLLECTION_FEEDBACK_FILE,
  emptyFeedbackStore,
  feedbackKey,
  loadFeedback,
  nextToAsk,
  nextToOfferEndorsement,
  noteAnswered,
  noteEndorsed,
  notePlayed,
  saveFeedback,
  type FeedbackEntry,
} from "./collectionFeedback";

const IVY: Omit<FeedbackEntry, "firstPlayedAt"> = {
  packageId: "0456490d-525b-49e3-92d2-5c6e617990be",
  packageName: "Ivy's Panties - Event Horizon",
  revisionNumber: 4,
  slug: "dmt85e",
  gameDomain: "fallout4",
};
const MERIDIA: Omit<FeedbackEntry, "firstPlayedAt"> = {
  packageId: "aaaa1111-2222-3333-4444-555566667777",
  packageName: "Meridia's Panties - Event Horizon",
  revisionNumber: 2,
  slug: "ecb76c",
  gameDomain: "skyrimspecialedition",
};

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "eh-feedback-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("nothing to ask until they have played", () => {
  it("an empty store asks nothing", () => {
    expect(nextToAsk(emptyFeedbackStore())).toBeUndefined();
  });

  it("a launch is what makes the question exist", () => {
    const s = notePlayed(emptyFeedbackStore(), IVY, "2026-09-21T10:00:00Z");
    expect(nextToAsk(s)?.entry.packageName).toBe("Ivy's Panties - Event Horizon");
  });
});

describe("it is asked once", () => {
  it("a second launch does not reset the question", () => {
    // Otherwise a dismissed question comes back every time they play.
    let s = notePlayed(emptyFeedbackStore(), IVY, "2026-09-21T10:00:00Z");
    s = noteAnswered(s, feedbackKey(IVY.packageId, 4), { dismissed: true }, "2026-09-21T10:05:00Z");
    s = notePlayed(s, IVY, "2026-09-22T19:00:00Z");
    expect(nextToAsk(s)).toBeUndefined();
    expect(s.entries[feedbackKey(IVY.packageId, 4)]?.firstPlayedAt).toBe("2026-09-21T10:00:00Z");
  });

  it("a dismissal closes it as firmly as an answer", () => {
    let s = notePlayed(emptyFeedbackStore(), IVY, "2026-09-21T10:00:00Z");
    s = noteAnswered(s, feedbackKey(IVY.packageId, 4), { dismissed: true }, "t");
    expect(nextToAsk(s)).toBeUndefined();
  });

  it("but a NEW revision is a new question", () => {
    // The vote is per revision on Nexus: revision 4 working says nothing
    // about revision 5.
    let s = notePlayed(emptyFeedbackStore(), IVY, "2026-09-21T10:00:00Z");
    s = noteAnswered(s, feedbackKey(IVY.packageId, 4), { answer: "worked" }, "t");
    s = notePlayed(s, { ...IVY, revisionNumber: 5 }, "2026-09-25T10:00:00Z");
    expect(nextToAsk(s)?.entry.revisionNumber).toBe(5);
  });
});

describe("one at a time, oldest first", () => {
  it("does not stack up questions", () => {
    // Three installs played should not greet them with three prompts.
    let s = notePlayed(emptyFeedbackStore(), MERIDIA, "2026-09-20T10:00:00Z");
    s = notePlayed(s, IVY, "2026-09-21T10:00:00Z");
    expect(nextToAsk(s)?.entry.packageName).toContain("Meridia");
    s = noteAnswered(s, feedbackKey(MERIDIA.packageId, 2), { answer: "worked" }, "t");
    expect(nextToAsk(s)?.entry.packageName).toContain("Ivy");
  });
});

describe("endorsement follows a yes, and only a yes", () => {
  it("is offered after 'it worked'", () => {
    let s = notePlayed(emptyFeedbackStore(), IVY, "t");
    s = noteAnswered(s, feedbackKey(IVY.packageId, 4), { answer: "worked" }, "t");
    expect(nextToOfferEndorsement(s)?.entry.slug).toBe("dmt85e");
  });

  it("is NEVER offered after 'it did not work'", () => {
    // Asking someone having a bad time to endorse is the wrong question, and
    // the log bundle is what actually helps the curator there.
    let s = notePlayed(emptyFeedbackStore(), IVY, "t");
    s = noteAnswered(s, feedbackKey(IVY.packageId, 4), { answer: "did-not-work" }, "t");
    expect(nextToOfferEndorsement(s)).toBeUndefined();
  });

  it("is not offered after a dismissal", () => {
    let s = notePlayed(emptyFeedbackStore(), IVY, "t");
    s = noteAnswered(s, feedbackKey(IVY.packageId, 4), { dismissed: true }, "t");
    expect(nextToOfferEndorsement(s)).toBeUndefined();
  });

  it("is not offered twice", () => {
    let s = notePlayed(emptyFeedbackStore(), IVY, "t");
    s = noteAnswered(s, feedbackKey(IVY.packageId, 4), { answer: "worked" }, "t");
    s = noteEndorsed(s, feedbackKey(IVY.packageId, 4), "t");
    expect(nextToOfferEndorsement(s)).toBeUndefined();
  });
});

describe("the file", () => {
  it("round-trips", async () => {
    let s = notePlayed(emptyFeedbackStore(), IVY, "2026-09-21T10:00:00Z");
    s = noteAnswered(s, feedbackKey(IVY.packageId, 4), { answer: "worked" }, "2026-09-21T11:00:00Z");
    await saveFeedback(dir, s);
    expect(await loadFeedback(dir)).toEqual(s);
  });

  it("treats a missing file as nothing asked", async () => {
    expect(await loadFeedback(dir)).toEqual(emptyFeedbackStore());
  });

  it("survives a corrupt file rather than blocking the page", async () => {
    fs.writeFileSync(path.join(dir, COLLECTION_FEEDBACK_FILE), "{ not json");
    expect(await loadFeedback(dir)).toEqual(emptyFeedbackStore());
  });

  it("drops an entry that could not name a collection", async () => {
    // A hand-edited file must not make the UI ask about nothing, or send a
    // vote for a revision that does not exist.
    fs.writeFileSync(
      path.join(dir, COLLECTION_FEEDBACK_FILE),
      JSON.stringify({
        schema: "event-horizon.collection-feedback/1",
        entries: {
          good: { ...IVY, firstPlayedAt: "t" },
          bad: { packageId: "x" },
        },
      }),
    );
    const back = await loadFeedback(dir);
    expect(Object.keys(back.entries)).toEqual(["good"]);
  });
});
