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
 * So the game's prefix comes from the record its launcher keeps
 * (launcherRecords.ts), and whether a folder is shared is proven by a write
 * (sharedFolders.ts). Guessing wrong here blocks an install that would have
 * worked, so a record that only names a DEFAULT prefix counts only when that
 * prefix holds this game's settings.
 * ──────────────────────────────────────────────────────────────────────
 */

import * as fsp from "fs/promises";
import * as path from "path";

import { basenameOf, relativeUnder, segmentsOf } from "../paths";
import { isDirectory } from "./fsFacts";
import { reachLinuxPath, type WineHost } from "./host";
import { heroicCandidates, steamCandidates, type PrefixCandidate } from "./launcherRecords";
import { shareOf, type FolderShare } from "./sharedFolders";

type Resolved = PrefixCandidate & { driveC: string; holdsGameSettings: boolean };

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
  // Vortex's paths are Windows paths, so they compare case-insensitively even under Wine.
  const settings = input.folders.flatMap((f) => {
    const rel =
      vortexUserDir !== undefined && f.vortexDir !== undefined ? relativeUnder(vortexUserDir, f.vortexDir, "insensitive") : undefined;
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
