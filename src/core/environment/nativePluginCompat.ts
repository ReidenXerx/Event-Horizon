/**
 * ──────────────────────────────────────────────────────────────────────
 * Will this collection's script-extender plugins load on a given game?
 *
 * The answer the version soft block and the build's own check both need, from
 * data recorded at build time (`nativePlugins`). Pure: no disk, no Vortex.
 *
 * ─── THREE THINGS DECIDE IT, AND ALL THREE WERE GOT WRONG ONCE ─────────
 * 1. WHICH COPY DEPLOYS. Two mods often ship the same DLL path — a base mod
 *    and its "AE Support" / "NG" / "GOG Fix" / "Old-Gen Replacers" update,
 *    ten times in one real collection. Only the copy that wins the file
 *    conflict is ever loaded. Judging every copy called three correct setups
 *    broken (fiss.dll, skee64.dll, wsfw_identifier.dll). The winner comes from
 *    `before`/`after` rules ONLY: `requires` is a dependency, not an order,
 *    and counting it was a second mistake made while fixing the first.
 * 2. WHICH EXTENDER THE PLAYER RUNS. Old-gen F4SE and SE-era SKSE call a
 *    plugin's Query function and never read its version block. AE SKSE and
 *    next-gen F4SE read the block. 62 of 64 declaring F4SE plugins on a real
 *    profile export both, so the same DLL can be fine on one extender and
 *    unloadable on the other.
 * 3. HOW THE RUNTIME IS SPELLED. SKSE calls the GOG build of 1.6.1179
 *    "1.6.1179.1"; the executable reports "1.6.1179.0". Compare those
 *    naively and every GOG plugin looks incompatible.
 *
 * ─── WHAT IT WILL NOT CLAIM ────────────────────────────────────────────
 * A Query function decides at load time and declares nothing, so on a
 * Query-calling extender the honest verdict is "unverified", not "loads".
 * An unreadable DLL is "unknown". Only a verdict the file itself proves is
 * "cannot load".
 * ──────────────────────────────────────────────────────────────────────
 */

import type { EhcollNativePlugin, EhcollRule } from "../../types/ehcoll";

/** How the player's script extender asks a plugin whether it fits. */
export type ExtenderApi =
  /** Calls the plugin's Query function; ignores the version block. */
  | "query"
  /** Reads the version block. */
  | "version";

export type NativeTarget = {
  /** As script extenders spell it: "1.6.1179.1", "1.10.163". */
  runtime: string;
  api: ExtenderApi;
};

export type PluginVerdict =
  | { kind: "loads" }
  /** Query decides at load time; nothing in the file says what it decides. */
  | { kind: "unverified" }
  /** The file itself proves it: this extender will not load it. */
  | { kind: "cannot-load"; why: string }
  /** The file could not be read, or the combination is not one we know. */
  | { kind: "unknown"; why: string };

const tuple = (version: string): number[] | undefined => {
  const parts = version.split(".").map((s) => Number.parseInt(s, 10));
  return parts.length >= 3 && parts.slice(0, 3).every(Number.isFinite)
    ? parts.slice(0, 3)
    : undefined;
};

const atLeast = (v: number[], floor: number[]): boolean => {
  for (let i = 0; i < floor.length; i += 1) {
    if (v[i]! !== floor[i]!) return v[i]! > floor[i]!;
  }
  return true;
};

/**
 * Which extender API a game version is played with.
 *
 * Skyrim: AE (1.6.317 and later) SKSE reads the version block; SE (1.5.x)
 * SKSE calls Query. Fallout 4: next-gen (1.10.980 and later) F4SE reads the
 * block; old-gen (1.10.163 and earlier) F4SE calls Query. `undefined` for any
 * game this has not been measured on — no data, no verdict.
 */
export function extenderApiFor(gameId: string, version: string): ExtenderApi | undefined {
  const v = tuple(version);
  if (v === undefined) return undefined;
  if (gameId === "skyrimse") return atLeast(v, [1, 6, 317]) ? "version" : "query";
  if (gameId === "fallout4") return atLeast(v, [1, 10, 980]) ? "version" : "query";
  return undefined;
}

/**
 * The runtime id a script extender uses for this game, version and store.
 *
 * Only the Skyrim GOG build carries a marker, `.1` — measured: every
 * GOG-specific SKSE plugin on a real profile lists `1.6.1179.1` while the GOG
 * executable reports `1.6.1179.0`. No Fallout 4 plugin lists a sub-version, so
 * none is added there.
 */
