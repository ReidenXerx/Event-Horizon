/**
 * ──────────────────────────────────────────────────────────────────────
 * The curator's copy, installed NEXT TO the user's, never over it.
 *
 * When a user already has a mod the collection needs, the resolver adopts it —
 * and if its bytes are the curator's, that is exactly right. When they are
 * not (their own FOMOD answers, a texture they deleted, a plugin they merged),
 * there used to be two options and both were bad: uninstall theirs and install
 * ours, which destroys work they did on purpose; or report the mismatch and
 * carry on, which silently ships a collection that is not the curator's.
 *
 * Vortex does not force that choice. A mod is one row in a per-game pool and a
 * profile only records which rows are enabled, so two copies cost a row and
 * some disk — and disk is the one budget this project explicitly does not
 * economise. Ours is enabled in the collection's profile; theirs stays exactly
 * as it was, still enabled in their own.
 *
 * ─── HOW A SECOND COPY AVOIDS VORTEX'S "REPLACE OR VARIANT?" DIALOG ────
 * Read out of Vortex's installer rather than guessed. Its name loop collides
 * when EITHER of these returns a hit:
 *
 *     checkModNameExists(installName, …)  → mods where `mod.id === installName`
 *     checkModVariantsExist(…, archiveId) → mods where `mod.archiveId === archiveId`
 *
 * and shows the dialog only when the combined list is non-empty. So a second
 * copy installs silently if it has BOTH a distinct install name and a distinct
 * archive record. Satisfying one is not enough: re-downloading the same Nexus
 * file reuses the download, which trips the second check even under a new name.
 *
 * Both come from one move — stage the archive under our own file name and
 * register it as a new local download. `adoptLocalArchive` copies it into
 * Vortex's download folder under that basename and derives the archive id from
 * the destination, and Vortex derives the install name from the same basename.
 * ──────────────────────────────────────────────────────────────────────
 */

import * as fsp from "fs/promises";
import * as os from "os";
import * as path from "path";

import type { types } from "@nexusmods/vortex-api";

import { ehLog } from "../logging/ehLog";
import { adoptLocalArchive } from "./adoptLocalArchive";
import { installFromExistingDownload, safeRmTempDir } from "./modInstall";
import type { VortexInstallerChoices } from "./installerChoices";

/**
 * Marks a mod as this tool's copy, in the one place a user actually looks:
 * the mod list.
 *
 * The collection name and version are in there deliberately. A player can run
 * more than one Event Horizon collection, and two of them can need different
 * builds of the same mod — so "Skyrim Landscapes - Event Horizon" would be
 * ambiguous the moment a second collection wanted it, and the two installs
 * would collide on the install name and bring the dialog straight back.
 *
 * Shape: `<mod> - <collection> v<version> - Event Horizon`.
 */
