/**
 * ──────────────────────────────────────────────────────────────────────
 * Under Wine/Proton: which prefix does the GAME run in, and do Vortex and the
 * game use the same settings folders?
 *
 * A Wine prefix is a Windows install of its own — its own C:, its own
 * Documents and AppData. On Linux, Vortex and the game are often in different
 * ones. The tester who found this ran Vortex in one Proton prefix and
 * Fallout 4 from Heroic in another: Vortex wrote plugins.txt and every INI
 * edit into ITS prefix (C:\users\steamuser), the game read its own, and the
 * preflight — reading Vortex's — said the game had never been started, after
 * he had started it from Heroic.
 *
 * So the game's prefix comes from the record its launcher keeps, and whether a
 * folder is shared is PROVEN, not read off paths: a file written into Vortex's
 * copy either shows up in the game's or it does not. People share the folders
 * by linking them, or by running Vortex inside the game's prefix; both pass,
 * and a copy — identical until the first write — does not.
 *
 * Where the records are, read from each project's source:
 *  - Wine maps "/" to Z: and gives every process the Linux home and its own
 *    prefix as NT paths, WINEHOMEDIR and WINECONFIGDIR; the host's HOME and
 *    XDG_* arrive renamed WINE_HOST_HOME, WINE_HOST_XDG_* (dlls/ntdll/unix/env.c).
 *  - Heroic keeps its settings in `app.getPath("appData")/heroic`: ~/.config/heroic,
 *    or ~/.var/app/com.heroicgameslauncher.hgl/config/heroic for the Flatpak.
 *    A game's own settings are `GamesConfig/<appName>.json`,
 *    `{ "<appName>": { "winePrefix": … } }`, "~" meaning the home; without one
 *    it uses `config.json` → `defaultSettings.winePrefix`, which starts out as
 *    ~/Games/Heroic/Prefixes/shared. GOG games Heroic installed are listed in
 *    `gog_store/installed.json`, and a GOG game's appName is the product id its
 *    `goggame-<id>.info` is named after (src/backend: constants/paths.ts,
 *    config.ts, game_config.ts, storeManagers/gog/library.ts).
 *  - Steam runs a Proton game in `steamapps/compatdata/<appId>` of its library.
 *  - A Proton prefix keeps drive C in `pfx/drive_c`, a Wine prefix in `drive_c`.
 *
 * Guessing wrong here blocks an install that would have worked, so a record
 * that only names a DEFAULT prefix counts only when that prefix holds this
 * game's settings, and a Heroic record for a game Heroic does not list as
 * installed — or installed in another folder — is not used at all.
 * ──────────────────────────────────────────────────────────────────────
 */

import { randomUUID } from "crypto";
import * as fsp from "fs/promises";
import * as path from "path";

import { basenameOf, segmentsOf } from "../paths";
import { parseAppManifest } from "./storeFileLists";

// ── What Wine says ───────────────────────────────────────────────────────

export type WineHost = {
  /** Where the Linux root "/" is reachable from this process. Wine maps it to Z:. */
  unixRoot: string;
  /** Linux home directories, as Linux paths, most likely first. Empty when Wine did not say. */
  homes: string[];
  /** The host's XDG_CONFIG_HOME, a Linux path, when it was set. */
  xdgConfigHome?: string;
  /** The prefix Vortex itself runs in, a Linux path, when Wine said. */
  vortexPrefix?: string;
};

/**
 * A Linux path, or a Wine NT path through Z: (`\??\Z:\home\me`), as a Linux
 * path. Any other drive letter maps somewhere only Wine's own prefix knows, so
 * that is `undefined` rather than a guess.
 */
export function linuxPathOf(value: string | undefined): string | undefined {
  const v = value?.trim();
  if (v === undefined || v.length === 0) return undefined;
  if (v.startsWith("/")) return `/${segmentsOf(v).join("/")}`;
  const nt = /^(?:\\\?\?\\|\\\\\?\\)?[zZ]:(?:[\\/](.*))?$/.exec(v);
  return nt === null ? undefined : `/${segmentsOf(nt[1] ?? "").join("/")}`;
}

