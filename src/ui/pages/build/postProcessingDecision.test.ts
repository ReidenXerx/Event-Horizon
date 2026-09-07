/**
 * The decision a curator makes about their own edits, and the guard rails on it.
 *
 * The dangerous answer here is not the wrong one, it is the FAST one. "These
 * are all mine" is true for most of the list, one click away, and when wrong
 * it produces a collection that installs cleanly for every user while silently
 * leaving out the files the curator added. Nothing errors. Nothing warns. It
 * reproduces the curator's game except for the parts that made it theirs.
 *
 * So two things get tested: that each answer writes the override that actually
 * makes it true, and that the wording tells the curator what they are doing to
 * somebody else rather than which flag they are setting.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  describeChoice,
  describeDecisionIntro,
  overrideForChoice,
} from "./postProcessingDecision";

describe("what each answer actually writes", () => {
  it("declaring records only the declaration", () => {
    expect(overrideForChoice("declare", { isNexusMod: true })).toEqual({
      postProcessed: true,
      mirrored: false,
      bundled: false,
      dropped: false,
    });
  });

  it("bundling a Nexus mod also marks it external", () => {
    // Bundling is gated on `shipsAsExternal`, and a Nexus mod is not external
    // until `treatAsExternal` says so. Setting `bundled` alone would be a
    // decision the build silently ignores — which this area has already been
    // bitten by once, when treatAsExternal reached the manifest and neither of
    // the two bundling gates had heard of it.
    expect(overrideForChoice("bundle", { isNexusMod: true })).toEqual({
      bundled: true,
      treatAsExternal: true,
      mirrored: false,
      postProcessed: false,
      dropped: false,
    });
  });

  it("bundling an already-external mod does not need the flag", () => {
    expect(overrideForChoice("bundle", { isNexusMod: false })).toEqual({
      bundled: true,
      mirrored: false,
      postProcessed: false,
      dropped: false,
    });
  });

  it("never writes both answers at once", () => {
    // They are opposites: one withholds the files, the other ships them.
    for (const isNexusMod of [true, false]) {
      const declare = overrideForChoice("declare", { isNexusMod });
      const bundle = overrideForChoice("bundle", { isNexusMod });
      // Explicitly false rather than absent: the patch is MERGED onto an
      // existing entry, so a changed verdict has to overwrite the old flag,
      // not merely omit it.
      expect(declare.bundled).toBe(false);
      expect(bundle.postProcessed).toBe(false);
    }
  });
});

describe("the wording a curator decides from", () => {
  it("describes each answer by what users end up with", () => {
    // Not "mark as post-processed" — that describes a checkbox. A curator can
    // have an opinion about what a user receives; they cannot have one about a
    // field name.
    const declare = describeChoice("declare", 1608);
    expect(declare.consequence).toMatch(/users install/i);
    expect(declare.consequence).toContain("1608 files");

    const bundle = describeChoice("bundle", 1608);
    expect(bundle.consequence).toMatch(/users get/i);
  });

  it("gives concrete examples of when each is right", () => {
    // "Is this deliberate?" is answerable with yes by anyone. "Is this a
    // tool's log, or LOD output?" is not.
    expect(describeChoice("declare", 3).consequence).toMatch(
      /log|backup|cache|ini/i,
    );
    expect(describeChoice("bundle", 3).consequence).toMatch(/patch|lod/i);
    expect(describeChoice("mirror", 3).consequence).toMatch(/clean|ini/i);
  });

  it("never points LOD output at declaring it", () => {
    // The correction that cost a real collection its LODs. Output from
    // xLODGen or DynDOLOD is generated from the curator's exact mod list and
    // load order; a user installing the collection cannot regenerate it, so
    // declaring it ships a world with no LODs and nothing anywhere says so.
    const declare = describeChoice("declare", 1608).consequence;
    expect(declare).not.toMatch(/right for[^.]*(xlodgen|dyndolod)/i);
    // And it says the opposite out loud, because the wrong answer here is
    // the one a curator reaches for by default.
    expect(declare).toMatch(/not for lod/i);
  });

  it("points LOD output at shipping it instead", () => {
    expect(describeChoice("bundle", 1608).consequence).toMatch(
      /xlodgen|dyndolod/i,
    );
  });

  it("still says what declaring costs, whichever example is given", () => {
    expect(describeChoice("declare", 3).consequence).toMatch(/no worse off/i);
  });

  it("says bundling costs download size, so the choice is informed", () => {
    expect(describeChoice("bundle", 3).consequence).toMatch(/bigger|size/i);
  });

  it("singularises, because a report that says '1 files' gets trusted less", () => {
    expect(describeChoice("declare", 1).consequence).toContain("your 1 file.");
  });
});

describe("the intro that frames the question", () => {
  it("asks about users, not about intent", () => {
    // The first framing was "was this deliberate?", which is answerable with
    // yes for nearly every mod on the list and changes nothing.
    const intro = describeDecisionIntro(3);
    expect(intro.question).toMatch(/installing this collection need them/i);
    expect(intro.question).not.toMatch(/deliberate|intend/i);
  });

  it("states the cost of leaving one unanswered", () => {
    expect(describeDecisionIntro(3).ifIgnored).toMatch(/recorded as broken/i);
  });

  it("warns specifically against answering them all the same way", () => {
    // The load-bearing sentence. Without it the panel is a list of buttons
    // whose fastest path is also its worst outcome.
    const c = describeDecisionIntro(9).caution;
    expect(c).toMatch(/one at a time|look at the file/i);
    expect(c).toMatch(/silently/i);
  });

  it("counts mods correctly in the singular", () => {
    expect(describeDecisionIntro(1).title).toBe("1 mod needs a decision");
    expect(describeDecisionIntro(4).title).toBe("4 mods need a decision");
  });
});

describe("the panel offers no way to answer without looking", () => {
  // A unit test cannot see a rendered page, so this reads the source for the
  // affordances that would undo the design.
  const panel = readFileSync(join(__dirname, "BuildPage.tsx"), "utf8");
  const start = panel.indexOf("function PostProcessingDecisions");
  const end = panel.indexOf("function BuildingPanel");
  const body = panel.slice(start, end);

  it("finds the component it claims to check", () => {
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
  });

  it("has no bulk action", () => {
    // "Mark all as mine" is one line of code and it removes the only thing
    // making this decision real.
    expect(body).not.toMatch(/select all|mark all|applyToAll|apply all/i);
  });

  it("shows the offending paths rather than only a count", () => {
    expect(body).toContain("c.files.map");
  });

  it("says what each path MEANS, not just its name", () => {
    // A bare path cannot answer the question being asked. "Common Clothes and
    // Armors.esp" does not tell the curator whether declaring costs the user
    // that file or merely hands them the archive's copy of it — and those are
    // opposite outcomes wearing the same verdict.
    expect(body).toContain("describeUnexplainedFile(f)");
  });

  it("preselects nothing", () => {
    expect(body).not.toMatch(/defaultChecked|defaultValue/);
  });
});

describe("the declare consequence tells the truth about each kind", () => {
  it("says users go WITHOUT a file the archive does not have", () => {
    const c = describeChoice("declare", 2, { added: 2, changed: 0 });
    expect(c.consequence).toContain("without your 2 files");
  });

  it("says users get the ARCHIVE'S version of a file they changed", () => {
    // The old copy claimed users install "without your 1 file" here, which is
    // false: the archive has that file, so they receive its copy. On a real
    // 1894-mod profile this case was thousands of files.
    const c = describeChoice("declare", 1, { added: 0, changed: 1 });
    expect(c.consequence).toContain("ITS version");
    expect(c.consequence).not.toContain("without your 1 file");
  });

  it("covers both when the mod has some of each", () => {
    const c = describeChoice("declare", 5, { added: 2, changed: 3 });
    expect(c.consequence).toContain("go without the files you added");
    expect(c.consequence).toContain("archive's version of the ones you changed");
  });

  it("stays true when the split is unknown", () => {
    const c = describeChoice("declare", 3);
    expect(c.consequence).toContain("added");
    expect(c.consequence).toContain("changed");
  });
});

describe("the panel heading describes both shapes", () => {
  it("does not claim the archives simply lack these files", () => {
    // Only true of added files. For a changed one the archive HAS it.
    expect(describeDecisionIntro(5).what).not.toContain("do not contain");
  });

  it("names both what users lose and what they get instead", () => {
    const what = describeDecisionIntro(5).what;
    expect(what).toContain("added");
    expect(what).toContain("changed");
  });
});

describe("the mirror choice", () => {
  it("sets only `mirrored`, never treatAsExternal", () => {
    // A mirrored mod is a NORMAL Nexus mod that gets corrected after install.
    // Flagging it external would stop the archive being downloaded at all,
    // which is the one thing this choice exists to preserve — the author's
    // download, and the bytes we then only have to correct rather than carry.
    expect(overrideForChoice("mirror", { isNexusMod: true })).toEqual({
      mirrored: true,
      bundled: false,
      postProcessed: false,
      dropped: false,
    });
    expect(overrideForChoice("mirror", { isNexusMod: false })).toEqual({
      mirrored: true,
      bundled: false,
      postProcessed: false,
      dropped: false,
    });
  });

  it("still bundles as external, so the two stay distinguishable", () => {
    expect(overrideForChoice("bundle", { isNexusMod: true })).toMatchObject({
      bundled: true,
      treatAsExternal: true,
    });
  });

  it("promises the user's folder ends up identical, not that they skip the download", () => {
    const copy = describeChoice("mirror", 3);
    expect(copy.consequence).toContain("still download this mod from Nexus");
    expect(copy.consequence).toContain("identical");
  });
});

describe("the panel offers mirroring first, and only when it works", () => {
  const src = readFileSync(join(__dirname, "BuildPage.tsx"), "utf8");
  const body = src.slice(
    src.indexOf("function PostProcessingDecisions"),
    src.indexOf("function BuildingPanel"),
  );

  it("lists mirror first and DROP last", () => {
    /**
     * Order is the cheapest safety property this screen has. Mirror leads
     * because it is the answer whose worst case is a bigger download; drop
     * trails because it is the only one that does not ship the mod, and a
     * curator clicking down a column of 57 cards should not meet it on the
     * way to the ones that do.
     */
    const order = ["mirror", "declare", "bundle", "drop"].map((k) =>
      body.indexOf(`"${k}"`),
    );
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it("blocks it when the build recorded no hashes to reconcile against", () => {
    expect(body).toContain('k === "mirror" && !c.canMirror');
    expect(body).toContain("Needs a Thorough build");
  });
});

