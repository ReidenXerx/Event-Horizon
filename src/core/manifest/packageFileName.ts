/**
 * The one place that decides what a built package is called.
 *
 * It lived inside `buildPackageAction` as a private helper, which was fine
 * while exactly one thing produced the name and nothing ever had to find the
 * file again. The Collection Doctor has to find it again — most of its repairs
 * re-run pipeline steps that read the manifest — and a second, hand-copied
 * version of this rule would be a slow-motion bug: the two would agree today
 * and disagree the first time either changed, surfacing as a Doctor that
 * cannot locate a package sitting right in front of it.
 *
 * Both the writer and the finder now import this.
 */

/** Package name → filename slug. */
export function slugifyPackageName(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      // Long names are legal and unbounded; filesystems are not.
      .slice(0, 64) || "collection"
  );
}

/** Version → filename-safe version. Dots and dashes survive; nothing else. */
export function safePackageVersion(version: string): string {
  return version.replace(/[^a-zA-Z0-9.-]/g, "-");
}

/**
 * What a package file is written as. Both are the same zip with `manifest.json`
 * at its root; only the name differs. `.zip` exists because Nexus quarantines
 * the `.ehcoll` extension, so a curator publishing there builds `.zip` directly
 * instead of renaming the file by hand.
 */
export type PackageFormat = "ehcoll" | "zip";

/** `<slug>-<version>.<ehcoll|zip>` — the name the packager writes. */
export function buildOutputFileName(
  name: string,
  version: string,
  format: PackageFormat = "ehcoll",
): string {
  return `${slugifyPackageName(name)}-${safePackageVersion(version)}.${format}`;
}

/** The format a package file's name says it is, or undefined for any other file. */
export function packageFormatOf(fileName: string): PackageFormat | undefined {
  const lower = fileName.toLowerCase();
  if (lower.endsWith(".ehcoll")) return "ehcoll";
  if (lower.endsWith(".zip")) return "zip";
  return undefined;
}
