/**
 * Which mod the game gets each collection file from — recorded from the
 * curator's own Vortex deployment, and compared against the player's.
 *
 * ─── WHY ───────────────────────────────────────────────────────────────────
 * Every other check here asks whether the right FILES are in each mod's
 * staging folder. None asked which copy of a path the game actually gets. A
 * player whose Ivy had been updated through several revisions got "nailed"
 * breasts on every new game; a fresh install fixed it (alasdairn, 2026-10-04).
 * Every mod's files would have verified. What the install kept and a clean one
 * did not was invisible, because nothing looked at the deployment itself.
 *
 * Vortex writes `vortex.deployment.json` beside each deployment target: every
 * deployed file and the mod folder it came from. Two questions are asked of
 * the player's:
 *
 *  1. FOREIGN — a file the collection ships, deployed from a mod that is not
 *     part of the collection (a player's own mod, a leftover from an older
 *     revision). Needs nothing recorded, so it works for every package. This
 *     is the one that covers the incident: in Ivy 1.0.38 `skeleton.nif` is
 *     shipped by ZeX alone, so only something outside the collection can
 *     replace it.
 *  2. WINNER — for a path several collection mods ship ("contested", 5,178 of
 *     67,839 in Ivy 1.0.38), the mod whose copy the curator's game got, from
 *     the curator's deployment (`manifest.deployment.winners`).
 *
 * A difference between two collection mods is dropped when both copies are
 * byte-identical (the hashes are in `stagingFiles`), and is "fixable" only when
 * the collection's own rules decide that pair: otherwise no rule orders them
 * and re-applying rules cannot change who wins.
 */

import type { CapturedDeploymentManifest } from "../deploymentManifest";
import type { EhcollDeploymentWinner, EhcollRule } from "../../types/ehcoll";
import { conflictWinner } from "../environment/nativePluginCompat";

export type { EhcollDeploymentWinner };

export const normPath = (p: string): string => p.replace(/\\/g, "/").toLowerCase();

/** What both sides need to know about one collection mod. */
export type DeployModFacts = {
  compareKey: string;
  modType?: string;
  /** False for a mod the curator had installed but switched off; it ships nothing. */
  enabled?: boolean;
  files: ReadonlyArray<{ path: string; sha256?: string }>;
};

/** A deployment entry with a `target` sub-folder is in a place the relPath alone does not name. */
const plainEntries = (m: CapturedDeploymentManifest) => m.files.filter((f) => f.target === undefined || f.target === "");

/**
 * Build side: the curator's winners for every contested path.
 *
 * `folderToKey` maps a Vortex mod folder (`installationPath`, which is what a
 * deployment manifest calls `source`) to the collection mod's compareKey.
 * Recorded only when that winner really ships the path in its staging folder:
 * a deployment Vortex has not refreshed since a mod changed can still name the
 * old winner, and recording it would tell a correct player they are wrong.
 */
export function recordDeploymentWinners(input: {
  mods: readonly DeployModFacts[];
  manifests: readonly CapturedDeploymentManifest[];
  folderToKey: ReadonlyMap<string, string>;
}): EhcollDeploymentWinner[] {
  const out: EhcollDeploymentWinner[] = [];
  for (const manifest of input.manifests) {
    const type = manifest.modType ?? "";
    const shippers = shippersOf(input.mods, type);
    const byWinner = new Map<string, string[]>();
    for (const f of plainEntries(manifest)) {
      const p = normPath(f.relPath);
      const keys = shippers.get(p);
      if (keys === undefined || keys.size < 2) continue;
      const key = input.folderToKey.get(f.source.toLowerCase());
      if (key === undefined || !keys.has(key)) continue;
      const list = byWinner.get(key) ?? [];
      list.push(p);
      byWinner.set(key, list);
    }
    for (const [mod, paths] of [...byWinner].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
      out.push({ modType: type, mod, paths: paths.sort() });
    }
  }
  return out;
}

/** path → compareKeys of the ENABLED collection mods of one mod type that ship it. */
function shippersOf(mods: readonly DeployModFacts[], type: string): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const m of mods) {
    if (m.enabled === false || (m.modType ?? "") !== type) continue;
    for (const f of m.files) {
      const p = normPath(f.path);
      const set = out.get(p) ?? new Set<string>();
      set.add(m.compareKey);
      out.set(p, set);
    }
  }
  return out;
}

export type DeployFinding = {
  kind: "foreign" | "wrong-winner" | "not-deployed";
  modType: string;
  path: string;
  /** compareKey of the collection mod whose copy should be there. */
  expected: string;
  /** The folder the game got it from instead; absent for `not-deployed`. */
  actualFolder?: string;
  /** For `wrong-winner`: the other collection mod, by compareKey. */
  actualKey?: string;
  /** For `wrong-winner`: the collection's rules decide this pair, so re-applying them can fix it. */
  ruled?: boolean;
};

export type DeployReport = {
  /** Contested paths compared against the curator's winner. */
  judgedWinners: number;
  /** Collection-shipped paths checked for a foreign source. */
  judgedPaths: number;
  /** Mod types the collection ships into that the player's game has no deployment for. */
  undeployedTypes: string[];
  findings: DeployFinding[];
};

