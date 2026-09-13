/**
 * A package carries a bundled mod as its loose files, and no archive at all.
 *
 * Pinned against the real packager with a 7-Zip stand-in that really zips the
 * folder it is handed, so the finished package is checked the way a user's
 * install reads it:
 *  - bundled files land at bundled/<sha256>/<path>, byte for byte, and the
 *    finished package reproduces the identity the manifest names;
 *  - 7-Zip is told to flag every non-ASCII name as UTF-8, and a package whose
 *    names it left in the local code page, or that lacks a file, refuses the
 *    build by name;
 *  - an archive among a bundled or a mirrored mod's files refuses the build,
 *    naming the mod, the file and the format, before 7-Zip is ever asked;
 *  - files changed after the build measured them refuse the build by name, and
 *    so do a folder emptied since, a file that vanished, or one no longer
 *    readable;
 *  - a rebuild that is refused or cancelled leaves the package already at the
 *    output path as it was, and a cancel is reported as one.
 */
import * as crypto from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildZip } from "../environment/fixtures.testutil";
import { bundleFilesFromListing, listBundleFolder, writeBundleZip } from "./bundleZip";
import { packageEhcoll, PackageEhcollError } from "./packageZip";
import { buildStoredZip } from "./storedZip.testutil";
import type { EhcollManifest } from "../../types/ehcoll";
import type { SevenZipApi } from "./sevenZip";

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "eh-pkgbundle-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

/** Every file under `root`: its "/" path relative to `root`, and its bytes. */
const filesUnder = (root: string): Array<{ name: string; data: Buffer }> => {
  const out: Array<{ name: string; data: Buffer }> = [];
  const walk = (d: string): void => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full);
      else out.push({ name: path.relative(root, full).split(path.sep).join("/"), data: fs.readFileSync(full) });
    }
  };
  walk(root);
  return out;
};

type FakeSevenZip = SevenZipApi & { adds: number; raw: readonly string[] };

/**
 * A 7-Zip that really zips the staging folder it is handed.
 *
 * `utf8Names: false` leaves names unflagged — what 7-Zip does, without
 * -mcu=on, to a name that fits the machine's code page. `drop` leaves out the
 * files whose path ends with it, as 7-Zip does with a file it cannot open.
 */
function zippingSevenZip(options: { utf8Names?: boolean; drop?: string } = {}): FakeSevenZip {
  const fake = {
    adds: 0,
    raw: [] as readonly string[],
    add: async (archive: string, sources: readonly string[], opts: { raw?: readonly string[] } = {}) => {
      fake.adds += 1;
      fake.raw = opts.raw ?? [];
      const entries = filesUnder(path.dirname(sources[0]!)).filter(
        (e) => options.drop === undefined || !e.name.endsWith(options.drop),
      );
      fs.writeFileSync(
        archive,
        options.utf8Names === false
          ? buildStoredZip(entries.map((e) => ({ name: e.name, body: e.data })))
          : buildZip(entries, "deflate"),
      );
      return { code: 0 };
    },
    list: async () => ({}),
    extractFull: async () => ({ code: 0 }),
  };
  return fake as unknown as FakeSevenZip;
}

const put = (root: string, rel: string, body: string | Buffer): string => {
  const full = path.join(root, ...rel.split("/"));
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, body);
  return full;
};

/** Every file under `root`, as a relative "/" path → its text. */
const tree = (root: string): Record<string, string> =>
  Object.fromEntries(filesUnder(root).map((f) => [f.name, f.data.toString("utf8")]));

const identityOf = async (root: string): Promise<string> =>
  (await writeBundleZip(await bundleFilesFromListing(await listBundleFolder(root)), undefined)).sha256;

const manifestWith = (mods: unknown[]): EhcollManifest =>
  ({
    schemaVersion: 2,
    package: {
      id: "11111111-2222-4333-8444-555555555555",
      name: "Test",
      version: "1.0.0",
      author: "someone",
      createdAt: "2026-01-01T00:00:00.000Z",
      strictMissingMods: false,
      verificationLevel: "thorough",
    },
    game: { id: "fallout4", version: "1.10.163.0", versionPolicy: "exact" },
    vortex: { version: "1.9.0", deploymentMethod: "hardlink", requiredExtensions: [] },
    mods,
    rules: [],
    fileOverrides: [],
    plugins: { order: [], enabled: [] },
    loadOrder: [],
    iniTweaks: [],
    externalDependencies: [],
    userlist: { plugins: [], groups: [] },
  }) as unknown as EhcollManifest;

