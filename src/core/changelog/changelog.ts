/**
 * ──────────────────────────────────────────────────────────────────────
 * The changelog Event Horizon writes itself.
 *
 * Owner request 2026-09-15: writing a changelog by hand is a hassle when the
 * build already knows what changed. Settled by poll: it covers everything EH
 * tracks, users see it inside EH, the curator's own words go on top, a Nexus
 * BBCode copy is offered, and the full history is kept.
 *
 * ─── SNAPSHOTS, NOT MANIFESTS ──────────────────────────────────────────
 * A manifest carries every staged file of every mod; on a 1,755-mod collection
 * that is hundreds of thousands of entries. The history has to keep the last
 * build around until the next one, so each build is reduced to a SNAPSHOT: a
 * few fields per mod (with the staged files folded into one stat-only shape,
 * as the build diff already does), the plugin order, the load order, rules,
 * INI settings, prerequisites and requirements.
 *
 * ─── MATCHED THE WAY THE BUILD DIFF MATCHES ────────────────────────────
 * Mods pair up exactly as `diffCollectionAgainstProfile` pairs a profile with
 * a package: the same key first; then the same Nexus page, which is an update
 * (preferring the same name, since one page often ships several installs);
 * then the name, only where one side has no Nexus key. Anything compared by
 * name, and any check one side could not answer, is counted rather than
 * folded into "unchanged" — the same rule as `CollectionDiff`.
 *
 * Pure: no disk and no clock. The build decides what to compare and when.
 * ──────────────────────────────────────────────────────────────────────
 */

import { compareSelections } from "../curator/fomodSelectionDiff";
import { compareShapes, stagingShapeOf } from "../curator/stagingShape";
import type { FomodSelectionStep } from "../getModsListForProfile";
import type { EhcollManifest, EhcollMod } from "../../types/ehcoll";

// ===========================================================================
// Snapshot
// ===========================================================================

/**
 * How a mod reaches the person installing.
 *  - `download`: fetched from Nexus as the author published it.
 *  - `mirrored`: fetched from its source, then the curator's changes applied.
 *  - `bundled`:  shipped inside the package.
 *  - `manual`:   an external mod the user fetches by hand.
 */
export type ModDelivery = "download" | "mirrored" | "bundled" | "manual";

export type SnapshotMod = {
  compareKey: string;
  name: string;
  version?: string;
  enabled: boolean;
  delivery: ModDelivery;
  fomodSelections: FomodSelectionStep[];
  /** The build PROVED an empty answer set (NS-8). */
  emptySelectionVerified?: boolean;
  /** Stat-only fingerprint of the staged files. Absent when none were recorded. */
  stagingShape?: string;
  /** Vortex INI tweaks the curator enabled on this mod, sorted. */
  iniTweaks?: string[];
};

export type ChangelogSnapshot = {
  schema: 1;
  version: string;
  game: { version: string; versionPolicy: string };
  /** Required Vortex extensions, as "id" or "id minVersion". */
  requiredExtensions: string[];
  mods: SnapshotMod[];
  plugins: Array<{ name: string; enabled: boolean; light?: boolean }>;
  /** Load-order compareKeys, in position order. */
  loadOrder: string[];
  /** Rules that are not ignored, as "source|type|reference". */
  rules: string[];
  /** Collection-level INI tweaks, as "ini|section|key=value". */
  iniTweaks: string[];
  gameIni: IniSetting[];
  externalDependencies: Array<{ id: string; name: string; version: string }>;
};

export type IniSetting = { file: string; section: string; key: string; value: string };

function deliveryOf(mod: EhcollMod): ModDelivery {
  if (mod.state?.mirrored === true) return "mirrored";
  if (mod.source.kind === "nexus") return "download";
  return mod.source.bundled ? "bundled" : "manual";
}

