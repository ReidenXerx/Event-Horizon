/**
 * ──────────────────────────────────────────────────────────────────────
 * Can this account actually download the mods this collection needs?
 *
 * Every `nexus-download` decision ends in `api.ext.nexusDownload(...)`, which
 * asks the Nexus API for a direct download link. Nexus only issues those to
 * **Premium** accounts. A free account is sent to the website to click the
 * download button by hand, one mod at a time.
 *
 * On the curator's machine that distinction is invisible — they are Premium,
 * the mods are already downloaded, and nothing in the build path touches the
 * download API at all. It only shows up on the person installing, which is
 * exactly the person we cannot watch.
 *
 * The real 954-mod collection is the case that matters: a free account facing
 * it does not hit a small inconvenience, it hits several hundred manual
 * browser downloads. That is worth knowing BEFORE pressing Install rather
 * than discovering it at mod 3 of 954.
 *
 * This does not block anything and does not change how any download is made.
 * It reads account status and says what it implies.
 *
 * ── On being wrong ──
 * `@nexusmods/vortex-api` ships types with NO runtime: `selectors.isPremium`
 * exists in `api.d.ts`, but whether it exists in the Vortex the user is
 * actually running cannot be checked from here. So every read is guarded and
 * the failure value is `unknown` — which warns about nothing. A false "you are
 * not Premium" on a Premium account would be a worse bug than staying quiet,
 * because it would teach the user to ignore this screen.
 * ──────────────────────────────────────────────────────────────────────
 */

import { selectors } from "@nexusmods/vortex-api";
import type { types } from "@nexusmods/vortex-api";

import type { InstallPlan } from "../../types/installPlan";
import { ehLog } from "../logging/ehLog";

export type NexusAccount =
  /** Premium: the API issues direct download links. Everything works. */
  | { kind: "premium" }
  /**
   * Logged in, not Premium. Downloads need a manual click per mod, which is
   * why Premium is a stated requirement rather than a recommendation.
   */
  | { kind: "free" }
  /** No Nexus login at all: `nexusDownload` has nothing to authenticate with. */
  | { kind: "logged-out" }
  /** Could not tell. Never warned about — see the header. */
  | { kind: "unknown"; why: string };

/**
 * How many mods this plan will actually fetch from Nexus.
 *
 * Deliberately NOT `summary.willInstallSilently`: that number also counts
 * bundled archives and local downloads, which need no network and no account.
 * Warning "412 downloads need Premium" when 400 of them are already on disk
 * would be the kind of inflated count that trains people to skip warnings.
 */
export function countNexusDownloads(plan: InstallPlan): number {
  return plan.modResolutions.filter((r) => r.decision.kind === "nexus-download")
    .length;
}

/**
 * Read Nexus account status from the running Vortex.
 *
 * Two independent sources, in order of authority:
 *
 *  1. `selectors.isLoggedIn` / `selectors.isPremium`. These are Vortex's own
 *     published accessors — the thing that DEFINES where this lives. They are
 *     tried first for that reason, not because they are more convenient.
 *  2. `state.persistent.nexus.userInfo`, which is where those selectors read
 *     from. This is our inference about Vortex's internals and could be wrong
 *     or could move, so it is the fallback rather than the source of truth.
 *
 * If both fail we say `unknown` rather than guessing a default — and "logged
 * out" is NOT the safe default, since telling a signed-in Premium user to go
 * and sign in would be a false alarm on the one screen that must stay
 * trustworthy.
 */
export function readNexusAccount(api: types.IExtensionApi): NexusAccount {
  let state: unknown;
  try {
    state = api.getState();
  } catch {
    return { kind: "unknown", why: "Vortex state could not be read" };
  }
  if (state === null || typeof state !== "object") {
    return { kind: "unknown", why: "Vortex state was not an object" };
  }

  const viaSelector = readViaSelectors(state);
  if (viaSelector !== undefined) return viaSelector;

  const info = readUserInfo(state);
  if (info === undefined) {
    // No user info recorded is what a logged-out Vortex looks like — but it
    // is also what an unfamiliar state shape looks like, and we cannot tell
    // those apart. Only treat it as logged out when the nexus slice is
    // present and simply has no user in it.
    return hasNexusSlice(state)
      ? { kind: "logged-out" }
      : { kind: "unknown", why: "no Nexus account information in state" };
  }

  if (typeof info.isPremium !== "boolean") {
    return { kind: "unknown", why: "account status was not recorded" };
  }
  return info.isPremium ? { kind: "premium" } : { kind: "free" };
}

/**
 * Ask Vortex's own selectors, if this build has them.
 *
 * `@nexusmods/vortex-api` is a types-only package — there is no runtime JS in
 * it, and the real module is supplied by the Vortex that loads the extension.
 * So the typings promising these selectors is not evidence that the running
 * app has them, and every access is guarded accordingly.
 *
 * Returns `undefined` for "these selectors could not answer", which is
 * distinct from an answer of `free` or `logged-out`, and lets the caller fall
 * through to reading state directly.
 */
function readViaSelectors(state: unknown): NexusAccount | undefined {
  const sel = selectors as unknown as {
    isLoggedIn?: (s: unknown) => unknown;
    isPremium?: (s: unknown) => unknown;
  };

  try {
    if (typeof sel.isLoggedIn === "function") {
      const loggedIn = sel.isLoggedIn(state);
      // Only a definite `false` is actionable. Anything else means the
      // selector did not really answer, and guessing from it would be worse
      // than falling through to the state read.
      if (loggedIn === false) return { kind: "logged-out" };
    }
    if (typeof sel.isPremium === "function") {
      const premium = sel.isPremium(state);
      if (typeof premium === "boolean") {
        return premium ? { kind: "premium" } : { kind: "free" };
      }
    }
  } catch {
    /* a selector that throws has told us nothing; fall through */
  }
  return undefined;
}

