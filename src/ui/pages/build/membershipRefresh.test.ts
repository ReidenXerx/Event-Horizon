/**
 * `loadBuildContext` runs once, when the form opens. Every build after that
 * reused its snapshot — so toggling a mod in Vortex and pressing Build again
 * shipped the OLD membership, silently. Measured: a rebuild produced a mod set
 * identical to the previous one down to every compareKey, with no
 * load-context pass in the log at all.
 *
 * This is the staleness a fingerprinted hash cache structurally cannot catch:
 * nothing about the files changed, only which files count.
 */
import { describe, expect, it } from "vitest";

import {
  describeMembershipChange,
  diffProfileMembership,
  refreshProfileMembership,
} from "./engine";
import type { AuditorMod } from "../../../core/getModsListForProfile";

const mod = (id: string, over: Partial<AuditorMod> = {}): AuditorMod =>
  ({
    id,
    name: id,
    enabled: true,
    collectionIds: [],
    hasInstallerChoices: false,
    hasDetailedInstallerChoices: false,
    fomodSelections: [],
    rules: [],
    modType: "",
    fileOverrides: [],
    enabledINITweaks: [],
    installOrder: 0,
    ...over,
  }) as AuditorMod;

describe("diffProfileMembership", () => {
  it("reports nothing when the profile has not moved", () => {
    const known = [mod("a"), mod("b")];
    const diff = diffProfileMembership(known, [mod("a"), mod("b")]);
    expect(diff.changed).toBe(false);
    expect(describeMembershipChange(diff, 2)).toEqual([]);
  });

  it("sees a mod enabled since the form opened", () => {
    const diff = diffProfileMembership([mod("a")], [mod("a"), mod("b")]);
    expect(diff.changed).toBe(true);
    expect(diff.addedNames).toEqual(["b"]);
    expect(diff.appeared.map((m) => m.id)).toEqual(["b"]);
    expect(diff.merged.map((m) => m.id)).toEqual(["a", "b"]);
  });

  it("sees a mod DISABLED since the form opened, and drops it", () => {
    // The case that started this: a mod switched off in Vortex kept shipping.
    const diff = diffProfileMembership([mod("a"), mod("gone")], [mod("a")]);
    expect(diff.removedNames).toEqual(["gone"]);
    expect(diff.merged.map((m) => m.id)).toEqual(["a"]);
    expect(diff.appeared).toEqual([]);
  });

  it("KEEPS the enriched entry for a mod that is still enabled", () => {
    // The whole reason not to just use the fresh read: that hash cost minutes.
    const known = [mod("a", { archiveSha256: "f".repeat(64) })];
    const diff = diffProfileMembership(known, [mod("a"), mod("b")]);
    expect(diff.merged[0]!.archiveSha256).toBe("f".repeat(64));
    // ...and the newcomer arrives without one, so it gets hashed.
    expect(diff.merged[1]!.archiveSha256).toBeUndefined();
  });

  it("handles a swap — one off, one on — in a single pass", () => {
    const diff = diffProfileMembership([mod("old")], [mod("new")]);
    expect(diff.addedNames).toEqual(["new"]);
    expect(diff.removedNames).toEqual(["old"]);
    expect(diff.merged.map((m) => m.id)).toEqual(["new"]);
  });
});

describe("describeMembershipChange", () => {
  it("says what moved and which membership was actually used", () => {
    const diff = diffProfileMembership([mod("a"), mod("dropped")], [mod("a"), mod("fresh")]);
    const line = describeMembershipChange(diff, 2).join(" ");
    expect(line).toMatch(/profile changed after this form was opened/);
    expect(line).toMatch(/1 added \("fresh"\)/);
    expect(line).toMatch(/1 no longer enabled \("dropped"\)/);
    // The curator has to know which list won, or the warning is just noise.
    expect(line).toMatch(/as it is NOW \(2 mods\)/);
  });

  it("truncates a large change rather than listing a hundred names", () => {
    const known = [mod("keep")];
    const fresh = [mod("keep"), ...Array.from({ length: 9 }, (_, i) => mod(`n${i}`))];
    const line = describeMembershipChange(diffProfileMembership(known, fresh), 10).join(" ");
    expect(line).toMatch(/9 added/);
    expect(line).toMatch(/and 4 more/);
  });
});

describe("refreshProfileMembership (the wiring, not just the diff)", () => {
  // The unit tests above all pass against a version that never reads the
  // profile at all — which is exactly the bug. So assert the reader is
  // actually consulted and its answer actually wins.
  const base = {
    state: {} as never,
    gameId: "fallout4",
    profileId: "p1",
  };

  it("uses the profile as it is NOW, not the snapshot it was handed", async () => {
    const out = await refreshProfileMembership({
      ...base,
      known: [mod("a"), mod("disabled-since")],
      readProfileMods: () => [mod("a")],
    });
    expect(out.mods.map((m) => m.id)).toEqual(["a"]);
    expect(out.removedNames).toEqual(["disabled-since"]);
    expect(out.warnings).toHaveLength(1);
  });

  it("keeps a switched-off optional or version mod the context scoped in (Meridia 1.0.32's Steam builds)", async () => {
    const steam = mod("Honed Metal+2", { enabled: false });
    const plainOff = mod("turned-off", { enabled: false });
    const known = [mod("a"), steam];
    const out = await refreshProfileMembership({
      ...base,
      known,
      readProfileMods: () => [mod("a"), steam, plainOff],
      shipsWhenDisabled: (m) => m.id === "Honed Metal+2",
    });
    expect(out.mods.map((m) => m.id)).toEqual(["a", "Honed Metal+2"]);
    expect(out.removedNames).toEqual([]);
  });

  it("stays silent and returns the snapshot untouched when nothing moved", async () => {
    const known = [mod("a"), mod("b")];
    const out = await refreshProfileMembership({
      ...base,
      known,
      readProfileMods: () => [mod("a"), mod("b")],
    });
    expect(out.mods).toBe(known);
    expect(out.warnings).toEqual([]);
  });

  it("builds anyway if the profile cannot be re-read", async () => {
    // A refresh is an improvement, not a precondition; failing the build over
    // it would trade a working collection for a diagnostic.
    const known = [mod("a")];
    const out = await refreshProfileMembership({
      ...base,
      known,
      readProfileMods: () => {
        throw new Error("state unreadable");
      },
    });
    expect(out.mods).toBe(known);
    expect(out.warnings).toEqual([]);
  });
});
