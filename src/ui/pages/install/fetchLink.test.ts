/**
 * The link route end to end on a loopback server: the published checksum
 * travels from the parsed link into the download and out as the receipt the
 * screens show. A checksum that is parsed and then dropped on the way is the
 * failure this guards — the log said "downloaded", and nothing was compared.
 *
 * The Nexus half runs against a fake of Vortex's Nexus surface (`api.ext`
 * and the downloads slice of state), because that is the boundary Event
 * Horizon actually talks to; the bytes behind it are real files and a real
 * HTTP server.
 */
import { createHash } from "crypto";
import * as fs from "fs";
import * as http from "http";
import * as os from "os";
import * as path from "path";
import * as zlib from "zlib";

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const hoisted = vi.hoisted(() => ({
  root: "",
  logged: [] as Array<{ level: string; event: string; data?: Record<string, unknown> }>,
  opened: [] as string[],
}));

vi.mock("../../../core/paths", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getEventHorizonDir: (...segments: string[]): string => path.join(hoisted.root, ...segments),
}));
vi.mock("../../../core/logging/ehLog", () => ({
  ehLog: (level: string, event: string, data?: Record<string, unknown>): void => {
    hoisted.logged.push({ level, event, ...(data !== undefined ? { data } : {}) });
  },
}));
vi.mock("../../../core/revealPath", () => ({
  openExternalUrl: async (url: string): Promise<{ kind: "opened" }> => {
    hoisted.opened.push(url);
    return { kind: "opened" };
  },
}));

import { __testPaths } from "../../../../test/stubs/vortex-api";
import { parseInstallLink, type NexusFileCandidate } from "../../../core/installer/installLink";
import { fetchLink, waitForVortexDownload } from "./fetchLink";

const BODY = Buffer.alloc(200_000);
for (let i = 0; i < BODY.length; i += 1) BODY[i] = (i * 31 + 7) & 0xff;
const BODY_SHA = createHash("sha256").update(BODY).digest("hex");

let server: http.Server;
let base = "";
let vortexDownloads = "";

