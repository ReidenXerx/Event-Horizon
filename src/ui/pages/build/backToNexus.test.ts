/**
 * "Use the Nexus download": a Nexus mod the curator marked external goes back
 * to being an ordinary Nexus download — but only when Nexus still has its file.
 */
import { describe, expect, it } from "vitest";

import {
  BACK_TO_NEXUS_PATCH,
  backToNexusVerdict,
  canGoBackToNexus,
  checkBackToNexus,
  visibleExternalRows,
} from "./backToNexus";
import { choiceFromEntry } from "../../../core/manifest/collectionConfig";

const nexusMod = (id: string, modId = 122592, fileId = 555) =>
  ({ id, name: id, nexusModId: modId, nexusFileId: fileId }) as never;
const handMade = (id: string) => ({ id, name: id }) as never;
const RCS = "Race Compatibility SKSE-122592-2-1-0-1743431985";

describe("which mods offer it", () => {
  it("a Nexus mod the curator marked external", () => {
    expect(canGoBackToNexus(nexusMod(RCS), { treatAsExternal: true, bundled: true })).toBe(true);
  });

  it("not a Nexus mod that is not marked, nor a mod Vortex never had Nexus ids for", () => {
    expect(canGoBackToNexus(nexusMod(RCS), { bundled: false })).toBe(false);
    expect(canGoBackToNexus(handMade("MeridiaPantiesPatches"), { treatAsExternal: true, bundled: true })).toBe(false);
  });
});

describe("the rows of the external-mods table", () => {
  it("drops a Nexus mod the moment it is switched back, and keeps real external mods", () => {
    const contextList = [nexusMod(RCS), handMade("MeridiaPantiesPatches")];
    const rows = visibleExternalRows(contextList, contextList, {
      [RCS]: { ...BACK_TO_NEXUS_PATCH },
      MeridiaPantiesPatches: { bundled: true },
    });
    expect(rows.map((m: { id: string }) => m.id)).toEqual(["MeridiaPantiesPatches"]);
  });

  it("still adds a Nexus mod the moment it is marked external", () => {
    const usssep = nexusMod("USSEP", 266, 1);
    const rows = visibleExternalRows([], [usssep], { USSEP: { treatAsExternal: true } });
    expect(rows.map((m: { id: string }) => m.id)).toEqual(["USSEP"]);
  });
});

describe("what it changes", () => {
  it("turns off external and bundled, and reopens a bundle answer instead of keeping it", () => {
    const answeredBundle = { treatAsExternal: true, bundled: true, postProcessingDecidedFor: "fp" };
    const after = { ...answeredBundle, ...BACK_TO_NEXUS_PATCH };
    expect(after.treatAsExternal).toBe(false);
    expect(choiceFromEntry(after)).toBeUndefined();
  });

  it("keeps a mirror answer, the link and the instructions", () => {
    const entry = {
      treatAsExternal: true,
      mirrored: true,
      url: "https://www.nexusmods.com/skyrimspecialedition/mods/122592",
      instructions: "take the main file",
    };
    const after = { ...entry, ...BACK_TO_NEXUS_PATCH };
    expect(choiceFromEntry(after)).toBe("mirror");
    expect(after.url).toBe(entry.url);
    expect(after.instructions).toBe(entry.instructions);
  });
});

describe("asking Nexus first", () => {
  const files = (list: Array<{ file_id: number; category_name: string; name?: string; version?: string }>) =>
    async () => list;

  it("switches when Nexus still offers the file", async () => {
    const verdict = await checkBackToNexus({
      mod: nexusMod(RCS, 122592, 555),
      getModFiles: files([{ file_id: 555, category_name: "MAIN" }]),
    });
    expect(verdict).toEqual({ kind: "switch" });
  });

  it("refuses when the file has left Nexus, and names the newer file to update to", async () => {
    const verdict = await checkBackToNexus({
      mod: nexusMod(RCS, 122592, 555),
      getModFiles: files([{ file_id: 999, category_name: "MAIN", name: "Race Compatibility SKSE", version: "2.5.8" }]),
    });
    expect(verdict.kind).toBe("refuse");
    if (verdict.kind === "refuse") {
      expect(verdict.why).toMatch(/no longer offers/);
      expect(verdict.why).toMatch(/Race Compatibility SKSE 2\.5\.8/);
      expect(verdict.why).toMatch(/Update the mod in Vortex/);
    }
  });

  it("refuses when the mod page itself is gone", async () => {
    const verdict = await checkBackToNexus({
      mod: nexusMod(RCS, 122592, 555),
      getModFiles: async () => {
        throw Object.assign(new Error("Not Found"), { statusCode: 404 });
      },
    });
    expect(verdict.kind).toBe("refuse");
  });

  it("switches with a note when Nexus cannot be asked at all", async () => {
    const verdict = await checkBackToNexus({ mod: nexusMod(RCS), getModFiles: undefined });
    expect(verdict.kind).toBe("switch");
    expect(verdict.kind === "switch" && verdict.note).toMatch(/could not be asked/);
  });

  it("refuses a mod with no Nexus ids without asking anything", async () => {
    const verdict = await checkBackToNexus({ mod: handMade("MeridiaPantiesPatches"), getModFiles: files([]) });
    expect(verdict.kind).toBe("refuse");
  });

  it("switches for an old version, and says the author may archive it", () => {
    const verdict = backToNexusVerdict({ status: "old-version" } as never);
    expect(verdict.kind).toBe("switch");
    expect(verdict.kind === "switch" && verdict.note).toMatch(/old versions/);
  });
});
