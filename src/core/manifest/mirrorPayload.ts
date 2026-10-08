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
 * destination="">`, places it.
 *
 * Or the same bytes at ANOTHER path: a file the curator moved (CoTaP for
 * CoTaP Standalone, Ivy Rev 14: Textures/actors/** under Textures/CoTaP/).
 * Where an install puts those bytes does not matter for these, because the
 * mirror never waits for the install to produce them: the build records the
 * entry (`state.mirrorFromArchiveAt`) and the user's mirror extracts exactly
 * that entry to the curator's path. Before 0.2.56 such a file shipped whole,
 * re-hosting the author's bytes (NS-5).
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

import { pMap } from "../../utils/pMap";

/** Mirrored mods compared with their archives at once. */
const MIRROR_PARALLEL = 4;
import { getDefaultHashConcurrency } from "./stagingFileWalker";
import * as path from "path";

import type { EhcollStagingFile } from "../../types/ehcoll";
import { pathKey, segmentsOf } from "../paths";
import { isSafeRelativePath } from "../safeRelativePath";

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
  /**
   * Of `provided`, the files the archive holds at ANOTHER path: staged path →
   * the archive entry with its bytes. Absent when there are none.
   */
  movedFrom?: Record<string, string>;
  /** Files a same-size entry at their path made worth reading. */
  compared: number;
  /** Of those, files that could not be read — and so ship. */
  unreadable: number;
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

  const out: ArchiveProvision = { provided: [], compared: 0, unreadable: 0 };
  // Which staged files have a same-size entry anywhere: only those need a checksum.
  const work = args.staged.flatMap((file) => {
    // Without a hash the user's side could not check the archive's copy — and
    // packaging refuses a mirrored mod with such a file anyway.
    if (file.sha256 === undefined) return [];
    const sameSize = bySize.get(file.size) ?? [];
    if (sameSize.length === 0) return [];
    const here = sameSize.filter((e) => entrySitsAt(e.path, file.path));
    // A moved file is taken from the entry by name, so it must be one the
    // user's side can extract into a temp folder.
    const elsewhere = sameSize.filter((e) => !here.includes(e) && isSafeRelativePath(e.path));
    return [{ file, here, elsewhere }];
  });
  // Checksummed several at once (the hash pool does them on every core);
  // `provided` keeps the staged order either way.
  type Verdict = { kind: "provided"; from?: string } | { kind: "differs" | "unreadable" | "skipped" };
  const verdicts = await pMap(
    work,
    Math.max(1, getDefaultHashConcurrency()),
    async ({ file, here, elsewhere }): Promise<Verdict> => {
      if (args.signal?.aborted === true) return { kind: "skipped" };
      let crc: string;
      try {
        crc = (await args.crcOf(file.path)).toLowerCase();
      } catch {
        return { kind: "unreadable" };
      }
      if (here.some((e) => e.crc!.toLowerCase() === crc)) return { kind: "provided" };
      // The first in archive order, so the same archive always names the same entry.
      const moved = elsewhere.find((e) => e.crc!.toLowerCase() === crc);
      return moved !== undefined ? { kind: "provided", from: moved.path } : { kind: "differs" };
    },
  );
  const movedFrom: Record<string, string> = {};
  verdicts.forEach((v, i) => {
    if (v.kind === "skipped") return;
    out.compared += 1;
    if (v.kind === "unreadable") out.unreadable += 1;
    if (v.kind === "provided") {
      const staged = work[i]!.file.path;
      out.provided.push(staged);
      if (v.from !== undefined) movedFrom[staged] = v.from;
    }
  });
  if (Object.keys(movedFrom).length > 0) out.movedFrom = movedFrom;
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
  // Several mods at once: each lists its own archive (7-Zip is a process of its
  // own) and checksums its own files. Results are keyed by mod, so order is moot.
  const mirrored = args.mods.filter((m) => m.mirrored === true);
  await pMap(mirrored, MIRROR_PARALLEL, async (mod) => {
    if (args.signal?.aborted === true) return;
    const shipsAll = (why: string): void => {
      out.set(mod.id, { kind: "ships-all", why });
    };

    const unpredictable = args.unpredictable(mod);
    if (unpredictable !== undefined) {
      shipsAll(unpredictable);
      return;
    }
    const archivePath = args.archiveFor(mod);
    if (archivePath === undefined) {
      shipsAll("the build had no archive to compare it with");
      return;
    }
    const root = args.stagingRootOf(mod);
    if (root === undefined) {
      shipsAll("its staging folder could not be located");
      return;
    }
    const listing = await args.listArchive(archivePath);
    if (listing === undefined) {
      shipsAll(`its archive could not be listed (${path.basename(archivePath)})`);
      return;
    }

    const staged = mod.stagingFiles ?? [];
    const proof = await findFilesTheArchiveProvides({
      staged,
      listing,
      crcOf: (p) => args.crcFile(path.join(root, ...segmentsOf(p))),
      ...(args.signal !== undefined ? { signal: args.signal } : {}),
    });
    out.set(mod.id, { kind: "proven", staged: staged.length, ...proof });
  });
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
      ...(p.movedFrom !== undefined ? { moved: Object.keys(p.movedFrom).length } : {}),
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
