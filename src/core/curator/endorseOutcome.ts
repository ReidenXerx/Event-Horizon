/**
 * Endorsing through Vortex, with an answer.
 *
 * ─── THE STATUS IS THE CURRENT ONE, NOT THE WANTED ONE ─────────────────
 * Vortex's `endorse-mod` handler takes the mod's CURRENT status and TOGGLES:
 * its `endorseMod` maps "undecided" / "abstained" / "" → endorse, and
 * "endorsed" → abstain. Verified in the deployed bundle, and in Vortex's own
 * UI, which passes `mod.attributes.endorsed ?? "Undecided"`. The bulk
 * endorse here sent the literal "Endorsed" — the state it WANTED — and so
 * asked Nexus to abstain on every mod it touched.
 *
 * ─── AND THERE IS AN ANSWER, IN THE ATTRIBUTE ──────────────────────────
 * The handler writes `endorsed: "pending"` when it starts, the result
 * ("Endorsed") when Nexus answers, and "Undecided" on an error. So the
 * outcome of each request is readable from the mod's own attribute, and a
 * fixed 250ms pause with no result was never necessary: wait for the
 * attribute to leave "pending", then move on.
 */

/** The status Vortex must be handed so that it ENDORSES. */
export function statusToSend(current: string | undefined): string {
  return current === undefined || current === "" ? "Undecided" : current;
}

export type EndorseOutcome = "endorsed" | "abstained" | "failed" | "timeout";

/**
 * Poll the attribute until Vortex has answered.
 *
 * `read` returns the mod's current `endorsed` attribute. `before` is what it
 * was when the request went out, so an answer that merely repeats it (an
 * error path writes "Undecided", which is also the usual starting value)
 * is told apart from "no answer yet" by the transit through "pending".
 */
export async function waitForEndorseOutcome(args: {
  read: () => string | undefined;
  before: string | undefined;
  timeoutMs?: number;
  intervalMs?: number;
  sleep?: (ms: number) => Promise<void>;
}): Promise<EndorseOutcome> {
  const timeoutMs = args.timeoutMs ?? 15_000;
  const intervalMs = args.intervalMs ?? 150;
  const sleep = args.sleep ?? ((ms): Promise<void> => new Promise((r) => setTimeout(r, ms)));
  const deadline = Date.now() + timeoutMs;
  let sawPending = false;
  while (Date.now() < deadline) {
    const now = args.read();
    if (now === "pending") sawPending = true;
    else if (now !== undefined && now !== "") {
      const lower = now.toLowerCase();
      if (lower === "endorsed") return "endorsed";
      if (lower === "abstained") return "abstained";
      // "Undecided" after "pending" is Vortex's error path.
      if (sawPending) return "failed";
      if (now !== args.before) return lower === "undecided" ? "failed" : "endorsed";
    }
    await sleep(intervalMs);
  }
  return "timeout";
}
