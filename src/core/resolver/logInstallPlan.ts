/**
 * Logging for the install plan.
 *
 * WHY THIS IS A SEPARATE MODULE AND NOT `ehLog` CALLS INSIDE THE RESOLVER:
 * `resolveInstallPlan` is a pure function of (manifest, userState,
 * installTarget). That purity is what makes its 40-odd decision tests cheap
 * and what lets the same inputs be replayed later against a fixed build.
 * Threading a file-writing side effect through it would trade that away for
 * nothing — the plan it returns already contains every fact worth logging.
 *
 * WHY IT EXISTS AT ALL: the resolver decides, per mod, "already installed",
 * "download this", "the bytes diverged", "cannot find it". Those decisions
 * drive everything the driver then does, and until now not one of them
 * reached the log. When a tester reported 1,093 mods being reinstalled that
 * were already present, the plan that made that call left no trace, and the
 * cause — `installedMods` scoped to a profile instead of to the game pool —
 * took a full investigation that ONE of these lines would have settled.
 *
 * So: one summary line with the shape of the inputs (which is where the bug
 * was), a histogram of what was decided, and a per-mod line for every mod
 * that is NOT the boring case.
 */

import { ehLog } from "../logging/ehLog";

import type { InstallPlan, ModResolution, UserSideState } from "../../types/installPlan";

/**
 * Decision kinds that mean "nothing to see here": the mod is present and
 * correct, or an archive we already hold covers it. Everything else gets its
 * own line, because everything else is a thing someone will later ask about.
 */
const UNREMARKABLE = new Set([
  "nexus-already-installed",
  "external-already-installed",
]);

/**
 * Cap on per-mod lines. A collection of 1,100 mods where every one needs
 * attention is exactly the pathological case worth logging, so the cap is
 * high — but it is a cap, and the overflow is counted rather than dropped
 * silently, because a truncated list that does not say it was truncated is
 * how a partial answer gets read as a complete one.
 */
const MAX_ATTENTION_LINES = 500;

function countBy<T>(items: readonly T[], key: (item: T) => string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const item of items) {
    const k = key(item);
    out[k] = (out[k] ?? 0) + 1;
  }
  return out;
}

/**
 * Describe the resolver's INPUTS, not just its output.
 *
 * Every resolver bug found so far has been a bad input wearing a plausible
 * output: the right ladder run against the wrong list of installed mods. The
 * counts below are the cheapest way to tell those apart at a glance — an
 * `installedMods` figure far below what the user has in Vortex is the tell,
 * and `withSha` / `withNexusId` say whether those entries can be MATCHED at
 * all, since a mod with no sha never satisfies the byte-exact arm.
 */
function describeInputs(userState: UserSideState): Record<string, unknown> {
  const installed = userState.installedMods;
  return {
    installedMods: installed.length,
    installedWithSha: installed.filter((m) => m.archiveSha256 !== undefined).length,
    installedWithNexusId: installed.filter((m) => m.nexusModId !== undefined).length,
    // `undefined` and `0` mean different things here: undefined is "the caller
    // chose not to hash the downloads folder", 0 is "it hashed it and found
    // nothing usable". Conflating them hides a skipped step as an empty one.
    availableDownloads:
      userState.availableDownloads === undefined
        ? "not-collected"
        : userState.availableDownloads.length,
    activeProfileId: userState.activeProfileId,
    gameId: userState.gameId,
    gameVersion: userState.gameVersion ?? "unknown",
  };
}

/**
 * Record what the resolver decided and why it could have decided it.
 *
 * @param plan  the resolved plan, as returned by `resolveInstallPlan`
 * @param userState  the inputs it ran against
 * @param where  which call site resolved this plan — the same manifest is
 *   resolved by the action handler and by the install page at two different
 *   moments, and "which of those produced this line" is the first thing you
 *   need when two disagree
 */
export function logInstallPlan(
  plan: InstallPlan,
  userState: UserSideState,
  where: string,
): void {
  const byDecision = countBy(plan.modResolutions, (r) => r.decision.kind);

  ehLog("info", "resolver.plan.resolved", {
    where,
    installTarget: plan.installTarget.kind,
    collection: plan.manifest.package.name,
    version: plan.manifest.package.version,
    inputs: describeInputs(userState),
    totalMods: plan.summary.totalMods,
    byDecision,
    alreadyInstalled: plan.summary.alreadyInstalled,
    willInstallSilently: plan.summary.willInstallSilently,
    needsUserConfirmation: plan.summary.needsUserConfirmation,
    missing: plan.summary.missing,
    orphans: plan.summary.orphans,
    canProceed: plan.summary.canProceed,
    // When `canProceed` is false the next question is always "because of
    // what". The strings, not only the counts: a blocked install whose log
    // says `compatErrors: 1` has told you nothing you could act on.
    compatErrors: plan.compatibility.errors,
    compatWarnings: plan.compatibility.warnings,
    externalDepsNotOk: plan.externalDependencies.filter(
      (d) => d.status.kind !== "ok",
    ).length,
  });

  const attention: ModResolution[] = plan.modResolutions.filter(
    (r) => !UNREMARKABLE.has(r.decision.kind),
  );
  for (const r of attention.slice(0, MAX_ATTENTION_LINES)) {
    // The decision object carries its own evidence — the diverged fileIds,
    // the two shas, the reason a mod is unreachable — so it goes in whole
    // rather than being flattened into a message no field can be read out of.
    ehLog("debug", "resolver.mod.decided", {
      where,
      name: r.name,
      compareKey: r.compareKey,
      source: r.sourceKind,
      decision: r.decision,
    });
  }
  if (attention.length > MAX_ATTENTION_LINES) {
    ehLog("warn", "resolver.mod.decided.truncated", {
      where,
      logged: MAX_ATTENTION_LINES,
      total: attention.length,
      omitted: attention.length - MAX_ATTENTION_LINES,
    });
  }
}
