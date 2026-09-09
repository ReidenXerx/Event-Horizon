/**
 * The last rung of the escalation ladder, and it is only worth having because
 * the rungs beneath it removed the noise: a mod reaches here having failed
 * against the curator's staging, failed against its ARCHIVE, and survived a
 * reinstall. The ~11% of mods whose curator-side files were merely
 * post-processed are settled earlier and never produce one of these.
 *
 * So the properties worth pinning are about what a curator will DO with it —
 * and about the two ways a report like this goes wrong: accusing someone on
 * evidence that does not support it, and leaking something the sender would
 * have wanted to redact before pasting it in public.
 */
import { describe, expect, it } from "vitest";

import { buildCuratorReport, type CuratorReportInput } from "./curatorReport";

const base = (over: Partial<CuratorReportInput> = {}): CuratorReportInput => ({
  packageName: "Ivy 2",
  packageVersion: "1.0.9",
  packageSha256: "a9730587fc7ce7f68086ed39ab483e7f94b26369726911da2f708f1f360bfc3c",
  modName: "Point Lookout",
  modCompareKey: "nexus:1234:567890",
  modVersion: "2.1",
  missingFiles: ["Data/PointLookout.esm"],
  differingFiles: ["Data/Textures/rock.dds"],
  extraFiles: [],
  attempts: ["Reinstalled from the downloaded archive", "Re-downloaded the archive"],
  platform: "win32 (Wine/Proton)",
  ...over,
});

describe("it never claims a check that did not happen", () => {
  // The report's whole worth is that a stranger can trust it. It used to state
  // "and they do not match its archive either" unconditionally — but the
  // archive can be missing, unreadable, or on a prefix where 7z will not run,
  // and the verdict for MISSING files is reached before the archive is opened
  // at all. Asserting the comparison anyway sends a curator to investigate
  // something nobody did.
  it("says the archive check is MISSING, not failed, when it did not run", () => {
    const text = buildCuratorReport(base({ archiveChecked: false }));
    expect(text).toMatch(/not possible to compare/i);
    expect(text).toMatch(/missing rather than failed/i);
    expect(text).not.toMatch(/do not match its archive either/i);
  });

  it("treats an ABSENT flag as 'not checked'", () => {
    // The weaker claim must be the default. An omitted field must never be
    // able to manufacture the stronger one.
    const input = base();
    delete (input as { archiveChecked?: boolean }).archiveChecked;
    expect(buildCuratorReport(input)).toMatch(/not possible to compare/i);
  });

  it("makes the strong claim only when the archive really was read", () => {
    const text = buildCuratorReport(base({ archiveChecked: true }));
    expect(text).toMatch(/do not match its archive either/i);
    expect(text).not.toMatch(/not possible to compare/i);
  });
});

describe("what the curator needs to act", () => {
  it("names which build this is, not just which collection", () => {
    // A curator with two packages in circulation otherwise has to guess, and
    // the answer changes what the whole report means.
    const text = buildCuratorReport(base());
    expect(text).toContain("Ivy 2 v1.0.9");
    expect(text).toContain("a9730587");
  });

  it("carries a machine-readable mod id, not only a display name", () => {
    // Two mods can share a name. `nexus:1234:567890` is the thing a curator
    // can look up.
    expect(buildCuratorReport(base())).toContain("nexus:1234:567890");
  });

  it("says what was already tried, so nobody suggests it again", () => {
    // The first reply to any bug report is "have you reinstalled". Answering
    // it in advance is most of the value of an automated report.
    const text = buildCuratorReport(base());
    expect(text).toContain("Reinstalled from the downloaded archive");
    expect(text).toContain("Re-downloaded the archive");
  });

  it("reports the platform, because Proton changes the answer", () => {
    expect(buildCuratorReport(base())).toContain("Wine/Proton");
  });
});

describe("what it must not claim", () => {
  it("does not accuse the mod of being broken", () => {
    // The evidence does not support it: the archive may have been re-uploaded
    // under the same file id, or this machine may be altering files. An
    // accusation sends the curator to check the wrong thing first.
    const text = buildCuratorReport(base());
    expect(text).toMatch(/does NOT prove the mod is broken/);
  });

  it("still states the consequence plainly", () => {
    // Refusing to accuse must not become refusing to say anything. The useful
    // half is that other users will most likely hit the same thing.
    const text = buildCuratorReport(base());
    expect(text).toMatch(/anyone else installing it will most likely see the same/);
  });

  it("labels extra files as often harmless", () => {
    // Different FOMOD answers produce these legitimately. A bare list of
    // "extra files" reads as damage.
    const text = buildCuratorReport(base({ extraFiles: ["Data/optional.esp"] }));
    expect(text).toMatch(/often harmless/i);
  });
});