/** Reduce a manifest to what the changelog compares. */
export function snapshotManifest(manifest: EhcollManifest): ChangelogSnapshot {
  return {
    schema: 1,
    version: manifest.package.version,
    game: {
      version: manifest.game.version,
      versionPolicy: manifest.game.versionPolicy,
    },
    requiredExtensions: (manifest.vortex?.requiredExtensions ?? []).map((e) =>
      e.minVersion !== undefined ? `${e.id} ${e.minVersion}` : e.id,
    ),
    mods: manifest.mods.map((mod) => {
      const tweaks = [...(mod.state?.enabledINITweaks ?? [])].sort();
      return {
        compareKey: mod.compareKey,
        name: mod.name,
        ...(mod.version !== undefined ? { version: mod.version } : {}),
        // Absent means enabled, as in summarizeBuiltMods.
        enabled: mod.state?.enabled !== false,
        delivery: deliveryOf(mod),
        fomodSelections: mod.install?.fomodSelections ?? [],
        ...(mod.install?.emptySelectionVerified === true
          ? { emptySelectionVerified: true }
          : {}),
        ...(mod.state?.stagingFiles !== undefined && mod.state.stagingFiles.length > 0
          ? { stagingShape: stagingShapeOf(mod.state.stagingFiles) }
          : {}),
        ...(tweaks.length > 0 ? { iniTweaks: tweaks } : {}),
      };
    }),
    plugins: (manifest.plugins?.order ?? []).map((p) => ({
      name: p.name,
      enabled: p.enabled,
      ...(p.light !== undefined ? { light: p.light } : {}),
    })),
    loadOrder: [...(manifest.loadOrder ?? [])]
      .sort((a, b) => a.pos - b.pos)
      .map((e) => e.compareKey),
    rules: (manifest.rules ?? [])
      .filter((r) => r.ignored !== true)
      .map((r) => `${r.source}|${r.type}|${r.reference}`),
    iniTweaks: (manifest.iniTweaks ?? []).map(
      (t) => `${t.ini}|${t.section}|${t.key}=${t.value}`,
    ),
    gameIni: (manifest.gameIni?.files ?? []).flatMap((f) =>
      f.settings.map((s) => ({
        file: f.fileName,
        section: s.section,
        key: s.key,
        value: s.value,
      })),
    ),
    externalDependencies: (manifest.externalDependencies ?? []).map((d) => ({
      id: d.id,
      name: d.name,
      version: d.version,
    })),
  };
}

// ===========================================================================
// Changes
// ===========================================================================

export type ModLine = { name: string; version?: string };
export type RuleLine = { mod: string; type: string; other: string };

export type ChangelogChanges = {
  mods: {
    added: ModLine[];
    removed: ModLine[];
    /** Same mod, different version or file. */
    updated: Array<{ name: string; from: string; to: string }>;
    enabled: string[];
    disabled: string[];
    /** Same mod and file, different contents. */
    reconfigured: Array<{ name: string; reason: "installer-options" | "staged-files" }>;
    delivery: Array<{ name: string; from: ModDelivery; to: ModDelivery }>;
    iniTweaks: Array<{ name: string; on: string[]; off: string[] }>;
  };
  plugins: {
    added: string[];
    removed: string[];
    enabled: string[];
    disabled: string[];
    madeLight: string[];
    madeFull: string[];
    /** The fewest plugins whose moves explain the new order. */
    moved: string[];
  };
  /** Mods whose load-order position moved, by name. */
  loadOrderMoved: string[];
  rules: { added: RuleLine[]; removed: RuleLine[] };
  iniTweaks: { added: string[]; removed: string[] };
  gameIni: {
    added: IniSetting[];
    removed: IniSetting[];
    changed: Array<IniSetting & { from: string }>;
  };
  prerequisites: {
    added: string[];
    removed: string[];
    updated: Array<{ name: string; from: string; to: string }>;
  };
  requirements: {
    game?: { from: string; to: string };
    extensionsAdded: string[];
    extensionsRemoved: string[];
  };
  /** Checks that could not be completed. Counted, never read as "unchanged". */
  unknown: { installerOptions: number; stagedFiles: number; matchedByName: number };
};

function emptyChanges(): ChangelogChanges {
  return {
    mods: {
      added: [],
      removed: [],
      updated: [],
      enabled: [],
      disabled: [],
      reconfigured: [],
      delivery: [],
      iniTweaks: [],
    },
    plugins: {
      added: [],
      removed: [],
      enabled: [],
      disabled: [],
      madeLight: [],
      madeFull: [],
      moved: [],
    },
    loadOrderMoved: [],
    rules: { added: [], removed: [] },
    iniTweaks: { added: [], removed: [] },
    gameIni: { added: [], removed: [], changed: [] },
    prerequisites: { added: [], removed: [], updated: [] },
    requirements: { extensionsAdded: [], extensionsRemoved: [] },
    unknown: { installerOptions: 0, stagedFiles: 0, matchedByName: 0 },
  };
}

/** The Nexus mod id inside a `nexus:<modId>:<fileId>` key. */
function pageOf(compareKey: string): string | undefined {
  const parts = compareKey.split(":");
  return parts[0] === "nexus" && parts.length === 3 ? parts[1] : undefined;
}

const line = (m: SnapshotMod): ModLine => ({
  name: m.name,
  ...(m.version !== undefined ? { version: m.version } : {}),
});

function push<K, V>(index: Map<K, V[]>, key: K, value: V): void {
  const list = index.get(key);
  if (list === undefined) index.set(key, [value]);
  else list.push(value);
}

/**
 * Items present in both orders that MOVED, in their new order.
 *
 * "Moved" is the fewest items whose relocation turns the old order into the
 * new: everything outside a longest increasing run of old positions. Moving
 * one plugin from the bottom to the top shifts every plugin between, and
 * listing all of them would bury the one move the curator made.
 */
