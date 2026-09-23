/**
 * The case that made this: a player's update from Meridia 1.0.20 to 1.0.23
 * stopped at `Pandora_sd` for three hours, because the previous revision's
 * `Pandora_sd` still held the name and Vortex asked whether to replace it.
 */
import { describe, expect, it } from "vitest";

import { bundledTargetName } from "./bundledTargetName";
import { collectBundledZipEntriesForPrefetchForTest } from "./runInstall";

const PACKAGE = { id: "5448963d-2ec5-4eb2-8f99-a25a4153fcb6", name: "Meridia's Panties", version: "1.0.23" };
const KEY = `external:staging:${"c".repeat(64)}`;

const target = (modName: string, taken: string[]): string => {
  const pool = new Set(taken.map((t) => t.toLowerCase()));
  return bundledTargetName({
    modName,
    sha256: "a".repeat(64),
    isTaken: (id) => pool.has(id.toLowerCase()),
    collectionName: PACKAGE.name,
    collectionVersion: PACKAGE.version,
    packageId: PACKAGE.id,
    compareKey: KEY,
  });
};

describe("bundledTargetName", () => {
  it("keeps the curator's name when nothing holds it", () => {
    expect(target("Pandora_sd", ["Something Else"])).toBe("Pandora_sd");
  });

  it("goes in beside a different mod that holds the name, under the mirrored mods' per-release name", () => {
    const name = target("Pandora_sd", ["Pandora_sd"]);
    expect(name).not.toBe("Pandora_sd");
    expect(name).toMatch(/^Pandora_sd - Meridia's Panties v1\.0\.23 \[[0-9a-f]{8}\] - Event Horizon$/);
    // Deterministic, so a resumed install asks for the same name again.
    expect(target("Pandora_sd", ["Pandora_sd"])).toBe(name);
  });

  it("asks about the id Vortex would derive, not the raw title", () => {
    // `bundledArchiveFileName` turns the colon into `_`; that spelling is what
    // Vortex's pool holds, so that is the one that must count as taken.
    expect(target("Skyrim: Patch", ["Skyrim_ Patch"])).not.toBe("Skyrim: Patch");
    expect(target("Skyrim: Patch", ["Skyrim: Patch"])).toBe("Skyrim: Patch");
  });
});

describe("the install driver's bundled names", () => {
  const ctx = (kind: "fresh-profile" | "current-profile", pool: string[]) =>
    ({
      api: {
        getState: () => ({
          persistent: { mods: { skyrimse: Object.fromEntries(pool.map((id) => [id, { id }])) } },
        }),
      },
      plan: {
        manifest: {
          package: PACKAGE,
          game: { id: "skyrimse" },
          mods: [{ compareKey: KEY, name: "Pandora_sd", source: { kind: "external", sha256: "a".repeat(64), bundled: true } }],
        },
        installTarget: { kind },
        modResolutions: [
          {
            compareKey: KEY,
            name: "Pandora_sd",
            decision: { kind: "external-use-bundled", sha256: "a".repeat(64), bundleFolder: "bundled/aaa/" },
          },
        ],
      },
    }) as never;

  it("primes a new revision's bundle beside the previous revision's copy", () => {
    const [req] = collectBundledZipEntriesForPrefetchForTest(ctx("fresh-profile", ["Pandora_sd"]));
    expect(req!.preferredName).toMatch(/^Pandora_sd - Meridia's Panties v1\.0\.23 \[[0-9a-f]{8}\] - Event Horizon$/);
  });

  it("sees a taken name whatever its case", () => {
    const [req] = collectBundledZipEntriesForPrefetchForTest(ctx("fresh-profile", ["pandora_SD"]));
    expect(req!.preferredName).not.toBe("Pandora_sd");
  });

  it("keeps the plain name when the pool does not hold it", () => {
    const [req] = collectBundledZipEntriesForPrefetchForTest(ctx("fresh-profile", ["Other"]));
    expect(req!.preferredName).toBe("Pandora_sd");
  });

  it("leaves an in-place install alone: there the name may be this release's own copy", () => {
    // Repairing in place, a same-named mod can be ours with files missing and
    // enabled in this very profile; a second copy would double it up.
    const [req] = collectBundledZipEntriesForPrefetchForTest(ctx("current-profile", ["Pandora_sd"]));
    expect(req!.preferredName).toBe("Pandora_sd");
  });
});
