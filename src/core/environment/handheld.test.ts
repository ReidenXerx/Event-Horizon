/**
 * Handheld PCs and what follows from one (owner poll, 2026-10-09): an
 * optional mod marked for handhelds starts ticked only on one; files a player
 * changes in a game menu ship but are never judged.
 */
import { describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ handheld: false }));
vi.mock("./handheld", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./handheld")>()),
  detectHandheld: () => ({ handheld: h.handheld, how: "test" }),
}));
vi.mock("../proton/detect", () => ({ looksLikeWine: () => false }));

import { isHandheldProduct } from "./handheld";
import { initialVariantSkips } from "../../ui/pages/install/variantChoice";
import { computeStagingSetHash } from "../manifest/stagingSetHash";
import { judgeSkipSet, skipsVerification } from "../volatileFiles";

describe("which machines are handhelds", () => {
  it("knows the common ones by their product name", () => {
    for (const p of ["Jupiter", "Galileo", "ROG Ally RC71L_RC71L", "RC72LA", "83E1", "Claw A1M", "AYANEO 2S"]) {
      expect(isHandheldProduct(p)).toBe(true);
    }
  });
  it("does not take a desktop board for one", () => {
    for (const p of ["NH5xVR", "MS-7C91", "System Product Name", "B550 AORUS ELITE"]) {
      expect(isHandheldProduct(p)).toBe(false);
    }
  });
});

describe("an optional mod for handhelds", () => {
  const manifest = {
    package: { id: "meridia" },
    mods: [
      { compareKey: "handheld", name: "Meridia - Handheld Settings", state: { optional: true, optionalFor: "handheld" } },
      { compareKey: "plain", name: "Some optional", state: { optional: true } },
    ],
  } as never;

  it("starts unticked on a desktop, and only that one", async () => {
    h.handheld = false;
    expect(await initialVariantSkips(manifest)).toEqual(["handheld"]);
  });

  it("starts ticked on a handheld", async () => {
    h.handheld = true;
    expect(await initialVariantSkips(manifest)).toEqual([]);
  });
});

describe("a settings file the player changes in a game menu", () => {
  const dll = { path: "SKSE/Plugins/SPS.dll", size: 1, sha256: "a".repeat(64) };
  const ini = { path: "SKSE/Plugins/SPS_User.ini", size: 1, sha256: "b".repeat(64) };
  const skip = judgeSkipSet({ playerSettingsFiles: ["SKSE/Plugins/SPS_User.ini"] });

  it("is never judged on the player's side", () => {
    expect(skipsVerification(ini.path, skip)).toBe(true);
    expect(skipsVerification(ini.path)).toBe(false);
  });

  it("is left out of the staging-set hash the same way on both sides, whatever the player changed", () => {
    const changed = { ...ini, sha256: "c".repeat(64) };
    expect(computeStagingSetHash([dll, ini], skip)).toBe(computeStagingSetHash([dll, changed], skip));
    expect(computeStagingSetHash([dll, ini], skip)).toBe(computeStagingSetHash([dll]));
  });
});
