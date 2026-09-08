/**
 * Writing into someone's game configuration. The merge has to leave everything
 * it was not asked to change exactly as it found it — comments, ordering, the
 * user's own hand-tuned keys — because a collection states a starting
 * configuration, it does not own the file.
 */
import { describe, expect, it } from "vitest";

import {
  describeIniChanges,
  mergeIniText,
  shouldApplyGameIni,
} from "./applyGameIni";

const lf = (...lines: string[]) => lines.join("\n");

describe("mergeIniText", () => {
  it("changes the value in place and reports before → after", () => {
    const out = mergeIniText(lf("[General]", "uGridsToLoad=5"), [
      { section: "General", key: "uGridsToLoad", value: "7" },
    ]);
    expect(out.text).toBe(lf("[General]", "uGridsToLoad=7"));
    expect(out.changed).toEqual([
      { section: "General", key: "uGridsToLoad", before: "5", after: "7" },
    ]);
  });

  it("leaves comments, blank lines and unrelated keys untouched", () => {
    // The reason this is a merge and not a rewrite: a parsed model round-trip
    // would silently discard every one of these.
    const original = lf(
      "; hand-tuned, do not lose me",
      "[General]",
      "uGridsToLoad=5",
      "",
      "; my own note",
      "sMyOwnSetting=keep",
    );
    const out = mergeIniText(original, [
      { section: "General", key: "uGridsToLoad", value: "7" },
    ]);
    expect(out.text).toBe(original.replace("uGridsToLoad=5", "uGridsToLoad=7"));
  });

  it("reports a key already at the wanted value as unchanged, not as applied", () => {
    const out = mergeIniText(lf("[A]", "k=v"), [{ section: "A", key: "k", value: "v" }]);
    expect(out.changed).toEqual([]);
    expect(out.unchanged).toBe(1);
  });

  it("appends a missing key under its existing section", () => {
    const out = mergeIniText(lf("[General]", "existing=1", "[Display]", "other=2"), [
      { section: "General", key: "added", value: "9" },
    ]);
    expect(out.text).toBe(
      lf("[General]", "existing=1", "added=9", "[Display]", "other=2"),
    );
    expect(out.changed).toEqual([
      { section: "General", key: "added", after: "9" },
    ]);
  });

  it("creates a section that does not exist at all", () => {
    const out = mergeIniText(lf("[General]", "k=v"), [
      { section: "Papyrus", key: "iMinMemoryPageSize", value: "256" },
    ]);
    expect(out.text).toBe(
      lf("[General]", "k=v", "", "[Papyrus]", "iMinMemoryPageSize=256"),
    );
  });

  it("rewrites the LAST duplicate — the one the game reads", () => {
    // Rewriting an earlier duplicate changes nothing while reporting that it
    // did, which is the worst of both.
    const out = mergeIniText(lf("[A]", "k=1", "k=2"), [
      { section: "A", key: "k", value: "9" },
    ]);
    expect(out.text).toBe(lf("[A]", "k=1", "k=9"));
    expect(out.changed[0]!.before).toBe("2");
  });

  it("matches section and key case-insensitively, keeping the user's spelling", () => {
    const out = mergeIniText(lf("[display]", "iSize W = 1920"), [
      { section: "Display", key: "isize w", value: "2560" },
    ]);
    // The user wrote the key with that spacing; only the value moves.
    expect(out.text).toBe(lf("[display]", "iSize W = 2560"));
  });

  it("preserves CRLF line endings", () => {
    // Windows INI files are CRLF, and rewriting them as LF makes every line
    // of a diff look changed.
    const out = mergeIniText("[A]\r\nk=1\r\n", [{ section: "A", key: "k", value: "2" }]);
    expect(out.text).toContain("\r\n");
    expect(out.text).not.toMatch(/[^\r]\n/);
  });

  it("does not touch a key of the same name in a different section", () => {
    const out = mergeIniText(lf("[A]", "k=1", "[B]", "k=2"), [
      { section: "B", key: "k", value: "9" },
    ]);
    expect(out.text).toBe(lf("[A]", "k=1", "[B]", "k=9"));
  });

  it("applies several sections in one pass without corrupting offsets", () => {
    const out = mergeIniText(
      lf("[A]", "a=1", "[B]", "b=1", "[C]", "c=1"),
      [
        { section: "A", key: "newA", value: "x" },
        { section: "C", key: "newC", value: "z" },
        { section: "B", key: "b", value: "9" },
      ],
    );
    expect(out.text).toBe(
      lf("[A]", "a=1", "newA=x", "[B]", "b=9", "[C]", "c=1", "newC=z"),
    );
  });

  it("does nothing to a file when there is nothing to assign", () => {
    const original = lf("[A]", "k=v");
    expect(mergeIniText(original, []).text).toBe(original);
  });
});

