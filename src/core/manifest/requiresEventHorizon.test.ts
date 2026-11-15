/**
 * A curator's minimum Event Horizon, refused up front (owner, 11-15).
 *
 * Ivy Rev 29 needed EH 0.2.126's fixes (Overture/Chemistry refused on Rapport,
 * DLC-gated plugins switched off). "Bake the EH version requirement into the
 * collection bundle": the config's `minEventHorizon` becomes
 * `package.requiresEventHorizon`, and the package is schema 3.
 *
 *  - EH 0.2.128 on: refuses a package whose minimum is newer than itself,
 *    before anything is believed, with an "update Event Horizon" sentence.
 *  - EH up to 0.2.127: refuses schema 3 at the same gate ("Unsupported
 *    schemaVersion 3 ... Update the Event Horizon extension").
 */
import { afterEach, describe, expect, it } from "vitest";

import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { buildManifest, type BuildManifestInput } from "./buildManifest";
import { loadOrCreateCollectionConfig, saveCollectionConfig } from "./collectionConfig";
import { _setRunningEventHorizonForTest, ParseManifestError, parseManifest } from "./parseManifest";
import { EXTENSION_VERSION } from "../../ui/version";

const raw = (schemaVersion: number, requires?: string): string =>
  JSON.stringify({
    schemaVersion,
    package: {
      id: "11111111-2222-4333-8444-555555555555",
      name: "Ivy",
      version: "1.0.60",
      createdAt: "1970-01-01T00:00:00.000Z",
      verificationLevel: "thorough",
      author: "A Curator",
      strictMissingMods: false,
      ...(requires !== undefined ? { requiresEventHorizon: { version: requires } } : {}),
    },
    game: { id: "fallout4", version: "1.10.163.0", versionPolicy: "exact" },
    vortex: { version: "1.13.7", deploymentMethod: "hardlink", requiredExtensions: [] },
    iniTweaks: [],
    externalDependencies: [],
    mods: [],
    rules: [],
    plugins: { order: [] },
  });

const refusal = (fn: () => unknown): string => {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(ParseManifestError);
    return (err as ParseManifestError).message;
  }
  throw new Error("expected a refusal");
};

afterEach(() => _setRunningEventHorizonForTest(EXTENSION_VERSION));

describe("a collection's minimum Event Horizon", () => {
  it("installs on an Event Horizon at or past the minimum, and keeps it (schema 3)", () => {
    _setRunningEventHorizonForTest("0.2.128");
    const m = parseManifest(raw(3, "0.2.126")).manifest;
    expect(m.package.requiresEventHorizon).toEqual({ version: "0.2.126" });
    expect(m.schemaVersion).toBe(3);
  });

  it("refuses an older one up front, saying what to do and that nothing changed", () => {
    _setRunningEventHorizonForTest("0.2.125");
    const msg = refusal(() => parseManifest(raw(3, "0.2.126")));
    expect(msg).toContain('"Ivy" needs Event Horizon 0.2.126 or newer, and you have 0.2.125');
    expect(msg).toContain("Update Event Horizon first");
    expect(msg).toContain("Nothing was installed or changed");
  });

  it("compares by number: 0.2.130 is newer than 0.2.126", () => {
    _setRunningEventHorizonForTest("0.2.130");
    expect(parseManifest(raw(3, "0.2.126")).manifest.package.requiresEventHorizon?.version).toBe("0.2.126");
  });

  it("a package without a minimum stays schema 2, so every Event Horizon still reads it", () => {
    const m = parseManifest(raw(2)).manifest;
    expect(m.schemaVersion).toBe(2);
    expect(m.package.requiresEventHorizon).toBeUndefined();
  });

  it("still refuses a schema it does not know", () => {
    expect(refusal(() => parseManifest(raw(4)))).toContain("Unsupported schemaVersion 4");
  });
});

describe("the curator's config key", () => {
  const load = async (extra: Record<string, unknown>) => {
    const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "eh-mineh-"));
    fs.writeFileSync(
      path.join(configDir, "ivy.json"),
      JSON.stringify({ schemaVersion: 1, packageId: "11111111-2222-4333-8444-555555555555", externalMods: {}, ...extra }),
    );
    return (await loadOrCreateCollectionConfig({ configDir, slug: "ivy" })).config;
  };

  it("accepts a dotted version and refuses anything else", async () => {
    expect((await load({ minEventHorizon: " 0.2.126 " })).minEventHorizon).toBe("0.2.126");
    await expect(load({ minEventHorizon: "latest" })).rejects.toThrow(/minEventHorizon/);
    await expect(load({ minEventHorizon: 126 })).rejects.toThrow(/minEventHorizon/);
  });
});

describe("the build writes it, and a package round-trips", () => {
  const build = (minEventHorizon?: string) =>
    buildManifest({
      snapshot: { gameId: "fallout4", mods: [] },
      package: {
        id: "00000000-0000-4000-8000-000000000000",
        name: "Ivy",
        version: "1.0.60",
        author: "a",
        verificationLevel: "thorough",
        ...(minEventHorizon !== undefined ? { minEventHorizon } : {}),
      },
      game: { version: "1.10.163.0", versionPolicy: "exact" },
      vortex: { version: "2.6.0", deploymentMethod: "hardlink" },
      externalMods: {},
    } as unknown as BuildManifestInput).manifest;

  it("a minimum makes schema 3 with the field; none leaves schema 2", () => {
    const withMin = build("0.2.126");
    expect(withMin.schemaVersion).toBe(3);
    expect(withMin.package.requiresEventHorizon).toEqual({ version: "0.2.126" });
    const without = build();
    expect(without.schemaVersion).toBe(2);
    expect(without.package.requiresEventHorizon).toBeUndefined();
  });

  it("what the build writes, the parser reads back", () => {
    _setRunningEventHorizonForTest("0.2.128");
    const back = parseManifest(JSON.stringify(build("0.2.126"))).manifest;
    expect(back.schemaVersion).toBe(3);
    expect(back.package.requiresEventHorizon).toEqual({ version: "0.2.126" });
  });

  it("the key survives the save the build does after every build", async () => {
    const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "eh-mineh-save-"));
    fs.writeFileSync(
      path.join(configDir, "ivy.json"),
      JSON.stringify({ schemaVersion: 1, packageId: "11111111-2222-4333-8444-555555555555", externalMods: {}, minEventHorizon: "0.2.126" }),
    );
    const { config } = await loadOrCreateCollectionConfig({ configDir, slug: "ivy" });
    await saveCollectionConfig({ configDir, slug: "ivy", config: { ...config, lastBuiltVersion: "1.0.60" } });
    expect((await loadOrCreateCollectionConfig({ configDir, slug: "ivy" })).config.minEventHorizon).toBe("0.2.126");
  });
});
