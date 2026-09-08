/**
 * What a stop past the point of no return did NOT do, in one sentence.
 *
 * ─── WHAT THIS FILE USED TO BE ──────────────────────────────────────────────
 * `runPhase.ts`: a phase combinator — `runPhase` and `runFinishing` — written
 * to replace six copy-pasted blocks in `runInstallImpl` with one guarded
 * shape, plus an `isAbort` helper and this describer.
 *
 * It was a good idea and it lost. The driver never adopted it: a later change
 * grew `stopBeforeWriting(phase)` instead — a closure over the run's own
 * `finishingSkipped` array — and that is what all five post-deploy writers
 * use. So the combinator sat at ZERO production call sites while nine of its
 * eleven tests exercised code nothing ran, and `isAbort` became the second
 * copy of that predicate in the repo.
 *
 * The argument for keeping it was that its `consequence` field is required on
 * purpose, and a phase whose author cannot write that sentence has not thought
 * about what happens when it fails. That argument is sound and it did not
 * survive contact: the driver's own guard has no such field and is the one
 * being used. Two implementations of one rule is how this codebase drifted in
 * the first place, and a documented combinator nobody calls is read as the
 * house style by the next contributor and copied rather than used.
 *
 * So the combinator is gone and the one function with real callers moved here,
 * where its name says what it does.
 */

/**
 * The sentence the Done screen shows after a stop past the deploy.
 *
 * `skipped` is every finishing step the run declined to perform because the
 * user pressed Stop. It leads with WHY the run reported success — a fully
 * deployed collection with no receipt is the state provenance depends on not
 * existing (NS-2) — and ends with the fact that decides what they do next:
 * running it again is cheap, because every mod is already recognised.
 */
export function describeSkippedFinishing(skipped: readonly string[]): string {
  return (
    `You stopped the install after the mods were already deployed, so it ` +
    `finished writing its record rather than leaving you with none. These ` +
    `steps were skipped: ${skipped.join(", ")}. Running the install again ` +
    `picks them up — every mod is recognised rather than re-downloaded.`
  );
}