beforeAll(async () => {
  hoisted.root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "eh-fetchlink-"));
  vortexDownloads = path.join(hoisted.root, "vortex-downloads");
  await fs.promises.mkdir(vortexDownloads, { recursive: true });
  __testPaths.downloadPath = vortexDownloads;
  server = http.createServer((req, res) => {
    const range = /bytes=(\d+)-(\d*)/.exec(req.headers.range ?? "");
    if (range !== null && range[2] === "0") {
      res.writeHead(206, {
        "content-disposition": 'attachment; filename="ivy-panties-1.0.19.ehcoll"',
        "content-range": `bytes 0-0/${BODY.length}`,
      });
      res.end(BODY.subarray(0, 1));
      return;
    }
    res.writeHead(200, { "content-length": String(BODY.length), etag: '"x"' });
    res.end(BODY);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

afterAll(async () => {
  __testPaths.downloadPath = "/stub/downloads";
  await new Promise<void>((r) => server.close(() => r()));
  await fs.promises.rm(hoisted.root, { recursive: true, force: true });
});

beforeEach(async () => {
  hoisted.logged.length = 0;
  hoisted.opened.length = 0;
  // Each run downloads afresh; a finished file from an earlier test is not the subject here.
  await fs.promises.rm(path.join(hoisted.root, "downloads"), { recursive: true, force: true });
});

const api = {} as never;
const events = { onPhase: (): void => undefined };

function parsed(input: string): Exclude<ReturnType<typeof parseInstallLink>, { kind: "invalid" }> {
  const link = parseInstallLink(input);
  if (link.kind === "invalid") throw new Error(link.why);
  return link;
}

describe("fetchLink, direct route", () => {
  it("holds the file to the link's #sha256= and hands the verdict to the screens", async () => {
    const outcome = await fetchLink(api, parsed(`${base}/pkg#sha256=${BODY_SHA}`), new AbortController().signal, events);
    expect(outcome).toMatchObject({
      kind: "file",
      receipt: { fileName: "ivy-panties-1.0.19.ehcoll", size: BODY.length, sha256: BODY_SHA, verified: "match" },
    });
  });

  it("refuses a file that does not match, and nothing reaches the package path", async () => {
    const wrong = "0".repeat(64);
    await expect(
      fetchLink(api, parsed(`${base}/pkg#sha256=${wrong}`), new AbortController().signal, events),
    ).rejects.toMatchObject({ name: "ChecksumMismatchError" });
    await expect(fs.promises.stat(path.join(hoisted.root, "downloads", "ivy-panties-1.0.19.ehcoll"))).rejects.toBeTruthy();
    await expect(fs.promises.stat(path.join(hoisted.root, "downloads", "ivy-panties-1.0.19.ehcoll.part"))).rejects.toBeTruthy();
  });

  it("says unverified, in the receipt and in the log, when the link carries no checksum", async () => {
    const outcome = await fetchLink(api, parsed(`${base}/pkg`), new AbortController().signal, events);
    expect(outcome).toMatchObject({ kind: "file", receipt: { sha256: BODY_SHA, verified: "unverified" } });
    expect(hoisted.logged.find((l) => l.event === "install.link.unverified")?.data).toMatchObject({ sha256: BODY_SHA });
  });
});

/** A one-entry stored zip, the way a curator's link file is built. */
function linkZip(name: string, text: string): Buffer {
  const data = Buffer.from(text, "utf8");
  const nameBytes = Buffer.from(name, "utf8");
  const crc = zlib.crc32(data);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(0x800, 6);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(data.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(nameBytes.length, 26);
  const dir = Buffer.alloc(46);
  dir.writeUInt32LE(0x02014b50, 0);
  dir.writeUInt16LE(20, 4);
  dir.writeUInt16LE(20, 6);
  dir.writeUInt16LE(0x800, 8);
  dir.writeUInt32LE(crc, 16);
  dir.writeUInt32LE(data.length, 20);
  dir.writeUInt32LE(data.length, 24);
  dir.writeUInt16LE(nameBytes.length, 28);
  const cdSize = 46 + nameBytes.length;
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(cdSize, 12);
  end.writeUInt32LE(30 + nameBytes.length + data.length, 16);
  return Buffer.concat([local, nameBytes, data, dir, nameBytes, end]);
}

/**
 * Vortex as far as the link route sees it: an active game, the games it has
 * extensions for, a Nexus file listing, and a download that lands a real file
 * in its download folder.
 */
function fakeVortex(opts: {
  activeGameId: string;
  files: NexusFileCandidate[];
  onDownload?: (fileName: string) => Buffer;
}): { api: never; downloadsAsked: number[] } {
  const downloads: Record<string, unknown> = {};
  const downloadsAsked: number[] = [];
  const state = {
    settings: { profiles: { activeGameId: opts.activeGameId } },
    session: {
      gameMode: {
        known: [
          { id: "fallout4", name: "Fallout 4" },
          { id: "skyrimse", name: "Skyrim Special Edition" },
          { id: "skyrimvr", name: "Skyrim VR" },
        ],
      },
    },
    persistent: { downloads: { files: downloads } },
  };
  const fake = {
    getState: () => state,
    ext: {
      nexusGetModFiles: async (): Promise<NexusFileCandidate[]> => opts.files,
      nexusDownload: async (_game: string, _mod: number, fileId: number, fileName: string): Promise<string> => {
        downloadsAsked.push(fileId);
        const bytes = opts.onDownload?.(fileName) ?? Buffer.alloc(0);
        await fs.promises.writeFile(path.join(vortexDownloads, fileName), bytes);
        downloads[`dl-${fileId}`] = { id: `dl-${fileId}`, state: "finished", localPath: fileName, received: bytes.length, size: bytes.length };
        return `dl-${fileId}`;
      },
    },
  };
  return { api: fake as never, downloadsAsked };
}

describe("fetchLink, Nexus route", () => {
  const landingFiles: NexusFileCandidate[] = [
    { file_id: 11, file_name: "ivy-panties-link.zip", category_name: "MAIN" },
    { file_id: 9, file_name: "ivy-panties-link-old.zip", category_name: "OLD_VERSION" },
  ];

  it("follows a landing page's link file to the package, held to the file's checksum", async () => {
    const vortex = fakeVortex({
      activeGameId: "fallout4",
      files: landingFiles,
      onDownload: () => linkZip("link.txt", `Paste this link: ${base}/pkg\nSHA-256: ${BODY_SHA}\n`),
    });
    const outcome = await fetchLink(
      vortex.api,
      parsed("https://www.nexusmods.com/fallout4/mods/108944"),
      new AbortController().signal,
      events,
    );
    expect(vortex.downloadsAsked).toEqual([11]);
    expect(outcome).toMatchObject({ kind: "file", receipt: { sha256: BODY_SHA, verified: "match" } });
    expect(hoisted.logged.find((l) => l.event === "install.link.carrier-read")?.data).toMatchObject({
      fileId: 11,
      sha256: BODY_SHA,
    });
  });

  it("refuses the package when it is not the one the link file's checksum names", async () => {
    const vortex = fakeVortex({
      activeGameId: "fallout4",
      files: landingFiles,
      onDownload: () => linkZip("link.txt", `${base}/pkg\n${"a".repeat(64)}\n`),
    });
    await expect(
      fetchLink(vortex.api, parsed("https://www.nexusmods.com/fallout4/mods/108944"), new AbortController().signal, events),
    ).rejects.toMatchObject({ name: "ChecksumMismatchError" });
  });

  it("names the game to switch to, as Vortex names it", async () => {
    const vortex = fakeVortex({ activeGameId: "fallout4", files: [] });
    await expect(
      fetchLink(
        vortex.api,
        parsed("https://www.nexusmods.com/skyrimspecialedition/mods/191460"),
        new AbortController().signal,
        events,
      ),
    ).rejects.toThrow("This collection is for Skyrim Special Edition or Skyrim VR, and Vortex is managing Fallout 4.");
  });

  it("asks for the specific file's link when several packages are equally likely", async () => {
    const vortex = fakeVortex({
      activeGameId: "fallout4",
      files: [
        { file_id: 1, file_name: "a.ehcoll", category_name: "MAIN", uploaded_timestamp: 1 },
        { file_id: 2, file_name: "b.ehcoll", category_name: "MAIN", uploaded_timestamp: 2 },
      ],
    });
    await expect(
      fetchLink(vortex.api, parsed("https://www.nexusmods.com/fallout4/mods/108944"), new AbortController().signal, events),
    ).rejects.toThrow(/2 files that could be the collection/);
    expect(vortex.downloadsAsked).toEqual([]);
  });
});

describe("waitForVortexDownload", () => {
  const stateWith = (files: () => Record<string, unknown>): never =>
    ({ getState: () => ({ persistent: { downloads: { files: files() } } }) }) as never;

  it("stops waiting, and says why, when the download is paused in Vortex", async () => {
    const api = stateWith(() => ({ d: { id: "d", state: "paused", received: 5 } }));
    await expect(
      waitForVortexDownload(api, "d", new AbortController().signal, () => undefined, { pollMs: 5 }),
    ).rejects.toThrow(/paused in Vortex's Downloads tab/);
  });

  it("stops waiting when the download is removed from Vortex's list", async () => {
    let polls = 0;
    const api = stateWith(() => {
      polls += 1;
      return polls < 3 ? { d: { id: "d", state: "started", received: 1 } } : {};
    });
    await expect(
      waitForVortexDownload(api, "d", new AbortController().signal, () => undefined, { pollMs: 5 }),
    ).rejects.toThrow(/removed from Vortex's Downloads tab/);
  });

  it("stops waiting for a download Vortex never lists", async () => {
    const api = stateWith(() => ({}));
    await expect(
      waitForVortexDownload(api, "d", new AbortController().signal, () => undefined, { pollMs: 5, appearWithinMs: 30 }),
    ).rejects.toThrow(/never listed/);
  });
});
