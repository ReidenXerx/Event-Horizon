/**
 * ──────────────────────────────────────────────────────────────────────
 * Every curator action says in the log what it offered and what it did.
 *
 * A curator reporting a problem sends a log, not a screen. The plan preview,
 * a planning failure, a freeze, a note, an enable, a removal that failed and
 * an archive that would not install all used to leave nothing behind, so
 * "did nothing" and "did the wrong thing" read the same from outside.
 *
 * ─── WHY THIS IS A SOURCE TEST ─────────────────────────────────────────
 * ehLog writes to Vortex's log sink, which does not exist under vitest, and
 * the hook is wiring. The property is that the event is emitted from the
 * right handler, so the handler's text is what gets read. Same approach as
 * modUpdateWiring.test.ts.
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

describe("what the curator actions log", () => {
  it("the plan preview, with its steps, files, off-Nexus lines and unread pages", () => {
    const body = section("const openPlan", "const linesOf");
    expect(body).toContain('"curator.requirement.plan.preview"');
    for (const field of ["steps:", "fileIds:", "toEnable:", "external:", "unfetched:", "truncated:", "blockers:"]) {
      expect(body, field).toContain(field);
    }
    expect(body).toContain('"curator.requirement.plan.fail"');
  });

  it("freezing, notes and enables", () => {
    expect(section("const setFrozen", "const refreshUpdates")).toContain('"curator.freeze.set"');
    expect(section("const saveNote", "const setPluginEnabled")).toContain('"curator.note.set"');
    expect(section("const setEnabledFor", "const enableWithProviders")).toContain('"curator.enable.set"');
  });

  it("a removal or a download install that failed, per mod", () => {
    expect(section("const removeMods", "const installDownloads")).toContain('"curator.remove.fail"');
    expect(section("const installDownloads", "const saveNote")).toContain('"curator.install-download.fail"');
  });

  it("a plan reports the file that landed, not only the one it planned", () => {
    expect(section("const runPlan", "const installRequirement")).toContain("installedFile:");
  });
});