describe("describeIniChanges", () => {
  it("says what changed and what was added, per file", () => {
    const said = describeIniChanges("Fallout4Custom.ini", [
      { section: "General", key: "uGridsToLoad", before: "5", after: "7" },
      { section: "Papyrus", key: "iMinMemoryPageSize", after: "256" },
    ]);
    expect(said[0]).toBe("Fallout4Custom.ini [General] uGridsToLoad: 5 → 7");
    expect(said[1]).toBe("Fallout4Custom.ini [Papyrus] iMinMemoryPageSize = 256 (added)");
  });
});

describe("applyGameIni (writes real files)", () => {
  const setup = async () => {
    const fs = await import("fs");
    const os = await import("os");
    const path = await import("path");
    const docs = fs.mkdtempSync(path.join(os.tmpdir(), "eh-apply-"));
    const dir = path.join(docs, "My Games", "Fallout4");
    fs.mkdirSync(dir, { recursive: true });
    return { fs, path, docs, dir };
  };

  it("writes the collection's settings and reports each one", async () => {
    const { fs, path, docs, dir } = await setup();
    const { applyGameIni } = await import("./applyGameIni");
    fs.writeFileSync(
      path.join(dir, "Fallout4.ini"),
      ["; keep me", "[General]", "uGridsToLoad=5"].join("\n"),
    );

    const receipt = await applyGameIni({
      gameId: "fallout4",
      documentsPath: docs,
      gameIni: {
        files: [
          {
            fileName: "Fallout4.ini",
            settings: [{ section: "General", key: "uGridsToLoad", value: "7" }],
          },
        ],
      },
    });

    expect(receipt.appliedCount).toBe(1);
    expect(receipt.changes[0]).toMatch(/uGridsToLoad: 5 → 7/);
    const written = fs.readFileSync(path.join(dir, "Fallout4.ini"), "utf8");
    expect(written).toContain("uGridsToLoad=7");
    expect(written).toContain("; keep me");
    fs.rmSync(docs, { recursive: true, force: true });
  });

  it("refuses to write a machine key even if one reaches it", async () => {
    // Capture already drops these. This is the last point before someone
    // else's screen resolution lands in their file, so it checks again.
    const { fs, path, docs, dir } = await setup();
    const { applyGameIni } = await import("./applyGameIni");
    fs.writeFileSync(path.join(dir, "Fallout4Prefs.ini"), ["[Display]", "iSize W=2560"].join("\n"));

    const receipt = await applyGameIni({
      gameId: "fallout4",
      documentsPath: docs,
      gameIni: {
        files: [
          {
            fileName: "Fallout4Prefs.ini",
            settings: [{ section: "Display", key: "iSize W", value: "1920" }],
          },
        ],
      },
    });

    expect(receipt.appliedCount).toBe(0);
    expect(fs.readFileSync(path.join(dir, "Fallout4Prefs.ini"), "utf8")).toContain("iSize W=2560");
    fs.rmSync(docs, { recursive: true, force: true });
  });

  it("creates a Custom.ini that does not exist yet", async () => {
    const { fs, path, docs, dir } = await setup();
    const { applyGameIni } = await import("./applyGameIni");
    const receipt = await applyGameIni({
      gameId: "fallout4",
      documentsPath: docs,
      gameIni: {
        files: [
          {
            fileName: "Fallout4Custom.ini",
            settings: [{ section: "Papyrus", key: "iMinMemoryPageSize", value: "256" }],
          },
        ],
      },
    });
    expect(receipt.appliedCount).toBe(1);
    expect(fs.readFileSync(path.join(dir, "Fallout4Custom.ini"), "utf8")).toContain(
      "iMinMemoryPageSize=256",
    );
    fs.rmSync(docs, { recursive: true, force: true });
  });
});