/**
 * Player side. `keyToFolder` maps a collection compareKey to the player's
 * Vortex mod folder — only for mods actually in their mod pool. A recorded
 * winner the player does not have (skipped, failed, removed) is not judged:
 * the install already reports a missing mod, and blaming each of its files
 * again would bury that one fact under hundreds of lines.
 */
export function judgeDeployment(input: {
  winners: readonly EhcollDeploymentWinner[];
  mods: readonly DeployModFacts[];
  rules: readonly EhcollRule[];
  manifests: readonly CapturedDeploymentManifest[];
  keyToFolder: ReadonlyMap<string, string>;
}): DeployReport {
  const deployed = new Map<string, Map<string, string>>();
  for (const m of input.manifests) {
    const byPath = new Map<string, string>();
    for (const f of plainEntries(m)) byPath.set(normPath(f.relPath), f.source);
    deployed.set(m.modType ?? "", byPath);
  }
  const folderToKey = new Map<string, string>();
  for (const [k, f] of input.keyToFolder) folderToKey.set(f.toLowerCase(), k);
  const shaOf = new Map<string, Map<string, string>>();
  for (const m of input.mods) {
    const byPath = new Map<string, string>();
    for (const f of m.files) if (f.sha256 !== undefined) byPath.set(normPath(f.path), f.sha256);
    shaOf.set(m.compareKey, byPath);
  }

  const findings: DeployFinding[] = [];
  const undeployedTypes = new Set<string>();
  let judgedWinners = 0;
  let judgedPaths = 0;

  // 1. Foreign: a collection file deployed from a mod outside the collection.
  const types = new Set(input.mods.map((m) => m.modType ?? ""));
  for (const type of types) {
    const shippers = shippersOf(input.mods, type);
    if (shippers.size === 0) continue;
    const byPath = deployed.get(type);
    if (byPath === undefined) {
      undeployedTypes.add(type);
      continue;
    }
    for (const [p, keys] of shippers) {
      if (![...keys].some((k) => input.keyToFolder.has(k))) continue;
      judgedPaths += 1;
      const source = byPath.get(p);
      if (source === undefined || folderToKey.has(source.toLowerCase())) continue;
      findings.push({ kind: "foreign", modType: type, path: p, expected: [...keys][0]!, actualFolder: source });
    }
  }

  // 2. Winner: a contested path the player's game gets from another collection mod, or not at all.
  for (const w of input.winners) {
    const folder = input.keyToFolder.get(w.mod);
    const byPath = deployed.get(w.modType);
    if (folder === undefined || byPath === undefined) continue;
    for (const p of w.paths) {
      judgedWinners += 1;
      const source = byPath.get(p);
      if (source === undefined) {
        findings.push({ kind: "not-deployed", modType: w.modType, path: p, expected: w.mod });
        continue;
      }
      if (source.toLowerCase() === folder.toLowerCase()) continue;
      const actualKey = folderToKey.get(source.toLowerCase());
      if (actualKey === undefined) continue; // already reported as foreign
      const a = shaOf.get(w.mod)?.get(p);
      const b = shaOf.get(actualKey)?.get(p);
      if (a !== undefined && a === b) continue; // same bytes: nothing the game can tell apart
      findings.push({
        kind: "wrong-winner",
        modType: w.modType,
        path: p,
        expected: w.mod,
        actualFolder: source,
        actualKey,
        ruled: conflictWinner([w.mod, actualKey], input.rules) === w.mod,
      });
    }
  }

  return { judgedWinners, judgedPaths, undeployedTypes: [...undeployedTypes], findings };
}

/**
 * One line per (kind, from, should-be) pair: one wrong mod can account for
 * thousands of files, and a list of paths hides that it is one cause.
 */
export function describeDeployFindings(
  findings: readonly DeployFinding[],
  nameOfKey: (key: string) => string,
  maxGroups = 30,
): string[] {
  const groups = new Map<string, { line: (n: number, eg: string) => string; paths: string[] }>();
  for (const f of findings) {
    const expected = nameOfKey(f.expected);
    const from = f.actualKey !== undefined ? nameOfKey(f.actualKey) : f.actualFolder;
    const id = `${f.kind}\u0000${from ?? ""}\u0000${expected}`;
    let g = groups.get(id);
    if (g === undefined) {
      g = {
        line:
          f.kind === "foreign"
            ? (n, eg) => `"${from}" (not part of the collection) replaces ${n} file(s) of "${expected}", e.g. ${eg}`
            : f.kind === "not-deployed"
              ? (n, eg) => `${n} file(s) of "${expected}" are not deployed, e.g. ${eg}`
              : (n, eg) =>
                  `"${from}" wins ${n} file(s) the creator's game takes from "${expected}", e.g. ${eg}` +
                  (f.ruled === true ? "" : " (no collection rule orders these two mods)"),
        paths: [],
      };
      groups.set(id, g);
    }
    g.paths.push(f.path);
  }
  const sorted = [...groups.values()].sort((a, b) => b.paths.length - a.paths.length);
  const lines = sorted.slice(0, maxGroups).map((g) => g.line(g.paths.length, g.paths.slice(0, 2).join(", ")));
  if (sorted.length > maxGroups) lines.push(`…and ${sorted.length - maxGroups} more`);
  return lines;
}

/** Total recorded contested paths. */
export const countRecordedPaths = (winners: readonly EhcollDeploymentWinner[]): number =>
  winners.reduce((n, w) => n + w.paths.length, 0);
