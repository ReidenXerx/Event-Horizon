/**
 * The workbench's view model: one list of mods, seen through one of several
 * VIEWS, with everything a row needs to say precomputed once.
 *
 * The page used to be six independent cards, each with its own table, its
 * own tick set and its own button row — "Updates", "Frozen", "Selected",
 * two "Disk cleanup"s and "Duplicates" — so the same mod appeared in three
 * places with three different checkboxes, and the action for a row lived a
 * screen away from the row. A view is a filter over the SAME rows; the
 * selection is one set; the actions follow the selection.
 *
 * Pure, so the whole thing is tested without React.
 */

import {
  findDuplicates,
  findFrozen,
  findManualUpdates,
  findUpdatable,
  findUpdateShadowed,
  type CuratorMod,
} from "../../../core/curator/profileActions";
import {
  describeRequirementCell,
  type ModRequirementReport,
  type RequirementsReport,
} from "../../../core/curator/requirements";

export type ViewId =
  | "all"
  | "updates"
  | "manual"
  | "frozen"
  | "requirements"
  | "dependants"
  | "duplicates"
  | "disabled"
  | "outside-data"
  | "not-nexus";

export type ViewSpec = {
  id: ViewId;
  label: string;
  /** One sentence under the table, said once. */
  description: string;
};

export const VIEWS: readonly ViewSpec[] = [
  { id: "all", label: "All mods", description: "Every mod Vortex has for this game, enabled or not." },
  {
    id: "updates",
    label: "Updates",
    description:
      "Mods with a newer file on Nexus that can be installed from here, one at a time, each checked against its archive. Frozen mods are not listed.",
  },
  {
    id: "manual",
    label: "Manual updates",
    description:
      "Nexus has a newer version but did not say which file: these have to be updated from the mod page.",
  },
  {
    id: "frozen",
    label: "Frozen",
    description:
      "Held at a version. A freeze keeps a mod out of bulk update; if Vortex's own update button moves it anyway, it shows as drifted here.",
  },
  {
    id: "requirements",
    label: "Missing requirements",
    description:
      "Mods whose Nexus page or plugin header names something this profile does not have — or has installed but disabled.",
  },
  {
    id: "dependants",
    label: "Needed by others",
    description: "Mods something else in this profile depends on. Disabling one of these breaks its dependants.",
  },
  {
    id: "duplicates",
    label: "Duplicates",
    description: "Two installs sharing a Nexus page. The same file twice is a mistake; two different files can be deliberate.",
  },
  { id: "disabled", label: "Disabled", description: "Installed for this game but not enabled in the active profile." },
  {
    id: "outside-data",
    label: "Outside Data",
    description: "Mods whose kind deploys them to the game root or elsewhere — script extenders, ENB, injectors.",
  },
  { id: "not-nexus", label: "Not from Nexus", description: "Hand-added archives: no page, no update check, no requirements to read." },
];

export type WorkRow = {
  mod: CuratorMod;
  /** From → to, when an automatic update is available. */
  update?: { from: string; to: string; toFileId: number };
  /** Nexus has a newer version but no file id. */
  manual?: { from: string; to: string; url?: string };
  frozen?: { at: string; driftedTo?: string; updateWithheld: boolean };
  /** Other installs on the same Nexus page. */
  duplicateOf?: { kind: "same-file" | "same-page"; others: string[] };
  /** This install is older than another install of the same file. */
  shadowedBy?: string;
  requirements?: ModRequirementReport;
  requirementCell: string;
  /** Vortex mod ids that require this one. */
  requiredBy: string[];
};

export function buildRows(mods: readonly CuratorMod[], report: RequirementsReport | undefined): WorkRow[] {
  const updatable = new Map(findUpdatable(mods).map((c) => [c.mod.id, c]));
  const manual = new Map(findManualUpdates(mods).map((m) => [m.mod.id, m]));
  const frozen = new Map(findFrozen(mods).map((f) => [f.mod.id, f]));
  const shadowed = new Map(findUpdateShadowed(mods).map((s) => [s.mod.id, s]));
  const dupOf = new Map<string, { kind: "same-file" | "same-page"; others: string[] }>();
  for (const g of findDuplicates(mods)) {
    for (const m of g.mods) {
      dupOf.set(m.id, {
        kind: g.kind === "same-file" ? "same-file" : "same-page",
        others: g.mods.filter((o) => o.id !== m.id).map((o) => o.name),
      });
    }
  }
  return mods.map((mod) => {
    const u = updatable.get(mod.id);
    const m = manual.get(mod.id);
    const f = frozen.get(mod.id);
    const s = shadowed.get(mod.id);
    const d = dupOf.get(mod.id);
    const req = report?.byMod.get(mod.id);
    const row: WorkRow = {
      mod,
      requirementCell: describeRequirementCell(req),
      requiredBy: report?.requiredBy.get(mod.id) ?? [],
    };
    if (u !== undefined) row.update = { from: u.fromVersion, to: u.toVersion, toFileId: u.toFileId };
    if (m !== undefined) row.manual = { from: m.fromVersion, to: m.toVersion, ...(m.url === undefined ? {} : { url: m.url }) };
    if (f !== undefined) {
      row.frozen = {
        at: f.frozenAtVersion,
        updateWithheld: f.updateWithheld,
        ...(f.driftedTo === undefined ? {} : { driftedTo: f.driftedTo }),
      };
    }
    if (d !== undefined) row.duplicateOf = d;
    if (s !== undefined) row.shadowedBy = s.newerInstall.name;
    if (req !== undefined) row.requirements = req;
    return row;
  });
}

