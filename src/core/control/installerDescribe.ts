/**
 * An installer's whole tree, read BEFORE installing, for an agent to choose
 * from. The owner, 2026-09-27: "expose every installer and its steps to agent
 * and it could smartly drive it". Live that night, a patch hub offered patches
 * for mods the collection does not have, which would have added plugins with
 * missing masters; the agent could only tell the owner which boxes to untick
 * after the wizard was already open.
 *
 * This is a separate reader from parseModuleConfig on purpose: that one feeds
 * the replay and models only what the replay needs. This one keeps what a
 * person choosing needs: descriptions, option types and the conditions that
 * change them, which steps show when, and which plugins each option adds.
 *
 * Pure: XML text and the archive's file list in, a description out.
 */

import { attrNamed, childNamed, childrenNamed, parseXml, type XmlElement } from "../manifest/miniXml";

export type DescribedOption = {
  name: string;
  description?: string;
  image?: string;
  /** Required / Optional / Recommended / NotUsable / CouldBeUsable: the default when conditions decide. */
  type: string;
  /** Present when the type depends on conditions: each rule in words. */
  typeWhen?: Array<{ when: string; type: string }>;
  /**
   * What the type is on THIS setup, when the rules can be settled from the
   * plugin list alone (annotateTypes). Absent when a rule needs a flag, a game
   * version or a non-plugin file: those are left to the wizard, never guessed.
   */
  typeNow?: string;
  /** Internal: the rules as XML, for annotateTypes. Not sent. */
  typeRules?: Array<{ when: XmlElement; type: string }>;
  /** Flags this option sets when chosen (they drive later steps and conditional installs). */
  flags: Record<string, string>;
  files: number;
  /** Plugin files (.esp/.esm/.esl) this option installs, as the game will see them. */
  plugins: string[];
  /** Internal: where those plugins are in the archive (the masters check reads them). Not sent. */
  pluginEntries?: string[];
  /** Filled by the masters check: masters no installed plugin and nothing in this installer provides. */
  missingMasters?: string[];
  /** Filled by the masters check: masters only ANOTHER option of this installer provides. */
  mastersFromOtherOptions?: Array<{ master: string; from: string }>;
};
export type DescribedGroup = { name: string; type: string; options: DescribedOption[] };
export type DescribedStep = { index: number; name: string; visibleWhen?: string; groups: DescribedGroup[] };
export type FomodDescription = {
  kind: "fomod";
  moduleName?: string;
  /** Folder in the archive that holds fomod/ (files are relative to it). */
  root: string;
  requiredFiles: { files: number; plugins: string[]; pluginEntries?: string[] };
  /** Prerequisites the installer itself checks before it runs. */
  moduleDependencies?: string;
  steps: DescribedStep[];
  conditionalInstalls: Array<{ when: string; files: number; plugins: string[]; pluginEntries?: string[] }>;
};
export type BasicDescription = {
  kind: "basic";
  /** Top-level folders: more than one data folder here is where Vortex asks which to use. */
  topLevel: string[];
  files: number;
  plugins: string[];
};

const PLUGIN = /\.(esp|esm|esl)$/i;
const norm = (p: string): string => p.split("\\").join("/").replace(/^\/+|\/+$/g, "");
const base = (p: string): string => norm(p).split("/").pop() ?? p;

/** Every dependency expression under a node, in words: `flag "X" is "On" and "a.esm" is Active`. */
export function renderDependencies(node: XmlElement | undefined): string | undefined {
  if (node === undefined) return undefined;
  const op = (attrNamed(node, "operator") ?? "And").toLowerCase() === "or" ? " or " : " and ";
  const parts: string[] = [];
  for (const c of node.children) {
    const n = c.name.toLowerCase();
    if (n === "flagdependency") parts.push(`flag "${attrNamed(c, "flag") ?? ""}" is "${attrNamed(c, "value") ?? ""}"`);
    else if (n === "filedependency") parts.push(`"${attrNamed(c, "file") ?? ""}" is ${attrNamed(c, "state") ?? "Active"}`);
    else if (n === "gamedependency") parts.push(`game version ≥ ${attrNamed(c, "version") ?? "?"}`);
    else if (n === "fommdependency") parts.push(`mod manager ≥ ${attrNamed(c, "version") ?? "?"}`);
    else if (n === "dependencies") {
      const inner = renderDependencies(c);
      if (inner !== undefined) parts.push(`(${inner})`);
    }
  }
  return parts.length > 0 ? parts.join(op) : undefined;
}