const bundledMod = (name: string, sha: string): unknown => ({
  compareKey: `external:staging:${name}`,
  name,
  source: { kind: "external", bundled: true, sha256: sha, expectedFilename: `${name}.zip` },
  state: {},
});

/** Package one bundled mod made of `files`, with this 7-Zip; the promise rejects on refusal. */
async function packageOne(
  files: Record<string, string | Buffer>,
  sevenZip: FakeSevenZip,
  extra: { stagingDir?: string } = {},
): Promise<{ sha: string; outputPath: string }> {
  const mod = path.join(dir, "staging", "settings");
  for (const [rel, body] of Object.entries(files)) put(mod, rel, body);
  const sha = await identityOf(mod);
  const outputPath = path.join(dir, "out.ehcoll");
  await packageEhcoll({
    manifest: manifestWith([bundledMod("Settings", sha)]),
    bundles: [{ rootDir: mod, sha256: sha, modName: "Settings" }],
    outputPath,
    sevenZip,
    ...(extra.stagingDir !== undefined ? { stagingDir: extra.stagingDir, cleanupOnSuccess: false } : {}),
  });
  return { sha, outputPath };
}

const SEVEN_Z_HEAD = Buffer.from([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c, 0x00, 0x04]);
const ZIP_HEAD = Buffer.from([0x50, 0x4b, 0x03, 0x04]);

