/**
 * ──────────────────────────────────────────────────────────────────────
 * Every field this collection ships, and who reads it on the other side.
 *
 * A `.ehcoll` is a promise: the curator's machine writes it, a stranger's
 * machine acts on it. Eight of twenty-one fields turned out to be written and
 * read by nothing at all — `fileOverrides` at both levels, `deploymentPriority`,
 * `installOrder`, `enabled`, `attributes`, `iniTweaks`, and a `schemaVersion`
 * that only the parser's compatibility gate looks at. Some are deliberate.
 * None of them were declared as such anywhere a compiler could see.
 *
 * ─── THE MECHANISM, BORROWED FROM THE ONE PLACE IT ALREADY WORKED ──────
 * `collectionConfig.ts` guards its config entry with a mapped type over
 * `Required<T>`, so adding a field to the type without adding a reader is a
 * compile error at that line rather than data loss on a user's machine. It was
 * the only such guard in 182 source files, and it earned its keep: it blocked
 * `postProcessed` from being added until a reader existed.
 *
 * This is that idea applied to the shipped format. Add a field to
 * `ModInstallState` or `EhcollManifest` and the build stops until you say what
 * happens to it. "Nothing happens to it" is an allowed answer — it just has to
 * be an answer, with a reason, instead of a silence nobody notices for months.
 *
 * ─── AND THE TABLE IS CHECKED, BECAUSE PROSE ROTS ──────────────────────
 * A table of claims is only worth having if something verifies it. This one
 * has a test that opens each named reader and confirms it actually touches the
 * field. That is not hypothetical rigour: a build warning in this repo told
 * curators for months that INI tweaks were never applied, while
 * `applyIniTweaks.ts` sat beside it applying them — and testers were told to
 * go and redo the work by hand. An unverified claim about behaviour is exactly
 * how that happens.
 * ──────────────────────────────────────────────────────────────────────
 */

import type {
  EhcollManifest,
  EhcollPluginEntry,
  ModInstallSpec,
  ModInstallState,
} from "../../types/ehcoll";

export type FieldFate =
  /**
   * Something on the user's side acts on this.
   *
   * `by` is a path under `src/` relative to the repo's `src` directory, and
   * the test opens it — a name here that does not read the field fails.
   */
  | { readonly kind: "applied"; readonly by: string }
  /**
   * Written and deliberately not acted on. `why` is the whole value of the
   * entry: "recorded only" without a reason is how a gap becomes permanent.
   */
  | { readonly kind: "recorded-only"; readonly why: string }
  /**
   * Read by the parser to decide whether it can read the rest at all. Not a
   * behaviour, so it is neither applied nor a gap.
   */
  | { readonly kind: "structural"; readonly why: string };

/**
 * Per-mod install state. `Required<>` forces an entry for every field.
 */
export const MOD_INSTALL_STATE_FATES: {
  readonly [K in keyof Required<ModInstallState>]: FieldFate;
} = {
  modType: { kind: "applied", by: "core/installer/applyModTypes.ts" },
  mirrored: { kind: "applied", by: "core/installer/runInstall.ts" },
  enabledINITweaks: { kind: "applied", by: "core/installer/applyIniTweaks.ts" },
  postProcessed: { kind: "applied", by: "core/installer/judgeReinstall.ts" },
  /**
   * `runInstall`, not `verifyModInstall` — the latter receives the file list
   * as a differently-named argument and mentions `stagingFiles` only in its
   * comments. The old substring check passed on that prose; the strengthened
   * one does not, which is the point.
   */
  stagingFiles: { kind: "applied", by: "core/installer/runInstall.ts" },

  enabled: {
    kind: "recorded-only",
    why:
      "The driver enables every mod it installs, so a per-mod flag would only " +
      "matter for shipping a mod deliberately switched off — which the build " +
      "excludes from the collection instead.",
  },
  installOrder: {
    kind: "recorded-only",
    why:
      "The curator's ordinal, kept because it is cheap to carry and useful " +
      "when diagnosing an ordering question by hand. Nothing replays it.",
  },
  deploymentPriority: {
    kind: "recorded-only",
    why:
      "Vortex exposes no action to set a deployment priority, and ordering " +
      "only decides a file conflict no RULE decides — 3 of 4,383 contested " +
      "files on the real collection. Machinery guarding almost nothing.",
  },

};

