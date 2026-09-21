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
  /** Whether the player's game is older (-1) or newer (1) than required. */
  direction: -1 | 1 | undefined;
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
  };
  /** Why there is no precise list, when there is not. */
  noListReason?: "package-predates-plugin-data" | "runtime-unknown" | "no-plugins";
};

const direction = (installed: string, required: string): -1 | 1 | undefined => {
  const a = installed.split(".").map((s) => Number.parseInt(s, 10));
  const b = required.split(".").map((s) => Number.parseInt(s, 10));
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (!Number.isFinite(x) || !Number.isFinite(y)) return undefined;
    if (x !== y) return x < y ? -1 : 1;
  }
  return undefined;
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
    direction: direction(installed, manifest.game.version),
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
    return { ...base, noListReason: "runtime-unknown" };
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
} {
  const headline =
    `This collection was built on ${m.required}; your game is ${m.installed}.`;

  if (m.plugins === undefined) {
    const why =
      m.noListReason === "package-predates-plugin-data"
        ? "This package was built before Event Horizon recorded which mods depend on the " +
          "game version, so it cannot tell you exactly which ones to swap."
        : "Event Horizon could not work out which script-extender runtime your game uses, " +
          "so it cannot tell you exactly which mods to swap.";
    return {
      headline,
      summary: [
        why,
        "Most of a collection does not care about the version. What breaks is script-extender " +
          "plugins (.dll files); anything in the collection that ships one may need the build for " +
          "your game version.",
      ],
      swapLines: [],
    };
  }

  const p = m.plugins;
  const mods = byMod(p.cannotLoad);
  const summary: string[] = [];
  const plural = (n: number, one: string, many: string): string => (n === 1 ? one : many);

  if (mods.length === 0) {
    summary.push(
      p.loads > 0
        ? `Every script-extender plugin here that declares its game version will load on ${p.target.runtime}.`
        : `No script-extender plugin here is built only for another version.`,
    );
  } else {
    summary.push(
      `${mods.length} ${plural(mods.length, "mod", "mods")} will not load on your game and ` +
        `${plural(mods.length, "needs", "need")} the build for ${p.target.runtime}. ` +
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
  return {
    headline,
    summary,
    swapLines: mods.map(
      (x) => `${x.mod} — ${x.paths.join(", ")}: ${x.why}`,
    ),
  };
}
