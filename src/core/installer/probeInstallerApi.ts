/**
 * What does THIS Vortex's installer actually accept?
 *
 * Replaying a curator's FOMOD choices needs `start-install` (or
 * `start-install-download`) to take those choices as an argument. Vortex's
 * published typings do not describe its events at all — `api.events.emit` is
 * untyped, and `start-install` appears nowhere in `api.d.ts` — so the
 * signature is unknown from outside the running app.
 *
 * Guessing it would produce the worst possible outcome: extra arguments are
 * silently ignored by an EventEmitter, so a wrong guess installs every mod
 * with default options while the code claims to be replaying choices. That is
 * the same shape as every other bug this project has had — a thing that looks
 * like it worked.
 *
 * So ask the running Vortex. A listener's `length` is its declared arity and
 * its source head names the parameters, which together settle what can be
 * passed. Logged once at startup; costs nothing and answers a question no
 * amount of reading the typings can.
 */

import type { types } from "@nexusmods/vortex-api";

import { ehLog } from "../logging/ehLog";

/**
 * Watch what Vortex itself passes when a real install starts.
 *
 * The wrapper turned out to be a transparent error shim —
 * `(...args) => cb(...args)` — so extra arguments DO reach the real handler.
 * What that cannot show is the handler's own arity, because `cb` lives in a
 * closure. But a passive listener on the same event sees every call anyone
 * makes, including Vortex's own, and the argument shapes of a real install
 * are the signature, observed instead of assumed.
 *
 * Records types and lengths, never contents: an archive path is a filesystem
 * path from the user's machine and has no business in a log.
 */
/**
 * How many times each (event, argc, shape) has been seen this session, so the
 * summary can report what the per-call lines no longer do.
 */
const shapeCounts = new Map<string, number>();

/**
 * Report every call shape observed, once, at the end of a run.
 *
 * Without this the de-duplication above would LOSE information — a shape seen
 * 1,649 times and one seen twice would look identical, and "how many installs
 * went through the choices-carrying call?" is a real question.
 */
export function logInstallCallShapes(): void {
  if (shapeCounts.size === 0) return;
  ehLog("info", "installer.api-call-shapes", {
    shapes: [...shapeCounts.entries()].map(([key, count]) => ({ key, count })),
  });
}

export function watchInstallCalls(api: types.IExtensionApi): void {
  for (const name of INSTALL_EVENTS) {
    try {
      api.events.on(name, (...args: unknown[]) => {
        /**
         * ─── ONE LINE PER SHAPE, NOT PER CALL ───────────────────────────
         * This was 23% of a real 1.3 MB tester log — 1,895 lines carrying no
         * mod name and collapsing to FOUR distinct shapes. It is a per-call
         * trace of a fact established once, and it crowded out the events
         * that actually answer questions.
         *
         * The shape is what we wanted to know: whether Vortex's untyped
         * events arrive as we assume. Seeing it once, with a count, proves
         * that; seeing it 1,895 times proves it 1,894 more times.
         */
        const shape = args.map(describeArg);
        const key = `${name}|${args.length}|${shape.join(",")}`;
        const seen = (shapeCounts.get(key) ?? 0) + 1;
        shapeCounts.set(key, seen);
        if (seen === 1) {
          ehLog("debug", "installer.api-call", {
            event: name,
            argc: args.length,
            shape,
            note: "first call of this shape; later ones are counted, not logged",
          });
        }
      });
    } catch {
      /* a listener we could not attach is not worth failing over */
    }
  }
}

/** What an argument IS, with nothing of what it contains. */
function describeArg(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (typeof value === "function") return `function/${value.length}`;
  if (Array.isArray(value)) return `array[${value.length}]`;
  if (typeof value === "object") {
    const keys = Object.keys(value as object).sort();
    // Keys are the point: an options bag containing `choices` is the answer.
    return `object{${keys.slice(0, 12).join(",")}}`;
  }
  if (typeof value === "string") return `string(len ${value.length})`;
  return typeof value;
}

/** Events worth knowing the shape of before we try to drive them. */
const INSTALL_EVENTS = [
  "start-install",
  "start-install-download",
  "install-dependencies",
] as const;

type EmitterLike = {
  listeners?: (event: string) => Array<(...args: unknown[]) => unknown>;
};

/**
 * Record the arity and parameter list of Vortex's install event handlers.
 *
 * Never throws: this is a diagnostic, and an extension that fails to load
 * because it was curious about an API is worse than an unanswered question.
 */
export function probeInstallerApi(api: types.IExtensionApi): void {
  try {
    const events = api.events as unknown as EmitterLike;
    if (typeof events?.listeners !== "function") {
      ehLog("debug", "installer.api-probe", { note: "events.listeners unavailable" });
      return;
    }
    for (const name of INSTALL_EVENTS) {
      const handlers = events.listeners(name) ?? [];
      ehLog("debug", "installer.api-probe", {
        event: name,
        listeners: handlers.length,
        // Arity plus the parameter list: between them they say whether a
        // choices argument exists and where it sits.
        signatures: handlers.map((h) => ({
          arity: h.length,
          head: describeParams(h),
          // Vortex wraps its handlers as `(...args) => ...`, so arity says
          // nothing. The wrapper BODY is the last thing that can: it usually
          // names the function it forwards to, and how many arguments it
          // passes on.
          body: describeBody(h),
        })),
      });
    }
  } catch (err) {
    ehLog("debug", "installer.api-probe", { failed: String(err) });
  }
}

/**
 * The parameter list of a function, as written.
 *
 * Bundled and minified code keeps parameter POSITIONS even when it renames
 * them, so an arity of 3 with a middle argument is the answer even if that
 * argument is called `n`.
 */
function describeParams(fn: (...args: unknown[]) => unknown): string {
  let src: string;
  try {
    src = Function.prototype.toString.call(fn);
  } catch {
    return "<unreadable>";
  }
  const open = src.indexOf("(");
  const close = src.indexOf(")", open);
  const params = open >= 0 && close > open ? src.slice(open + 1, close) : "";
  return params.replace(/\s+/g, " ").slice(0, 200);
}

/**
 * The opening of a function's body.
 *
 * A `(...args)` wrapper hides the real signature behind it, but what it does
 * with those args — forwards them whole, destructures a fixed number, names an
 * inner handler — is the evidence that survives minification.
 */
function describeBody(fn: (...args: unknown[]) => unknown): string {
  let src: string;
  try {
    src = Function.prototype.toString.call(fn);
  } catch {
    return "<unreadable>";
  }
  return src.replace(/\s+/g, " ").slice(0, 400);
}
