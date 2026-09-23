/**
 * The mod that motivated this is real: a settings bundle the curator edits in
 * place. 188 files in the source archive, 179 in staging — 12 removed, 3 added.
 * It built, shipped, and would have handed every user the original archive.
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { __testPaths } from "../../../test/stubs/vortex-api";
import {
  describeExternalDrift,
  detectExternalDrift,
  measureBundledMods,
  type ExternalDrift,
} from "./bundleFromStaging";
import { fakeSevenZip } from "./testing/fakeSevenZip";
import type { AuditorMod } from "../getModsListForProfile";
import type { CollectionConfig } from "./collectionConfig";

const mod = (over: Partial<AuditorMod> & { id: string }): AuditorMod =>
  ({
    name: over.id,
    enabled: true,
    collectionIds: [],
    hasInstallerChoices: false,
    hasDetailedInstallerChoices: false,
    fomodSelections: [],
    rules: [],
    modType: "",
    fileOverrides: [],
    enabledINITweaks: [],
    installOrder: 0,
    ...over,
  }) as AuditorMod;

const config = (externalMods: CollectionConfig["externalMods"]): CollectionConfig =>
  ({ schemaVersion: 1, packageId: "p", externalMods }) as CollectionConfig;

let staging: string;
beforeEach(() => {
  staging = fs.mkdtempSync(path.join(os.tmpdir(), "eh-bundle-"));
  __testPaths.installPath = staging;
});
afterEach(() => {
  fs.rmSync(staging, { recursive: true, force: true });
  __testPaths.installPath = "/stub/install";
});

const listing = (paths: string[]) => async () => ({
  entries: paths.map((p) => ({ path: p })),
});

describe("detectExternalDrift", () => {
  const base = {
    state: {} as never,
    gameId: "fallout4",
    sevenZip: fakeSevenZip({}),
    isExternal: () => true,
    archivePathFor: () => "C:/dl/settings.7z",
  };

  it("reports files removed AND added — that is what editing in place looks like", async () => {
    const [drift] = await detectExternalDrift({
      ...base,
      mods: [
        mod({
          id: "settings",
          name: "Ivy'sPantiesSettings",
          installationPath: "settings",
          stagingFiles: [
            { path: "F4SE/Plugins/BakaFramework.toml", size: 1 },
            { path: "PC_README.md", size: 1 },
          ] as never,
        }),
      ],
      config: config({}),
      listArchive: listing([
        "F4SE/Plugins/BakaFramework.toml",
        "F4SE/Plugins/x-cell.toml",
      ]),
    });
    expect(drift!.removed).toEqual(["f4se/plugins/x-cell.toml"]);
    expect(drift!.added).toEqual(["pc_readme.md"]);
  });

  it("does not let a root-level file explain away one at depth", async () => {
    /**
     * ─── A SUFFIX OF ONE SEGMENT IS A BASENAME, NOT A WRAPPER ──────────
     * The tail match allowed the shorter side to be a single segment, so a
     * root `readme.txt` in the archive matched a staged `docs/readme.txt` at
     * any depth and both dropped out of the comparison. Root-level
     * readme/licence/changelog alongside a `docs/` folder is an ordinary
     * mod-archive shape.
     *
     * Under-reporting is the silent direction: `describeExternalDrift` stays
     * quiet, the curator is never told their hand-maintained mod diverged,
     * and the collection ships the ARCHIVE — "whoever installs it gets the
     * original, not your version", which is the harm this module opens with.
     */
    const [drift] = await detectExternalDrift({
      ...base,
      mods: [
        mod({
          id: "docs",
          installationPath: "docs",
          stagingFiles: [
            { path: "a.esp", size: 1 },
            { path: "docs/readme.txt", size: 1 },
          ] as never,
        }),
      ],
      config: config({}),
      listArchive: listing(["a.esp", "readme.txt"]),
    });
    // Both directions: the staged one is genuinely new, the archived one
    // genuinely gone.
    expect(drift!.added).toEqual(["docs/readme.txt"]);
    expect(drift!.removed).toEqual(["readme.txt"]);
  });

  it("says nothing when staging still matches the archive", async () => {
    const drift = await detectExternalDrift({
      ...base,
      mods: [
        mod({
          id: "clean",
          installationPath: "clean",
          stagingFiles: [{ path: "a.esp", size: 1 }] as never,
        }),
      ],
      config: config({}),
      listArchive: listing(["a.esp"]),
    });
    expect(drift).toEqual([]);
  });

  it("sees through a stripped wrapper directory rather than crying drift", async () => {
    // Vortex drops this leading folder on install because `Textures/` is one of
    // its stop patterns; identical content must not read as "every file added
    // and every file removed".
    const drift = await detectExternalDrift({
      ...base,
      mods: [
        mod({
          id: "wrapped",
          installationPath: "wrapped",
          stagingFiles: [{ path: "Textures/a.dds", size: 1 }] as never,
        }),
      ],
      config: config({}),
      listArchive: listing(["01 Main/Textures/a.dds"]),
    });
    expect(drift).toEqual([]);
  });

  it("catches an archive Vortex installs into the wrong folder — Meridia's grass cache", async () => {
    /**
     * Shipped in Meridia 1.0.23 and reached every player. The tail match read
     * this as two stray readme files, because it assumed Vortex strips every
     * wrapper; it strips none here, since nothing inside is a stop pattern.
     */
    const [drift] = await detectExternalDrift({
      ...base,
      gameId: "skyrimse",
      mods: [
        mod({
          id: "grass",
          name: "Grass_Cache_Default_LOD",
          installationPath: "grass",
          stagingFiles: [
            { path: "Grass/A.cgid", size: 1 },
            { path: "Grass/B.cgid", size: 1 },
          ] as never,
        }),
      ],
      config: config({}),
      listArchive: listing([
        "Grass_Cache_Default/README.txt",
        "Grass_Cache_Default/meta.ini",
        "Grass_Cache_Default/Data/Grass/A.cgid",
        "Grass_Cache_Default/Data/Grass/B.cgid",
      ]),
    });
    expect(drift!.misplaced).toEqual({
      count: 2,
      under: "Grass_Cache_Default/Data/",
      stripped: "",
      example: { staged: "Grass/A.cgid", installed: "Grass_Cache_Default/Data/Grass/A.cgid" },
    });
    // Nothing was added: the files ARE in the archive, just not where the
    // game reads them.
    expect(drift!.added).toEqual([]);
    expect(drift!.removed).toEqual([
      "grass_cache_default/readme.txt",
      "grass_cache_default/meta.ini",
    ]);
  });

  it("does not call a shared basename a wrapper folder", async () => {
    // A root `readme.txt` against the archive's `docs/readme.txt` is two
    // files that happen to share a name — reported as drift both ways, never
    // as the whole mod landing in the wrong folder.
    const [drift] = await detectExternalDrift({
      ...base,
      mods: [
        mod({
          id: "docs",
          installationPath: "docs",
          stagingFiles: [
            { path: "a.esp", size: 1 },
            { path: "readme.txt", size: 1 },
          ] as never,
        }),
      ],
      config: config({}),
      listArchive: listing(["a.esp", "docs/readme.txt"]),
    });
    expect(drift!.misplaced).toBeUndefined();
    expect(drift!.added).toEqual(["readme.txt"]);
    expect(drift!.removed).toEqual(["docs/readme.txt"]);
  });

  it("stays quiet about that same wrapper once a plugin inside lets Vortex strip it", async () => {
    const drift = await detectExternalDrift({
      ...base,
      gameId: "skyrimse",
      mods: [
        mod({
          id: "grass",
          installationPath: "grass",
          stagingFiles: [
            { path: "Grass/A.cgid", size: 1 },
            { path: "Patch.esp", size: 1 },
          ] as never,
        }),
      ],
      config: config({}),
      listArchive: listing(["Wrap/Data/Grass/A.cgid", "Wrap/Data/Patch.esp"]),
    });
    expect(drift).toEqual([]);
  });

  it("does NOT call unselected FOMOD options drift", async () => {
    // Measured on a real profile: the Unofficial AAF Patch archive holds 391
    // files the curator did not select. Reporting those as drift told them to
    // bundle a FOMOD — which would ship one person's choices as a flat archive
    // and skip the installer for everyone else.
    const drift = await detectExternalDrift({
      ...base,
      mods: [
        mod({
          id: "uap",
          installationPath: "uap",
          stagingFiles: [{ path: "chosen.esp", size: 1 }] as never,
        }),
      ],
      config: config({}),
      listArchive: listing([
        "fomod/ModuleConfig.xml",
        "chosen.esp",
        "Optional/not-chosen.esp",
        "Optional/also-not-chosen.esp",
      ]),
    });
    expect(drift).toEqual([]);
  });

  it("still reports ADDED files in a FOMOD, and says the removals went unread", async () => {
    // A script explains a file that never arrived. It cannot explain a file
    // that is there and was never in the archive.
    const [drift] = await detectExternalDrift({
      ...base,
      mods: [
        mod({
          id: "edited",
          installationPath: "edited",
          stagingFiles: [
            { path: "chosen.esp", size: 1 },
            { path: "my-tweak.ini", size: 1 },
          ] as never,
        }),
      ],
      config: config({}),
      listArchive: listing([
        "fomod/ModuleConfig.xml",
        "chosen.esp",
        "Optional/not-chosen.esp",
      ]),
    });
    expect(drift!.added).toEqual(["my-tweak.ini"]);
    expect(drift!.removed).toEqual([]);
    expect(drift!.declaredAlternatives).toBe(true);
  });

  it("finds the script wherever it sits, and is not fooled by case", async () => {
    const drift = await detectExternalDrift({
      ...base,
      mods: [
        mod({
          id: "nested",
          installationPath: "nested",
          stagingFiles: [{ path: "a.esp", size: 1 }] as never,
        }),
      ],
      config: config({}),
      listArchive: listing(["Main/FOMOD/moduleconfig.xml", "a.esp", "b.esp"]),
    });
    expect(drift).toEqual([]);
  });

  it("records whether the curator already ticked bundle", async () => {
    const [drift] = await detectExternalDrift({
      ...base,
      mods: [
        mod({
          id: "settings",
          installationPath: "settings",
          stagingFiles: [{ path: "mine.txt", size: 1 }] as never,
        }),
      ],
      config: config({ settings: { bundled: true } }),
      listArchive: listing(["theirs.txt"]),
    });
    expect(drift!.bundled).toBe(true);
  });
});

