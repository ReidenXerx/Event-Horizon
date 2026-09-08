/**
 * A retry must not be blocked by the fact that the previous run worked.
 *
 * ─── THE RUN THIS COMES FROM ────────────────────────────────────────────────
 * A tester's first install answered ten `external-prompt-user` mods by
 * pointing at local files. One unrelated mod failed, so they pressed Retry —
 * and preflight refused the whole 979-mod plan before installing anything:
 *
 *   Plan contains 7 invalid conflictChoice(s): Render Tattoos
 *   [external-already-installed]: decision kind "external-already-installed"
 *   does not accept user choices; PorcOverlays_esl_02b [...]; facegen_v1.0
 *   [...]; AAF_SCRS_Cr_V2.3.1 [...]; AAF_VanillaKinkyCreatureAnimations_Themes
 *   [external-use-local-download]: ...; AAF_AutonomyEnhanced_v2.800 [...];
 *   bodyslides_f4_sd [...]
 *
 * Every one of those seven had been answered on the first run and the answer
 * had WORKED — the mod is installed, which is precisely why the resolver now
 * returns `external-already-installed` and asks nothing. The stored answer had
 * done its job. "Obsolete" was being read as "invalid".
 *
 * `preflight` is a pure function of the plan and the user's answers, so these
 * drive it directly and assert on the refusal string — the thing the user saw.
 */
import { describe, expect, it } from "vitest";

import { preflight } from "./runInstall";

/** A plan with only the fields preflight reads. */
const planWith = (args: {
  resolutions?: unknown[];
  orphans?: unknown[];
}): never =>
  ({
    summary: { canProceed: true },
    compatibility: { gameMatches: true },
    modResolutions: args.resolutions ?? [],
    orphanedMods: args.orphans ?? [],
    installTarget: { kind: "current-profile" },
  }) as never;

const collectPreflightRefusal = (args: {
  resolutions?: unknown[];
  orphans?: unknown[];
  conflictChoices?: Record<string, unknown>;
  orphanChoices?: Record<string, unknown>;
}): string | undefined =>
  preflight(planWith(args), {
    conflictChoices: args.conflictChoices ?? {},
    orphanChoices: args.orphanChoices ?? {},
  } as never);

describe("answers that a previous run already satisfied", () => {
  it("does not refuse when the decision no longer asks a question", () => {
    const refusal = collectPreflightRefusal({
      resolutions: [
        {
          compareKey: "external:aaa",
          name: "Render Tattoos",
          decision: { kind: "external-already-installed" },
        },
        {
          compareKey: "external:bbb",
          name: "AAF_VanillaKinkyCreatureAnimations_Themes",
          decision: { kind: "external-use-local-download" },
        },
      ],
      conflictChoices: {
        // Both answered on the first run, both now installed.
        "external:aaa": { kind: "use-local-file", localPath: "C:/a.7z" },
        "external:bbb": { kind: "use-local-file", localPath: "C:/b.7z" },
      },
    });
    expect(refusal).toBeUndefined();
  });

  it("STILL refuses a wrong-shaped answer to a live question", () => {
    // The validation exists for a reason and has to survive the fix: a mod
    // that genuinely needs an answer, given one it cannot use, is a bug.
    const refusal = collectPreflightRefusal({
      resolutions: [
        {
          compareKey: "external:ccc",
          name: "Still Asking",
          decision: { kind: "external-prompt-user" },
        },
      ],
      conflictChoices: {
        "external:ccc": { kind: "replace-existing" },
      },
    });
    expect(refusal).toMatch(/invalid conflictChoice/);
    expect(refusal).toMatch(/Still Asking/);
  });

  it("accepts a right-shaped answer to a live question", () => {
    const refusal = collectPreflightRefusal({
      resolutions: [
        {
          compareKey: "external:ddd",
          name: "Asking Nicely",
          decision: { kind: "external-prompt-user" },
        },
      ],
      conflictChoices: {
        "external:ddd": { kind: "use-local-file", localPath: "C:/d.7z" },
      },
    });
    expect(refusal).toBeUndefined();
  });

  it("still refuses an answer for a mod that is not in the plan at all", () => {
    // A key matching NO mod is a real bug, not a decision that moved on: the
    // plan always contains every manifest mod.
    const refusal = collectPreflightRefusal({
      resolutions: [
        {
          compareKey: "external:eee",
          name: "Present",
          decision: { kind: "external-already-installed" },
        },
      ],
      conflictChoices: {
        "external:not-in-the-plan": { kind: "skip" },
      },
    });
    expect(refusal).toMatch(/stray conflictChoice key/);
  });

  it("ignores an orphan answer whose mod is no longer an orphan", () => {
    // The previous run already uninstalled it, so it is not offered again —
    // and refusing on that blocks a retry because the retry worked.
    const refusal = collectPreflightRefusal({
      resolutions: [],
      orphans: [],
      orphanChoices: { "mod-removed-last-run": { kind: "uninstall" } },
    });
    expect(refusal).toBeUndefined();
  });
});
