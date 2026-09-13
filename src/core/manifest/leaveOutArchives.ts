/**
 * ─── A SHIPPED MOD CARRIES NO ARCHIVE ──────────────────────────────────────
 * Nexus quarantines a package with an archive inside it, and a bundled or
 * mirrored mod's files ship loose — so a mod holding a leftover .7z, a .docx
 * readme or a .jar would put one straight back.
 *
 * Such files are left out, exactly as if the curator had deleted them from
 * staging: out of the bundle (`listBundleFolder`), and — here — out of the file
 * list the manifest records for the mod, which is what every user's install
 * verifies, identifies the mod by, and mirrors to. Leaving them in that list
 * would promise files no package carries. Users end up without them whichever
 * way the mod ships, so bundling and mirroring still give the same result
 * (NS-5).
 *
 * Judged by content, like the package check, whatever a file is called. A file
 * that cannot be opened here is kept: the step that reads it names it. Every
 * file left out is logged; nothing is asked of the curator.
 */
import * as path from "path";

import { AbortError } from "../../utils/abortError";
import type { AuditorMod } from "../getModsListForProfile";
import { ehLog } from "../logging/ehLog";
import { stagingRootFromFolder } from "../stagingPath";
import { archiveFormatOfFile, type ArchiveFormat } from "./archiveInside";

export type LeftOutArchive = { modId: string; modName: string; path: string; format: ArchiveFormat };

type StagingFile = NonNullable<AuditorMod["stagingFiles"]>[number];

export async function leaveOutArchiveFiles(args: {
  mods: readonly AuditorMod[];
  /** The bundled and mirrored mods: the ones whose own files a package carries. */
  shippedModIds: ReadonlySet<string>;
  installRoot: string | undefined;
  signal?: AbortSignal;
}): Promise<{ mods: AuditorMod[]; leftOut: LeftOutArchive[] }> {
  const leftOut: LeftOutArchive[] = [];
  const mods: AuditorMod[] = [];
  for (const mod of args.mods) {
    const root = stagingRootFromFolder(args.installRoot, mod.installationPath);
    if (!args.shippedModIds.has(mod.id) || root === undefined || mod.stagingFiles === undefined) {
      mods.push(mod);
      continue;
    }
    const kept: StagingFile[] = [];
    for (const file of mod.stagingFiles) {
      if (args.signal?.aborted === true) throw new AbortError("Cancelled");
      const format = await archiveFormatOfFile(path.join(root, ...file.path.split("/"))).catch(() => undefined);
      if (format === undefined) kept.push(file);
      else leftOut.push({ modId: mod.id, modName: mod.name, path: file.path, format });
    }
    mods.push(kept.length === mod.stagingFiles.length ? mod : { ...mod, stagingFiles: kept });
  }
  if (leftOut.length > 0) {
    ehLog("info", "build.archives-left-out", {
      count: leftOut.length,
      files: leftOut.map((f) => ({ mod: f.modName, path: f.path, format: f.format })),
    });
  }
  return { mods, leftOut };
}
