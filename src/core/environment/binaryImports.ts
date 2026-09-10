/**
 * Run the loader's own consistency check over the game root: every symbol an
 * executable imports from a DLL beside it must be exported by that DLL.
 * See peImage.ts for why this, and not a list of known-good files.
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

export async function probeImportMismatches(args: {
  gameDir: string;
  /** Root-level executable names to check. */
  exeNames: readonly string[];
  /** Lower-case root file names the store installed. */
  vanillaRootNames: ReadonlySet<string>;
}): Promise<ImportProbe> {
  const probe: ImportProbe = { checked: [], findings: [], unreadable: [] };
  let rootNames: string[];
  try {
    rootNames = (await fsp.readdir(args.gameDir, { withFileTypes: true }))
      .filter((d) => d.isFile() || d.isSymbolicLink())
      .map((d) => d.name);
  } catch (err) {
    probe.unreadable.push(args.gameDir);
    ehLog("warn", "environment.imports.root-unreadable", { gameDir: args.gameDir, error: String(err) });
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
