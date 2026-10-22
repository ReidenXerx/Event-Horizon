/**
 * ──────────────────────────────────────────────────────────────────────
 * Telling someone how to fetch a mod we cannot fetch for them.
 *
 * Vortex's own answer to a browse-website dependency is an embedded browser.
 * We deliberately do not do that. An in-app browser is signed out of every
 * site the user has an account on, handles a CAPTCHA or a Cloudflare check
 * badly or not at all, has no ad-blocker, no password manager, and no download
 * manager — so the one flow where a person most needs their own environment is
 * the one where they are given the worst version of it.
 *
 * So: open the link in THEIR browser, let them download it however they
 * normally would, and take the archive back as a file. From that point the
 * install is ours — including the curator's FOMOD choices, which the picked
 * file now replays (see adoptLocalArchive).
 *
 * ── Why the mode matters ──
 * `browse`, `direct` and `manual` are three different actions, and the
 * instruction has to match or it is worse than none:
 *
 *   browse  — a mod PAGE. "Find the right file on the page" is the work.
 *   direct  — a link straight to the file. Clicking it just downloads; telling
 *             someone to "find the file on the page" would send them looking
 *             for a page that never appears.
 *   manual  — no usable link. The curator's prose is all there is, and
 *             pretending otherwise wastes the reader's time.
 *
 * Absent mode is treated as `browse`: a link we inferred is far more likely to
 * be a page than a direct file, and "look for the file" degrades gracefully if
 * a download starts anyway, where the reverse does not.
 * ──────────────────────────────────────────────────────────────────────
 */

export type DownloadMode = "direct" | "browse" | "manual";

export type Guidance = {
  /** One line saying what pressing the button will do. */
  action: string;
  /** What to do after, in order. Empty when there is nothing to add. */
  steps: string[];
  /** Whether there is anything to open at all. */
  canOpen: boolean;
};

export function describeDownload(args: {
  url?: string;
  mode?: DownloadMode;
  expectedFilename?: string;
  /** The curator's note for this mod. The card shows it above these steps. */
  instructions?: string;
}): Guidance {
  // 2026-10-22: the card never showed the note, so a Tumblr page with two
  // downloads got the first one and a "NOT the file" warning. With a note on
  // screen, the steps defer to it instead of naming a file the page may not
  // call that way.
  const hasNote = args.instructions !== undefined && args.instructions.trim().length > 0;
  const named =
    args.expectedFilename !== undefined && args.expectedFilename.length > 0
      ? `"${args.expectedFilename}"`
      : "the file";

  if (args.url === undefined || args.url.length === 0) {
    return {
      action: "",
      canOpen: false,
      steps: [
        hasNote
          ? `This collection does not record a download link for this mod — the ` +
            `curator's note above is what there is to go on.`
          : `This collection records no download link or note for this mod — look ` +
            `it up by its name.`,
        `Once you have ${named}, pick it below and Event Horizon installs it ` +
          `the way the curator had it.`,
      ],
    };
  }

  // A link we have, but the curator says it is not one to follow blindly.
  if (args.mode === "manual") {
    return {
      action: "Open the link",
      canOpen: true,
      steps: [
        hasNote
          ? `The curator marked this one as needing a manual download — read ` +
            `their note above before following the link.`
          : `The curator marked this one as needing a manual download.`,
        `Download ${named}, then pick it below.`,
      ],
    };
  }

  if (args.mode === "direct") {
    return {
      action: "Start the download",
      canOpen: true,
      steps: [
        `This link goes straight to the file, so it opens in your browser and ` +
          `starts downloading — no page to search.`,
        `When it finishes, pick ${named} below.`,
      ],
    };
  }

  return {
    action: "Open the page",
    canOpen: true,
    steps: [
      `Opens in your own browser, signed in as you — not in a window inside ` +
        `Vortex.`,
      hasNote
        ? `Download the file the curator's note above names — a page can offer ` +
          `several, and only that one is right — then pick it below.`
        : `Download ${named} from the page, then pick it below.`,
      `Event Horizon takes it from there, including the installer options the ` +
        `curator chose.`,
    ],
  };
}
