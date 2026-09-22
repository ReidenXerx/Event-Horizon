/**
 * ──────────────────────────────────────────────────────────────────────
 * The player's game is not the version the collection was built on.
 *
 * This used to STOP the install outright. Players asked to be allowed through,
 * and the reason they could be is measurable: almost nothing in a collection
 * cares about the game version. Meshes, textures and most plugins run on any
 * build. What breaks is native code — script-extender plugins compiled
 * against one executable — and those DLLs say which runtimes they support.
 *
 * So instead of "no", the player gets two honest roads (owner poll,
 * 2026-09-22 — warn, and hold Install until one box is ticked):
 *
 *   - change the game to the collection's version — the existing guidance,
 *     downgrade tools and all; or
 *   - keep their version and swap the handful of mods that will not load on
 *     it, named one by one.
 *
 * ─── WHY THE LIST IS SHORT, AND WHY IT IS RIGHT ────────────────────────
 * Measured on a real 1,746-mod Skyrim collection: 241 of 252 script-extender
 * plugins are version-independent (Address Library), so the old answer —
 * "re-download every mod with a DLL", 245 of them — was wrong by more than an
 * order of magnitude. The list here comes from what each DLL declared at
 * build time, judged against the PLAYER's runtime and script extender, and
 * only for the copy that actually deploys when two mods ship the same file.
 *
 * ─── WHAT IT DOES NOT PRETEND ──────────────────────────────────────────
 * A package built before plugin data was recorded carries no list; it says so
 * rather than inventing one. A player whose runtime cannot be established
 * gets the general guidance and no list. "Unverified" plugins — decided at
 * load time — are counted, never named as problems.
 * ──────────────────────────────────────────────────────────────────────
 */

import type { EhcollManifest, GameVersionPolicy } from "../../types/ehcoll";
import {
  extenderApiFor,
  judgeCollection,
  runtimeIdFor,
  type NativeFinding,
  type NativeTarget,
} from "../environment/nativePluginCompat";

export type VersionMismatch = {
  required: string;
  installed: string;
  policy: GameVersionPolicy;
  /**
   * The stores, when both are known and they DIFFER.
   *
   * A second compatibility axis, and it was being carried inside the version
   * string: Skyrim's GOG build has its own script-extender runtime id, so a
   * store difference showed up as a swap list with no explanation, beside
   * advice ("update the game to X") that cannot fix it. The player has to be
   * told which axis is wrong before either road makes sense.
   */
  stores?: { curator: string; user: string };
  /**
   * The precise judgement, when the package recorded plugin data AND the
   * player's runtime could be established. Absent otherwise — see `why`.
   */
  plugins?: {
    target: NativeTarget;
    /** Winning DLLs that will not load on the player's game: swap these. */
    cannotLoad: NativeFinding[];
    /** Winning DLLs whose fate cannot be told. */
    unknown: NativeFinding[];
    /** Plugins that load, most of them through Address Library. */
    loads: number;
    /** Plugins that decide at load time; counted, not named. */
    unverified: number;
    /**
     * Paths several mods ship with no rule deciding which deploys.
     *
     * The receipt folds these into its "unknown" count because from the
     * player's side they are the same "cannot tell". This panel dropped them
     * entirely, so the screen whose whole job is "which mods do I swap" was
     * the one surface that never mentioned them.
     */
    undetermined: { path: string; mods: string[] }[];
    /**
     * Mods whose plugin list may be SHORT, because the build could not read
     * part of their folder. Counted, never named as problems: nothing is
     * known to be wrong with them, only unchecked.
     */
    partlyChecked: number;
  };
  /**
   * Why there is no precise list, when there is not.
   *
   * `game-not-measured` is separate from `runtime-unknown` on purpose: one
   * says "we have never measured which script-extender builds this game's
   * mods need", the other says "we could not read YOUR game's version". The
   * first is our gap and the second sounds like the player's fault, and for
   * Starfield, Fallout 3 and New Vegas the honest answer was always the
   * first one.
   */
  noListReason?:
    | "package-predates-plugin-data"
    | "runtime-unknown"
    | "game-not-measured";
};

/**
 * Assess a version mismatch from the player's side. Pure.
 *
 * `store` is the PLAYER's store: the GOG build of Skyrim has its own runtime
 * id, so the same version number judges differently on Steam and GOG.
 */