export function readWineHost(env: Readonly<Record<string, string | undefined>>): WineHost {
  const homes: string[] = [];
  const addHome = (p: string | undefined): void => {
    if (p !== undefined && p !== "/" && !homes.includes(p)) homes.push(p);
  };
  addHome(linuxPathOf(env["WINE_HOST_HOME"]));
  addHome(linuxPathOf(env["WINEHOMEDIR"]));
  // A HOME that is a Linux path can only have come from the host.
  if (env["HOME"]?.startsWith("/") === true) addHome(linuxPathOf(env["HOME"]));
  const xdg =
    linuxPathOf(env["WINE_HOST_XDG_CONFIG_HOME"]) ??
    (env["XDG_CONFIG_HOME"]?.startsWith("/") === true ? linuxPathOf(env["XDG_CONFIG_HOME"]) : undefined);
  const vortexPrefix = linuxPathOf(env["WINECONFIGDIR"]);
  return {
    unixRoot: "Z:\\",
    homes,
    ...(xdg !== undefined ? { xdgConfigHome: xdg } : {}),
    ...(vortexPrefix !== undefined ? { vortexPrefix } : {}),
  };
}

/** A Linux path, as this process reaches it. */
export function reachLinuxPath(host: WineHost, linuxPath: string): string {
  return path.join(host.unixRoot, ...segmentsOf(linuxPath));
}

/** A path this process reaches through the Linux root, as that Linux path. */
export function linuxPathThroughRoot(host: WineHost, reached: string): string | undefined {
  const root = segmentsOf(host.unixRoot);
  const segs = segmentsOf(reached);
  if (segs.length < root.length || root.some((s, i) => s.toLowerCase() !== segs[i]!.toLowerCase())) return undefined;
  return `/${segs.slice(root.length).join("/")}`;
}

/** The part of `child` below `parent`, "/"-separated. Case-insensitive, as Windows and Wine compare. */
export function relativeUnder(parent: string, child: string): string | undefined {
  const p = segmentsOf(parent);
  const c = segmentsOf(child);
  if (c.length <= p.length || p.some((s, i) => s.toLowerCase() !== c[i]!.toLowerCase())) return undefined;
  return c.slice(p.length).join("/");
}

/** `p` moved from under `fromRoot` to the same place under `toRoot`; `undefined` when it is not under `fromRoot`. */
export function rebaseUnder(fromRoot: string, toRoot: string, p: string): string | undefined {
  const rel = relativeUnder(fromRoot, p);
  return rel === undefined ? undefined : path.join(toRoot, ...segmentsOf(rel));
}

/** A path on Vortex's own C: as a Linux path — Wine keeps drive C in `<prefix>/drive_c`. */
function vortexLinuxPath(host: WineHost, reached: string): string | undefined {
  if (host.vortexPrefix === undefined) return undefined;
  const segs = segmentsOf(reached);
  return segs[0]?.toLowerCase() === "c:" ? `${host.vortexPrefix}/drive_c/${segs.slice(1).join("/")}` : undefined;
}

// ── Which prefix the launcher runs the game in ───────────────────────────

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

type Resolved = PrefixCandidate & { driveC: string; holdsGameSettings: boolean };

type JsonRead = { kind: "ok"; value: unknown } | { kind: "missing" } | { kind: "unreadable"; why: string };

/** Launcher settings are kilobytes; a file past this is not one. */
const MAX_JSON_BYTES = 16 * 1024 * 1024;

function errorCode(err: unknown): string {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : err instanceof Error ? err.message : String(err);
}

async function readJson(file: string): Promise<JsonRead> {
  let text: string;
  try {
    const stat = await fsp.stat(file);
    if (!stat.isFile()) return { kind: "missing" };
    if (stat.size > MAX_JSON_BYTES) return { kind: "unreadable", why: `${stat.size} bytes` };
    text = await fsp.readFile(file, "utf8");
  } catch (err) {
    const code = errorCode(err);
    return code === "ENOENT" || code === "ENOTDIR" ? { kind: "missing" } : { kind: "unreadable", why: code };
  }
  try {
    return { kind: "ok", value: JSON.parse(text) as unknown };
  } catch {
    return { kind: "unreadable", why: "not JSON" };
  }
}

