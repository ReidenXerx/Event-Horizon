/**
 * Orphans an in-place run finds (a repair, a resume, the same version
 * re-published). Owner, 2026-10-04: one Event Horizon itself installed
 * defaults to Uninstall, since an old skeleton or body mod left switched on
 * breaks the collection with every file verifying; one the player brought
 * stays theirs (NS-2).
 */
import { describe, expect, it } from "vitest";

import { resolveOrphanedMods } from "./resolveInstallPlan";
import { defaultOrphanChoice, fillDefaultOrphanChoices } from "../../ui/pages/install/state";

const PKG = "pkg-1";
const tag = (key: string, ownership?: "installed" | "adopted", extra: Record<string, unknown> = {}) => ({
  collectionPackageId: PKG,
  collectionVersion: "1.0.37",
  originalCompareKey: key,
  installedAt: "2026-10-01T00:00:00Z",
  ...(ownership !== undefined ? { ownership } : {}),
  ...extra,
});
const manifest = { package: { id: PKG }, mods: [{ compareKey: "kept" }] } as never;
const userState = {
  previousInstall: { packageId: PKG },
  installedMods: [
    { id: "v-kept", name: "Still in", enabled: true, eventHorizonInstall: tag("kept", "installed") },
    { id: "v-ours", name: "Old Skeleton", enabled: true, eventHorizonInstall: tag("old-skel", "installed") },
    { id: "v-theirs", name: "Their Mod", enabled: true, eventHorizonInstall: tag("theirs", "adopted") },
    { id: "v-unknown", name: "Old Receipt Mod", enabled: true, eventHorizonInstall: tag("legacy") },
    // The player deleted our copy and reinstalled their own; Vortex gave it the same id.
    {
      id: "v-reinstalled",
      name: "Reinstalled",
      enabled: true,
      installTime: "2026-10-03T12:00:00Z",
      eventHorizonInstall: tag("re", "installed"),
    },
    // Installed beside a mod of the player's, whose own copy was switched off.
    { id: "v-beside", name: "Beside", enabled: true, eventHorizonInstall: tag("beside", "installed", { displaced: true }) },
  ],
} as never;

describe("orphans after an in-place run", () => {
  const orphans = resolveOrphanedMods(manifest, userState, { kind: "current-profile" } as never);

  it("recommends removing only what Event Horizon installed", () => {
    expect(orphans.map((o) => [o.existingModId, o.recommendation])).toEqual([
      ["v-ours", "recommend-uninstall"],
      ["v-theirs", "manual-review"],
      ["v-unknown", "manual-review"],
      ["v-reinstalled", "manual-review"],
      ["v-beside", "manual-review"],
    ]);
  });

  it("defaults the screen to that recommendation, and Keep for the rest", () => {
    const filled = fillDefaultOrphanChoices({ plan: { orphanedMods: orphans } } as never, {});
    expect(filled).toEqual({
      "v-ours": { kind: "uninstall" },
      "v-theirs": { kind: "keep" },
      "v-unknown": { kind: "keep" },
      "v-reinstalled": { kind: "keep" },
      "v-beside": { kind: "keep" },
    });
    // Another profile uses it: Uninstall would take it from there too (NS-3).
    const shared = fillDefaultOrphanChoices({ plan: { orphanedMods: orphans } } as never, {}, (id) => id === "v-ours");
    expect(shared["v-ours"]).toEqual({ kind: "keep" });
    // The player's own answer always wins over the default.
    expect(fillDefaultOrphanChoices({ plan: { orphanedMods: orphans } } as never, { "v-ours": { kind: "keep" } })["v-ours"]).toEqual({ kind: "keep" });
    expect(defaultOrphanChoice()).toEqual({ kind: "keep" });
  });

  it("finds no orphans in a fresh profile", () => {
    expect(resolveOrphanedMods(manifest, userState, { kind: "fresh-profile" } as never)).toEqual([]);
  });
});
