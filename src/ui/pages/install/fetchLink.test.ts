/**
 * The link route end to end on a loopback server: the published checksum
 * travels from the parsed link into the download and out as the receipt the
 * screens show. A checksum that is parsed and then dropped on the way is the
 * failure this guards — the log said "downloaded", and nothing was compared.
 */
import { createHash } from "crypto";
import * as fs from "fs";
import * as http from "http";
import * as os from "os";
import * as path from "path";

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const hoisted = vi.hoisted(() => ({
  root: "",
  logged: [] as Array<{ level: string; event: string; data?: Record<string, unknown> }>,
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

import { parseInstallLink } from "../../../core/installer/installLink";
import { fetchLink } from "./fetchLink";

const BODY = Buffer.alloc(200_000);
for (let i = 0; i < BODY.length; i += 1) BODY[i] = (i * 31 + 7) & 0xff;
const BODY_SHA = createHash("sha256").update(BODY).digest("hex");

let server: http.Server;
let base = "";

beforeAll(async () => {
  hoisted.root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "eh-fetchlink-"));
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
  await new Promise<void>((r) => server.close(() => r()));
  await fs.promises.rm(hoisted.root, { recursive: true, force: true });
});

beforeEach(() => {
  hoisted.logged.length = 0;
});

const api = {} as never;
const events = { onPhase: (): void => undefined };

function direct(input: string): Exclude<ReturnType<typeof parseInstallLink>, { kind: "invalid" }> {
  const link = parseInstallLink(input);
  if (link.kind === "invalid") throw new Error(link.why);
  return link;
}

describe("fetchLink, direct route", () => {
  it("holds the file to the link's #sha256= and hands the verdict to the screens", async () => {
    const outcome = await fetchLink(api, direct(`${base}/pkg#sha256=${BODY_SHA}`), new AbortController().signal, events);
    expect(outcome).toMatchObject({
      kind: "file",
      receipt: { fileName: "ivy-panties-1.0.19.ehcoll", size: BODY.length, sha256: BODY_SHA, verified: "match" },
    });
  });

  it("refuses a file that does not match, and nothing reaches the package path", async () => {
    const wrong = "0".repeat(64);
    await expect(
      fetchLink(api, direct(`${base}/pkg#sha256=${wrong}`), new AbortController().signal, events),
    ).rejects.toMatchObject({ name: "ChecksumMismatchError" });
    await expect(fs.promises.stat(path.join(hoisted.root, "downloads", "ivy-panties-1.0.19.ehcoll.part"))).rejects.toBeTruthy();
  });

  it("says unverified, in the receipt and in the log, when the link carries no checksum", async () => {
    const outcome = await fetchLink(api, direct(`${base}/pkg`), new AbortController().signal, events);
    expect(outcome).toMatchObject({ kind: "file", receipt: { sha256: BODY_SHA, verified: "unverified" } });
    expect(hoisted.logged.find((l) => l.event === "install.link.unverified")?.data).toMatchObject({ sha256: BODY_SHA });
  });
});
