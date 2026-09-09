/**
 * Planning a deletion, which is the half that must never be wrong.
 *
 * Two rules carry the risk: an archive any mod still points at is never a
 * candidate (Event Horizon hashes those at build time), and the removals have
 * to precede the deletions because a mod entry is what holds the reference.
 */
import { describe, expect, it } from "vitest";

import {
  archivesFreedByRemoval,
  cleanupSubset,
  describeEvidence,
  provenSupersedes,
  unprovenSupersedes,
  findSupersededMods,
  orphanArchives,
  tickedArchives,
  formatSize,
  planCleanup,
  type DownloadEntry,
} from "./cleanupPlan";
import type { CuratorMod } from "./profileActions";

const mod = (
  id: string,
  over: Partial<CuratorMod & { archiveId?: string }> = {},
): CuratorMod & { archiveId?: string } => ({
  id,
  name: id,
  enabled: true,
  modType: "",
  ...over,
});

const dl = (id: string, over: Partial<DownloadEntry> = {}): DownloadEntry => ({
  id,
  fileName: `${id}.7z`,
  bytes: 1024 ** 3,
  ...over,
});

describe("which installs are old versions", () => {
  it("keeps the highest file id and retires the rest", () => {
    const removals = findSupersededMods([
      mod("old", { nexusModId: 7, nexusFileId: 100 }),
      mod("new", { nexusModId: 7, nexusFileId: 200 }),
    ]);
    expect(removals).toHaveLength(1);
    expect(removals[0]!.mod.id).toBe("old");
    expect(removals[0]!.supersededBy.id).toBe("new");
  });

  it("does not retire the same FILE installed twice", () => {
    // Redundant, but not a version question — choosing between identical
    // twins is a different decision than retiring an older release.
    expect(
      findSupersededMods([
        mod("a", { nexusModId: 7, nexusFileId: 100 }),
        mod("b", { nexusModId: 7, nexusFileId: 100 }),
      ]),
    ).toEqual([]);
  });

  it("says nothing when file ids are missing", () => {
    // No ordering, so no way to know which is older.
    expect(
      findSupersededMods([
        mod("a", { nexusModId: 7 }),
        mod("b", { nexusModId: 7 }),
      ]),
    ).toEqual([]);
  });

  it("never groups mods from different pages", () => {
    expect(
      findSupersededMods([
        mod("a", { nexusModId: 7, nexusFileId: 1 }),
        mod("b", { nexusModId: 8, nexusFileId: 2 }),
      ]),
    ).toEqual([]);
  });
});