const objectOf = (v: unknown): Record<string, unknown> | undefined =>
  typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
const stringOf = (v: unknown): string | undefined => (typeof v === "string" && v.trim().length > 0 ? v.trim() : undefined);

async function isDirectory(p: string): Promise<boolean> {
  try {
    return (await fsp.stat(p)).isDirectory();
  } catch {
    return false;
  }
}

async function exists(p: string): Promise<boolean> {
  try {
    await fsp.stat(p);
    return true;
  } catch {
    return false;
  }
}

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

async function heroicCandidates(
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

async function steamCandidates(gameDir: string, host: WineHost, looked: string[]): Promise<PrefixCandidate[]> {
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

async function driveCOf(prefix: string): Promise<string | undefined> {
  for (const candidate of [path.join(prefix, "pfx", "drive_c"), path.join(prefix, "drive_c")]) {
    if (await isDirectory(candidate)) return candidate;
  }
  return undefined;
}

async function userDirsOf(driveC: string): Promise<string[]> {
  let names: string[];
  try {
    names = await fsp.readdir(path.join(driveC, "users"));
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const name of names.sort()) {
    if (name.toLowerCase() === "public") continue;
    const full = path.join(driveC, "users", name);
    if (await isDirectory(full)) out.push(full);
  }
  return out;
}

async function usersHolding(users: readonly string[], rel: string): Promise<string[]> {
  const out: string[] = [];
  for (const user of users) {
    if (await isDirectory(path.join(user, ...segmentsOf(rel)))) out.push(user);
  }
  return out;
}

async function scanHomes(host: WineHost): Promise<string[]> {
  const out: string[] = [];
  for (const base of ["/home", "/var/home"]) {
    let names: string[];
    try {
      names = (await fsp.readdir(reachLinuxPath(host, base))).sort();
    } catch {
      continue;
    }
    for (const name of names) {
      if (out.some((h) => basenameOf(h) === name)) continue;
      if (await isDirectory(reachLinuxPath(host, `${base}/${name}`))) out.push(`${base}/${name}`);
    }
  }
  return out;
}

// ── Whether a folder is shared ───────────────────────────────────────────

export type FolderShare = {
  /** What lives there, in words. */
  label: string;
  /** Below the user folder, "/"-separated — the same on both sides. */
  rel: string;
  /** Vortex's copy and the game's, as this process reaches them. */
  vortexDir: string;
  gameDir: string;
  vortexExists: boolean;
  gameExists: boolean;
  /** Both as Linux paths, when known — for a command the user can paste. */
  vortexLinuxPath?: string;
  gameLinuxPath?: string;
  state: "shared" | "separate" | "unprobed";
  /** The evidence, in words. */
  detail: string;
};

/**
 * Does a file written into `from` appear in `to`? Created exclusively under a
 * name nothing else uses and removed again at once, so nothing that was there
 * is ever touched.
 */
async function writesShowUp(
  from: string,
  to: string,
): Promise<{ kind: "probed"; visible: boolean } | { kind: "unprobed"; why: string }> {
  const name = `.event-horizon-prefix-probe-${randomUUID()}`;
  const written = path.join(from, name);
  try {
    await fsp.writeFile(written, "", { flag: "wx" });
  } catch (err) {
    return { kind: "unprobed", why: errorCode(err) };
  }
  try {
    return { kind: "probed", visible: await exists(path.join(to, name)) };
  } finally {
    await fsp.rm(written, { force: true }).catch(() => undefined);
  }
}

async function shareOf(
  host: WineHost,
  vortexUserDir: string,
  gameUserDir: string,
  folder: { label: string; rel: string },
): Promise<FolderShare> {
  const segs = segmentsOf(folder.rel);
  const vortexDir = path.join(vortexUserDir, ...segs);
  const gameDir = path.join(gameUserDir, ...segs);
  const vortexExists = await isDirectory(vortexDir);
  const gameExists = await isDirectory(gameDir);
  const vortexLinux = vortexLinuxPath(host, vortexDir);
  const gameLinux = linuxPathThroughRoot(host, gameDir);
  const base = {
    label: folder.label,
    rel: folder.rel,
    vortexDir,
    gameDir,
    vortexExists,
    gameExists,
    ...(vortexLinux !== undefined ? { vortexLinuxPath: vortexLinux } : {}),
    ...(gameLinux !== undefined ? { gameLinuxPath: gameLinux } : {}),
  };
  // One side has it and the other does not: they cannot be the same folder.
  if (vortexExists !== gameExists) {
    return { ...base, state: "separate", detail: vortexExists ? "only Vortex's prefix has it" : "only the game's prefix has it" };
  }
  // Neither has it yet: whoever creates it creates it inside the nearest
  // parent both have, so that parent decides.
  let depth = segs.length;
  if (!vortexExists) {
    for (depth = segs.length - 1; depth > 0; depth -= 1) {
      const v = await isDirectory(path.join(vortexUserDir, ...segs.slice(0, depth)));
      const g = await isDirectory(path.join(gameUserDir, ...segs.slice(0, depth)));
      if (v !== g) {
        return {
          ...base,
          state: "separate",
          detail: `neither prefix has it yet, and only ${v ? "Vortex's" : "the game's"} has ${segs.slice(0, depth).join("/")}`,
        };
      }
      if (v) break;
    }
  }
  const at = segs.slice(0, depth);
  const where = at.length === 0 ? "user folder" : at.join("/");
  const probe = await writesShowUp(path.join(vortexUserDir, ...at), path.join(gameUserDir, ...at));
  if (probe.kind === "unprobed") {
    return { ...base, state: "unprobed", detail: `a test file could not be written into Vortex's ${where} (${probe.why})` };
  }
  if (depth === segs.length) {
    return probe.visible
      ? { ...base, state: "shared", detail: "a test file written into Vortex's copy appeared in the game's" }
      : { ...base, state: "separate", detail: "a test file written into Vortex's copy did not appear in the game's" };
  }
  return probe.visible
    ? { ...base, state: "shared", detail: `neither prefix has it yet, and ${where}, where it will be created, is shared` }
    : { ...base, state: "separate", detail: `neither prefix has it yet, and ${where} is not shared` };
}

// ── The probe ────────────────────────────────────────────────────────────

export type WinePrefixProbe = {
  host: WineHost;
  /** Every record consulted and what it said — for the log. */
  looked: string[];
  candidates: PrefixCandidate[];
  /** The game's prefix, when the records name exactly one. */
  game?: PrefixCandidate & { driveC: string };
  /** Why the probe stopped short, in words. */
  unresolved?: string;
  vortexUserDir?: string;
  /** The user folder inside the game's prefix. */
  gameUserDir?: string;
  /** Whether the game has created its settings folder in its prefix — it does the first time it starts. */
  gameStarted?: boolean;
  folders: FolderShare[];
};

export async function probeWinePrefix(input: {
  gameDir: string;
  host: WineHost;
  /** Vortex's own user folder, C:\users\<name>. */
  vortexUserDir: string | undefined;
  /**
   * The settings folders Vortex writes for this game, as Vortex reaches them.
   * The first is the one the game creates when it first starts.
   */
  folders: ReadonlyArray<{ label: string; vortexDir: string | undefined }>;
}): Promise<WinePrefixProbe> {
  const { host, vortexUserDir } = input;
  const looked: string[] = [];
  const probe: WinePrefixProbe = {
    host,
    looked,
    candidates: [],
    ...(vortexUserDir !== undefined ? { vortexUserDir } : {}),
    folders: [],
  };
  const settings = input.folders.flatMap((f) => {
    const rel = vortexUserDir !== undefined && f.vortexDir !== undefined ? relativeUnder(vortexUserDir, f.vortexDir) : undefined;
    return rel === undefined ? [] : [{ label: f.label, rel }];
  });
  if (vortexUserDir === undefined || settings.length === 0) {
    probe.unresolved = `Vortex's settings folders (${input.folders.map((f) => f.vortexDir ?? "unknown").join(", ")}) are not inside its user folder (${vortexUserDir ?? "unknown"}), so the same folders cannot be found in another prefix.`;
    return probe;
  }
  const marker = settings[0]!;

  let homes = host.homes;
  if (homes.length === 0) {
    homes = await scanHomes(host);
    looked.push(`Wine named no Linux home; found in /home and /var/home: ${homes.length > 0 ? homes.join(", ") : "none"}`);
  }

  const found = [
    ...(await heroicCandidates(input.gameDir, host, homes, looked)),
    ...(await steamCandidates(input.gameDir, host, looked)),
  ];
  for (const c of found) {
    const driveC = await driveCOf(c.reached);
    if (driveC === undefined) {
      looked.push(`${c.linuxPath ?? c.reached} (${c.detail}): no drive_c there, so that prefix does not exist`);
      probe.candidates.push(c);
      continue;
    }
    const users = await userDirsOf(driveC);
    probe.candidates.push({
      ...c,
      driveC,
      users: users.map(basenameOf),
      holdsGameSettings: (await usersHolding(users, marker.rel)).length > 0,
    });
  }

  const describe = (c: PrefixCandidate): string => `${c.linuxPath ?? c.reached}, from ${c.detail}`;
  const existing = probe.candidates.filter((c): c is Resolved => c.driveC !== undefined);
  const distinct = (list: Resolved[]): Resolved[] =>
    list.filter((c, i) => list.findIndex((o) => o.driveC.toLowerCase() === c.driveC.toLowerCase()) === i);
  const named = distinct(existing.filter((c) => c.explicit));
  let game: Resolved | undefined;
  if (named.length === 1) {
    game = named[0];
  } else if (named.length > 1) {
    const holding = named.filter((c) => c.holdsGameSettings);
    if (holding.length === 1) {
      game = holding[0];
    } else {
      probe.unresolved = `Records name ${named.length} prefixes for this game (${named.map(describe).join("; ")}), and ${holding.length === 0 ? "none" : "more than one"} holds its settings.`;
    }
  } else {
    const holding = distinct(existing.filter((c) => c.holdsGameSettings));
    if (holding.length === 1) {
      game = holding[0];
    } else if (existing.length > 0) {
      probe.unresolved =
        holding.length === 0
          ? `Only a default prefix is recorded for this game (${existing.map(describe).join("; ")}), and it holds none of the game's settings, so it may not be the one the game runs in.`
          : `More than one default prefix holds the game's settings (${holding.map(describe).join("; ")}).`;
    }
  }
  if (game === undefined) {
    probe.unresolved ??=
      probe.candidates.length === 0
        ? "No Heroic or Steam record names a prefix for this game."
        : `No recorded prefix exists (${probe.candidates.map(describe).join("; ")}).`;
    return probe;
  }
  probe.game = game;

  const users = await userDirsOf(game.driveC);
  const holding = await usersHolding(users, marker.rel);
  const vortexName = basenameOf(vortexUserDir).toLowerCase();
  const pick = (list: string[]): string | undefined =>
    list.length === 1 ? list[0] : list.find((u) => basenameOf(u).toLowerCase() === vortexName);
  const gameUserDir = holding.length > 0 ? pick(holding) : pick(users);
  if (gameUserDir === undefined) {
    probe.unresolved = `${path.join(game.driveC, "users")} holds ${users.length > 0 ? users.map(basenameOf).join(", ") : "no user folder"}, and which one the game uses cannot be told.`;
    return probe;
  }
  probe.gameUserDir = gameUserDir;
  probe.gameStarted = holding.includes(gameUserDir);
  if (!probe.gameStarted) return probe;

  for (const folder of settings) probe.folders.push(await shareOf(host, vortexUserDir, gameUserDir, folder));
  return probe;
}
