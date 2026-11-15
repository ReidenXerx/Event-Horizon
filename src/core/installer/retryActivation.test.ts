/**
 * The retry pass activates a recovered mod's plugins before retrying the mods
 * that ask about them.
 *
 * Ivy 1.0.59 (Fallout-collection, 11-15): Overture 0.2.3 and Chemistry 0.2.6
 * failed with "Installer Prerequisites not fulfilled: File 'rapport.esp' is
 * Active". Rapport had been refused in the first pass (its installer needs
 * Anatomy.esp, which the cut cycle placed after it), and the retry recovered
 * Rapport, then retried both in the same sweep with rapport.esp neither
 * deployed nor switched on.
 */
import * as fs from "fs";
import * as path from "path";

import { describe, expect, it } from "vitest";

import { retryActivationTracker } from "../resolver/installEpochs";
import type { EhcollManifest } from "../../types/ehcoll";

const ivy = {
  game: { id: "fallout4" },
  plugins: {
    order: ["AAF.esm", "Anatomy.esp", "Rapport.esp", "Overture.esp", "Chemistry.esp", "DLCNukaWorld.esm"].map(
      (name) => ({ name, enabled: true }),
    ),
  },
  mods: [
    { compareKey: "aaf", name: "AAF", provides: ["AAF.esm"] },
    { compareKey: "anatomy", name: "Anatomy", reads: ["aaf.esm", "rapport.esp"], provides: ["Anatomy.esp"] },
    { compareKey: "rapport", name: "Rapport", reads: ["aaf.esm", "anatomy.esp"], provides: ["Rapport.esp"] },
    { compareKey: "overture", name: "Overture", reads: ["aaf.esm", "rapport.esp", "dlcnukaworld.esm"], provides: ["Overture.esp"] },
    { compareKey: "chemistry", name: "Chemistry", reads: ["aaf.esm", "rapport.esp"], provides: ["Chemistry.esp"] },
  ].map((m) => ({
    compareKey: m.compareKey,
    name: m.name,
    install: { fomodSelections: [], readsPluginState: m.reads ?? [] },
    state: { stagingFiles: m.provides.map((p) => ({ path: `Data\\${p}` })) },
  })),
} as unknown as EhcollManifest;

const mod = (key: string) => ivy.mods.find((m) => m.compareKey === key)!;

describe("retrying the mods that ask about a recovered mod's plugin", () => {
  it("activates once Rapport is recovered, before Overture; Chemistry then needs nothing", () => {
    const t = retryActivationTracker(ivy);
    expect(t.needsBefore(mod("rapport"))).toEqual([]);
    t.recovered("rapport");
    expect(t.needsBefore(mod("overture"))).toEqual(["rapport.esp"]);
    expect(t.pending()).toEqual(["rapport.esp"]);
    t.activated();
    expect(t.needsBefore(mod("chemistry"))).toEqual([]);
  });

  it("does nothing when no recovered mod provides what is asked", () => {
    const t = retryActivationTracker(ivy);
    t.recovered("chemistry");
    expect(t.needsBefore(mod("overture"))).toEqual([]);
    expect(t.needsBefore(mod("anatomy"))).toEqual([]);
  });

  it("any recovered provider counts, not only Rapport", () => {
    const t = retryActivationTracker(ivy);
    t.recovered("aaf");
    expect(t.needsBefore(mod("overture"))).toEqual(["aaf.esm"]);
  });
});

describe("the driver does it inside the retry loop", () => {
  const src = fs.readFileSync(path.join(__dirname, "runInstall.ts"), "utf8");
  const loop = src.slice(src.indexOf('"install.retry.start"'), src.indexOf('"install.retry.done"'));

  it("finds the retry loop it claims to check", () => {
    expect(loop.length).toBeGreaterThan(1000);
  });

  it("activates BEFORE retrying the mod, and records recoveries after", () => {
    const asks = loop.indexOf("retryActivation.needsBefore(manifestEntry)");
    const deploy = loop.indexOf("await deployAndWait(", asks);
    const retry = loop.indexOf("await executeDecision(", asks);
    const recovered = loop.indexOf("retryActivation.recovered(entry.compareKey)");
    expect(asks).toBeGreaterThan(-1);
    expect(deploy).toBeGreaterThan(asks);
    expect(retry).toBeGreaterThan(deploy);
    expect(recovered).toBeGreaterThan(retry);
  });
});
