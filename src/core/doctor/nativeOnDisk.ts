/**
 * ──────────────────────────────────────────────────────────────────────
 * Is the script-extender side of the game right for the game version the
 * player has NOW? Read from the game folder as deployed, not from the package.
 *
 * The install names the mods to swap when the player's game differs from the
 * collection's (the version panel). A player who swaps most of them and
 * forgets one has no way to ask what is still wrong: Ruinfan, Meridia on
 * Steam 1.6.1170 (built on GOG 1.6.1179), forgot the Address Library
 * (2026-09-28). This check answers it on every Doctor visit:
 *
 *  - the script extender's runtime DLL for this version (`skse64_1_6_1170.dll`,
 *    `f4se_1_11_240.dll` in the game folder);
 *  - the Address Library file for this version, when the setup uses one
 *    (`versionlib-1-6-1170-0*.bin`, `version-1-5-97-0.bin`,
 *    `version-1-11-240-0.bin` in the plugin folder). It is a data file, not a
 *    DLL, so the plugin judgement alone never saw it;
 *  - each deployed plugin DLL that will not load on this version, named by the
 *    mod that deployed it. Same judgement the install makes.
 *
 * File names confirmed on the curator's own GOG Skyrim 1.6.1179 and Steam
 * Fallout 4 1.11.240 installs.
 * ──────────────────────────────────────────────────────────────────────
 */

import * as fs from "fs";
import * as path from "path";

import type { HealthCheck } from "./health";
import { extenderApiFor, judgePlugin, runtimeIdFor } from "../environment/nativePluginCompat";
import { readNativePluginDeclaration } from "../environment/scriptExtenderVersion";
import type { EhcollNativePlugin } from "../../types/ehcoll";

const EXTENDER: Record<string, { prefix: "skse64" | "f4se"; extender: "skse" | "f4se"; pluginDir: string; name: string } | undefined> = {
  skyrimse: { prefix: "skse64", extender: "skse", pluginDir: "SKSE/Plugins", name: "SKSE" },
  fallout4: { prefix: "f4se", extender: "f4se", pluginDir: "F4SE/Plugins", name: "F4SE" },
};

export type NativeOnDisk = {
  gameVersion: string;
  extenderName: string;
  /** The runtime DLL this version needs, and whether it is there; `found` lists the ones that are. */
  extender: { expected: string; present: boolean; found: string[] };
  /** The Address Library file this version needs; `needed` is false when nothing here uses one. */
  addressLibrary: { expected: string; present: boolean; needed: boolean };
  /** Deployed plugin DLLs that will not load on this version. */
  cannotLoad: Array<{ file: string; mod?: string; why: string }>;
};

/** "1.6.1170.0" → [1, 6, 1170]. */
const parts = (v: string): number[] | undefined => {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(v.trim());
  return m === null ? undefined : [Number(m[1]), Number(m[2]), Number(m[3])];
};

/** The Address Library file name (without extension) for a game version. */
export function addressLibraryStem(gameId: string, version: string): string | undefined {
  const v = parts(version);
  if (v === undefined) return undefined;
  const dashed = v.join("-");
  if (gameId === "skyrimse") return v[1]! >= 6 ? `versionlib-${dashed}-0` : `version-${dashed}-0`;
  if (gameId === "fallout4") return `version-${dashed}-0`;
  return undefined;
}

/**
 * Reads the game folder. Undefined when the game is not one this knows, or its
 * version or folder cannot be established: no finding is better than a guessed one.
 */