/** Files and plugins of a `<files>` block, expanding `<folder>` against the archive listing. */
function filesOf(
  node: XmlElement | undefined,
  root: string,
  listing: readonly string[],
): { files: number; plugins: string[]; pluginEntries: string[] } {
  let files = 0;
  const plugins = new Set<string>();
  const pluginEntries = new Set<string>();
  const prefix = root === "" ? "" : `${root}/`;
  for (const f of childrenNamed(node, "file")) {
    const src = attrNamed(f, "source");
    if (src === undefined) continue;
    files += 1;
    const dest = attrNamed(f, "destination");
    const target = dest !== undefined && dest !== "" ? dest : src;
    // Only a plugin at the Data root loads; one installed into a subfolder is just a file.
    if (PLUGIN.test(target) && !norm(target).includes("/")) {
      plugins.add(base(target));
      const entry = `${prefix}${norm(src)}`.toLowerCase();
      const hit = listing.find((e) => e.toLowerCase() === entry);
      if (hit !== undefined) pluginEntries.add(hit);
    }
  }
  for (const d of childrenNamed(node, "folder")) {
    const src = attrNamed(d, "source");
    if (src === undefined) continue;
    const from = `${prefix}${norm(src)}/`.toLowerCase();
    const dest = norm(attrNamed(d, "destination") ?? "");
    for (const entry of listing) {
      if (!entry.toLowerCase().startsWith(from)) continue;
      files += 1;
      const rel = entry.slice(from.length);
      const installed = dest === "" ? rel : `${dest}/${rel}`;
      if (PLUGIN.test(installed) && !installed.includes("/")) {
        plugins.add(base(installed));
        pluginEntries.add(entry);
      }
    }
  }
  return { files, plugins: [...plugins], pluginEntries: [...pluginEntries] };
}

function describeOption(node: XmlElement, root: string, listing: readonly string[]): DescribedOption {
  const td = childNamed(node, "typeDescriptor");
  const plain = attrNamed(childNamed(td, "type"), "name");
  const dep = childNamed(td, "dependencyType");
  const typeWhen: Array<{ when: string; type: string }> = [];
  const typeRules: Array<{ when: XmlElement; type: string }> = [];
  for (const p of childrenNamed(childNamed(dep, "patterns"), "pattern")) {
    const node = childNamed(p, "dependencies");
    const when = renderDependencies(node);
    const t = attrNamed(childNamed(p, "type"), "name");
    if (when !== undefined && t !== undefined && node !== undefined) {
      typeWhen.push({ when, type: t });
      typeRules.push({ when: node, type: t });
    }
  }
  const flags: Record<string, string> = {};
  for (const f of childrenNamed(childNamed(node, "conditionFlags"), "flag")) {
    const name = attrNamed(f, "name");
    if (name !== undefined) flags[name] = f.text.trim();
  }
  const description = childNamed(node, "description")?.text.trim();
  const image = attrNamed(childNamed(node, "image"), "path");
  const { files, plugins, pluginEntries } = filesOf(childNamed(node, "files"), root, listing);
  return {
    name: attrNamed(node, "name") ?? "",
    ...(description ? { description: description.slice(0, 600) } : {}),
    ...(image !== undefined ? { image } : {}),
    type: plain ?? attrNamed(childNamed(dep, "defaultType"), "name") ?? "Optional",
    ...(typeWhen.length > 0 ? { typeWhen, typeRules } : {}),
    flags,
    files,
    plugins,
    pluginEntries,
  };
}

/** Describes a ModuleConfig.xml. `configPath` is its path in the archive; `listing` every file path in the archive. */
export function describeModuleConfig(xml: string, configPath: string, listing: readonly string[]): FomodDescription {
  const doc = parseXml(xml);
  const segs = norm(configPath).split("/");
  const root = segs.slice(0, Math.max(0, segs.length - 2)).join("/");
  const steps = childrenNamed(childNamed(doc, "installSteps"), "installStep").map((s, index) => {
    const visibleWhen = renderDependencies(childNamed(childNamed(s, "visible"), "dependencies") ?? childNamed(s, "visible"));
    return {
      index,
      name: attrNamed(s, "name") ?? "",
      ...(visibleWhen !== undefined ? { visibleWhen } : {}),
      groups: childrenNamed(childNamed(s, "optionalFileGroups"), "group").map((g) => ({
        name: attrNamed(g, "name") ?? "",
        type: attrNamed(g, "type") ?? "",
        options: childrenNamed(childNamed(g, "plugins"), "plugin").map((p) => describeOption(p, root, listing)),
      })),
    };
  });
  const moduleDependencies = renderDependencies(childNamed(doc, "moduleDependencies"));
  const moduleName = childNamed(doc, "moduleName")?.text.trim();
  return {
    kind: "fomod",
    ...(moduleName ? { moduleName } : {}),
    root,
    requiredFiles: filesOf(childNamed(doc, "requiredInstallFiles"), root, listing),
    ...(moduleDependencies !== undefined ? { moduleDependencies } : {}),
    steps,
    conditionalInstalls: childrenNamed(childNamed(childNamed(doc, "conditionalFileInstalls"), "patterns"), "pattern").map((p) => ({
      when: renderDependencies(childNamed(p, "dependencies")) ?? "always",
      ...filesOf(childNamed(p, "files"), root, listing),
    })),
  };
}

