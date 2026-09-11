/**
 * ──────────────────────────────────────────────────────────────────────
 * Is a mod's archive actually in Downloads?
 *
 * Vortex recording an archive id is not the archive being on disk: an
 * in-place update leaves the mod pointing at a dead download record, and an
 * archive deleted by hand leaves its record behind. Reinstall has refused on
 * that basis since it was written — it uninstalls first (NS-2). Remove told
 * the curator "its archive stays in Downloads, so it can be installed again"
 * for every mod without looking, and for a mod whose archive is gone,
 * removing it means downloading it again: the one consequence the dialog
 * existed to state.
 * ──────────────────────────────────────────────────────────────────────
 */

/** Split mods by whether the archive Vortex records for them is on disk. */
export async function splitByArchiveOnDisk<T extends { archiveId?: string }>(
  mods: readonly T[],
  pathOf: (archiveId: string | undefined) => string | undefined,
  exists: (fullPath: string) => Promise<boolean>,
): Promise<{ withArchive: T[]; noArchive: T[] }> {
  const withArchive: T[] = [];
  const noArchive: T[] = [];
  for (const m of mods) {
    const full = pathOf(m.archiveId);
    if (full !== undefined && (await exists(full))) withArchive.push(m);
    else noArchive.push(m);
  }
  return { withArchive, noArchive };
}

const bulleted = (names: readonly string[], cap: number): string =>
  names
    .slice(0, cap)
    .map((n) => `  • ${n}`)
    .join("\n") + (names.length > cap ? `\n  … and ${names.length - cap} more` : "");

/** The Remove confirmation, saying which of the mods can come back from Downloads. */
export function describeRemoveConfirm(input: {
  targets: readonly { name: string }[];
  noArchive: readonly { name: string }[];
  stillNeeded: readonly { provider: { name: string }; dependants: readonly { name: string }[] }[];
}): string {
  const { targets, noArchive, stillNeeded } = input;
  const archives =
    noArchive.length === 0
      ? `Each one's archive stays in Downloads, so it can be installed again; Disk cleanup lists such archives.`
      : noArchive.length === targets.length
        ? `None of them has its archive in Downloads, so none can be reinstalled offline — each would have to be ` +
          `downloaded again.`
        : `${targets.length - noArchive.length} of them keep their archive in Downloads and can be installed again from ` +
          `there; the ${noArchive.length} listed under NO ARCHIVE cannot.`;
  return (
    `Each is uninstalled from Vortex — its staging folder is deleted and it leaves every profile. ${archives}\n\n` +
    bulleted(
      targets.map((m) => m.name),
      10,
    ) +
    (noArchive.length > 0 && noArchive.length < targets.length
      ? `\n\nNO ARCHIVE ON DISK — cannot be reinstalled offline; each would have to be downloaded again:\n` +
        bulleted(
          noArchive.map((m) => m.name),
          10,
        )
      : "") +
    (stillNeeded.length > 0
      ? `\n\nSTILL NEEDED: ` +
        stillNeeded
          .slice(0, 6)
          .map((b) => `${b.provider.name} by ${b.dependants.map((d) => d.name).join(", ")}`)
          .join("; ") +
        `.`
      : "")
  );
}
