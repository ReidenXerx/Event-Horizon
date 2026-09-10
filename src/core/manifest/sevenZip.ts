/**
 * Typed wrapper around `vortex-api`'s re-exported `SevenZip`.
 *
 * ## What this actually is
 *
 * Vortex bundles **node-7z 0.8.1**, pinned to Nexus's own fork
 * (`github:Nexus-Mods/node-7z`). That is the OLD, class-based, promise-based
 * API — not the modern `node-7z` v2+ stream API that most documentation
 * describes. The difference is not cosmetic, and getting it wrong fails
 * silently, so the real contract is written down here:
 *
 * ```js
 * var Zip = function () {};
 * Zip.prototype.list = require('./list');   // methods live on the PROTOTYPE
 * module.exports = Zip;                     // the export is a CONSTRUCTOR
 * ```
 *
 * Consequences, every one of them verified by running Vortex's own bundled
 * copy against a real mod archive:
 *
 *  1. `util.SevenZip` is a **constructor**. `util.SevenZip.list` is
 *     `undefined`; you must `new` it first. Calling the export directly
 *     throws `TypeError: Zip.list is not a function` *synchronously*.
 *  2. Every method returns a **Promise**, never an event-emitter stream.
 *     There is no `.on("data")`, no `.on("end")`, no `.on("error")`.
 *  3. `list` reports entries through a **progress callback** that receives an
 *     ARRAY of entries, and resolves with the archive's tech spec.
 *  4. An entry's path field is **`name`**, not `file`, and it is
 *     backslash-separated on Windows.
 *  5. `extract` runs 7z's `e` command, which **FLATTENS** the directory tree.
 *     `extractFull` runs `x` and preserves it. A mod installer must never use
 *     `extract` — this module deliberately does not expose it.
 *  6. Options are 0.8.1-style: `raw` (not `$raw`), `r` (not `recursive`).
 *     Unknown keys are rendered literally into garbage switches such as
 *     `-$cherryPickmanifest.json`, which 7z rejects.
 *  7. **A failed 7z run RESOLVES.** `run.js` resolves on child `close`
 *     regardless of exit status, handing back `{ code, errors }`. Nothing
 *     rejects. An unchecked `await` therefore treats a total failure as
 *     success — for a tool whose promise is deterministic reproduction, that
 *     is the worst possible failure mode. The `runSevenZip*` helpers below
 *     exist to make that impossible to forget.
 *  8. There is no `workingDir` option; `run.js` spawns without a `cwd`. To
 *     store relative paths, pass an absolute wildcard (`<dir>/*`) as the
 *     source — 7z stores entries relative to the wildcard's directory.
 *
 * Callers should use the guarded `sevenZipList` / `sevenZipExtractFull` /
 * `sevenZipAdd` helpers rather than touching {@link SevenZipApi} directly.
 */

import { util } from "@nexusmods/vortex-api";
import * as path from "path";

import { ehLog } from "../logging/ehLog";

/**
 * One entry reported by `list`'s progress callback.
 *
 * Field names mirror node-7z 0.8.1's parser exactly (`lib/list.js`
 * `insertField`): `Path` → `name`, `Size` → `size`, `Attributes` → `attr`,
 * `CRC` → `crc`, `Modified` → `date`.
 *
 * `crc` is the archive's stored CRC32, read straight from the header with no
 * decompression — the cheapest per-file integrity signal that exists.
 * Measured across .zip/.7z/.rar on a real 939-mod profile: present on 100% of
 * file entries at ~0.02s per archive. It is typed `string | number` and left
 * optional on purpose; consumers must treat absence as "cannot verify", never
 * as "mismatch".
 */
export type SevenZipListEntry = {
  /** Path inside the archive. Backslash-separated on Windows. */
  name: string;
  size?: number;
  /**
   * DOS attribute string. Contains `"D"` for a directory — NOT necessarily
   * first: a real .7z reports directories as `"RD"` (read-only + directory).
   */
  attr?: string;
  /**
   * The `Folder = +` column, which some 7z versions emit instead of a `D`
   * attribute.
   *
   * Declared rather than reached through a cast because `isDirectoryEntry`
   * genuinely depends on it, and a field the production code reads but the
   * type denies is one nobody can see when they change this shape.
   */
  folder?: string;
  crc?: string | number;
  date?: Date;
};

/**
 * What `run.js` resolves with. `code` is 7-Zip's exit status — **0 means
 * success and anything else means failure**, including the case where 7z
 * rejected a malformed switch and did nothing at all.
 */
export type SevenZipResult = {
  code: number;
  errors: string[];
};

