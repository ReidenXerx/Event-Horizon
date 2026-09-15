import { describe, expect, it } from "vitest";

import {
  MAX_GALLERY_IMAGES,
  imageFormatOf,
  isPresentationEntry,
  isSafeLink,
  presentationImages,
  readPresentation,
  readPresentationConfig,
  readableOn,
  themeVariables,
  withImagesPresent,
} from "./presentation";

const SHA = "a".repeat(64);
const img = (file: string, over: Record<string, unknown> = {}) => ({ file, sha256: SHA, size: 1000, ...over });

describe("imageFormatOf", () => {
  it("recognises each accepted format by its first bytes", () => {
    expect(imageFormatOf(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe("png");
    expect(imageFormatOf(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe("jpeg");
    expect(imageFormatOf(Buffer.from("GIF89a"))).toBe("gif");
    expect(imageFormatOf(Buffer.from("RIFF\u0000\u0000\u0000\u0000WEBP"))).toBe("webp");
  });

  it("refuses anything else, whatever it is named", () => {
    expect(imageFormatOf(Buffer.from("<svg xmlns"))).toBeUndefined();
    expect(imageFormatOf(Buffer.from("<html>"))).toBeUndefined();
    expect(imageFormatOf(Buffer.alloc(0))).toBeUndefined();
  });
});

describe("links and entries", () => {
  it("follows only http and https", () => {
    expect(isSafeLink("https://www.nexusmods.com/fallout4/mods/109025")).toBe(true);
    expect(isSafeLink("http://example.com")).toBe(true);
    expect(isSafeLink("javascript:alert(1)")).toBe(false);
    expect(isSafeLink("file:///C:/Windows/System32")).toBe(false);
    expect(isSafeLink("not a url")).toBe(false);
  });

  it("accepts only a plain image name inside presentation/", () => {
    expect(isPresentationEntry("presentation/header-abc.png")).toBe(true);
    expect(isPresentationEntry("presentation/../manifest.json")).toBe(false);
    expect(isPresentationEntry("presentation/sub/x.png")).toBe(false);
    expect(isPresentationEntry("presentation/page.html")).toBe(false);
    expect(isPresentationEntry("bundled/x.png")).toBe(false);
  });
});

describe("readPresentation", () => {
  it("is undefined for a package with no presentation", () => {
    expect(readPresentation(undefined)).toBeUndefined();
  });

  it("keeps what is usable and names what is not, instead of refusing", () => {
    const read = readPresentation({
      header: img("presentation/header.png", { caption: "  Goodneighbor  " }),
      tile: img("presentation/../tile.png"),
      gallery: [img("presentation/one.jpg"), img("presentation/two.webp", { sha256: "nope" }), "x"],
      theme: { accent: "#ff6b3d", background: "red" },
      about: "# Ivy\n\nHi.",
      links: [
        { label: "Nexus page", url: "https://www.nexusmods.com/fallout4/mods/109025" },
        { label: "Evil", url: "javascript:alert(1)" },
      ],
    })!;
    expect(read.presentation?.header).toEqual(img("presentation/header.png", { caption: "Goodneighbor" }));
    expect(read.presentation?.tile).toBeUndefined();
    expect(read.presentation?.gallery.map((g) => g.file)).toEqual(["presentation/one.jpg"]);
    expect(read.presentation?.theme).toEqual({ accent: "#ff6b3d" });
    expect(read.presentation?.links).toEqual([
      { label: "Nexus page", url: "https://www.nexusmods.com/fallout4/mods/109025" },
    ]);
    expect(read.problems).toHaveLength(5);
  });

  it("keeps at most the gallery limit", () => {
    const many = Array.from({ length: MAX_GALLERY_IMAGES + 3 }, (_, i) => img(`presentation/g${i}.png`));
    const read = readPresentation({ gallery: many })!;
    expect(read.presentation?.gallery).toHaveLength(MAX_GALLERY_IMAGES);
    expect(read.problems[0]).toContain("first");
  });

  it("has no presentation when nothing usable is left", () => {
    expect(readPresentation({ header: img("../x.png") })?.presentation).toBeUndefined();
    expect(readPresentation("banner")).toEqual({ problems: ["presentation is not an object"] });
  });
});

describe("readPresentationConfig", () => {
  it("drops unusable settings from a hand-edited config", () => {
    expect(
      readPresentationConfig({
        header: "header-1.png",
        tile: "C:/Users/me/tile.png",
        gallery: [{ file: "g-1.jpg", caption: "Diamond City" }, { file: "../g.png" }],
        theme: { accent: "#123456", background: 7 },
        links: [{ label: "Discord", url: "https://discord.gg/x" }, { label: "", url: "https://x.y" }],
        about: "",
      }),
    ).toEqual({
      header: "header-1.png",
      gallery: [{ file: "g-1.jpg", caption: "Diamond City" }],
      theme: { accent: "#123456" },
      links: [{ label: "Discord", url: "https://discord.gg/x" }],
    });
  });
});

describe("images in the package", () => {
  const presentation = readPresentation({
    header: img("presentation/a.png"),
    tile: img("presentation/a.png"),
    gallery: [img("presentation/b.png"), img("presentation/c.png")],
  })!.presentation!;

  it("lists each file once", () => {
    expect(presentationImages(presentation).map((i) => i.file)).toEqual([
      "presentation/a.png",
      "presentation/b.png",
      "presentation/c.png",
    ]);
  });

  it("drops images whose files are not in the package, and says which", () => {
    const kept = withImagesPresent(presentation, new Set(["presentation/b.png"]));
    expect(kept.presentation?.header).toBeUndefined();
    expect(kept.presentation?.gallery.map((g) => g.file)).toEqual(["presentation/b.png"]);
    expect(kept.missing.sort()).toEqual(["presentation/a.png", "presentation/c.png"]);
  });
});

describe("theme", () => {
  it("picks dark text on a light accent and light text on a dark one", () => {
    expect(readableOn("#ffb15c")).toBe("#0b0a12");
    expect(readableOn("#2c1a5e")).toBe("#ffffff");
  });

  it("sets only the collection's own variables, and nothing for an invalid colour", () => {
    expect(themeVariables({ accent: "#4cc9f0", background: "#000000" })).toEqual({
      "--eh-accent": "#4cc9f0",
      "--eh-accent-soft": "rgba(76, 201, 240, 0.14)",
      "--eh-showcase-accent-text": "#0b0a12",
      "--eh-showcase-tint": "rgba(0, 0, 0, 0.22)",
    });
    expect(themeVariables({ accent: "red" })).toEqual({});
  });
});
