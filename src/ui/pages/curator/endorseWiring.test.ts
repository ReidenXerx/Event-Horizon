/**
 * ──────────────────────────────────────────────────────────────────────
 * The bulk endorse checks what Vortex's handler checks before sending, and
 * reads the in-progress marker where Vortex writes it.
 *
 * The rules and the verdicts are tested in endorseOutcome.test.ts. What only
 * the hook can show is the order — a refusal decided BEFORE the emit, not
 * inferred from an attribute that never changed — and that the marker reader
 * is handed to the wait. Same approach as modUpdateWiring.test.ts.
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

describe("endorseEach", () => {
  const body = (): string => section("const endorseEach", "const describeEndorse");

  it("decides whether Vortex would send before emitting", () => {
    const b = body();
    const refusal = b.indexOf("endorseRefusal(");
    const emit = b.indexOf('"endorse-mod"');
    expect(refusal).toBeGreaterThan(-1);
    expect(emit).toBeGreaterThan(refusal);
  });

  it("reads the marker under the game Vortex writes it to", () => {
    const b = body();
    expect(b).toContain("pendingGameFor(");
    expect(b).toMatch(/readPending: \(\) => statusUnder\(markerGame, mod\.id\)/);
  });

  it("reports through describeEndorseRun", () => {
    expect(SRC).toMatch(/const describeEndorse = [^\n]*describeEndorseRun\(o, asked, stopped\)/);
  });
});
