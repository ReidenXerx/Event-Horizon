/**
 * The resume is the point: a 10 GB package on a home connection is
 * interrupted more often than not, and a downloader that starts over is one
 * nobody finishes. So the server here honours Range, and the tests break
 * the transfer on purpose and check that the second run picks up the rest
 * and still hashes the whole file.
 */
import { createHash } from "crypto";
import * as fs from "fs";
import * as http from "http";
import * as os from "os";
import * as path from "path";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { downloadToFile, probeFileName } from "./downloadDirect";

const BODY = Buffer.alloc(300_000);
for (let i = 0; i < BODY.length; i += 1) BODY[i] = (i * 7 + (i >> 8)) & 0xff;
const BODY_SHA = createHash("sha256").update(BODY).digest("hex");

let server: http.Server;
let base = "";
let tmp = "";
/** Per-test knobs the handler reads. */
const knobs = { ignoreRange: false, cutAfter: undefined as number | undefined, redirects: 0 };

beforeAll(async () => {
  tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), "eh-dl-"));
  server = http.createServer((req, res) => {
    if (req.url?.startsWith("/redirect/")) {
      const n = Number(req.url.slice("/redirect/".length));
      res.writeHead(302, { location: n > 1 ? `/redirect/${n - 1}` : "/file.ehcoll" });
      res.end();
      return;
    }
    if (req.url === "/named") {
      // A share host: the URL says nothing, the header names the file.
      const probe = /bytes=(\d+)-(\d+)/.exec(req.headers.range ?? "");
      res.writeHead(probe ? 206 : 200, {
        "content-disposition": 'attachment; filename="meridia-panties-1.0.15.ehcoll"',
        ...(probe ? { "content-range": `bytes 0-0/${BODY.length}` } : {}),
      });
      res.end(probe ? BODY.subarray(0, 1) : BODY);
      return;
    }
    if (req.url === "/missing") {
      res.writeHead(404, "Not Found");
      res.end("nope");
      return;
    }
    const range = knobs.ignoreRange ? undefined : /bytes=(\d+)-/.exec(req.headers.range ?? "");
    const from = range ? Number(range[1]) : 0;
    if (from >= BODY.length) {
      res.writeHead(416, { "content-range": `bytes */${BODY.length}` });
      res.end();
      return;
    }
    const slice = BODY.subarray(from);
    const cut = knobs.cutAfter !== undefined ? slice.subarray(0, knobs.cutAfter) : slice;
    if (from > 0) {
      res.writeHead(206, {
        "content-range": `bytes ${from}-${BODY.length - 1}/${BODY.length}`,
        "content-length": String(slice.length),
      });
    } else {
      res.writeHead(200, { "content-length": String(BODY.length) });
    }
    if (knobs.cutAfter !== undefined) {
      // Drop the connection AFTER the bytes are on the wire; destroying
      // straight away would discard the headers too and look like a dead host.
      res.write(cut, () => res.destroy());
    } else {
      res.end(cut);
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address() as { port: number };
  base = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  await fs.promises.rm(tmp, { recursive: true, force: true });
});

describe("downloadToFile", () => {
  beforeEach(() => {
    knobs.ignoreRange = false;
    knobs.cutAfter = undefined;
  });

  it("downloads, reports progress with the total, and hashes the file", async () => {
    const dest = path.join(tmp, "a", "one.ehcoll");
    const seen: number[] = [];
    let total: number | undefined;
    const got = await downloadToFile({
      url: `${base}/file.ehcoll`,
      destPath: dest,
      onProgress: (p) => {
        seen.push(p.received);
        total = p.total;
      },
    });
    expect(got.size).toBe(BODY.length);
    expect(got.sha256).toBe(BODY_SHA);
    expect(got.resumed).toBe(false);
    expect(total).toBe(BODY.length);
    expect(seen[seen.length - 1]).toBe(BODY.length);
    expect((await fs.promises.readFile(dest)).equals(BODY)).toBe(true);
    await expect(fs.promises.stat(`${dest}.part`)).rejects.toBeTruthy();
  });

  it("continues a cut transfer from where it stopped, and the hash is of the whole file", async () => {
    const dest = path.join(tmp, "two.ehcoll");
    knobs.cutAfter = 100_000;
    // How much reaches the client before the server drops the socket is the
    // kernel's business, not the test's: the claim is that the message and
    // the part on disk agree, and that the rest arrives on the next run.
    let message = "";
    try {
      await downloadToFile({ url: `${base}/file.ehcoll`, destPath: dest });
    } catch (err) {
      message = (err as Error).message;
    }
    const m = /closed after (\d+) of 300000 bytes/.exec(message);
    expect(m, message).not.toBeNull();
    const landed = Number(m?.[1]);
    expect(landed).toBeGreaterThan(0);
    expect(landed).toBeLessThan(BODY.length);
    expect((await fs.promises.stat(`${dest}.part`)).size).toBe(landed);

    knobs.cutAfter = undefined;
    const got = await downloadToFile({ url: `${base}/file.ehcoll`, destPath: dest });
    expect(got.resumed).toBe(true);
    expect(got.size).toBe(BODY.length);
    expect(got.sha256).toBe(BODY_SHA);
    expect((await fs.promises.readFile(dest)).equals(BODY)).toBe(true);
  });

  it("starts over, not appends, when the server ignores the Range", async () => {
    const dest = path.join(tmp, "three.ehcoll");
    await fs.promises.writeFile(`${dest}.part`, Buffer.alloc(5000, 1));
    knobs.ignoreRange = true;
    const got = await downloadToFile({ url: `${base}/file.ehcoll`, destPath: dest });
    knobs.ignoreRange = false;
    expect(got.resumed).toBe(false);
    expect(got.sha256).toBe(BODY_SHA);
  });

  it("treats a part that is already complete as done", async () => {
    const dest = path.join(tmp, "four.ehcoll");
    await fs.promises.writeFile(`${dest}.part`, BODY);
    const got = await downloadToFile({ url: `${base}/file.ehcoll`, destPath: dest });
    expect(got.resumed).toBe(true);
    expect(got.sha256).toBe(BODY_SHA);
  });

  it("follows redirects", async () => {
    const dest = path.join(tmp, "five.ehcoll");
    const got = await downloadToFile({ url: `${base}/redirect/3`, destPath: dest });
    expect(got.sha256).toBe(BODY_SHA);
  });

  it("names the HTTP status when the link is dead", async () => {
    const dest = path.join(tmp, "six.ehcoll");
    await expect(downloadToFile({ url: `${base}/missing`, destPath: dest })).rejects.toThrow(/HTTP 404/);
  });

  it("reads the server's file name with a one-byte probe", async () => {
    expect(await probeFileName(`${base}/named`)).toBe("meridia-panties-1.0.15.ehcoll");
    expect(await probeFileName(`${base}/file.ehcoll`)).toBeUndefined();
    expect(await probeFileName(`${base}/missing`)).toBeUndefined();
  });

  it("cancels with an AbortError and keeps the part for next time", async () => {
    const dest = path.join(tmp, "seven.ehcoll");
    const controller = new AbortController();
    const run = downloadToFile({
      url: `${base}/file.ehcoll`,
      destPath: dest,
      signal: controller.signal,
      onProgress: () => controller.abort(),
    });
    await expect(run).rejects.toMatchObject({ name: "AbortError" });
    const part = await fs.promises.stat(`${dest}.part`);
    expect(part.size).toBeGreaterThan(0);
    expect(part.size).toBeLessThanOrEqual(BODY.length);
  });
});
