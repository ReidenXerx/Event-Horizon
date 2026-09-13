/**
 * A bundled mod's archive is one WE build from the curator's staging folder,
 * and a ZIP stores each file's modification time — so its hash encodes mtimes,
 * metadata that says nothing about the mod's contents. Verified with the real
 * packer: repacking the same folder after touching one file, contents
 * byte-identical, produces a different hash.
 *
 * Identity is what the user-side reconciler compares across releases. Key a
 * mod on that hash and any mtime change — reinstalling the same mod version, a
 * redeploy, a backup tool, copying the staging folder — re-keys it. On the next
 * update the old key is gone from the manifest, so the mod is reported as an
 * ORPHAN and the user is asked to uninstall something still in the collection,
 * while the new key installs a second copy.
 *
 * So: a repacked mod is identified by its CONTENT, and the archive hash stays
 * where it belongs — locating the bundled file inside the package.
 */
import { describe, expect, it } from "vitest";

import { buildManifest } from "./buildManifest";
import type { BuildManifestInput } from "./buildManifest";

const stagingFiles = [
  { path: "Data/a.esp", size: 3, sha256: "a".repeat(64) },
  { path: "Data/b.ba2", size: 3, sha256: "b".repeat(64) },
];

const buildWith = (args: {
  archiveSha256: string;
  repacked: boolean;
}): ReturnType<typeof buildManifest> =>
  buildManifest({
    snapshot: {
      gameId: "fallout4",
      mods: [
        {
          id: "custom-mod",
          name: "Ivy Panties Settings",
          enabled: true,
          modType: "",
          installOrder: 0,
          rules: [],
          fileOverrides: [],
          enabledINITweaks: [],
          fomodSelections: [],
          hasInstallerChoices: false,
          hasDetailedInstallerChoices: false,
          archiveSha256: args.archiveSha256,
          stagingFiles,
        },
      ],
    },
    package: {
      id: "00000000-0000-4000-8000-000000000000",
      name: "P",
      version: "1.0.0",
      author: "a",
      verificationLevel: "thorough",
    },
    game: { version: "1.10.163.0", versionPolicy: "exact" },
    vortex: { version: "2.6.0", deploymentMethod: "hardlink" },
    externalMods: { "custom-mod": { bundled: true } },
    ...(args.repacked
      ? { bundledModIds: new Set(["custom-mod"]) }
      : {}),
  } as unknown as BuildManifestInput);

const keyOf = (r: ReturnType<typeof buildManifest>): string =>
  r.manifest.mods[0]!.compareKey;

describe("repacked mod identity", () => {
  it("does not change when only the repacked archive hash changes", () => {
    // Two builds of an UNCHANGED mod. The repacker produced different bytes
    // because a file's mtime moved; the mod itself is identical.
    const first = buildWith({ archiveSha256: "1".repeat(64), repacked: true });
    const second = buildWith({ archiveSha256: "2".repeat(64), repacked: true });
    expect(keyOf(first)).toBe(keyOf(second));
    expect(keyOf(first)).toMatch(/^external:staging:/);
  });

  it("still locates the bundled archive by its real hash", () => {
    // Identity moved; the LOCATOR must not. The package stores the archive at
    // bundled/<sha256>, so source.sha256 stays the repacked archive's hash.
    const built = buildWith({ archiveSha256: "1".repeat(64), repacked: true });
    const source = built.manifest.mods[0]!.source as { sha256?: string };
    expect(source.sha256).toBe("1".repeat(64));
  });

  it("leaves a NON-repacked external mod keyed on its archive", () => {
    // A downloaded archive is a stable artifact — it is the stronger identity
    // and this must not change it, or every existing collection re-keys.
    const a = buildWith({ archiveSha256: "1".repeat(64), repacked: false });
    expect(keyOf(a)).toBe(`external:${"1".repeat(64)}`);
  });

  it("changes identity when the mod's CONTENT changes", () => {
    // The other half: stable is not the same as frozen. A real edit to the
    // staging files must still produce a new identity, or an updated mod would
    // be mistaken for the old one.
    const before = buildWith({ archiveSha256: "1".repeat(64), repacked: true });
    const after = buildManifest({
      snapshot: {
        gameId: "fallout4",
        mods: [
          {
            id: "custom-mod",
            name: "Ivy Panties Settings",
            enabled: true,
            modType: "",
            installOrder: 0,
            rules: [],
            fileOverrides: [],
            enabledINITweaks: [],
            fomodSelections: [],
            hasInstallerChoices: false,
            hasDetailedInstallerChoices: false,
            archiveSha256: "1".repeat(64),
            stagingFiles: [
              stagingFiles[0]!,
              { path: "Data/b.ba2", size: 4, sha256: "c".repeat(64) },
            ],
          },
        ],
      },
      package: {
        id: "00000000-0000-4000-8000-000000000000",
        name: "P",
        version: "1.0.0",
        author: "a",
        verificationLevel: "thorough",
      },
      game: { version: "1.10.163.0", versionPolicy: "exact" },
      vortex: { version: "2.6.0", deploymentMethod: "hardlink" },
      externalMods: { "custom-mod": { bundled: true } },
      bundledModIds: new Set(["custom-mod"]),
    } as unknown as BuildManifestInput);
    expect(keyOf(before)).not.toBe(keyOf(after));
  });
});
