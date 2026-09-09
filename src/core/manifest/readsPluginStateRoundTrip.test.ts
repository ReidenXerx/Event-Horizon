/**
 * `readsPluginState` survives the format, and is sourced onto the mod at all.
 *
 * ─── WHY BOTH HALVES ────────────────────────────────────────────────────────
 * This project has shipped a write-only manifest field five times —
 * `state.postProcessed`, `game.store`, `gameIniApplication`,
 * `fomodReplayMode`, and `plugins.order[].light`, which was written into every
 * package for the whole life of the feature and dropped by the parser on read.
 * The registry meant to prevent that could not see one level down, which is
 * why `MOD_INSTALL_SPEC_FATES` now exists alongside this test.
 *
 * A field that decides WHICH EPOCH a mod installs in has a second way to be
 * inert: it can round-trip perfectly and never be populated, because nothing
 * copies the self-check's finding onto the mod. So this checks the write, the
 * read, and the source.
 */
import * as fs from "fs";
import * as path from "path";

import { describe, expect, it } from "vitest";

import { parseManifest } from "./parseManifest";
import { MOD_INSTALL_SPEC_FATES } from "./manifestFieldFates";

/** A minimal manifest that parses, with one mod we can vary. */
const manifestWith = (install: Record<string, unknown>): string =>
  JSON.stringify({
    schemaVersion: 1,
    package: {
      id: "11111111-2222-4333-8444-555555555555",
      name: "Test Collection",
      version: "1.0.0",
      createdAt: "1970-01-01T00:00:00.000Z",
      verificationLevel: "thorough",
      author: "A Curator",
      strictMissingMods: false,
    },
    game: {
      id: "fallout4",
      version: "1.10.163.0",
      versionPolicy: "exact",
    },
    vortex: {
      version: "1.13.7",
      deploymentMethod: "hardlink",
      requiredExtensions: [],
    },
    iniTweaks: [],
    externalDependencies: [],
    mods: [
      {
        compareKey: "nexus:100:200",
        name: "A Mod",
        source: {
          kind: "nexus",
          modId: 100,
          fileId: 200,
          gameDomain: "fallout4",
          archiveName: "a-mod.7z",
          sha256: "a".repeat(64),
        },
        install,
        state: { enabled: true, installOrder: 0, deploymentPriority: 0 },
      },
    ],
    rules: [],
    plugins: { order: [] },
  });

const firstModInstall = (raw: string): Record<string, unknown> =>
  parseManifest(raw).manifest.mods[0]!.install as unknown as Record<
    string,
    unknown
  >;

describe("readsPluginState reaches the user side", () => {
  it("survives a real parse", () => {
    const install = firstModInstall(
      manifestWith({
        fomodSelections: [],
        readsPluginState: ["aaf.esm", "aaf.esp"],
      }),
    );
    expect(install.readsPluginState).toEqual(["aaf.esm", "aaf.esp"]);
  });

  it("is absent for a mod that names nothing", () => {
    // Presence is the signal. A field on every entry of a 950-mod manifest is
    // 950 lines saying nothing, and an empty array would still be truthy to a
    // careless reader.
    const install = firstModInstall(manifestWith({ fomodSelections: [] }));
    expect("readsPluginState" in install).toBe(false);
  });

  it("drops an entry that is not a plugin filename", () => {
    /**
     * It decides which epoch a mod installs in. A loose-file dependency is
     * satisfied by extraction rather than activation, so deferring a mod for
     * one would buy nothing — and a non-string would reach the installer's
     * comparison and quietly match nothing.
     */
    const install = firstModInstall(
      manifestWith({
        fomodSelections: [],
        readsPluginState: ["aaf.esm", "Scripts/foo.pex", 42, "", null],
      }),
    );
    expect(install.readsPluginState).toEqual(["aaf.esm"]);
  });

  it("drops the field entirely when nothing survives the filter", () => {
    const install = firstModInstall(
      manifestWith({
        fomodSelections: [],
        readsPluginState: ["Scripts/foo.pex"],
      }),
    );
    expect("readsPluginState" in install).toBe(false);
  });

  it("has a declared fate, which is what makes it non-optional to read it", () => {
    /**
     * `MOD_INSTALL_SPEC_FATES` is `Required<ModInstallSpec>`, so a field added
     * to the type without an entry here is a COMPILE error rather than a bug
     * report from a stranger. This table did not exist until this change —
     * `EhcollManifest`, `ModInstallState` and `EhcollPluginEntry` each had one
     * and the install spec did not, which is one of the two levels `light`
     * slipped through.
     */
    expect(MOD_INSTALL_SPEC_FATES.readsPluginState).toEqual({
      kind: "applied",
      by: "core/installer/runInstall.ts",
    });
  });
});