describe("describeExternalDrift", () => {
  const drifted = (over: Partial<ExternalDrift> = {}): ExternalDrift => ({
    modId: "settings",
    modName: "Ivy'sPantiesSettings",
    removed: ["a", "b"],
    added: ["PC_README.md"],
    bundled: false,
    mirrored: false,
    declaredAlternatives: false,
    ...over,
  });

  it("tells the curator the user would get the ORIGINAL, and what to do", () => {
    const lines = describeExternalDrift([drifted()]).join(" ");
    expect(lines).toMatch(/ships the ARCHIVE/);
    expect(lines).toMatch(/not your version/);
    expect(lines).toMatch(/Ivy'sPantiesSettings/);
    // BOTH answers are offered, and the difference between them is stated,
    // because it is the one a curator may care about most: bundling takes the
    // author's download away (NS-5) and mirroring does not.
    expect(lines).toMatch(/"mirror"/i);
    expect(lines).toMatch(/"bundle"/i);
    expect(lines).toMatch(/still downloads from the author/i);
  });

  it("stays quiet about mods already flagged for bundling", () => {
    // Their drift is about to ship correctly; nagging would train the curator
    // to ignore the message that matters.
    expect(describeExternalDrift([drifted({ bundled: true })])).toEqual([]);
  });

  it("stays just as quiet about mods already answered MIRROR", () => {
    /**
     * The blind spot this whole warning had: bundling is not the only way the
     * package carries the curator's bytes. Told about a mirrored mod, it said
     * the exact opposite of the truth — "the collection ships the ARCHIVE, so
     * whoever installs it gets the original, not your version" — and then
     * recommended bundling, which a curator may have refused on purpose.
     */
    expect(describeExternalDrift([drifted({ mirrored: true })])).toEqual([]);
  });

  it("explains that a FOMOD's unselected options were not counted", () => {
    // Silence about removals would read as "nothing was removed" — a check
    // that never ran, presented as a clean result.
    const line = describeExternalDrift([
      drifted({ removed: [], declaredAlternatives: true }),
    ]).join(" ");
    expect(line).toMatch(/FOMOD/);
    expect(line).toMatch(/unselected options were not counted/);
    expect(line).not.toMatch(/file\(s\) in the archive are not staged/);
  });

  it("is ONE warning however many mods drifted — the caller counts these", () => {
    // The build page shows `warnings.length`. Returning the headline and each
    // mod's detail as separate entries made one problem read as five, and a
    // build with six things to say announced "10 warnings".
    const many = [
      drifted({ modId: "a", modName: "A" }),
      drifted({ modId: "b", modName: "B" }),
      drifted({ modId: "c", modName: "C" }),
      drifted({ modId: "d", modName: "D" }),
    ];
    const out = describeExternalDrift(many);
    expect(out).toHaveLength(1);
    // ...and the detail is still there, just inside the one entry.
    expect(out[0]!.split("\n")).toHaveLength(5);
    expect(out[0]).toMatch(/"A"/);
    expect(out[0]).toMatch(/"D"/);
  });

  it("says nothing at all when nothing drifted", () => {
    expect(describeExternalDrift([])).toEqual([]);
  });

  const grass = {
    count: 9087,
    under: "Grass_Cache_Default/Data/",
    stripped: "",
    example: { staged: "Grass/A.cgid", installed: "Grass_Cache_Default/Data/Grass/A.cgid" },
  };

  it("names a misplaced mod on its own: where players get it, why, and the fix", () => {
    const out = describeExternalDrift([
      drifted({
        modName: "Grass_Cache_Default_LOD",
        added: [],
        removed: ["grass_cache_default/readme.txt"],
        misplaced: grass,
      }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatch(/installs into the wrong folder for everyone but you/);
    expect(out[0]).toMatch(/9087 of your staged file\(s\) inside "Grass_Cache_Default\/Data\/"/);
    expect(out[0]).toMatch(/players get Grass_Cache_Default\/Data\/Grass\/A\.cgid where you have Grass\/A\.cgid/);
    expect(out[0]).toMatch(/nothing in this archive does/);
    expect(out[0]).toMatch(/Re-pack the archive/);
    // Not ALSO reported as a curator's edit shipping as the original: the
    // readme it dropped is noise next to a mod the game cannot see.
    expect(out[0]).not.toMatch(/ships the ARCHIVE/);
  });

  it("says what Vortex does strip when a stop pattern matched elsewhere in the archive", () => {
    const [line] = describeExternalDrift([
      drifted({ misplaced: { ...grass, stripped: "Main", under: "Extra/" } }),
    ]);
    expect(line).toMatch(/Vortex removes only "Main\/" from the front/);
    expect(line).not.toMatch(/nothing in this archive does/);
  });

  it("stays quiet about a misplaced mod already answered mirror or bundle", () => {
    // Both answers ship the curator's staging folder, so the layout is theirs.
    expect(describeExternalDrift([drifted({ misplaced: grass, mirrored: true })])).toEqual([]);
    expect(describeExternalDrift([drifted({ misplaced: grass, bundled: true })])).toEqual([]);
  });
});

describe("measureBundledMods", () => {
  const workDir = (): string => path.join(staging, ".repack");

  it("WARNS about a large bundle without refusing to pack it", async () => {
    // The curator chose to ship this mod. Refusing would be the tool deciding
    // what they are allowed to publish; the size is their business, and all
    // this owes them is a heads-up about the download and the wait.
    const dir = path.join(staging, "huge");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "big.bin"), Buffer.alloc(4096));

    const out = await measureBundledMods({
      state: {} as never,
      gameId: "fallout4",
      mods: [mod({ id: "huge", name: "Huge", installationPath: "huge" })],
      config: config({ huge: { bundled: true } }),
      workDir: workDir(),
      isExternal: () => true,
      options: { warnBytes: 1024 },
    });
    expect(out.bundles).toHaveLength(1);
    expect(out.warnings[0]).toMatch(/will be at least that large/);
    expect(out.warnings[0]).toMatch(/fine if you meant it/);
    expect(out.warnings[0]).not.toMatch(/NOT bundled/);
  });

  it("says nothing about size when the bundle is small", async () => {
    const dir = path.join(staging, "small");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "a.txt"), "x");

    const out = await measureBundledMods({
      state: {} as never,
      gameId: "fallout4",
      mods: [mod({ id: "small", name: "Small", installationPath: "small" })],
      config: config({ small: { bundled: true } }),
      workDir: workDir(),
      isExternal: () => true,
      options: { warnBytes: 1024 * 1024 },
    });
    expect(out.bundles).toHaveLength(1);
    expect(out.warnings.filter((w) => w.includes("at least that large"))).toEqual([]);
  });

  it("ignores mods the curator did not flag", async () => {
    const out = await measureBundledMods({
      state: {} as never,
      gameId: "fallout4",
      mods: [mod({ id: "plain", installationPath: "plain" })],
      config: config({}),
      workDir: workDir(),
      isExternal: () => true,
    });
    expect(out.bundles).toEqual([]);
    expect(out.warnings).toEqual([]);
    expect(out.failed).toEqual([]);
  });

  it("refuses a mod Vortex records no staging folder for, by id and with the reason", async () => {
    // A warning alone was the hole: the mod shipped nothing, nobody downstream
    // knew it by id, and the build carried on as if it had been packed.
    const out = await measureBundledMods({
      state: {} as never,
      gameId: "fallout4",
      mods: [mod({ id: "nopath", name: "No Path" })],
      config: config({ nopath: { bundled: true } }),
      workDir: workDir(),
      isExternal: () => true,
    });
    expect(out.bundles).toEqual([]);
    expect(out.failed).toEqual([
      { modId: "nopath", modName: "No Path", reason: expect.stringMatching(/no staging folder/) },
    ]);
  });

  it("refuses a mod whose staging folder holds nothing to ship", async () => {
    fs.mkdirSync(path.join(staging, "hollow"), { recursive: true });
    const out = await measureBundledMods({
      state: {} as never,
      gameId: "fallout4",
      mods: [mod({ id: "hollow", name: "Hollow", installationPath: "hollow" })],
      config: config({ hollow: { bundled: true } }),
      workDir: workDir(),
      isExternal: () => true,
    });
    expect(out.bundles).toEqual([]);
    expect(out.failed[0]!.reason).toMatch(/holds no files to ship/);
  });
});