export function runtimeIdFor(
  gameId: string,
  version: string,
  store: string | undefined,
): string | undefined {
  const v = tuple(version);
  if (v === undefined) return undefined;
  const base = v.join(".");
  if (gameId === "skyrimse") {
    /**
     * ─── AN UNKNOWN STORE IS NOT "STEAM" ──────────────────────────────
     * The store decides the id here, so not knowing it means not knowing
     * the id. Returning `base` for an unrecorded store answered as though
     * Steam had been established, and every GOG-only plugin — which lists
     * `1.6.1179.1` — then read as "cannot load" against `1.6.1179`. The
     * two strings differ by one character a person will not notice.
     *
     * Vortex leaves the store undefined whenever the player added the game
     * path by hand, so this is an ordinary machine, not a corner case. The
     * player would have been handed a swap list naming the mods that are
     * RIGHT for their install, and a GOG curator would have been told their
     * own working DLLs cannot load.
     *
     * Every caller already handles `undefined` as "no verdict".
     */
    const s = store?.toLowerCase();
    if (s === "gog") return `${base}.1`;
    return s === "steam" ? base : undefined;
  }
  // Fallout 4 plugins carry no store marker, so the store cannot change the
  // answer and not knowing it costs nothing.
  if (gameId === "fallout4") return base;
  return undefined;
}

/** Will ONE plugin load on this target? */
export function judgePlugin(plugin: EhcollNativePlugin, target: NativeTarget): PluginVerdict {
  if (plugin.kind === "unreadable") {
    return { kind: "unknown", why: "the DLL could not be read" };
  }

  if (target.api === "query") {
    if (plugin.kind === "query-only") return { kind: "unverified" };
    // It declares. A Query-calling extender needs the Query function too.
    return plugin.hasQuery === true
      ? { kind: "unverified" }
      : {
          kind: "cannot-load",
          why:
            "it is built for the newer script extender only — it has no Query " +
            "function, which is what this game's extender calls",
        };
  }

  // A version-block extender.
  if (plugin.kind === "query-only") {
    return plugin.extender === "skse"
      ? {
          kind: "cannot-load",
          why: "it predates the Anniversary Edition script extender, which will not load it",
        }
      : // Not established for next-gen F4SE, so not claimed.
        { kind: "unknown", why: "it declares no game version, and this extender's handling of that is not known" };
  }
  if (plugin.versionIndependent === true) return { kind: "loads" };
  const runtimes = plugin.runtimes ?? [];
  if (runtimes.includes(target.runtime)) return { kind: "loads" };
  return {
    kind: "cannot-load",
    why:
      runtimes.length === 0
        ? "it names no game version it runs on"
        : `it is built for ${runtimes.join(", ")}, and this game is ${target.runtime}`,
  };
}

/** Does a rule's reference point at this mod? References may be partly pinned. */
const refersTo = (reference: string, compareKey: string): boolean =>
  reference === compareKey || compareKey.startsWith(`${reference}:`);

/**
 * Which of several mods shipping one path deploys last, and so wins.
 *
 * `before` and `after` only. A mod wins when every other mod in the group is
 * ordered before it — DIRECTLY OR THROUGH A CHAIN. Anything short of a single
 * such mod is reported as undetermined rather than guessed.
 *
 * ─── WHY THE CHAIN MATTERS ─────────────────────────────────────────────
 * Vortex asks about one conflict at a time, so three mods shipping one DLL
 * end up with the rules a person actually clicked: C after B, B after A. The
 * redundant C after A is never created. Comparing only direct rules reported
 * that as "no rule decides this", which is false — the order IS decided — and
 * worse, an undetermined path is skipped entirely, so the DLL that really
 * deploys was never judged and a broken winner produced no warning at all.
 * A base mod plus its "AE Support" and "GOG Fix" updates is exactly this
 * shape, and one real collection had ten such stacks.
 */
function conflictWinner(
  keys: readonly string[],
  rules: readonly EhcollRule[],
): string | undefined {
  const deploysAfter = (a: string, b: string): boolean =>
    rules.some(
      (r) =>
        r.ignored !== true &&
        ((r.type === "after" && r.source === a && refersTo(r.reference, b)) ||
          (r.type === "before" && r.source === b && refersTo(r.reference, a))),
    );
  /**
   * Transitive closure over the handful of mods contesting one path —
   * Floyd-Warshall on at most a few keys, so the cost is nothing and a
   * cycle stays a cycle (two winners, hence undetermined).
   */
  const after = new Map<string, Set<string>>();
  for (const a of keys) {
    after.set(a, new Set(keys.filter((b) => b !== a && deploysAfter(a, b))));
  }
  for (const mid of keys) {
    for (const a of keys) {
      if (!after.get(a)!.has(mid)) continue;
      for (const b of after.get(mid)!) {
        if (b !== a) after.get(a)!.add(b);
      }
    }
  }
  const winners = keys.filter((k) => keys.every((o) => o === k || after.get(k)!.has(o)));
  return winners.length === 1 ? winners[0] : undefined;
}

export type NativeFinding = { mod: string; path: string; why: string };