describe("what may be deleted", () => {
  it("NEVER touches an archive a surviving mod points at", () => {
    // The rule that stops a build reporting missing archives.
    const plan = planCleanup({
      mods: [mod("keep", { archiveId: "dl-1", nexusModId: 7, nexusFileId: 9 })],
      downloads: [dl("dl-1")],
    });
    expect(plan.deleteArchives).toEqual([]);
    expect(plan.keptReferenced).toBe(1);
  });

  it("frees an archive only the retired install was holding", () => {
    const plan = planCleanup({
      mods: [
        mod("old", { archiveId: "dl-old", nexusModId: 7, nexusFileId: 100 }),
        mod("new", { archiveId: "dl-new", nexusModId: 7, nexusFileId: 200 }),
      ],
      downloads: [dl("dl-old"), dl("dl-new")],
      removeModIds: new Set(["old"]),
    });
    expect(plan.removeMods.map((r) => r.mod.id)).toEqual(["old"]);
    expect(plan.deleteArchives.map((a) => a.entry.id)).toEqual(["dl-old"]);
    expect(plan.deleteArchives[0]!.reason).toBe("freed-by-removal");
  });

  it("keeps an archive shared by a retired AND a surviving mod", () => {
    // Two mods from one archive: retiring one must not delete the file the
    // other still needs.
    const plan = planCleanup({
      mods: [
        mod("old", { archiveId: "shared", nexusModId: 7, nexusFileId: 100 }),
        mod("new", { archiveId: "shared", nexusModId: 7, nexusFileId: 200 }),
      ],
      downloads: [dl("shared")],
      removeModIds: new Set(["old"]),
    });
    expect(plan.removeMods).toHaveLength(1);
    expect(plan.deleteArchives).toEqual([]);
  });

  it("deletes an orphan when a version of that mod survives", () => {
    const plan = planCleanup({
      mods: [mod("cur", { archiveId: "dl-new", nexusModId: 7, nexusFileId: 9 })],
      downloads: [dl("dl-new"), dl("dl-stale", { nexusModId: 7, nexusFileId: 1 })],
    });
    expect(plan.deleteArchives.map((a) => a.entry.id)).toEqual(["dl-stale"]);
    expect(plan.deleteArchives[0]!.reason).toBe("orphan-superseded");
  });

  it("REFUSES an orphan for a mod nothing installed", () => {
    // Could be a leftover, could be a download not installed yet. They look
    // identical from here, and deleting a deliberate download to save space
    // is worse than not saving it.
    const plan = planCleanup({
      mods: [],
      downloads: [dl("maybe-wanted", { nexusModId: 99, nexusFileId: 1 })],
    });
    expect(plan.deleteArchives).toEqual([]);
    expect(plan.unclearOrphans.map((o) => o.entry.id)).toEqual(["maybe-wanted"]);
    expect(plan.unclearBytes).toBe(1024 ** 3);
  });

  it("treats a mod with no known archive as protecting nothing it holds", () => {
    // It cannot vouch for any file, so nothing is freed on its account — but
    // it also must not cause an unrelated archive to be deleted.
    const plan = planCleanup({
      mods: [mod("no-archive", { nexusModId: 7, nexusFileId: 900 })],
      downloads: [dl("dl-1", { nexusModId: 7, nexusFileId: 1 })],
    });
    expect(plan.deleteArchives.map((a) => a.entry.id)).toEqual(["dl-1"]);
  });

  it("sums only what it will actually delete", () => {
    const plan = planCleanup({
      mods: [mod("cur", { archiveId: "keep", nexusModId: 7, nexusFileId: 9 })],
      downloads: [
        dl("keep", { bytes: 5 * 1024 ** 3 }),
        dl("stale", { nexusModId: 7, nexusFileId: 1, bytes: 2 * 1024 ** 3 }),
        dl("unknown", { nexusModId: 42, bytes: 9 * 1024 ** 3 }),
      ],
    });
    expect(plan.bytesFreed).toBe(2 * 1024 ** 3);
    expect(plan.unclearBytes).toBe(9 * 1024 ** 3);
  });
});


describe("the two ways this used to delete the wrong thing", () => {
  it("never plans a removal the curator did not tick", () => {
    // It used to choose them itself. A lower file id is not proof of an older
    // version — a Nexus page ships a main file and its optional patches under
    // one mod id — so acting on that guess deleted a patch installed on
    // purpose. Suggesting is fine; acting is not.
    const mods = [
      mod("main", { archiveId: "dl-main", nexusModId: 7, nexusFileId: 100 }),
      mod("optional", { archiveId: "dl-opt", nexusModId: 7, nexusFileId: 200 }),
    ];
    const plan = planCleanup({
      mods,
      downloads: [dl("dl-main"), dl("dl-opt")],
    });
    expect(plan.removeMods).toEqual([]);
    expect(plan.deleteArchives).toEqual([]);
    // Still offered as a candidate for the curator to judge.
    expect(findSupersededMods(mods)).toHaveLength(1);
  });

  it("does not even SUGGEST retiring an enabled install for a disabled one", () => {
    // The rollback. A curator who hit a regression in v2 disables it and
    // re-enables v1; suggesting they delete v1 inverts what they chose. This
    // was verified with a probe: the old planner retired "v1-IN-USE" and
    // deleted its archive.
    expect(
      findSupersededMods([
        mod("v1-in-use", { nexusModId: 7, nexusFileId: 100, enabled: true }),
        mod("v2-disabled", { nexusModId: 7, nexusFileId: 200, enabled: false }),
      ]),
    ).toEqual([]);
  });

  it("still suggests retiring a disabled older install", () => {
    // The ordinary case must survive the guard above.
    const suggestions = findSupersededMods([
      mod("old", { nexusModId: 7, nexusFileId: 100, enabled: false }),
      mod("new", { nexusModId: 7, nexusFileId: 200, enabled: true }),
    ]);
    expect(suggestions.map((r) => r.mod.id)).toEqual(["old"]);
  });

  it("still deletes orphan archives without any removal being ticked", () => {
    // The bulk of the space is here — archives nothing references at all —
    // and that path never depended on guessing versions.
    const plan = planCleanup({
      mods: [mod("cur", { archiveId: "keep", nexusModId: 7, nexusFileId: 9 })],
      downloads: [dl("keep"), dl("stale", { nexusModId: 7, nexusFileId: 1 })],
    });
    expect(plan.deleteArchives.map((a) => a.entry.id)).toEqual(["stale"]);
  });
});

