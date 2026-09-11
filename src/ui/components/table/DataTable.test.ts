/**
 * What DataTable's rendering has to keep that no DOM-free test can see.
 *
 * The window arithmetic is tested in rowWindow.test.ts. This guards the one
 * rendering decision that only a real browser distinguishes: a spacer row is
 * REPLACED when its height changes, not updated. Updated in place, headless
 * Edge kept the table's old layout (value 957px, cell 3266px tall) and the
 * rows the arithmetic placed correctly were drawn somewhere else; a keyed
 * row was laid out fresh at every position probed. The repository has no
 * DOM test environment, so the guard reads the source, like
 * noInlineStyle.test.ts does.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const SOURCE = readFileSync(join(__dirname, "DataTable.tsx"), "utf8");

/** The opening tag of every `<tr>` carrying the spacer class. */
export function spacerRowTags(source: string): string[] {
  return [...source.matchAll(/<tr\b[^>]*className="eh-table__spacer"[^>]*>/g)].map((m) => m[0]);
}

describe("DataTable spacer rows", () => {
  it("keys each spacer row on the height it stands in for", () => {
    const tags = spacerRowTags(SOURCE);
    expect(tags).toHaveLength(2);
    expect(tags[0]).toMatch(/\bkey=\{`[^`]*\$\{topSpace\}[^`]*`\}/);
    expect(tags[1]).toMatch(/\bkey=\{`[^`]*\$\{bottomSpace\}[^`]*`\}/);
  });

  it("measures rows by the id they carry, not by position", () => {
    // The height record is keyed by id; a row that stops saying which id it
    // is gets measured as nobody and the window never learns its height.
    expect(SOURCE).toMatch(/<tr\s+key=\{viewRow\.id\}\s+data-eh-row=\{viewRow\.id\}/);
    expect(SOURCE).toMatch(/tr\.dataset\.ehRow/);
  });

  it("would catch an unkeyed spacer", () => {
    const unkeyed = '<tr className="eh-table__spacer" aria-hidden="true">';
    expect(spacerRowTags(unkeyed)).toEqual([unkeyed]);
    expect(unkeyed).not.toMatch(/\bkey=\{`[^`]*\$\{topSpace\}[^`]*`\}/);
  });
});