type UserInfo = { isPremium?: unknown };

/** `state.persistent.nexus.userInfo`, if it is there and is an object. */
function readUserInfo(state: unknown): UserInfo | undefined {
  const nexus = nexusSlice(state);
  if (nexus === undefined) return undefined;
  const info = (nexus as { userInfo?: unknown }).userInfo;
  if (info === null || typeof info !== "object") return undefined;
  return info as UserInfo;
}

function hasNexusSlice(state: unknown): boolean {
  return nexusSlice(state) !== undefined;
}

function nexusSlice(state: unknown): unknown {
  const persistent = (state as { persistent?: unknown }).persistent;
  if (persistent === null || typeof persistent !== "object") return undefined;
  const nexus = (persistent as { nexus?: unknown }).nexus;
  if (nexus === null || typeof nexus !== "object") return undefined;
  return nexus;
}

/**
 * What to tell the user.
 *
 * Premium is a stated REQUIREMENT of this extension, so the message says that
 * rather than describing the tedium and leaving them to infer it. But it is
 * still phrased as what will happen, not as a rule for its own sake: "Vortex
 * cannot fetch these on its own" is checkable and true, where "you must have
 * Premium" invites the reply "or what?".
 *
 * Nothing is said when there is nothing to download. Premium is not needed to
 * install archives already on disk, and a requirement notice on a collection
 * that needs no network would be a rule quoted at someone it does not apply
 * to — which is how a screen loses the reader before the warnings that matter.
 */
export function describeNexusAccount(
  account: NexusAccount,
  downloadCount: number,
): string[] {
  if (downloadCount === 0) return [];
  if (account.kind === "premium" || account.kind === "unknown") return [];

  const mods = `${downloadCount} mod${downloadCount === 1 ? "" : "s"}`;

  if (account.kind === "logged-out") {
    return [
      `You are not signed in to Nexus Mods, and ${mods} need to be ` +
        `downloaded from there. Sign in from Vortex's Nexus Mods page, then ` +
        `come back to this screen.`,
    ];
  }

  const lines = [
    `Nexus Premium is required to install this collection, and this account ` +
      `does not have it. Nexus only lets mod managers download files directly ` +
      `for Premium accounts, so Vortex cannot fetch the ${mods} this needs: each ` +
      `one fails with "Only available to premium users", and the install stops.`,
  ];
  if (downloadCount >= LOT) {
    lines.push(
      `With Premium (one month is enough) the whole install runs unattended, ` +
        `and a stopped install continues where it left off.`,
    );
  }
  return lines;
}

/**
 * Above this, "you will click a few times" stops being an honest description.
 * Chosen as the point where the clicking becomes the dominant cost of the
 * install rather than an annoyance during it.
 */
const LOT = 25;

/**
 * Log which source answered, once at startup.
 *
 * Everything above is written so that a wrong guess about Vortex's internals
 * degrades to `unknown` and says nothing. That is the right failure, but it is
 * also a SILENT one: if neither the selectors nor the state path work on the
 * machine actually installing, the warning simply never appears and nobody
 * finds out it was never going to.
 *
 * So record what happened. `kind` is the answer, and for `unknown`, `why` is
 * the reason it could not be reached — which is the difference between "this
 * user is Premium" and "this check has never worked".
 *
 * Deliberately records no account identity: not the email, username, profile
 * URL or user id that sit next to `isPremium` in the same object. Whether an
 * account is Premium is what this code needs; who it belongs to is not.
 */
export function probeNexusAccount(api: types.IExtensionApi): void {
  try {
    const account = readNexusAccount(api);
    ehLog("info", "nexus.account-probe", {
      kind: account.kind,
      ...(account.kind === "unknown" ? { why: account.why } : {}),
      selectorsPresent: describeSelectorAvailability(),
    });
  } catch {
    /* a probe that fails must not affect startup */
  }
}

/** Which of Vortex's account selectors this build actually exposes. */
function describeSelectorAvailability(): string {
  const sel = selectors as unknown as Record<string, unknown>;
  const present = ["isLoggedIn", "isPremium"].filter(
    (n) => typeof sel[n] === "function",
  );
  return present.length === 0 ? "none" : present.join(",");
}

/**
 * Whether the Nexus account is why downloads fail: a free account, or no
 * sign-in. Vortex's own "Only available to premium users" notification counts
 * too, for when its account state could not be read. Undefined when the
 * account is not the explanation.
 */
export function downloadAccountCause(api: types.IExtensionApi): "free" | "logged-out" | undefined {
  const account = readNexusAccount(api);
  if (account.kind === "free" || account.kind === "logged-out") return account.kind;
  try {
    const list = (api.getState() as { session?: { notifications?: { notifications?: unknown[] } } })?.session?.notifications
      ?.notifications;
    const saysPremium = (Array.isArray(list) ? list : []).some((n) => {
      const x = n as { message?: unknown; title?: unknown } | null;
      return /premium users/i.test(`${String(x?.title ?? "")} ${String(x?.message ?? "")}`);
    });
    if (saysPremium) return "free";
  } catch {
    // Unreadable state: the account is not shown to be the cause.
  }
  return undefined;
}
