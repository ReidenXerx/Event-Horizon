import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { MarkdownView, parseBlocks } from "./Markdown";

const html = (source: string, images?: Record<string, string>): string =>
  renderToStaticMarkup(React.createElement(MarkdownView, { source, ...(images !== undefined ? { images } : {}) }));

describe("parseBlocks", () => {
  it("splits headings, paragraphs, lists, quotes, rules and images", () => {
    const blocks = parseBlocks(
      [
        "# Ivy's Panties",
        "",
        "A long",
        "paragraph.",
        "",
        "- one",
        "- two",
        "1. first",
        "> quoted",
        "---",
        "![Diamond City](presentation/shot.png)",
      ].join("\n"),
    );
    expect(blocks.map((b) => b.kind)).toEqual(["heading", "paragraph", "list", "list", "quote", "rule", "image"]);
    expect(blocks[1]).toEqual({ kind: "paragraph", text: "A long paragraph." });
  });
});

describe("MarkdownView", () => {
  it("renders the everyday formatting", () => {
    const out = html("## Setup\n\n**Bold**, *italic* and `code`.\n\n- a\n- b");
    expect(out).toContain("<h3>Setup</h3>");
    expect(out).toContain("<strong>Bold</strong>");
    expect(out).toContain("<em>italic</em>");
    expect(out).toContain("<code>code</code>");
    expect(out).toContain("<ul><li>a</li><li>b</li></ul>");
  });

  it("never turns raw HTML in the text into markup", () => {
    const out = html('<script>alert(1)</script><img src=x onerror="alert(1)">');
    expect(out).not.toContain("<script>");
    expect(out).not.toContain("<img");
    expect(out).toContain("&lt;script&gt;");
  });

  it("links only to http and https, and shows anything else as plain text", () => {
    const out = html("[Nexus](https://www.nexusmods.com) and [trap](javascript:alert(1)) and [disk](file:///C:/x)");
    expect(out).toContain('href="https://www.nexusmods.com"');
    expect(out).not.toContain("javascript:");
    expect(out).not.toContain("file:///");
    expect(out).toContain("trap");
  });

  it("shows only images the package carries, and the alt text for anything else", () => {
    const out = html(
      "![Shot](presentation/shot.png)\n\n![Short name](shot.png)\n\n![Tracker](https://evil.example/pixel.gif)",
      { "presentation/shot.png": "file:///cache/shot.png" },
    );
    expect(out.match(/<img /g)).toHaveLength(2);
    expect(out).not.toContain("evil.example");
    expect(out).toContain("Tracker");
  });
});