export function assessVersionMismatch(args: {
  manifest: Pick<EhcollManifest, "game" | "mods" | "rules">;
  installed: string;
  store: string | undefined;
}): VersionMismatch {
  const { manifest, installed } = args;
  const base: VersionMismatch = {
    required: manifest.game.version,
    installed,
    policy: manifest.game.versionPolicy,
    ...(args.store !== undefined &&
    manifest.game.store !== undefined &&
    args.store.toLowerCase() !== manifest.game.store.toLowerCase()
      ? { stores: { curator: manifest.game.store, user: args.store } }
      : {}),
  };

  const anyRecorded = manifest.mods.some((m) => m.state.nativePlugins !== undefined);
  // A package with no plugin data at all is either older than the field or
  // genuinely has no native code. Only the first leaves the player guessing.
  if (!anyRecorded) {
    return { ...base, noListReason: "package-predates-plugin-data" };
  }

  const runtime = runtimeIdFor(manifest.game.id, installed, args.store);
  const api = extenderApiFor(manifest.game.id, installed);
  if (runtime === undefined || api === undefined) {
    /*
     * Which of the two is it? A game we have never measured answers
     * `undefined` for ANY version, so ask it about a version that is
     * certainly well-formed: still undefined means the gap is ours.
     */
    const measured =
      runtimeIdFor(manifest.game.id, "1.0.0", args.store) !== undefined &&
      extenderApiFor(manifest.game.id, "1.0.0") !== undefined;
    return { ...base, noListReason: measured ? "runtime-unknown" : "game-not-measured" };
  }

  const target: NativeTarget = { runtime, api };
  const j = judgeCollection({
    mods: manifest.mods.map((m) => ({
      name: m.name,
      compareKey: m.compareKey,
      ...(m.state.nativePlugins !== undefined ? { nativePlugins: m.state.nativePlugins } : {}),
    })),
    rules: manifest.rules,
    target,
  });
  return {
    ...base,
    plugins: {
      target,
      cannotLoad: j.cannotLoad,
      unknown: j.unknown,
      loads: j.loads,
      unverified: j.unverified,
      undetermined: j.undeterminedConflicts,
      partlyChecked: manifest.mods.filter((m) => m.state.nativePluginsIncomplete === true).length,
    },
  };
}

/** Group findings by mod, so a mod with three dead DLLs is one line. */
function byMod(findings: readonly NativeFinding[]): Array<{ mod: string; paths: string[]; why: string }> {
  const out = new Map<string, { mod: string; paths: string[]; why: string }>();
  for (const f of findings) {
    const slot = out.get(f.mod) ?? { mod: f.mod, paths: [], why: f.why };
    slot.paths.push(f.path);
    out.set(f.mod, slot);
  }
  return [...out.values()].sort((a, b) => (a.mod < b.mod ? -1 : a.mod > b.mod ? 1 : 0));
}

/**
 * What the player reads. `swapLines` is the precise list, one per MOD;
 * `summary` explains the choice. Kept apart so the UI can render the list as
 * a list rather than as prose.
 */
