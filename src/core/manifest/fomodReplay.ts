/**
 * Derive the file set a FOMOD SHOULD install, from the script plus the recorded
 * choices — without consulting anyone's staging folder.
 *
 * ─── WHY THIS IS THE KEYSTONE ─────────────────────────────────────────
 * The other two references each leave a hole:
 *
 *   archive listing  → knows the true bytes of every CANDIDATE file, but not
 *                      which subset a FOMOD selects. A file missing from
 *                      staging is indistinguishable from an option not chosen.
 *   curator staging  → knows what landed on the curator's disk, which is the
 *                      thing under test. If Vortex lost files during the
 *                      CURATOR's unpack — the exact bug this feature exists to
 *                      catch — the recorded set is short, and the omission is
 *                      invisible to both other references.
 *
 * Replaying the script closes that. `ModuleConfig.xml` is a declarative install
 * spec, and Vortex records the choices (`IChoiceType.options`, step → group →
 * choice with a plugin `idx`). Given both, the expected file set is COMPUTED,
 * derived from no one's disk. The curator's staging stops being an input to
 * correctness and becomes purely the thing being verified.
 *
 * ─── FIDELITY IS THE RISK, AND IT IS REAL ─────────────────────────────
 * This is a partial reimplementation of an installer. If it disagrees with
 * Vortex's FOMOD engine, it manufactures false mismatches — the same class of
 * bug, relocated. Measured on one real script (Ultimate AAF Patch): 8 install
 * steps, 10 groups, 48 plugins, 114 `<folder>` entries, and a
 * `conditionalFileInstalls` block with 158 patterns over 148 flag
 * dependencies. Conditional logic is not an edge case here; it is most of the
 * script.
 *
 * So the contract is deliberately conservative: every result carries
 * {@link FomodReplayResult.confidence}, and anything this module does not fully
 * understand downgrades it rather than guessing. A LOW-confidence replay must
 * not be used to accuse a staging folder of anything.
 * ──────────────────────────────────────────────────────────────────────
 */

import { toPosix } from "../paths";

/** One selected choice, as Vortex records it (`IChoices`). */
export type RecordedChoice = { name: string; idx?: number };
export type RecordedGroup = { name: string; choices: RecordedChoice[] };
export type RecordedStep = { name: string; groups: RecordedGroup[] };

/** A `<file>` or `<folder>` node from the script. */
export type FomodFileSpec = {
  source: string;
  destination?: string;
  /** Higher wins when two specs target the same destination. Default 0. */
  priority: number;
  /** `<folder>` copies a tree; `<file>` copies one file. */
  isFolder: boolean;
};

export type FomodPlugin = {
  name: string;
  /** Position within its group — matches the `idx` Vortex records. */
  idx: number;
  files: FomodFileSpec[];
  /** Flags this plugin sets when selected, consumed by conditional patterns. */
  flags: Record<string, string>;
};

export type FomodGroup = { name: string; type: string; plugins: FomodPlugin[] };
export type FomodStep = { name: string; groups: FomodGroup[] };

export type FomodConditionalPattern = {
  /** flag name → required value. All must match for the pattern to apply. */
  flagDependencies: Record<string, string>;
  files: FomodFileSpec[];
  /**
   * Dependency kinds on this pattern that the parser does not model
   * (`fileDependency`, `gameDependency`, nested `dependencies`, non-And
   * operators).
   *
   * A pattern carrying any of these CANNOT be evaluated, and must not be
   * treated as satisfied. `Object.entries({}).every(...)` is `true`, so an
   * unmodelled pattern whose flag map came out empty would otherwise apply
   * ALWAYS — which is exactly how this replay once predicted files that a real
   * install correctly did not produce, and reported a healthy mod as missing
   * three files.
   */
  unsupportedDependencies: string[];
};

export type FomodScript = {
  moduleName?: string;
  requiredInstallFiles: FomodFileSpec[];
  steps: FomodStep[];
  conditionalPatterns: FomodConditionalPattern[];
};

export type ReplayConfidence = "high" | "low";

export type FomodReplayResult = {
  /** Source paths (archive-relative) the script says should be installed. */
  sources: FomodFileSpec[];
  /**
   * `high` only when every recorded choice was matched to a plugin in the
   * script. Anything else — an unmatched group, a choice whose plugin could not
   * be identified, an unsupported dependency type — yields `low`.
   *
   * A `low` result is a hint, never an accusation.
   */
  confidence: ReplayConfidence;
  /** Human-readable reasons the confidence was downgraded. */
  warnings: string[];
  /** Flags that ended up set — exposed for debugging a surprising result. */
  flags: Record<string, string>;
};

/** Case- and separator-insensitive key for matching names across sources. */
function norm(s: string): string {
  // Lowercased unconditionally: this keys FOMOD option and plugin NAMES for
  // recognition, not files for identity, and a curator's "Textures" is the
  // user's "textures" on every platform.
  return toPosix(s.trim().toLowerCase());
}

