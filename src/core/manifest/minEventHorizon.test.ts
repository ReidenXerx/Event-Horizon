/**
 * The oldest EH a package needs, from the features it uses (owner poll,
 * 2026-10-06: warn in the preview, never block).
 */
import { describe, expect, it } from "vitest";

import { compareEhVersions, neededEventHorizon } from "./minEventHorizon";
import type { EhcollManifest } from "../../types/ehcoll";

const mod = (state: Record<string, unknown>, source: Record<string, unknown> = { kind: "nexus" }) =>
  ({ compareKey: "k", name: "m", source, install: {}, state: { enabled: true, installOrder: 0, deploymentPriority: 0, ...state } }) as never;

const manifest = (mods: unknown[], game: Record<string, unknown> = {}) =>
  ({ mods, game: { id: "fallout4", version: "1", versionPolicy: "exact", ...game } }) as unknown as Pick<EhcollManifest, "mods" | "game">;

describe("neededEventHorizon", () => {
  it("needs nothing for a package with none of the newer features", () => {
    expect(neededEventHorizon(manifest([mod({})]))).toBeUndefined();
  });

  it("needs 0.2.56 for files a mirrored mod moved", () => {
    const needs = neededEventHorizon(
      manifest([mod({ mirrored: true, mirrorFromArchive: ["T/CoTaP/a.dds"], mirrorFromArchiveAt: { "T/CoTaP/a.dds": "T/a.dds" } })]),
    );
    expect(needs).toEqual({ version: "0.2.56", why: ["mod files the curator moved to another folder"] });
  });

  it("takes the newest feature used, and names each one", () => {
    const needs = neededEventHorizon(
      manifest(
        [
          mod({ optional: true }),
          mod(
            { stagingFiles: [{ path: "p.esp", size: 1, installerCondition: { needs: ["a.esm"] } }] },
            { kind: "external", bundled: true },
          ),
        ],
        { optionalOwnedMasters: ["ghoulification.esm"] },
      ),
    );
    expect(needs?.version).toBe("0.2.45");
    expect(needs?.why).toEqual([
      "files a mod installs only when you have certain plugins",
      "optional mods",
      "optional Creations",
      "bundled patches that check which plugins you own",
    ]);
  });

  it("compares versions by number, not text", () => {
    expect(compareEhVersions("0.2.9", "0.2.10")).toBe(-1);
    expect(compareEhVersions("0.2.46", "0.2.46")).toBe(0);
    expect(compareEhVersions("0.3.0", "0.2.99")).toBe(1);
  });
});
