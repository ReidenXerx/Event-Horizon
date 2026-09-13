/**
 * Where the people installing get a mod, from the build to the decision card.
 *
 * The mirror card said "Users still download this mod from Nexus" about every
 * mod. On a real build it said that about CC_enclave_textures, set to Manual,
 * whose archive was the curator's own repack and on Nexus nowhere. So each
 * candidate carries where users get the mod, the build fills it in with the
 * same test it ships the mod by, and the card is worded from that.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { AuditorMod } from "../../../core/getModsListForProfile";
import type { CollectionConfig } from "../../../core/manifest/collectionConfig";
import { findPostProcessingCandidates } from "../../../core/manifest/runSelfChecks";
import type { SelfCheckReport } from "../../../core/manifest/selfCheckMod";
import { downloadedFromNexus } from "./engine";

function report(modId: string): SelfCheckReport {
  return {
    modId,
    modName: modId,
    depth: "replayed",
    notes: [],
    missing: [],
    unexplained: 2,
    unexplainedExamples: [],
    omissionLeads: [],
    stagedCount: 3,
    expectedCount: 1,
  } as unknown as SelfCheckReport;
}

describe("a decision candidate says where users get the mod", () => {
  it("marks the mods users download from Nexus, and every other one as fetched by hand", () => {
    const candidates = findPostProcessingCandidates(
      [report("from-nexus"), report("by-hand")],
      new Map(),
      new Set(),
      new Set(["from-nexus"]),
    );
    const source = new Map(candidates.map((c) => [c.modId, c.source]));
    expect(source.get("from-nexus")).toBe("nexus");
    expect(source.get("by-hand")).toBe("external");
  });

  it("claims neither when the caller does not know", () => {
    const [c] = findPostProcessingCandidates([report("unknown")], new Map());
    expect(c!.source).toBeUndefined();
  });
});

describe("the build decides it the way it ships the mod", () => {
  const mod = (id: string, nexusModId?: number, nexusFileId?: number): AuditorMod =>
    ({ id, name: id, nexusModId, nexusFileId }) as unknown as AuditorMod;
  const config = (externalMods: CollectionConfig["externalMods"]): CollectionConfig =>
    ({ externalMods }) as unknown as CollectionConfig;

  it("counts a Nexus mod as downloaded from Nexus", () => {
    expect(downloadedFromNexus([mod("a", 11, 22)], config({})).has("a")).toBe(true);
  });

  it("does not count a Nexus mod the collection ships as external", () => {
    // Its file is gone from Nexus, or bundling marked it: users fetch it by hand.
    const shipped = config({ a: { treatAsExternal: true } });
    expect(downloadedFromNexus([mod("a", 11, 22)], shipped).has("a")).toBe(false);
  });

  it("does not count a mod with no Nexus file", () => {
    expect(downloadedFromNexus([mod("manual")], config({})).has("manual")).toBe(false);
  });
});

describe("both candidate lists get it", () => {
  // A list built without it still renders — every card just says neither — so
  // nothing but a check like this notices the wiring going missing.
  it("is passed to the list made before the gate and to the one rebuilt after it", () => {
    const engine = readFileSync(join(__dirname, "engine.ts"), "utf8");
    expect(engine.split("downloadedFromNexus(mods, collectionConfig)").length - 1).toBe(2);
    const selfChecks = readFileSync(
      join(__dirname, "..", "..", "..", "core", "manifest", "runSelfChecks.ts"),
      "utf8",
    );
    expect(selfChecks).toContain("opts?.downloadedFromNexus,");
  });
});