export function movedInOrder(
  before: readonly string[],
  after: readonly string[],
): string[] {
  const position = new Map<string, number>();
  before.forEach((k, i) => {
    if (!position.has(k)) position.set(k, i);
  });
  const common = after.filter((k) => position.has(k));
  const seq = common.map((k) => position.get(k) as number);
  // Longest increasing subsequence, patience-sorting style, with back links.
  const tails: number[] = [];
  const tailAt: number[] = [];
  const back: number[] = new Array<number>(seq.length).fill(-1);
  for (let i = 0; i < seq.length; i++) {
    const v = seq[i] as number;
    let lo = 0;
    let hi = tails.length;
    while (lo < hi) {
      const mid = Math.floor((lo + hi) / 2);
      if ((tails[mid] as number) < v) lo = mid + 1;
      else hi = mid;
    }
    tails[lo] = v;
    tailAt[lo] = i;
    back[i] = lo > 0 ? (tailAt[lo - 1] as number) : -1;
  }
  const kept = new Set<number>();
  for (let i = tails.length > 0 ? (tailAt[tails.length - 1] as number) : -1; i >= 0; i = back[i] as number) {
    kept.add(i);
  }
  return common.filter((_, i) => !kept.has(i));
}

const iniKey = (s: IniSetting): string =>
  `${s.file.toLowerCase()}|${s.section.toLowerCase()}|${s.key.toLowerCase()}`;

/** What changed from one build of a collection to the next. */
export function diffSnapshots(
  prev: ChangelogSnapshot,
  next: ChangelogSnapshot,
): ChangelogChanges {
  const changes = emptyChanges();
  diffMods(prev, next, changes);
  diffPlugins(prev, next, changes);

  const nameOf = new Map<string, string>();
  for (const m of prev.mods) nameOf.set(m.compareKey, m.name);
  for (const m of next.mods) nameOf.set(m.compareKey, m.name);

  changes.loadOrderMoved = movedInOrder(prev.loadOrder, next.loadOrder).map(
    (k) => nameOf.get(k) ?? k,
  );

  const describeRule = (rule: string): RuleLine => {
    const [source = "", type = "", reference = ""] = rule.split("|");
    return { mod: modName(nameOf, source), type, other: modName(nameOf, reference) };
  };
  const prevRules = new Set(prev.rules);
  const nextRules = new Set(next.rules);
  changes.rules.added = next.rules.filter((r) => !prevRules.has(r)).map(describeRule);
  changes.rules.removed = prev.rules.filter((r) => !nextRules.has(r)).map(describeRule);

  const prevTweaks = new Set(prev.iniTweaks);
  const nextTweaks = new Set(next.iniTweaks);
  changes.iniTweaks.added = next.iniTweaks.filter((t) => !prevTweaks.has(t));
  changes.iniTweaks.removed = prev.iniTweaks.filter((t) => !nextTweaks.has(t));

  const prevIni = new Map(prev.gameIni.map((s) => [iniKey(s), s]));
  const nextIni = new Map(next.gameIni.map((s) => [iniKey(s), s]));
  for (const s of next.gameIni) {
    const was = prevIni.get(iniKey(s));
    if (was === undefined) changes.gameIni.added.push(s);
    else if (was.value !== s.value) changes.gameIni.changed.push({ ...s, from: was.value });
  }
  for (const s of prev.gameIni) {
    if (!nextIni.has(iniKey(s))) changes.gameIni.removed.push(s);
  }

  const prevDeps = new Map(prev.externalDependencies.map((d) => [d.id, d]));
  const nextDeps = new Map(next.externalDependencies.map((d) => [d.id, d]));
  for (const d of next.externalDependencies) {
    const was = prevDeps.get(d.id);
    if (was === undefined) changes.prerequisites.added.push(d.name);
    else if (was.version !== d.version) {
      changes.prerequisites.updated.push({ name: d.name, from: was.version, to: d.version });
    }
  }
  for (const d of prev.externalDependencies) {
    if (!nextDeps.has(d.id)) changes.prerequisites.removed.push(d.name);
  }

  const gameLabel = (s: ChangelogSnapshot): string =>
    `${s.game.version} (${s.game.versionPolicy})`;
  if (
    prev.game.version !== next.game.version ||
    prev.game.versionPolicy !== next.game.versionPolicy
  ) {
    changes.requirements.game = { from: gameLabel(prev), to: gameLabel(next) };
  }
  const prevExt = new Set(prev.requiredExtensions);
  const nextExt = new Set(next.requiredExtensions);
  changes.requirements.extensionsAdded = next.requiredExtensions.filter((e) => !prevExt.has(e));
  changes.requirements.extensionsRemoved = prev.requiredExtensions.filter((e) => !nextExt.has(e));

  return changes;
}

/**
 * A mod named by a rule. A rule may pin a whole Nexus page ("nexus:1234"), in
 * which case any file from that page names it.
 */