/**
 * ─── ONE SHIPPED TYPE PER TABLE, INCLUDING THE NESTED ONES ─────────────
 * The two tables above cover `EhcollManifest` and `ModInstallState` — the
 * top level of each. `EhcollPluginEntry` sits INSIDE `plugins.order[]`, so
 * `Required<EhcollManifest>` never saw it, and `light` was written by the
 * build, shipped in every package, and silently dropped by the parser for as
 * long as the feature existed. The registry that exists to make exactly that
 * impossible could not see one level down.
 *
 * A nested shipped type needs its own table for the same reason the top level
 * does: `Required<>` turns "someone added a field and nobody reads it" into a
 * compile error instead of a bug report from a stranger.
 */
export const MOD_INSTALL_SPEC_FATES: {
  readonly [K in keyof Required<ModInstallSpec>]: FieldFate;
} = {
  fomodSelections: { kind: "applied", by: "core/installer/installerChoices.ts" },
  installerChoicesType: {
    kind: "applied",
    by: "core/installer/installerChoices.ts",
  },
  emptySelectionVerified: {
    kind: "applied",
    by: "core/installer/installerChoices.ts",
  },
  readsPluginState: { kind: "applied", by: "core/installer/runInstall.ts" },
  installerType: {
    kind: "recorded-only",
    why:
      "Vortex decides which installer to run from the archive itself. This " +
      "is the curator's observed answer, kept for diagnosing a mod that " +
      "installed differently on two machines; nothing replays it.",
  },
};

export const PLUGIN_ENTRY_FATES: {
  readonly [K in keyof Required<EhcollPluginEntry>]: FieldFate;
} = {
  name: { kind: "applied", by: "core/installer/applyPluginOrder.ts" },
  enabled: { kind: "applied", by: "core/installer/applyPluginOrder.ts" },
  light: { kind: "applied", by: "core/installer/applyPluginLightFlags.ts" },
};

/**
 * The manifest's top level.
 */
export const MANIFEST_FATES: {
  readonly [K in keyof Required<EhcollManifest>]: FieldFate;
} = {
  package: { kind: "applied", by: "core/resolver/resolveInstallPlan.ts" },
  game: { kind: "applied", by: "core/resolver/resolveInstallPlan.ts" },
  vortex: { kind: "applied", by: "core/resolver/resolveInstallPlan.ts" },
  mods: { kind: "applied", by: "core/resolver/resolveInstallPlan.ts" },
  rules: { kind: "applied", by: "core/installer/applyModRules.ts" },
  plugins: { kind: "applied", by: "core/resolver/resolveInstallPlan.ts" },
  /**
   * Read off the manifest by the driver, which hands the entries to
   * `applyLoadOrder` — that module names `loadOrder` only in its docblock.
   */
  loadOrder: { kind: "applied", by: "core/installer/runInstall.ts" },
  userlist: { kind: "applied", by: "core/resolver/resolveInstallPlan.ts" },
  gameIni: { kind: "applied", by: "core/installer/applyGameIni.ts" },
  externalDependencies: {
    kind: "recorded-only",
    why:
      "The resolver turns these into ExternalDependencyDecisions, and NOTHING " +
      "consumes them. `userState.externalDependencyState` is hardcoded " +
      "undefined at all three construction sites, so every dependency " +
      "resolves `not-verified`; `externalDepBlocking` only fires on `missing` " +
      "or `files-mismatch` and is therefore unreachable; and the install UI " +
      "never renders them. This said `applied` while the build page told the " +
      "curator 'the user's copy is verified against these hashes' — the exact " +
      "false claim this table exists to prevent, inside the table itself. " +
      "Recorded-only until a verification pass exists and its result is shown.",
  },

  schemaVersion: {
    kind: "structural",
    why:
      "Read by parseManifest's compatibility gate to refuse a package this " +
      "build cannot understand, before any of the rest is trusted.",
  },

  iniTweaks: {
    kind: "recorded-only",
    why:
      "A v1 placeholder written as a hardcoded empty array — nothing is ever " +
      "captured INTO it, so there is no setting for it to lose. Distinct " +
      "from ModInstallState.enabledINITweaks, which is captured and applied.",
  },
};
