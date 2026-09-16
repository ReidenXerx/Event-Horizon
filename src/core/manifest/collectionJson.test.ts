/**
 * An Event Horizon package carries Vortex's collection marker beside its own
 * manifest, so that a package published as a Nexus collection opens in Event
 * Horizon when someone presses Install on the website.
 *
 * Two halves live in two places — the packager writes the marker, the
 * installer claim reads it — and nothing but a test holds them together. The
 * one test here that matters most is the round trip: a package this build
 * produces must be claimed by this build's own interceptor. If either half
 * drifts, that is the test that fails, instead of a user pressing Install and
 * getting Vortex's bulk installer.
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { testSupported } from "../installer/collectionIntercept";
import { packageEhcoll } from "./packageZip";
import { readEhcoll } from "./readEhcoll";
import { buildStoredZip } from "./storedZip.testutil";
import type { EhcollManifest, SupportedGameId } from "../../types/ehcoll";
import type { SevenZipApi } from "./sevenZip";

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "eh-colljson-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

/** Every file under `root`, as archive entries: "/"-separated relative names. */
function walk(root: string, rel = ""): Array<{ name: string; body: Buffer }> {
  const out: Array<{ name: string; body: Buffer }> = [];
  for (const entry of fs.readdirSync(path.join(root, rel), { withFileTypes: true })) {
    const childRel = rel === "" ? entry.name : `${rel}/${entry.name}`;
    if (entry.isDirectory()) out.push(...walk(root, childRel));
    else out.push({ name: childRel, body: fs.readFileSync(path.join(root, childRel)) });
  }
  return out;
}

/** A 7-Zip that really zips the staging folder, so the output can be read back. */
const zippingSevenZip = (): SevenZipApi =>
  ({
    add: async (archive: string, sources: readonly string[]) => {
      fs.writeFileSync(archive, buildStoredZip(walk(path.dirname(sources[0]!))));
      return { code: 0 };
    },
    list: async () => ({}),
    extractFull: async () => ({ code: 0 }),
  }) as unknown as SevenZipApi;

const manifestFor = (gameId: SupportedGameId, version: string): EhcollManifest =>
  ({
    schemaVersion: 2,
    package: {
      id: "11111111-2222-4333-8444-555555555555",
      name: "Ivy's Panties",
      version: "1.0.29",
      author: "DuduPhudu",
      createdAt: "2026-09-16T00:00:00.000Z",
      strictMissingMods: false,
      verificationLevel: "thorough",
    },
    game: { id: gameId, version, versionPolicy: "exact" },
    vortex: { version: "1.9.0", deploymentMethod: "hardlink", requiredExtensions: [] },
    mods: [],
    rules: [],
    fileOverrides: [],
    plugins: { order: [], enabled: [] },
    loadOrder: [],
    iniTweaks: [],
    externalDependencies: [],
    userlist: { plugins: [], groups: [] },
  }) as unknown as EhcollManifest;

/** Build a real package and keep its staging folder, which IS the archive's contents. */
async function build(
  gameId: SupportedGameId = "fallout4",
  version = "1.10.163.0",
): Promise<{ stagingDir: string; outputPath: string }> {
  const stagingDir = path.join(dir, "staging");
  const outputPath = path.join(dir, "out.zip");
  await packageEhcoll({
    manifest: manifestFor(gameId, version),
    bundles: [],
    outputPath,
    sevenZip: zippingSevenZip(),
    stagingDir,
    cleanupOnSuccess: false,
  });
  return { stagingDir, outputPath };
}

const readCollectionJson = (stagingDir: string): Record<string, any> =>
  JSON.parse(fs.readFileSync(path.join(stagingDir, "collection.json"), "utf8"));

describe("the collection marker a package carries", () => {
  it("writes collection.json at the archive root, beside the manifest", async () => {
    const { stagingDir } = await build();
    const root = walk(stagingDir)
      .map((e) => e.name)
      .filter((n) => !n.includes("/"));
    expect(root).toContain("collection.json");
    expect(root).toContain("manifest.json");
  });

  it("carries exactly the fields Vortex's validator requires", async () => {
    // Read from Vortex's own schema: the collection needs info, mods and
    // modRules; info needs author, authorUrl, name, description, domainName.
    // A missing one is a "Collection validation mismatch" notification.
    const c = readCollectionJson((await build()).stagingDir);
    expect(Object.keys(c).sort()).toEqual(
      expect.arrayContaining(["info", "modRules", "mods"]),
    );
    for (const field of ["author", "authorUrl", "name", "description", "domainName"]) {
      expect(c.info).toHaveProperty(field);
    }
    expect(c.info.author).toBe("DuduPhudu");
    expect(c.info.name).toBe("Ivy's Panties");
  });

  it("lists no mods, so Vortex alone can never bulk-install the collection", async () => {
    /**
     * Not an omission. A user without Event Horizon who installs this gets
     * Vortex's collection installer, and Vortex loses extracted files when it
     * installs in bulk. Listing the real mods would hand that user exactly the
     * failure this project exists to prevent.
     */
    const c = readCollectionJson((await build()).stagingDir);
    expect(c.mods).toEqual([]);
    expect(c.modRules).toEqual([]);
  });

  it("names the Nexus domain, not the Vortex game id", async () => {
    // skyrimse is Vortex's id; the site and its API say skyrimspecialedition.
    // Writing the wrong one is invisible until something looks the collection up.
    const skyrim = readCollectionJson((await build("skyrimse", "1.6.1170.0")).stagingDir);
    expect(skyrim.info.domainName).toBe("skyrimspecialedition");
  });

  it("keeps fallout4 as fallout4, where the two names happen to agree", async () => {
    const fo4 = readCollectionJson((await build()).stagingDir);
    expect(fo4.info.domainName).toBe("fallout4");
  });

  it("tells a user without Event Horizon what to do, where Vortex will show it", async () => {
    // Vortex's install dialog shows installInstructions only when a collection
    // HAS mods; with none it prints its own default. So the message must also
    // be in the description, which Vortex does show.
    const c = readCollectionJson((await build()).stagingDir);
    expect(c.info.description).toMatch(/Event Horizon/);
    expect(c.info.description).toMatch(/nexusmods\.com\/site\/mods\/2235/);
    expect(c.info.installInstructions).toBe(c.info.description);
  });
});

describe("the two halves agree", () => {
  it("a package this build produces is claimed by this build's own installer", async () => {
    /**
     * The contract, end to end. The packager writes the marker; the
     * interceptor decides by it. If someone renames the file, moves it into a
     * folder, or narrows the claim, a published collection silently stops
     * opening in Event Horizon and starts installing through Vortex — with
     * every test on either side still passing on its own.
     */
    const { stagingDir } = await build();
    const archiveFiles = walk(stagingDir).map((e) => e.name);
    const verdict = await testSupported(archiveFiles, "fallout4");
    expect(verdict.supported).toBe(true);
  });

  it("Event Horizon still reads its own package, with no warning about the marker", async () => {
    // The reader tolerates unknown root files, but only by accident of a
    // comment. Recognised explicitly, the marker must not cost every package a
    // warning about a file we put there on purpose.
    const { outputPath } = await build();
    const read = await readEhcoll(outputPath);
    expect(read.manifest.package.name).toBe("Ivy's Panties");
    expect(read.warnings.some((w) => w.includes("collection.json"))).toBe(false);
  });
});