function modName(nameOf: ReadonlyMap<string, string>, key: string): string {
  const exact = nameOf.get(key);
  if (exact !== undefined) return exact;
  for (const [k, name] of nameOf) {
    if (k.startsWith(`${key}:`)) return name;
  }
  return key;
}

function diffMods(prev: ChangelogSnapshot, next: ChangelogSnapshot, changes: ChangelogChanges): void {
  const claimed = new Set<string>();
  const prevByKey = new Map<string, SnapshotMod>();
  const prevByPage = new Map<string, SnapshotMod[]>();
  const prevByName = new Map<string, SnapshotMod[]>();
  for (const m of prev.mods) {
    prevByKey.set(m.compareKey, m);
    const page = pageOf(m.compareKey);
    if (page !== undefined) push(prevByPage, page, m);
    push(prevByName, m.name, m);
  }
  const take = (
    list: SnapshotMod[] | undefined,
    accept?: (m: SnapshotMod) => boolean,
  ): SnapshotMod | undefined =>
    list?.find((m) => !claimed.has(m.compareKey) && (accept === undefined || accept(m)));

  /** State that can change on any pairing: switched on or off, delivered differently. */
  const compareState = (was: SnapshotMod, now: SnapshotMod): void => {
    if (was.enabled !== now.enabled) {
      (now.enabled ? changes.mods.enabled : changes.mods.disabled).push(now.name);
    }
    if (was.delivery !== now.delivery) {
      changes.mods.delivery.push({ name: now.name, from: was.delivery, to: now.delivery });
    }
    const before = new Set(was.iniTweaks ?? []);
    const after = new Set(now.iniTweaks ?? []);
    const on = [...after].filter((t) => !before.has(t));
    const off = [...before].filter((t) => !after.has(t));
    if (on.length > 0 || off.length > 0) {
      changes.mods.iniTweaks.push({ name: now.name, on, off });
    }
  };

  /** The same mod and the same file: compare what is inside it. */
  const settle = (was: SnapshotMod, now: SnapshotMod, byName: boolean): void => {
    claimed.add(was.compareKey);
    if (byName) changes.unknown.matchedByName += 1;
    compareState(was, now);
    const options = compareSelections(
      was.fomodSelections,
      now.fomodSelections,
      was.emptySelectionVerified === true,
    );
    if (options === "differ") {
      changes.mods.reconfigured.push({ name: now.name, reason: "installer-options" });
    } else if (options === "unknown") {
      changes.unknown.installerOptions += 1;
    }
    const files = compareShapes(was.stagingShape, now.stagingShape);
    // A re-run installer changes the files too; one event, reported once.
    if (files === "differ" && options !== "differ") {
      changes.mods.reconfigured.push({ name: now.name, reason: "staged-files" });
    } else if (files === "unknown") {
      changes.unknown.stagedFiles += 1;
    }
  };

  const update = (was: SnapshotMod, now: SnapshotMod): void => {
    claimed.add(was.compareKey);
    changes.mods.updated.push({
      name: now.name,
      from: was.version ?? "unknown",
      to: now.version ?? "unknown",
    });
    compareState(was, now);
  };

  // Pass 1: the same key.
  const pending: SnapshotMod[] = [];
  for (const now of next.mods) {
    const was = prevByKey.get(now.compareKey);
    if (was !== undefined && !claimed.has(was.compareKey)) settle(was, now, false);
    else pending.push(now);
  }

  // Pass 2: the same Nexus page with a different file is an update.
  const stillPending: SnapshotMod[] = [];
  for (const now of pending) {
    const page = pageOf(now.compareKey);
    const fromPage = page === undefined ? undefined : prevByPage.get(page);
    const was = take(fromPage, (m) => m.name === now.name) ?? take(fromPage);
    if (was === undefined) stillPending.push(now);
    else update(was, now);
  }

  // Pass 3: the name, only where one side has no Nexus key to compare.
  for (const now of stillPending) {
    const was = take(
      prevByName.get(now.name),
      (m) => pageOf(now.compareKey) === undefined || pageOf(m.compareKey) === undefined,
    );
    if (was === undefined) {
      changes.mods.added.push(line(now));
    } else if (was.version !== undefined && now.version !== undefined && was.version !== now.version) {
      changes.unknown.matchedByName += 1;
      update(was, now);
    } else {
      settle(was, now, true);
    }
  }

  for (const was of prev.mods) {
    if (!claimed.has(was.compareKey)) changes.mods.removed.push(line(was));
  }
}

