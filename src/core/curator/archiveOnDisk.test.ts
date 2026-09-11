/**
 * Remove promised every mod could be installed again from Downloads without
 * looking for the archive.
 */
import { describe, expect, it } from "vitest";

import { describeRemoveConfirm, splitByArchiveOnDisk } from "./archiveOnDisk";

describe("splitByArchiveOnDisk", () => {
  it("keeps a mod only when its recorded archive is on disk, in order", async () => {
    const mods = [
      { name: "on disk", archiveId: "a" },
      { name: "no record", archiveId: undefined },
      { name: "no path", archiveId: "b" },
      { name: "gone", archiveId: "c" },
      { name: "also on disk", archiveId: "d" },
    ];
    const paths: Record<string, string> = { a: "/dl/a.7z", c: "/dl/c.7z", d: "/dl/d.7z" };
    const onDisk = new Set(["/dl/a.7z", "/dl/d.7z"]);
    const split = await splitByArchiveOnDisk(
      mods,
      (id) => (id === undefined ? undefined : paths[id]),
      async (p) => onDisk.has(p),
    );
    expect(split.withArchive.map((m) => m.name)).toEqual(["on disk", "also on disk"]);
    expect(split.noArchive.map((m) => m.name)).toEqual(["no record", "no path", "gone"]);
  });
});

describe("describeRemoveConfirm", () => {
  const targets = [{ name: "Kept" }, { name: "Gone" }];

  it("promises a reinstall from Downloads only when every archive is there", () => {
    const text = describeRemoveConfirm({ targets, noArchive: [], stillNeeded: [] });
    expect(text).toContain("Each one's archive stays in Downloads, so it can be installed again");
    expect(text).not.toContain("NO ARCHIVE");
  });

  it("lists the mods with no archive separately and does not promise them a reinstall", () => {
    const text = describeRemoveConfirm({ targets, noArchive: [{ name: "Gone" }], stillNeeded: [] });
    expect(text).not.toContain("Each one's archive stays in Downloads");
    expect(text).toContain("1 of them keep their archive in Downloads");
    expect(text).toMatch(/NO ARCHIVE ON DISK — cannot be reinstalled offline[^\n]*\n {2}• Gone/);
  });

  it("says plainly when none of them can come back offline", () => {
    const text = describeRemoveConfirm({ targets, noArchive: targets, stillNeeded: [] });
    expect(text).toContain("None of them has its archive in Downloads, so none can be reinstalled offline");
  });

  it("still names what depends on them", () => {
    const text = describeRemoveConfirm({
      targets,
      noArchive: [],
      stillNeeded: [{ provider: { name: "Kept" }, dependants: [{ name: "Needs Kept" }] }],
    });
    expect(text).toContain("STILL NEEDED: Kept by Needs Kept.");
  });
});
