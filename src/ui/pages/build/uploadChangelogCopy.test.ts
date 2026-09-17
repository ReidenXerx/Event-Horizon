/**
 * After an upload, the dialog offers this version's changelog in the format a
 * Nexus collection page takes (Markdown) as well as the one a mod page takes
 * (BBCode). Owner request 2026-09-17.
 */
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { NexusUploadDialog } from "./NexusCollectionUpload";

const dialog = (extra: object): string =>
  renderToStaticMarkup(
    React.createElement(NexusUploadDialog, {
      phase: { kind: "done", link: { id: 510746, slug: "ecb76c", gameDomain: "skyrimspecialedition" }, revisionNumber: 2, remembered: true },
      pageName: "Meridia's Panties - Event Horizon",
      onPageNameChange: () => undefined,
      outputPath: "C:/x/meridia-s-panties-event-horizon-1.0.20.zip",
      outputBytes: 1_550_000_000,
      onSelect: () => undefined,
      onClose: () => undefined,
      onUpload: () => undefined,
      onStop: () => undefined,
      onBack: () => undefined,
      ...extra,
    } as never),
  );

describe("copying the changelog after an upload", () => {
  it("offers Markdown before BBCode when the build has both", () => {
    const html = dialog({ changelogMarkdown: "## 1.0.20", changelogBbcode: "[b]1.0.20[/b]" });
    expect(html).toContain("Copy changelog (Markdown)");
    expect(html).toContain("Copy changelog (BBCode)");
    expect(html.indexOf("Copy changelog (Markdown)")).toBeLessThan(html.indexOf("Copy changelog (BBCode)"));
  });

  it("offers neither when the build recorded no changelog", () => {
    const html = dialog({});
    expect(html).not.toContain("Copy changelog");
  });
});
