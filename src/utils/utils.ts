import { revealInFileManager } from "../core/revealPath";
import * as fs from "fs/promises";
import * as path from "path";
import type { types } from "@nexusmods/vortex-api";
import type { AuditorMod } from "../core/getModsListForProfile";
import {
  matchSnapshots,
  type MatchTier,
} from "../core/identity/modIdentity";
import type { CapturedDeploymentManifest } from "../core/deploymentManifest";
import type { CapturedLoadOrderEntry } from "../core/loadOrder";
import type { CapturedUserlist } from "../core/userlist";

/**
 * Show a folder, or a file inside its folder, in the OS file manager.
 *
 * These used to be `exec(\`start "" "${p}"\`)`, which was wrong three ways.
 *
 * It built a SHELL COMMAND by string interpolation, so any path containing a
 * quote or a shell metacharacter would have been executed rather than opened.
 * The paths here are ours and the slug is sanitised, so it was not reachable
 * today — but "not reachable today" is the state a shell-injection pattern is
 * in right up until someone passes it a different string.
 *
 * `start` is a cmd.exe builtin, so under Proton it reaches Wine's shell rather
 * than the user's desktop, which is a supported target for this project.
 *
 * And it duplicated `revealInFileManager`, which already tries
 * showItemInFolder, then openPath, then Vortex's own opener, checks the return
 * value that openPath lies with, and reports which one worked. Two openers is
 * one more than can be kept correct.
 *
 * Fire-and-forget, as before: these back notification buttons, and a file
 * manager that will not open is not worth failing anything over.
 */
export function openFolder(folderPath: string): void {
  void revealInFileManager({ folderPath });
}

export function openFile(filePath: string): void {
  void revealInFileManager({ filePath, folderPath: path.dirname(filePath) });
}

export function findInObject(
  obj: unknown,
  predicate: (key: string, value: unknown, path: string) => boolean,
  currentPath = "state",
  results: Array<{ path: string; key: string; value: unknown }> = [],
  seen = new WeakSet<object>(),
) {
  if (!obj || typeof obj !== "object") return results;

  if (seen.has(obj as object)) return results;
  seen.add(obj as object);

  for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
    const nextPath = `${currentPath}.${key}`;

    if (predicate(key, value, nextPath)) {
      results.push({ path: nextPath, key, value });
    }

    if (value && typeof value === "object") {
      findInObject(value, predicate, nextPath, results, seen);
    }
  }

  return results;
}

export async function pickJsonFile(
  api: types.IExtensionApi,
): Promise<string | undefined> {
  const filePath = await api.selectFile({
    title: "Select reference Mod Auditor JSON",
    filters: [{ name: "JSON files", extensions: ["json"] }],
  });

  return filePath?.length ? filePath : undefined;
}

/**
 * Ask the user for a collection package: a `.ehcoll`, or the `.zip` a Nexus
 * page serves it as (Nexus quarantines files named `.ehcoll`).
 *
 * Goes through Vortex's own `api.selectFile`, NOT Electron's dialog.
 *
 * This used to `require("electron")` and reach for `remote.dialog ?? dialog`.
 * Both halves of that are dead: `remote` was removed in Electron 14, and
 * `dialog` is a MAIN-process module that a renderer never has. It could only
 * ever have worked on a Vortex old enough to still expose remote — and it
 * failed outright for a user running Vortex under Proton, which is where it
 * was finally noticed. `pickJsonFile`, four lines up in this same file, had
 * been doing it correctly the whole time.
 *
 * Vortex's own picker is also the right dependency for a reason beyond
 * availability: it is the one that knows about Vortex's window, its modal
 * stack, and whatever wrapper the host platform needs.
 */
export async function pickEhcollFile(
  api: types.IExtensionApi,
): Promise<string | undefined> {
  const filePath = await api.selectFile({
    title: "Select an Event Horizon collection package (.ehcoll or .zip)",
    filters: [{ name: "Event Horizon collection packages", extensions: ["ehcoll", "zip"] }],
  });
  return filePath?.length ? filePath : undefined;
}

