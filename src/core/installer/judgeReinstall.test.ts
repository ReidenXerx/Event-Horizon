/**
 * `verifyModInstall` compares two disks — the user's staging and the curator's
 * — and cannot tell "your install went wrong" from "the curator's copy was
 * modified after extraction". Measured on a real 993-mod profile, about ELEVEN
 * PERCENT of mods are the second case: BA2 repacking, plugin cleaning,
 * runtime-generated config. Every one of them was being uninstalled,
 * reinstalled, compared against the same post-processed reference, failed
 * again, and recorded as broken.
 *
 * The archive is the reference no one's extraction can corrupt. These tests
 * pin the one question this module answers: could a reinstall possibly change
 * the outcome?
 */
import * as crypto from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { judgeReinstall } from "./judgeReinstall";
import { crc32 } from "../manifest/readZip";
import { writeStoredZip } from "../manifest/storedZip.testutil";
import type { SevenZipApi } from "../manifest/sevenZip";

let dir: string;
let staging: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "eh-judge-"));
  staging = path.join(dir, "staging");
  fs.mkdirSync(staging, { recursive: true });
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const hex = (n: number): string => (n >>> 0).toString(16).padStart(8, "0");

/** Write a user-side staged file and report what an archive listing would say. */
const stage = (rel: string, contents: string): { size: number; crc: string } => {
  const p = path.join(staging, ...rel.split("/"));
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, contents);
  return { size: Buffer.byteLength(contents), crc: hex(crc32(Buffer.from(contents))) };
};

/** A 7z whose `list` reports exactly the entries given. */
const listing = (
  entries: Array<{ path: string; size: number; crc?: string }>,
): SevenZipApi =>
  ({
    list: async (
      _a: string,
      _o: unknown,
      progress?: (batch: unknown[]) => void,
    ) => {
      // The real SevenZipListEntry shape: `name`, numeric `size`, `attr`.
      // My first attempt invented `file`/`attributes`/stringified size, every
      // entry parsed to nothing, and all five interesting cases came back
      // "undecidable" — a fake that agrees with an imagined API tests the
      // imagination.
      progress?.(
        entries.map((e) => ({
          name: e.path,
          size: e.size,
          ...(e.crc !== undefined ? { crc: e.crc } : {}),
          attr: "A",
        })),
      );
      return { type: "7z" };
    },
    add: async () => ({ code: 0 }),
    extractFull: async () => ({ code: 0 }),
  }) as unknown as SevenZipApi;

const archivePath = "/pretend/mod.7z";

describe("the case that was costing ~11% of every install", () => {
  it("does NOT reinstall when the user's file is exactly what the archive holds", async () => {
    // The curator repacked their BA2 after installing. The user's file differs
    // from the curator's copy and matches the archive — so it is what a clean
    // install produces, and reinstalling reproduces precisely what is there.
    const f = stage("Textures.ba2", "the archive's original bytes");
    const judgement = await judgeReinstall({
      missingFiles: [],
      differingPaths: ["Textures.ba2"],
      stagingRoot: staging,
      archivePath,
      sevenZip: listing([{ path: "Textures.ba2", size: f.size, crc: f.crc }]),
    });
    expect(judgement.kind).toBe("curator-diverged");
  });

  it("matches by CONTENT, not by path — a FOMOD renames on install", async () => {
    // `<file source destination>` means the staged path routinely has no
    // counterpart in the archive. Its bytes do. Matching on path would send
    // every FOMOD mod down the reinstall branch.
    const f = stage("Data/Meshes/thing.nif", "identical bytes");
    const judgement = await judgeReinstall({
      missingFiles: [],
      differingPaths: ["Data/Meshes/thing.nif"],
      stagingRoot: staging,
      archivePath,
      sevenZip: listing([
        { path: "optional/00 Core/thing.nif", size: f.size, crc: f.crc },
      ]),
    });
    expect(judgement.kind).toBe("curator-diverged");
  });
});

