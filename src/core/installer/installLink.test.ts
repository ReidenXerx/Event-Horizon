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
  fileSizeOf,
  nexusFilePageUrl,
  parseInstallLink,
  safeDownloadName,
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