/**
 * Open a file picker for a mod archive, used by the install action's
 * external-prompt-user picker. Title and `expectedFilename` give the
 * user a hint of what they're being asked to provide.
 */
export async function pickModArchiveFile(args: {
  api: types.IExtensionApi;
  title: string;
  expectedFilename?: string;
}): Promise<string | undefined> {
  const filePath = await args.api.selectFile({
    title: args.title,
    ...(args.expectedFilename !== undefined
      ? { defaultPath: args.expectedFilename }
      : {}),
    filters: [
      { name: "Mod archives", extensions: ["zip", "7z", "rar", "tar", "tgz", "gz"] },
      { name: "All files", extensions: ["*"] },
    ],
  });
  return filePath?.length ? filePath : undefined;
}

export type ExportedModsSnapshot = {
  exportedAt?: string;
  gameId: string;
  profileId: string;
  count?: number;
  /**
   * All profile-managed mods (enabled + disabled). Always present for
   * backward compatibility — `compareSnapshots` uses this as the
   * authoritative list when `enabledMods`/`disabledMods` are absent.
   */
  mods: AuditorMod[];

  /**
   * Profile-enabled mods, separated out for easier viewer display.
   * Present in snapshots created by Phase 5.3+. Older reference files
   * only have `mods`; derive the split by filtering on `mod.enabled`.
   */
  enabledMods?: AuditorMod[];

  /**
   * Profile-disabled mods, separated out for easier viewer display.
   * Present in snapshots created by Phase 5.3+.
   */
  disabledMods?: AuditorMod[];

  /**
   * Per-modtype deployment manifests captured on export only.
   *
   * Optional because:
   *   1. Older snapshot files (pre-Phase 1 slice 3) won't have it.
   *   2. The Compare Mods action builds a current-side snapshot
   *      synchronously without `api`, so it cannot capture manifests.
   *
   * NOT diffed yet — `compareMods` ignores it. Captured here so that the
   * future installer (Phase 4+) can plan reconciliation against the
   * curator's actual deployment winners.
   */
  deploymentManifests?: CapturedDeploymentManifest[];

  /**
   * Per-game load order from `state.persistent.loadOrder[gameId]`.
   *
   * Optional because:
   *   1. Older snapshot files (pre-Phase 1 slice 4) won't have it.
   *   2. Games that drive load order purely via `plugins.txt` will emit
   *      an empty array; we still emit the field for forward-compat.
   *
   * Distinct from `plugins.txt` — covers non-plugin mods (script
   * extenders, ENB, etc.) on games that use Vortex's LoadOrder API.
   * NOT diffed yet — captured for the future installer.
   */
  loadOrder?: CapturedLoadOrderEntry[];

  /**
   * Curator's LOOT userlist (`state.userlist`) — plugin-to-plugin
   * rules + group assignments + group-to-group rules.
   *
   * Optional because:
   *   1. Older snapshot files (pre-slice 6d) won't have it.
   *   2. The Compare Mods action builds a current-side snapshot
   *      synchronously without `api`, so it cannot capture userlist.
   *   3. Non-LOOT games (Starfield without xeditor) emit an empty
   *      userlist; we still capture the field for forward-compat.
   *
   * Distinct from `plugins.order` (flat plugins.txt snapshot) and
   * from `loadOrder` (Vortex's generic per-game LoadOrder).
   * NOT diffed yet — captured for the future installer.
   */
  userlist?: CapturedUserlist;
};

/**
 * How "interesting" a field difference is to a human reviewing a diff:
 *  - `content`  — real drift (version, bytes, FOMOD choices, rules, ...).
 *  - `cosmetic` — display-only (mod display name).
 *  - `metadata` — provenance/UI bookkeeping (source, installer flags).
 *
 * Machine-LOCAL fields (`id`, `archiveId`, `installOrder`, `installTime`)
 * are not compared at all — they differ on every machine and are not drift.
 */