describe("packaging a bundled mod", () => {
  it("ships its files loose under bundled/<sha256>/, and the package reproduces the identity the manifest names", async () => {
    const stagingDir = path.join(dir, "pack");
    const sevenZip = zippingSevenZip();
    const { sha } = await packageOne(
      {
        "F4SE/Plugins/BakaFramework.toml": "[toml]",
        "Текстуры/файл.dds": "cyrillic",
        // Written by a runtime, not shipped by the mod: not part of a bundle.
        "Thumbs.db": "explorer",
      },
      sevenZip,
      { stagingDir },
    );

    expect(sevenZip.adds).toBe(1);
    expect(fs.readdirSync(path.join(stagingDir, "bundled"))).toEqual([sha]);
    const shipped = path.join(stagingDir, "bundled", sha);
    expect(tree(shipped)).toEqual({
      "F4SE/Plugins/BakaFramework.toml": "[toml]",
      "Текстуры/файл.dds": "cyrillic",
    });
    expect(await identityOf(shipped)).toBe(sha);
  });

  it("tells 7-Zip to store every non-ASCII name as flagged UTF-8", async () => {
    // Left to its defaults 7-Zip keeps "Cópia" in the machine's code page,
    // unflagged, and no install can read it back as the same path.
    const sevenZip = zippingSevenZip();
    await packageOne({ "Cópia.txt": "copy" }, sevenZip);
    expect(sevenZip.raw).toContain("-tzip");
    expect(sevenZip.raw).toContain("-mcu=on");
  });

  it("refuses a package whose names 7-Zip left in the local code page", async () => {
    const err = await packageOne({ "Cópia.txt": "copy", "plain.txt": "ascii" }, zippingSevenZip({ utf8Names: false })).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(PackageEhcollError);
    const message = (err as Error).message;
    expect(message).toMatch(/"Settings" cannot be read back out of the package 7-Zip wrote/);
    expect(message).toMatch(/does not say how its name is encoded/);
    expect(fs.existsSync(path.join(dir, "out.ehcoll"))).toBe(false);
  });

  it("refuses a package 7-Zip wrote without one of the mod's files, and names it", async () => {
    await expect(
      packageOne({ "a.ini": "[a]", "b.ini": "[b]" }, zippingSevenZip({ drop: "b.ini" })),
    ).rejects.toThrow(/does not reproduce "Settings"[\s\S]*missing from the package: b\.ini/);
  });

  it("refuses an archive among a bundled mod's files, naming mod, file and format", async () => {
    const sevenZip = zippingSevenZip();
    const err = await packageOne(
      {
        "patch.esp": "TES4",
        // Named like anything else: the signature decides, not the extension.
        "optional/Extras.bin": Buffer.concat([SEVEN_Z_HEAD, Buffer.from("payload")]),
      },
      sevenZip,
    ).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(PackageEhcollError);
    const message = (err as Error).message;
    expect(message).toMatch(/^A file this collection would ship is an archive/);
    expect(message).toMatch(/Nexus Mods quarantines any upload with an archive inside it/);
    expect(message).toContain(`"Settings": optional/Extras.bin (7z)`);
    expect(message).not.toContain("patch.esp");
    expect(sevenZip.adds).toBe(0);
    expect(fs.existsSync(path.join(dir, "out.ehcoll"))).toBe(false);
  });

  it("refuses an archive among a mirrored mod's files too, and lists every offender", async () => {
    const docs = path.join(dir, "staging", "docs");
    const docx = put(docs, "Readme.docx", Buffer.concat([ZIP_HEAD, Buffer.from("word")]));
    const gz = put(docs, "notes.gz", Buffer.from([0x1f, 0x8b, 0x08, 0x00, 0x01]));
    const plain = put(docs, "plain.txt", "just text");
    const mirrored = [docx, gz, plain].map((sourcePath) => ({
      sourcePath,
      sha256: crypto.createHash("sha256").update(fs.readFileSync(sourcePath)).digest("hex"),
      modName: "Docs",
    }));
    const manifest = manifestWith([
      {
        compareKey: "external:docs",
        name: "Docs",
        source: { kind: "external", bundled: false, expectedFilename: "docs.zip" },
        state: {
          mirrored: true,
          stagingFiles: mirrored.map((f) => ({
            path: path.basename(f.sourcePath),
            size: fs.statSync(f.sourcePath).size,
            sha256: f.sha256,
          })),
        },
      },
    ]);

    const err = await packageEhcoll({
      manifest,
      bundles: [],
      mirrorFiles: mirrored,
      outputPath: path.join(dir, "out.ehcoll"),
      sevenZip: zippingSevenZip(),
    }).catch((e: unknown) => e);

    const message = (err as Error).message;
    expect(message).toMatch(/^2 files this collection would ship are archives/);
    expect(message).toContain(`"Docs": ${docx} (zip)`);
    expect(message).toContain(`"Docs": ${gz} (gzip)`);
    expect(message).not.toContain(plain);
  });

  it("refuses files that changed after the build measured them, and says how to get past it", async () => {
    const mod = path.join(dir, "staging", "settings");
    put(mod, "a.ini", "before");
    const sha = await identityOf(mod);
    put(mod, "a.ini", "after!");

    await expect(
      packageEhcoll({
        manifest: manifestWith([bundledMod("Settings", sha)]),
        bundles: [{ rootDir: mod, sha256: sha, modName: "Settings" }],
        outputPath: path.join(dir, "out.ehcoll"),
        sevenZip: zippingSevenZip(),
      }),
    ).rejects.toThrow(
      /"Settings": its files changed after this build measured them[\s\S]*tick "Re-read every file"/,
    );
  });

  it("refuses a bundle the manifest does not name, and a bundled mod with no bundle", async () => {
    const mod = path.join(dir, "staging", "stray");
    put(mod, "a.txt", "x");

    await expect(
      packageEhcoll({
        manifest: manifestWith([]),
        bundles: [{ rootDir: mod, sha256: "a".repeat(64), modName: "Stray" }],
        outputPath: path.join(dir, "out.ehcoll"),
        sevenZip: zippingSevenZip(),
      }),
    ).rejects.toThrow(/Bundled mod "Stray" \(sha256 a{64}\) does not correspond/);

    await expect(
      packageEhcoll({
        manifest: manifestWith([bundledMod("Missing", "b".repeat(64))]),
        bundles: [],
        outputPath: path.join(dir, "out2.ehcoll"),
        sevenZip: zippingSevenZip(),
      }),
    ).rejects.toThrow(/no bundle with sha256 b{64} was provided/);
  });

  it("ships a file the mod holds as a link to another of its files, as that file's bytes", async (ctx) => {
    // A hardlink to the link would be another link, whose absolute target
    // points out of the staged folder, and the staged check would not find it.
    const mod = path.join(dir, "staging", "settings");
    const real = put(mod, "a.ini", "[a]");
    try {
      fs.symlinkSync(real, path.join(mod, "linked.ini"), "file");
    } catch {
      // A file link needs Developer Mode or elevation on Windows.
      ctx.skip();
    }
    const stagingDir = path.join(dir, "pack");
    const { sha } = await packageOne({}, zippingSevenZip(), { stagingDir });

    const shipped = path.join(stagingDir, "bundled", sha);
    expect(tree(shipped)).toEqual({ "a.ini": "[a]", "linked.ini": "[a]" });
    expect(fs.lstatSync(path.join(shipped, "linked.ini")).isSymbolicLink()).toBe(false);
  });
});

