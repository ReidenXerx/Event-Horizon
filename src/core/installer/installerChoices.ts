/**
 * Handing the curator's FOMOD answers back to Vortex.
 *
 * ## How the signature was established
 *
 * Vortex's events are untyped and `start-install-download` appears nowhere in
 * `api.d.ts`, so the shape could not be read from the package. It was observed
 * instead: a passive listener recorded Vortex's OWN calls during a real
 * install, and it passes
 *
 *   start-install-download(downloadId, { allowAutoEnable, choices }, cb)
 *
 * with `cb` of arity 2 — `(err, modId)`. That is the mechanism, watched rather
 * than guessed, which matters because the listener wrapper is a transparent
 * `(...args) => cb(...args)` shim: extra arguments are forwarded silently, so
 * a wrong guess would install every mod with default options while appearing
 * to replay the curator's.
 *
 * ## What gets sent
 *
 * `IChoiceType` is `{ type, options }`. `options` is the recorded selection
 * tree; `type` says which installer's answer format it is. Both come from the
 * manifest — see `installerChoicesType`, captured for exactly this.
 */

import type { FomodSelectionStep } from "../getModsListForProfile";
import type { EhcollMod } from "../../types/ehcoll";
import type { FomodReplayMode } from "./fomodReplayMode";
import { DEFAULT_FOMOD_REPLAY_MODE, isUnattended } from "./fomodReplayMode";

/** Vortex's `IChoiceType`, as its installer expects it. */
export type VortexInstallerChoices = {
  type: string;
  options: FomodSelectionStep[];
};

/**
 * Fallback for manifests built before `installerChoicesType` was captured.
 *
 * Every recorded selection in the wild came from Vortex's FOMOD installer —
 * that is the only installer that asks questions — so this is the right guess
 * for old packages. New ones carry the real value and never reach it.
 */
const LEGACY_CHOICE_TYPE = "fomod";

/**
 * The choices to replay for a mod, or `undefined` when there are none.
 *
 * Returning `undefined` is load-bearing: the caller then makes the exact call
 * it made before this feature existed. A mod with nothing recorded must not
 * take a different code path just because replay is now possible.
 */
export function choicesFor(entry: EhcollMod | undefined): VortexInstallerChoices | undefined {
  const selections = entry?.install?.fomodSelections ?? [];

  /**
   * ─── NO STEPS AT ALL IS THE ONLY "NO ANSWER" ────────────────────────
   * This is the whole distinction, and it used to be drawn one level too
   * deep.
   *
   * An EMPTY `fomodSelections` means the build never observed an installer
   * for this mod — there is genuinely nothing to replay, and the caller must
   * make the same call it made before replay existed.
   *
   * Steps PRESENT with every `choices` array empty is a different thing
   * entirely: the build watched the curator go through the installer and
   * recorded what they did, which was tick nothing and press Finish. That is
   * an answer. FOMOD groups are frequently optional — `SelectAny`,
   * `SelectAtMostOne` — and "none of these" is a perfectly ordinary way to
   * install a mod.
   *
   * The old code rejected that case with the reasoning that sending it "would
   * claim the curator made a choice they did not make". It is the opposite:
   * sending a step whose groups are empty claims exactly what happened, that
   * no option was picked. What actually claimed something false was
   * DISCARDING it, because the installer then had no answer, ran attended,
   * and asked the player a question the curator had already answered.
   *
   * Six mods on the reference profile behave this way — iWant Status Bars,
   * iWant Widgets, Rock Traps Trigger Fixes and others — and a tester who had
   * chosen "install automatically" was stopped by a dialog for each.
   *
   * Worst case this is no worse than before: if Vortex decides it cannot run
   * a given selection unattended it falls back to asking, which is precisely
   * what happened without it.
   */
  if (selections.length === 0) {
    /**
     * ─── UNLESS THE BUILD PROVED NOTHING WAS PICKED ────────────────────
     * The docblock above says an empty list means "the build never observed
     * an installer for this mod". That is true of the 1,454 mods in a real
     * collection that simply have no FOMOD — and FALSE for the handful that
     * have one whose answers Vortex did not keep. A tester's install stopped
     * dead on one of those: a dialog with nothing to replay, and answering it
     * the way the curator had made Vortex fail outright.
     *
     * `emptySelectionVerified` is the build having replayed the installer
     * with NO choices and confirmed that reproduces the curator's staging
     * exactly. That makes "they picked nothing" a measurement, so it can be
     * replayed like any other answer — an empty options list, unattended.
     *
     * Vortex accepts it: its installer needs `choices !== undefined` and
     * `choices.type === "fomod"` to run unattended, and says nothing about
     * the options being non-empty.
     */
    if (entry?.install?.emptySelectionVerified === true) {
      return {
        type: entry.install.installerChoicesType ?? LEGACY_CHOICE_TYPE,
        options: [],
      };
    }
    return undefined;
  }

  return {
    type: entry?.install?.installerChoicesType ?? LEGACY_CHOICE_TYPE,
    options: selections,
  };
}

/**
 * The options bag for `start-install-download`.
 *
 * `allowAutoEnable: true` matches what the path this replaces did: installing
 * through `nexusDownload(..., allowInstall = true)` let Vortex enable the mod
 * as it normally would. The driver sets enablement itself afterwards from the
 * manifest, so this decides only the moment in between.
 */
/**
 * Should the curator's answers be applied WITHOUT showing the FOMOD dialog?
 *
 * Read out of the shipped Vortex bundle rather than guessed. Its installer:
 *
 *     const canBeUnattended =
 *       choices !== undefined && choices.type === "fomod";
 *     const shouldBypassDialog = canBeUnattended && unattended === true;
 *
 * and the install manager forwards `options.unattended` from the very option
 * bag we pass to `start-install-download`. So all three conditions are ours to
 * satisfy — we already supply `choices` with `type: "fomod"`.
 *
 * (The comment directly above that code says the dialog is bypassed
 * "regardless of unattended flag". It is not; the line beneath it requires
 * `unattended === true`. Trust the code.)
 *
 * ─── THIS IS THE USER'S CALL, NOT OURS ─────────────────────────────────
 * It was briefly a constant here. It is not one any more: both answers are
 * right for different people, and the user is asked once before the install
 * starts — see `fomodReplayMode.ts` for the wording and for the consequence
 * that makes the question worth asking at all.
 *
 * The default below is only what happens when nobody chose, which in practice
 * means a caller that predates the question.
 */
export function installOptions(
  choices: VortexInstallerChoices,
  unattended: boolean = isUnattended(DEFAULT_FOMOD_REPLAY_MODE),
): {
  allowAutoEnable: boolean;
  choices: VortexInstallerChoices;
  unattended: boolean;
} {
  return { allowAutoEnable: true, choices, unattended };
}

/**
 * The replay half of an install call's arguments: the curator's answers, and
 * whether to apply them silently.
 *
 * Exists because the six install call sites in `runInstall` each spelled the
 * same conditional spread out by hand, and threading a second field through
 * would have meant six more chances to thread it through only five. Both
 * fields are omitted together when there is nothing to replay, which keeps the
 * no-choices path byte-identical to what it was before replay existed —
 * `exactOptionalPropertyTypes` makes that distinction real rather than
 * cosmetic.
 */
export function replayArgs(
  entry: EhcollMod | undefined,
  mode: FomodReplayMode = DEFAULT_FOMOD_REPLAY_MODE,
): { choices?: VortexInstallerChoices; unattended?: boolean } {
  const choices = choicesFor(entry);
  if (choices === undefined) return {};
  return { choices, unattended: isUnattended(mode) };
}
