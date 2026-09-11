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
 *
 * ─── BUT NOT ALWAYS, AND SOMETIMES NOTHING IS SENT AT ALL ──────────────
 * Read in the deployed bundle (nexus_integration `onEndorseMod`,
 * `endorseThing`, `endorseModImpl`, and the mods reducer):
 *
 *  - Logged out: an error notification, and nothing written.
 *  - The mod is looked up under the ACTIVE game; absent there, or with no
 *    Nexus mod id, or with no `version` / `modVersion`: nothing written.
 *  - "pending" is written under the mod's `downloadGame`, the answer under
 *    the active game — and `setModAttribute` is dropped for a mod that is
 *    not in that game's pool. So for a mod downloaded for another game (or
 *    with no `downloadGame`) no marker is ever written, and an error that
 *    puts back "Undecided" looks exactly like no answer.
 *
 * Each of those used to read "gave no answer within 15 seconds and may still
 * land" — a refusal reported as a request in flight. They are checked before
 * sending, and a request whose marker should appear and does not is reported
 * as not sent.
 */

/** The status Vortex must be handed so that it ENDORSES. */
export function statusToSend(current: string | undefined): string {
  return current === undefined || current === "" ? "Undecided" : current;
}

export type EndorseOutcome = "endorsed" | "abstained" | "failed" | "timeout" | "not-sent";

/** How long a request's "pending" marker may take to appear before it counts as not sent. */
export const NOT_SENT_AFTER_MS = 1000;

/**
 * Poll the attribute until Vortex has answered.
 *
 * `read` returns the mod's current `endorsed` attribute under the active
 * game, where the answer lands. `before` is what it was when the request
 * went out, so an answer that merely repeats it (an error path writes
 * "Undecided", which is also the usual starting value) is told apart from
 * "no answer yet" by the transit through "pending".
 *
 * `readPending`, when the marker is readable at all (see
 * {@link pendingGameFor}), reads where Vortex writes it. Given one, a request
 * whose marker has not appeared within `notSentAfterMs` is "not-sent": the
 * handler writes it synchronously when it accepts the request.
 */
export async function waitForEndorseOutcome(args: {
  read: () => string | undefined;
  readPending?: () => string | undefined;
  before: string | undefined;
  timeoutMs?: number;
  notSentAfterMs?: number;
  intervalMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}): Promise<EndorseOutcome> {
  const timeoutMs = args.timeoutMs ?? 15_000;
  const notSentAfterMs = args.notSentAfterMs ?? NOT_SENT_AFTER_MS;
  const intervalMs = args.intervalMs ?? 150;
  const sleep = args.sleep ?? ((ms): Promise<void> => new Promise((r) => setTimeout(r, ms)));
  const now = args.now ?? Date.now;
  const startedAt = now();
  const deadline = startedAt + timeoutMs;
  let sawPending = false;
  while (now() < deadline) {
    const current = args.read();
    if (current === "pending" || args.readPending?.() === "pending") sawPending = true;
    if (current !== undefined && current !== "" && current !== "pending") {
      const lower = current.toLowerCase();
      if (lower === "endorsed") return "endorsed";
      if (lower === "abstained") return "abstained";
      // "Undecided" after "pending" is Vortex's error path.
      if (sawPending) return "failed";
      if (current !== args.before) return lower === "undecided" ? "failed" : "endorsed";
    }
    if (args.readPending !== undefined && !sawPending && now() - startedAt >= notSentAfterMs) return "not-sent";
    await sleep(intervalMs);
  }
  return "timeout";
}

/**
 * The game key Vortex's "pending" marker lands under, when it lands at all.
 *
 * Vortex writes it under `attributes.downloadGame`, and its reducer drops the
 * write for a mod that is not in that game's pool. Undefined means no marker
 * will ever be readable for this mod.
 */
export function pendingGameFor(
  modsByGame: Readonly<Record<string, Readonly<Record<string, unknown>> | undefined>> | undefined,
  downloadGame: unknown,
  modId: string,
): string | undefined {
  if (typeof downloadGame !== "string" || downloadGame === "") return undefined;
  return modsByGame?.[downloadGame]?.[modId] !== undefined ? downloadGame : undefined;
}

/**
 * Why Vortex would do nothing with an endorse request for this mod, or
 * undefined when it would send one. The same checks, in the same order, as
 * Vortex's handler.
 */
export function endorseRefusal(input: {
  /** From readNexusAccount: only a definite "logged-out" refuses. */
  account: "logged-out" | "free" | "premium" | "unknown";
  activeGameId: string | undefined;
  gameId: string;
  /** The mod's attributes under the ACTIVE game; undefined when Vortex has no such mod there. */
  attributes: Readonly<Record<string, unknown>> | undefined;
}): string | undefined {
  if (input.account === "logged-out") return "you are not logged in to Nexus in Vortex";
  if (input.activeGameId !== undefined && input.activeGameId !== input.gameId) {
    return "Vortex endorses only mods of the game it is managing";
  }
  const a = input.attributes;
  if (a === undefined) return "Vortex no longer has this mod";
  if (!a.modId) return "it has no Nexus mod id";
  if (!(a.version || a.modVersion)) return "it has no version recorded, and Vortex will not endorse a mod without one";
  return undefined;
}

export type EndorseRun = {
  endorsed: number;
  failed: string[];
  /** Sent, the marker was seen, and no answer came within the clock: may still land. */
  timedOut: string[];
  /** Sent, but no marker is ever readable for these and no answer came: refusal and silence look the same. */
  unreadable: string[];
  /** Not sent, with the reason. */
  notSent: { name: string; why: string }[];
  sent: number;
};

const num = (n: number): string => n.toLocaleString();
const listed = (names: readonly string[]): string => names.slice(0, 5).join(", ") + (names.length > 5 ? "…" : "");

export function describeEndorseRun(o: EndorseRun, asked: number, stopped: boolean): string {
  const parts = [`Endorsed ${num(o.endorsed)} of ${num(asked)} mod(s)` + (stopped ? " before you stopped it" : "")];
  if (o.failed.length > 0) {
    parts.push(`Nexus refused ${num(o.failed.length)} (${listed(o.failed)}) — Vortex's notifications say why`);
  }
  const byWhy = new Map<string, string[]>();
  for (const { name, why } of o.notSent) byWhy.set(why, [...(byWhy.get(why) ?? []), name]);
  for (const [why, names] of byWhy) {
    parts.push(`${num(names.length)} not sent because ${why} (${listed(names)})`);
  }
  if (o.timedOut.length > 0) {
    parts.push(`${num(o.timedOut.length)} gave no answer within 15 seconds and may still land`);
  }
  if (o.unreadable.length > 0) {
    parts.push(
      `${num(o.unreadable.length)} were sent but gave no readable answer (${listed(o.unreadable)}): Vortex marks a ` +
        `request in progress only under the game a mod was downloaded for, so for these a refusal cannot be told ` +
        `from silence — check them on Nexus`,
    );
  }
  return parts.join("; ") + ".";
}
