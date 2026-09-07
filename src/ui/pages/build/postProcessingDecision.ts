/**
 * ──────────────────────────────────────────────────────────────────────
 * "Your staging has files this mod's archive cannot produce. Now what?"
 *
 * The build finds these; this module decides what the curator is actually
 * being asked, and what each answer does.
 *
 * ─── THE QUESTION IS NOT "WAS THIS DELIBERATE" ─────────────────────────
 * That was the first framing and it is the wrong one, because "yes, I ran
 * xLODGen" is true for almost every case here and answering it changes
 * nothing useful. The question that decides the outcome is:
 *
 *     DO THE PEOPLE INSTALLING THIS COLLECTION NEED THOSE FILES?
 *
 * Both answers are common and they have opposite fixes:
 *
 *   - No  → generator output, a repacked BA2, a cleaned plugin. Machine-local
 *           work. Declare it, and users install the archive without them.
 *   - Yes → a patch dropped into the folder, an edit the setup depends on.
 *           Declaring would make users silently go without it. Ship the bytes.
 *
 * ─── WHY THIS MATTERS MORE THAN IT LOOKS ───────────────────────────────
 * A curator clicking "declare" down the whole list without reading is not
 * being lazily harmless. They are promising users a collection that
 * reproduces their game while quietly withholding the parts they added — and
 * it will not fail, or warn, or show up in a diff. It reproduces perfectly
 * except for the files that made the setup theirs.
 *
 * So the UI shows the actual paths, offers no bulk action, and starts every
 * mod undecided. The cost of that is a curator reading six file names per
 * mod. The cost of the alternative is silent, permanent and shipped.
 * ──────────────────────────────────────────────────────────────────────
 */

import type { ExternalModConfigEntry } from "../../../core/manifest/collectionConfig";

export type PostProcessingChoice =
  /**
   * Reproduce this mod's staging folder on the user's machine exactly.
   *
   * The mod still installs from its own Nexus archive; afterwards the
   * differences are reconciled from bytes carried in the package. Right for
   * almost everything, which is why it is offered first.
   */
  | "mirror"
  /** The files are the curator's own. Users install the archive without them. */
  | "declare"
  /**
   * Leave this mod out of the collection.
   *
   * The one answer that is not about HOW to ship the mod. Offered because
   * some mods should not be shipped at all: a mod whose entire staging folder
   * is files its archive cannot produce ships nothing a user can obtain, and
   * the other three answers would all faithfully deliver that nothing.
   *
   * Nothing is removed from the curator's own Vortex.
   */
  | "drop"
  /** The files matter. Pack the staging folder and ship it. */
  | "bundle";

/**
 * The config override each answer writes.
 *
 * `bundle` sets `treatAsExternal` too when the mod came from Nexus. Bundling
 * is gated on a mod shipping as external (`shipsAsExternal`), and a Nexus mod
 * is not external until that flag says so — setting `bundled` alone would be
 * a decision the build then silently ignores, which is the failure mode this
 * whole area already had once.
 */
