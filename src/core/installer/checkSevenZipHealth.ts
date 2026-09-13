/**
 * ──────────────────────────────────────────────────────────────────────
 * Does VORTEX's archive extractor work on this machine?
 *
 * Event Horizon no longer needs 7z to read a `.ehcoll` — that is a ZIP of
 * our own format and we parse it directly. But the files INSIDE a package
 * are mod archives, and they can be `.7z` or `.rar`. Unpacking those is
 * Vortex's installer's job, through Vortex's own bundled 7z. That
 * dependency is real, it is not ours to remove, and on a Wine/Proton
 * prefix it is the thing most likely to be broken.
 *
 * Which is why this exists. Without it the user finds out the way our
 * alpha tester did: pick a collection, wait, and get an error that names
 * neither the cause nor the fix. With it they find out in about a second,
 * before anything has been installed, and are told what to run.
 *
 * ─── WHY NOT JUST LET IT FAIL LATER ────────────────────────────────────
 * Because a 954-mod install that dies on mod 1 has still changed the
 * user's Vortex state, and because "couldn't extract" forty minutes in
 * reads as "your collection is broken" rather than "your prefix is
 * missing a runtime". The cost of being wrong in that direction is a
 * curator debugging a package that was never at fault.
 *
 * ─── DISCIPLINE ────────────────────────────────────────────────────────
 * This NEVER throws and NEVER blocks. It is a warning, not a gate: a
 * preflight that wrongly refuses to start is worse than the failure it
 * was guarding against, because there is no way past it. If the check
 * itself breaks, the install proceeds exactly as it would have.
 * ──────────────────────────────────────────────────────────────────────
 */

import {
  resolveSevenZip,
  sevenZipSelfTest,
  type SevenZipApi,
} from "../manifest/sevenZip";
import { looksLikeWine } from "../proton";

export type SevenZipHealth =
  /** 7z built an archive and read it back. Vortex can install mods. */
  | { kind: "ok" }
  /** Vortex did not expose SevenZip at all — we never got a handle to test. */
  | { kind: "unavailable"; why: string }
  /** 7z is there and cannot do its job. This is the Proton case. */
  | { kind: "broken"; why: string; fatal: boolean }
  /**
   * The check itself failed, which says nothing about 7z either way.
   *
   * Not reachable through `sevenZipSelfTest` as it stands — it catches its
   * own errors and reports `{ok:false}`. This exists so that "never throws"
   * stays true if that contract ever changes, not because it is an expected
   * state, and it is deliberately worded as "could not verify" rather than
   * as a fault.
   */
  | { kind: "indeterminate"; why: string };

/**
 * Run the round-trip test against Vortex's own 7z.
 *
 * `sevenZipSelfTest` builds a small archive and reads it back, which is the
 * only thing that separates "7z is broken" from "that file is broken" —
 * node-7z's `list` resolves with an empty spec either way and discards
 * `{code, errors}`, so a failed listing on its own proves nothing.
 */
export async function checkSevenZipHealth(
  sevenZip?: SevenZipApi,
): Promise<SevenZipHealth> {
  let api: SevenZipApi;
  try {
    api = sevenZip ?? resolveSevenZip();
  } catch (err) {
    // resolveSevenZip throws when util.SevenZip is absent. That is a real
    // finding about Vortex, not a failure of this check.
    return {
      kind: "unavailable",
      why: err instanceof Error ? err.message : String(err),
    };
  }

  try {
    const health = await sevenZipSelfTest(api);
    if (health.ok) return { kind: "ok" };
    // fatal === false means extraction works and only listing is broken, which
    // is survivable: every listing path of ours is native-first. Only a failed
    // EXTRACT means no mod can be installed.
    return { kind: "broken", why: health.why, fatal: health.fatal };
  } catch (err) {
    return {
      kind: "indeterminate",
      why: err instanceof Error ? err.message : String(err),
    };
  }
}


export type SevenZipAdvice = {
  /** One line, for a notification. */
  message: string;
  /** What to actually do, most likely first. */
  steps: string[];
};

/**
 * What to tell the user, in their situation.
 *
 * `undefined` when 7z is healthy — there is nothing to say, and a preflight
 * that announces success trains people to dismiss it without reading.
 */
export function describeSevenZipHealth(
  health: SevenZipHealth,
  onWine = looksLikeWine(),
): SevenZipAdvice | undefined {
  if (health.kind === "ok") return undefined;

  if (health.kind === "indeterminate") {
    // Deliberately not alarming: we do not know that anything is wrong.
    return {
      message:
        "Could not verify that Vortex's archive extractor works. The install " +
        "will continue; if mods fail to extract, this is the first thing to check.",
      steps: [`The check itself failed with: ${health.why}`],
    };
  }

  const problem =
    health.kind === "unavailable"
      ? "Vortex did not provide its archive extractor (7-Zip)"
      : "Vortex's archive extractor (7-Zip) is not working";

  if (!onWine) {
    return {
      message:
        `${problem}. Event Horizon can read the collection, but Vortex will ` +
        `not be able to unpack mods until this is fixed.`,
      steps: [
        "Restart Vortex — the extractor is loaded at startup.",
        "If that does not help, reinstall Vortex; its 7-Zip ships with it.",
        `Detail: ${health.why}`,
      ],
    };
  }

  return {
    message:
      `${problem}, and this looks like a Wine/Proton prefix. Event Horizon ` +
      `can read the collection itself, but Vortex cannot unpack mod archives ` +
      `until this is fixed — every mod would fail to install.`,
    steps: [
      // Ordered by likelihood, not by effort. Vortex SHIPS 7z.exe and 7z.dll
      // inside its own app directory, so this is virtually never a missing
      // 7-Zip: it is a missing runtime that 7z.exe needs, or a Proton build
      // that cannot run it.
      // Order matters, and so does NOT leading with vcrun. If 7z managed to
      // create an archive, its process started and ran — which rules a missing
      // Visual C++ runtime out, because a missing DLL means the exe never
      // launches. Leading with vcrun2022 sent at least one tester after a
      // runtime that was already installed.
      "Run scripts/setup-proton.sh from the Event Horizon repo on the LINUX " +
        "side — it finds your Vortex prefix and sets up what Vortex needs.",
      "Try a different Proton version for the Vortex prefix first — Proton " +
        "Experimental and GE builds differ in what they can run, and this is " +
        "the most common cause when 7-Zip runs but misbehaves.",
      "If 7-Zip does not start at all (rather than starting and failing), " +
        "then a runtime IS missing: protontricks <appid> vcrun2022.",
      `Detail: ${health.why}`,
    ],
  };
}