export function gatherNativeOnDisk(args: {
  gameId: string;
  gameDir: string;
  gameVersion: string;
  store?: string;
  /** Which mod deployed a file (path relative to the Data folder), when Vortex can say. */
  deployedBy?: (relPath: string) => string | undefined;
}): NativeOnDisk | undefined {
  const ext = EXTENDER[args.gameId];
  const v = parts(args.gameVersion);
  const stem = addressLibraryStem(args.gameId, args.gameVersion);
  if (ext === undefined || v === undefined || stem === undefined) return undefined;

  let rootFiles: string[];
  try {
    rootFiles = fs.readdirSync(args.gameDir);
  } catch {
    return undefined;
  }
  const expectedDll = `${ext.prefix}_${v.join("_")}.dll`;
  const runtimeDll = new RegExp(`^${ext.prefix}_\\d+_\\d+_\\d+\\.dll$`, "i");
  const found = rootFiles.filter((f) => runtimeDll.test(f));

  const pluginDir = path.join(args.gameDir, "Data", ...ext.pluginDir.split("/"));
  let pluginFiles: string[] = [];
  try {
    pluginFiles = fs.readdirSync(pluginDir);
  } catch {
    pluginFiles = [];
  }

  const runtime = runtimeIdFor(args.gameId, args.gameVersion, args.store);
  const api = extenderApiFor(args.gameId, args.gameVersion);
  const cannotLoad: NativeOnDisk["cannotLoad"] = [];
  let usesAddressLibrary = pluginFiles.some((f) => /^version(lib)?-[\d-]+\.bin$/i.test(f));
  for (const f of pluginFiles.filter((n) => n.toLowerCase().endsWith(".dll"))) {
    let bytes: Buffer;
    try {
      bytes = fs.readFileSync(path.join(pluginDir, f));
    } catch {
      continue;
    }
    const d = readNativePluginDeclaration(bytes, ext.extender);
    if (d === undefined || d.kind === "not-a-plugin") continue;
    const plugin: EhcollNativePlugin =
      d.kind === "declares"
        ? {
            path: `${ext.pluginDir}/${f}`,
            extender: ext.extender,
            kind: "declares",
            versionIndependent: d.versionIndependent,
            runtimes: d.runtimes,
            hasQuery: d.hasQuery,
            ...(d.addressIndependence !== undefined ? { addressIndependence: d.addressIndependence } : {}),
            ...(d.structureIndependence !== undefined ? { structureIndependence: d.structureIndependence } : {}),
          }
        : { path: `${ext.pluginDir}/${f}`, extender: ext.extender, kind: "query-only" };
    if (d.kind === "declares" && (d.versionIndependent || ((d.addressIndependence ?? 0) & 6) !== 0)) {
      usesAddressLibrary = true;
    }
    if (runtime === undefined || api === undefined) continue;
    const verdict = judgePlugin(plugin, { runtime, api });
    if (verdict.kind === "cannot-load") {
      const mod = args.deployedBy?.(`${ext.pluginDir}/${f}`);
      cannotLoad.push({ file: f, ...(mod !== undefined ? { mod } : {}), why: verdict.why });
    }
  }

  const lowerStem = stem.toLowerCase();
  const alPresent = pluginFiles.some((f) => f.toLowerCase().startsWith(lowerStem) && f.toLowerCase().endsWith(".bin"));
  return {
    gameVersion: v.join("."),
    extenderName: ext.name,
    extender: { expected: expectedDll, present: found.some((f) => f.toLowerCase() === expectedDll.toLowerCase()), found },
    addressLibrary: { expected: `${stem}.bin`, present: alPresent, needed: usesAddressLibrary },
    cannotLoad: cannotLoad.sort((a, b) => ((a.mod ?? a.file) < (b.mod ?? b.file) ? -1 : 1)),
  };
}

/** The Doctor card. Pure. */
export function assessNativeOnDisk(o: NativeOnDisk): HealthCheck {
  const detail: string[] = [];
  // A setup with no script extender at all is not this check's business.
  if (o.extender.found.length > 0 && !o.extender.present) {
    detail.push(
      `${o.extenderName} for ${o.gameVersion} is missing (${o.extender.expected}). Installed: ` +
        `${o.extender.found.join(", ")}, which is for another game version. Install the ${o.extenderName} ` +
        `build for ${o.gameVersion}.`,
    );
  }
  if (o.addressLibrary.needed && !o.addressLibrary.present) {
    detail.push(
      `Address Library for ${o.gameVersion} is missing (${o.addressLibrary.expected}). Install the ` +
        `Address Library build for your game version.`,
    );
  }
  for (const c of o.cannotLoad) {
    const why = c.why.charAt(0).toUpperCase() + c.why.slice(1);
    detail.push(`${c.mod !== undefined ? `${c.mod}: ` : ""}${c.file} will not load. ${why}.`);
  }
  const problems = detail.length;
  return {
    id: "native-plugins",
    title: `${o.extenderName} for your game version`,
    status: problems > 0 ? "broken" : "healthy",
    summary:
      problems > 0
        ? `${problems} thing${problems === 1 ? "" : "s"} in your game folder ${problems === 1 ? "is" : "are"} still for ` +
          `another game version. Swap ${problems === 1 ? "it" : "them"} for the build for ${o.gameVersion}.`
        : `The ${o.extenderName} files in your game folder are right for ${o.gameVersion}.`,
    detail,
    affectedCount: problems,
  };
}