export type DiffCategory = "content" | "cosmetic" | "metadata";

export type ModFieldDifference = {
  field: string;
  category: DiffCategory;
  referenceValue: unknown;
  currentValue: unknown;
};

export type ChangedModReport = {
  compareKey: string;
  /** Which identity tier matched this pair (see modIdentity.ts). */
  matchTier: MatchTier;
  /** 0..1 confidence of the match (1.0 for exact identity tiers). */
  confidence: number;
  reference: AuditorMod;
  current: AuditorMod;
  differences: ModFieldDifference[];
};

/**
 * A matched pair with NO meaningful (non-local) differences. Kept compact
 * — the viewer only needs to show name/version/enabled plus the match tier.
 */
export type MatchedModSummary = {
  compareKey: string;
  matchTier: MatchTier;
  confidence: number;
  name: string;
  version?: string;
  enabled: boolean;
};

export type ModsDiffReport = {
  generatedAt: string;

  reference: {
    gameId?: string;
    profileId?: string;
    exportedAt?: string;
    count: number;
  };

  current: {
    gameId?: string;
    profileId?: string;
    exportedAt?: string;
    count: number;
  };

  summary: {
    onlyInReference: number;
    onlyInCurrent: number;
    /** Matched pairs with at least one meaningful difference. */
    changed: number;
    /** Matched pairs with no meaningful difference. */
    unchanged: number;
    /** Total matched pairs (changed + unchanged). */
    matched: number;
    /** How many matches landed in each identity tier. */
    matchedByTier: Partial<Record<MatchTier, number>>;
  };

  onlyInReference: AuditorMod[];
  onlyInCurrent: AuditorMod[];
  changed: ChangedModReport[];
  unchanged: MatchedModSummary[];
};

/**
 * @deprecated Superseded by the tiered matcher in
 * `src/core/identity/modIdentity.ts` (`matchSnapshots`). The non-Nexus
 * fallbacks here (`archive:<archiveId>`, `id:<mod.id>`) are MACHINE-LOCAL
 * and cause cross-machine false splits. Retained only to derive a stable
 * `compareKey` label for report entries and for backward compatibility
 * with external references; do NOT use it to match two snapshots.
 */
export function getModCompareKey(mod: AuditorMod): string {
  if (mod.nexusModId !== undefined && mod.nexusFileId !== undefined) {
    return `nexus:${mod.nexusModId}:${mod.nexusFileId}`;
  }

  if (mod.archiveId) {
    return `archive:${mod.archiveId}`;
  }

  return `id:${mod.id}`;
}

/**
 * Recursively sort object keys for byte-stable JSON serialization.
 * Arrays preserve their order (their order is meaningful); only object
 * key ordering is normalized.
 *
 * Used by:
 *  - `deepEqualStable` for order-insensitive comparisons.
 *  - `core/manifest/packageZip` for deterministic `manifest.json` output.
 */
export function sortDeep(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortDeep);
  }

  if (value && typeof value === "object") {
    return Object.keys(value as Record<string, unknown>)
      .sort()
      .reduce<Record<string, unknown>>((acc, key) => {
        acc[key] = sortDeep((value as Record<string, unknown>)[key]);
        return acc;
      }, {});
  }

  return value;
}

export function deepEqualStable(a: unknown, b: unknown): boolean {
  return JSON.stringify(sortDeep(a)) === JSON.stringify(sortDeep(b));
}

/**
 * Fields compared between two matched mods, tagged by category.
 *
 * Machine-LOCAL fields are deliberately absent: `id`, `archiveId`,
 * `installOrder`, and `installTime` differ on every machine and are not
 * drift — including them drowned the real signal (byte/version changes)
 * under ~100%-noise diffs.
 */
