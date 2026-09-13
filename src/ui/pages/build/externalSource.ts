/**
 * ──────────────────────────────────────────────────────────────────────
 * How does the user get this mod?
 *
 * Mirrors Vortex's own three download modes and adds the one thing Vortex
 * cannot do for a non-Nexus file — ship the bytes:
 *
 *   bundled  — the mod's files travel inside the `.ehcoll`. Nothing to fetch.
 *   direct   — the link IS the file. Opening it starts a download.
 *   browse   — the link is a mod PAGE. Find the file on it, then download.
 *   manual   — no usable link. The curator's prose is the whole instruction.
 *
 * The distinction between `direct` and `browse` is not cosmetic: the user-side
 * screen tells someone to "find the file on the page" or that the link "starts
 * downloading", and getting that backwards sends them hunting a page that
 * never appears, or waiting on a download that never starts. Vortex models
 * these separately for the same reason, and a collection that flattened them
 * would be losing information the curator already has.
 *
 * ── Why this is a derived view, not a stored field ──
 * The config stores `bundled` (boolean) and `mode` independently, because they
 * answer different questions and `bundled` predates `mode`. This collapses
 * them into the single choice a curator actually makes, and expands that
 * choice back into both fields. Storing the collapsed value instead would
 * make every existing config unreadable.
 * ──────────────────────────────────────────────────────────────────────
 */

export type ExternalSourceKind = "bundled" | "direct" | "browse" | "manual";

export type SourceFields = {
  bundled?: boolean;
  mode?: "direct" | "browse" | "manual";
  url?: string;
};

/**
 * Which of the four a stored entry represents.
 *
 * `bundled` wins over any mode: the bytes ship, so nothing is downloaded and
 * whatever mode is recorded describes a fetch that will not happen.
 *
 * With no mode recorded, a URL means `browse` and no URL means `manual`. That
 * is the same default the user-side guidance uses, and it errs the safe way:
 * "look for the file on the page" still reads sensibly if a download starts
 * on its own, where "this starts downloading" does not survive landing on a
 * page.
 */
export function sourceKindOf(entry: SourceFields): ExternalSourceKind {
  if (entry.bundled === true) return "bundled";
  if (entry.mode !== undefined) return entry.mode;
  return hasText(entry.url) ? "browse" : "manual";
}

/**
 * The config patch for choosing `kind`.
 *
 * `bundled` is always written explicitly rather than left undefined, because
 * an absent boolean and a false one read the same to this code but not to the
 * rest of the config — and a curator switching away from Bundled must actually
 * switch away from it.
 *
 * The URL is never cleared. Someone toggling to Bundled and back should find
 * the link they typed still there; deleting a curator's typing on a mode
 * change is the kind of small betrayal that makes a form feel unsafe.
 */
export function sourcePatch(kind: ExternalSourceKind): SourceFields {
  if (kind === "bundled") return { bundled: true };
  return { bundled: false, mode: kind };
}

/**
 * What is wrong with this combination, in the curator's terms.
 *
 * The case worth catching: `direct` or `browse` with no link. The user-side
 * screen for those says "open the page" and there is no page — so the mod
 * arrives with a button that cannot exist and instructions that assume it
 * does. `manual` with no link is fine; that is what manual means.
 */
export function sourceProblem(
  entry: SourceFields,
  opts: { hasStagingFolder: boolean },
): string | undefined {
  const kind = sourceKindOf(entry);

  // Bundling does NOT need the original download. `repackBundledExternals`
  // measures the mod's STAGING folder and re-keys the mod to the bundle's
  // hash, which is the whole reason a hand-made mod with no archive can still
  // ship. Gating this on the archive would block bundling
  // for exactly the mods that most need it.
  if (kind === "bundled" && !opts.hasStagingFolder) {
    return (
      "This mod has no staging folder on disk, so there is nothing to pack. " +
      "Reinstall it in Vortex, or pick another option."
    );
  }
  if ((kind === "direct" || kind === "browse") && !hasText(entry.url)) {
    return kind === "direct"
      ? "Add the link to the file, or switch to Manual."
      : "Add the link to the mod's page, or switch to Manual.";
  }
  return undefined;
}

/** Short label and the one-line explanation of what the user will do. */
export function describeSourceKind(kind: ExternalSourceKind): {
  label: string;
  hint: string;
} {
  switch (kind) {
    case "bundled":
      return {
        label: "Bundled",
        hint:
          "Packed from your staging folder and shipped inside the collection. " +
          "Nothing to download, and no original archive needed.",
      };
    case "direct":
      return {
        label: "Direct link",
        hint: "The link is the file itself — opening it starts the download.",
      };
    case "browse":
      return {
        label: "From website",
        hint: "The link is the mod's page. They find the file on it, then download.",
      };
    case "manual":
      return {
        label: "Manual",
        hint: "No link. Your instructions are all they get, so make them specific.",
      };
  }
}

export const SOURCE_KINDS: readonly ExternalSourceKind[] = [
  "bundled",
  "direct",
  "browse",
  "manual",
];

const hasText = (v: string | undefined): boolean =>
  v !== undefined && v.trim().length > 0;
