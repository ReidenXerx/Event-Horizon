/**
 * ──────────────────────────────────────────────────────────────────────
 * What ends up beside the game executable, and what is missing from there.
 *
 * A handful of things in any load order do not live in Data: the script
 * extender's loader, ENB's wrapper, an engine fix's proxy DLL. They are few —
 * on a real 1753-mod Skyrim profile exactly ONE mod deploys outside Data — and
 * they are the ones whose absence breaks everything downstream while every
 * file check still passes.
 *
 * ─── WHY THIS REPORTS AND DOES NOT DETECT ──────────────────────────────
 * The obvious feature is to spot engine injectors automatically from the shape
 * of their staging folder. It was tried against the real collection and it
 * does not work:
 *
 *   - "has a top-level Data/ folder" matched ONE mod, SKSE, which was already
 *     the correct type. It finds nothing that is wrong.
 *   - "has a .dll or .exe at the staging root" matched SKSE and **Pandora
 *     Behaviour Engine**, a standalone tool you run from its own folder.
 *     Setting that to a root-deploying type would empty a tool folder into the
 *     game directory.
 *   - "has a .dll outside the SE plugins folder" matched Nemesis, Community
 *     Shaders, Upscaling and Achievements Mods Enabler. All four are normal
 *     mods; none is an injector.
 *
 * A tool's binary and an injector's binary are the same bytes in the same
 * place. Nothing in the staging folder distinguishes them, so a detector can
 * only produce confident false positives — and the cost of a false positive
 * here is files dumped into the game root, which is worse than the problem.
 *
 * So this states facts the curator can check, and never a verdict:
 * which mods deploy outside Data, and which root-folder prerequisites were
 * found. Both are short. The value is in noticing what is NOT on either list.
 *
 * The one thing it does assert is `describeScriptExtenderGap`, and only
 * because that one IS provable rather than inferred.
 * ──────────────────────────────────────────────────────────────────────
 */

import type { AuditorMod } from "../getModsListForProfile";

import { toPosix } from "../paths";
import type { EhcollExternalDependency } from "../../types/ehcoll";

export type RootFolderMod = {
  name: string;
  /** Vortex's mod type. Never empty here — that is the point of the list. */
  modType: string;
};

/**
 * Mods Vortex will deploy somewhere other than Data.
 *
 * Read straight off the modType Vortex already assigned. No inference, so no
 * false positives: if Vortex says this mod is `dinput`, its files go to the
 * game root, and that is a fact about what the collection will do.
 */