const COMPARE_FIELDS: Array<{ field: keyof AuditorMod; category: DiffCategory }> =
  [
    { field: "name", category: "cosmetic" },
    { field: "version", category: "content" },
    { field: "enabled", category: "content" },
    { field: "source", category: "metadata" },
    { field: "nexusModId", category: "metadata" },
    { field: "nexusFileId", category: "content" },
    { field: "archiveSha256", category: "content" },
    { field: "collectionIds", category: "metadata" },
    { field: "installerType", category: "metadata" },
    { field: "hasInstallerChoices", category: "metadata" },
    { field: "hasDetailedInstallerChoices", category: "content" },
    { field: "fomodSelections", category: "content" },
    { field: "rules", category: "content" },
    { field: "modType", category: "content" },
    { field: "fileOverrides", category: "content" },
    { field: "enabledINITweaks", category: "content" },
  ];

export function compareMods(
  referenceMod: AuditorMod,
  currentMod: AuditorMod,
): ModFieldDifference[] {
  const differences: ModFieldDifference[] = [];

  for (const { field, category } of COMPARE_FIELDS) {
    if (!deepEqualStable(referenceMod[field], currentMod[field])) {
      differences.push({
        field: String(field),
        category,
        referenceValue: referenceMod[field],
        currentValue: currentMod[field],
      });
    }
  }

  return differences;
}

export function compareSnapshots(
  referenceSnapshot: ExportedModsSnapshot,
  currentSnapshot: ExportedModsSnapshot,
): ModsDiffReport {
  const referenceMods = referenceSnapshot.mods ?? [];
  const currentMods = currentSnapshot.mods ?? [];

  const { matches, onlyInReference, onlyInCurrent } = matchSnapshots(
    referenceMods,
    currentMods,
  );

  const changed: ChangedModReport[] = [];
  const unchanged: MatchedModSummary[] = [];
  const matchedByTier: Partial<Record<MatchTier, number>> = {};

  for (const match of matches) {
    matchedByTier[match.tier] = (matchedByTier[match.tier] ?? 0) + 1;

    const compareKey = getModCompareKey(match.reference);
    const differences = compareMods(match.reference, match.current);

    if (differences.length > 0) {
      changed.push({
        compareKey,
        matchTier: match.tier,
        confidence: match.confidence,
        reference: match.reference,
        current: match.current,
        differences,
      });
    } else {
      unchanged.push({
        compareKey,
        matchTier: match.tier,
        confidence: match.confidence,
        name: match.current.name,
        version: match.current.version,
        enabled: match.current.enabled,
      });
    }
  }

  return {
    generatedAt: new Date().toISOString(),

    reference: {
      gameId: referenceSnapshot.gameId,
      profileId: referenceSnapshot.profileId,
      exportedAt: referenceSnapshot.exportedAt,
      count: referenceMods.length,
    },

    current: {
      gameId: currentSnapshot.gameId,
      profileId: currentSnapshot.profileId,
      exportedAt: currentSnapshot.exportedAt,
      count: currentMods.length,
    },

    summary: {
      onlyInReference: onlyInReference.length,
      onlyInCurrent: onlyInCurrent.length,
      changed: changed.length,
      unchanged: unchanged.length,
      matched: matches.length,
      matchedByTier,
    },

    onlyInReference,
    onlyInCurrent,
    changed,
    unchanged,
  };
}

export async function exportDiffReport(params: {
  diff: ModsDiffReport;
  outputDir: string;
  gameId: string;
}): Promise<string> {
  const { diff, outputDir, gameId } = params;

  await fs.mkdir(outputDir, { recursive: true });

  const filePath = path.join(
    outputDir,
    `event-horizon-mod-diff-${gameId}-${Date.now()}.json`,
  );

  await fs.writeFile(filePath, JSON.stringify(diff, null, 2), "utf8");

  return filePath;
}

export async function pickTxtFile(
  api: types.IExtensionApi,
): Promise<string | undefined> {
  const filePath = await api.selectFile({
    title: "Select reference plugins.txt",
    filters: [
      { name: "Text files", extensions: ["txt"] },
      { name: "All files", extensions: ["*"] },
    ],
  });

  return filePath?.length ? filePath : undefined;
}
