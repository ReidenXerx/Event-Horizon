/**
 * A bundle's zip is an identity the curator's build and the user's install
 * compute independently, so the two must agree byte for byte. Pinned: file
 * order does not matter and content does; the zip is a real one our reader
 * follows, ZIP64 included; the package side — loose entries read out of a
 * package another zip writer made, stored or deflated — lands on the same hash
 * as the build side; and a file that is not what it was listed as is refused.
 */
import * as crypto from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { PassThrough, Readable } from "stream";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildZip } from "../environment/fixtures.testutil";
import { isVolatileFile } from "../volatileFiles";
import { bundleEntryOf, bundleFolderInPackage, shaOfBundleFolder } from "./bundleLayout";
import {
  bundleFilesFromListing,
  bundleFilesFromPackage,
  listBundleFolder,
  writeBundleZip,
  writeBundleZipToFile,
  type BundleFile,
} from "./bundleZip";
import { crc32, listZipEntries, openZipReader, readZipEntry } from "./readZip";
import { buildStoredZip } from "./storedZip.testutil";
import { walkStagingFolder } from "./stagingFileWalker";

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "eh-bundlezip-"));
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

const memoryFile = (p: string, content: string | Buffer): BundleFile => {
  const buf = typeof content === "string" ? Buffer.from(content) : content;
  return { path: p, size: buf.length, crc32: crc32(buf), open: () => Readable.from([buf]) };
};

const MOD: BundleFile[] = [
  memoryFile("textures/b.dds", "second texture"),
  memoryFile("Meshes/a.nif", "a mesh"),
  memoryFile("plugin.esp", "TES4 plugin bytes"),
];

async function bytesOf(file: BundleFile): Promise<Buffer> {
  const parts: Buffer[] = [];
  for await (const chunk of await file.open()) parts.push(chunk as Buffer);
  return Buffer.concat(parts);
}

async function written(
  files: readonly BundleFile[],
  options: { zip64From?: number } = {},
): Promise<{ bytes: Buffer; sha256: string }> {
  const sink = new PassThrough();
  const chunks: Buffer[] = [];
  sink.on("data", (c: Buffer) => chunks.push(c));
  const result = await writeBundleZip(files, sink, options);
  sink.end();
  return { bytes: Buffer.concat(chunks), sha256: result.sha256 };
}

const toDisk = (bytes: Buffer, name = "bundle.zip"): string => {
  const p = path.join(tmp, name);
  fs.writeFileSync(p, bytes);
  return p;
};

