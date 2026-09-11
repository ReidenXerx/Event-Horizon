/**
 * The resume is the point: a 10 GB package on a home connection is
 * interrupted more often than not, and a downloader that starts over is one
 * nobody finishes. So the server here honours Range, and the tests break
 * the transfer on purpose and check that the second run picks up the rest
 * and still hashes the whole file.
 *
 * The resume is also the danger: a part continued with bytes of a DIFFERENT
 * file hashes to something, installs as something, and is wrong. So the
 * other half of these tests changes the file between attempts, lies about
 * offsets, and runs two downloads at once, and checks the result is always
 * exactly one file.
 */
import { createHash } from "crypto";
import { EventEmitter } from "events";
import * as fs from "fs";
import * as http from "http";
import * as os from "os";
import * as path from "path";

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const logged = vi.hoisted(() => [] as Array<{ level: string; event: string; data?: Record<string, unknown> }>);
vi.mock("../logging/ehLog", () => ({
  ehLog: (level: string, event: string, data?: Record<string, unknown>): void => {
    logged.push({ level, event, ...(data !== undefined ? { data } : {}) });
  },
}));

import { downloadToFile, probeFileName, type RequestImpl } from "./downloadDirect";

const BODY = Buffer.alloc(300_000);
for (let i = 0; i < BODY.length; i += 1) BODY[i] = (i * 7 + (i >> 8)) & 0xff;
const BODY_SHA = createHash("sha256").update(BODY).digest("hex");
const OTHER = Buffer.alloc(300_000);
for (let i = 0; i < OTHER.length; i += 1) OTHER[i] = (i * 13 + 5) & 0xff;
const OTHER_SHA = createHash("sha256").update(OTHER).digest("hex");

let server: http.Server;
let base = "";
let tmp = "";
/** Per-test knobs the handler reads. */
const knobs = {
  ignoreRange: false,
  cutAfter: undefined as number | undefined,
  body: BODY,
  etag: '"v1"' as string | undefined,
  honorIfRange: true,
  /** Answer a Range with 206 of the WHOLE file, Content-Range starting at 0. */
  wrongStart: false,
  /** Many servers send no validator on a 206; then only If-Range protects the part. */
  validatorOn206: true,
};
const hits = new Map<string, number>();

function resetKnobs(): void {
  knobs.ignoreRange = false;
  knobs.cutAfter = undefined;
  knobs.body = BODY;
  knobs.etag = '"v1"';
  knobs.honorIfRange = true;
  knobs.wrongStart = false;
  knobs.validatorOn206 = true;
}

beforeAll(async () => {
  tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), "eh-dl-"));
  server = http.createServer((req, res) => {
    const url = (req.url ?? "").split("?")[0];
    hits.set(url, (hits.get(url) ?? 0) + 1);
    if (url === "/html") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "content-length": "34" });
      res.end("<html>rate limited, captcha</html>");
      return;
    }
    if (url === "/hang") {
      return; // never answers
    }
    if (url === "/stall") {
      res.writeHead(200, { "content-length": String(BODY.length), etag: '"v1"' });
      res.write(BODY.subarray(0, 1000));
      return;
    }
    if (url.startsWith("/redirect/")) {
      const n = Number(url.slice("/redirect/".length));
      res.writeHead(302, { location: n > 1 ? `/redirect/${n - 1}` : "/file.ehcoll" });
      res.end();
      return;
    }
    if (url === "/named") {
      // A share host: the URL says nothing, the header names the file.
      const probe = /bytes=(\d+)-(\d+)/.exec(req.headers.range ?? "");
      res.writeHead(probe ? 206 : 200, {
        "content-disposition": 'attachment; filename="meridia-panties-1.0.15.ehcoll"',
        ...(probe ? { "content-range": `bytes 0-0/${BODY.length}` } : {}),
      });
      res.end(probe ? BODY.subarray(0, 1) : BODY);
      return;
    }
    if (url === "/missing") {
      res.writeHead(404, "Not Found");
      res.end("nope");
      return;
    }
    if (url === "/stall-once" && hits.get(url) === 1) {
      // Sends a head of the file and then nothing, holding the socket open.
      res.writeHead(200, { "content-length": String(BODY.length), etag: '"v1"' });
      res.write(BODY.subarray(0, 50_000));
      return;
    }
    const body = url === "/other.ehcoll" ? OTHER : knobs.body;
    const validator = knobs.etag !== undefined ? { etag: knobs.etag } : {};
    let range = knobs.ignoreRange ? undefined : /bytes=(\d+)-/.exec(req.headers.range ?? "");
    const ifRange = req.headers["if-range"];
    if (range && knobs.honorIfRange && typeof ifRange === "string" && ifRange !== knobs.etag) range = undefined;
    if (range && knobs.wrongStart) {
      res.writeHead(206, {
        "content-range": `bytes 0-${body.length - 1}/${body.length}`,
        "content-length": String(body.length),
        ...validator,
      });
      res.end(body);
      return;
    }
    const from = range ? Number(range[1]) : 0;
    if (from >= body.length) {
      res.writeHead(416, { "content-range": `bytes */${body.length}` });
      res.end();
      return;
    }
    const slice = body.subarray(from);
    const cut = knobs.cutAfter !== undefined ? slice.subarray(0, knobs.cutAfter) : slice;
    if (from > 0) {
      res.writeHead(206, {
        "content-range": `bytes ${from}-${body.length - 1}/${body.length}`,
        "content-length": String(slice.length),
        ...(knobs.validatorOn206 ? validator : {}),
      });
    } else {
      res.writeHead(200, { "content-length": String(body.length), ...validator });
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
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
  await fs.promises.rm(tmp, { recursive: true, force: true });
});