/**
 * Resolve which plugin a recorded choice refers to.
 *
 * `idx` is preferred: it is the plugin's position in the group and is what
 * Vortex actually stores, so it survives a mod author fixing a typo in a
 * display name. The name is used as a cross-check and as the fallback when no
 * idx was recorded. A disagreement between the two is reported rather than
 * silently resolved — it means our understanding of the group has drifted from
 * Vortex's.
 */
function resolvePlugin(
  group: FomodGroup,
  choice: RecordedChoice,
  warnings: string[],
): FomodPlugin | undefined {
  const byName = group.plugins.find((p) => norm(p.name) === norm(choice.name));
  if (choice.idx === undefined) {
    if (byName === undefined) {
      warnings.push(`No plugin named "${choice.name}" in group "${group.name}".`);
    }
    return byName;
  }
  const byIdx = group.plugins.find((p) => p.idx === choice.idx);
  if (byIdx === undefined) {
    if (byName !== undefined) return byName;
    warnings.push(`No plugin at index ${choice.idx} in group "${group.name}".`);
    return undefined;
  }
  if (byName !== undefined && byName !== byIdx) {
    warnings.push(
      `Choice "${choice.name}" (idx ${choice.idx}) in group "${group.name}" ` +
        `matches two different plugins by name and index; trusting index.`,
    );
  }
  return byIdx;
}

/**
 * Replay a parsed script against recorded choices.
 *
 * Pure. Returns SOURCE specs rather than destination paths: expanding a
 * `<folder>` into concrete files needs the archive listing, which the caller
 * already has, and keeping that join outside this module keeps the FOMOD
 * semantics testable on their own.
 */
export function replayFomod(
  script: FomodScript,
  recorded: RecordedStep[],
): FomodReplayResult {
  const warnings: string[] = [];
  const flags: Record<string, string> = {};
  const sources: FomodFileSpec[] = [...script.requiredInstallFiles];

  const stepByName = new Map(script.steps.map((s) => [norm(s.name), s]));

  for (const recStep of recorded) {
    const step = stepByName.get(norm(recStep.name));
    if (step === undefined) {
      warnings.push(`Recorded step "${recStep.name}" is not in the script.`);
      continue;
    }
    const groupByName = new Map(step.groups.map((g) => [norm(g.name), g]));
    for (const recGroup of recStep.groups) {
      const group = groupByName.get(norm(recGroup.name));
      if (group === undefined) {
        warnings.push(
          `Recorded group "${recGroup.name}" is not in step "${recStep.name}".`,
        );
        continue;
      }
      for (const choice of recGroup.choices) {
        const plugin = resolvePlugin(group, choice, warnings);
        if (plugin === undefined) continue;
        sources.push(...plugin.files);
        for (const [k, v] of Object.entries(plugin.flags)) flags[k] = v;
      }
    }
  }

  // Conditional installs are evaluated AFTER every selection, because a pattern
  // may depend on flags set by any step.
  for (const pattern of script.conditionalPatterns) {
    if (pattern.unsupportedDependencies.length > 0) {
      // Cannot evaluate ⇒ MUST NOT include. Over-predicting invents "missing"
      // files and accuses a correct install; under-predicting only means we
      // notice less. The asymmetry decides it.
      warnings.push(
        `Conditional pattern depends on ${pattern.unsupportedDependencies.join(", ")}, ` +
          `which this replay cannot evaluate; its files are excluded.`,
      );
      continue;
    }
    const satisfied = Object.entries(pattern.flagDependencies).every(
      ([name, value]) => norm(flags[name] ?? "") === norm(value),
    );
    if (satisfied) sources.push(...pattern.files);
  }

  return {
    sources: dedupeByPriority(sources),
    confidence: warnings.length === 0 ? "high" : "low",
    warnings,
    flags,
  };
}

/**
 * Drop specs that are byte-for-byte the same instruction.
 *
 * ─── WHY THIS IS NOT PRIORITY RESOLUTION ──────────────────────────────
 * It deliberately keys on SOURCE + destination + kind, not on destination
 * alone. An earlier version keyed on destination, on the theory that FOMOD
 * resolves overlaps by `priority` — and collapsed a real 25-choice install down
 * to ONE folder, because `<folder>` specs overwhelmingly install to the mod
 * ROOT and therefore all share the empty destination. Validated against the
 * Ultimate AAF Patch script, which is how the bug was found.
 *
 * Priority resolution is real, but it operates per FILE, after `<folder>` specs
 * are expanded against the archive listing. Two folders installing to the root
 * do not conflict; two files landing on the same path do. Doing it here, before
 * expansion, cannot distinguish those cases and silently predicts a fraction of
 * the true file set — which would read as mass "missing files" on a perfectly
 * correct install.
 *
 * So this only removes exact duplicates (the same plugin selected twice via
 * different steps), and the caller resolves priority when it expands folders.
 */
function dedupeByPriority(specs: FomodFileSpec[]): FomodFileSpec[] {
  const best = new Map<string, FomodFileSpec>();
  for (const spec of specs) {
    const key = `${norm(spec.source)}|${norm(spec.destination ?? "")}|${spec.isFolder}`;
    const prev = best.get(key);
    if (prev === undefined || spec.priority >= prev.priority) best.set(key, spec);
  }
  return Array.from(best.values());
}