/** A package with no FOMOD: what Vortex's basic installer will see. */
export function describeBasic(listing: readonly string[]): BasicDescription {
  const top = new Set<string>();
  const plugins = new Set<string>();
  for (const e of listing) {
    const p = norm(e);
    const segs = p.split("/");
    if (segs.length > 1) top.add(segs[0]!);
    if (PLUGIN.test(p) && segs.length <= 2) plugins.add(base(p));
  }
  return { kind: "basic", topLevel: [...top].sort(), files: listing.length, plugins: [...plugins].sort() };
}

/**
 * Marks each option whose plugins need a master that nothing provides: not an
 * installed plugin, not this option, not the installer's required files. A
 * master only another option of the installer provides is listed separately:
 * choosing both settles it. Pure: `mastersByEntry` holds what the caller read
 * from each plugin in the archive; `installed` the lowercased plugin names the
 * game already has.
 */
export function annotateMasters(
  d: FomodDescription,
  mastersByEntry: ReadonlyMap<string, readonly string[]>,
  installed: ReadonlySet<string>,
): FomodDescription {
  const lc = (s: string): string => s.toLowerCase();
  const providers = new Map<string, string[]>();
  for (const { plugin, from } of pluginSources(d)) {
    const k = lc(plugin);
    providers.set(k, [...(providers.get(k) ?? []), from]);
  }
  const required = new Set(d.requiredFiles.plugins.map(lc));
  for (const s of d.steps) {
    for (const g of s.groups) {
      for (const o of g.options) {
        const own = new Set(o.plugins.map(lc));
        const masters = new Set<string>();
        for (const e of o.pluginEntries ?? []) for (const m of mastersByEntry.get(e) ?? []) masters.add(m);
        const missing: string[] = [];
        const fromOthers: Array<{ master: string; from: string }> = [];
        for (const m of masters) {
          const k = lc(m);
          if (installed.has(k) || own.has(k) || required.has(k)) continue;
          const elsewhere = (providers.get(k) ?? []).filter((f) => f !== `${s.name} / ${g.name} / ${o.name}`);
          if (elsewhere.length > 0) fromOthers.push({ master: m, from: elsewhere[0]! });
          else missing.push(m);
        }
        if (missing.length > 0) o.missingMasters = missing;
        if (fromOthers.length > 0) o.mastersFromOtherOptions = fromOthers;
      }
    }
  }
  return d;
}

/** The description as sent: internal archive paths removed. */
export function publicDescription(d: FomodDescription): FomodDescription {
  const strip = <T extends { pluginEntries?: string[]; typeRules?: unknown }>(x: T): T => {
    const { pluginEntries: _e, typeRules: _r, ...rest } = x;
    return rest as T;
  };
  return {
    ...d,
    requiredFiles: strip(d.requiredFiles),
    steps: d.steps.map((s) => ({ ...s, groups: s.groups.map((g) => ({ ...g, options: g.options.map(strip) })) })),
    conditionalInstalls: d.conditionalInstalls.map(strip),
  };
}

/** Every plugin archive path the description knows, for one extraction. */
export function allPluginEntries(d: FomodDescription): string[] {
  const out = new Set<string>(d.requiredFiles.pluginEntries ?? []);
  for (const s of d.steps) for (const g of s.groups) for (const o of g.options) for (const e of o.pluginEntries ?? []) out.add(e);
  return [...out];
}

