/**
 * Dashboard data layer.
 *
 * Gathers everything the home dashboard renders, in one shot. The
 * page reads these fields once on mount and never recomputes them
 * mid-render, which keeps the dashboard simple and the UI snappy.
 *
 * Sources:
 *   - Vortex state (active game, profile, Vortex version)
 *   - %APPDATA%/Vortex/event-horizon/installs/*.json   (player receipts)
 *   - %APPDATA%/Vortex/event-horizon/collections/.config/*.json
 *                                                      (curator configs)
 *   - %APPDATA%/Vortex/event-horizon/collections/*.ehcoll, *.zip
 *                                                      (built packages)
 *
 * Errors per file are accumulated, not thrown — one bad receipt
 * doesn't take the whole dashboard down.
 */

import * as fsp from "fs/promises";
import * as path from "path";
import { util } from "@nexusmods/vortex-api";
import type { types } from "@nexusmods/vortex-api";

import { listReceipts } from "../../../core/installLedger";
import {
  getActiveGameId,
  getActiveProfileIdFromState,
} from "../../../core/getModsListForProfile";
import {
  resolveProfileName,
  resolveVortexVersion,
} from "../../../core/resolver/userState";
import type { CollectionConfig } from "../../../core/manifest/collectionConfig";
import { packageFormatOf } from "../../../core/manifest/packageFileName";
import type { InstallReceipt } from "../../../types/installLedger";
import type { SupportedGameId } from "../../../types/ehcoll";
import { getCollectionsConfigDir, getCollectionsDir, getVortexUserDataPath } from "../../../core/paths";

// ===========================================================================
// Public types
// ===========================================================================

export const SUPPORTED_GAME_IDS: ReadonlySet<string> = new Set<SupportedGameId>([
  "skyrimse",
  "fallout3",
  "falloutnv",
  "fallout4",
  "starfield",
]);

export interface SystemStatus {
  /** Active game id, or `undefined` if no game is selected in Vortex. */
  gameId: string | undefined;
  /** True iff Event Horizon supports the active game. */
  gameIsSupported: boolean;
  /** Human-readable label for the active game. */
  gameLabel: string;
  /** Active profile id (any game) or `undefined`. */
  profileId: string | undefined;
  /** Display name for the active profile. */
  profileName: string | undefined;
  /** Reported Vortex version, or `"unknown"` if Vortex doesn't tell us. */
  vortexVersion: string;
  /** Where receipts and configs live on this machine. */
  appDataPath: string;
}

export interface CuratorConfigSummary {
  /** Slug derived from the file name (i.e. without `.json`). */
  slug: string;
  /** Absolute path of the JSON file. */
  configPath: string;
  /** Cached mtime — used to sort by "most recently edited". */
  modifiedAt: number;
  /** Loaded config (only present if parsing succeeded). */
  config?: CollectionConfig;
  /** Set if loading the config failed. */
  error?: string;
}

export interface BuiltPackageSummary {
  /** Absolute path of the .ehcoll archive. */
  packagePath: string;
  /** File name including extension. */
  fileName: string;
  /** mtime in ms since epoch. */
  modifiedAt: number;
  /** Size in bytes (best-effort). */
  sizeBytes: number;
}

export interface DashboardData {
  status: SystemStatus;
  receipts: InstallReceipt[];
  receiptErrors: Array<{ filename: string; message: string }>;
  curatorConfigs: CuratorConfigSummary[];
  builtPackages: BuiltPackageSummary[];
}

// ===========================================================================
// Public API
// ===========================================================================

/**
 * Read everything the dashboard needs in parallel. Always resolves —
 * per-section errors land on the relevant slice of the result so the
 * dashboard can still render the parts that worked.
 */
export async function loadDashboardData(
  api: types.IExtensionApi,
): Promise<DashboardData> {
  const status = readSystemStatus(api);
  const appDataPath = status.appDataPath;

  const [receiptsResult, configsResult, packagesResult] = await Promise.all([
    loadReceipts(appDataPath),
    loadCuratorConfigs(appDataPath),
    loadBuiltPackages(appDataPath),
  ]);

  return {
    status,
    receipts: receiptsResult.receipts,
    receiptErrors: receiptsResult.errors,
    curatorConfigs: configsResult,
    builtPackages: packagesResult,
  };
}

// ===========================================================================
// System status
// ===========================================================================

export function readSystemStatus(api: types.IExtensionApi): SystemStatus {
  const state = api.getState();
  const gameId = getActiveGameId(state);
  const profileId = gameId ? getActiveProfileIdFromState(state, gameId) : undefined;
  const profileName =
    profileId !== undefined ? resolveProfileName(state, profileId) : undefined;
  const vortexVersion = resolveVortexVersion(state);

  return {
    gameId,
    gameIsSupported: gameId !== undefined && SUPPORTED_GAME_IDS.has(gameId),
    gameLabel: formatGameLabel(gameId),
    profileId,
    profileName,
    vortexVersion,
    appDataPath: getVortexUserDataPath(),
  };
}

