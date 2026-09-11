/**
 * ──────────────────────────────────────────────────────────────────────
 * Stop in the curator workbench means "after this one".
 *
 * Vortex cannot cancel an install from outside, and it loses files when two
 * installs run at once. A Stop that rejects the wait for the RUNNING install
 * frees the page — every button comes back — while Vortex is still writing,
 * and the next click starts an install on top of it.
 *
 * ─── WHY THIS IS A SOURCE TEST ─────────────────────────────────────────
 * The hook is wiring over Vortex's event bus; the behaviour lives in
 * `requirementStep.ts` and `modInstall.ts`, which are tested directly. What
 * can only be read here is whether the hook hands the run's signal to a wait
 * that would honour it by letting go. Same approach as modUpdateWiring.test.ts.
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

describe("Stop does not abandon a running install", () => {
  it("installing downloads does not hand the run's signal to the install wait", () => {
    const body = section("const installDownloads", "const saveNote");
    const at = body.indexOf("installFromExistingDownload(");
    expect(at).toBeGreaterThan(-1);
    const call = body.slice(at, body.indexOf(");", at));
    expect(call).toContain("archiveId");
    expect(call).not.toMatch(/\bsignal\b/);
  });

  it("a requirement step goes through installRequirementStep, not a bare wait", () => {
    const body = section("const installOne", "const setLight");
    expect(body).toContain("installRequirementStep(");
    expect(body).not.toContain("updateOneAndWait(");
  });
});
