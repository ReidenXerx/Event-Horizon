/**
 * Files that cannot be verified because nothing installs them.
 *
 * ─── THE PROBLEM ───────────────────────────────────────────────────────────
 * Verification asks "are the bytes in this mod's staging folder the bytes the
 * curator had?". For almost every file that is a fair question. For a handful
 * it is not: the game writes them at runtime, or Windows Explorer writes them
 * when someone opens the folder. Their contents depend on how long the curator
 * played, not on what they installed, so they differ on EVERY machine and can
 * never be made to match by reinstalling.
 *
 * A real 1755-mod install showed the cost. `SKSE/Plugins/BugFixesSSE.log` was
 * 460 bytes for the curator and 462 for the user — two bytes of a log the SKSE
 * plugin appends to when Skyrim starts. That one difference failed the mod's
 * verification, which sent it to the repair path, which correctly declined to
 * touch a mod the journal did not record installing (NS-2) and reported it as
 * unrepairable. Seven mods were flagged that way, all healthy, all for the
 * same reason.
 *
 * ─── WHY THIS LIST IS SHORT ────────────────────────────────────────────────
 * NS-1 makes precision the goal, and every exclusion is verification given up.
 * So the list was not guessed from what sounds volatile — it was read off a
 * real 354,819-file capture, and two obvious-looking guesses were WRONG:
 *
 *  - `.bak` and `.old` are SHIPPED CONTENT. That capture had 18 `.bak` files
 *    including `00000D63.NIF.bak` and `settings.ini.bak`, and one `.old`
 *    under DynamicStringDistributor — all authored by mod makers, all things a
 *    user should get byte-for-byte.
 *  - `.0` `.1` `.2` `.3` are not rotated logs. Nemesis ships nine of them
 *    under `Nemesis_Engine/Lib/test/` — OpenSSL CA hash files and cfgparser
 *    fixtures. Excluding numbered extensions would have stopped verifying
 *    real content in a mod whose correctness matters a great deal.
 *
 * What survived is only what the CURATOR'S MACHINE, not the mod author,
 * produced.
 *
 * ─── WHY IT IS NOT PER-GAME ────────────────────────────────────────────────
 * The rules are shaped by the runtime and the OS, not by the title: SKSE and
 * F4SE plugins both write `.log` beside themselves, and Windows writes
 * `Thumbs.db` into any folder with images whether it belongs to Skyrim or
 * Fallout 4. A per-game path list would need maintaining per game and would
 * still have missed `textures/aatj/armor/debug.log`, which is a runtime log
 * nowhere near `SKSE/Plugins/`. One rule that holds for every supported game
 * is both shorter and more complete than four that do not.
 *
 * ─── BOTH SIDES, AND OLD PACKAGES ──────────────────────────────────────────
 * Used by the BUILD, so new packages never record these, and by VERIFY, so
 * packages already in testers' hands stop reporting them. That second half is
 * what makes this fix land without a repack.
 */

import { basenameOf } from "./paths";

/**
 * Why a path was excluded. Carried into the log so an exclusion is visible
 * rather than a silent hole in what was checked.
 */
export type VolatileReason =
  /** A log the game, a script extender, or an SKSE/F4SE plugin appends to. */
  | "runtime-log"
  /** Windows Explorer's thumbnail cache. */
  | "windows-thumbnail-cache"
  /** Windows folder-view metadata. */
  | "windows-folder-metadata"
  /** macOS Finder metadata, which reaches Windows inside archives. */
  | "macos-finder-metadata"
  /**
   * Event Horizon's own case-detection probe.
   *
   * `detectCaseSensitivity` writes one of these into the directory it is
   * asking about and removes it immediately — but the removal can fail (a
   * filter driver holding the handle), and a curator who rebuilt afterwards
   * would capture it into the manifest and ship a file no archive can ever
   * produce, giving every user a permanent `missingFiles` entry.
   */
  | "eh-case-probe";

/** Filenames that are written by the OS, never by a mod. Compared lowercased. */
const OS_ARTIFACTS: ReadonlyMap<string, VolatileReason> = new Map([
  ["thumbs.db", "windows-thumbnail-cache"],
  ["ehthumbs.db", "windows-thumbnail-cache"],
  ["desktop.ini", "windows-folder-metadata"],
  [".ds_store", "macos-finder-metadata"],
]);

/**
 * Why this path cannot be verified, or `undefined` when it can.
 *
 * `relPath` is relative to the mod's staging root, with either separator.
 */
/** Ours, by construction, and never content. See `eh-case-probe`. */
const EH_PROBE = /^ehcaseprobe-[a-z0-9]+\.tmp$/;

export function volatileReason(relPath: string): VolatileReason | undefined {
  // Separator-agnostic: staging paths arrive with "/" from the manifest and
  // "\" from a Windows walk, and a rule that only matches one of them is a
  // rule that works on the build side and not the install side.
  /**
   * Lowercased UNCONDITIONALLY, unlike a path comparison.
   *
   * This is name recognition, not identity: `THUMBS.DB` on a case-sensitive
   * filesystem is a different file from `Thumbs.db`, and it is still Windows
   * Explorer's thumbnail cache. The question here is "what KIND of file is
   * this", which has the same answer on every platform.
   */
  const name = basenameOf(relPath).toLowerCase();
  if (name.length === 0) return undefined;

  const osArtifact = OS_ARTIFACTS.get(name);
  if (osArtifact !== undefined) return osArtifact;

  /**
   * `.log` ANYWHERE, not only under `SKSE/Plugins`.
   *
   * The scope is deliberate and it is the one place this list is broad. A
   * `.log` inside a mod's staging folder is written by something that ran, and
   * a mod author shipping documentation does not name it `.log` — they name it
   * `readme.txt`. Against the real capture this excluded 7 files out of
   * 354,819, every one of them a runtime log.
   */
  if (name.endsWith(".log")) return "runtime-log";

  if (EH_PROBE.test(name)) return "eh-case-probe";

  return undefined;
}

/** True when this path is written by the runtime or the OS, not by a mod. */
export function isVolatileFile(relPath: string): boolean {
  return volatileReason(relPath) !== undefined;
}
