/**
 * A collection built on a machine where Vortex could not report the game
 * version shipped `game.version: "unknown"` with policy `"exact"`. Read
 * literally that says "your game must be version 'unknown'" — which no real
 * install satisfies, so the collection is blocked for every user on earth
 * because of a detection gap on one curator's machine.
 */
import { describe, expect, it } from "vitest";

import { resolveCompatibility } from "./resolveInstallPlan";
import type { EhcollManifest } from "../../types/ehcoll";
import type { UserSideState } from "../../types/installPlan";

const manifest = (version: string, policy: "exact" | "minimum" = "exact") =>
  ({
    game: { id: "fallout4", version, versionPolicy: policy },
    vortex: { version: "2.6.0", deploymentMethod: "hardlink", requiredExtensions: [] },
    mods: [],
  }) as unknown as EhcollManifest;

const user = (gameVersion: string | undefined) =>
  ({
    gameId: "fallout4",
    gameVersion,
    enabledExtensions: [],
    vortexVersion: "2.6.0",
    deploymentMethod: "hardlink",
  }) as unknown as UserSideState;

describe("game version compatibility", () => {
  it("does NOT block an install over a requirement the curator never determined", () => {
    const report = resolveCompatibility(manifest("unknown"), user("1.10.163.0"));
    expect(report.errors).toEqual([]);
    expect(report.gameVersion.status).toBe("unknown");
    expect(report.warnings.join(" ")).toMatch(/does not record which game version/);
  });

  it("treats an empty requirement the same way", () => {
    const report = resolveCompatibility(manifest(""), user("1.10.163.0"));
    expect(report.errors).toEqual([]);
  });

  /**
   * A real mismatch used to be an error, which stopped the install outright.
   * It is now a SOFT block (owner poll, 2026-09-22): reported as
   * `versionMismatch`, and the player must acknowledge it. The guard must
   * still not swallow the check — the mismatch has to arrive, just not as an
   * error.
   */
  it("reports a REAL exact mismatch as a soft block, not as an error", () => {
    const report = resolveCompatibility(manifest("1.10.163.0"), user("1.10.984.0"));
    expect(report.errors).toEqual([]);
    expect(report.gameVersion.status).toBe("mismatch");
    expect(report.versionMismatch).toMatchObject({ required: "1.10.163.0", installed: "1.10.984.0", direction: 1 });
    // Changing the game stays on offer, with the existing guidance.
    expect(report.versionMismatch?.changeGame.length).toBeGreaterThan(0);
  });

  it("reports a too-old game under a minimum policy the same way", () => {
    const report = resolveCompatibility(manifest("1.10.163.0", "minimum"), user("1.10.162.0"));
    expect(report.errors).toEqual([]);
    expect(report.versionMismatch).toMatchObject({ policy: "minimum", direction: -1 });
  });

  it("carries no versionMismatch on a newer game under a minimum policy", () => {
    const report = resolveCompatibility(manifest("1.10.163.0", "minimum"), user("1.10.984.0"));
    expect(report.versionMismatch).toBeUndefined();
  });

  it("keeps a DIFFERENT game a hard error — acknowledging cannot make that installable", () => {
    const report = resolveCompatibility(manifest("1.10.163.0"), { ...user("1.10.984.0"), gameId: "skyrimse" });
    expect(report.errors.length).toBeGreaterThan(0);
    expect(report.versionMismatch).toBeUndefined();
  });

  it("still passes a real match", () => {
    const report = resolveCompatibility(manifest("1.10.163.0"), user("1.10.163.0"));
    expect(report.errors).toEqual([]);
    expect(report.gameVersion.status).toBe("ok");
  });
});

/**
 * The other side of the same gap, and the one an alpha tester reported as a
 * bug: the CURATOR recorded a version, and the PLAYER's Vortex has none.
 *
 * That is the ordinary case under Wine/Proton — Vortex reads the version out
 * of the game executable at discovery time and it routinely fails in a
 * prefix. Nothing is wrong, so this must not block, and it must not read like
 * a fault either.
 */
describe("when the PLAYER's game version cannot be detected", () => {
  it("never blocks the install", () => {
    // The property that matters. A version we cannot read is not evidence of
    // an incompatible game, and refusing on it would strand every Proton user
    // over a detection gap — the same mistake as the curator-side one above,
    // pointed the other way.
    const report = resolveCompatibility(manifest("1.10.163.0"), user(undefined));
    expect(report.errors).toEqual([]);
    expect(report.gameVersion.status).toBe("unknown");
  });

  it("does not block under 'minimum' policy either", () => {
    const report = resolveCompatibility(
      manifest("1.10.163.0", "minimum"),
      user(undefined),
    );
    expect(report.errors).toEqual([]);
  });

  it("says the install is unaffected, rather than just 'unknown'", () => {
    // The bug as reported was that this looked like a failure. The warning has
    // to carry its own reassurance, because the user reading it has no way to
    // know an unchecked version is advisory.
    const report = resolveCompatibility(manifest("1.10.163.0"), user(undefined));
    const w = report.warnings.join(" ");
    expect(w).toMatch(/does not block/i);
    expect(w).toMatch(/Vortex has not recorded a version/i);
  });

  it("blames Vortex's detection, not the collection", () => {
    // Sending a player to re-download a package that is fine is the expensive
    // wrong turn here, exactly as it was for the truncated-archive message.
    const report = resolveCompatibility(manifest("1.10.163.0"), user(undefined));
    const w = report.warnings.join(" ");
    expect(w).toMatch(/nothing is wrong with the collection/i);
  });

  it("an empty string counts as undetected, not as a version", () => {
    // Vortex stores "" for a game it discovered but could not version, and a
    // truthiness bug here would compare "" against the requirement and report
    // a mismatch for a perfectly good install.
    const report = resolveCompatibility(manifest("1.10.163.0"), user(""));
    expect(report.errors).toEqual([]);
    expect(report.gameVersion.status).toBe("unknown");
  });
});