describe("what still warrants a reinstall", () => {
  it("a missing file always does, whatever the archive says", async () => {
    // Content mutation does not affect PRESENCE, so the curator's staging
    // stays the right reference for omissions even on a post-processed setup.
    // This is the failure the project exists to catch; never explain it away.
    const judgement = await judgeReinstall({
      missingFiles: ["Data/lost.esp"],
      differingPaths: [],
      stagingRoot: staging,
      archivePath,
      sevenZip: listing([{ path: "Data/lost.esp", size: 10, crc: "aaaaaaaa" }]),
    });
    expect(judgement.kind).toBe("reinstall");
    expect(judgement.why).toMatch(/absent/);
  });

  it("a file matching NEITHER reference does", async () => {
    stage("Data/thing.esp", "bytes that are in no archive");
    const judgement = await judgeReinstall({
      missingFiles: [],
      differingPaths: ["Data/thing.esp"],
      stagingRoot: staging,
      archivePath,
      sevenZip: listing([
        { path: "Data/thing.esp", size: 999, crc: "deadbeef" },
      ]),
    });
    expect(judgement.kind).toBe("reinstall");
  });

  it("refuses to explain away a MIXED result", async () => {
    // One file explained and one not is not a pass. Skipping the repair
    // because most of the mod looked fine is how a real omission survives.
    const ok = stage("good.bin", "in the archive");
    stage("bad.bin", "in no archive");
    const judgement = await judgeReinstall({
      missingFiles: [],
      differingPaths: ["good.bin", "bad.bin"],
      stagingRoot: staging,
      archivePath,
      sevenZip: listing([{ path: "good.bin", size: ok.size, crc: ok.crc }]),
    });
    expect(judgement.kind).toBe("reinstall");
  });

  it("does not accept size agreement alone as an explanation", async () => {
    // Acting on `size-only` means SKIPPING a repair, and same-size-different-
    // bytes is exactly what a truncated or corrupted file looks like.
    //
    // The listing must carry SOME crc, or this passes through the
    // "no checksums at all" guard instead and proves nothing about the rule
    // it names — which is how the first version of this test passed while
    // counting size-only as explained.
    const f = stage("thing.bin", "aaaaaaaaaa");
    const judgement = await judgeReinstall({
      missingFiles: [],
      differingPaths: ["thing.bin"],
      stagingRoot: staging,
      archivePath,
      sevenZip: listing([
        // Carries a crc, so withCrc > 0 and the guard does not fire.
        { path: "unrelated.bin", size: 4242, crc: "abcdabcd" },
        // Our file's size, but no crc — the size-only case exactly.
        { path: "thing.bin", size: f.size },
      ]),
    });
    expect(judgement.kind).toBe("reinstall");
  });
});

describe("the driver actually asks before it reinstalls", () => {
  // Source assertions: the verify loop needs a live Vortex. That is exactly
  // why classifyVerification — the sibling of this module, written and tested
  // long before today — sat unreferenced by anything but its own test while
  // the driver reinstalled ~11% of every collection for no reason. It has
  // since been deleted: this module is what replaced it, and these
  // assertions are what stop the replacement going the same way.
  const driver = async (): Promise<string> => {
    const fsm = await import("fs");
    const pathm = await import("path");
    return fsm.readFileSync(pathm.join(__dirname, "runInstall.ts"), "utf8");
  };

  it("consults the archive BEFORE spending a reinstall", async () => {
    const src = await driver();
    const judged = src.indexOf("await judgeReinstall(");
    const recover = src.indexOf("await tryRecoverFailedMod(");
    expect(judged).toBeGreaterThan(-1);
    expect(recover).toBeGreaterThan(-1);
    // After the reinstall it would still be true, and still useless.
    expect(judged).toBeLessThan(recover);
  });

  it("skips the reinstall on a curator-diverged verdict", async () => {
    const src = await driver();
    expect(src).toMatch(/judgement\.kind === "curator-diverged"/);
    // `continue` is what makes it a skip rather than a note on the way to
    // reinstalling anyway.
    const branch = src.slice(src.indexOf('judgement.kind === "curator-diverged"'));
    expect(branch.slice(0, branch.indexOf("}\n\n"))).toContain("continue;");
  });

  it("logs the verdict, so a remote install can be explained", async () => {
    const src = await driver();
    expect(src).toMatch(/"verify\.judged"/);
  });
});

describe("when it cannot tell, it says so and reinstalls", () => {
  it("no archive to consult", async () => {
    stage("thing.bin", "x");
    const judgement = await judgeReinstall({
      missingFiles: [],
      differingPaths: ["thing.bin"],
      stagingRoot: staging,
      archivePath: undefined,
    });
    expect(judgement.kind).toBe("undecidable");
    expect(judgement.why).toMatch(/could not be located/);
  });

  it("7z will not run — the machine this whole investigation started on", async () => {
    stage("thing.bin", "x");
    const broken = {
      list: async () => {
        throw new Error("spawn 7z.exe ENOENT");
      },
    } as unknown as SevenZipApi;
    const judgement = await judgeReinstall({
      missingFiles: [],
      differingPaths: ["thing.bin"],
      stagingRoot: staging,
      archivePath,
      sevenZip: broken,
    });
    // Undecidable, NOT "fine" — an absent second opinion is not a clean bill
    // of health, and the caller reinstalls exactly as it did before.
    expect(judgement.kind).toBe("undecidable");
  });

  it("a listing with no checksums at all", async () => {
    const f = stage("thing.bin", "x");
    const judgement = await judgeReinstall({
      missingFiles: [],
      differingPaths: ["thing.bin"],
      stagingRoot: staging,
      archivePath,
      sevenZip: listing([{ path: "thing.bin", size: f.size }]),
    });
    expect(judgement.kind).toBe("undecidable");
    expect(judgement.why).toMatch(/no checksums/);
  });

  it("a file that vanished between verifying and judging", async () => {
    const judgement = await judgeReinstall({
      missingFiles: [],
      differingPaths: ["never-written.bin"],
      stagingRoot: staging,
      archivePath,
      sevenZip: listing([{ path: "never-written.bin", size: 1, crc: "aaaaaaaa" }]),
    });
    expect(judgement.kind).toBe("reinstall");
  });

  it("never throws, whatever it is handed", async () => {
    // It runs inside the verify loop of a 954-mod install. An exception here
    // would turn a diagnostic nicety into a failed install.
    await expect(
      judgeReinstall({
        missingFiles: [],
        differingPaths: ["x"],
        stagingRoot: "/does/not/exist",
        archivePath,
        sevenZip: listing([]),
      }),
    ).resolves.toBeDefined();
  });
});

