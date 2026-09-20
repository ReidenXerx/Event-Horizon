/**
 * ──────────────────────────────────────────────────────────────────────
 * Which files of a mirrored mod its own archive already provides.
 *
 * A mirrored mod installs from its archive, and the mirror then corrects the
 * folder into the curator's. The package carried EVERY staged file of such a
 * mod to do that, the ones the archive had just installed byte for byte
 * included. On a real Fallout 4 package that put BodySlide.exe,
 * OutfitStudio.exe and OCBPC's cbp.dll in the package unchanged — re-hosting
 * the authors' own files, which is what mirroring exists to avoid (NS-5) — and
 * Nexus Mods quarantined the upload for carrying executables.
 *
 * So a build proves, per mirrored mod, which files the archive provides,
 * records them in the manifest (`state.mirrorFromArchive`) and packs only the
 * rest. On the user's side the mirror takes a recorded file from the mod's own
 * archive when their install did not produce it, checked against its SHA-256
 * like every other write.
 *
 * ─── WHAT COUNTS AS PROVIDED ──────────────────────────────────────────
 * An archive entry with the file's size and CRC-32, AT the file's path: the
 * entry's path is the staged path, or ends with it at a folder boundary — how
 * an installer that strips a wrapper folder, or a FOMOD `<folder
 * destination="">`, places it. The same bytes elsewhere in the archive are not
 * enough: they say nothing about where an install puts them, so a file the
 * curator moved still ships.
 *
 * CRC-32 because it is what an archive's header already records, so the proof
 * costs one read of the curator's file and no extraction. It is not
 * collision-resistant and does not have to be: the curator is not an
 * adversary, and the user's side hashes whatever it takes from the archive
 * against the recorded SHA-256, so a wrong claim fails by name instead of
 * writing wrong bytes.
 *
 * ─── ONLY WHERE AN INSTALL CAN BE PREDICTED ───────────────────────────
 * A claim is only as good as the user's install placing files where the
 * curator's did. The self-check says which mods that holds for
 * (`reproducibleInstall`); every other mirrored mod carries every file, as all
 * of them did before.
 * ──────────────────────────────────────────────────────────────────────
 */

import * as path from "path";

import type { EhcollStagingFile } from "../../types/ehcoll";
import { pathKey, segmentsOf } from "../paths";

import type { ArchiveEntry, ArchiveListing } from "./archiveContents";
import type { SelfCheckReport } from "./selfCheckMod";

/**
 * Does an archive entry at `entryPath` install to `stagedPath`?
 *
 * Equal, or ending with it at a folder boundary. Case-folded, which can only
 * add a candidate: the size and checksum decide here, and the SHA-256 on the
 * user's side.
 */
export function entrySitsAt(entryPath: string, stagedPath: string): boolean {
  const entry = pathKey(entryPath, "insensitive");
  const staged = pathKey(stagedPath, "insensitive");
  return entry === staged || entry.endsWith(`/${staged}`);
}

export type ArchiveProvision = {
  /** Staged paths the archive provides, spelled exactly as in `stagingFiles`. */
  provided: string[];
  /** Files a same-size entry at their path made worth reading. */
  compared: number;
  /** Of those, files that could not be read — and so ship. */
  unreadable: number;
  /**
   * Compared, readable, and the archive's copy is DIFFERENT.
   *
   * The mirror does not act on these — a file the archive cannot supply is
   * simply one the package carries — but for an external mod it is the whole
   * story: the archive players download no longer produces the bytes the
   * collection recorded.
   *
   * It was invisible before, and that cost a tester their game. A curator
   * regenerated a BodySlide output after uploading its archive; 1,130 of
   * 2,994 files changed, EVERY ONE of them at the same size and the same
   * path, so the name-level drift check saw nothing. Players installed the
   * correct archive and got meshes the collection was never built against.
   *
   * Same size at the same path is exactly the case where only a checksum can
   * tell, which is why it is recorded here rather than inferred from
   * `compared - provided.length` by a caller who cannot name the files.
   */
  changed: string[];
};

/**
 * Which of `staged` the archive provides.
 *
 * Reads only a file that has a same-size entry at its path: most of a mod's
 * files, and never one the archive cannot hold.
 */
export async function findFilesTheArchiveProvides(args: {
  staged: readonly EhcollStagingFile[];
  listing: ArchiveListing;
  /** CRC-32 of one staged file, as 8 hex digits. */
  crcOf: (stagedPath: string) => Promise<string>;
  signal?: AbortSignal;
}): Promise<ArchiveProvision> {
  const bySize = new Map<number, ArchiveEntry[]>();
  for (const entry of args.listing.entries) {
    // An entry the header gives no size or checksum for proves nothing.
    if (entry.size === undefined || entry.crc === undefined) continue;
    const same = bySize.get(entry.size);
    if (same === undefined) bySize.set(entry.size, [entry]);
    else same.push(entry);
  }

  const out: ArchiveProvision = {
    provided: [],
    compared: 0,
    unreadable: 0,
    changed: [],
  };
  for (const file of args.staged) {
    if (args.signal?.aborted === true) break;
    // Without a hash the user's side could not check the archive's copy — and
    // packaging refuses a mirrored mod with such a file anyway.
    if (file.sha256 === undefined) continue;
    const candidates = (bySize.get(file.size) ?? []).filter((e) =>
      entrySitsAt(e.path, file.path),
    );
    if (candidates.length === 0) continue;

    out.compared += 1;
    let crc: string;
    try {
      crc = (await args.crcOf(file.path)).toLowerCase();
    } catch {
      out.unreadable += 1;
      continue;
    }
    if (candidates.some((e) => e.crc!.toLowerCase() === crc)) {
      out.provided.push(file.path);
    } else {
      // Same size, same path, different checksum. For the mirror this only
      // means "the package carries it"; for an external mod it means the
      // archive and the staging folder have diverged in content alone.
      out.changed.push(file.path);
    }
  }
  return out;
}