describe("writeBundleZip", () => {
  it("writes the same bytes whatever order the files arrive in, and returns that zip's hash", async () => {
    const a = await written(MOD);
    const b = await written([...MOD].reverse());
    expect(b.bytes.equals(a.bytes)).toBe(true);
    expect(a.sha256).toBe(crypto.createHash("sha256").update(a.bytes).digest("hex"));
  });

  it("hashes the same with no sink as with one", async () => {
    expect((await writeBundleZip(MOD, undefined)).sha256).toBe((await written(MOD)).sha256);
  });

  it("changes identity when a byte of one file, or the name of one file, changes", async () => {
    const base = (await written(MOD)).sha256;
    const edited = [memoryFile("textures/b.dds", "second texturE"), ...MOD.slice(1)];
    const renamed = [memoryFile("textures/c.dds", "second texture"), ...MOD.slice(1)];
    expect((await written(edited)).sha256).not.toBe(base);
    expect((await written(renamed)).sha256).not.toBe(base);
  });

  it("is a real zip: stored entries with UTF-8 names, every file read back byte for byte", async () => {
    const files = [...MOD, memoryFile("Текстуры/файл.dds", "cyrillic"), memoryFile("empty.txt", "")];
    const zip = toDisk((await written(files)).bytes);
    const entries = await listZipEntries(zip);
    expect(entries.map((e) => e.name)).toEqual(["Meshes/a.nif", "empty.txt", "plugin.esp", "textures/b.dds", "Текстуры/файл.dds"]);
    expect(entries.every((e) => e.method === 0 && e.nameEncodingKnown)).toBe(true);
    for (const f of files) {
      expect((await readZipEntry(zip, f.path)).equals(await bytesOf(f))).toBe(true);
    }
  });

  it("carries sizes and offsets as ZIP64 where they need it, and the reader follows them", async () => {
    const files = [memoryFile("a.txt", "small"), memoryFile("big.bin", Buffer.alloc(40, 7)), memoryFile("z.txt", "after the big one")];
    const { bytes } = await written(files, { zip64From: 32 });
    expect(bytes.includes(Buffer.from([0x50, 0x4b, 0x06, 0x06]))).toBe(true);
    const zip = toDisk(bytes);
    expect((await listZipEntries(zip)).map((e) => [e.name, e.uncompressedSize])).toEqual([
      ["a.txt", 5],
      ["big.bin", 40],
      ["z.txt", 17],
    ]);
    expect((await readZipEntry(zip, "big.bin")).equals(Buffer.alloc(40, 7))).toBe(true);
    expect((await readZipEntry(zip, "z.txt")).toString()).toBe("after the big one");
  });

  it("refuses a file that is not what it was listed as", async () => {
    const liar: BundleFile = { ...memoryFile("a.txt", "listed"), open: () => Readable.from([Buffer.from("changed")]) };
    await expect(writeBundleZip([liar], undefined)).rejects.toThrow(/is not the file that was listed/);
  });

  it("refuses paths a zip cannot carry safely, and the same path twice", async () => {
    for (const bad of ["../escape.txt", "a//b.txt", "a\\b.txt", "", "./a.txt", "dir/"]) {
      await expect(writeBundleZip([memoryFile(bad, "x")], undefined), bad).rejects.toThrow(/cannot be a file inside a bundle/);
    }
    await expect(writeBundleZip([memoryFile("a.txt", "x"), memoryFile("a.txt", "y")], undefined)).rejects.toThrow(/appears twice/);
  });

  it("is the frozen format: these files make exactly these bytes, in this version and every later one", async () => {
    // Pinned values, not derived ones. A writer change that moves either hash
    // re-keys every bundled mod ever shipped — a new manifest schema, not a
    // fix. The ZIP64 layout is pinned through the test-only threshold.
    expect((await written(MOD)).sha256).toBe("a8add9891f80e56cd81cd1366e0ad4491b8123f8011cd750fac38eb3a355149b");
    const withZip64 = [
      memoryFile("a.txt", "small"),
      memoryFile("big.bin", Buffer.alloc(40, 7)),
      memoryFile("z.txt", "after the big one"),
    ];
    expect((await written(withZip64, { zip64From: 32 })).sha256).toBe("2503031118531d757521e3e441d0e6809a8b22b3aa23e4618c79d3e9a7ba3e74");
  });

  it("writes a bundle with no files as an empty but valid zip", async () => {
    expect(await listZipEntries(toDisk((await written([])).bytes))).toEqual([]);
  });
});

