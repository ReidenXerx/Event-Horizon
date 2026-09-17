/**
 * ──────────────────────────────────────────────────────────────────────
 * What to actually DO about a game-version mismatch.
 *
 * "Game version mismatch: required 1.10.163 exactly, installed 1.10.984" is
 * true and useless. It names the problem and leaves the user to discover on
 * their own that Bethesda shipped an update which broke the script extender,
 * that the fix is to move the game BACKWARDS, and that this is a normal thing
 * modders do rather than a sign something is broken.
 *
 * That discovery is the single most common wall a new modder hits, and it is
 * entirely avoidable: the collection knows which version it needs and the
 * resolver knows which one is installed, so it can say which direction to go
 * and what the tool is called.
 *
 * ## Why the links are searches, not mod ids
 *
 * Downgrade tools get re-uploaded, superseded and occasionally taken down. A
 * hard-coded Nexus mod id is a promise this file cannot keep, and sending
 * someone to a dead page is worse than sending them to a search that always
 * resolves. Names are given so the right result is recognisable.
 * ──────────────────────────────────────────────────────────────────────
 */

/** A version that is famous for breaking things, and what it means. */
type VersionNote = {
  /** Matched as a PREFIX, because builds carry trailing components. */
  prefix: string;
  summary: string;
};

type GameGuidance = {
  /** Human name, for prose. */
  name: string;
  /** Search that will always resolve, whatever the current tool is called. */
  searchUrl: string;
  /** Tools people actually use, so the right search result is recognisable. */
  toolNames: string[];
  notes: VersionNote[];
};

const GUIDANCE: Record<string, GameGuidance> = {
  fallout4: {
    name: "Fallout 4",
    searchUrl: "https://www.nexusmods.com/fallout4/search/?gsearch=downgrader",
    toolNames: ["Simple Fallout 4 Downgrader", "Fallout 4 Downgrader"],
    notes: [
      {
        prefix: "1.10.980",
        summary:
          "the 2024 'next-gen' update, which broke F4SE and most script " +
          "extender plugins. Most large collections still target 1.10.163.",
      },
      {
        prefix: "1.10.984",
        summary:
          "a post-'next-gen' build. Most large collections still target " +
          "1.10.163, the last pre-next-gen version.",
      },
      {
        prefix: "1.10.163",
        summary:
          "the last pre-'next-gen' build, and what most established Fallout 4 " +
          "collections are built against.",
      },
    ],
  },
  skyrimse: {
    name: "Skyrim Special Edition",
    searchUrl: "https://www.nexusmods.com/skyrimspecialedition/search/?gsearch=downgrade",
    toolNames: ["Skyrim Downgrade Patcher", "Best of Both Worlds"],
    notes: [
      {
        prefix: "1.5.97",
        summary:
          "the pre-Anniversary Edition build that a large part of the SKSE " +
          "plugin ecosystem still targets.",
      },
      {
        prefix: "1.6.",
        summary:
          "an Anniversary Edition build. SKSE plugins are version-locked, so " +
          "collections built for 1.5.97 will not run here.",
      },
    ],
  },
  starfield: {
    name: "Starfield",
    searchUrl: "https://www.nexusmods.com/starfield/search/?gsearch=downgrade",
    toolNames: ["Starfield Downgrader"],
    notes: [],
  },
  falloutnv: {
    name: "Fallout: New Vegas",
    searchUrl: "https://www.nexusmods.com/newvegas/search/?gsearch=downgrade",
    toolNames: [],
    notes: [],
  },
  fallout3: {
    name: "Fallout 3",
    searchUrl: "https://www.nexusmods.com/fallout3/search/?gsearch=downgrade",
    toolNames: [],
    notes: [],
  },
};

const describe = (game: GameGuidance, version: string): string | undefined =>
  game.notes.find((n) => version.startsWith(n.prefix))?.summary;

/**
 * Turn "these versions differ" into "here is what to do about it".
 *
 * Returns an empty array when there is nothing useful to add — an unknown game,
 * or versions that carry no meaning worth explaining. Saying nothing beats
 * padding a real error with filler.
 */
export function gameVersionGuidance(args: {
  gameId: string;
  required: string;
  installed: string;
  /** What to do once the version is right. Default: "re-run this install". */
  retry?: string;
}): string[] {
  const retry = args.retry ?? "re-run this install";
  const game = GUIDANCE[args.gameId];
  if (game === undefined) return [];

  const out: string[] = [];

  const installedNote = describe(game, args.installed);
  const requiredNote = describe(game, args.required);
  if (installedNote !== undefined) {
    out.push(`You have ${args.installed} — ${installedNote}`);
  }
  if (requiredNote !== undefined) {
    out.push(`This collection needs ${args.required} — ${requiredNote}`);
  }

  // Direction matters: telling someone to downgrade when they need to UPDATE
  // sends them the wrong way through a tedious process.
  const direction = compareVersions(args.installed, args.required);
  if (direction === undefined || direction > 0) {
    out.push(
      `Changing a Bethesda game's version is routine for modding, not a sign ` +
        `anything is broken. To move ${game.name} back to ${args.required}, use a ` +
        `downgrade tool` +
        (game.toolNames.length > 0
          ? ` — commonly ${game.toolNames.join(" or ")}`
          : "") +
        `: ${game.searchUrl}`,
    );
    out.push(
      `Steam users can also download an older build directly through the ` +
        `console (download_depot), and GOG users can install an older offline ` +
        `installer. Verify the game files afterwards, then ${retry}.`,
    );
  } else if (direction < 0) {
    out.push(
      `Your ${game.name} is OLDER than this collection expects. Update the game ` +
        `to ${args.required} through Steam or GOG, then ${retry}.`,
    );
  }

  return out;
}

/**
 * Compare dotted numeric versions. `undefined` when either side is not
 * comparable — which is a "cannot tell", never an assumed direction.
 */
export function compareVersions(a: string, b: string): number | undefined {
  const parse = (v: string): number[] | undefined => {
    const parts = v.trim().split(".");
    const nums = parts.map((p) => Number.parseInt(p, 10));
    return nums.every((n) => Number.isFinite(n)) && nums.length > 0
      ? nums
      : undefined;
  };
  const pa = parse(a);
  const pb = parse(b);
  if (pa === undefined || pb === undefined) return undefined;
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d > 0 ? 1 : -1;
  }
  return 0;
}
