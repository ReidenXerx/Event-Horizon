/**
 * One finishing step of an install: guarded, non-fatal, abort-aware.
 *
 * ─── THE SHAPE THIS REPLACES ────────────────────────────────────────────────
 * Six blocks of `runInstallImpl` were the same eleven lines with five words
 * changed: is there work to do → report progress → run it → merge the result
 * into the receipt → on an AbortError return the abort, on anything else log
 * and carry on → check the signal. Mod rules, the LOOT userlist and the load
 * order are the clearest three; they differ only in name, guard, call, merge
 * and the sentence describing what silently fails.
 *
 * ─── WHY IT MATTERS THAT IT WAS COPY-PASTED ─────────────────────────────────
 * It had already drifted. Every phase up to `applying-load-order` checked the
 * abort signal; the five appended after it — plugin order, ESL flags, the
 * order check, mod types, game INI — did not, and two of them did not even
 * take the signal. Nobody decided that. It is what happens when the pattern
 * lives in the reader's head instead of in a function, and each new fix was
 * appended to the end of a 2,240-line body.
 *
 * ─── `consequence` IS REQUIRED ON PURPOSE ───────────────────────────────────
 * A non-fatal catch that logs "it threw" tells you nothing you can act on. The
 * two best comments in the driver are the ones that say what the silence
 * costs — "continuing without rule application: the curator's conflict order
 * is NOT reproduced on this machine" — and a phase whose author cannot write
 * that sentence has not thought about what happens when it fails.
 */

import { ehLog } from "../logging/ehLog";

/** How a phase ended. */
export type PhaseOutcome =
  /** It ran, or there was nothing to do. */
  | "ok"
  /** It threw. Non-fatal: the run continues, the consequence is logged. */
  | "failed"
  /** The user stopped the run. The caller decides what that means. */
  | "aborted"
  /**
   * Skipped because the user had already stopped the run, and this phase runs
   * past the point where stopping can undo anything. See {@link runFinishing}.
   */
  | "skipped-after-stop";

export type PhaseSpec<T> = {
  /** Driver phase name, for progress and the log. */
  readonly phase: string;
  /** Skip entirely when false — "there are no rules to apply". */
  readonly when?: boolean;
  /** The work. */
  readonly work: () => Promise<T> | T;
  /** Fold the result into the run's state. Not called when `work` throws. */
  readonly merge?: (result: T) => void;
  /**
   * What is silently wrong if this phase fails, in the user's terms.
   * Required — see the header.
   */
  readonly consequence: string;
};

/** True for an abort from either channel the driver uses. */
export function isAbort(err: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted === true) return true;
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { name?: unknown }).name === "AbortError"
  );
}

/**
 * Run one non-fatal phase.
 *
 * Never throws: an abort is reported as `"aborted"` and anything else as
 * `"failed"` with the consequence logged. The caller decides whether an abort
 * ends the run — that decision differs before and after the deploy, and it is
 * not this function's to make.
 */
export async function runPhase<T>(
  spec: PhaseSpec<T>,
  signal?: AbortSignal,
): Promise<PhaseOutcome> {
  if (spec.when === false) return "ok";
  if (signal?.aborted === true) return "aborted";

  try {
    const result = await spec.work();
    spec.merge?.(result);
    return "ok";
  } catch (err) {
    if (isAbort(err, signal)) {
      ehLog("info", `${spec.phase}.aborted`, {});
      return "aborted";
    }
    ehLog("error", `${spec.phase}.threw`, {
      consequence: spec.consequence,
      err,
    });
    return "failed";
  }
}

/**
 * Run a phase that happens AFTER the point of no return.
 *
 * ─── WHY THIS IS A DIFFERENT FUNCTION ───────────────────────────────────────
 * Once the deploy has run, the collection is on disk and linked into the game
 * folder. Everything after it — pinning the plugin order, restoring ESL flags,
 * writing the game INI — is finishing work, and the receipt that records the
 * whole install comes last.
 *
 * So an abort here is genuinely awkward. Honouring it by unwinding would leave
 * a fully-installed collection with NO receipt, which is the one state the
 * provenance rules depend on not existing (NS-2). Ignoring it is what the code
 * did: five phases ran with no signal check at all, so pressing Stop in the
 * last quarter of an install did nothing and said nothing.
 *
 * Neither is right, and the honest answer is the third one: stop doing further
 * work, keep going to the receipt, and TELL the user which finishing steps
 * were skipped. A stop is respected as far as it safely can be, and the part
 * that could not be respected is named rather than hidden.
 */
export async function runFinishing<T>(
  spec: PhaseSpec<T>,
  signal: AbortSignal | undefined,
  skipped: string[],
): Promise<PhaseOutcome> {
  if (spec.when === false) return "ok";
  if (signal?.aborted === true) {
    skipped.push(spec.phase);
    ehLog("info", `${spec.phase}.skipped-after-stop`, {
      why: "the user stopped the run; the mods are already deployed",
      consequence: spec.consequence,
    });
    return "skipped-after-stop";
  }
  const outcome = await runPhase(spec, signal);
  if (outcome === "aborted") {
    skipped.push(spec.phase);
    ehLog("info", `${spec.phase}.skipped-after-stop`, {
      why: "the user stopped the run mid-phase",
      consequence: spec.consequence,
    });
  }
  return outcome;
}

/** The sentence a user reads when a stop landed too late to undo anything. */
export function describeSkippedFinishing(skipped: readonly string[]): string {
  return (
    `You stopped the install after the mods were already deployed, so it ` +
    `finished writing its record rather than leaving you with none. These ` +
    `steps were skipped: ${skipped.join(", ")}. Running the install again ` +
    `picks them up — every mod is recognised rather than re-downloaded.`
  );
}