/** Every plugin an installer can add, with where it comes from (for the masters check). */
export function pluginSources(d: FomodDescription): Array<{ plugin: string; from: string }> {
  const out: Array<{ plugin: string; from: string }> = d.requiredFiles.plugins.map((plugin) => ({ plugin, from: "required" }));
  for (const s of d.steps) for (const g of s.groups) for (const o of g.options) for (const plugin of o.plugins) out.push({ plugin, from: `${s.name} / ${g.name} / ${o.name}` });
  for (const c of d.conditionalInstalls) for (const plugin of c.plugins) out.push({ plugin, from: `when ${c.when}` });
  return out;
}

const PLUGIN_FILE = /\.(esp|esm|esl)$/i;

/**
 * A dependency group settled from the plugin list: true, false, or undefined
 * when any part of it needs something the list does not hold (a flag set by an
 * earlier page, the game version, a non-plugin file). Three-valued, so an
 * unknown part decides nothing it could not decide on its own.
 *
 * A plugin is Active when it is in the list and enabled, Inactive when it is in
 * the list and disabled, Missing when it is not in the list.
 */
function settleDependencies(node: XmlElement, plugins: ReadonlyMap<string, boolean>): boolean | undefined {
  const or = (attrNamed(node, "operator") ?? "And").toLowerCase() === "or";
  let unknown = false;
  for (const c of node.children) {
    const n = c.name.toLowerCase();
    let v: boolean | undefined;
    if (n === "filedependency") {
      const file = (attrNamed(c, "file") ?? "").replace(/^.*[\\/]/, "").toLowerCase();
      const want = (attrNamed(c, "state") ?? "Active").toLowerCase();
      if (!PLUGIN_FILE.test(file)) v = undefined;
      else {
        const enabled = plugins.get(file);
        const is = enabled === undefined ? "missing" : enabled ? "active" : "inactive";
        v = want === "active" || want === "inactive" || want === "missing" ? is === want : undefined;
      }
    } else if (n === "dependencies") v = settleDependencies(c, plugins);
    else if (n === "flagdependency" || n === "gamedependency" || n === "fommdependency") v = undefined;
    else continue;
    if (v === undefined) unknown = true;
    else if (or && v) return true;
    else if (!or && !v) return false;
  }
  return unknown ? undefined : !or;
}

/**
 * Settles each conditional option type the way the wizard will: the first
 * rule that holds wins, none holding means the default. A rule that cannot be
 * settled before a holding one leaves the type unknown, because the wizard may
 * stop there. Fallout-collection, 2026-10-24: a pick on a NotUsable option was
 * only found out inside the wizard ("pick-unverified"), after Vortex had
 * already switched the installed version off.
 */
export function annotateTypes(d: FomodDescription, plugins: ReadonlyMap<string, boolean>): FomodDescription {
  return {
    ...d,
    steps: d.steps.map((s) => ({
      ...s,
      groups: s.groups.map((g) => ({
        ...g,
        options: g.options.map((o) => {
          if (o.typeRules === undefined) return o;
          for (const r of o.typeRules) {
            const v = settleDependencies(r.when, plugins);
            if (v === undefined) return o;
            if (v) return { ...o, typeNow: r.type };
          }
          return { ...o, typeNow: o.type };
        }),
      })),
    })),
  };
}

/**
 * Picks (by name) that land on an option NotUsable on this setup. Numeric
 * picks name the live wizard's ids and are left to it.
 */
export function notUsablePicks(
  d: FomodDescription,
  picks: ReadonlyArray<{ group: string | number; options: ReadonlyArray<string | number>; step?: string | number }>,
): Array<{ step: string; group: string; option: string; when?: string }> {
  const same = (a: string, b: string): boolean => a.trim().toLowerCase() === b.trim().toLowerCase();
  const out: Array<{ step: string; group: string; option: string; when?: string }> = [];
  for (const pick of picks) {
    if (typeof pick.group !== "string") continue;
    for (const s of d.steps) {
      if (pick.step !== undefined && (typeof pick.step === "number" ? pick.step !== s.index : !same(pick.step, s.name))) continue;
      for (const g of s.groups) {
        if (!same(g.name, pick.group)) continue;
        for (const want of pick.options) {
          if (typeof want !== "string") continue;
          const o = g.options.find((x) => same(x.name, want));
          if (o?.typeNow !== undefined && same(o.typeNow, "NotUsable")) {
            const rule = o.typeWhen?.find((r) => same(r.type, "NotUsable"));
            out.push({ step: s.name, group: g.name, option: o.name, ...(rule !== undefined ? { when: rule.when } : {}) });
          }
        }
      }
    }
  }
  return out;
}
