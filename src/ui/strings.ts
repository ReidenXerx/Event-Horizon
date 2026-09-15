/**
 * Centralised user-facing string table.
 *
 * Why a table:
 *  - One spot to proof-read tone, terminology ("collection", "profile",
 *    ".ehcoll", "Event Horizon").
 *  - Trivial to swap in a translation backend later — every string in
 *    here is keyed.
 *  - Discourages copy-paste drift: when "Build collection" gets renamed
 *    to "Pack collection", we change one line, not eight.
 *
 * What lives here:
 *  - Strings the user reads. Buttons, banners, errors, hints.
 *
 * What does NOT live here:
 *  - Log messages (server-side; English-only).
 *  - JSON keys, file paths, env var names.
 *  - One-off debug copy that's only visible in dev builds.
 *
 * Migration policy:
 *  - This module is intentionally additive. Components keep their
 *    inline strings until they're touched for other reasons; new
 *    components should pull from `S` from day one.
 *  - When extracting, prefer descriptive keys (`build.empty.title`)
 *    over reused ones — a collision later is harder to fix than an
 *    extra entry.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * String table. Keys are dotted paths describing surface + role.
 * Values are either plain strings or single-arg formatters when the
 * copy needs interpolation.
 */
export const S = {
  app: {
    name: "Event Horizon",
    tagline:
      "A drop-in collection installer for Vortex that captures every piece of curator state.",
  },

  build: {
    title: "Build a collection",
    cta: "Build package",
    empty: {
      title: "Your active profile has no mods.",
      message:
        "A collection needs at least one mod. Enable some mods in Vortex first, then come back here.",
    },
    importExisting: "Import from a previous package",
    importExistingBusy: "Importing...",
    distribution: {
      hint:
        "Upload this package to your collection's Nexus mod page named .zip instead of .ehcoll (Nexus quarantines .ehcoll files), with mod manager download off, so players can drag it into Event Horizon.",
    },
  },

  install: {
    title: "Install a collection",
    pickHero: "Drop a collection package or click to browse",
    pickSafetyHint:
      "Event Horizon never modifies your current profile until you click Install on the final review screen.",
    confirmTitle: "Last chance to review",
    diskLow: (free: string): string =>
      `Low disk space on Vortex's data drive. Only ${free} free where mods get staged. Large collections can easily download tens of gigabytes — installs may fail mid-way if the disk fills.`,
    stale: {
      title: "This collection was installed here before",
      subtitle:
        "Event Horizon kept a record of the last install, but the Vortex profile it pointed to is gone. Pick how to handle it before continuing.",
      btnFresh: "Start fresh",
      btnKeep: "Install into current profile",
      btnBack: "Go back",
    },
  },

  collections: {
    searchPlaceholder: "Search by name, game, or profile...",
    empty: "No collections match",
    sort: {
      recent: "Most recent",
      name: "Name (A → Z)",
      mods: "Mod count (high → low)",
    },
  },

  errors: {
    copyReport: "Copy report",
    copyReportBusy: "Copying...",
    copyReportOk: "Copied!",
    copyReportFail: "Couldn't copy to clipboard.",
    saveReport: "Save report...",
  },

  toasts: {
    diagSaved: "Diagnostic saved.",
    profileSwitched: (name: string): string =>
      `Switched to profile "${name}".`,
    pathCopied: "Path copied to clipboard.",
  },
} as const;

/**
 * Tiny helper for `S.x.y(arg)` — present so call sites are uniform
 * regardless of whether a key is a literal or a formatter.
 *
 *   t(S.install.diskLow, "1.2 GB")  →  "Low disk space ..."
 *   t(S.app.name)                   →  "Event Horizon"
 */
export function t<TArgs extends any[]>(
  value: string | ((...args: TArgs) => string),
  ...args: TArgs
): string {
  if (typeof value === "function") return value(...args);
  return value;
}