function diffPlugins(prev: ChangelogSnapshot, next: ChangelogSnapshot, changes: ChangelogChanges): void {
  const key = (name: string): string => name.toLowerCase();
  const prevPlugins = new Map(prev.plugins.map((p) => [key(p.name), p]));
  const nextPlugins = new Map(next.plugins.map((p) => [key(p.name), p]));
  for (const p of next.plugins) {
    const was = prevPlugins.get(key(p.name));
    if (was === undefined) {
      changes.plugins.added.push(p.name);
      continue;
    }
    if (was.enabled !== p.enabled) {
      (p.enabled ? changes.plugins.enabled : changes.plugins.disabled).push(p.name);
    }
    // Unknown on either side says nothing (see EhcollPluginEntry.light).
    if (was.light !== undefined && p.light !== undefined && was.light !== p.light) {
      (p.light ? changes.plugins.madeLight : changes.plugins.madeFull).push(p.name);
    }
  }
  for (const p of prev.plugins) {
    if (!nextPlugins.has(key(p.name))) changes.plugins.removed.push(p.name);
  }
  changes.plugins.moved = movedInOrder(
    prev.plugins.map((p) => key(p.name)),
    next.plugins.map((p) => key(p.name)),
  ).map((k) => nextPlugins.get(k)?.name ?? k);
}

// ===========================================================================
// Entries and history
// ===========================================================================

export type ChangelogEntry = {
  version: string;
  /** ISO time of the build that produced it. */
  date: string;
  /** The curator's own words, markdown, shown above the generated list. */
  notes?: string;
  /** What changed since the previous version. Absent on a first release. */
  changes?: ChangelogChanges;
  /** Present on a first release: what the collection starts with. */
  firstRelease?: { mods: number; plugins: number };
};

/**
 * What the curator side keeps between builds, next to the collection config.
 *
 * `last` is the snapshot of the most recent build. `beforeLast` is the last
 * snapshot of the version before it, which is what a REBUILD of the same
 * version compares against: rebuilding 1.0.27 must still say what changed
 * since 1.0.26, not "nothing since the previous 1.0.27".
 */
export type ChangelogHistory = {
  schema: 1;
  /** Newest first. */
  entries: ChangelogEntry[];
  last?: ChangelogSnapshot;
  beforeLast?: ChangelogSnapshot;
};

/**
 * Record one build: its entry, and the history to keep afterwards.
 *
 * `previousPackage` is the snapshot of the newest package already on disk, for
 * a collection whose history began after its last release. Notes left blank on
 * a rebuild keep the notes that version already had.
 */
export function recordBuild(
  history: ChangelogHistory | undefined,
  next: ChangelogSnapshot,
  opts: { date: string; notes?: string; previousPackage?: ChangelogSnapshot },
): { entry: ChangelogEntry; history: ChangelogHistory } {
  const entries = history?.entries ?? [];
  const last = history?.last ?? opts.previousPackage;
  const rebuild = last !== undefined && last.version === next.version;
  const base = rebuild ? history?.beforeLast : last;
  const typed = opts.notes?.trim() ?? "";
  const notes = typed !== "" ? typed : entries.find((e) => e.version === next.version)?.notes;
  const entry: ChangelogEntry = {
    version: next.version,
    date: opts.date,
    ...(notes !== undefined ? { notes } : {}),
    ...(base !== undefined
      ? { changes: diffSnapshots(base, next) }
      : { firstRelease: { mods: next.mods.length, plugins: next.plugins.length } }),
  };
  const beforeLast = rebuild ? history?.beforeLast : last;
  return {
    entry,
    history: {
      schema: 1,
      entries: [entry, ...entries.filter((e) => e.version !== next.version)],
      last: next,
      ...(beforeLast !== undefined ? { beforeLast } : {}),
    },
  };
}

// ===========================================================================
// Words
// ===========================================================================

const DELIVERY_WORDS: Record<ModDelivery, string> = {
  download: "downloaded from Nexus",
  mirrored: "mirrored",
  bundled: "bundled in the package",
  manual: "manual download",
};

const RULE_WORDS: Record<string, string> = {
  before: "loads before",
  after: "loads after",
  requires: "requires",
  recommends: "recommends",
  conflicts: "conflicts with",
  provides: "provides",
};

const withVersion = (m: ModLine): string =>
  m.version !== undefined ? `${m.name} ${m.version}` : m.name;

const plural = (n: number, one: string, many: string = `${one}s`): string =>
  `${n} ${n === 1 ? one : many}`;

export type ChangeSection = { title: string; lines: string[] };