describe("listBundleFolder", () => {
  it("lists a mod's folder in the zip's order, leaving out files a runtime writes", async () => {
    const root = path.join(tmp, "mod");
    const put = (rel: string, body: string): void => {
      const full = path.join(root, ...rel.split("/"));
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, body);
    };
    put("textures/b.dds", "second texture");
    put("Meshes/a.nif", "a mesh");
    put("plugin.esp", "TES4 plugin bytes");
    put("SKSE/Plugins/mod.log", "written by the game");
    put("Thumbs.db", "explorer");
    expect(isVolatileFile("SKSE/Plugins/mod.log") && isVolatileFile("Thumbs.db")).toBe(true);
    const listing = await listBundleFolder(root);
    expect(listing.map((f) => [f.path, f.size])).toEqual([
      ["Meshes/a.nif", 6],
      ["plugin.esp", 17],
      ["textures/b.dds", 14],
    ]);
    // Read from disk, it is the same bundle as the same files held in memory.
    expect((await writeBundleZip(await bundleFilesFromListing(listing), undefined)).sha256).toBe((await written(MOD)).sha256);
  });

  it("lists exactly what the manifest's staging capture lists, links included", async () => {
    // A bundle holding files the manifest does not describe ships bytes no
    // user's verification expects, and the mod is never recognised as
    // installed. So the bundle is listed by the same walk as the capture —
    // whatever that walk does with a link to a folder, inside the mod or out.
    const root = path.join(tmp, "linked-mod");
    fs.mkdirSync(path.join(root, "real"), { recursive: true });
    fs.writeFileSync(path.join(root, "real", "a.txt"), "a");
    const outside = path.join(tmp, "elsewhere");
    fs.mkdirSync(outside, { recursive: true });
    fs.writeFileSync(path.join(outside, "b.txt"), "b");
    fs.symlinkSync(path.join(root, "real"), path.join(root, "again"), "junction");
    fs.symlinkSync(outside, path.join(root, "outside"), "junction");

    const listed = (await listBundleFolder(root)).map((f) => f.path);
    const captured = (await walkStagingFolder(root, undefined)).map((f) => f.relativePath);
    expect(listed).toContain("real/a.txt");
    expect([...listed].sort()).toEqual([...captured].sort());
  });

  it("refuses a mod whose files cannot all be read, rather than bundle it with a hole", async () => {
    // A listing that quietly skipped an unreadable path would ship the mod
    // without it, under an identity that says nothing is missing.
    const root = path.join(tmp, "holed-mod");
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(path.join(root, "a.txt"), "a");
    const gone = path.join(tmp, "gone");
    fs.mkdirSync(gone, { recursive: true });
    fs.symlinkSync(gone, path.join(root, "dangling"), "junction");
    fs.rmSync(gone, { recursive: true, force: true });

    await expect(listBundleFolder(root)).rejects.toThrow(/could not be read/);
  });
});