describe("splitting the plan into the two acts", () => {
  const mods = [
    mod("old", { nexusModId: 7, nexusFileId: 70, archiveId: "arc-old" }),
    mod("new", { nexusModId: 7, nexusFileId: 80, archiveId: "arc-new" }),
  ];
  const downloads: DownloadEntry[] = [
    { id: "arc-old", fileName: "Mod-7-0.7z", bytes: 100, nexusModId: 7 },
    { id: "arc-new", fileName: "Mod-8-0.7z", bytes: 200, nexusModId: 7 },
    { id: "arc-loose", fileName: "Mod-6-0.7z", bytes: 400, nexusModId: 7, nexusFileId: 60 },
  ];

  it("calls an already-free archive an orphan, needing no removal", () => {
    // arc-loose is referenced by nothing and mod 7 is still installed.
    const plan = planCleanup({ mods, downloads });
    expect(orphanArchives(plan).map((a) => a.entry.id)).toEqual(["arc-loose"]);
    expect(archivesFreedByRemoval(plan)).toEqual([]);
  });

  it("keeps an archive freed by a removal out of the orphan list", () => {
    // Ticking "old" for removal frees arc-old — but only AFTER the removal,
    // so it must not appear in the card that deletes archives on their own.
    const plan = planCleanup({ mods, downloads, removeModIds: new Set(["old"]) });
    expect(archivesFreedByRemoval(plan).map((a) => a.entry.id)).toEqual(["arc-old"]);
    expect(orphanArchives(plan).map((a) => a.entry.id)).toEqual(["arc-loose"]);
  });

  it("recomputes the bytes a narrowed plan actually frees", () => {
    // The number on an Apply button is a promise about what Apply does. A
    // subset that carried the original total would overstate it.
    const plan = planCleanup({ mods, downloads });
    const subset = cleanupSubset({
      plan,
      removeMods: [],
      deleteArchives: orphanArchives(plan),
    });
    expect(plan.bytesFreed).toBe(400);
    expect(subset.bytesFreed).toBe(400);

    const none = cleanupSubset({ plan, removeMods: [], deleteArchives: [] });
    expect(none.bytesFreed).toBe(0);
  });

  it("narrows to exactly what was ticked", () => {
    const plan = planCleanup({ mods, downloads });
    expect(tickedArchives(orphanArchives(plan), new Set(["arc-loose"]))).toHaveLength(1);
    expect(tickedArchives(orphanArchives(plan), new Set(["nothing"]))).toEqual([]);
  });

  it("never lets the archive card carry a removal", () => {
    // The two cards are separate ACTS. An archive-only apply that quietly
    // uninstalled a mod would be the worst possible surprise here.
    const plan = planCleanup({ mods, downloads, removeModIds: new Set(["old"]) });
    const archivesOnly = cleanupSubset({
      plan,
      removeMods: [],
      deleteArchives: orphanArchives(plan),
    });
    expect(archivesOnly.removeMods).toEqual([]);
  });
});


