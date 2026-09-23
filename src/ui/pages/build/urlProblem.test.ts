/**
 * The manifest parser drops any external-mod link that is not http(s) — on the
 * USER's machine, silently, long after the curator could have fixed it. So a
 * curator who types "example.com" publishes a collection with no link and
 * never learns. This is the check that catches it where it is typed.
 *
 * It has to accept exactly what the parser accepts. Stricter and the form
 * rejects a link that would have shipped fine; looser and it waves through one
 * that will vanish, which is the failure it exists to prevent.
 */
import { describe, expect, it } from "vitest";

import { urlProblem } from "./BuildPage";

describe("urlProblem", () => {
  it("accepts what the manifest will actually carry", () => {
    for (const ok of [
      "https://example.com/mods/42",
      "http://example.com/f.7z",
      "HTTPS://EXAMPLE.COM/X",
      "  https://example.com/spaced  ",
    ]) {
      expect(urlProblem(ok), ok).toBeUndefined();
    }
  });

  it("says nothing about an empty field", () => {
    // The link is optional. A blank one is a choice, not a mistake.
    expect(urlProblem(undefined)).toBeUndefined();
    expect(urlProblem("")).toBeUndefined();
    expect(urlProblem("   ")).toBeUndefined();
  });

  it("names the scheme problem for a non-web link", () => {
    // file:// is the curator's own disk and means nothing to anyone else.
    const said = urlProblem("file:///C:/mods/thing.7z");
    expect(said).toMatch(/http:\/\/ and https:\/\//);
    expect(urlProblem("nxm://fallout4/mods/1/files/2")).toBeDefined();
  });

  it("tells someone who omitted the scheme what to add", () => {
    // The most likely mistake, and the one with the most useful correction.
    const said = urlProblem("example.com/mods/42");
    expect(said).toMatch(/starting with https:\/\//);
  });

  it("rejects a bare Windows path", () => {
    expect(urlProblem("C:\\Users\\me\\Downloads\\mod.7z")).toBeDefined();
  });
});
