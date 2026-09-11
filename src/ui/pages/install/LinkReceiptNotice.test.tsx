/**
 * The decision this screen carries: a file from a link with no published
 * checksum is shown with its hash AND with the plain statement that it was
 * not verified. A notice that showed a hash under a neutral title would read
 * as a check that never happened.
 */
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { LinkReceiptNotice } from "./LinkReceiptNotice";

const SHA = "ab".repeat(32);

describe("LinkReceiptNotice", () => {
  it("says a file from a bare link was not verified, and shows its hash", () => {
    const html = renderToStaticMarkup(
      React.createElement(LinkReceiptNotice, {
        receipt: { fileName: "ivy.ehcoll", size: 1024, sha256: SHA, verified: "unverified", source: "direct" },
      }),
    );
    expect(html).toMatch(/Not verified against a published checksum/);
    expect(html).toContain(SHA);
    expect(html).not.toMatch(/Checksum verified/);
  });

  it("says a matching file was verified, and shows the hash it matched", () => {
    const html = renderToStaticMarkup(
      React.createElement(LinkReceiptNotice, {
        receipt: { fileName: "ivy.ehcoll", size: 1024, sha256: SHA, verified: "match", source: "direct" },
      }),
    );
    expect(html).toMatch(/Checksum verified/);
    expect(html).toContain(SHA);
  });
});