describe("two different FILES on one Nexus page are not two versions", () => {
  // Both pairs are real, off the curator's own Skyrim profile, and both were
  // offered for deletion by the rule that only looked at the mod id.
  const bodypaints = [
    mod("bp-cbbe", {
      name: "(2)Barbarian Bodypaints - CBBE-31826-1-0-1579138592",
      fileName: "Barbarian Bodypaints - CBBE-31826-1-0-1579138592.7z",
      version: "1.0",
      nexusModId: 31826,
      nexusFileId: 128100,
    }),
    mod("bp-male", {
      name: "(3)Barbarian Bodypaints - Male-31826-1-0-1579138821",
      fileName: "Barbarian Bodypaints - Male-31826-1-0-1579138821.7z",
      version: "1.0",
      nexusModId: 31826,
      nexusFileId: 128101,
    }),
  ];

  const overlays = [
    mod("co-main", {
      fileName: "Community Overlays 1 - Main - CBBE 2K-22487-1-0-1-1547251200.7z",
      version: "1.0.1",
      nexusModId: 22487,
      nexusFileId: 90001,
    }),
    mod("co-patch", {
      fileName: "Community Overlays 1 - Bugfix Patch-22487-1-0-2-1548457200.7z",
      version: "1.0.2",
      nexusModId: 22487,
      nexusFileId: 90002,
    }),
  ];

  it("does not call a CBBE variant an old version of the Male one", () => {
    expect(provenSupersedes(findSupersededMods(bodypaints))).toEqual([]);
  });

  it("does not call a main file an old version of a bugfix patch", () => {
    // This one has a genuinely HIGHER version on the other file — 1.0.2
    // against 1.0.1 — so comparing versions would not have saved it either.
    // Only the file's own name separates them.
    expect(provenSupersedes(findSupersededMods(overlays))).toEqual([]);
  });

  it("still reports them as a lead, rather than hiding them", () => {
    const unproven = unprovenSupersedes(findSupersededMods(bodypaints));
    expect(unproven).toHaveLength(1);
    expect(unproven[0]!.evidence).toBe("same-page-only");
    expect(describeEvidence(unproven[0]!.evidence)).toBe("same page only");
  });

  it("prefers the file's own name over parsing the archive", () => {
    // `logicalFileName` is what Nexus calls the file. When it is present the
    // archive name is not consulted at all.
    const named = [
      mod("a", {
        logicalFileName: "Barbarian Bodypaints - CBBE",
        fileName: "whatever-31826-1-0-1.7z",
        nexusModId: 31826,
        nexusFileId: 1,
      }),
      mod("b", {
        logicalFileName: "Barbarian Bodypaints - Male",
        fileName: "whatever-31826-1-0-2.7z",
        nexusModId: 31826,
        nexusFileId: 2,
      }),
    ];
    expect(provenSupersedes(findSupersededMods(named))).toEqual([]);
  });
});

describe("what IS an old version", () => {
  it("recognises the same file at a lower version", () => {
    const pair = [
      mod("apoc-old", {
        fileName: "Apocalypse - Magic of Skyrim-1090-9-8-1500000000.7z",
        version: "9.8",
        nexusModId: 1090,
        nexusFileId: 400,
      }),
      mod("apoc-new", {
        fileName: "Apocalypse - Magic of Skyrim-1090-10-0-1600000000.7z",
        version: "10.0",
        nexusModId: 1090,
        nexusFileId: 500,
      }),
    ];
    const proven = provenSupersedes(findSupersededMods(pair));
    expect(proven).toHaveLength(1);
    expect(proven[0]!.mod.id).toBe("apoc-old");
    expect(proven[0]!.evidence).toBe("same-file");
  });

  it("takes Nexus's own update chain as proof, whatever the names say", () => {
    // `newestFileId` is written by walking Nexus's file_updates from the
    // installed file. Landing on another install's file id is not an
    // inference — it is Nexus saying this one replaced that one.
    const pair = [
      mod("old", {
        nexusModId: 7,
        nexusFileId: 100,
        newestFileId: 200,
        logicalFileName: "An Old Name Nobody Kept",
      }),
      mod("new", {
        nexusModId: 7,
        nexusFileId: 200,
        logicalFileName: "A Renamed File",
      }),
    ];
    const proven = provenSupersedes(findSupersededMods(pair));
    expect(proven).toHaveLength(1);
    expect(proven[0]!.evidence).toBe("update-chain");
  });

  it("lets the chain outrank a mere name match", () => {
    const three = [
      mod("v1", {
        nexusModId: 7,
        nexusFileId: 100,
        newestFileId: 300,
        logicalFileName: "Same Name",
      }),
      mod("v2", { nexusModId: 7, nexusFileId: 200, logicalFileName: "Same Name" }),
      mod("v3", { nexusModId: 7, nexusFileId: 300, logicalFileName: "Same Name" }),
    ];
    const found = findSupersededMods(three).find((r) => r.mod.id === "v1");
    expect(found?.evidence).toBe("update-chain");
    expect(found?.supersededBy.id).toBe("v3");
  });

  it("compares within a file, not across the whole page", () => {
    // Two variants, each with its own history. The older CBBE is superseded
    // by the newer CBBE — NOT by the Male file that happens to be newest.
    const four = [
      mod("cbbe-1", { nexusModId: 9, nexusFileId: 10, logicalFileName: "Skin CBBE" }),
      mod("cbbe-2", { nexusModId: 9, nexusFileId: 20, logicalFileName: "Skin CBBE" }),
      mod("male-1", { nexusModId: 9, nexusFileId: 30, logicalFileName: "Skin Male" }),
    ];
    const proven = provenSupersedes(findSupersededMods(four));
    expect(proven).toHaveLength(1);
    expect(proven[0]!.mod.id).toBe("cbbe-1");
    expect(proven[0]!.supersededBy.id).toBe("cbbe-2");
  });

  it("still refuses to retire the version actually in use", () => {
    // The rollback: v1 re-enabled after a bad v2. Unchanged by any of this.
    const pair = [
      mod("v1", {
        enabled: true,
        nexusModId: 7,
        nexusFileId: 100,
        logicalFileName: "Same",
      }),
      mod("v2", {
        enabled: false,
        nexusModId: 7,
        nexusFileId: 200,
        logicalFileName: "Same",
      }),
    ];
    expect(findSupersededMods(pair)).toEqual([]);
  });

  it("says nothing about a file identity it cannot determine", () => {
    // No logical name, and an archive name that never mentions the mod id.
    const pair = [
      mod("a", { fileName: "mystery.7z", nexusModId: 7, nexusFileId: 1 }),
      mod("b", { fileName: "other.7z", nexusModId: 7, nexusFileId: 2 }),
    ];
    expect(provenSupersedes(findSupersededMods(pair))).toEqual([]);
    expect(unprovenSupersedes(findSupersededMods(pair))).toHaveLength(1);
  });
});


