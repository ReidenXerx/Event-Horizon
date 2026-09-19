/**
 * ──────────────────────────────────────────────────────────────────────
 * A mod the PLAYER is asked to supply must have an archive on the
 * curator's side. This refuses the build when one does not.
 *
 * ─── WHY THIS IS A REFUSAL AND NOT A WARNING ───────────────────────────
 * An external mod — one that does not come from Nexus, or that the curator
 * marked `treatAsExternal` — is not fetched for the player. They are shown a
 * file picker and told to supply their own copy, because the collection
 * cannot legally or technically fetch it for them.
 *
 * The only thing that makes that safe is the curator's archive: its SHA-256
 * is what `checkArchiveIdentity` compares the picked file against, at the
 * moment of picking, while the player still has the chance to go and get the
 * right one. With no archive on the curator's side there is no expectation to
 * compare, `checkArchiveIdentity` returns without an opinion, and the picker
 * accepts whatever it is handed.
 *
 * What happens next is the part that cost someone an evening. The mod still
 * has an identity — the SHA-256 of the curator's DEPLOYED files — so the
 * divergence is caught, but only after the wrong archive has been installed,
 * by verification, as a file mismatch with nothing in it that names a file to
 * download instead. The player is told their install is wrong and not what
 * would make it right. That is the whole failure mode: a mod hosted outside
 * Nexus gets a new version, the curator never hears about it, the player
 * downloads the newest one because it is the only one on the page, and
 * everything downstream is a mismatch nobody can act on.
 *
 * ─── THE THREE WAYS OUT, ALL OF THEM CHEAP ─────────────────────────────
 * Import the archive into Vortex, so its hash exists; tick Bundle, so the
 * package carries the bytes and nobody is asked for anything (NS-5/NS-6 — the
 * curator's call, since it costs the author their download); or take the mod
 * out of the profile. Every one of those is a minute of the curator's time
 * against an unfixable install on a stranger's machine.
 *
 * A BUNDLED external mod is deliberately exempt: the package carries it, so
 * no player is ever prompted, so there is no pick to check.
 * ──────────────────────────────────────────────────────────────────────
 */

/** One mod as this gate needs to see it. */
export type ExternalArchiveMod = {
  id: string;
  name: string;
  /**
   * The curator's source archive hash, when Vortex still holds the archive.
   * Its absence is the whole subject of this file.
   */
  archiveSha256?: string | undefined;
  /** Does the player install this from their own copy? */
  shipsAsExternal: boolean;
  /**
   * Does the package carry this mod's own bytes?
   *
   * MEASURED bundling, not the curator's tick: a mod flagged for bundling
   * whose repack failed is refused separately by name, and must not be let
   * through here on an intention that did not happen.
   */
  bundled: boolean;
};

export type ExternalArchiveRefusal = {
  code: "external-without-archive";
  /** The mods that caused it, for the log and for the message. */
  mods: readonly { id: string; name: string }[];
  message: string;
};

/** How many names go in the message before it becomes a wall of text. */
const NAMES_SHOWN = 12;

/**
 * May this build proceed?
 *
 * `undefined` means yes. Pure, so the rule is testable without a Vortex.
 */
export function externalArchiveRefusal(
  mods: readonly ExternalArchiveMod[],
): ExternalArchiveRefusal | undefined {
  const offenders = mods.filter(
    (m) =>
      m.shipsAsExternal &&
      !m.bundled &&
      (m.archiveSha256 === undefined || m.archiveSha256 === ""),
  );
  if (offenders.length === 0) return undefined;

  /**
   * One flowing paragraph, not a bulleted block.
   *
   * The curator reads this in the `<span>` above the Build button, which has
   * no `pre-line`: a message written with newlines arrives as one run-on line
   * with the indentation folded into it. Prose survives that; a list does not.
   */
  const shown = offenders.slice(0, NAMES_SHOWN).map((m) => `"${m.name}"`);
  const rest = offenders.length - shown.length;
  const names = shown.join(", ") + (rest > 0 ? `, and ${rest} more` : "");

  const count = `${offenders.length} mod${offenders.length === 1 ? "" : "s"}`;
  const they = offenders.length === 1 ? "it" : "them";
  const their = offenders.length === 1 ? "its" : "their";

  return {
    code: "external-without-archive",
    mods: offenders.map((m) => ({ id: m.id, name: m.name })),
    message:
      `${count} ship${offenders.length === 1 ? "s" : ""} as external — the ` +
      `player is shown a file picker and asked to supply ${their} own copy — ` +
      `but Vortex no longer holds ${their} archive on your side, so there is ` +
      `no hash to check ${their} pick against: ${names}. ` +
      `Without your archive the picker accepts whatever file it is handed, ` +
      `and if the mod has had a new version since you installed it — the ` +
      `usual case for anything hosted outside Nexus — the player downloads ` +
      `that one, it installs, and the mismatch only surfaces later as failed ` +
      `file checks that cannot tell them which file to get instead. ` +
      `Any one of three things fixes ${they}: ` +
      `Import the archive into Vortex (drop the file into Vortex's download ` +
      `folder and let it scan), then build again; ` +
      `or tick "Bundle" for the mod, so the package carries its files and ` +
      `nobody is asked for anything — check the author's permissions first; ` +
      `or disable the mod in this profile, which leaves it out of the ` +
      `collection entirely.`,
  };
}