export type CollectionNativeJudgement = {
  /** A winning DLL the file itself proves will not load. */
  cannotLoad: NativeFinding[];
  /** A winning DLL whose fate cannot be told. */
  unknown: NativeFinding[];
  /** Paths several mods ship with no rule deciding which deploys. */
  undeterminedConflicts: { path: string; mods: string[] }[];
  /** Winning plugins that load, including unverified ones. */
  loads: number;
  unverified: number;
};

/** Judge every plugin that will actually deploy. */
export function judgeCollection(args: {
  mods: ReadonlyArray<{ name: string; compareKey: string; nativePlugins?: EhcollNativePlugin[] }>;
  rules: readonly EhcollRule[];
  target: NativeTarget;
}): CollectionNativeJudgement {
  // Group by path, case-insensitively: they are Windows paths, and two mods
  // writing `SKSE/Plugins/X.dll` and `skse/plugins/x.dll` write one file.
  const byPath = new Map<string, { path: string; entries: { mod: string; key: string; plugin: EhcollNativePlugin }[] }>();
  for (const mod of args.mods) {
    for (const plugin of mod.nativePlugins ?? []) {
      const k = plugin.path.toLowerCase();
      const slot = byPath.get(k) ?? { path: plugin.path, entries: [] };
      slot.entries.push({ mod: mod.name, key: mod.compareKey, plugin });
      byPath.set(k, slot);
    }
  }

  const out: CollectionNativeJudgement = {
    cannotLoad: [],
    unknown: [],
    undeterminedConflicts: [],
    loads: 0,
    unverified: 0,
  };
  for (const { path, entries } of byPath.values()) {
    let winner = entries[0]!;
    if (entries.length > 1) {
      const key = conflictWinner(entries.map((e) => e.key), args.rules);
      const found = key === undefined ? undefined : entries.find((e) => e.key === key);
      if (found === undefined) {
        out.undeterminedConflicts.push({ path, mods: entries.map((e) => e.mod) });
        continue;
      }
      winner = found;
    }
    const verdict = judgePlugin(winner.plugin, args.target);
    if (verdict.kind === "loads") out.loads += 1;
    else if (verdict.kind === "unverified") out.unverified += 1;
    else if (verdict.kind === "cannot-load") out.cannotLoad.push({ mod: winner.mod, path, why: verdict.why });
    else out.unknown.push({ mod: winner.mod, path, why: verdict.why });
  }
  return out;
}

/**
 * What a CURATOR should hear about their own build: plugins that cannot load
 * on the very game they built it on.
 *
 * Nothing warned about these before, and they are silent on every machine —
 * the extender skips the DLL and says so only in its own log. A real
 * collection shipped one (Crafting Highlight Fix 1.9, a next-gen-only build,
 * in a collection for old-gen 1.10.163) and it was found only by reading the
 * DLLs by hand.
 *
 * `unverified` plugins are deliberately NOT mentioned. On a Query-calling
 * extender that is almost every plugin, and it is the normal state of an
 * old-gen game rather than a finding.
 */
export function describeCuratorNativeFindings(
  judgement: CollectionNativeJudgement,
  gameLabel: string,
): string[] {
  const out: string[] = [];
  if (judgement.cannotLoad.length > 0) {
    const n = judgement.cannotLoad.length;
    out.push(
      [
        `${n} script-extender plugin${n === 1 ? "" : "s"} in this collection cannot ` +
          `load on the game you are building for (${gameLabel}), so every player ` +
          `gets ${n === 1 ? "a mod" : "mods"} that silently do${n === 1 ? "es" : ""} ` +
          `nothing — the extender skips ${n === 1 ? "it" : "them"} and says so only ` +
          `in its own log:`,
        ...judgement.cannotLoad.map((f) => `  • ${f.path} (${f.mod}): ${f.why}.`),
        `The fix is usually that mod's build for your game version, or an update ` +
          `that replaces the DLL — with a rule making it win.`,
      ].join("\n"),
    );
  }
  if (judgement.undeterminedConflicts.length > 0) {
    const n = judgement.undeterminedConflicts.length;
    out.push(
      [
        `${n} script-extender plugin path${n === 1 ? " is" : "s are"} shipped by more ` +
          `than one mod with no rule deciding which deploys, so which DLL a player ` +
          `ends up with is not decided by this collection:`,
        ...judgement.undeterminedConflicts.map((c) => `  • ${c.path}: ${c.mods.join(" / ")}`),
        `A before/after rule between them settles it.`,
      ].join("\n"),
    );
  }
  if (judgement.unknown.length > 0) {
    const n = judgement.unknown.length;
    out.push(
      `${n} script-extender plugin${n === 1 ? "" : "s"} could not be judged, so ` +
        `whether ${n === 1 ? "it loads" : "they load"} on ${gameLabel} is unknown: ` +
        judgement.unknown.map((f) => `${f.path} (${f.why})`).join("; ") +
        `.`,
    );
  }
  return out;
}