describe("an orphan is only superseded by something NEWER", () => {
  // Three independent audit lenses landed on this: the rule used to be "some
  // version of this page is installed", which is the same-page fallacy the
  // mod half of this file was rewritten to kill — and it lived on the half
  // that deletes permanently with no tick required.
  const installedV2 = [
    mod("v2", { nexusModId: 500, nexusFileId: 900, archiveId: "dl-v2" }),
  ];

  it("deletes an older file of a mod whose newer file is installed", () => {
    const plan = planCleanup({
      mods: installedV2,
      downloads: [
        dl("dl-v2", { nexusModId: 500, nexusFileId: 900 }),
        dl("dl-v1", { nexusModId: 500, nexusFileId: 400 }),
      ],
    });
    expect(plan.deleteArchives.map((a) => a.entry.id)).toEqual(["dl-v1"]);
  });

  it("NEVER deletes a newer file the curator has not installed yet", () => {
    // Downloaded ahead of installing. The old rule deleted it because an
    // OLDER file of the same mod was installed.
    const plan = planCleanup({
      mods: [mod("v1", { nexusModId: 500, nexusFileId: 400, archiveId: "dl-v1" })],
      downloads: [
        dl("dl-v1", { nexusModId: 500, nexusFileId: 400 }),
        dl("dl-v3", { nexusModId: 500, nexusFileId: 900 }),
      ],
    });
    expect(plan.deleteArchives).toEqual([]);
    expect(plan.unclearOrphans.map((o) => o.entry.id)).toEqual(["dl-v3"]);
  });

  it("NEVER deletes a sibling variant from the same page", () => {
    // "Bodypaints - CBBE" installed, "- Male" merely downloaded. The exact
    // pair this file's own comments cite as the false positive to kill.
    const plan = planCleanup({
      mods: [mod("cbbe", { nexusModId: 31826, nexusFileId: 128100, archiveId: "dl-cbbe" })],
      downloads: [
        dl("dl-cbbe", { nexusModId: 31826, nexusFileId: 128100 }),
        dl("dl-male", { nexusModId: 31826, nexusFileId: 128101 }),
      ],
    });
    expect(plan.deleteArchives).toEqual([]);
  });

  it("treats a missing file id on either side as an unknown, never as proof", () => {
    // An unknown is never grounds for a permanent delete. This is also the
    // shape of every archive-recovery re-download.
    expect(
      planCleanup({
        mods: installedV2,
        downloads: [dl("dl-v2", { nexusModId: 500, nexusFileId: 900 }), dl("dl-?", { nexusModId: 500 })],
      }).deleteArchives,
    ).toEqual([]);
    expect(
      planCleanup({
        mods: [mod("v", { nexusModId: 500, archiveId: "a" })],
        downloads: [dl("dl-old", { nexusModId: 500, nexusFileId: 1 })],
      }).deleteArchives,
    ).toEqual([]);
  });
});

