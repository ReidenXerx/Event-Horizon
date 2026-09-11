/**
 * A pasted link is classified before anything is fetched, and the two
 * classes are handled by different machinery. A Nexus page mistaken for a
 * direct link would be "downloaded" as HTML and rejected as a package; a
 * direct link mistaken for a Nexus page would be sent to Vortex's Nexus
 * integration, which has nothing to say about it.
 */
import * as fs from "fs";
import * as path from "path";

import { describe, expect, it } from "vitest";

import {
  chooseEhcollFile,
  fileNameFromContentDisposition,
  fileSizeOf,
  nexusFilePageUrl,
  parseInstallLink,
  safeDownloadName,
  sanitizeFileName,
  type NexusFileCandidate,
} from "./installLink";

describe("parseInstallLink", () => {
  it("reads the plain mod page address", () => {
    expect(parseInstallLink("https://www.nexusmods.com/fallout4/mods/108944")).toEqual({
      kind: "nexus",
      domain: "fallout4",
      modId: 108944,
    });
  });

  it("reads the /games/ form the site itself uses and ignores the tab", () => {
    expect(
      parseInstallLink("  https://www.nexusmods.com/games/skyrimspecialedition/mods/191460?tab=description "),
    ).toEqual({ kind: "nexus", domain: "skyrimspecialedition", modId: 191460 });
  });

  it("keeps a file_id when the link names one", () => {
    expect(
      parseInstallLink("https://www.nexusmods.com/fallout4/mods/108944?tab=files&file_id=410973"),
    ).toEqual({ kind: "nexus", domain: "fallout4", modId: 108944, fileId: 410973 });
  });

  it("reads an nxm link, which always names the file", () => {
    expect(
      parseInstallLink("nxm://skyrimspecialedition/mods/191460/files/803758?key=abc&expires=1"),
    ).toEqual({ kind: "nexus", domain: "skyrimspecialedition", modId: 191460, fileId: 803758 });
  });

  it("treats any other web link as the file itself", () => {
    expect(parseInstallLink("https://example.com/dl/ivy-panties-1.0.19.ehcoll")).toEqual({
      kind: "direct",
      url: "https://example.com/dl/ivy-panties-1.0.19.ehcoll",
    });
  });

  it("turns a pixeldrain share page into its direct download link", () => {
    expect(parseInstallLink("https://pixeldrain.com/u/Qc8K6SYR")).toEqual({
      kind: "direct",
      url: "https://pixeldrain.com/api/file/Qc8K6SYR?download",
    });
    // An already-direct link is left alone.
    expect(parseInstallLink("https://pixeldrain.com/api/file/Qc8K6SYR?download")).toEqual({
      kind: "direct",
      url: "https://pixeldrain.com/api/file/Qc8K6SYR?download",
    });
  });

  it("refuses a Nexus link that is not a mod page, and says what to paste instead", () => {
    const r = parseInstallLink("https://www.nexusmods.com/fallout4/collections/tumkz9");
    expect(r.kind).toBe("invalid");
    expect((r as { why: string }).why).toMatch(/mods\/108944/);
  });

  it("refuses plain http, which anything on the way can rewrite, except on this machine", () => {
    const r = parseInstallLink("http://pixeldrain.com/api/file/Qc8K6SYR?download");
    expect(r.kind).toBe("invalid");
    expect((r as { why: string }).why).toMatch(/https:\/\//);
    expect(parseInstallLink("http://www.nexusmods.com/fallout4/mods/108944").kind).toBe("invalid");
    expect(parseInstallLink("http://127.0.0.1:8080/pkg.ehcoll").kind).toBe("direct");
    expect(parseInstallLink("http://localhost/pkg.ehcoll").kind).toBe("direct");
  });

  it("carries a #sha256= checksum, and the address it downloads has no fragment", () => {
    const hex = "AB".repeat(32);
    expect(parseInstallLink(`https://pixeldrain.com/u/Qc8K6SYR#sha256=${hex}`)).toEqual({
      kind: "direct",
      url: "https://pixeldrain.com/api/file/Qc8K6SYR?download",
      sha256: hex.toLowerCase(),
    });
    expect(parseInstallLink(`https://www.nexusmods.com/fallout4/mods/108944#sha256=${hex}`)).toEqual({
      kind: "nexus",
      domain: "fallout4",
      modId: 108944,
      sha256: hex.toLowerCase(),
    });
    // An unrelated fragment is not a checksum and is not refused.
    expect(parseInstallLink("https://example.com/pkg.ehcoll#top")).toEqual({
      kind: "direct",
      url: "https://example.com/pkg.ehcoll",
    });
  });

  it("refuses a checksum fragment that is not a SHA-256, rather than skipping the check", () => {
    expect(parseInstallLink("https://example.com/pkg.ehcoll#sha256=abc").kind).toBe("invalid");
    expect(parseInstallLink(`https://example.com/pkg.ehcoll#sha256=${"g".repeat(64)}`).kind).toBe("invalid");
    expect(parseInstallLink(`https://example.com/pkg.ehcoll#SHA-256=${"a".repeat(64)}`).kind).toBe("invalid");
  });

  it("drops credentials from a direct link", () => {
    expect(parseInstallLink("https://user:secret@example.com/pkg.ehcoll")).toEqual({
      kind: "direct",
      url: "https://example.com/pkg.ehcoll",
    });
  });

  it("refuses a file_id that is not a whole file number instead of ignoring it", () => {
    for (const bad of ["1e3", "", "0x10", "-4", "12.0"]) {
      const r = parseInstallLink(`https://www.nexusmods.com/skyrimspecialedition/mods/191460?tab=files&file_id=${bad}`);
      expect(r.kind, bad).toBe("invalid");
    }
  });

  it("refuses non-web schemes and empty input", () => {
    expect(parseInstallLink("file:///C:/x.ehcoll").kind).toBe("invalid");
    expect(parseInstallLink("").kind).toBe("invalid");
    expect(parseInstallLink("not a link").kind).toBe("invalid");
  });
});

describe("chooseEhcollFile", () => {
  const pkg = (over: Partial<NexusFileCandidate>): NexusFileCandidate => ({
    file_id: 1,
    file_name: "x.ehcoll",
    category_id: 1,
    ...over,
  });

  it("takes the named file even when it is not a .ehcoll", () => {
    const files = [pkg({ file_id: 1 }), pkg({ file_id: 2, file_name: "notes.zip" })];
    expect(chooseEhcollFile(files, 2)).toEqual({ kind: "one", file: files[1] });
  });

  it("reports a named file the page does not have", () => {
    const r = chooseEhcollFile([pkg({ file_id: 1 })], 9);
    expect(r.kind).toBe("none");
  });

  it("ignores non-package files and retired versions", () => {
    const files = [
      pkg({ file_id: 1, file_name: "readme.txt" }),
      pkg({ file_id: 2, category_id: 4 }), // old version
      pkg({ file_id: 3 }),
    ];
    expect(chooseEhcollFile(files)).toEqual({ kind: "one", file: files[2] });
  });

  it("prefers the page's primary file", () => {
    const files = [pkg({ file_id: 1 }), pkg({ file_id: 2, is_primary: true }), pkg({ file_id: 3, category_id: 2 })];
    expect(chooseEhcollFile(files)).toEqual({ kind: "one", file: files[1] });
  });

  it("with several Main files and dates, takes the newest", () => {
    const files = [
      pkg({ file_id: 1, uploaded_timestamp: 100 }),
      pkg({ file_id: 2, uploaded_timestamp: 300 }),
      pkg({ file_id: 3, uploaded_timestamp: 200 }),
    ];
    expect(chooseEhcollFile(files)).toEqual({ kind: "one", file: files[1] });
  });

  it("does not guess between equals", () => {
    const files = [pkg({ file_id: 1, category_id: 2 }), pkg({ file_id: 2, category_id: 2 })];
    const r = chooseEhcollFile(files);
    expect(r.kind).toBe("several");
  });

  it("explains an empty page and a page without packages differently", () => {
    expect((chooseEhcollFile([]) as { why: string }).why).toMatch(/no files/);
    expect((chooseEhcollFile([pkg({ file_name: "mod.7z" })]) as { why: string }).why).toMatch(/no \.ehcoll/);
  });
});

describe("the source file itself", () => {
  // A raw NUL inside a regex made git classify installLink.ts as binary:
  // no diffs in review, CRLF kept against .gitattributes' eol=lf.
  it("is text: no control bytes and LF line endings", () => {
    const bytes = fs.readFileSync(path.join(__dirname, "installLink.ts"));
    const control = [...bytes].filter((b) => b < 0x20 && b !== 0x0a);
    expect(control).toEqual([]);
  });

  // The file-name sanitizer names invisible and bidi characters in a regex.
  // Written raw they are invisible in review and in every editor, which is
  // the very thing the sanitizer exists to stop; they must stay escapes.
  it("holds no raw invisible or direction-changing characters", () => {
    const text = fs.readFileSync(path.join(__dirname, "installLink.ts"), "utf8");
    const raw = [...text]
      .map((c) => c.codePointAt(0) ?? 0)
      .filter(
        (cp) =>
          (cp >= 0x7f && cp <= 0x9f) ||
          cp === 0xad ||
          cp === 0x61c ||
          cp === 0x180e ||
          (cp >= 0x200b && cp <= 0x200f) ||
          (cp >= 0x2028 && cp <= 0x202e) ||
          (cp >= 0x2060 && cp <= 0x206f) ||
          cp === 0xfeff,
      )
      .map((cp) => `U+${cp.toString(16).toUpperCase()}`);
    expect(raw).toEqual([]);
  });
});

describe("helpers", () => {
  it("builds the file page a free account is sent to", () => {
    expect(nexusFilePageUrl("fallout4", 108944, 410973)).toBe(
      "https://www.nexusmods.com/fallout4/mods/108944?tab=files&file_id=410973",
    );
  });

  it("reads a size from either field", () => {
    expect(fileSizeOf({ file_id: 1, size_in_bytes: 10 })).toBe(10);
    expect(fileSizeOf({ file_id: 1, size_kb: 2 })).toBe(2048);
    expect(fileSizeOf({ file_id: 1 })).toBeUndefined();
  });

  it("names a direct download after the link, kept inside our folder", () => {
    expect(safeDownloadName("https://h/x/ivy%20panties.ehcoll")).toBe("ivy panties.ehcoll");
    expect(safeDownloadName("https://h/x/pkg")).toBe("pkg.ehcoll");
    expect(safeDownloadName("https://h/x/../")).toBe("collection.ehcoll");
    expect(safeDownloadName("https://h/")).toBe("collection.ehcoll");
  });
});

describe("file names a server supplies", () => {
  const RLO = String.fromCharCode(0x202e);
  const ZWSP = String.fromCharCode(0x200b);

  it("removes invisible and direction-changing characters, so the name on screen is the name on disk", () => {
    const name = sanitizeFileName(`${RLO}llocohe.exe`);
    expect(name).toBe("llocohe.exe.ehcoll");
    expect(sanitizeFileName(`ivy${ZWSP}.ehcoll`)).toBe("ivy.ehcoll");
    expect(sanitizeFileName(`a${String.fromCharCode(0)}b`)).toBe("ab.ehcoll");
  });

  it("never names a Windows device", () => {
    expect(sanitizeFileName("CON")).toBe("_CON.ehcoll");
    expect(sanitizeFileName("nul.ehcoll")).toBe("_nul.ehcoll");
    expect(sanitizeFileName("console.ehcoll")).toBe("console.ehcoll");
  });

  it("caps the length and keeps the extension", () => {
    const name = sanitizeFileName(`${"x".repeat(300)}.ehcoll`);
    expect(name.length).toBeLessThanOrEqual(120);
    expect(name.endsWith(".ehcoll")).toBe(true);
  });

  it("drops trailing dots and spaces Windows would drop silently, and paths", () => {
    expect(sanitizeFileName("pkg.ehcoll. ")).toBe("pkg.ehcoll");
    expect(sanitizeFileName("../../Windows/evil.dll")).toBe(".._.._Windows_evil.dll.ehcoll");
    expect(sanitizeFileName(" .. ")).toBe("collection.ehcoll");
  });

  it("reads Content-Disposition as quoted strings and RFC 8187 values", () => {
    expect(fileNameFromContentDisposition('attachment; filename="a;b.ehcoll"')).toBe("a;b.ehcoll");
    expect(fileNameFromContentDisposition('attachment; filename="a\\"b.ehcoll"')).toBe('a"b.ehcoll');
    expect(fileNameFromContentDisposition("inline; filename=pkg.ehcoll; size=3")).toBe("pkg.ehcoll");
    expect(fileNameFromContentDisposition("attachment; filename*=utf-8'en'pkg%20x.ehcoll")).toBe("pkg x.ehcoll");
    expect(
      fileNameFromContentDisposition(`attachment; filename="plain.ehcoll"; filename*=UTF-8''%E2%80%AEllocohe.exe`),
    ).toBe(`${RLO}llocohe.exe`);
    expect(fileNameFromContentDisposition("attachment")).toBeUndefined();
  });
});
