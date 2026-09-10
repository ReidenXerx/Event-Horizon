/**
 * What the game root's native code says about itself.
 *
 *  - probeImportMismatches: the Windows loader's own consistency check — every
 *    symbol an executable imports from a DLL beside it must be exported by that
 *    DLL. See peImage.ts for why this, and not a list of known-good files.
 *  - rootDllOwnership: which root DLLs belong to a TOOL beside the game rather
 *    than to the game, so cleaning the folder does not break the Creation Kit.
 */

import * as fsp from "fs/promises";
import * as path from "path";

import { ehLog } from "../logging/ehLog";
import type { ImportMismatch } from "./environmentChecks";
import { missingImports, parsePeImage, type PeImage } from "./peImage";

export type ImportProbe = {
  checked: string[];
  findings: ImportMismatch[];
  /** Executables or DLLs that could not be read or parsed — "cannot say", not "fine". */
  unreadable: string[];
};

async function rootFileNames(gameDir: string): Promise<string[] | undefined> {
  try {
    return (await fsp.readdir(gameDir, { withFileTypes: true }))
      .filter((d) => d.isFile() || d.isSymbolicLink())
      .map((d) => d.name);
  } catch (err) {
    ehLog("warn", "environment.imports.root-unreadable", { gameDir, error: String(err) });
    return undefined;
  }
}

export async function probeImportMismatches(args: {
  gameDir: string;
  /** Root-level executable names to check. */
  exeNames: readonly string[];
  /** Lower-case root file names the store installed. */
  vanillaRootNames: ReadonlySet<string>;
}): Promise<ImportProbe> {
  const probe: ImportProbe = { checked: [], findings: [], unreadable: [] };
  const rootNames = await rootFileNames(args.gameDir);
  if (rootNames === undefined) {
    probe.unreadable.push(args.gameDir);
    return probe;
  }
  const byLower = new Map(rootNames.map((n) => [n.toLowerCase(), n]));
  const images = new Map<string, PeImage | undefined>();
  const load = async (name: string): Promise<PeImage | undefined> => {
    const key = name.toLowerCase();
    if (images.has(key)) return images.get(key);
    let image: PeImage | undefined;
    try {
      image = parsePeImage(await fsp.readFile(path.join(args.gameDir, name)));
    } catch {
      image = undefined;
    }
    if (image === undefined) probe.unreadable.push(name);
    images.set(key, image);
    return image;
  };

  const seen = new Set<string>();
  for (const wanted of args.exeNames) {
    const actual = byLower.get(wanted.toLowerCase());
    if (actual === undefined || seen.has(actual.toLowerCase())) continue;
    seen.add(actual.toLowerCase());
    const exe = await load(actual);
    if (exe === undefined) continue;
    probe.checked.push(actual);
    for (const dllKey of exe.imports.keys()) {
      const dllName = byLower.get(dllKey);
      if (dllName === undefined) continue; // resolved from the system, not ours to judge
      const dll = await load(dllName);
      if (dll === undefined) continue;
      const missing = missingImports(exe, dllKey, dll);
      if (missing.length === 0) continue;
      probe.findings.push({
        exe: actual,
        dll: dllName,
        missing,
        dllIsVanilla: args.vanillaRootNames.has(dllKey),
      });
    }
  }
  return probe;
}

/**
 * Root DLLs that belong to a tool beside the game, not to the game.
 *
 * The curator's rule: a root DLL referenced only by a non-game executable
 * belongs to that tool and is left alone. "Referenced" is evidence read from
 * the binaries, not a list of tool names:
 *   - a static import, followed through the DLLs it pulls in, or
 *   - the DLL's file name written literally inside the binary (ASCII or
 *     UTF-16) — which is how the Creation Kit names `flowchartx64.dll`, loaded
 *     at run time and invisible to an import table.
 * A DLL the GAME references the same way — its executables, its script
 * extender's loader — is the game's, whatever else also names it: `dxgi.dll`,
 * `d3d11.dll` and `dinput8.dll` are named by the game itself, so an injector
 * with those names is never exempted.
 *
 * Measured on the curator's GOG Fallout 4: CreationKit.exe owns ssce5564,
 * flowchartx64 and d3dcompiler_46. The VoltekLib DLLs and flowchartx32 carry no
 * such evidence (their names are built at run time) and are still moved —
 * restorable, and said so rather than guessed.
 */
export async function rootDllOwnership(args: {
  gameDir: string;
  /** Lower-case root executables that are the game's: store executables and script-extender loaders. */
  gameExes: ReadonlySet<string>;
}): Promise<{ toolOwned: Map<string, string[]>; gameReferenced: Set<string> }> {
  const toolOwned = new Map<string, string[]>();
  const gameReferenced = new Set<string>();
  const rootNames = await rootFileNames(args.gameDir);
  if (rootNames === undefined) return { toolOwned, gameReferenced };
  const byLower = new Map(rootNames.map((n) => [n.toLowerCase(), n]));
  const dlls = [...byLower.keys()].filter((n) => /\.(dll|asi)$/.test(n));
  if (dlls.length === 0) return { toolOwned, gameReferenced };

  const refsCache = new Map<string, Set<string>>();
  const refs = async (name: string): Promise<Set<string>> => {
    const cached = refsCache.get(name);
    if (cached !== undefined) return cached;
    const out = new Set<string>();
    refsCache.set(name, out);
    let buf: Buffer;
    try {
      buf = await fsp.readFile(path.join(args.gameDir, byLower.get(name)!));
    } catch {
      return out;
    }
    const image = parsePeImage(buf);
    for (const dll of image?.imports.keys() ?? []) if (byLower.has(dll)) out.add(dll);
    const text = buf.toString("latin1").toLowerCase();
    for (const dll of dlls) {
      if (dll === name) continue;
      if (text.includes(dll) || text.includes(dll.split("").join("\0"))) out.add(dll);
    }
    return out;
  };
  const closure = async (starts: readonly string[]): Promise<Set<string>> => {
    const seen = new Set<string>();
    const stack = [...starts];
    while (stack.length > 0) {
      for (const dll of await refs(stack.pop()!)) {
        if (!seen.has(dll)) {
          seen.add(dll);
          stack.push(dll);
        }
      }
    }
    return seen;
  };

  const exes = [...byLower.keys()].filter((n) => n.endsWith(".exe"));
  const game = exes.filter((n) => args.gameExes.has(n));
  const tools = exes.filter((n) => !args.gameExes.has(n));
  for (const dll of await closure(game)) gameReferenced.add(dll);
  for (const tool of tools) {
    for (const dll of await closure([tool])) {
      if (gameReferenced.has(dll)) continue;
      toolOwned.set(dll, [...(toolOwned.get(dll) ?? []), byLower.get(tool)!]);
    }
  }
  ehLog("info", "environment.root-dll-ownership", {
    gameDir: args.gameDir,
    gameExes: game,
    tools,
    toolOwned: Object.fromEntries(toolOwned),
  });
  return { toolOwned, gameReferenced };
}