/**
 * What `list` resolves with: the archive's own header info, parsed by
 * node-7z's `lib/list.js` state machine.
 *
 * `type` is the load-bearing field. Measured against Vortex's bundled copy:
 * a MISSING file and a CORRUPT file both resolve with `{}`, while a valid but
 * genuinely EMPTY zip resolves with `{path, type, physicalSize}` and zero
 * entries. Since `list` throws away 7z's exit code, the presence of `type` is
 * the only way to tell "could not read it" from "there is nothing in it" —
 * and those two must never look the same.
 */
export type SevenZipArchiveSpec = {
  path?: string;
  type?: string;
  physicalSize?: string;
};

/**
 * Progress callback for `add` / `extractFull`, as forwarded by
 * `util/outputParse.js`. The fourth argument is the fork's cancellation
 * hook: calling it kills the spawned 7z child. It is the ONLY way to cancel
 * — this node-7z does not expose the ChildProcess.
 */
export type SevenZipProgress = (
  files: string[],
  percentage: number | undefined,
  stdin: unknown,
  cancel: () => void,
) => void;

/**
 * 0.8.1-style switches. Keys are rendered as `-<key><value>`, so only real
 * 7z switch letters belong here. `raw` is the escape hatch for anything that
 * needs a literal argument (including positional file filters).
 */
export type SevenZipOptions = {
  /** Literal arguments appended verbatim, e.g. `["-tzip"]` or `["manifest.json"]`. */
  raw?: string[];
  /** `-r`, recurse into subdirectories. */
  r?: boolean;
};

/**
 * The narrow surface of node-7z 0.8.1 we consume. `extract` is intentionally
 * absent — see note 5 above.
 */
export type SevenZipApi = {
  add(
    archive: string,
    sources: string[],
    options?: SevenZipOptions,
    progress?: SevenZipProgress,
  ): Promise<SevenZipResult>;
  list(
    archive: string,
    options?: SevenZipOptions,
    progress?: (entries: SevenZipListEntry[]) => void,
  ): Promise<SevenZipArchiveSpec>;
  extractFull(
    archive: string,
    dest: string,
    options?: SevenZipOptions,
    progress?: SevenZipProgress,
  ): Promise<SevenZipResult>;
};

/**
 * Resolve the runtime SevenZip implementation from `vortex-api` and
 * **instantiate it**.
 *
 * `util.SevenZip` is node-7z's exported constructor; its methods live on the
 * prototype. Returning the constructor itself (which this module used to do)
 * yields an object whose `list`/`add`/`extractFull` are all `undefined`, so
 * every call throws a synchronous TypeError that a surrounding try/catch
 * quietly converts into "skipped".
 */
export function resolveSevenZip(): SevenZipApi {
  const exposed = (util as unknown as { SevenZip?: unknown }).SevenZip;
  if (typeof exposed !== "function") {
    ehLog("error", "sevenzip.resolve.fail", {
      reason: "util.SevenZip is not a constructor",
    });
    throw new Error(
      "vortex-api.util.SevenZip is not available at runtime. " +
        "Are we running outside of Vortex?",
    );
  }
  const Ctor = exposed as new () => SevenZipApi;
  return new Ctor();
}

/**
 * Turn node-7z's resolve-on-failure into a thrown error.
 *
 * @see {@link SevenZipResult} — note 7 in the module docblock.
 */
function assertOk(result: SevenZipResult | undefined, what: string): void {
  const code = result?.code;
  // Log the resolved code and errors on EVERY call — node-7z resolves on
  // failure rather than rejecting (see note 7 in the module docblock), so
  // this is the one place a non-zero code is guaranteed to surface even when
  // nothing above ever inspects the thrown error.
  ehLog(code === 0 || code === undefined ? "debug" : "warn", "sevenzip.result", {
    what,
    code: code ?? null,
    errors: result?.errors ?? [],
  });
  if (code === 0 || code === undefined) {
    return;
  }
  const detail = (result?.errors ?? [])
    .map((e) => e.replace(/\s+/g, " ").trim())
    .filter((e) => e.length > 0)
    .join("; ");
  throw new Error(
    `7z exited with code ${code} while ${what}` +
      (detail.length > 0 ? `: ${detail}` : "."),
  );
}

/**
 * Does 7z work on this machine at all?
 *
 * `list` cannot tell a bad archive from a 7z that will not run: both resolve
 * with an empty spec and nothing else. The only way to separate them is to ask
 * 7z to do something we KNOW should succeed — build a tiny archive and read it
 * back. If that fails, the problem is 7z, not the user's file.
 *
 * This exists because an alpha tester on Proton hit a list failure and the
 * error blamed his download. The file turned out to be the right question to
 * ask, but nothing in the code could have said so, and "is 7z even working
 * here" was unanswerable from the failure alone.
 *
 * Cheap: a few hundred bytes in a temp directory, run only when something has
 * already gone wrong.
 */
