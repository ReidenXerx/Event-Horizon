/**
 * Archives are recognised by their signature, never by their name, and what
 * every Nexus mod legitimately ships — Bethesda's .ba2 and .bsa, plugins,
 * textures, DLLs — is not an archive here.
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { describe, expect, it } from "vitest";

import { archiveFormatOf, archiveFormatOfFile } from "./archiveInside";

const head = (...parts: Array<number[] | string>): Buffer =>
  Buffer.concat(parts.map((p) => (typeof p === "string" ? Buffer.from(p, "latin1") : Buffer.from(p))));

describe("archiveFormatOf", () => {
  it("recognises each archive format by its first bytes", () => {
    expect(archiveFormatOf(head([0x50, 0x4b, 0x03, 0x04], "rest"))).toBe("zip");
    expect(archiveFormatOf(head([0x50, 0x4b, 0x05, 0x06], new Array<number>(18).fill(0)))).toBe("zip");
    expect(archiveFormatOf(head([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c, 0x00, 0x04]))).toBe("7z");
    expect(archiveFormatOf(head("Rar!", [0x1a, 0x07, 0x01, 0x00]))).toBe("rar");
    expect(archiveFormatOf(head("Rar!", [0x1a, 0x07, 0x00]))).toBe("rar");
    expect(archiveFormatOf(head([0x1f, 0x8b, 0x08, 0x00]))).toBe("gzip");
    expect(archiveFormatOf(head([0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00]))).toBe("xz");
    expect(archiveFormatOf(head("MSCF", [0, 0, 0, 0]))).toBe("cab");
    expect(archiveFormatOf(head([0x28, 0xb5, 0x2f, 0xfd, 0x24]))).toBe("zstd");
    expect(archiveFormatOf(head([0x04, 0x22, 0x4d, 0x18, 0x64]))).toBe("lz4");
    expect(archiveFormatOf(head("MSWIM", [0, 0, 0, 0xd0]))).toBe("wim");
    expect(archiveFormatOf(head("BZh9", [0x31, 0x41, 0x59, 0x26, 0x53, 0x59]))).toBe("bzip2");
    const tar = Buffer.alloc(512);
    tar.write("ustar", 257, "latin1");
    expect(archiveFormatOf(tar)).toBe("tar");
  });

  it("does not call a game's own files archives", () => {
    expect(archiveFormatOf(head("BTDX", [1, 0, 0, 0]))).toBeUndefined();
    expect(archiveFormatOf(head("BSA", [0, 0x69, 0, 0, 0]))).toBeUndefined();
    expect(archiveFormatOf(head("TES4", [0, 0, 0, 0]))).toBeUndefined();
    expect(archiveFormatOf(head("DDS ", [0x7c, 0, 0, 0]))).toBeUndefined();
    expect(archiveFormatOf(head("MZ", [0x90, 0]))).toBeUndefined();
    expect(archiveFormatOf(head("BZh"))).toBeUndefined();
    expect(archiveFormatOf(head("BZhello, world"))).toBeUndefined();
    expect(archiveFormatOf(Buffer.alloc(0))).toBeUndefined();
  });
});

describe("archiveFormatOfFile", () => {
  it("reads the signature from disk, whatever the file is called", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "eh-archive-"));
    try {
      const disguised = path.join(dir, "readme.txt");
      fs.writeFileSync(disguised, head([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c], "payload"));
      const tiny = path.join(dir, "tiny.bin");
      fs.writeFileSync(tiny, "PK");
      expect(await archiveFormatOfFile(disguised)).toBe("7z");
      expect(await archiveFormatOfFile(tiny)).toBeUndefined();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