/**
 * ──────────────────────────────────────────────────────────────────────
 * An archive can be an installed mod's own, with a broken link.
 *
 * `stillReferenced` is keyed on `mod.archiveId`, and that link DIES when a mod
 * is updated in place: Vortex refreshes `version` and `nexusFileId` and leaves
 * `archiveId` naming the old download record, which was deleted with the old
 * file. BodyTalk went 3.8 → 4.0.1 that way; its staging folder is still called
 * `BodyTalk-72310-3-8-1687372211`.
 *
 * The archive the mod actually uses then belongs to a record nothing points
 * at. It is not superseded either — its file id EQUALS the installed one
 * rather than being lower — so it landed in `unclearOrphans`, under a sentence
 * telling the curator that NO version of that mod is installed.
 *
 * Nothing was ever at risk: an unclear orphan is never listed and never
 * selected. But the claim is false about the curator's own live archives, and
 * the reclaimable-space figure counted them. Ten of them on one real
 * collection.
 * ──────────────────────────────────────────────────────────────────────
 */
describe("an archive whose mod link went stale", () => {
  /** BodyTalk as it really is: installed at 4.0.1, archiveId long dead. */
  const bodyTalk = {
    id: "BodyTalk-72310-3-8-1687372211",
    name: "BodyTalk",
    enabled: true,
    nexusModId: 72310,
    nexusFileId: 383018,
    // Points at the 3.8 download record, which no longer exists.
    archiveId: "dead-record-for-3-8",
  } as unknown as CuratorMod;

  /** The 4.0.1 archive, with its own record that no mod points at. */
  const its401Archive: DownloadEntry = {
    id: "download-for-4-0-1",
    fileName: "TBOS-BodyTalk4-72310-4-0-1-1769451493.7z",
    bytes: 307_700_000,
    nexusModId: 72310,
    nexusFileId: 383018,
  };

  it("is kept and named, not reported as having no version installed", () => {
    const plan = planCleanup({
      mods: [bodyTalk],
      downloads: [its401Archive],
    });

    expect(plan.staleLinked.map((s) => s.entry.id)).toEqual([
      "download-for-4-0-1",
    ]);
    // And crucially NOT under the label that says otherwise.
    expect(plan.unclearOrphans).toEqual([]);
    expect(plan.deleteArchives).toEqual([]);
  });

  it("still deletes a genuinely older archive of the same mod", () => {
    /**
     * The other direction, and the reason this cannot simply keep everything
     * that shares a modId: the 4.0 archive IS superseded, and reclaiming it is
     * the entire point of the feature.
     */
    const older: DownloadEntry = {
      id: "download-for-4-0",
      fileName: "TBOS-BodyTalk4-72310-4-0-1754521707.zip",
      bytes: 300_000_000,
      nexusModId: 72310,
      nexusFileId: 300000,
    };

    const plan = planCleanup({
      mods: [bodyTalk],
      downloads: [older, its401Archive],
    });

    expect(plan.deleteArchives.map((d) => d.entry.id)).toEqual([
      "download-for-4-0",
    ]);
    expect(plan.staleLinked.map((s) => s.entry.id)).toEqual([
      "download-for-4-0-1",
    ]);
  });

  it("does not claim a SIBLING file from the same page", () => {
    /**
     * Matched on (modId, fileId) exactly, never on the page. One Nexus page
     * ships main files, variants and patches — "Bodypaints - CBBE" installed
     * while "- Male" is merely downloaded is the same-page fallacy this file
     * was twice rewritten to eliminate, and a NEWER sibling must stay an
     * unclear orphan rather than being claimed as the installed mod's.
     */
    const sibling: DownloadEntry = {
      id: "download-for-a-variant",
      fileName: "TBOS-BodyTalk4-Variant-72310-9-9-1799999999.7z",
      bytes: 1_000,
      nexusModId: 72310,
      nexusFileId: 999999,
    };

    const plan = planCleanup({ mods: [bodyTalk], downloads: [sibling] });

    expect(plan.staleLinked).toEqual([]);
    expect(plan.unclearOrphans.map((o) => o.entry.id)).toEqual([
      "download-for-a-variant",
    ]);
  });

  it("leaves a properly linked archive exactly as it was", () => {
    // The ordinary case, which must keep counting as `keptReferenced` rather
    // than becoming a stale-link report on every healthy install.
    const linked = { ...bodyTalk, archiveId: "download-for-4-0-1" } as
      unknown as CuratorMod;

    const plan = planCleanup({ mods: [linked], downloads: [its401Archive] });

    expect(plan.keptReferenced).toBe(1);
    expect(plan.staleLinked).toEqual([]);
  });
});