const PROBE_CONTENT = "event-horizon 7z self-test";

export async function sevenZipSelfTest(
  api: SevenZipApi,
): Promise<{ ok: true } | { ok: false; fatal: boolean; why: string }> {
  const fsp = await import("fs/promises");
  const os = await import("os");
  const path = await import("path");

  ehLog("info", "sevenzip.self-test.start", {});
  let dir: string | undefined;
  try {
    dir = await fsp.mkdtemp(path.join(os.tmpdir(), "eh-7z-selftest-"));
    const source = path.join(dir, "probe.txt");
    const archive = path.join(dir, "probe.zip");
    await fsp.writeFile(source, PROBE_CONTENT, "utf8");

    await sevenZipAdd(api, archive, [source], { raw: ["-tzip"] });

    // EXTRACT is the operation that decides whether mods can install, so it is
    // the one that decides whether a failure is fatal.
    //
    // The previous version tested `list` alone and called any failure "7z is
    // not working on this system". That conflated two very different states.
    // `list` is the operation we ALREADY know misbehaves under Wine - it is
    // why readZip exists and why listArchive.ts is native-first with 7z only
    // as a fallback - and node-7z resolves it with a spec even when the
    // underlying call failed. A tester's log showed exactly this shape: the
    // archive was created successfully, so 7z.exe had started and done real
    // work, and only the listing came back unusable. Reporting that as a dead
    // extractor sent the diagnosis at a missing Visual C++ runtime, which a
    // successful create had already ruled out.
    const extractDir = path.join(dir, "out");
    try {
      await sevenZipExtractFull(api, archive, extractDir);
      const roundTripped = await fsp.readFile(
        path.join(extractDir, "probe.txt"),
        "utf8",
      );
      if (roundTripped !== PROBE_CONTENT) {
        ehLog("error", "sevenzip.self-test.fail", {
          fatal: true,
          reason: "round-trip-mismatch",
        });
        return {
          ok: false,
          fatal: true,
          why:
            "7z extracted an archive but the contents did not survive the " +
            "round trip. Vortex cannot unpack mods on this system.",
        };
      }
    } catch (err) {
      ehLog("error", "sevenzip.self-test.fail", {
        fatal: true,
        reason: "extract-failed",
        err: err instanceof Error ? err.message : String(err),
      });
      return {
        ok: false,
        fatal: true,
        why:
          "7z created an archive but could not extract it back: " +
          `${err instanceof Error ? err.message : String(err)}. ` +
          "Vortex cannot unpack mods on this system.",
      };
    }

    const spec = await api.list(archive, {}, () => undefined);
    if (typeof spec?.type !== "string") {
      // Not fatal: extraction works, so mods install. Only listing is broken,
      // and every path of ours that needs a listing is native-first already.
      ehLog("warn", "sevenzip.self-test.fail", {
        fatal: false,
        reason: "list-unavailable",
      });
      return {
        ok: false,
        fatal: false,
        why:
          "7z can create and extract archives but cannot list them. This is a " +
          "known node-7z failure under Wine/Proton. Event Horizon reads " +
          "archives natively, so installs are unaffected.",
      };
    }
    ehLog("info", "sevenzip.self-test.ok", {});
    return { ok: true };
  } catch (err) {
    ehLog("error", "sevenzip.self-test.fail", {
      fatal: true,
      reason: "unexpected",
      err: err instanceof Error ? err.message : String(err),
    });
    return {
      ok: false,
      fatal: true,
      why: `7z could not run: ${err instanceof Error ? err.message : String(err)}`,
    };
  } finally {
    if (dir !== undefined) {
      await fsp.rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}

/** Wire an AbortSignal to the fork's progress-callback `cancel` hook. */
function cancelOnAbort(signal: AbortSignal | undefined): SevenZipProgress {
  return (_files, _pct, _stdin, cancel) => {
    if (signal?.aborted === true) {
      cancel();
    }
  };
}

/**
 * List an archive's entries.
 *
 * `list` resolves with the archive spec and **discards** `{code, errors}`, so
 * the exit status is not available here. An unreadable archive is detected by
 * its empty spec instead (see {@link SevenZipArchiveSpec}) and throws, because
 * silently returning zero entries would report every staged file as
 * unexplained. A valid archive that really is empty returns `[]`.
 */
export async function sevenZipList(
  api: SevenZipApi,
  archive: string,
  options?: SevenZipOptions,
): Promise<SevenZipListEntry[]> {
  const archiveName = path.basename(archive);
  const startedAt = Date.now();
  ehLog("debug", "sevenzip.list.start", { archive: archiveName });
  const entries: SevenZipListEntry[] = [];
  /**
   * ─── `-sccUTF-8`: THE NAMES COME BACK AS THEY ARE ON DISK ─────────────
   * Without it 7-Zip writes names in the CONSOLE codepage, and Node reads its
   * stdout as UTF-8. Anything that codepage cannot hold comes back wrong or
   * gone, and the extraction that put the file on disk never had that problem
   * — so the listing and the staging folder stop agreeing on a file's name.
   *
   * Measured on the curator's download folders, ten archives list differently
   * without it:
   *   - `BeastHHBB - Feminine Female Khajiit` stores "Cópia" (Portuguese for
   *     "Copy") as OEM byte 0xA2; it listed as "C\uFFFDpia", matched nothing
   *     staged, and was offered to the curator as two DELETED files — who
   *     answered "ship my deletion" on that evidence.
   *   - Nemesis's `简体中文.txt` and `日本語.txt` listed as `____.txt`.
   *   - Bards Reborn's "cú chulainn" listed as "c\uFFFD chulainn".
   *
   * The switch changes only how 7-Zip PRINTS a name. How it DECODES the stored
   * bytes is untouched, so the listing now names files exactly as the
   * extraction on this machine did. Appended after the caller's own switches:
   * 7-Zip reads switches wherever they appear, and a caller's positional filter
   * keeps working.
   */
  const withUtf8Output: SevenZipOptions = {
    ...(options ?? {}),
    raw: [...(options?.raw ?? []), "-sccUTF-8"],
  };
  const spec = await api.list(archive, withUtf8Output, (batch) => {
    for (const entry of batch) {
      if (entry?.name !== undefined) {
        entries.push(entry);
      }
    }
  });

  // Defensive only — `list` resolves with an archive SPEC, not a result, and
  // node-7z discards {code, errors} on this path. So there is no exit status
  // here to read today, and this fires only if a future node-7z starts
  // supplying one. It is not the diagnosis; see below.
  assertOk(spec as SevenZipResult | undefined, `listing "${archive}"`);

  if (typeof spec?.type !== "string") {
    // An EMPTY spec is all node-7z gives back, and it means the same thing for
    // every cause: a corrupt file, a truncated download, a path 7z cannot
    // reach, no permission, or a 7z binary that will not run at all. The
    // result carries nothing that separates them.
    //
    // So the caller has to distinguish them by other means — inspecting the
    // file (diagnoseArchive) and testing 7z itself (sevenZipSelfTest). This
    // message deliberately does NOT accuse the file, because on the evidence
    // available here that is a guess.
    ehLog("error", "sevenzip.list.fail", {
      archive: archiveName,
      reason: "empty-spec",
      ms: Date.now() - startedAt,
    });
    throw new Error(
      `7z returned no archive information for "${archive}". node-7z reports ` +
        `nothing further on this path — the file, the path, or 7z itself ` +
        `could be at fault.`,
    );
  }
  ehLog("info", "sevenzip.list.ok", {
    archive: archiveName,
    entries: entries.length,
    ms: Date.now() - startedAt,
  });
  return entries;
}

/**
 * Extract with full paths (`x`). Pass `options.raw` to cherry-pick specific
 * entries — 7z takes those as trailing positional filters.
 */
export async function sevenZipExtractFull(
  api: SevenZipApi,
  archive: string,
  dest: string,
  options?: SevenZipOptions,
  signal?: AbortSignal,
): Promise<void> {
  const archiveName = path.basename(archive);
  const startedAt = Date.now();
  ehLog("debug", "sevenzip.extract.start", {
    archive: archiveName,
    dest: path.basename(dest),
  });
  const result = await api.extractFull(
    archive,
    dest,
    options ?? {},
    cancelOnAbort(signal),
  );
  assertOk(result, `extracting "${archive}"`);
  ehLog("info", "sevenzip.extract.ok", {
    archive: archiveName,
    ms: Date.now() - startedAt,
  });
}

/** Add files to an archive. `sources` must be an array — node-7z calls `.map` on it. */
export async function sevenZipAdd(
  api: SevenZipApi,
  archive: string,
  sources: string[],
  options?: SevenZipOptions,
  signal?: AbortSignal,
): Promise<void> {
  const archiveName = path.basename(archive);
  const startedAt = Date.now();
  ehLog("debug", "sevenzip.add.start", {
    archive: archiveName,
    sources: sources.length,
  });
  const result = await api.add(
    archive,
    sources,
    options ?? {},
    cancelOnAbort(signal),
  );
  assertOk(result, `creating "${archive}"`);
  ehLog("info", "sevenzip.add.ok", {
    archive: archiveName,
    sources: sources.length,
    ms: Date.now() - startedAt,
  });
}
