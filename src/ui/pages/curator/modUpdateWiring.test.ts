/**
 * ──────────────────────────────────────────────────────────────────────
 * The fourth argument to `mod-update` is a DISCRIMINATOR, not a label.
 *
 * Vortex's handler opens with:
 *
 *     if (source !== "nexus") {
 *       // not a mod from nexus mods
 *       return;
 *     }
 *
 * It was passed "event-horizon-curator-tools" — read as an attribution tag,
 * because Vortex's own caller passes `mod.attributes.source` in that slot.
 * The handler returned immediately: no download, no error, and not one line
 * in Vortex's log or ours. The page sat on "Updating 1 of 4" until the
 * fifteen-minute timeout, and the only way to diagnose it was to notice that
 * Vortex's own log was empty too.
 *
 * ─── WHY THIS IS A SOURCE TEST ─────────────────────────────────────────
 * Nothing runnable can catch it. The emit is fire-and-forget into an event
 * bus that does not exist outside Vortex, so a unit test can only assert that
 * we called `emit` — which we did, correctly, with an argument that made it a
 * no-op. The property lives in the literal, so the literal is what gets read.
 *
 * The same approach as `bundleGateWiring.test.ts`, for the same reason: the
 * mistake is invisible to types and to behaviour, and costs an hour of
 * staring at a spinner.
 * ──────────────────────────────────────────────────────────────────────
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const PAGE = join(__dirname, "useCuratorActions.ts");

/** The `mod-update` emit call, whitespace-normalised. */
function modUpdateEmit(): string {
  const src = readFileSync(PAGE, "utf8");
  const at = src.indexOf('"mod-update"');
  expect(at, "the curator actions no longer emit mod-update").toBeGreaterThan(-1);
  // From the emit to the end of its argument list.
  const close = src.indexOf(");", at);
  return src.slice(at, close).replace(/\s+/g, " ");
}

describe("the mod-update emit", () => {
  it('passes "nexus" as the source', () => {
    // Vortex's own bulk update hardcodes this exact literal at this exact
    // call. Anything else and the handler returns before doing anything.
    expect(modUpdateEmit()).toMatch(/source|"nexus"/);
    const src = readFileSync(PAGE, "utf8");
    expect(src).toMatch(/const source = "nexus";/);
  });

  it("never passes a made-up source string", () => {
    // The exact shape of the bug: a descriptive tag where a discriminator
    // was expected. Any identifier-looking literal that is not "nexus" is
    // the same mistake wearing a different name.
    const src = readFileSync(PAGE, "utf8");
    const emit = modUpdateEmit();
    expect(emit).not.toMatch(/event-horizon/i);
    expect(emit).not.toMatch(/curator-tools/i);
    // And no other literal is being passed as the source anywhere near it.
    expect(src).not.toMatch(/"mod-update",[\s\S]{0,220}?"(?!nexus")[a-z-]{4,}"/);
  });

  it("sends the download's game, not blindly the active one", () => {
    // A compatible download — a Skyrim LE file installed under SSE — lives
    // under the other game's id, and Vortex reads `downloadGame` here for
    // exactly that reason.
    const src = readFileSync(PAGE, "utf8");
    expect(src).toMatch(/downloadGame\s*=\s*candidate\.mod\.downloadGame\s*\?\?/);
  });

  it("logs the attempt, so a silent no-op is visible next time", () => {
    // The whole reason this took a log dive: the flow emitted nothing at
    // all, so "did nothing" and "working" looked identical from outside.
    const src = readFileSync(PAGE, "utf8");
    expect(src).toMatch(/curator\.update\.start/);
    expect(src).toMatch(/curator\.bulk-update\.start/);
    expect(src).toMatch(/curator\.bulk-update\.done/);
  });
});