/** A first run that the server cuts short, leaving a part and its record. */
async function cutRun(url: string, dest: string, after = 100_000): Promise<number> {
  knobs.cutAfter = after;
  let message = "";
  try {
    await downloadToFile({ url, destPath: dest });
  } catch (err) {
    message = (err as Error).message;
  }
  knobs.cutAfter = undefined;
  const m = /closed after (\d+) of 300000 bytes/.exec(message);
  expect(m, message).not.toBeNull();
  return Number(m?.[1]);
}

describe("downloadToFile", () => {
  beforeEach(() => {
    resetKnobs();
    logged.length = 0;
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
    await expect(fs.promises.stat(`${dest}.part.json`)).rejects.toBeTruthy();
  });

  it("continues a cut transfer from where it stopped, and the hash is of the whole file", async () => {
    const dest = path.join(tmp, "two.ehcoll");
    // How much reaches the client before the server drops the socket is the
    // kernel's business, not the test's: the claim is that the message and
    // the part on disk agree, and that the rest arrives on the next run.
    const landed = await cutRun(`${base}/file.ehcoll`, dest);
    expect(landed).toBeGreaterThan(0);
    expect(landed).toBeLessThan(BODY.length);
    expect((await fs.promises.stat(`${dest}.part`)).size).toBe(landed);

    const got = await downloadToFile({ url: `${base}/file.ehcoll`, destPath: dest });
    expect(got.resumed).toBe(true);
    expect(got.size).toBe(BODY.length);
    expect(got.sha256).toBe(BODY_SHA);
    expect((await fs.promises.readFile(dest)).equals(BODY)).toBe(true);
  });

  it("does not stitch: a file that changed between attempts arrives whole (If-Range)", async () => {
    const dest = path.join(tmp, "changed.ehcoll");
    await cutRun(`${base}/file.ehcoll`, dest);
    knobs.body = OTHER;
    knobs.etag = '"v2"';
    // Its 206 would carry no tag to compare: If-Range is the only guard.
    knobs.validatorOn206 = false;
    const got = await downloadToFile({ url: `${base}/file.ehcoll`, destPath: dest });
    expect(got.sha256).toBe(OTHER_SHA);
    expect(got.resumed).toBe(false);
  });

  it("does not stitch when the server ignores If-Range but names a new version", async () => {
    const dest = path.join(tmp, "changed2.ehcoll");
    await cutRun(`${base}/file.ehcoll`, dest);
    knobs.body = OTHER;
    knobs.etag = '"v2"';
    knobs.honorIfRange = false;
    const got = await downloadToFile({ url: `${base}/file.ehcoll`, destPath: dest });
    expect(got.sha256).toBe(OTHER_SHA);
    expect(logged.some((l) => l.event === "link.direct.restart")).toBe(true);
  });

  it("does not continue a part that was downloaded from a different link", async () => {
    const dest = path.join(tmp, "otherlink.ehcoll");
    await cutRun(`${base}/file.ehcoll`, dest);
    // Same version tag, different file: only the recorded link tells them apart.
    const got = await downloadToFile({ url: `${base}/other.ehcoll`, destPath: dest });
    expect(got.sha256).toBe(OTHER_SHA);
    const discarded = logged.find((l) => l.event === "link.direct.part-discarded");
    expect(String(discarded?.data?.why)).toMatch(/different link/);
  });

  it("does not continue a part nothing records the origin of", async () => {
    const dest = path.join(tmp, "orphan.ehcoll");
    await fs.promises.writeFile(`${dest}.part`, Buffer.alloc(100_000, 0xee));
    const got = await downloadToFile({ url: `${base}/file.ehcoll`, destPath: dest });
    expect(got.sha256).toBe(BODY_SHA);
    expect(got.resumed).toBe(false);
  });

  it("does not continue from a server that names no version for the file", async () => {
    const dest = path.join(tmp, "novalidator.ehcoll");
    knobs.etag = undefined;
    await cutRun(`${base}/file.ehcoll`, dest);
    const got = await downloadToFile({ url: `${base}/file.ehcoll`, destPath: dest });
    expect(got.resumed).toBe(false);
    expect(got.sha256).toBe(BODY_SHA);
  });

  it("starts over, not appends, when the server ignores the Range", async () => {
    const dest = path.join(tmp, "three.ehcoll");
    await fs.promises.writeFile(`${dest}.part`, Buffer.alloc(5000, 1));
    await fs.promises.writeFile(`${dest}.part.json`, JSON.stringify({ url: `${base}/file.ehcoll`, etag: '"v1"' }));
    knobs.ignoreRange = true;
    const got = await downloadToFile({ url: `${base}/file.ehcoll`, destPath: dest });
    expect(got.resumed).toBe(false);
    expect(got.sha256).toBe(BODY_SHA);
  });

  it("does not append a 206 that starts somewhere other than the end of the part", async () => {
    const dest = path.join(tmp, "wrongstart.ehcoll");
    await cutRun(`${base}/file.ehcoll`, dest);
    knobs.wrongStart = true;
    const got = await downloadToFile({ url: `${base}/file.ehcoll`, destPath: dest });
    expect(got.size).toBe(BODY.length);
    expect(got.sha256).toBe(BODY_SHA);
  });

  it("treats a part that is exactly the recorded file as done", async () => {
    const dest = path.join(tmp, "four.ehcoll");
    await fs.promises.writeFile(`${dest}.part`, BODY);
    await fs.promises.writeFile(
      `${dest}.part.json`,
      JSON.stringify({ url: `${base}/file.ehcoll`, etag: '"v1"', total: BODY.length }),
    );
    const got = await downloadToFile({ url: `${base}/file.ehcoll`, destPath: dest });
    expect(got.resumed).toBe(true);
    expect(got.sha256).toBe(BODY_SHA);
  });

  it("does not take a 416 as done when the part is not the size the server states", async () => {
    const dest = path.join(tmp, "oversized.ehcoll");
    await fs.promises.writeFile(`${dest}.part`, Buffer.alloc(450_000, 0x5a));
    await fs.promises.writeFile(`${dest}.part.json`, JSON.stringify({ url: `${base}/file.ehcoll`, etag: '"v1"' }));
    const got = await downloadToFile({ url: `${base}/file.ehcoll`, destPath: dest });
    expect(got.size).toBe(BODY.length);
    expect(got.sha256).toBe(BODY_SHA);
  });

  it("a second run on the same file waits for the first to let go of the part", async () => {
    const dest = path.join(tmp, "lock.ehcoll");
    const first = new AbortController();
    let sawBytes!: () => void;
    const bytesArrived = new Promise<void>((r) => {
      sawBytes = r;
    });
    const run1 = downloadToFile({
      url: `${base}/stall-once`,
      destPath: dest,
      signal: first.signal,
      onProgress: () => sawBytes(),
    });
    await bytesArrived;
    const run2 = downloadToFile({ url: `${base}/stall-once`, destPath: dest });
    await new Promise((r) => setTimeout(r, 300));
    expect(hits.get("/stall-once")).toBe(1);
    first.abort();
    await expect(run1).rejects.toMatchObject({ name: "AbortError" });
    const got = await run2;
    expect(got.sha256).toBe(BODY_SHA);
  });

  it("follows redirects", async () => {
    const dest = path.join(tmp, "five.ehcoll");
    const got = await downloadToFile({ url: `${base}/redirect/3`, destPath: dest });
    expect(got.sha256).toBe(BODY_SHA);
  });

  it("refuses a plain http link that leaves this machine, before any request", async () => {
    let requests = 0;
    const request = ((): never => {
      requests += 1;
      throw new Error("must not be called");
    }) as unknown as RequestImpl;
    await expect(
      downloadToFile({ url: "http://files.example.com/pkg.ehcoll", destPath: path.join(tmp, "http.ehcoll"), request }),
    ).rejects.toThrow(/Plain http/);
    expect(requests).toBe(0);
  });

  it("refuses an https link that redirects to plain http", async () => {
    const asked: string[] = [];
    // A fake transport: the https "server" answers 302 to an http address.
    const request: RequestImpl = (url, _options, onResponse) => {
      asked.push(url);
      const req = new EventEmitter() as EventEmitter & { end: () => void; destroy: () => void };
      req.destroy = (): void => undefined;
      req.end = (): void => {
        const res = Object.assign(new EventEmitter(), {
          statusCode: 302,
          headers: { location: "http://cdn.example.com/pkg.ehcoll" },
          resume: () => undefined,
        });
        onResponse(res as never);
      };
      return req as never;
    };
    await expect(
      downloadToFile({ url: "https://files.example.com/pkg.ehcoll", destPath: path.join(tmp, "down.ehcoll"), request }),
    ).rejects.toThrow(/from https to plain http/);
    expect(asked).toEqual(["https://files.example.com/pkg.ehcoll"]);
  });

  it("names the HTTP status when the link is dead", async () => {
    const dest = path.join(tmp, "six.ehcoll");
    await expect(downloadToFile({ url: `${base}/missing`, destPath: dest })).rejects.toThrow(/HTTP 404/);
  });

  it("names the host and path of a failing link, never its signed query", async () => {
    const dest = path.join(tmp, "signed.ehcoll");
    const err = await downloadToFile({ url: `${base}/missing?token=secret&expires=1`, destPath: dest }).catch((e: Error) => e);
    expect((err as Error).message).toMatch(/\/missing/);
    expect((err as Error).message).not.toMatch(/secret/);
  });

  it("refuses a web page before opening the part or touching a finished file of the same name", async () => {
    const dest = path.join(tmp, "page.ehcoll");
    await fs.promises.writeFile(dest, "GOOD");
    await expect(downloadToFile({ url: `${base}/html`, destPath: dest })).rejects.toThrow(/web page \(text\/html\)/);
    expect(await fs.promises.readFile(dest, "utf8")).toBe("GOOD");
    await expect(fs.promises.stat(`${dest}.part`)).rejects.toBeTruthy();
  });

  it("reports a write failure as the disk's error, not a dropped connection", async () => {
    const dest = path.join(tmp, "eisdir.ehcoll");
    await fs.promises.mkdir(`${dest}.part`, { recursive: true });
    const err = (await downloadToFile({ url: `${base}/file.ehcoll`, destPath: dest }).catch((e: unknown) => e)) as NodeJS.ErrnoException;
    expect(err.code, err.message).toMatch(/^E[A-Z]+$/);
    expect(err.message).not.toMatch(/connection closed/);
  });

  it("checks the drive's free space against the size before writing", async () => {
    const dest = path.join(tmp, "nospace.ehcoll");
    await expect(
      downloadToFile({ url: `${base}/file.ehcoll`, destPath: dest, freeBytes: async () => 1000 }),
    ).rejects.toThrow(/Not enough disk space/);
    await expect(fs.promises.stat(`${dest}.part`)).rejects.toBeTruthy();
  });

  it("turns a server that goes quiet into the resumable interruption, not an endless wait", async () => {
    const dest = path.join(tmp, "stall.ehcoll");
    const run = downloadToFile({ url: `${base}/stall`, destPath: dest, idleTimeoutMs: 200 });
    const settled = await Promise.race([
      run.then(
        () => "resolved",
        (e: Error) => e.message,
      ),
      new Promise<string>((r) => setTimeout(() => r("still waiting"), 3000)),
    ]);
    expect(settled).toMatch(/Nothing arrived for 200 ms after 1000 of 300000 bytes\. Paste the link again to continue/);
    expect((await fs.promises.stat(`${dest}.part`)).size).toBe(1000);
  });

  it("gives up probing a server that never answers", async () => {
    const settled = await Promise.race([
      probeFileName(`${base}/hang`, undefined, undefined, 200).then((v) => ({ v })),
      new Promise<string>((r) => setTimeout(() => r("still waiting"), 3000)),
    ]);
    expect(settled).toEqual({ v: undefined });
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
    const record = JSON.parse(await fs.promises.readFile(`${dest}.part.json`, "utf8")) as { url: string };
    expect(record.url).toBe(`${base}/file.ehcoll`);
  });

  it("logs where a run starts and what the server answered, without the link's query", async () => {
    const dest = path.join(tmp, "logged.ehcoll");
    await downloadToFile({ url: `${base}/file.ehcoll?token=secret`, destPath: dest });
    const start = logged.find((l) => l.event === "link.direct.start");
    const response = logged.find((l) => l.event === "link.direct.response");
    expect(start?.data).toMatchObject({ partSize: 0, resumeFrom: 0 });
    expect(response?.data).toMatchObject({ status: 200, redirects: 0 });
    expect(JSON.stringify(logged)).not.toMatch(/secret/);
  });
});
