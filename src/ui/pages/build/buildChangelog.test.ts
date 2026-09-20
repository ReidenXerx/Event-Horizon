import { describe, expect, it, vi } from "vitest";

import { prepareChangelog } from "./buildChangelog";
import type { ChangelogHistory, ChangelogSnapshot } from "../../../core/changelog/changelog";
import type { EhcollManifest } from "../../../types/ehcoll";

const PACKAGE_ID = "fa6eb141-03b0-4847-bb12-e4c5fe4fa385";

const manifest = (
  version: string,
  modNames: string[],
  over: Record<string, unknown> = {},
): EhcollManifest =>
  ({
    package: {
      id: PACKAGE_ID,
      name: "Ivy's Panties",
      version,
      author: "DuduPhudu",
      createdAt: "2026-09-15T12:00:00.000Z",
      ...over,
    },
    game: { id: "fallout4", version: "1.10.163.0", versionPolicy: "exact" },
    vortex: { requiredExtensions: [] },
    mods: modNames.map((name, i) => ({
      compareKey: `nexus:${i + 1}:1`,
      name,
      source: { kind: "nexus" },
      install: { fomodSelections: [] },
      state: { enabled: true },
    })),
    plugins: { order: [] },
    loadOrder: [],
    rules: [],
    iniTweaks: [],
    externalDependencies: [],
  }) as unknown as EhcollManifest;

const pkg = (fileName: string) => ({ fileName, fullPath: `C:/c/${fileName}`, bytes: 1, builtAt: new Date() });

const common = {
  configDir: "C:/c/.config",
  slug: "ivy-s-panties",
  outputDir: "C:/c",
  knownSlugs: async () => ["ivy-s-panties"],
};