export function describeVersionMismatch(m: VersionMismatch): {
  headline: string;
  summary: string[];
  swapLines: string[];
  /**
   * The sentence the player actually affirms.
   *
   * It used to be one generic line whatever the finding — the same words for
   * "six mods" as for "we could not check anything" — which is a tick that
   * carries no information and teaches people to tick. It is derived from
   * the same data as the paragraph above it.
   */
  acknowledgement: string;
} {
  const stores =
    m.stores !== undefined
      ? `This collection was also built on the ${m.stores.curator} version of the game and you ` +
        `are on ${m.stores.user}. The two use different executables, so changing the version ` +
        `alone will not make a ${m.stores.curator} build load here.`
      : undefined;
  const headline =
    m.stores !== undefined
      ? `This collection was built on ${m.stores.curator} ${m.required}; your game is ` +
        `${m.stores.user} ${m.installed}.`
      : `This collection was built on ${m.required}; your game is ${m.installed}.`;

  if (m.plugins === undefined) {
    const why =
      m.noListReason === "package-predates-plugin-data"
        ? "This package was built before Event Horizon recorded which mods depend on the " +
          "game version, so it cannot tell you exactly which ones to swap."
        : m.noListReason === "game-not-measured"
          ? "Event Horizon has not measured which script-extender builds this game's mods need, " +
            "so it cannot name them here."
          : "Event Horizon could not work out which script-extender build your game needs, " +
            "so it cannot tell you exactly which mods to swap.";
    return {
      headline,
      summary: [
        why,
        ...(stores !== undefined ? [stores] : []),
        "Most of a collection does not care about the version. What breaks is script-extender " +
          "plugins (.dll files); anything in the collection that ships one may need the build for " +
          "your game version.",
      ],
      swapLines: [],
      acknowledgement:
        `I understand Event Horizon could not check which mods need the ${m.required} build, ` +
        `and some may not work on ${m.installed}.`,
    };
  }

  const p = m.plugins;
  const mods = byMod(p.cannotLoad);
  const summary: string[] = [];
  const plural = (n: number, one: string, many: string): string => (n === 1 ? one : many);

  /**
   * The version a MOD PAGE shows, never the runtime id.
   *
   * `p.target.runtime` is what the script extender calls this build, and its
   * GOG marker — the trailing `.1` on 1.6.1179 — appears on no Nexus file,
   * no changelog and no executable. A player sent to look for "1.6.1179.1"
   * will not find it. The store is said in words instead.
   */
  const yourBuild = m.stores !== undefined ? `${m.installed} (${m.stores.user})` : m.installed;

  if (stores !== undefined) summary.push(stores);
  if (mods.length === 0) {
    summary.push(
      p.loads > 0
        ? `Every script-extender plugin here that declares its game version will load on ${yourBuild}.`
        : `No script-extender plugin here is built only for another version.`,
    );
  } else {
    summary.push(
      `${mods.length} ${plural(mods.length, "mod", "mods")} will not load on your game and ` +
        `${plural(mods.length, "needs", "need")} the build for ${yourBuild}. ` +
        `${plural(mods.length, "It is", "They are")} listed below.`,
    );
  }
  /**
   * Said as what they ARE, not as a count of what "works". On an extender that
   * calls Query nothing can be proven to load ahead of time, so reporting
   * "0 plugins work on any version" — which the first version of this did,
   * for a 1.5.97 player — reads like an alarm and is only an artefact.
   */
  if (p.loads > 0) {
    summary.push(
      `${p.loads} ${plural(p.loads, "plugin works", "plugins work")} on any version through ` +
        `Address Library — ${plural(p.loads, "it needs", "they need")} Address Library for ` +
        `${m.installed}, and the script extender must be the one for ${m.installed}.`,
    );
  }
  if (p.unverified > 0) {
    summary.push(
      `${p.unverified} ${plural(p.unverified, "plugin checks", "plugins check")} your game ` +
        `version ${plural(p.unverified, "itself", "themselves")} when the game starts. Nothing in ` +
        `the files says what ${plural(p.unverified, "it", "they")} will decide, so some may still ` +
        `refuse ${m.installed} — the script extender's log names any that do.`,
    );
  }
  if (p.unknown.length > 0) {
    // Named, but capped: 33 paths inline is a wall, not a message.
    const shown = p.unknown.slice(0, 5).map((f) => f.path.split("/").pop());
    summary.push(
      `${p.unknown.length} ${plural(p.unknown.length, "plugin", "plugins")} could not be judged ` +
        `ahead of time (${shown.join(", ")}` +
        (p.unknown.length > shown.length ? `, and ${p.unknown.length - shown.length} more` : "") +
        `) — the script extender's log will say whether they loaded.`,
    );
  }
  if (p.partlyChecked > 0) {
    /*
     * The list above is exact about what it saw, and this says what it did
     * not see. Without it the four counts read as a total for the whole
     * collection, and a mod whose folder could not be read provably cannot
     * appear in the swap list — precision about an incomplete sample.
     */
    summary.push(
      `${p.partlyChecked} ${plural(p.partlyChecked, "mod", "mods")} could only be checked in ` +
        `part, because the build could not read all of ${plural(p.partlyChecked, "its", "their")} ` +
        `files. Nothing is known to be wrong with ${plural(p.partlyChecked, "it", "them")}; ` +
        `${plural(p.partlyChecked, "it is", "they are")} simply not covered by the list above.`,
    );
  }
  if (p.undetermined.length > 0) {
    /*
     * The receipt already folds these into its "cannot tell" count; this
     * panel dropped them, so the one screen that answers "which mods do I
     * swap" was the only place they were invisible. An undetermined path
     * means the collection does not decide which copy of that DLL wins, so
     * nobody can say which one the player will end up with.
     */
    const n = p.undetermined.length;
    summary.push(
      `${n} ${plural(n, "file is", "files are")} shipped by more than one mod with no rule ` +
        `deciding which wins (${p.undetermined.slice(0, 3).map((u) => u.path.split("/").pop()).join(", ")}` +
        `${n > 3 ? `, and ${n - 3} more` : ""}), so which copy you end up with is not decided here.`,
    );
  }
  return {
    headline,
    summary,
    swapLines: mods.map(
      (x) => `${x.mod} — ${x.paths.join(", ")}: ${x.why}`,
    ),
    /**
     * What the player affirms, from what was actually found: a number when
     * there is one, and the honest "could not check" when there is not.
     */
    acknowledgement:
      mods.length > 0
        ? `I understand ${mods.length} ${plural(mods.length, "mod", "mods")} will not load on ` +
          `${m.installed} until I swap ${plural(mods.length, "it", "them")}.`
        : p.unverified + p.unknown.length + p.undetermined.length > 0
          ? `I understand some of this collection's script-extender plugins could not be checked ` +
            `for ${m.installed}, and may not work.`
          : `I understand this collection was made for ${m.required} and I am on ${m.installed}.`,
  };
}