/** Every non-empty group of changes, in reading order. Shared by every renderer. */
export function changeSections(c: ChangelogChanges): ChangeSection[] {
  const sections: ChangeSection[] = [];
  const add = (title: string, lines: string[]): void => {
    if (lines.length > 0) sections.push({ title, lines });
  };
  add("Mods added", c.mods.added.map(withVersion));
  add("Mods removed", c.mods.removed.map(withVersion));
  add("Mods updated", c.mods.updated.map((u) => `${u.name}: ${u.from} → ${u.to}`));
  add("Mods switched on", c.mods.enabled);
  add("Mods switched off", c.mods.disabled);
  add(
    "Re-installed with different installer options",
    c.mods.reconfigured.filter((r) => r.reason === "installer-options").map((r) => r.name),
  );
  add(
    "Files changed inside",
    c.mods.reconfigured.filter((r) => r.reason === "staged-files").map((r) => r.name),
  );
  add(
    "Delivered differently",
    c.mods.delivery.map((d) => `${d.name}: ${DELIVERY_WORDS[d.from]} → ${DELIVERY_WORDS[d.to]}`),
  );
  add(
    "Mod INI tweaks",
    c.mods.iniTweaks.map((t) =>
      [
        t.name,
        ...(t.on.length > 0 ? [`on: ${t.on.join(", ")}`] : []),
        ...(t.off.length > 0 ? [`off: ${t.off.join(", ")}`] : []),
      ].join("; "),
    ),
  );
  add("Plugins added", c.plugins.added);
  add("Plugins removed", c.plugins.removed);
  add("Plugins switched on", c.plugins.enabled);
  add("Plugins switched off", c.plugins.disabled);
  add("Plugins flagged light (ESL)", c.plugins.madeLight);
  add("Plugins no longer light", c.plugins.madeFull);
  add("Plugins moved in the load order", c.plugins.moved);
  add("Mods moved in the load order", c.loadOrderMoved);
  add(
    "Rules added",
    c.rules.added.map((r) => `${r.mod} ${RULE_WORDS[r.type] ?? r.type} ${r.other}`),
  );
  add(
    "Rules removed",
    c.rules.removed.map((r) => `${r.mod} ${RULE_WORDS[r.type] ?? r.type} ${r.other}`),
  );
  add("Game settings", [
    ...c.gameIni.changed.map((s) => `${s.file} [${s.section}] ${s.key}: ${s.from} → ${s.value}`),
    ...c.gameIni.added.map((s) => `${s.file} [${s.section}] ${s.key} = ${s.value} (new)`),
    ...c.gameIni.removed.map((s) => `${s.file} [${s.section}] ${s.key} (no longer set)`),
  ]);
  add("INI tweaks", [
    ...c.iniTweaks.added.map((t) => `${t.replace(/\|/g, " ")} (new)`),
    ...c.iniTweaks.removed.map((t) => `${t.replace(/\|/g, " ")} (removed)`),
  ]);
  add("Prerequisites", [
    ...c.prerequisites.added.map((n) => `${n} (new)`),
    ...c.prerequisites.updated.map((u) => `${u.name}: ${u.from} → ${u.to}`),
    ...c.prerequisites.removed.map((n) => `${n} (no longer needed)`),
  ]);
  add("Requirements", [
    ...(c.requirements.game !== undefined
      ? [`Game version: ${c.requirements.game.from} → ${c.requirements.game.to}`]
      : []),
    ...c.requirements.extensionsAdded.map((e) => `Needs Vortex extension ${e}`),
    ...c.requirements.extensionsRemoved.map((e) => `No longer needs Vortex extension ${e}`),
  ]);
  return sections;
}

/** The totals line above an entry. */
export function summarizeEntry(entry: ChangelogEntry): string {
  if (entry.changes === undefined) {
    const first = entry.firstRelease;
    return first !== undefined
      ? `First release: ${plural(first.mods, "mod")}, ${plural(first.plugins, "plugin")}.`
      : "First release.";
  }
  const c = entry.changes;
  const parts: string[] = [];
  // The first mod figure names the noun ("1 mod removed"), the rest share it.
  const modFigures: Array<[number, string]> = [
    [c.mods.added.length, "added"],
    [c.mods.removed.length, "removed"],
    [c.mods.updated.length, "updated"],
    [c.mods.reconfigured.length, "changed inside"],
    [c.mods.enabled.length + c.mods.disabled.length, "switched on or off"],
  ];
  for (const [n, verb] of modFigures) {
    if (n === 0) continue;
    parts.push(parts.length === 0 ? `${plural(n, "mod")} ${verb}` : `${n} ${verb}`);
  }
  const count = (n: number, one: string, many: string): void => {
    if (n > 0) parts.push(`${n} ${n === 1 ? one : many}`);
  };
  count(
    c.plugins.added.length + c.plugins.removed.length,
    "plugin added or removed",
    "plugins added or removed",
  );
  count(
    c.plugins.moved.length + c.loadOrderMoved.length,
    "moved in the load order",
    "moved in the load order",
  );
  count(c.rules.added.length + c.rules.removed.length, "rule change", "rule changes");
  count(
    c.gameIni.added.length + c.gameIni.removed.length + c.gameIni.changed.length +
      c.iniTweaks.added.length + c.iniTweaks.removed.length +
      c.mods.iniTweaks.length,
    "setting change",
    "setting changes",
  );
  const other = changeSections(c).length - parts.length;
  if (parts.length === 0) {
    return other > 0 ? "Changes to prerequisites or requirements." : "No changes since the previous version.";
  }
  return `${parts.join(", ")}.`;
}

