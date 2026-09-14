/**
 * readEhcoll had NO tests.
 *
 * It is what the entire install path and the build dashboard's package
 * inspector sit on -- six dependents, three execution flows -- and replacing
 * its ZIP reading with a native reader broke nothing in a 566-test suite,
 * because nothing was watching. Making its listing return an EMPTY ARRAY,
 * which must produce "does not contain manifest.json", also passed. That is
 * the definition of unwired.
 *
 * These read REAL archives (provenance in readZip.fixtures.ts) and assert on
 * WHICH STAGE the failure comes from, because that is what separates a working
 * chain from a broken one:
 *
 *   listing broken    -> "does not contain manifest.json"
 *   extraction broken -> a file-read error
 *   both working      -> a MANIFEST SCHEMA complaint
 *
 * The third is the only outcome that proves the first two happened, which is
 * why these assert on it rather than merely that something threw.
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as zlib from "zlib";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { hasPackageManifest, readEhcoll, ReadEhcollError } from "./readEhcoll";
import { DOTNET_ZIP, SEVENZIP_WITH_LOCAL_EXTRA } from "./readZip.fixtures";

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "eh-read-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const write = (
  b64: string,
  name: string,
  mutate?: (b: Buffer) => void,
): string => {
  const buf = Buffer.from(b64, "base64");
  mutate?.(buf);
  const p = path.join(dir, name);
  fs.writeFileSync(p, buf);
  return p;
};

/** The message, whatever stage produced it. */
const capture = async (p: string): Promise<string> => {
  try {
    await readEhcoll(p);
    return "<no error>";
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
};

describe("readEhcoll reads the archive itself", () => {
  it("gets manifest.json's real bytes as far as the parser", async () => {
    // The load-bearing one. This archive HAS a manifest.json whose content is
    // valid JSON but not a valid manifest, so a working chain fails at the
    // SCHEMA. A listing that returned nothing would say the package has no
    // manifest; an extraction that wrote nothing would give a read error.
    // Neither of those is a schema complaint.
    const msg = await capture(write(SEVENZIP_WITH_LOCAL_EXTRA, "a.ehcoll"));
    expect(msg).not.toBe("<no error>");
    expect(msg).not.toMatch(/does not contain manifest\.json/);
    expect(msg).not.toMatch(/ENOENT|no such file/i);
  });

  it("reads an archive written by .NET as readily as one written by 7-Zip", async () => {
    // Same assertion, different real writer. The reader must not be tuned to
    // whichever tool happened to produce the packages we tested with.
    const msg = await capture(write(DOTNET_ZIP, "b.ehcoll"));
    expect(msg).not.toBe("<no error>");
    expect(msg).not.toMatch(/does not contain manifest\.json/);
    expect(msg).not.toMatch(/ENOENT|no such file/i);
  });

  it("says the package has no manifest when it genuinely has none", async () => {
    // The other side of the same coin. Rename the entry everywhere it appears
    // -- central directory and local header -- and the listing should now
    // legitimately report no manifest. Without this, the tests above would
    // pass on a reader that never looks at entry names at all.
    const p = write(SEVENZIP_WITH_LOCAL_EXTRA, "c.ehcoll", (b) => {
      let i = b.indexOf("manifest.json");
      while (i !== -1) {
        b.write("xanifest.json", i);
        i = b.indexOf("manifest.json");
      }
    });
    expect(await capture(p)).toMatch(/does not contain manifest\.json/);
  });
});

/** A stored zip of the given files: UTF-8 names, real CRCs. */
function storedZip(files: Array<{ name: string; data: string }>): Buffer {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const f of files) {
    const data = Buffer.from(f.data, "utf8");
    const name = Buffer.from(f.name, "utf8");
    const crc = zlib.crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x800, 6);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    parts.push(local, name, data);
    const header = Buffer.alloc(46);
    header.writeUInt32LE(0x02014b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(20, 6);
    header.writeUInt16LE(0x800, 8);
    header.writeUInt32LE(crc, 16);
    header.writeUInt32LE(data.length, 20);
    header.writeUInt32LE(data.length, 24);
    header.writeUInt16LE(name.length, 28);
    header.writeUInt32LE(offset, 42);
    central.push(header, name);
    offset += 30 + name.length + data.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, cd, end]);
}

