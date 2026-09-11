/**
 * Read the ESL / "light" flag of every plugin in the curator's load order.
 *
 * ─── WHY THE DEPLOYED FILE, NOT STAGING ────────────────────────────────
 * Two mods can stage a plugin of the same name; only one of them wins
 * deployment, and the winner is what the game loads and what Vortex's own
 * plugin parser reads. Picking a staged copy would mean recording the flag of
 * a file that never runs — and picking "the first one found" would make the
 * answer depend on directory order.
 *
 * plugins.txt is itself a list of DEPLOYED plugins, so reading beside it keeps
 * the two consistent.
 *
 * ─── ABSENT MEANS UNKNOWN ──────────────────────────────────────────────
 * A plugin whose header cannot be read is left out rather than recorded as
 * `false`. On the install side an absent flag means "leave this alone", and a
 * false one means "clear the flag" — so guessing here would strip flags from a
 * user's plugins on the strength of a failed read.
 *
 * ─── AND WHICH BIT THE VALUES CAME FROM ────────────────────────────────
 * The light bit is the game's (0x100 on Starfield, 0x200 elsewhere). The bit
 * read is returned so the package can record it, and an installer can refuse
 * values that do not mean what its game means by "light". A game with no
 * light plugins, or one Vortex does not know, records nothing at all.
 */

import * as path from "path";

import { pluginCapabilityFor, readPluginFlags } from "./pluginFlags";

export type CapturedPluginFlags = {
  /** Keyed by LOWERCASED plugin name — the form every comparison uses. */
  light: Record<string, boolean>;
  /** Plugins whose header could not be read, so nothing was recorded. */
  unreadable: string[];
  /** How many carry the flag, for the build report. */
  lightCount: number;
  /** Medium (Starfield FD-slot) plugins: not light, and not regular either. */
  mediumCount: number;
  /** The header bit `light` was read from. Absent when nothing could be captured for this game. */
  lightFlagBit?: number;
  /** Why the whole game was skipped, when it was — for the log. */
  notCaptured?: string;
};

export async function capturePluginFlags(args: {
  pluginNames: readonly string[];
  /** The game's Data folder. Omit when it is not known — nothing is recorded. */
  dataDir: string | undefined;
  /** The Vortex game id: it decides which header bit is "light". */
  gameId: string;
  signal?: AbortSignal;
  onProgress?: (done: number, total: number) => void;
}): Promise<CapturedPluginFlags> {
  const out: CapturedPluginFlags = { light: {}, unreadable: [], lightCount: 0, mediumCount: 0 };
  const capability = pluginCapabilityFor(args.gameId);
  if (capability === undefined) {
    out.notCaptured = `Vortex's plugin management does not know "${args.gameId}", so no header bit is known to mean light there.`;
    return out;
  }
  if (capability.lightFlagBit === undefined) {
    out.notCaptured = `${args.gameId} has no light plugins.`;
    return out;
  }
  if (args.dataDir === undefined || args.pluginNames.length === 0) {
    return out;
  }
  out.lightFlagBit = capability.lightFlagBit;

  let done = 0;
  for (const name of args.pluginNames) {
    if (args.signal?.aborted === true) break;
    done += 1;
    args.onProgress?.(done, args.pluginNames.length);

    const flags = await readPluginFlags(path.join(args.dataDir, name), capability);
    if (flags === undefined) {
      out.unreadable.push(name);
      continue;
    }
    out.light[name.toLowerCase()] = flags.isLight;
    if (flags.isLight) out.lightCount += 1;
    else if (flags.isMedium) out.mediumCount += 1;
  }
  return out;
}

/**
 * What to warn the curator about, or `undefined` when there is nothing to say.
 *
 * The headroom number is the point. "573 light plugins" means nothing on its
 * own; "244 regular against a limit of 254" tells a curator how close their
 * collection is to not loading on anybody's machine, including their own.
 */
export function describePluginFlagCapture(
  captured: CapturedPluginFlags,
  totalPlugins: number,
  regularLimit: number,
): string | undefined {
  if (totalPlugins === 0) return undefined;

  if (captured.unreadable.length > 0 && captured.lightCount === 0) {
    return (
      `Could not read the ESL/light flag for ${captured.unreadable.length} of ` +
      `${totalPlugins} plugin(s) (e.g. "${captured.unreadable[0]!}"), so it is ` +
      `not recorded for them. Whoever installs this collection keeps whatever ` +
      `flag their own copy has.`
    );
  }
  if (captured.lightCount === 0) return undefined;

  const regular = totalPlugins - captured.lightCount - captured.mediumCount;
  const headroom = regularLimit - regular;
  const base =
    `${captured.lightCount} of ${totalPlugins} plugin(s) are marked light ` +
    `(ESL)` +
    (captured.mediumCount > 0 ? ` and ${captured.mediumCount} medium` : ``) +
    `, leaving ${regular} regular against this game's limit of ` +
    `${regularLimit}.`;

  if (headroom < 0) {
    return (
      `${base} That is ${-headroom} OVER the limit — this collection cannot ` +
      `load as it stands, on your machine or anyone else's. Mark more plugins ` +
      `light, or merge or remove some.`
    );
  }
  if (headroom <= 20) {
    return (
      `${base} Only ${headroom} slot(s) spare, so the light flags are what ` +
      `makes this collection loadable at all. They are recorded and will be ` +
      `re-applied on install.` +
      (captured.unreadable.length > 0
        ? ` ${captured.unreadable.length} plugin(s) could not be read and are ` +
          `not covered.`
        : "")
    );
  }
  return captured.unreadable.length > 0
    ? `${base} ${captured.unreadable.length} plugin(s) could not be read, so ` +
        `their flag is not recorded.`
    : undefined;
}
