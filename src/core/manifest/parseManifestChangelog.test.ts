/**
 * A package's changelog is for reading. Whatever shape it arrives in, it must
 * never be the reason a collection does not open: the parser keeps what it can
 * read, says what it left out, and installs go ahead.
 */
import { describe, expect, it } from "vitest";

import { parseManifest } from "./parseManifest";

const manifestWith = (changelog: unknown): string => {
  const pkg: Record<string, unknown> = {
    id: "11111111-2222-4333-8444-555555555555",
    name: "Test",
    version: "1.0.1",
    author: "someone",
    createdAt: "2026-01-01T00:00:00.000Z",
    strictMissingMods: false,
    verificationLevel: "thorough",
  };
  if (changelog !== undefined) pkg.changelog = changelog;
  return JSON.stringify({
    schemaVersion: 2,
    package: pkg,
    game: { id: "fallout4", version: "1.10.163.0", versionPolicy: "exact" },
    vortex: { version: "1.9.0", deploymentMethod: "hardlink", requiredExtensions: [] },
    mods: [],
    rules: [],
    plugins: { order: [] },
    loadOrder: [],
    iniTweaks: [],
    externalDependencies: [],
  });
};

describe("package.changelog", () => {
  it("is absent for a package built before changelogs existed", () => {
    const { manifest, warnings } = parseManifest(manifestWith(undefined));
    expect(manifest.package.changelog).toBeUndefined();
    expect(warnings.some((w) => w.includes("changelog"))).toBe(false);
  });

  it("comes through intact when it is well formed", () => {
    const entries = [
      {
        version: "1.0.1",
        date: "2026-01-02T00:00:00.000Z",
        notes: "Added Lux.",
        changes: { mods: { added: [{ name: "Lux", version: "6.5" }] } },
      },
      { version: "1.0.0", date: "2026-01-01T00:00:00.000Z", firstRelease: { mods: 3, plugins: 2 } },
    ];
    const { manifest } = parseManifest(manifestWith(entries));
    expect(manifest.package.changelog?.map((e) => e.version)).toEqual(["1.0.1", "1.0.0"]);
    expect(manifest.package.changelog?.[0]?.changes?.mods.added).toEqual([{ name: "Lux", version: "6.5" }]);
    expect(manifest.package.changelog?.[1]?.firstRelease).toEqual({ mods: 3, plugins: 2 });
  });

  it("leaves out unreadable entries with a warning, and the package still opens", () => {
    const { manifest, warnings } = parseManifest(
      manifestWith([{ version: "1.0.1", date: "2026-01-02" }, { nonsense: true }, 42]),
    );
    expect(manifest.package.changelog?.map((e) => e.version)).toEqual(["1.0.1"]);
    expect(warnings.some((w) => w.includes("2 unreadable entries"))).toBe(true);
  });

  it("does not refuse a package whose changelog is not a list at all", () => {
    const { manifest, warnings } = parseManifest(manifestWith("see the Nexus page"));
    expect(manifest.package.changelog).toEqual([]);
    expect(warnings.some((w) => w.includes("1 unreadable entry"))).toBe(true);
  });
});