export function overrideForChoice(
  choice: PostProcessingChoice,
  opts: {
    isNexusMod: boolean;
    /**
     * The diverged files being answered about.
     *
     * Stored with the answer so the question reopens when they change. An
     * answer with no fingerprint is still an answer — it simply never
     * reopens, which is what entries written before this existed do.
     */
    fingerprint?: string;
  },
): Partial<ExternalModConfigEntry> {
  const about =
    opts.fingerprint === undefined
      ? {}
      : { postProcessingDecidedFor: opts.fingerprint };
  /**
   * ─── THE THREE FLAGS ARE ONE ANSWER, SO EACH CLEARS THE OTHERS ──────
   * These patches used to be purely additive, which was harmless while an
   * answer could only be given once. Adding a "Change" button made it wrong:
   * `recordPostProcessingDecision` MERGES, and `choiceFromEntry` reads the
   * flags by precedence (bundle > mirror > declare) — so answering "declare"
   * on a mod already carrying `mirrored: true` left mirroring in place and
   * the verdict still read as mirror.
   *
   * The package then shipped the entire staging folder the curator had just
   * declined, and because the fingerprint WAS updated the question never
   * reopened. A silent, permanent override of an explicit decision.
   *
   * `treatAsExternal` is deliberately NOT cleared here: it also means "this
   * Nexus mod's file is gone, ship it as external", which the build form sets
   * independently of anything decided on this screen. Clearing it would undo
   * that. Bundling still sets it, and un-bundling leaves it — see the note in
   * the build engine about restoring identity for a dropped bundle.
   */
  const exclusive = {
    mirrored: choice === "mirror",
    postProcessed: choice === "declare",
    bundled: choice === "bundle",
    dropped: choice === "drop",
  };
  if (choice === "drop") {
    // Nothing else applies: the mod is not being shipped, so how it would
    // have been shipped is not a question any more. Clearing the others also
    // means un-dropping it later returns it to an unanswered state rather
    // than to a stale decision made about different files.
    return { ...exclusive, ...about };
  }
  if (choice === "mirror") {
    // Deliberately NOT treatAsExternal. A mirrored mod is a normal Nexus mod
    // that gets corrected after install — flagging it external would stop the
    // archive being downloaded at all, which is the one thing this choice
    // exists to preserve.
    return { ...exclusive, ...about };
  }
  if (choice === "declare") {
    return { ...exclusive, ...about };
  }
  return {
    ...exclusive,
    ...(opts.isNexusMod ? { treatAsExternal: true } : {}),
    ...about,
  };
}

export type ChoiceCopy = {
  label: string;
  /** What happens to the people installing this. Never what happens to a flag. */
  consequence: string;
};

/**
 * The wording IS the feature here, so it is tested like one.
 *
 * Both options are phrased from the INSTALLER's side. "Mark as post-processed"
 * describes a checkbox; "users install this mod without those files" describes
 * what the curator is about to do to someone, which is the thing they are
 * qualified to have an opinion about.
 */
/**
 * What actually happens to the user, which depends on something the old copy
 * ignored.
 *
 * "Users install this mod without your N files" is true of a file the archive
 * does not have. It is FALSE of a file the archive does have and the curator
 * edited: the user is not missing that file, they receive the archive's copy
 * of it — an uncleaned plugin, an unrepacked BA2. Measured on a real 1894-mod
 * profile, the second case is thousands of files, so the sentence was wrong
 * more often than it was right.
 */
function declareOutcome(
  n: string,
  kinds: { added: number; changed: number } | undefined,
  fileCount: number,
): string {
  if (kinds === undefined || (kinds.added > 0 && kinds.changed > 0)) {
    return (
      `Users install this mod from its archive. They go without the files ` +
      `you added, and receive the archive's version of the ones you changed ` +
      `— not your ${n}.`
    );
  }
  if (kinds.changed === 0) {
    return `Users install this mod from its archive, without your ${n}.`;
  }
  return (
    `Users install this mod from its archive and get ITS version of ` +
    `${fileCount === 1 ? "that file" : "those files"}, not your ${n}.`
  );
}