/**
 * MICROSCOPE PASS 1 — this check was reachable only through 7z.
 *
 * The whole point of judging is to stop ~11% of a collection being reinstalled
 * for nothing. Routing it exclusively through 7z meant that on a prefix where
 * 7z will not run — the platform this entire investigation started on — every
 * mismatch fell to "undecidable", which reinstalls. The saving evaporated
 * precisely where it was needed most, and nothing would have reported it.
 *
 * A large share of mod archives are ZIPs and we own a reader for those.
 */
describe("a ZIP archive is read natively, with no 7z at all", () => {
  /** A 7z that cannot run — what a broken Wine prefix actually looks like. */
  const brokenSevenZip = (): SevenZipApi =>
    ({
      list: () => {
        throw new Error("7z: cannot execute binary in this prefix");
      },
      add: async () => ({ code: 0 }),
      extractFull: async () => ({ code: 0 }),
    }) as unknown as SevenZipApi;

  it("explains a divergence from a .zip when 7z is completely dead", async () => {
    // Before this, the same input answered "undecidable" — and undecidable
    // reinstalls, which is the waste the module exists to prevent.
    stage("Textures/rock.dds", "the bytes a clean install produces");
    const zip = path.join(dir, "mod.zip");
    writeStoredZip(zip, [
      { name: "Textures/rock.dds", body: "the bytes a clean install produces" },
    ]);

    const judgement = await judgeReinstall({
      missingFiles: [],
      differingPaths: ["Textures/rock.dds"],
      stagingRoot: staging,
      archivePath: zip,
      sevenZip: brokenSevenZip(),
    });

    expect(judgement.kind).toBe("curator-diverged");
    if (judgement.kind === "curator-diverged") {
      expect(judgement.explained).toBe(1);
    }
  });

  it("still says reinstall when the zip does not contain those bytes", async () => {
    // The native path must not become a rubber stamp: a real defect still has
    // to survive it, or the fix would have replaced waste with silence.
    stage("Textures/rock.dds", "corrupted on the way in");
    const zip = path.join(dir, "mod.zip");
    writeStoredZip(zip, [
      { name: "Textures/rock.dds", body: "what the archive actually holds" },
    ]);

    const judgement = await judgeReinstall({
      missingFiles: [],
      differingPaths: ["Textures/rock.dds"],
      stagingRoot: staging,
      archivePath: zip,
      sevenZip: brokenSevenZip(),
    });

    expect(judgement.kind).toBe("reinstall");
  });

  it("reads the zip itself even when a working 7z disagrees", async () => {
    // Precedence, proven by making the two sources answer differently: 7z is
    // handed a listing that explains nothing, the zip on disk explains
    // everything. A "curator-diverged" here can only have come from the zip.
    stage("Meshes/thing.nif", "identical to the archive");
    const zip = path.join(dir, "mod.zip");
    writeStoredZip(zip, [
      { name: "Meshes/thing.nif", body: "identical to the archive" },
    ]);

    const judgement = await judgeReinstall({
      missingFiles: [],
      differingPaths: ["Meshes/thing.nif"],
      stagingRoot: staging,
      archivePath: zip,
      sevenZip: listing([{ path: "Meshes/thing.nif", size: 1, crc: "deadbeef" }]),
    });

    expect(judgement.kind).toBe("curator-diverged");
  });

  it("falls back to 7z for a .7z, which the native reader cannot parse", async () => {
    // The other half of the split: .7z and .rar remain 7z's job. The fallback
    // has to actually fire, not just exist.
    const f = stage("Data/thing.esp", "curator repacked this");
    const notAZip = path.join(dir, "mod.7z");
    fs.writeFileSync(notAZip, Buffer.from("7z\xbc\xaf\x27\x1c not a zip at all"));

    const judgement = await judgeReinstall({
      missingFiles: [],
      differingPaths: ["Data/thing.esp"],
      stagingRoot: staging,
      archivePath: notAZip,
      sevenZip: listing([{ path: "Data/thing.esp", size: f.size, crc: f.crc }]),
    });

    expect(judgement.kind).toBe("curator-diverged");
  });

  it("is undecidable when the archive is neither a zip nor readable by 7z", async () => {
    // Both routes gone. Undecidable reinstalls — the behaviour that existed
    // before any of this, which is the right floor.
    stage("Data/thing.esp", "whatever");
    const notAZip = path.join(dir, "mod.rar");
    fs.writeFileSync(notAZip, Buffer.from("Rar! not really"));

    const judgement = await judgeReinstall({
      missingFiles: [],
      differingPaths: ["Data/thing.esp"],
      stagingRoot: staging,
      archivePath: notAZip,
      sevenZip: brokenSevenZip(),
    });

    expect(judgement.kind).toBe("undecidable");
  });
});
