/**
 * ──────────────────────────────────────────────────────────────────────
 * Remove's confirmation says which mods can come back from Downloads.
 *
 * It used to promise "Its archive stays in Downloads, so it can be installed
 * again" for every mod without looking. The text and the split are tested in
 * archiveOnDisk.test.ts; what only the hook can show is that the dialog is
 * built from a real probe of the disk rather than from a fixed sentence.
 * Same approach as modUpdateWiring.test.ts.
 * ──────────────────────────────────────────────────────────────────────
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const SRC = readFileSync(join(__dirname, "useCuratorActions.ts"), "utf8");

function section(from: string, to: string): string {
  const a = SRC.indexOf(from);
  expect(a, `${from} not found`).toBeGreaterThan(-1);
  const b = SRC.indexOf(to, a);
  expect(b, `${to} not found after ${from}`).toBeGreaterThan(a);
  return SRC.slice(a, b);
}

describe("the Remove confirmation", () => {
  it("probes each archive on disk before it says anything about reinstalling", () => {
    const body = section("const removeMods", "const installDownloads");
    const probe = body.indexOf("splitByArchiveOnDisk(");
    const dialog = body.indexOf("confirm(");
    expect(probe).toBeGreaterThan(-1);
    expect(dialog).toBeGreaterThan(probe);
    expect(body).toContain("describeRemoveConfirm(");
  });

  it("no longer promises every archive stays in Downloads", () => {
    expect(section("const removeMods", "const installDownloads")).not.toContain("Its archive stays in Downloads");
  });
});