// ===========================================================================
// Receipts
// ===========================================================================

async function loadReceipts(appDataPath: string): Promise<{
  receipts: InstallReceipt[];
  errors: Array<{ filename: string; message: string }>;
}> {
  const errors: Array<{ filename: string; message: string }> = [];
  let receipts: InstallReceipt[] = [];
  try {
    receipts = await listReceipts(appDataPath, (filename, err) => {
      errors.push({ filename, message: err.message });
    });
  } catch (err) {
    errors.push({
      filename: "<install-ledger>",
      message: err instanceof Error ? err.message : String(err),
    });
  }
  /**
   * Newest first — and an undateable receipt sorts LAST rather than
   * poisoning the comparison.
   *
   * `new Date("").getTime()` is NaN, every comparison with it is false, and
   * a comparator that returns NaN is not an ordering: V8 is then free to
   * permute the whole array. The dashboard takes the first entry as the
   * collection it puts a Play button on, so one malformed timestamp could
   * hand the screen to an arbitrary collection — the `receipts[0]` scar
   * through a different door.
   */
  const installedAtMs = (r: InstallReceipt): number => {
    const t = Date.parse(r.installedAt);
    return Number.isFinite(t) ? t : Number.NEGATIVE_INFINITY;
  };
  receipts.sort((a, b) => installedAtMs(b) - installedAtMs(a));
  return { receipts, errors };
}

// ===========================================================================
// Curator configs
// ===========================================================================

async function loadCuratorConfigs(
  appDataPath: string,
): Promise<CuratorConfigSummary[]> {
  const configDir = getCollectionsConfigDir();

  let entries: string[];
  try {
    entries = await fsp.readdir(configDir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    return [];
  }

  const out: CuratorConfigSummary[] = [];
  await Promise.all(
    entries
      .filter((e) => e.toLowerCase().endsWith(".json"))
      .map(async (entry) => {
        const fullPath = path.join(configDir, entry);
        const slug = entry.slice(0, -".json".length);
        try {
          const [stat, raw] = await Promise.all([
            fsp.stat(fullPath),
            fsp.readFile(fullPath, "utf8"),
          ]);
          let config: CollectionConfig | undefined;
          try {
            config = JSON.parse(raw) as CollectionConfig;
          } catch (parseErr) {
            out.push({
              slug,
              configPath: fullPath,
              modifiedAt: stat.mtimeMs,
              error:
                parseErr instanceof Error
                  ? parseErr.message
                  : String(parseErr),
            });
            return;
          }
          out.push({
            slug,
            configPath: fullPath,
            modifiedAt: stat.mtimeMs,
            config,
          });
        } catch (err) {
          out.push({
            slug,
            configPath: fullPath,
            modifiedAt: 0,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }),
  );

  out.sort((a, b) => b.modifiedAt - a.modifiedAt);
  return out;
}

// ===========================================================================
// Built packages
// ===========================================================================

async function loadBuiltPackages(
  appDataPath: string,
): Promise<BuiltPackageSummary[]> {
  const dir = getCollectionsDir();
  let entries: string[];
  try {
    entries = await fsp.readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    return [];
  }

  const out: BuiltPackageSummary[] = [];
  await Promise.all(
    entries
      .filter((e) => packageFormatOf(e) !== undefined)
      .map(async (entry) => {
        const fullPath = path.join(dir, entry);
        try {
          const stat = await fsp.stat(fullPath);
          if (!stat.isFile()) return;
          // A .zip counts only when manifest.json sits at its root.
          if (packageFormatOf(entry) === "zip") {
            const { hasPackageManifest } = await import("../../../core/manifest/readEhcoll");
            if (!(await hasPackageManifest(fullPath).catch(() => false))) return;
          }
          out.push({
            packagePath: fullPath,
            fileName: entry,
            modifiedAt: stat.mtimeMs,
            sizeBytes: stat.size,
          });
        } catch {
          // Ignore — file might have been deleted between readdir and stat.
        }
      }),
  );

  out.sort((a, b) => b.modifiedAt - a.modifiedAt);
  return out;
}

// ===========================================================================
// Helpers
// ===========================================================================

const GAME_LABELS: Record<string, string> = {
  skyrimse: "Skyrim Special Edition",
  fallout3: "Fallout 3",
  falloutnv: "Fallout: New Vegas",
  fallout4: "Fallout 4",
  starfield: "Starfield",
};

function formatGameLabel(gameId: string | undefined): string {
  if (gameId === undefined) return "No game selected";
  return GAME_LABELS[gameId] ?? gameId;
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

export function formatRelativeTime(ms: number, now: number = Date.now()): string {
  const delta = Math.max(0, now - ms);
  const sec = Math.floor(delta / 1000);
  if (sec < 60) return "just now";
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} min ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `${day}d ago`;
  const wk = Math.floor(day / 7);
  if (wk < 5) return `${wk}w ago`;
  const mo = Math.floor(day / 30);
  if (mo < 12) return `${mo}mo ago`;
  const yr = Math.floor(day / 365);
  return `${yr}y ago`;
}