/**
 * The mod types that deploy OUTSIDE the game's Data folder, from where Vortex
 * itself deploys each type for this game.
 *
 * `modPaths` is `selectors.modPathsForGame(state, gameId)` — Vortex's
 * `game.getModPaths(discoveryPath)`: `""` is the default mod path (Data, for
 * a Bethesda game) and every other key is a type id with its own target. A
 * type whose target is neither that folder nor inside it deploys outside Data
 * — a script extender or ENB to the game root, whatever a game extension
 * registers. A fixed list of kinds knew three names and was wrong for every
 * other type and every game that places one differently.
 *
 * Undefined when Vortex gives no paths (the game is not discovered): nothing
 * is then claimed to be outside.
 */
export function outsideDataTypes(modPaths: Readonly<Record<string, string>> | undefined): ReadonlySet<string> | undefined {
  const dataPath = modPaths?.[""];
  if (modPaths === undefined || typeof dataPath !== "string" || dataPath === "") return undefined;
  const norm = (p: string): string => p.replace(/[\\/]+/g, "/").replace(/\/$/, "").toLowerCase();
  const data = norm(dataPath);
  const out = new Set<string>();
  for (const [typeId, target] of Object.entries(modPaths)) {
    if (typeId === "" || typeof target !== "string" || target === "") continue;
    const t = norm(target);
    if (t === data || t.startsWith(`${data}/`)) continue;
    out.add(typeId.toLowerCase());
  }
  return out;
}

export type ViewOptions = {
  /** Count disabled mods' missing requirements too (default: enabled only — settled with the user). */
  includeDisabled?: boolean;
  /** Mod types that deploy outside Data (see {@link outsideDataTypes}); absent = unknown, the view is empty. */
  outsideDataTypes?: ReadonlySet<string>;
};

export function rowsForView(rows: readonly WorkRow[], view: ViewId, opts: ViewOptions = {}): WorkRow[] {
  switch (view) {
    case "all":
      return [...rows];
    case "updates":
      return rows.filter((r) => r.update !== undefined);
    case "manual":
      return rows.filter((r) => r.manual !== undefined);
    case "frozen":
      return rows.filter((r) => r.frozen !== undefined);
    case "requirements":
      return rows.filter(
        (r) =>
          (opts.includeDisabled === true || r.mod.enabled) &&
          (r.requirements?.requirements ?? []).some((q) => q.status === "missing" || q.status === "installed-disabled"),
      );
    case "dependants":
      return rows.filter((r) => r.requiredBy.length > 0);
    case "duplicates":
      return rows.filter((r) => r.duplicateOf !== undefined);
    case "disabled":
      return rows.filter((r) => !r.mod.enabled);
    case "outside-data": {
      const outside = opts.outsideDataTypes;
      if (outside === undefined) return [];
      return rows.filter((r) => r.mod.modType !== "" && outside.has(r.mod.modType.toLowerCase()));
    }
    case "not-nexus":
      return rows.filter((r) => r.mod.nexusModId === undefined || (r.mod.source !== undefined && r.mod.source !== "nexus"));
    default: {
      const exhaustive: never = view;
      void exhaustive;
      return [...rows];
    }
  }
}

/**
 * Several views at once: the rows in EVERY active view ("updatable AND
 * frozen", "disabled AND needed by others"). An empty set is "all".
 */
export function rowsForViews(rows: readonly WorkRow[], views: ReadonlySet<ViewId>, opts: ViewOptions = {}): WorkRow[] {
  let out = [...rows];
  for (const v of views) {
    if (v === "all") continue;
    const keep = new Set(rowsForView(rows, v, opts).map((r) => r.mod.id));
    out = out.filter((r) => keep.has(r.mod.id));
  }
  return out;
}

/**
 * A search over what a curator knows a mod by: its name, the names of what
 * it requires (a page, a master), and the names of the mods that provide
 * them — so "who needs SkyUI" is a search, not a scroll.
 */
export function matchesSearch(row: WorkRow, query: string, modNameById: ReadonlyMap<string, string>): boolean {
  const q = query.trim().toLowerCase();
  if (q === "") return true;
  if (row.mod.name.toLowerCase().includes(q)) return true;
  if (row.mod.id.toLowerCase().includes(q)) return true;
  for (const req of row.requirements?.requirements ?? []) {
    if (req.name.toLowerCase().includes(q)) return true;
    if (req.master !== undefined && req.master.toLowerCase().includes(q)) return true;
    if (req.plugin !== undefined && req.plugin.toLowerCase().includes(q)) return true;
    for (const id of req.satisfiedBy) if ((modNameById.get(id) ?? "").toLowerCase().includes(q)) return true;
  }
  for (const id of row.requiredBy) if ((modNameById.get(id) ?? "").toLowerCase().includes(q)) return true;
  return false;
}

/** The count each chip shows. */
export function viewCounts(rows: readonly WorkRow[], opts: ViewOptions = {}): Record<ViewId, number> {
  const out = {} as Record<ViewId, number>;
  for (const v of VIEWS) out[v.id] = rowsForView(rows, v.id, opts).length;
  return out;
}

/** The chips worth showing: "All" always; the rest when they have something. */
export function visibleViews(counts: Record<ViewId, number>): ViewSpec[] {
  return VIEWS.filter((v) => v.id === "all" || counts[v.id] > 0);
}

/** A row's one-line status for the table. */
export function describeRowState(r: WorkRow): string {
  if (r.frozen?.driftedTo !== undefined) return `frozen, drifted to ${r.frozen.driftedTo}`;
  if (r.frozen !== undefined) return r.frozen.updateWithheld ? "frozen, update withheld" : "frozen";
  if (r.update !== undefined) return `update ${r.update.to}`;
  if (r.manual !== undefined) return `manual update ${r.manual.to}`;
  return r.mod.enabled ? "enabled" : "disabled";
}