/** Checks that could not be completed, said plainly, or undefined when all ran. */
export function describeUnknowns(c: ChangelogChanges): string | undefined {
  const notes: string[] = [];
  if (c.unknown.matchedByName > 0) {
    notes.push(`${plural(c.unknown.matchedByName, "mod")} could only be matched by name`);
  }
  if (c.unknown.installerOptions > 0) {
    notes.push(`${plural(c.unknown.installerOptions, "mod")} had installer answers on one side only`);
  }
  if (c.unknown.stagedFiles > 0) {
    notes.push(`${plural(c.unknown.stagedFiles, "mod")} had no file list to compare`);
  }
  return notes.length > 0 ? `${notes.join("; ")}.` : undefined;
}

const day = (iso: string): string => iso.slice(0, 10);

/** CHANGELOG.md: the whole history, newest first. */
export function renderChangelogMarkdown(title: string, entries: readonly ChangelogEntry[]): string {
  const out: string[] = [`# ${title} changelog`, ""];
  for (const entry of entries) {
    out.push(`## ${entry.version} (${day(entry.date)})`, "");
    if (entry.notes !== undefined) out.push(entry.notes, "");
    out.push(`**${summarizeEntry(entry)}**`, "");
    if (entry.changes !== undefined) {
      for (const section of changeSections(entry.changes)) {
        out.push(`### ${section.title} (${section.lines.length})`, "");
        for (const l of section.lines) out.push(`- ${l}`);
        out.push("");
      }
      const unknown = describeUnknowns(entry.changes);
      if (unknown !== undefined) out.push(`_Not compared: ${unknown}_`, "");
    }
  }
  return `${out.join("\n").trimEnd()}\n`;
}

/**
 * One version, as BBCode for a Nexus mod page.
 *
 * Long groups are cut at `maxLines` with a count of the rest: a re-sorted load
 * order can move hundreds of plugins, and a description that long is not read.
 * The full list stays in the package and in Event Horizon.
 */
export function renderChangelogBbcode(entry: ChangelogEntry, maxLines = 60): string {
  const out: string[] = [`[size=4][b]Version ${entry.version}[/b][/size]`];
  if (entry.notes !== undefined) out.push("", entry.notes);
  out.push("", `[b]${summarizeEntry(entry)}[/b]`);
  if (entry.changes !== undefined) {
    for (const section of changeSections(entry.changes)) {
      out.push("", `[b]${section.title} (${section.lines.length})[/b]`, "[list]");
      for (const l of section.lines.slice(0, maxLines)) out.push(`[*]${l}`);
      if (section.lines.length > maxLines) {
        out.push(`[*]…and ${section.lines.length - maxLines} more`);
      }
      out.push("[/list]");
    }
  }
  return out.join("\n");
}

// ===========================================================================
// Reading a changelog someone else wrote
// ===========================================================================

const isNumber = (s: string): boolean => /^[0-9]+$/.test(s);

/**
 * Order two version strings part by part, numerically where both parts are
 * numbers ("1.0.10" is after "1.0.9"). A missing part counts as zero, and a
 * label such as "beta" comes before the release it labels. Negative when `a`
 * is the older.
 */
export function compareVersionStrings(a: string, b: string): number {
  const pa = a.split(/[.+-]/);
  const pb = b.split(/[.+-]/);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i];
    const y = pb[i];
    if (x === y) continue;
    if (x === undefined) {
      if (isNumber(y as string)) {
        if (Number(y) === 0) continue;
        return -1;
      }
      return 1;
    }
    if (y === undefined) {
      if (isNumber(x)) {
        if (Number(x) === 0) continue;
        return 1;
      }
      return -1;
    }
    if (isNumber(x) && isNumber(y)) {
      if (Number(x) !== Number(y)) return Number(x) < Number(y) ? -1 : 1;
      continue;
    }
    if (isNumber(x)) return 1;
    if (isNumber(y)) return -1;
    return x < y ? -1 : 1;
  }
  return 0;
}

/**
 * The entries someone updating from `installedVersion` has not seen, newest
 * first. Every entry when nothing is installed.
 */
export function entriesSince(
  entries: readonly ChangelogEntry[],
  installedVersion?: string,
): ChangelogEntry[] {
  if (installedVersion === undefined) return [...entries];
  return entries.filter((e) => compareVersionStrings(e.version, installedVersion) > 0);
}

const asRecord = (v: unknown): Record<string, unknown> | undefined =>
  v !== null && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined;
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const str = (v: unknown): string => (typeof v === "string" ? v : "");
const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
const records = (v: unknown): Array<Record<string, unknown>> =>
  Array.isArray(v)
    ? v.map(asRecord).filter((x): x is Record<string, unknown> => x !== undefined)
    : [];
const DELIVERIES: readonly string[] = ["download", "mirrored", "bundled", "manual"];
const deliveryFrom = (v: unknown): ModDelivery =>
  typeof v === "string" && DELIVERIES.includes(v) ? (v as ModDelivery) : "download";