describe("shouldApplyGameIni", () => {
  const gameIni = {
    files: [{ fileName: "Fallout4.ini", settings: [{ section: "A", key: "k", value: "v" }] }],
  };

  it("applies on a first install", () => {
    expect(shouldApplyGameIni({ gameIni, packageVersion: "1.0.0" })).toBe(true);
  });

  it("does NOT re-apply the same version — the user may have changed it since", () => {
    // The whole reason the receipt records this. A second apply would silently
    // revert whatever they set afterwards.
    expect(
      shouldApplyGameIni({
        gameIni,
        packageVersion: "1.0.0",
        previous: { packageVersion: "1.0.0", gameIniApplication: { appliedCount: 3 } },
      }),
    ).toBe(false);
  });

  it("applies again for a NEW version — that is what an update means", () => {
    expect(
      shouldApplyGameIni({
        gameIni,
        packageVersion: "1.1.0",
        previous: { packageVersion: "1.0.0", gameIniApplication: { appliedCount: 3 } },
      }),
    ).toBe(true);
  });

  it("applies when an earlier install of this version never got to the settings", () => {
    expect(
      shouldApplyGameIni({
        gameIni,
        packageVersion: "1.0.0",
        previous: { packageVersion: "1.0.0" },
      }),
    ).toBe(true);
  });

  it("does nothing when the collection ships no settings", () => {
    expect(shouldApplyGameIni({ gameIni: undefined, packageVersion: "1.0.0" })).toBe(false);
    expect(shouldApplyGameIni({ gameIni: { files: [] }, packageVersion: "1.0.0" })).toBe(false);
  });
});

describe("once per version, and the projection that has to carry it", () => {
  /**
   * `shouldApplyGameIni` promises, in the user-facing text right below it,
   * that settings are "done once per version and never re-applied". The guard
   * read `previous.gameIniApplication`, the parameter was typed `unknown`, and
   * `PreviousCollectionInstall` — the only thing ever passed to it — had no
   * such field. So it compared `undefined !== undefined`, was always false,
   * and every re-run of the same release rewrote the user's INI and reverted
   * every edit they had made since. The one behaviour the comment calls
   * unforgivable, guarded by a check that could not fire.
   *
   * These test the RULE and the PROJECTION separately, because the rule was
   * always right — it was the data path that was empty.
   */
  const gameIni = { files: [{ path: "Skyrim.ini", settings: [] }] } as never;
  const applied = {
    appliedCount: 3,
    alreadyMatchedCount: 0,
    changes: [],
    failed: [],
  };

  it("applies when nothing was installed before", () => {
    expect(shouldApplyGameIni({ gameIni, packageVersion: "1.0.0" })).toBe(true);
  });

  it("does NOT re-apply for a version that already applied them", () => {
    expect(
      shouldApplyGameIni({
        gameIni,
        packageVersion: "1.0.0",
        previous: { packageVersion: "1.0.0", gameIniApplication: applied },
      }),
    ).toBe(false);
  });

  it("applies again for a NEW version", () => {
    expect(
      shouldApplyGameIni({
        gameIni,
        packageVersion: "1.0.1",
        previous: { packageVersion: "1.0.0", gameIniApplication: applied },
      }),
    ).toBe(true);
  });

  it("applies when the previous run SKIPPED them", () => {
    // A stop past the deploy records no `gameIniApplication` at all, which is
    // what keeps "running the install again picks them up" true. Recording a
    // zeroed receipt there would suppress the settings permanently.
    expect(
      shouldApplyGameIni({
        gameIni,
        packageVersion: "1.0.0",
        previous: { packageVersion: "1.0.0" },
      }),
    ).toBe(true);
  });

  it("carries gameIniApplication through previousInstallFromReceipt", async () => {
    /**
     * The half that was actually missing. Testing the rule alone would have
     * stayed green for the entire time the bug existed, because the rule was
     * never wrong — nothing ever handed it the field.
     */
    const { previousInstallFromReceipt } = await import(
      "../resolver/userState"
    );
    const projected = previousInstallFromReceipt({
      packageId: "p",
      packageVersion: "1.0.0",
      installedAt: "2026-01-01T00:00:00.000Z",
      mods: [],
      gameIniApplication: applied,
    } as never);
    expect(projected?.gameIniApplication).toEqual(applied);

    // And absence stays absence, so a skipped run does not read as applied.
    const withoutIt = previousInstallFromReceipt({
      packageId: "p",
      packageVersion: "1.0.0",
      installedAt: "2026-01-01T00:00:00.000Z",
      mods: [],
    } as never);
    expect(withoutIt?.gameIniApplication).toBeUndefined();
  });
});