/**
 * Why this mod's install cannot be predicted on another machine, or
 * `undefined` when it can.
 *
 * Named rather than a boolean so the build log says which of these it was: a
 * mod that ships every file for no stated reason is a mod nobody can tell from
 * a bug.
 */
export function unpredictableInstall(
  report:
    | Pick<
        SelfCheckReport,
        | "depth"
        | "promptsUser"
        | "readsPluginState"
        | "installerUnexamined"
        | "reproducibleInstall"
      >
    | undefined,
): string | undefined {
  if (report === undefined) return "the self-check did not examine it";
  if (report.reproducibleInstall === true) return undefined;
  if (report.depth === "skipped") return "the self-check could not read its archive";
  if (report.promptsUser === true) {
    return "its installer asks questions that users answer themselves";
  }
  if ((report.readsPluginState?.length ?? 0) > 0) {
    return "its installer depends on which plugins are active";
  }
  if (report.installerUnexamined === true) return "its installer could not be read";
  return "its installer could not be replayed with confidence";
}

/** What the build concluded for one mirrored mod. */
export type MirrorProvision =
  | ({ kind: "proven"; staged: number } & ArchiveProvision)
  /** Carries every file, and why none could be left to the archive. */
  | { kind: "ships-all"; why: string };

export type MirrorProvisionMod = {
  id: string;
  name: string;
  mirrored?: boolean;
  stagingFiles?: EhcollStagingFile[];
};

/**
 * For every mirrored mod, which files its archive provides.
 *
 * Everything that touches Vortex or the disk is passed in, so the policy —
 * which mods may leave anything to their archive, and why the others may not —
 * is tested whole.
 */
export async function proveMirroredFilesFromArchives<
  M extends MirrorProvisionMod,
>(args: {
  mods: readonly M[];
  /** See {@link unpredictableInstall}. */
  unpredictable: (mod: M) => string | undefined;
  /** The archive the self-check compared this mod with. */
  archiveFor: (mod: M) => string | undefined;
  stagingRootOf: (mod: M) => string | undefined;
  /** Resolves `undefined` when the archive cannot be listed. */
  listArchive: (archivePath: string) => Promise<ArchiveListing | undefined>;
  crcFile: (absolutePath: string) => Promise<string>;
  signal?: AbortSignal;
}): Promise<Map<string, MirrorProvision>> {
  const out = new Map<string, MirrorProvision>();
  for (const mod of args.mods) {
    if (mod.mirrored !== true) continue;
    if (args.signal?.aborted === true) break;
    const shipsAll = (why: string): void => {
      out.set(mod.id, { kind: "ships-all", why });
    };

    const unpredictable = args.unpredictable(mod);
    if (unpredictable !== undefined) {
      shipsAll(unpredictable);
      continue;
    }
    const archivePath = args.archiveFor(mod);
    if (archivePath === undefined) {
      shipsAll("the build had no archive to compare it with");
      continue;
    }
    const root = args.stagingRootOf(mod);
    if (root === undefined) {
      shipsAll("its staging folder could not be located");
      continue;
    }
    const listing = await args.listArchive(archivePath);
    if (listing === undefined) {
      shipsAll(`its archive could not be listed (${path.basename(archivePath)})`);
      continue;
    }

    const staged = mod.stagingFiles ?? [];
    const proof = await findFilesTheArchiveProvides({
      staged,
      listing,
      crcOf: (p) => args.crcFile(path.join(root, ...segmentsOf(p))),
      ...(args.signal !== undefined ? { signal: args.signal } : {}),
    });
    out.set(mod.id, { kind: "proven", staged: staged.length, ...proof });
  }
  return out;
}

/** The build log's account of the step: totals, and which mods went which way. */
export function summarizeProvisions(
  mods: readonly MirrorProvisionMod[],
  provisions: ReadonlyMap<string, MirrorProvision>,
): Record<string, unknown> {
  let fromArchive = 0;
  let staged = 0;
  const proven: Array<Record<string, unknown>> = [];
  const shipsAll: Array<Record<string, unknown>> = [];
  for (const mod of mods) {
    const p = provisions.get(mod.id);
    if (p === undefined) continue;
    if (p.kind === "ships-all") {
      shipsAll.push({ mod: mod.name, why: p.why });
      continue;
    }
    fromArchive += p.provided.length;
    staged += p.staged;
    proven.push({
      mod: mod.name,
      staged: p.staged,
      fromArchive: p.provided.length,
      compared: p.compared,
      ...(p.unreadable > 0 ? { unreadable: p.unreadable } : {}),
    });
  }
  return {
    mods: provisions.size,
    stagedFiles: staged,
    leftToArchives: fromArchive,
    proven: proven.slice(0, 20),
    shipsAllCount: shipsAll.length,
    shipsAll: shipsAll.slice(0, 20),
  };
}
