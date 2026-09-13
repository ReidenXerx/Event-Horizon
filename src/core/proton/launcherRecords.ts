/**
 * Which Wine prefix a launcher runs a game in, from the record the launcher
 * itself keeps — read from each launcher's source, not guessed:
 *
 *  - Heroic keeps its settings in `app.getPath("appData")/heroic`:
 *    ~/.config/heroic, or ~/.var/app/com.heroicgameslauncher.hgl/config/heroic
 *    for the Flatpak. A game's own settings are `GamesConfig/<appName>.json`,
 *    `{ "<appName>": { "winePrefix": … } }`, "~" meaning the home; without one it
 *    uses `config.json` → `defaultSettings.winePrefix`, which starts out as
 *    ~/Games/Heroic/Prefixes/shared. GOG games Heroic installed are listed in
 *    `gog_store/installed.json`, and a GOG game's appName is the product id its
 *    `goggame-<id>.info` is named after (src/backend: constants/paths.ts,
 *    config.ts, game_config.ts, storeManagers/gog/library.ts).
 *  - Steam runs a Proton game in `steamapps/compatdata/<appId>` of its library.
 *
 * A Heroic record for a game Heroic does not list as installed — or installed
 * in another folder — is not a candidate at all: guessing wrong here blocks an
 * install that would have worked.
 */

import * as fsp from "fs/promises";
import * as path from "path";

import { parseAppManifest } from "../environment/storeFileLists";
import { basenameOf } from "../paths";
import { errorCode, readJson } from "./fsFacts";
import { linuxPathOf, linuxPathThroughRoot, reachLinuxPath, type WineHost } from "./host";

export type PrefixSource = "heroic" | "steam";

export type PrefixCandidate = {
  source: PrefixSource;
  /** The record and what it said, in words. */
  detail: string;
  /** The prefix folder, as this process reaches it. */
  reached: string;
  /** The same folder as a Linux path, when known — the name a Linux user recognises. */
  linuxPath?: string;
  /** The launcher names this game's prefix outright, not a default the game falls back to. */
  explicit: boolean;
  /** Steam's app id, for a Steam prefix. */
  appId?: string;
  /** Drive C inside the prefix; absent when the prefix does not exist. */
  driveC?: string;
  /** The prefix's user folders, by name. */
  users?: string[];
  /** Whether a user folder in it holds this game's settings folder. */
  holdsGameSettings?: boolean;
};

const objectOf = (v: unknown): Record<string, unknown> | undefined =>
  typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
const stringOf = (v: unknown): string | undefined => (typeof v === "string" && v.trim().length > 0 ? v.trim() : undefined);

/** Where Heroic keeps its settings, relative to a home: the native build, then the Flatpak. */
const HEROIC_DIRS_IN_HOME = [".config/heroic", ".var/app/com.heroicgameslauncher.hgl/config/heroic"];

function heroicCandidate(
  host: WineHost,
  home: string | undefined,
  recorded: string,
  base: { detail: string; explicit: boolean },
  looked: string[],
): PrefixCandidate | undefined {
  const expanded = home !== undefined ? recorded.replace(/^~(?=\/|$)/, home) : recorded;
  const linux = expanded.startsWith("/") ? linuxPathOf(expanded) : undefined;
  if (linux === undefined) {
    looked.push(`${base.detail}: "${recorded}" is not a Linux path`);
    return undefined;
  }
  return { source: "heroic", ...base, reached: reachLinuxPath(host, linux), linuxPath: linux };
}