describe("prepareChangelog", () => {
  it("compares with the kept history and never opens a package when it has one", async () => {
    const last: ChangelogSnapshot = {
      schema: 1,
      version: "1.0.26",
      game: { version: "1.10.163.0", versionPolicy: "exact" },
      requiredExtensions: [],
      mods: [{ compareKey: "nexus:1:1", name: "A", enabled: true, delivery: "download", fomodSelections: [] }],
      plugins: [],
      loadOrder: [],
      rules: [],
      iniTweaks: [],
      gameIni: [],
      externalDependencies: [],
    };
    const history: ChangelogHistory = { schema: 1, entries: [], last };
    const findPackages = vi.fn();
    const prepared = await prepareChangelog({
      ...common,
      manifest: manifest("1.0.27", ["A", "B"]),
      notes: "Added B.",
      loadHistory: async () => history,
      findPackages,
    });
    expect(findPackages).not.toHaveBeenCalled();
    expect(prepared.entry.changes?.mods.added).toEqual([{ name: "B" }]);
    expect(prepared.markdown).toContain("Added B.");
    expect(prepared.bbcode).toContain("[b]Mods added (1)[/b]");
  });

  it("without history, compares with the newest earlier version of THIS collection and inherits its changelog", async () => {
    const packages = {
      "C:/c/ivy-s-panties-1.0.27.zip": manifest("1.0.27", ["A", "B", "C"]),
      "C:/c/ivy-s-panties-other.zip": manifest("2.0.0", ["X"], { id: "00000000-0000-4000-8000-000000000000" }),
      "C:/c/ivy-s-panties-1.0.26.zip": manifest("1.0.26", ["A"], {
        changelog: [{ version: "1.0.26", date: "2026-09-14T00:00:00Z", firstRelease: { mods: 1, plugins: 0 } }],
      }),
    } as Record<string, EhcollManifest>;
    const prepared = await prepareChangelog({
      ...common,
      manifest: manifest("1.0.27", ["A", "B"]),
      notes: "",
      loadHistory: async () => undefined,
      // Newest first: a rebuild of the same version, another collection, then the real previous one.
      findPackages: async () => [pkg("ivy-s-panties-1.0.27.zip"), pkg("ivy-s-panties-other.zip"), pkg("ivy-s-panties-1.0.26.zip")],
      readManifest: async (p) => packages[p]!,
    });
    expect(prepared.entry.changes?.mods.added).toEqual([{ name: "B" }]);
    expect(prepared.history.entries.map((e) => e.version)).toEqual(["1.0.27", "1.0.26"]);
    expect(prepared.note).toBeUndefined();
  });

  it("finds the previous version however many republished builds sit in front of it", async () => {
    /**
     * The scan used to open three packages and stop. A same-version
     * republish consumes a slot every time it runs — and republishing the
     * same version is a routine part of this workflow — so three of them
     * beside the new build exhausted the budget, the previous version was
     * never opened, and the changelog was written as a FIRST RELEASE with
     * the collection's whole history discarded and nothing said about it.
     */
    const packages: Record<string, EhcollManifest> = {
      "C:/c/ivy-s-panties-1.0.27-c.zip": manifest("1.0.27", ["A", "B"]),
      "C:/c/ivy-s-panties-1.0.27-b.zip": manifest("1.0.27", ["A", "B"]),
      "C:/c/ivy-s-panties-1.0.27-a.zip": manifest("1.0.27", ["A", "B"]),
      "C:/c/ivy-s-panties-other.zip": manifest("2.0.0", ["X"], {
        id: "00000000-0000-4000-8000-000000000000",
      }),
      "C:/c/ivy-s-panties-1.0.26.zip": manifest("1.0.26", ["A"]),
    };
    const prepared = await prepareChangelog({
      ...common,
      manifest: manifest("1.0.27", ["A", "B"]),
      notes: "",
      loadHistory: async () => undefined,
      findPackages: async () => Object.keys(packages).map((p) => pkg(p.slice("C:/c/".length))),
      readManifest: async (p) => packages[p]!,
    });
    expect(prepared.entry.changes?.mods.added).toEqual([{ name: "B" }]);
    expect(prepared.note).toBeUndefined();
  });

  it("says it looked when it opened packages and none was an earlier version", async () => {
    // "First release" has to be a statement about what the scan did, not a
    // shape the output happens to take when nothing matched.
    const packages: Record<string, EhcollManifest> = {
      "C:/c/ivy-s-panties-other.zip": manifest("2.0.0", ["X"], {
        id: "00000000-0000-4000-8000-000000000000",
      }),
    };
    const prepared = await prepareChangelog({
      ...common,
      manifest: manifest("1.0.27", ["A"]),
      notes: "",
      loadHistory: async () => undefined,
      findPackages: async () => [pkg("ivy-s-panties-other.zip")],
      readManifest: async (p) => packages[p]!,
    });
    expect(prepared.entry.firstRelease).toEqual({ mods: 1, plugins: 0 });
    expect(prepared.note).toContain("none was an earlier version");
  });

  it("says it STOPPED when a caller caps how many packages it may open", async () => {
    const packages: Record<string, EhcollManifest> = {
      "C:/c/ivy-s-panties-1.0.27-a.zip": manifest("1.0.27", ["A", "B"]),
      "C:/c/ivy-s-panties-1.0.26.zip": manifest("1.0.26", ["A"]),
    };
    const prepared = await prepareChangelog({
      ...common,
      manifest: manifest("1.0.27", ["A", "B"]),
      notes: "",
      loadHistory: async () => undefined,
      maxPackagesRead: 1,
      findPackages: async () => [pkg("ivy-s-panties-1.0.27-a.zip"), pkg("ivy-s-panties-1.0.26.zip")],
      readManifest: async (p) => packages[p]!,
    });
    expect(prepared.note).toContain("Stopped after opening 1");
  });

  it("writes a first release and says why when the earlier package cannot be read", async () => {
    const prepared = await prepareChangelog({
      ...common,
      manifest: manifest("1.0.27", ["A"]),
      notes: "",
      loadHistory: async () => undefined,
      findPackages: async () => [pkg("ivy-s-panties-1.0.26.zip")],
      readManifest: async () => {
        throw new Error("central directory missing");
      },
    });
    expect(prepared.entry.firstRelease).toEqual({ mods: 1, plugins: 0 });
    expect(prepared.note).toContain("central directory missing");
  });
});