describe("the mirror copy matches what the build actually packs", () => {
  it("does not claim only the differences are carried", () => {
    // `collectMirrorPayload` ships every staged file of a mirrored mod,
    // because the self-check matches on size alone here and a narrower
    // payload could leave the user unable to finish. The copy said the
    // opposite for one render.
    const c = describeChoice("mirror", 12).consequence;
    expect(c).not.toMatch(/only the differences|rather than the whole mod/i);
  });

  it("admits the download gets bigger, like bundling does", () => {
    expect(describeChoice("mirror", 12).consequence).toMatch(/bigger/i);
  });
});


describe("changing a verdict REPLACES it", () => {
  // The defect this pins: these patches were purely additive, which was
  // harmless while an answer could only be given once. The "Change" button
  // made it wrong — `recordPostProcessingDecision` MERGES, and
  // `choiceFromEntry` reads by precedence (bundle > mirror > declare), so
  // answering "declare" on a mod already carrying `mirrored: true` left
  // mirroring in place. The package shipped the whole staging folder the
  // curator had just declined, and the updated fingerprint meant the
  // question never reopened.
  const CHOICES = ["mirror", "declare", "bundle"] as const;

  it("sets exactly one verdict flag and clears the other two", () => {
    for (const choice of CHOICES) {
      const patch = overrideForChoice(choice, { isNexusMod: false }) as Record<
        string,
        unknown
      >;
      const on = (["mirrored", "postProcessed", "bundled"] as const).filter(
        (k) => patch[k] === true,
      );
      expect(on, `choice ${choice} set ${on.join()}`).toHaveLength(1);
    }
  });

  it("overwrites a previous answer when merged the way the recorder merges", () => {
    const merged = {
      ...overrideForChoice("mirror", { isNexusMod: false }),
      ...overrideForChoice("declare", { isNexusMod: false }),
    };
    expect(merged.mirrored).toBe(false);
    expect(merged.postProcessed).toBe(true);
  });
});
