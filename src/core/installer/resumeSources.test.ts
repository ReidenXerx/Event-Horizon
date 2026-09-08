/**
 * A killed run used to be unresumable.
 *
 * The driver keeps two records of a run in flight and they are disjoint by
 * construction: an ATTEMPT is written when a run ENDS badly, a MARKER when it
 * STARTS. `resumableProfileFromAttempts` read attempts only — so a run that
 * was force-quit, or lost to a power cut, wrote no attempt (no `finally`
 * runs), and the marker that survived with the profile id in it was read by
 * nobody. The next launch logged `whyNotResumed: "no-attempt"` and forked a
 * new profile. A tester ended up with several.
 */
import { describe, expect, it } from "vitest";

import { resumeCandidates } from "./resumeSources";
import { resumableProfileFromAttempts } from "../resolver/userState";
import type { InstallAttempt } from "./attemptRecord";
import type { InstallMarker } from "./installMarker";
import type { types } from "@nexusmods/vortex-api";

const PKG = "pkg-1";
const VERSION = "1.0.10";

const marker = (over: Partial<InstallMarker> = {}): InstallMarker => ({
  packageId: PKG,
  packageName: "Meridia Panties",
  packageVersion: VERSION,
  startedAt: "2026-09-08T00:00:00.000Z",
  profileId: "profile-from-marker",
  gameId: "skyrimse",
  totalMods: 1755,
  ...over,
});

const attempt = (over: Partial<InstallAttempt> = {}): InstallAttempt =>
  ({
    packageId: PKG,
    packageName: "Meridia Panties",
    packageVersion: VERSION,
    gameId: "skyrimse",
    endedAt: "2026-09-08T01:00:00.000Z",
    outcome: "failed",
    phase: "installing-mods",
    installedCount: 900,
    totalMods: 1755,
    profileId: "profile-from-attempt",
    ...over,
  }) as InstallAttempt;

/** Vortex state where both candidate profiles exist for this game. */
const state = (): types.IState =>
  ({
    persistent: {
      profiles: {
        "profile-from-marker": {
          id: "profile-from-marker",
          gameId: "skyrimse",
          name: "EH (from marker)",
        },
        "profile-from-attempt": {
          id: "profile-from-attempt",
          gameId: "skyrimse",
          name: "EH (from attempt)",
        },
      },
    },
  }) as unknown as types.IState;

const resolve = (candidates: ReturnType<typeof resumeCandidates>) =>
  resumableProfileFromAttempts(state(), "skyrimse", PKG, VERSION, candidates);

describe("a run that was KILLED, not merely failed", () => {
  it("resumes from the marker when there is no attempt", () => {
    // The whole point: no attempt exists because the process died before any
    // `finally` could run.
    const out = resolve(resumeCandidates([], [marker()]));
    expect(out).toMatchObject({
      kind: "resume",
      id: "profile-from-marker",
    });
  });

  it("still reports no-attempt when there is genuinely nothing", () => {
    expect(resolve(resumeCandidates([], []))).toMatchObject({
      kind: "refused",
      why: "no-attempt",
    });
  });
});

describe("when both records exist", () => {
  it("believes the ATTEMPT — it is the more specific claim", () => {
    // A cleared marker is the normal case, so both existing means the clear
    // failed. The attempt knows how the run ended and in which phase; the
    // marker only knows it started.
    const out = resolve(resumeCandidates([attempt()], [marker()]));
    expect(out).toMatchObject({
      kind: "resume",
      id: "profile-from-attempt",
    });
  });
});

describe("the version guard still applies to a marker", () => {
  it("refuses a marker left by a DIFFERENT release", () => {
    // Resuming into a profile filled for another version is the case the
    // guard exists for, and adding a second source must not open a hole in it.
    const out = resolve(
      resumeCandidates([], [marker({ packageVersion: "1.0.9" })]),
    );
    expect(out).toMatchObject({ kind: "refused", why: "version-changed" });
  });

  it("does not refuse a marker written before the field existed", () => {
    // Absent means unknown, not "different" — the same reading the guard
    // already applies to a legacy attempt. Refusing a real half-finished
    // install because an older build omitted a field is the failure this
    // path exists to stop.
    const legacy = marker();
    delete (legacy as { packageVersion?: string }).packageVersion;
    expect(resolve(resumeCandidates([], [legacy]))).toMatchObject({
      kind: "resume",
      id: "profile-from-marker",
    });
  });
});

describe("resumeCandidates ordering", () => {
  it("puts every attempt before every marker", () => {
    // `resumableProfileFromAttempts` takes the FIRST match, so the order is
    // the preference and it must not be incidental.
    const list = resumeCandidates([attempt()], [marker()]);
    expect(list.map((c) => c.profileId)).toEqual([
      "profile-from-attempt",
      "profile-from-marker",
    ]);
  });
});

describe("the wiring, not just the helper", () => {
  /**
   * Mutating the engine to pass attempts alone left all six tests above
   * green — the helper was covered and its CALL SITE was not, which is the
   * same gap that let the deploy-mods argument order survive 200 tests.
   *
   * Asserted as a property rather than a spelling: EVERY `resumeCandidates`
   * call must receive both sources. That survives renaming the surrounding
   * variables, reordering the file, and adding a third call site — three
   * source-text guards in this repo have already failed on a spelling they
   * were never testing.
   */
  it("gives every resume decision BOTH records", async () => {
    const fs = await import("fs");
    const path = await import("path");
    const src = fs.readFileSync(
      path.join(__dirname, "..", "..", "ui", "pages", "install", "engine.ts"),
      "utf8",
    );
    const calls = [...src.matchAll(/resumeCandidates\(([\s\S]{0,300}?)\n\s*\),/g)];
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      expect(call[1]).toContain("listInstallAttempts");
      expect(call[1]).toContain("listInterruptedInstalls");
    }
  });
});
