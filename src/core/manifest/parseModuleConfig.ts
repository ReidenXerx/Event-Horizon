/**
 * Parse a FOMOD `ModuleConfig.xml` into the shape {@link replayFomod} consumes.
 *
 * Encoding matters and is not optional: the real scripts in the wild are often
 * UTF-16 with a BOM (the Ultimate AAF Patch script measured here is), and
 * decoding one as UTF-8 yields a document full of NUL bytes that xml2js either
 * rejects or, worse, parses into nonsense. The BOM is sniffed rather than
 * assumed.
 *
 * Everything here degrades rather than guesses. A construct this parser does
 * not model must surface as a warning so {@link replayFomod} can downgrade its
 * confidence — a silently-dropped conditional would make the derived file set
 * quietly wrong, which is the one outcome worse than not checking at all.
 */

import {
  attrNamed,
  childNamed,
  childrenNamed,
  parseXml,
  type XmlElement,
} from "./miniXml";

import type {
  FomodConditionalPattern,
  FomodFileSpec,
  FomodGroup,
  FomodPlugin,
  FomodScript,
  FomodStep,
} from "./fomodReplay";

/** Decode a ModuleConfig buffer, honouring a UTF-16 BOM when present. */
export function decodeModuleConfig(buf: Buffer): string {
  if (buf.length >= 2) {
    if (buf[0] === 0xff && buf[1] === 0xfe) return buf.toString("utf16le");
    if (buf[0] === 0xfe && buf[1] === 0xff) {
      // UTF-16BE: swap to LE, which is all Node decodes natively.
      const swapped = Buffer.from(buf);
      swapped.swap16();
      return swapped.toString("utf16le");
    }
  }
  // A UTF-8 BOM would otherwise become a stray char before `<`.
  const text = buf.toString("utf8");
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

const children = childrenNamed;
const first = childNamed;
const attr = attrNamed;

function toPriority(raw: string | undefined): number {
  if (raw === undefined) return 0;
  const n = Number(raw);
  return Number.isFinite(n) ? n : 0;
}

/** Read a `<files>` block: any mix of `<file>` and `<folder>`. */
function parseFiles(filesNode: XmlElement | undefined): FomodFileSpec[] {
  const out: FomodFileSpec[] = [];
  for (const [tag, isFolder] of [
    ["file", false],
    ["folder", true],
  ] as const) {
    for (const node of children(filesNode, tag)) {
      const source = attr(node, "source");
      if (source === undefined) continue;
      const destination = attr(node, "destination");
      out.push({
        source,
        ...(destination !== undefined ? { destination } : {}),
        priority: toPriority(attr(node, "priority")),
        isFolder,
      });
    }
  }
  return out;
}

function parsePlugin(node: XmlElement, idx: number): FomodPlugin {
  const flags: Record<string, string> = {};
  for (const flagNode of children(first(node, "conditionFlags"), "flag")) {
    const name = attr(flagNode, "name");
    if (name === undefined) continue;
    flags[name] = flagNode.text.trim();
  }
  return {
    name: attr(node, "name") ?? `plugin-${idx}`,
    idx,
    files: parseFiles(first(node, "files")),
    flags,
  };
}

function parseGroup(node: XmlElement): FomodGroup {
  const pluginNodes = children(first(node, "plugins"), "plugin");
  return {
    name: attr(node, "name") ?? "",
    type: attr(node, "type") ?? "",
    plugins: pluginNodes.map(parsePlugin),
  };
}

function parseStep(node: XmlElement): FomodStep {
  const groupNodes = children(first(node, "optionalFileGroups"), "group");
  return {
    name: attr(node, "name") ?? "",
    groups: groupNodes.map(parseGroup),
  };
}

/**
 * ─── EVERY PLUGIN THIS SCRIPT ASKS THE GAME ABOUT ─────────────────────────
 * `<fileDependency file="aaf.esm" state="Active"/>` can appear in four places,
 * and this walks all of them rather than the one the replay happened to look
 * at: `<moduleDependencies>` (a prerequisite — refuses outright), an install
 * step's `<visible>` (hides the step), `<conditionalFileInstalls>` patterns
 * (installs a different set), and a plugin's `<typeDescriptor>` (changes
 * Required / Recommended / NotUsable).
 *
 * Only the last two were even reachable before, and `parseConditionals` threw
 * the FILENAME away — it recorded the literal string `"fileDependency"` so the
 * replay could exclude that pattern, which is the right call for the replay
 * and loses the fact entirely for anyone else. `<moduleDependencies>` was
 * never read at all, which is why the one construct that produces a visible
 * failure — "Installer Prerequisits not fulfilled: File 'aaf.esm' is Active"
 * — was invisible to the build.
 *
 * `state` is deliberately not recorded. `Active`, `Inactive` and `Missing` all
 * mean the same thing here: the answer depends on WHEN this mod installs.
 * Only `.esp`/`.esm`/`.esl` names are kept — a dependency on a loose file is
 * satisfied by extraction, not by activation, so ordering cannot help it.
 */
function collectPluginStateDependencies(root: XmlElement): string[] {
  const found = new Set<string>();

  const walk = (node: XmlElement | undefined): void => {
    if (node === undefined) return;
    for (const dep of children(node, "fileDependency")) {
      const file = attr(dep, "file");
      if (file === undefined) continue;
      const name = file.trim().toLowerCase();
      if (/\.(esp|esm|esl)$/.test(name)) found.add(name);
    }
    // `<dependencies>` nests arbitrarily deep through And/Or composites, and
    // the real-world case that motivated this is exactly one: the AAF mods
    // carry `Or(fileDependency aaf.esm, fileDependency aaf.esp)`.
    for (const nested of children(node, "dependencies")) walk(nested);
  };

  walk(first(root, "moduleDependencies"));

  for (const step of children(first(root, "installSteps"), "installStep")) {
    walk(first(step, "visible"));
    for (const group of children(first(step, "optionalFileGroups"), "group")) {
      for (const plugin of children(first(group, "plugins"), "plugin")) {
        for (const type of children(
          first(plugin, "typeDescriptor"),
          "dependencyType",
        )) {
          for (const pattern of children(first(type, "patterns"), "pattern")) {
            walk(first(pattern, "dependencies"));
          }
        }
      }
    }
  }

  const conditionals = first(
    first(root, "conditionalFileInstalls"),
    "patterns",
  );
  for (const pattern of children(conditionals, "pattern")) {
    walk(first(pattern, "dependencies"));
  }

  return [...found].sort();
}

/**
 * Parse `conditionalFileInstalls`.
 *
 * Only `flagDependency` is modelled. FOMOD also allows `fileDependency`,
 * `gameDependency` and nested `dependencies` operators, and a pattern using
 * one of those is reported through `warnings` rather than being silently
 * treated as unsatisfied — dropping it would under-predict the file set and
 * make a correct install look short.
 */
function parseConditionals(
  configNode: XmlElement,
  warnings: string[],
): FomodConditionalPattern[] {
  const patternsNode = first(
    first(configNode, "conditionalFileInstalls"),
    "patterns",
  );
  const out: FomodConditionalPattern[] = [];
  for (const pattern of children(patternsNode, "pattern")) {
    const deps = first(pattern, "dependencies");
    const flagDependencies: Record<string, string> = {};
    for (const dep of children(deps, "flagDependency")) {
      const name = attr(dep, "flag");
      if (name === undefined) continue;
      flagDependencies[name] = attr(dep, "value") ?? "";
    }
    // Recorded PER PATTERN, not just globally: the replay has to know which
    // specific pattern it cannot evaluate, so it can exclude that one instead
    // of trusting an empty flag map that means "unknown", not "unconditional".
    const unsupportedDependencies: string[] = [];
    for (const unsupported of ["fileDependency", "gameDependency", "dependencies"]) {
      if (children(deps, unsupported).length > 0) {
        unsupportedDependencies.push(unsupported);
        warnings.push(
          `conditionalFileInstalls uses <${unsupported}>, which this replay does not model.`,
        );
      }
    }
    const operator = attr(deps, "operator");
    if (operator !== undefined && operator.toLowerCase() !== "and") {
      unsupportedDependencies.push(`operator=${operator}`);
      warnings.push(`Dependency operator "${operator}" is not modelled (assuming And).`);
    }
    out.push({
      flagDependencies,
      files: parseFiles(first(pattern, "files")),
      unsupportedDependencies,
    });
  }
  return out;
}

export type ParsedModuleConfig = {
  script: FomodScript;
  /** Constructs encountered that this parser does not model. */
  warnings: string[];
};

/** Parse a decoded or raw `ModuleConfig.xml`. */
export async function parseModuleConfig(
  input: Buffer | string,
): Promise<ParsedModuleConfig> {
  const text = typeof input === "string" ? input : decodeModuleConfig(input);
  const root = parseXml(text);

  if (root.name.toLowerCase() !== "config") {
    throw new Error(
      `ModuleConfig.xml has no <config> root element (found <${root.name}>).`,
    );
  }

  const warnings: string[] = [];
  const stepNodes = children(first(root, "installSteps"), "installStep");
  const moduleNameNode = first(root, "moduleName");

  return {
    script: {
      ...(moduleNameNode !== undefined && moduleNameNode.text !== ""
        ? { moduleName: moduleNameNode.text }
        : {}),
      requiredInstallFiles: parseFiles(first(root, "requiredInstallFiles")),
      steps: stepNodes.map(parseStep),
      conditionalPatterns: parseConditionals(root, warnings),
      pluginStateDependencies: collectPluginStateDependencies(root),
    },
    warnings,
  };
}
