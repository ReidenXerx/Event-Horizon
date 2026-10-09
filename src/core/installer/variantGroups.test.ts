/**
 * Versions of one mod (Ivy FaceGen 2048 / 1024, owner poll 2026-10-09): the
 * player installs exactly one; the pick is remembered; a Steam Deck / Proton
 * install starts on the low-end one.
 */
import { promises as fsp } from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ dir: "" }));
vi.mock("../paths/appDataPaths", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../paths/appDataPaths")>()),
  getEventHorizonDir: (...segments: string[]) => path.join(h.dir, ...segments),
}));

import {
  defaultVariantPicks,
  picksFromSkipped,
  readVariantPicks,
  saveVariantPicks,
  unpickedKeys,
  variantGroupsOf,
} from "./variantGroups";
import { loadOrCreateCollectionConfig } from "../manifest/collectionConfig";
import { neededEventHorizon } from "../manifest/minEventHorizon";
import { applyPostProcessedDeclarations } from "../../ui/pages/build/engine";

const mods = [
  { compareKey: "ext:2048", name: "Ivy FaceGen 2048", state: { optional: true, variant: { group: "Ivy FaceGen", label: "2048" } } },
  { compareKey: "ext:1024", name: "Ivy FaceGen 1024", state: { optional: true, variant: { group: "Ivy FaceGen", label: "1024", lowEnd: true as const } } },
  { compareKey: "nexus:1:1", name: "Other", state: {} },
];

beforeEach(async () => {
  h.dir = await fsp.mkdtemp(path.join(os.tmpdir(), "eh-variants-"));
});
afterEach(async () => {
  await fsp.rm(h.dir, { recursive: true, force: true });
});

describe("which version is picked", () => {
  const groups = variantGroupsOf(mods);

  it("groups the versions, in manifest order, and leaves other mods alone", () => {
    expect([...groups.keys()]).toEqual(["Ivy FaceGen"]);
    expect(groups.get("Ivy FaceGen")!.map((m) => m.label)).toEqual(["2048", "1024"]);
  });

  it("is the first by default, the low-end one on a Steam Deck, and the remembered one above both", () => {
    expect(unpickedKeys(groups, defaultVariantPicks(groups, new Map(), false))).toEqual(["ext:1024"]);
    expect(unpickedKeys(groups, defaultVariantPicks(groups, new Map(), true))).toEqual(["ext:2048"]);
    const remembered = new Map([["Ivy FaceGen", "2048"]]);
    expect(unpickedKeys(groups, defaultVariantPicks(groups, remembered, true))).toEqual(["ext:1024"]);
  });

  it("falls back when the remembered version is gone from the collection", () => {
    const remembered = new Map([["Ivy FaceGen", "4096"]]);
    expect(defaultVariantPicks(groups, remembered, false).get("Ivy FaceGen")!.label).toBe("2048");
  });

  it("reads the pick back from what the preview left out", () => {
    expect(picksFromSkipped(groups, new Set(["ext:2048"])).get("Ivy FaceGen")!.label).toBe("1024");
  });

  it("is remembered per collection, by label", async () => {
    await saveVariantPicks("pkg-ivy", picksFromSkipped(groups, new Set(["ext:2048"])));
    expect(await readVariantPicks("pkg-ivy")).toEqual(new Map([["Ivy FaceGen", "1024"]]));
    expect(await readVariantPicks("other-collection")).toEqual(new Map());
  });
});

describe("the curator's side", () => {
  it("reads a version from the collection config", async () => {
    await fsp.writeFile(
      path.join(h.dir, "ivy.json"),
      JSON.stringify({
        schemaVersion: 1,
        packageId: "fa6eb141-03b0-4847-bb12-e4c5fe4fa385",
        externalMods: { fg1024: { variant: { group: " Ivy FaceGen ", label: "1024", lowEnd: true } } },
      }),
    );
    const { config } = await loadOrCreateCollectionConfig({ configDir: h.dir, slug: "ivy" });
    expect(config.externalMods["fg1024"]?.variant).toEqual({ group: "Ivy FaceGen", label: "1024", lowEnd: true });
  });

  it("makes each version an optional mod in the build", () => {
    const [m] = applyPostProcessedDeclarations(
      [{ id: "fg1024", name: "Ivy FaceGen 1024" } as never],
      { externalMods: { fg1024: { variant: { group: "Ivy FaceGen", label: "1024", lowEnd: true } } } } as never,
    );
    expect(m).toMatchObject({ optional: true, variant: { group: "Ivy FaceGen", label: "1024", lowEnd: true } });
  });

  it("tells a player on an older Event Horizon to update", () => {
    const needs = neededEventHorizon({ mods: mods as never, game: { id: "fallout4" } } as never);
    expect(needs?.version).toBe("0.2.62");
    expect(needs?.why).toContain("a choice between versions of one mod");
  });
});