describe("it has to survive being pasted somewhere public", () => {
  it("contains no absolute paths from the user's machine", () => {
    // Staging paths routinely contain a real name. The report is pasted into
    // Discord and Nexus comments by people who will not read it first.
    const text = buildCuratorReport(base());
    expect(text).not.toMatch(/[A-Za-z]:\\/);
    expect(text).not.toMatch(/\/home\/[^\s]+/);
    expect(text).not.toMatch(/\/Users\/[^\s]+/);
  });

  it("uses no markdown fences", () => {
    // A fenced block pasted into a Nexus comment box arrives as literal
    // backticks. The one thing this must do is survive an unknown destination.
    expect(buildCuratorReport(base())).not.toContain("```");
  });

  it("stays short when a mod has hundreds of bad files", () => {
    // "Every path" is unpastable and unreadable. A cap plus a count says the
    // same thing in a form somebody will actually send.
    const many = Array.from({ length: 400 }, (_, i) => `Data/file${i}.dds`);
    const text = buildCuratorReport(base({ differingFiles: many }));
    expect(text).toContain("Different (400)");
    expect(text).toMatch(/and 392 more/);
    expect(text.split("\n").length).toBeLessThan(60);
  });
});

describe("the driver actually produces one, and only at the end of the ladder", () => {
  // Source assertions: the verify loop needs a live Vortex. The failure this
  // guards is a report generator that exists and is never called — the same
  // shape as classifyVerification, which sat unreferenced while the driver
  // reinstalled ~11% of every collection for nothing.
  const driver = async (): Promise<string> => {
    const fs = await import("fs");
    const path = await import("path");
    return fs.readFileSync(path.join(__dirname, "runInstall.ts"), "utf8");
  };

  it("is built only AFTER the reinstall has been tried and failed", async () => {
    // A report generated before the retry would fire for every mod that a
    // reinstall goes on to fix, which is most of them.
    const src = await driver();
    const recover = src.indexOf("await tryRecoverFailedMod(");
    const report = src.indexOf("buildCuratorReport(");
    expect(recover).toBeGreaterThan(-1);
    expect(report).toBeGreaterThan(report === -1 ? 0 : -1);
    expect(report).toBeGreaterThan(recover);
  });

  it("rides on the result, not on the receipt", async () => {
    // serializeReceipt validates THROUGH parseReceipt, so a field the parser
    // does not know is silently destroyed at write. That bug has already
    // happened once in this codebase.
    const src = await driver();
    expect(src).toMatch(/curatorReports\.length > 0 \? \{ curatorReports \}/);
    const ledger = await (async () => {
      const fs = await import("fs");
      const path = await import("path");
      return fs.readFileSync(path.join(__dirname, "..", "installLedger.ts"), "utf8");
    })();
    expect(ledger).not.toContain("curatorReports");
  });

  it("reports the host as Wine when it is Wine", async () => {
    const src = await driver();
    expect(src).toMatch(/function describeHostForReport/);
    expect(src).toMatch(/looksLikeWine\(\)/);
  });

  it("is actually RENDERED, with a way to copy it", async () => {
    // A report generated into a result field that no screen reads is the same
    // failure as the classifier nothing called — it exists, it is correct, and
    // no human will ever see it. The whole point is that the user can send it.
    const fs = await import("fs");
    const path = await import("path");
    const steps = fs.readFileSync(
      path.join(__dirname, "..", "..", "ui", "pages", "install", "steps.tsx"),
      "utf8",
    );
    expect(steps).toMatch(/<CuratorReportsNotice reports=\{result\.curatorReports/);
    expect(steps).toMatch(/writeToClipboard/);
  });

  it("renders the hand-picked-archive notice too", async () => {
    const fs = await import("fs");
    const path = await import("path");
    const steps = fs.readFileSync(
      path.join(__dirname, "..", "..", "ui", "pages", "install", "steps.tsx"),
      "utf8",
    );
    // Formatting-tolerant on purpose: the claim is "this notice is rendered
    // with this field", not "these two tokens are adjacent". The strict
    // version broke the moment the element gained a `key` and wrapped across
    // lines — a false failure that says nothing about whether the notice
    // reaches the screen.
    expect(steps).toMatch(
      /<ExternalArchiveNotice[\s\S]{0,160}result\.externalArchiveNotice/,
    );
  });
});

describe("degrading gracefully", () => {
  it("omits sections that have nothing in them", () => {
    // A report with three empty headings makes the reader hunt for the one
    // that matters.
    const text = buildCuratorReport(
      base({ missingFiles: [], extraFiles: [], differingFiles: ["a.dds"] }),
    );
    expect(text).not.toContain("Missing (");
    expect(text).not.toContain("Extra (");
    expect(text).toContain("Different (1)");
  });

  it("works without the optional identity fields", () => {
    const text = buildCuratorReport({
      packageName: "X",
      packageVersion: "1",
      modName: "Y",
      modCompareKey: "external:abc",
      missingFiles: [],
      differingFiles: ["a"],
      extraFiles: [],
      attempts: [],
    });
    expect(text).toContain("external:abc");
    expect(text).not.toMatch(/undefined/);
  });

  it("never prints the string 'undefined'", () => {
    // It is pasted verbatim in front of other people.
    const text = buildCuratorReport(base({ modVersion: undefined, platform: undefined }));
    expect(text).not.toMatch(/undefined/);
  });
});

describe("when the user supplied the wrong archive", () => {
  /**
   * A tester's report named 11 differing and 248 extra files and closed with
   * "worth checking whether this mod still downloads the same archive it did
   * when the collection was built" — sending the curator to hunt a Nexus
   * re-upload.
   *
   * The run had already answered it. The file the tester browsed to hashed to
   * 76390867… where the collection recorded 51552edf…, and the install logged
   * both and warned him at the time. A report that asks a question the same
   * run answered wastes the only person who can act on it.
   */
  const withMismatch = (): string =>
    buildCuratorReport({
      packageName: "ivy panties",
      packageVersion: "1.0.13",
      modName: "AAF_darthroman_creature_pack_v1.0.3b",
      modCompareKey: "external:51552edf",
      missingFiles: [],
      differingFiles: ["AAF_DR_creature_pack.esp"],
      extraFiles: ["AAF/DR_pack_furnitureData_DR.xml"],
      attempts: ["Verified against the file list the collection recorded"],
      suppliedArchiveDiffers: {
        expected: "51552edf12182fc8f584ca1ea479622d1ef5b8db86d93b1ed020ca4a2be0b5f4",
        actual: "76390867850b3e1545eada7fd3c08b1968c076d5ad03b2f76f5f3d3f35a32091",
      },
    });

  it("states the cause and prints both hashes", () => {
    const r = withMismatch();
    expect(r).toMatch(/This one is explained/);
    expect(r).toContain("51552edf12182fc8f584ca1ea479622d1ef5b8db86d93b1ed020ca4a2be0b5f4");
    expect(r).toContain("76390867850b3e1545eada7fd3c08b1968c076d5ad03b2f76f5f3d3f35a32091");
  });

  it("stops asking the curator to check for a re-upload", () => {
    // The specific sentence that sent them looking. Its absence is the point.
    expect(withMismatch()).not.toMatch(/still downloads the same archive/);
    expect(withMismatch()).not.toMatch(/may have been re-uploaded/);
  });

  it("says the file lists are a consequence, not a second fault", () => {
    expect(withMismatch()).toMatch(/consequence of that and not a separate fault/);
  });

  it("points at the answer the curator can actually act on", () => {
    // If the original file is gone, bundling or mirroring is the fix.
    expect(withMismatch()).toMatch(/bundling or mirroring/i);
  });

  it("keeps the original wording when the archive was NOT the problem", () => {
    // The overwhelming majority of reports. Losing the re-upload hint for
    // those would trade one wrong answer for another.
    const r = buildCuratorReport({
      packageName: "ivy panties",
      packageVersion: "1.0.13",
      modName: "porcTattoos_2c",
      modCompareKey: "external:staging:ec638def",
      missingFiles: ["Interface/Translations/porcTattoos_en.txt.bak"],
      differingFiles: ["Interface/Translations/porcTattoos_en.txt"],
      extraFiles: [],
      attempts: ["Verified against the file list the collection recorded"],
    });
    expect(r).toMatch(/still downloads the same archive/);
    expect(r).not.toMatch(/This one is explained/);
  });
});

describe("the wiring, not just the report", () => {
  /**
   * Removing the driver's hand-off left all the tests above GREEN. The helper
   * was covered and its call site was not — the same gap that let the
   * deploy-mods argument order survive 200 tests, and the reason this file
   * ends with a source check rather than trusting the unit tests.
   */
  const driver = (): string => {
    const fs = require("fs") as typeof import("fs");
    const path = require("path") as typeof import("path");
    return fs.readFileSync(path.join(__dirname, "runInstall.ts"), "utf8");
  };

  it("hands the mismatch out of every install path", () => {
    const src = driver();
    // Both call sites: the main loop and the post-deploy retry pass. A cause
    // recorded on one and not the other reports differently depending on WHEN
    // the mod installed, which is the worst kind of inconsistency to debug.
    const handoffs = src.match(/onSuppliedArchiveDiffers: \(info\) =>/g) ?? [];
    expect(handoffs.length).toBeGreaterThanOrEqual(2);
  });

  it("feeds it into the curator report", () => {
    expect(driver()).toContain("suppliedArchiveDiffers: suppliedArchiveMismatches.get(");
  });

  it("records it against the compareKey the report is keyed by", () => {
    // Keyed wrong, it would silently never match and the report would revert
    // to speculating — with every test still green.
    expect(driver()).toContain("suppliedArchiveMismatches.has(installEntry.compareKey)");
  });
});