export async function heroicCandidates(
  gameDir: string,
  host: WineHost,
  homes: readonly string[],
  looked: string[],
): Promise<PrefixCandidate[]> {
  let names: string[];
  try {
    names = await fsp.readdir(gameDir);
  } catch (err) {
    looked.push(`Heroic: could not list ${gameDir} (${errorCode(err)})`);
    return [];
  }
  const ids = [
    ...new Set(names.map((n) => /^goggame-(\d+)\.info$/i.exec(n)?.[1]).filter((id): id is string => id !== undefined)),
  ];
  if (ids.length === 0) {
    looked.push(`Heroic: no goggame-<id>.info in ${gameDir}, so no GOG product id to look up`);
    return [];
  }
  const dirs: Array<{ dir: string; home: string | undefined }> = [];
  const addDir = (dir: string, home: string | undefined): void => {
    if (!dirs.some((d) => d.dir === dir)) dirs.push({ dir, home });
  };
  if (host.xdgConfigHome !== undefined) addDir(`${host.xdgConfigHome}/heroic`, homes[0]);
  for (const home of homes) for (const rel of HEROIC_DIRS_IN_HOME) addDir(`${home}/${rel}`, home);
  if (dirs.length === 0) looked.push("Heroic: no Linux home to look in");

  const out: PrefixCandidate[] = [];
  for (const { dir, home } of dirs) {
    const installedFile = `${dir}/gog_store/installed.json`;
    const installed = await readJson(reachLinuxPath(host, installedFile));
    if (installed.kind !== "ok") {
      looked.push(`${installedFile}: ${installed.kind === "missing" ? "not there" : `unreadable (${installed.why})`}`);
      continue;
    }
    const list = objectOf(installed.value)?.["installed"];
    const records = Array.isArray(list) ? list.map(objectOf) : [];
    for (const id of ids) {
      const record = records.find((r) => r?.["appName"] === id);
      if (record === undefined) {
        looked.push(`${installedFile}: GOG product ${id} is not installed through Heroic`);
        continue;
      }
      const installPath = stringOf(record["install_path"]);
      if (installPath !== undefined && basenameOf(installPath).toLowerCase() !== basenameOf(gameDir).toLowerCase()) {
        looked.push(`${installedFile}: Heroic installed ${id} in ${installPath}, not in the folder Vortex manages`);
        continue;
      }
      const configFile = `${dir}/GamesConfig/${id}.json`;
      const config = await readJson(reachLinuxPath(host, configFile));
      const own = config.kind === "ok" ? stringOf(objectOf(objectOf(config.value)?.[id])?.["winePrefix"]) : undefined;
      let candidate: PrefixCandidate | undefined;
      if (own !== undefined) {
        candidate = heroicCandidate(host, home, own, { detail: `${configFile} → winePrefix`, explicit: true }, looked);
      } else {
        const why = `${configFile} ${config.kind === "ok" ? "names no winePrefix" : config.kind === "missing" ? "is not there" : `is unreadable (${config.why})`}`;
        const globalFile = `${dir}/config.json`;
        const global = await readJson(reachLinuxPath(host, globalFile));
        const fallback =
          global.kind === "ok" ? stringOf(objectOf(objectOf(global.value)?.["defaultSettings"])?.["winePrefix"]) : undefined;
        candidate =
          fallback !== undefined
            ? heroicCandidate(
                host,
                home,
                fallback,
                { detail: `${why}; Heroic's default, ${globalFile} → defaultSettings.winePrefix`, explicit: false },
                looked,
              )
            : heroicCandidate(
                host,
                home,
                "~/Games/Heroic/Prefixes/shared",
                { detail: `${why}, and ${globalFile} names no default; Heroic's built-in default`, explicit: false },
                looked,
              );
      }
      if (candidate !== undefined) out.push(candidate);
    }
  }
  return out;
}

export async function steamCandidates(gameDir: string, host: WineHost, looked: string[]): Promise<PrefixCandidate[]> {
  const commonDir = path.dirname(gameDir);
  const steamapps = path.dirname(commonDir);
  if (path.basename(commonDir).toLowerCase() !== "common" || path.basename(steamapps).toLowerCase() !== "steamapps") {
    looked.push(`Steam: ${gameDir} is not in a Steam library`);
    return [];
  }
  let names: string[];
  try {
    names = (await fsp.readdir(steamapps)).filter((n) => /^appmanifest_\d+\.acf$/i.test(n)).sort();
  } catch (err) {
    looked.push(`Steam: could not list ${steamapps} (${errorCode(err)})`);
    return [];
  }
  const folder = path.basename(gameDir).toLowerCase();
  const out: PrefixCandidate[] = [];
  for (const name of names) {
    const acf = path.join(steamapps, name);
    let app: ReturnType<typeof parseAppManifest>;
    try {
      app = parseAppManifest(await fsp.readFile(acf, "utf8"));
    } catch (err) {
      looked.push(`Steam: could not read ${acf} (${errorCode(err)})`);
      continue;
    }
    if (app === undefined || app.installDir.toLowerCase() !== folder) continue;
    const reached = path.join(steamapps, "compatdata", app.appId);
    const linux = linuxPathThroughRoot(host, reached);
    out.push({
      source: "steam",
      detail: `${acf} → ${reached}`,
      reached,
      ...(linux !== undefined ? { linuxPath: linux } : {}),
      explicit: true,
      appId: app.appId,
    });
  }
  if (out.length === 0) looked.push(`Steam: no app manifest in ${steamapps} installs into "${path.basename(gameDir)}"`);
  return out;
}
