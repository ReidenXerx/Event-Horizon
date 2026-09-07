/**
 * ──────────────────────────────────────────────────────────────────────
 * A refused resume must be diagnosable from the log alone.
 *
 * A tester forked a fourth profile and the log said only
 * `whyNotResumed: "profile-deleted"`. That single field is equally consistent
 * with two very different things:
 *
 *   - they deleted the profile between attempts — a habit to mention, and
 *     nothing to fix;
 *   - we recorded a profile id that can never match — a bug that forks a
 *     profile on every run, forever.
 *
 * Nobody could tell which, so the answer was a guess. Three facts settle it
 * without asking the user anything: the id we wanted, every profile Vortex
 * actually has for the game, and what the previous run recorded.
 *
 * Asserted against the source because these are log lines: their absence is
 * invisible until the next incident, which is exactly when it is too late.
 * ──────────────────────────────────────────────────────────────────────
 */
import { readFileSync } from "fs";
import { join } from "path";

import { describe, expect, it } from "vitest";

const src = readFileSync(join(__dirname, "runInstall.ts"), "utf8");

/** The body of the profile-resolution log call. */
const resolved = src.slice(
  src.indexOf('ehLog("info", "install.profile.resolved"'),
  src.indexOf('aborted = checkAbort("creating-profile")'),
);

describe("a refused resume explains itself", () => {
  it("names the profile it went looking for", () => {
    expect(resolved).toContain("attemptProfileId");
  });

  it("lists the profiles Vortex actually has", () => {
    // The half that turns a claim into a check: if the wanted id is not in
    // this list it was deleted; if the list is empty or shaped differently,
    // the lookup itself is wrong.
    expect(resolved).toContain("knownProfiles");
    expect(src).toContain("function listProfilesForGame");
  });

  it("caps the profile list, because a log is sent to a stranger", () => {
    const helper = src.slice(
      src.indexOf("function listProfilesForGame"),
      src.indexOf("function archivePathForMod"),
    );
    expect(helper).toContain(".slice(0, 20)");
  });

  it("never lets the diagnostic break an install", () => {
    // A log line that can throw is worse than no log line: it turns a
    // question about a profile into a failed install.
    const helper = src.slice(
      src.indexOf("function listProfilesForGame"),
      src.indexOf("function archivePathForMod"),
    );
    expect(helper).toContain("catch");
  });

  it("records what the PREVIOUS run wrote, so one file has both sides", () => {
    /**
     * The decision to resume is made from a record written by an earlier run,
     * whose only trace was a file on the user's disk that nobody thinks to
     * ask for. Logging the write puts both halves of the handoff in the file
     * the tester already sends.
     */
    expect(src).toContain('"install.attempt.recorded"');
    const recorded = src.slice(
      src.indexOf('ehLog("info", "install.attempt.recorded"'),
      src.indexOf('ehLog("info", "install.attempt.recorded"') + 900,
    );
    // The field the next run's resume depends on, and whether it is usable.
    expect(recorded).toContain("profileId");
    expect(recorded).toContain("willBeResumable");
  });
});