describe("a bundled mod whose files went away", () => {
  it("names the mod whose folder went missing after it was measured", async () => {
    const mod = path.join(dir, "staging", "settings");
    put(mod, "a.ini", "[a]");
    const sha = await identityOf(mod);
    fs.rmSync(mod, { recursive: true, force: true });

    await expect(
      packageEhcoll({
        manifest: manifestWith([bundledMod("Settings", sha)]),
        bundles: [{ rootDir: mod, sha256: sha, modName: "Settings" }],
        outputPath: path.join(dir, "out.ehcoll"),
        sevenZip: zippingSevenZip(),
      }),
    ).rejects.toThrow(/"Settings": its staging folder "[^"]+" is missing or holds no files now/);
  });

  it("names the mod and the file when one vanishes while the package is collected", async () => {
    const mod = path.join(dir, "staging", "settings");
    put(mod, "a.ini", "[a]");
    const doomed = put(mod, "b.ini", "[b]");
    const sha = await identityOf(mod);

    await expect(
      packageEhcoll({
        manifest: manifestWith([bundledMod("Settings", sha)]),
        bundles: [{ rootDir: mod, sha256: sha, modName: "Settings" }],
        outputPath: path.join(dir, "out.ehcoll"),
        sevenZip: zippingSevenZip(),
        onProgress: (p) => {
          if (p.step === "staging-bundled" && p.done === 1) fs.rmSync(doomed);
        },
      }),
    ).rejects.toThrow(/"Settings": "b\.ini" could not be collected into the package/);
  });

  it("names the mod when a mirrored file it recorded cannot be read any more", async () => {
    const docs = path.join(dir, "staging", "docs");
    const gone = put(docs, "notes.txt", "notes");
    const sha256 = crypto.createHash("sha256").update(fs.readFileSync(gone)).digest("hex");
    fs.rmSync(gone);

    await expect(
      packageEhcoll({
        manifest: manifestWith([
          {
            compareKey: "external:docs",
            name: "Docs",
            source: { kind: "external", bundled: false, expectedFilename: "docs.zip" },
            state: { mirrored: true, stagingFiles: [{ path: "notes.txt", size: 5, sha256 }] },
          },
        ]),
        bundles: [],
        mirrorFiles: [{ sourcePath: gone, sha256, modName: "Docs" }],
        outputPath: path.join(dir, "out.ehcoll"),
        sevenZip: zippingSevenZip(),
      }),
    ).rejects.toThrow(/"Docs": the file "[^"]+notes\.txt" was recorded at the start of this build and could not be read now/);
  });
});

describe("a rebuild that does not finish", () => {
  const PREVIOUS = "the package that shipped";

  it("leaves the package already built as it was when the new one is refused", async () => {
    // Refused after 7-Zip wrote: what it wrote never takes the old package's place.
    fs.writeFileSync(path.join(dir, "out.ehcoll"), PREVIOUS);
    await expect(
      packageOne({ "a.ini": "[a]", "b.ini": "[b]" }, zippingSevenZip({ drop: "b.ini" })),
    ).rejects.toThrow(/does not reproduce "Settings"/);
    expect(fs.readFileSync(path.join(dir, "out.ehcoll"), "utf8")).toBe(PREVIOUS);
    expect(fs.existsSync(path.join(dir, "out.ehcoll.partial"))).toBe(false);
  });

  it("replaces it once the new one is finished, and leaves nothing beside it", async () => {
    fs.writeFileSync(path.join(dir, "out.ehcoll"), PREVIOUS);
    const { outputPath } = await packageOne({ "a.ini": "[a]" }, zippingSevenZip());
    expect(fs.readFileSync(outputPath).subarray(0, 4)).toEqual(ZIP_HEAD);
    expect(fs.existsSync(`${outputPath}.partial`)).toBe(false);
  });

  it("reports Cancel as a cancel, and leaves the package already built", async () => {
    const outputPath = path.join(dir, "out.ehcoll");
    fs.writeFileSync(outputPath, PREVIOUS);
    const mod = path.join(dir, "staging", "settings");
    put(mod, "a.ini", "[a]");
    const sha = await identityOf(mod);
    const controller = new AbortController();

    const err = await packageEhcoll({
      manifest: manifestWith([bundledMod("Settings", sha)]),
      bundles: [{ rootDir: mod, sha256: sha, modName: "Settings" }],
      outputPath,
      sevenZip: zippingSevenZip(),
      signal: controller.signal,
      onProgress: (p) => {
        if (p.step === "hashing-output") controller.abort();
      },
    }).catch((e: unknown) => e);

    expect(err).toMatchObject({ name: "AbortError" });
    expect(fs.readFileSync(outputPath, "utf8")).toBe(PREVIOUS);
    expect(fs.existsSync(`${outputPath}.partial`)).toBe(false);
  });

  it("reports what an interrupted call throws after Cancel as a cancel, not a failure", async () => {
    // An ENOENT from a half-removed folder, a read stopped mid-file: there only
    // because Cancel was pressed, and shown as a failed build they send the
    // curator after a fault that does not exist.
    const mod = path.join(dir, "staging", "settings");
    put(mod, "a.ini", "[a]");
    const sha = await identityOf(mod);
    const controller = new AbortController();
    const stopped = zippingSevenZip();
    stopped.add = (async () => {
      controller.abort();
      throw new Error("7-Zip stopped mid-write");
    }) as unknown as FakeSevenZip["add"];

    const err = await packageEhcoll({
      manifest: manifestWith([bundledMod("Settings", sha)]),
      bundles: [{ rootDir: mod, sha256: sha, modName: "Settings" }],
      outputPath: path.join(dir, "out.ehcoll"),
      sevenZip: stopped,
      signal: controller.signal,
    }).catch((e: unknown) => e);

    expect(err).toMatchObject({ name: "AbortError" });
  });
});