/**
 * ──────────────────────────────────────────────────────────────────────
 * AND THE SECOND FIELD, BECAUSE ABSENT MEANT TWO THINGS
 *
 * `readsPluginState` absent means either "the installer was read and asks the
 * game nothing" — 845 of 963 mods on the real collection have no FOMOD script
 * at all — or "the archive could not be opened, so nothing is known". The
 * epoch planner read absent as the first, which is right 845 times and wrong
 * for exactly the mods most likely to matter.
 *
 * `installerUnexamined` was added to say the second out loud, and then shipped
 * INERT: it was computed in `selfCheckMod`, summarised in `runSelfChecks`, and
 * dropped by the overlay in `engine.ts` that carries only the answers. It was
 * a build-time log line, never a thing the package knew — the seventh
 * write-only field in this project, introduced while fixing the sixth.
 *
 * So this checks the same three things the field above needs: it survives the
 * format, it is sourced onto the mod, and something reads it.
 * ──────────────────────────────────────────────────────────────────────
 */
describe("installerUnexamined reaches the user side", () => {
  it("survives a real parse", () => {
    const install = firstModInstall(
      manifestWith({ fomodSelections: [], installerUnexamined: true }),
    );
    expect(install.installerUnexamined).toBe(true);
  });

  it("is absent for a mod that WAS examined", () => {
    const install = firstModInstall(manifestWith({ fomodSelections: [] }));
    expect("installerUnexamined" in install).toBe(false);
  });

  it("accepts only `true`, never a truthy stand-in", () => {
    /**
     * It is a claim about what the build could not do. A `1` or a `"yes"`
     * from a hand-edited or older package must read as the absence it
     * already is rather than becoming an assertion nobody made.
     */
    for (const junk of [1, "true", {}, [], "yes"]) {
      const install = firstModInstall(
        manifestWith({ fomodSelections: [], installerUnexamined: junk }),
      );
      expect("installerUnexamined" in install).toBe(false);
    }
  });

  it("has a declared fate naming a reader that exists", () => {
    // `applied`, not `recorded-only`: something really does read it, and the
    // registry's own test opens that file and proves it. Claiming
    // `recorded-only` would be the more modest and less honest entry.
    expect(MOD_INSTALL_SPEC_FATES.installerUnexamined).toEqual({
      kind: "applied",
      by: "core/resolver/installEpochs.ts",
    });
  });
});

/**
 * ──────────────────────────────────────────────────────────────────────
 * THE THIRD HALF: IS IT EVER PUT ON THE MOD?
 *
 * The file above says it checks "the write, the read, and the source" — and it
 * checked the first two. The source half was never written, and that is the
 * hole `installerUnexamined` fell through: the field was computed by
 * `selfCheckMod`, summarised by `runSelfChecks`, given a manifest type, a
 * parser branch and a declared fate — and dropped by the ONE overlay in
 * `engine.ts` that copies self-check findings onto the mods. Every layer was
 * correct in isolation and the field was inert end to end.
 *
 * A round-trip test cannot see that: the field round-trips perfectly when
 * nothing ever sets it. Only the overlay can, so the overlay is what this
 * reads. Source text rather than behaviour because `engine.ts` is the build
 * wizard and cannot be entered from a unit test — recorded as FIXTURE-DEBT,
 * not as a claim that this is the stronger kind of test.
 * ──────────────────────────────────────────────────────────────────────
 */
describe("the build actually sources both fields onto the mod", () => {
  const engine = fs.readFileSync(
    path.join(__dirname, "..", "..", "ui", "pages", "build", "engine.ts"),
    "utf8",
  );

  it("copies readsPluginState from the self-check onto the mods", () => {
    expect(engine).toContain("readsPluginState: pluginStateReaders.get(m.id)!");
  });

  it("copies installerUnexamined too — the one that shipped inert", () => {
    expect(engine).toContain("r.installerUnexamined === true");
    expect(engine).toContain("installerUnexamined: true");
  });

  it("reads BOTH off the self-check reports, not off something else", () => {
    /**
     * Guards the specific shape of the bug: an overlay that filters only on
     * `readsPluginState` carries only that, however many other fields the
     * report has. Both filters have to exist, or the second field is a type
     * with no source again.
     */
    expect(engine).toContain("selfCheck.reports");
    const overlay = engine.slice(
      engine.indexOf("const pluginStateReaders"),
      engine.indexOf("const pluginStateReaders") + 2500,
    );
    expect(overlay).toContain("installerUnexamined");
  });
});