describe("a zip that is not a package", () => {
  // Packages are picked as .zip now (Nexus quarantines files named .ehcoll),
  // so a collection page's link file can reach the reader, and "not a valid
  // package" would leave its owner with nothing to do.
  it("names a collection page's link file, and what to do with it", async () => {
    const p = path.join(dir, "ivy-panties-link.zip");
    fs.writeFileSync(p, storedZip([
      { name: "event-horizon-link.json", data: '{"format":"event-horizon-link","version":1}' },
      { name: "readme.txt", data: "Paste the link into Event Horizon." },
    ]));
    const msg = await capture(p);
    expect(msg).toMatch(/is a collection's link file, not its package/);
    expect(msg).toMatch(/Paste the link written inside it/);
  });

  it("keeps saying no manifest for any other zip", async () => {
    const p = path.join(dir, "some-mod.zip");
    fs.writeFileSync(p, storedZip([{ name: "Data/some.esp", data: "TES4" }]));
    const msg = await capture(p);
    expect(msg).toMatch(/does not contain manifest\.json/);
    expect(msg).not.toMatch(/link file/);
  });
});

describe("hasPackageManifest", () => {
  it("is true for a zip with manifest.json at its root whatever its name, and false for one without", async () => {
    expect(await hasPackageManifest(write(SEVENZIP_WITH_LOCAL_EXTRA, "ivy-panties-1.0.26.zip"))).toBe(true);
    const nested = path.join(dir, "nested.zip");
    fs.writeFileSync(nested, storedZip([{ name: "wrap/manifest.json", data: "{}" }]));
    expect(await hasPackageManifest(nested)).toBe(false);
    const link = path.join(dir, "link.zip");
    fs.writeFileSync(link, storedZip([{ name: "event-horizon-link.json", data: "{}" }]));
    expect(await hasPackageManifest(link)).toBe(false);
  });

  it("throws the package reader's error for a file that is not a zip", async () => {
    const p = path.join(dir, "page.zip");
    fs.writeFileSync(p, Buffer.from("<!DOCTYPE html><html><body>404", "utf8"));
    await expect(hasPackageManifest(p)).rejects.toBeInstanceOf(ReadEhcollError);
  });
});

describe("readEhcoll error reporting", () => {
  it("calls a cut-short package incomplete, not corrupt", async () => {
    // The alpha tester's failure shape. Sending a curator to rebuild a package
    // that merely transferred badly points them at the wrong problem entirely.
    const whole = Buffer.from(SEVENZIP_WITH_LOCAL_EXTRA, "base64");
    const p = path.join(dir, "cut.ehcoll");
    fs.writeFileSync(p, whole.subarray(0, whole.length - 40));
    const msg = await capture(p);
    expect(msg).toMatch(/incomplete|transfer/i);
    expect(msg).not.toMatch(/password/i);
  });

  it("recognises a downloaded error page instead of calling it a broken zip", async () => {
    // A .ehcoll link that 404s saves an HTML page under the right filename.
    // "not a zip" is true and useless; naming it is what tells the user their
    // DOWNLOAD failed rather than the package.
    const p = path.join(dir, "html.ehcoll");
    fs.writeFileSync(p, Buffer.from("<!DOCTYPE html><html><body>404", "utf8"));
    expect(await capture(p)).toMatch(/HTML page/i);
  });

  it("never blames 7z, which it no longer uses", async () => {
    // The point of the change. A message blaming 7z on a machine where no 7z
    // ran sends the reader off to check something irrelevant -- which is
    // precisely what happened to the alpha tester.
    const whole = Buffer.from(SEVENZIP_WITH_LOCAL_EXTRA, "base64");
    const p = path.join(dir, "cut2.ehcoll");
    fs.writeFileSync(p, whole.subarray(0, whole.length - 40));
    expect(await capture(p)).not.toMatch(/7z|7-zip/i);
  });

  it("throws ReadEhcollError, the one type every caller catches", async () => {
    const p = path.join(dir, "x.ehcoll");
    fs.writeFileSync(p, Buffer.from([0x50, 0x4b]));
    await expect(readEhcoll(p)).rejects.toBeInstanceOf(ReadEhcollError);
  });

  it("rejects a relative path rather than resolving it against the cwd", async () => {
    await expect(readEhcoll("relative.ehcoll")).rejects.toThrow(
      /must be an absolute path/,
    );
  });
});