/**
 * Read `package.changelog` from a manifest.
 *
 * Lenient on purpose: a changelog is for reading, and a malformed one must
 * never stop an install. An entry without a version and a date is dropped and
 * counted; every list inside an entry is filled in when absent, so a changelog
 * written by an older or newer Event Horizon renders instead of breaking the
 * screen. Undefined when the manifest has no changelog at all.
 */
export function readChangelogEntries(
  raw: unknown,
): { entries: ChangelogEntry[]; dropped: number } | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) return { entries: [], dropped: 1 };
  const entries: ChangelogEntry[] = [];
  let dropped = 0;
  for (const item of raw) {
    const o = asRecord(item);
    if (o === undefined || typeof o.version !== "string" || typeof o.date !== "string") {
      dropped += 1;
      continue;
    }
    const changes = asRecord(o.changes);
    const first = asRecord(o.firstRelease);
    entries.push({
      version: o.version,
      date: o.date,
      ...(typeof o.notes === "string" && o.notes.trim() !== "" ? { notes: o.notes } : {}),
      ...(changes !== undefined
        ? { changes: normalizeChanges(changes) }
        : first !== undefined
          ? { firstRelease: { mods: num(first.mods), plugins: num(first.plugins) } }
          : {}),
    });
  }
  return { entries, dropped };
}

function normalizeChanges(o: Record<string, unknown>): ChangelogChanges {
  const mods = asRecord(o.mods) ?? {};
  const plugins = asRecord(o.plugins) ?? {};
  const rules = asRecord(o.rules) ?? {};
  const iniTweaks = asRecord(o.iniTweaks) ?? {};
  const gameIni = asRecord(o.gameIni) ?? {};
  const prerequisites = asRecord(o.prerequisites) ?? {};
  const requirements = asRecord(o.requirements) ?? {};
  const unknown = asRecord(o.unknown) ?? {};
  const game = asRecord(requirements.game);
  const modLine = (r: Record<string, unknown>): ModLine => ({
    name: str(r.name),
    ...(typeof r.version === "string" ? { version: r.version } : {}),
  });
  const ini = (r: Record<string, unknown>): IniSetting => ({
    file: str(r.file),
    section: str(r.section),
    key: str(r.key),
    value: str(r.value),
  });
  const rule = (r: Record<string, unknown>): RuleLine => ({
    mod: str(r.mod),
    type: str(r.type),
    other: str(r.other),
  });
  const change = (r: Record<string, unknown>): { name: string; from: string; to: string } => ({
    name: str(r.name),
    from: str(r.from),
    to: str(r.to),
  });
  return {
    mods: {
      added: records(mods.added).map(modLine),
      removed: records(mods.removed).map(modLine),
      updated: records(mods.updated).map(change),
      enabled: strings(mods.enabled),
      disabled: strings(mods.disabled),
      reconfigured: records(mods.reconfigured).map((r) => ({
        name: str(r.name),
        reason:
          r.reason === "installer-options"
            ? ("installer-options" as const)
            : ("staged-files" as const),
      })),
      delivery: records(mods.delivery).map((r) => ({
        name: str(r.name),
        from: deliveryFrom(r.from),
        to: deliveryFrom(r.to),
      })),
      iniTweaks: records(mods.iniTweaks).map((r) => ({
        name: str(r.name),
        on: strings(r.on),
        off: strings(r.off),
      })),
    },
    plugins: {
      added: strings(plugins.added),
      removed: strings(plugins.removed),
      enabled: strings(plugins.enabled),
      disabled: strings(plugins.disabled),
      madeLight: strings(plugins.madeLight),
      madeFull: strings(plugins.madeFull),
      moved: strings(plugins.moved),
    },
    loadOrderMoved: strings(o.loadOrderMoved),
    rules: { added: records(rules.added).map(rule), removed: records(rules.removed).map(rule) },
    iniTweaks: { added: strings(iniTweaks.added), removed: strings(iniTweaks.removed) },
    gameIni: {
      added: records(gameIni.added).map(ini),
      removed: records(gameIni.removed).map(ini),
      changed: records(gameIni.changed).map((r) => ({ ...ini(r), from: str(r.from) })),
    },
    prerequisites: {
      added: strings(prerequisites.added),
      removed: strings(prerequisites.removed),
      updated: records(prerequisites.updated).map(change),
    },
    requirements: {
      ...(game !== undefined ? { game: { from: str(game.from), to: str(game.to) } } : {}),
      extensionsAdded: strings(requirements.extensionsAdded),
      extensionsRemoved: strings(requirements.extensionsRemoved),
    },
    unknown: {
      installerOptions: num(unknown.installerOptions),
      stagedFiles: num(unknown.stagedFiles),
      matchedByName: num(unknown.matchedByName),
    },
  };
}