export function describeChoice(
  choice: PostProcessingChoice,
  fileCount: number,
  /**
   * How those files split. Omit only where the split is genuinely unknown —
   * the copy is then written to stay true either way.
   */
  kinds?: { added: number; changed: number },
): ChoiceCopy {
  const n = `${fileCount} file${fileCount === 1 ? "" : "s"}`;
  if (choice === "mirror") {
    return {
      label: "Reproduce my version — users get exactly this",
      // Says the cost out loud. The package carries this mod's files so it
      // can do the replacing, which makes mirroring HEAVIER than bundling,
      // not lighter — the thing it buys is that the mod stays a real Nexus
      // mod: the author keeps the download, and updates and rules still work
      // on it. An earlier draft claimed "only the differences ride in the
      // package", which described a narrowing the build does not do.
      consequence:
        `Users still download this mod from Nexus, then the collection puts ` +
        `your version of the ${n} in place — their folder ends up identical ` +
        `to yours. Right when the archive has the file and you changed it: a ` +
        `plugin you cleaned, an ini you edited. The package carries this ` +
        `mod's files to do that, so the download is bigger.`,
    };
  }
  if (choice === "declare") {
    return {
      label: "These files are mine — users don't need them",
      // ─── THE EXAMPLES HERE WERE WRONG, AND WRONG IN THE COSTLY ──────
      // It used to offer "xLODGen or DynDOLOD output" and "a plugin you
      // cleaned" as the cases for declaring. Both are the opposite: LOD
      // output is generated from the curator's EXACT mod list and load
      // order, nobody installing the collection can regenerate it, and
      // declaring it ships a world with no LODs. A cleaned plugin declared
      // means users get the dirty one back. The failure is silent in both
      // cases — nothing fails, nothing warns, the setup is just quietly not
      // the one that was promised.
      //
      // What actually belongs here is only what a user is NO WORSE OFF
      // without, so the test is stated that way rather than as a list.
      consequence:
        `${declareOutcome(n, kinds, fileCount)} Right only when they are no ` +
        `worse off for it — a tool's logs or .bak backups, a cache, an ini ` +
        `tuned to your hardware. NOT for LOD output or a cleaned plugin: ` +
        `nobody can regenerate those, and users would silently go without.`,
    };
  }
  if (choice === "drop") {
    return {
      label: "Leave this mod out of the collection",
      /**
       * Says what it does NOT do, first. "Drop" next to three buttons that
       * ship files reads like deletion, and a curator hesitating over whether
       * they are about to lose a mod will pick one of the other three
       * instead — which is how the mod that broke a tester's install got
       * answered "declare".
       */
      consequence:
        `Removes it from the collection only — your own Vortex is untouched ` +
        `and you keep the mod. Right when there is nothing worth shipping: a ` +
        `staging folder that holds only a placeholder or a leftover, or a ` +
        `mod you no longer want in this build. Users never see it, and it ` +
        `cannot ask them anything.`,
    };
  }
  return {
    label: "These files matter — ship my copy",
    consequence:
      `Packs your whole staging folder into the collection so users get the ` +
      `${n} too. Right for xLODGen or DynDOLOD output — generated from YOUR ` +
      `exact mod list, so nobody can reproduce it — or a patch you dropped ` +
      `in. Makes the download bigger by the size of the folder. It also ` +
      `means no installer runs on the user's machine, which is the answer ` +
      `for a mod whose FOMOD questions cannot be replayed.`,
  };
}

/**
 * The heading a curator reads before answering anything.
 *
 * Says what was found, in terms of a fact about their disk rather than a
 * verdict, then states the actual question. A curator who reads only this
 * should already know that the two answers are not interchangeable.
 */
export function describeDecisionIntro(modCount: number): {
  title: string;
  what: string;
  question: string;
  ifIgnored: string;
  caution: string;
} {
  const mods = `${modCount} mod${modCount === 1 ? "" : "s"}`;
  return {
    title: `${mods} need${modCount === 1 ? "s" : ""} a decision`,
    // Two shapes, and the difference decides what declaring costs. The first
    // version of this said the archives "do not contain" these files, which
    // is only true of the ones the curator ADDED — for a file they edited the
    // archive has it, and the user receives that copy rather than nothing.
    what:
      `Their staging folders differ from the archives they came from — files ` +
      `you added, which users would never get, and files you changed, where ` +
      `users would get the archive's version instead of yours.`,
    question: "Do the people installing this collection need them?",
    ifIgnored:
      `Leaving one undecided is not neutral: the file is recorded as ` +
      `required, every user fails the integrity check, the mod is ` +
      `reinstalled once, fails identically, and is recorded as broken.`,
    // The line that exists because the cheap answer is one click and always
    // available.
    caution:
      `Answer these one at a time, and look at the file names. Marking them ` +
      `all as yours is quick and it is the one outcome worse than ignoring ` +
      `them: your collection would install cleanly for everyone while ` +
      `silently leaving out the files you added.`,
  };
}