describe("the package side", () => {
  for (const method of ["store", "deflate"] as const) {
    it(`writes the very zip the build hashed, straight out of a package's ${method === "store" ? "stored" : "deflated"} loose entries`, async () => {
      const { sha256 } = await written(MOD);
      const folder = bundleFolderInPackage(sha256);
      const entries = [
        { name: "manifest.json", data: Buffer.from("{}") },
        ...(await Promise.all(MOD.map(async (f) => ({ name: `${folder}${f.path}`, data: await bytesOf(f) })))),
        { name: "mirror/0123", data: Buffer.from("not part of the bundle") },
      ];
      const pkg = toDisk(buildZip(entries, method), `package-${method}.ehcoll`);
      const reader = await openZipReader(pkg);
      try {
        const files = bundleFilesFromPackage(reader, folder);
        expect(files.map((f) => f.path).sort()).toEqual(MOD.map((f) => f.path).sort());
        const out = path.join(tmp, `rebuilt-${method}.zip`);
        const sink = fs.createWriteStream(out);
        const result = await writeBundleZip(files, sink);
        await new Promise<void>((resolve, reject) => sink.end((err?: Error | null) => (err ? reject(err) : resolve())));
        expect(result.sha256).toBe(sha256);
        expect(crypto.createHash("sha256").update(fs.readFileSync(out)).digest("hex")).toBe(sha256);
      } finally {
        await reader.close();
      }
    });
  }

  it("refuses a damaged entry rather than writing its bytes into the bundle", async () => {
    const { sha256 } = await written([memoryFile("plugin.esp", "TES4 plugin bytes")]);
    const folder = bundleFolderInPackage(sha256);
    const bytes = buildStoredZip([{ name: `${folder}plugin.esp`, body: "TES4 plugin bytes" }]);
    // A flipped byte in a STORED entry: nothing but the CRC can see it.
    bytes[bytes.indexOf(Buffer.from("TES4 plugin bytes")) + 5] ^= 0xff;
    const reader = await openZipReader(toDisk(bytes, "damaged.ehcoll"));
    try {
      await expect(writeBundleZip(bundleFilesFromPackage(reader, folder), undefined)).rejects.toThrow(
        /did not survive reading|is not the file that was listed/,
      );
    } finally {
      await reader.close();
    }
  });

  it("reads a bundle folder's name back to its hash, and nothing else", () => {
    const sha = "a".repeat(64);
    expect(shaOfBundleFolder(bundleFolderInPackage(sha))).toBe(sha);
    expect(shaOfBundleFolder(`bundled/${sha}.zip`)).toBeUndefined();
    expect(shaOfBundleFolder(`bundled/${sha}`)).toBeUndefined();
    expect(shaOfBundleFolder("bundled/xyz/")).toBeUndefined();
  });

  it("reads a package entry back to its bundle and its path inside the mod", () => {
    const sha = "b".repeat(64);
    expect(bundleEntryOf(`bundled/${sha}/Textures/a.dds`)).toEqual({
      sha256: sha,
      folder: `bundled/${sha}/`,
      path: "Textures/a.dds",
    });
    expect(bundleEntryOf(`bundled/${sha}.zip`)).toBeUndefined();
    expect(bundleEntryOf(`bundled/${sha}/`)).toBeUndefined();
    expect(bundleEntryOf(`mirror/${sha}`)).toBeUndefined();
  });

  it("reads a bundle written with Windows separators as the same bundle", async () => {
    // The package reader normalises separators when it classifies entries; the
    // install must find the very same files, or a package the reader accepted
    // fails part-way through as "incomplete".
    const { sha256 } = await written(MOD);
    const folder = bundleFolderInPackage(sha256);
    const entries = await Promise.all(
      MOD.map(async (f) => ({ name: `${folder}${f.path}`.split("/").join("\\"), data: await bytesOf(f) })),
    );
    const reader = await openZipReader(toDisk(buildZip(entries, "store"), "backslashes.ehcoll"));
    try {
      const files = bundleFilesFromPackage(reader, folder);
      expect(files.map((f) => f.path).sort()).toEqual(MOD.map((f) => f.path).sort());
      expect((await writeBundleZip(files, undefined)).sha256).toBe(sha256);
    } finally {
      await reader.close();
    }
  });

  it("refuses to rebuild a bundle whose names do not say how they are encoded", async () => {
    const { sha256 } = await written([memoryFile("Текстуры/файл.dds", "cyrillic")]);
    const folder = bundleFolderInPackage(sha256);
    // UTF-8 name bytes without the UTF-8 flag: what a re-packing tool leaves.
    const bytes = buildStoredZip([{ name: `${folder}Текстуры/файл.dds`, body: "cyrillic" }]);
    const reader = await openZipReader(toDisk(bytes, "unflagged.ehcoll"));
    try {
      expect(() => bundleFilesFromPackage(reader, folder)).toThrow(
        /does not say how its name is encoded/,
      );
    } finally {
      await reader.close();
    }
  });
});

describe("writeBundleZipToFile", () => {
  it("writes the bundle to disk and returns the identity of the bytes that landed", async () => {
    const out = path.join(tmp, "Settings.zip");
    const result = await writeBundleZipToFile(MOD, out);
    expect(result.sha256).toBe((await written(MOD)).sha256);
    expect(crypto.createHash("sha256").update(fs.readFileSync(out)).digest("hex")).toBe(
      result.sha256,
    );
  });

  it("leaves nothing behind when the write fails", async () => {
    const out = path.join(tmp, "Broken.zip");
    const liar: BundleFile = {
      ...memoryFile("a.txt", "listed"),
      open: () => Readable.from([Buffer.from("changed")]),
    };
    await expect(writeBundleZipToFile([liar], out)).rejects.toThrow(/is not the file that was listed/);
    expect(fs.existsSync(out)).toBe(false);
  });

  it("never overwrites, or deletes, a file that was already there", async () => {
    const out = path.join(tmp, "Existing.zip");
    fs.writeFileSync(out, "someone else's");
    await expect(writeBundleZipToFile(MOD, out)).rejects.toThrow(/EEXIST/);
    expect(fs.readFileSync(out, "utf8")).toBe("someone else's");
  });

  it("stops when cancelled, and removes what it had started", async () => {
    const out = path.join(tmp, "Cancelled.zip");
    const controller = new AbortController();
    controller.abort();
    await expect(writeBundleZipToFile(MOD, out, { signal: controller.signal })).rejects.toThrow(
      /cancelled/i,
    );
    expect(fs.existsSync(out)).toBe(false);
  });
});