describe("before anything is staged or written", () => {
  it("refuses a package its drive has no room for, naming the drive and the numbers", async () => {
    const mod = path.join(dir, "staging", "settings");
    put(mod, "a.ini", "x".repeat(4096));
    const sha = await identityOf(mod);
    const sevenZip = zippingSevenZip();

    const err = await packageEhcoll({
      manifest: manifestWith([bundledMod("Settings", sha)]),
      bundles: [{ rootDir: mod, sha256: sha, modName: "Settings" }],
      outputPath: path.join(dir, "out.ehcoll"),
      sevenZip,
      freeBytes: async () => 1024,
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(PackageEhcollError);
    expect((err as Error).message).toMatch(
      /Not enough free space on the drive holding "[^"]+": the new package \([^)]+\) needs about [\d.]+ \w+, and 1\.00 KB is free/,
    );
    expect(sevenZip.adds).toBe(0);
  });
});

describe("the hashes a manifest records for a bundled mod's files", () => {
  const sha256Of = (file: string): string =>
    crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");

  it("refuses a file whose recorded SHA-256 its bytes no longer have, naming it", async () => {
    const mod = path.join(dir, "staging", "settings");
    const a = put(mod, "a.ini", "[a]");
    put(mod, "b.ini", "[b]");
    const sha = await identityOf(mod);
    const sevenZip = zippingSevenZip();

    const err = await packageEhcoll({
      manifest: manifestWith([
        {
          ...(bundledMod("Settings", sha) as Record<string, unknown>),
          state: {
            stagingFiles: [
              { path: "a.ini", size: 3, sha256: sha256Of(a) },
              // What the hash cache still holds for a file rewritten with the same size and time.
              { path: "b.ini", size: 3, sha256: "0".repeat(64) },
            ],
          },
        },
      ]),
      bundles: [{ rootDir: mod, sha256: sha, modName: "Settings" }],
      outputPath: path.join(dir, "out.ehcoll"),
      sevenZip,
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(PackageEhcollError);
    expect((err as Error).message).toMatch(
      /"Settings": a file is recorded with a SHA-256 its bytes no longer have \(first: "b\.ini"\)[\s\S]*"Re-read every file"/,
    );
    expect(sevenZip.adds).toBe(0);
  });

  it("packs a mod whose recorded hashes are its bytes' hashes", async () => {
    const mod = path.join(dir, "staging", "settings");
    const a = put(mod, "a.ini", "[a]");
    const b = put(mod, "b.ini", "[b]");
    const sha = await identityOf(mod);

    await expect(
      packageEhcoll({
        manifest: manifestWith([
          {
            ...(bundledMod("Settings", sha) as Record<string, unknown>),
            state: {
              stagingFiles: [
                { path: "a.ini", size: 3, sha256: sha256Of(a) },
                { path: "b.ini", size: 3, sha256: sha256Of(b) },
              ],
            },
          },
        ]),
        bundles: [{ rootDir: mod, sha256: sha, modName: "Settings" }],
        outputPath: path.join(dir, "out.ehcoll"),
        sevenZip: zippingSevenZip(),
      }),
    ).resolves.toMatchObject({ bundledCount: 1 });
  });
});
