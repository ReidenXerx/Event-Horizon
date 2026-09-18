/**
 * ──────────────────────────────────────────────────────────────────────
 * Install the runtimes this machine is actually missing, and re-probe THEM.
 *
 * ─── WHY THIS EXISTS SEPARATELY ────────────────────────────────────────
 * `installSession.offerRuntimeRepair` already installs runtimes, but it is
 * built around one symptom: Vortex's 7-Zip cannot unpack, so install
 * everything plausible and re-test the extractor. That is the right shape for
 * that failure and the wrong shape for every other one.
 *
 * The failure this is for looks like nothing at all. A player without the
 * VC++ runtime installs a collection perfectly, every file verifies, and then
 * a script-extender plugin silently never loads — Fallout 4 body physics
 * being the one that brought it up: the bodies are there, the physics is not,
 * and no error is printed anywhere a player would look.
 *
 * The preview HAS detected this since `detectRuntimes` was written. It just
 * turned the finding into a sentence. So the fix was one paragraph of text
 * away from the person who needed it, and the only button that could act on
 * it appeared when 7-Zip was already broken.
 *
 * ─── THE VERIFY IS THE POINT, AND IT IS A DIFFERENT PROBE ──────────────
 * The 7-Zip repair verifies by re-running the extractor self-test. Here the
 * honest check is the detector itself, re-run for exactly the ids we tried to
 * install. An exit code is not evidence — 1638 means "a newer one is already
 * there" and reads as failure, and under Wine an installer can report success
 * having changed nothing. So the result says what the REGISTRY said
 * afterwards.
 * ──────────────────────────────────────────────────────────────────────
 */

import type { types } from "@nexusmods/vortex-api";

import { ehLog } from "../../core/logging/ehLog";
import type { PrerequisiteId } from "../../core/runtime/prerequisites";
import type { RuntimeFinding } from "../../core/runtime/detectRuntimes";

export type RuntimeRepairOutcome = {
  /** True when every id asked for probes `present` afterwards. */
  fixed: boolean;
  /** One line per runtime, in the words the user should read. */
  lines: string[];
  /** What the detector said AFTER installing, for the log and the UI. */
  after: RuntimeFinding[];
};

/** Which findings are worth offering to install. */
export function missingRuntimeIds(
  findings: readonly RuntimeFinding[],
): PrerequisiteId[] {
  // `unknown` is deliberately excluded: a probe that could not run is not a
  // reason to download and execute an installer on someone's machine.
  return findings.filter((f) => f.status === "absent").map((f) => f.id);
}

/**
 * Download and install `ids`, then re-probe those same ids.
 *
 * Never throws: this is offered from a preview and from the Doctor, and a
 * failed repair must leave both usable.
 */
export async function repairRuntimes(args: {
  api: types.IExtensionApi;
  ids: readonly PrerequisiteId[];
  onStep?: (message: string) => void;
}): Promise<RuntimeRepairOutcome> {
  const { api, ids } = args;
  if (ids.length === 0) {
    return { fixed: true, lines: ["Nothing was missing."], after: [] };
  }

  const [
    { installPrerequisites, summarisePrereqResults },
    { nodePrereqDeps },
    { PREREQUISITES },
    { detectRuntimes },
    { readRegistryValue, fileExists },
    proton,
  ] = await Promise.all([
    import("../../core/runtime/installPrerequisites"),
    import("../../core/runtime/nodePrereqDeps"),
    import("../../core/runtime/prerequisites"),
    import("../../core/runtime/detectRuntimes"),
    import("../../core/runtime/nodePrereqDeps"),
    import("../../core/proton"),
  ]);

  const onWine = proton.looksLikeWine();
  const wanted = PREREQUISITES.filter((p) => ids.includes(p.id));

  const probe = async (): Promise<RuntimeFinding[]> =>
    detectRuntimes(
      {
        readRegistryValue,
        fileExists,
        systemDir: `${process.env.WINDIR ?? "C:\\Windows"}\\System32`,
      },
      ids,
    );

  ehLog("info", "runtime.repair.start", { ids, onWine });
  args.onStep?.("Downloading…");

  let after: RuntimeFinding[] = [];
  try {
    const results = await installPrerequisites(
      wanted,
      nodePrereqDeps(async () => {
        after = await probe();
        return after.every((f) => f.status === "present");
      }),
      {
        onStep: (step) => {
          args.onStep?.(
            step.phase === "downloading"
              ? `Downloading ${step.id}…`
              : step.phase === "installing"
                ? `Installing ${step.id}…`
                : step.phase === "verifying"
                  ? "Checking whether that worked…"
                  : `${step.id} done`,
          );
        },
      },
    );

    // Whatever the installers claimed, this is what the machine says now.
    if (after.length === 0) after = await probe();
    const stillMissing = after.filter((f) => f.status === "absent");
    const summary = summarisePrereqResults(results, onWine);
    const lines = [
      summary.message,
      ...(stillMissing.length > 0
        ? [
            `Still missing after installing: ${stillMissing
              .map((f) => f.name)
              .join(", ")}.`,
          ]
        : []),
    ];
    const fixed = stillMissing.length === 0;
    ehLog(fixed ? "info" : "warn", "runtime.repair.done", {
      ids,
      fixed,
      after: after.map((f) => ({ id: f.id, status: f.status, version: f.version })),
    });
    return { fixed, lines, after };
  } catch (err) {
    ehLog("error", "runtime.repair.failed", { ids, err });
    return {
      fixed: false,
      lines: [
        `The repair could not finish: ${
          err instanceof Error ? err.message : String(err)
        }`,
      ],
      after,
    };
  }
}