export function findRootFolderMods(
  mods: readonly AuditorMod[],
): RootFolderMod[] {
  return mods
    .filter((m) => (m.modType ?? "").trim().length > 0)
    .map((m) => ({ name: m.name, modType: m.modType }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Per game, the SE plugin folder and the loader that has to exist for it. */
const SCRIPT_EXTENDERS: Record<
  string,
  { name: string; pluginDir: string; loader: string; probeId: string }
> = {
  skyrimse: {
    name: "SKSE64",
    pluginDir: "skse/plugins/",
    loader: "skse64_loader.exe",
    probeId: "skse64",
  },
  fallout4: {
    name: "F4SE",
    pluginDir: "f4se/plugins/",
    loader: "f4se_loader.exe",
    probeId: "f4se",
  },
  starfield: {
    name: "SFSE",
    pluginDir: "sfse/plugins/",
    loader: "sfse_loader.exe",
    probeId: "sfse",
  },
};

/**
 * The collection is built ON a script extender it does not contain.
 *
 * This is assertable rather than guessed, and that is the whole reason it
 * exists while injector detection does not. An SKSE plugin is a DLL in
 * `SKSE/Plugins`, it is loaded by exactly one thing, and if that thing is
 * neither a mod in the collection nor a declared prerequisite then every one
 * of those plugins is inert on arrival. There is no reading of the evidence
 * where such a collection works.
 *
 * Counts the plugins so the sentence carries its own weight: "37 mods depend
 * on this" is an argument, "a dependency is missing" is a shrug.
 */
export function describeScriptExtenderGap(args: {
  gameId: string;
  mods: readonly AuditorMod[];
  declared: readonly EhcollExternalDependency[];
}): string | undefined {
  const se = SCRIPT_EXTENDERS[args.gameId];
  if (se === undefined) return undefined;

  let pluginCount = 0;
  let providesLoader = false;
  for (const mod of args.mods) {
    for (const f of mod.stagingFiles ?? []) {
      const p = String(f.path).split("\\").join("/").toLowerCase();
      if (p.startsWith(se.pluginDir) && p.endsWith(".dll")) {
        pluginCount += 1;
        break;
      }
    }
    // The loader can sit anywhere in a root-deploying mod's tree.
    if (
      !providesLoader &&
      (mod.stagingFiles ?? []).some((f) =>
        String(f.path).split("\\").join("/").toLowerCase().endsWith(se.loader),
      )
    ) {
      providesLoader = true;
    }
  }

  if (pluginCount === 0) return undefined;
  if (providesLoader) return undefined;
  if (args.declared.some((d) => d.id === se.probeId)) return undefined;

  return (
    `${pluginCount} mod(s) in this collection are ${se.name} plugins, and ` +
    `nothing here installs ${se.name} itself — it is not a mod in the ` +
    `collection and it is not listed as a prerequisite. Those plugins load ` +
    `through ${se.loader}, which sits beside the game executable, so on any ` +
    `machine that does not already have it they will do nothing at all and ` +
    `report nothing. Add ${se.name} to the profile so it ships, or install it ` +
    `in the game folder so it is detected as a prerequisite.`
  );
}

/**
 * Executable files beside the game exe that nothing in the collection accounts
 * for.
 *
 * Purely informational, and deliberately so. Most of these are the game itself,
 * its store client, or the curator's own tools, and Event Horizon cannot tell
 * those apart from a wrapper the setup depends on. Saying which would mean
 * encoding a belief about each file — the exact thing that made a probe
 * requiring `tbb.dll` fail silently on every machine but one.
 *
 * So it states what is there and admits what it does not know. A curator reads
 * the list in a second, recognises their own tools, and notices anything that
 * should not be on it. Nothing is asked of them and nothing is remembered.
 *
 * Already-accounted files are removed rather than listed and excused: anything
 * a mod deploys, and anything a declared prerequisite already covers.
 */
export function describeUnaccountedRootBinaries(args: {
  /** Every .dll/.exe directly in the game folder. */
  rootBinaries: readonly string[];
  /** Lowercased basenames the collection's mods deploy. */
  providedByMods: ReadonlySet<string>;
  /** Prerequisites already declared, whose files are covered. */
  declared: readonly EhcollExternalDependency[];
}): string[] {
  const covered = new Set<string>(args.providedByMods);
  for (const dep of args.declared) {
    for (const f of dep.files) {
      covered.add(baseName(f.relPath).toLowerCase());
    }
  }

  const unaccounted = args.rootBinaries.filter(
    (f) => !covered.has(f.toLowerCase()),
  );
  if (unaccounted.length === 0) return [];

  const shown = unaccounted.slice(0, 12).join(", ");
  const more =
    unaccounted.length > 12 ? `, and ${unaccounted.length - 12} more` : "";
  return [
    `${unaccounted.length} executable file(s) sit beside the game executable ` +
      `that no mod here provides: ${shown}${more}.`,
    `Most will be the game, its store client, or your own tools. Event ` +
      `Horizon cannot tell those apart from something your setup depends on, ` +
      `and anything in that second group will not reach users. Nothing to do ` +
      `if you recognise them all.`,
  ];
}

/** Last path segment, for a "/"- or "\\"-separated path. */
function baseName(p: string): string {
  const cut = toPosix(p).lastIndexOf("/");
  return cut === -1 ? p : p.slice(cut + 1);
}

/**
 * The review list, as prose for the build form.
 *
 * Always says something, including when the answer is "one mod". A list that
 * hid itself when short could not do its actual job, which is to let a curator
 * notice that something they expected is not on it.
 */
export function describeRootFolderReview(args: {
  rootMods: readonly RootFolderMod[];
  declared: readonly EhcollExternalDependency[];
}): string[] {
  const lines: string[] = [];

  if (args.rootMods.length === 0) {
    lines.push(
      `No mod in this collection deploys outside Data. If it needs a script ` +
        `extender, ENB, or an engine fix, none of them is being managed by ` +
        `Vortex here.`,
    );
  } else {
    lines.push(
      `${args.rootMods.length} mod(s) deploy beside the game executable ` +
        `rather than into Data:`,
    );
    for (const m of args.rootMods.slice(0, 10)) {
      lines.push(`  • "${m.name}" (${m.modType})`);
    }
    if (args.rootMods.length > 10) {
      lines.push(`  • and ${args.rootMods.length - 10} more.`);
    }
  }

  if (args.declared.length > 0) {
    lines.push(
      `${args.declared.length} thing(s) in your game folder are not Vortex ` +
        `mods and will be listed for users to install by hand: ` +
        `${args.declared.map((d) => d.name).join(", ")}.`,
    );
  }

  lines.push(
    `Anything else that belongs next to the executable is not covered. Vortex ` +
      `decides this with a mod's "type", and it cannot always tell from an ` +
      `archive — set the type on the mod in Vortex and build again, and this ` +
      `collection will reproduce it.`,
  );
  return lines;
}