export function alongsideInstallName(args: {
  modName: string;
  collectionName: string;
  collectionVersion: string;
}): string {
  /**
   * Each PART is sanitised on its own and only then joined.
   *
   * Cleaning the assembled string instead looked equivalent and was not: the
   * trailing-whitespace trim ate the separator's leading space and produced
   * "Skyrim Landscapes- Meridia Panties v1.0.10 - Event Horizon". Harmless to
   * read, and it would have been baked into every staging folder name.
   */
  const clean = (raw: string): string =>
    raw
      // Windows-illegal in a file name. Both halves are free text: the mod
      // name comes from a manifest, the collection name is what the curator
      // typed into the build form.
      .replace(/[/\\:*?"<>|]/g, "_")
      // Win32 silently drops trailing dots and spaces, which would make the
      // path we return differ from the one that exists.
      .replace(/[\s.]+$/, "")
      .trim();

  const marker = ` - ${clean(args.collectionName)} v${clean(
    args.collectionVersion,
  )} - Event Horizon`;

  /**
   * The MARKER is what makes this name unique and what tells the user whose
   * mod it is, so the mod name is the half that gets trimmed. Truncating from
   * the right would drop "- Event Horizon" first and then the version —
   * exactly backwards, and it would reintroduce the install-name collision
   * this name exists to prevent.
   */
  const budget = Math.max(24, 120 - marker.length);
  return `${clean(args.modName).slice(0, budget)}${marker}`;
}

export type AlongsideResult = {
  vortexModId: string;
  /** Caller removes this once Vortex has taken its own copy of the archive. */
  tempDir: string;
  /** The name Vortex now shows for our copy. */
  installName: string;
};

/**
 * Install `archivePath`'s mod as a second copy under our own name.
 *
 * The caller supplies the bytes: an archive already on disk (the user's own
 * download, once its hash is confirmed to be the curator's) or one extracted
 * from the `.ehcoll`. This function does not fetch anything — deciding where
 * the curator's bytes come from is the caller's job and differs per source.
 *
 * Throws on failure, and the mod the user already had is untouched either way:
 * nothing here uninstalls anything.
 */
export async function installAlongside(
  api: types.IExtensionApi,
  args: {
    gameId: string;
    /** Bytes to install. Copied, never moved — the source may be Vortex's own. */
    archivePath: string;
    modName: string;
    collectionName: string;
    collectionVersion: string;
    /** The curator's recorded installer answers, when the mod had any. */
    choices?: VortexInstallerChoices;
    unattended?: boolean;
    signal?: AbortSignal;
  },
): Promise<AlongsideResult> {
  const installName = alongsideInstallName({
    modName: args.modName,
    collectionName: args.collectionName,
    collectionVersion: args.collectionVersion,
  });

  /**
   * ─── HAVE WE ALREADY MADE THIS EXACT COPY? ──────────────────────────────
   * The install name is deterministic in (mod, collection, version), and a
   * Vortex mod's id IS its install name — so a second run of the same release
   * asks Vortex to create a mod that already exists. Vortex answers with its
   * replace-or-variant dialog, which cannot be pre-answered, only avoided.
   * Nobody is watching an unattended install, so it sat there:
   *
   *   install.alongside.failed  F4SE / Address Library
   *   "Mod install stalled — no observable progress for 600s while
   *    extracting. The install pipeline may be waiting on a stuck dialog"
   *
   * Twenty minutes each, and both mods ended up unmirrored.
   *
   * A mod under this name is OURS by construction — the name carries our
   * collection and version, which nothing else writes — so finding one is not
   * a collision to work around, it is the previous run's answer. Adopt it.
   *
   * This is the same hole from the other side: a completed run records the
   * copy as `ownership: "installed"` and the next run's `ownedByUs` skips the
   * alongside path entirely. That only helps when a receipt survived, and the
   * run that made these had been interrupted before writing one.
   */
  const existing = (
    api.getState() as {
      persistent?: { mods?: Record<string, Record<string, unknown>> };
    }
  )?.persistent?.mods?.[args.gameId]?.[installName];
  if (existing !== undefined) {
    ehLog("info", "install.alongside.already-ours", {
      modName: args.modName,
      installName,
      why:
        "a mod under our own deterministic name already exists — an earlier " +
        "run of this release made it. Adopted instead of asking Vortex to " +
        "create it again, which raises a dialog nothing can answer.",
    });
    return {
      vortexModId: installName,
      // Nothing was staged, so there is nothing for the caller to clean up.
      tempDir: await fsp.mkdtemp(
        path.join(os.tmpdir(), "event-horizon-alongside-noop-"),
      ),
      installName,
    };
  }

  // Keep the extension: it is what tells Vortex which extractor to use.
  const ext = path.extname(args.archivePath);
  const tempDir = await fsp.mkdtemp(
    path.join(os.tmpdir(), "event-horizon-alongside-"),
  );

  try {
    const staged = path.join(tempDir, `${installName}${ext}`);
    // Copy rather than rename: the source is often Vortex's own download, and
    // moving it out from under Vortex would break the user's existing mod.
    await fsp.copyFile(args.archivePath, staged);

    // Registers a NEW download record — the second half of avoiding the
    // dialog. Its id is derived from this path, which no other mod has.
    const adopted = await adoptLocalArchive(api, {
      gameId: args.gameId,
      archivePath: staged,
    });

    ehLog("info", "install.alongside.start", {
      modName: args.modName,
      installName,
      archiveId: adopted.archiveId,
    });

    const installed = await installFromExistingDownload(api, {
      gameId: args.gameId,
      archiveId: adopted.archiveId,
      ...(args.choices !== undefined ? { choices: args.choices } : {}),
      ...(args.unattended !== undefined ? { unattended: args.unattended } : {}),
      ...(args.signal !== undefined ? { signal: args.signal } : {}),
    });

    ehLog("info", "install.alongside.ok", {
      modName: args.modName,
      installName,
      vortexModId: installed.vortexModId,
    });

    return { vortexModId: installed.vortexModId, tempDir, installName };
  } catch (err) {
    // Extraction/registration never got as far as handing Vortex a copy, so
    // this directory is ours to drop.
    await safeRmTempDir(tempDir);
    throw err;
  }
}
