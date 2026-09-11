/**
 * The release path's contracts: Vortex's version comparison (a prerelease
 * suffix is invisible to it), the zip Vortex reads, and the Nexus v3 upload
 * sequence — whose presigned PUT is rejected unless Content-Disposition and
 * Content-MD5 match what was declared. The fake Nexus here THROWS on a wrong
 * shape instead of tolerating it.
 */
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { deflateRawSync } from "node:zlib";

import { afterAll, describe, expect, it } from "vitest";

import {
  assertHeaderSafeFilename,
  backoffMs,
  coerceVersion,
  findMainFile,
  isReleasableVersion,
  nexusClient,
  readZipEntry,
  vortexWouldOfferUpdate,
} from "./nexusRelease.mjs";

describe("versions, as Vortex compares them", () => {
  it("coerces like semver.coerce: the prerelease suffix disappears", () => {
    expect(coerceVersion("0.1.0-alpha.150")).toEqual([0, 1, 0]);
    expect(coerceVersion("v2")).toEqual([2, 0, 0]);
    expect(coerceVersion("no digits")).toBeUndefined();
  });

  it("never offers alpha.N → alpha.N+1, and does offer 0.1.151 over alpha.150", () => {
    expect(vortexWouldOfferUpdate("0.1.0-alpha.149", "0.1.0-alpha.150")).toBe(false);
    expect(vortexWouldOfferUpdate("0.1.0-alpha.150", "0.1.151")).toBe(true);
    expect(vortexWouldOfferUpdate("0.1.151", "0.1.151")).toBe(false);
    expect(vortexWouldOfferUpdate("0.1.152", "0.1.151")).toBe(false);
    expect(vortexWouldOfferUpdate(undefined, "0.1.151")).toBe(true);
  });

  it("releases only plain x.y.z", () => {
    expect(isReleasableVersion("0.1.151")).toBe(true);
    expect(isReleasableVersion("0.1.0-alpha.151")).toBe(false);
    expect(isReleasableVersion("0.1")).toBe(false);
  });
});

function zip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, content, deflate] of entries) {
    const raw = Buffer.from(content);
    const data = deflate ? deflateRawSync(raw) : raw;
    const nameBuf = Buffer.from(name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(deflate ? 8 : 0, 8);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    locals.push(local, nameBuf, data);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(deflate ? 8 : 0, 10);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBuf);
    offset += 30 + nameBuf.length + data.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

describe("readZipEntry", () => {
  it("reads info.json at the archive root, stored or deflated", () => {
    const buf = zip([
      ["dist/index.js", "x", true],
      ["info.json", '{"version":"0.1.151"}', true],
      ["assets/a.txt", "y", false],
    ]);
    expect(JSON.parse(readZipEntry(buf, "info.json").toString()).version).toBe("0.1.151");
    expect(readZipEntry(buf, "assets/a.txt").toString()).toBe("y");
  });

  it("does not accept info.json one folder down — Vortex would not either", () => {
    expect(readZipEntry(zip([["event-horizon/info.json", "{}", false]]), "info.json")).toBeUndefined();
  });
});

/** A strict fake of the v3 upload sequence. */
function fakeNexus({ stateSequence = ["created", "available"] } = {}) {
  const calls = [];
  const bytesSeen = {};
  const json = (status, data) => ({ ok: status < 300, status, text: async () => JSON.stringify({ data }) });
  let states = [...stateSequence];
  const fetchImpl = async (url, init) => {
    calls.push(`${init.method} ${url.replace("https://api.nexusmods.com/v3", "")}`);
    if (url.startsWith("https://storage.example/")) {
      const h = init.headers;
      if (h["content-disposition"] !== 'attachment; filename="event-horizon-0.1.151.zip"') throw new Error("bad Content-Disposition");
      if (h["content-md5"] !== bytesSeen.md5b64) throw new Error("bad Content-MD5");
      // Signed by the presigned URL; the live storage rejects any other value.
      if (h["content-type"] !== "application/octet-stream") {
        return { ok: false, status: 403, text: async () => "<Error><Code>SignatureDoesNotMatch</Code></Error>" };
      }
      return { ok: true, status: 200, text: async () => "" };
    }
    if (init.headers.apikey !== "KEY") throw new Error("missing apikey header");
    if (url.endsWith("/uploads") && init.method === "POST") {
      const body = JSON.parse(init.body);
      if (typeof body.size_bytes !== "number" || !/^[0-9a-f]{32}$/.test(body.md5) || !body.filename) throw new Error("bad createUpload body");
      bytesSeen.md5b64 = Buffer.from(body.md5, "hex").toString("base64");
      return json(201, { id: "u-1", state: "created", presigned_url: "https://storage.example/put?sig=secret" });
    }
    if (url.endsWith("/uploads/u-1/finalise")) return json(200, { id: "u-1", state: "created" });
    if (url.endsWith("/uploads/u-1")) return json(200, { id: "u-1", state: states.shift() ?? "available" });
    if (url.endsWith("/mod-files/f-1/versions") && init.method === "POST") {
      const body = JSON.parse(init.body);
      for (const k of ["upload_id", "name", "version", "file_category"]) if (!body[k]) throw new Error(`missing ${k}`);
      return json(201, { file: { id: "f-1" }, version: { id: "v-new", position: "2" } });
    }
    return { ok: false, status: 404, text: async () => JSON.stringify({ title: "Not Found", detail: url }) };
  };
  return { fetchImpl, calls };
}

describe("nexusClient.uploadArchive", () => {
  it("creates, PUTs with the signed headers, finalises, waits for available", async () => {
    const { fetchImpl, calls } = fakeNexus({ stateSequence: ["created", "created", "available"] });
    const client = nexusClient({ apiKey: "KEY", fetchImpl, sleep: async () => undefined });
    const bytes = Buffer.from("zip bytes");
    const id = await client.uploadArchive({ bytes, filename: "event-horizon-0.1.151.zip" });
    expect(id).toBe("u-1");
    expect(calls).toEqual([
      "POST /uploads",
      "PUT https://storage.example/put?sig=secret",
      "POST /uploads/u-1/finalise",
      "GET /uploads/u-1",
      "GET /uploads/u-1",
      "GET /uploads/u-1",
    ]);
    expect(createHash("md5").update(bytes).digest("hex")).toHaveLength(32);
  });

  it("surfaces Nexus's problem details on an error", async () => {
    const client = nexusClient({ apiKey: "KEY", fetchImpl: async () => ({ ok: false, status: 403, text: async () => JSON.stringify({ title: "Forbidden", detail: "not your mod" }) }) });
    await expect(client.getMod("site", "2235")).rejects.toThrow(/403: Forbidden — not your mod/);
  });

  it("refuses to run without a key", () => {
    expect(() => nexusClient({ apiKey: "  " })).toThrow(/No Nexus API key/);
  });

  it("refuses a file name the signed header cannot carry, before creating the upload", async () => {
    const { fetchImpl, calls } = fakeNexus();
    const client = nexusClient({ apiKey: "KEY", fetchImpl, sleep: async () => undefined });
    await expect(client.uploadArchive({ bytes: Buffer.from("x"), filename: 'say "hi".zip' })).rejects.toThrow(/U\+0022.*nothing was uploaded/);
    expect(calls).toEqual([]);
  });
});

describe("assertHeaderSafeFilename", () => {
  it("accepts the names the release and the collections actually use", () => {
    expect(() => assertHeaderSafeFilename("event-horizon-0.1.151.zip")).not.toThrow();
    expect(() => assertHeaderSafeFilename("Ivy's Panties (1.0.19).ehcoll")).not.toThrow();
  });

  it("names the character that cannot go into Content-Disposition", () => {
    expect(() => assertHeaderSafeFilename("Meridia’s Panties.ehcoll")).toThrow(/character 8 \(U\+2019\)/);
    expect(() => assertHeaderSafeFilename("Café.ehcoll")).toThrow(/U\+00E9/);
    expect(() => assertHeaderSafeFilename("a\\b.zip")).toThrow(/U\+005C/);
  });
});

describe("backoffMs", () => {
  it("doubles from 2 s to a 2 min ceiling and never waits less than half of it", () => {
    expect(backoffMs(1, { random: () => 0 })).toBe(1000);
    expect(backoffMs(1, { random: () => 1 })).toBe(2000);
    expect(backoffMs(4, { random: () => 0 })).toBe(8000);
    expect(backoffMs(7, { random: () => 1 })).toBe(120_000);
    expect(backoffMs(30, { random: () => 0 })).toBe(60_000);
  });

  it("keeps a part trying for minutes over the default 10 attempts, not seconds", () => {
    const shortest = Array.from({ length: 9 }, (_, i) => backoffMs(i + 1, { random: () => 0 })).reduce((a, b) => a + b, 0);
    expect(shortest).toBeGreaterThanOrEqual(4 * 60 * 1000);
  });
});

// ── multipart ────────────────────────────────────────────────────────────

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "eh-nexus-release-"));
afterAll(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));
let fileSeq = 0;
/** A package file with no repeating 1000-byte window, so a swapped part is visible. */
function packageFile(size) {
  const bytes = Buffer.alloc(size);
  for (let i = 0; i < size; i += 1) bytes[i] = (i * 131 + (i >> 7) * 17 + 5) & 0xff;
  fileSeq += 1;
  const p = path.join(tmpRoot, `pkg-${fileSeq}.ehcoll`);
  fs.writeFileSync(p, bytes);
  return p;
}
const md5hex = (b) => createHash("md5").update(b).digest("hex");
const PART = 1000;
const apiJson = (status, data) => new Response(JSON.stringify({ data }), { status });
const EXPIRED = "<Error><Code>AccessDenied</Code><Message>Request has expired</Message></Error>";

/**
 * A strict fake of the multipart flow: the storage checks every part's bytes
 * and signed Content-MD5, answers with S3's ETags, and the completion only
 * succeeds with every part in order and its real ETag — the way S3 answers
 * InvalidPart otherwise. `put(n, init)` may replace a part's response.
 */
function fakeMultipart(file, { signed = "content-md5;host", put, complete } = {}) {
  const whole = fs.readFileSync(file);
  const nParts = Math.ceil(whole.length / PART);
  const partBytes = (n) => whole.subarray((n - 1) * PART, Math.min(whole.length, n * PART));
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(url);
    if (u.hostname === "api.nexusmods.com") {
      calls.push(`${init.method} ${u.pathname.replace("/v3", "")}`);
      if (init.headers.apikey !== "KEY") throw new Error("missing apikey header");
      if (u.pathname === "/v3/uploads/multipart") {
        const body = JSON.parse(init.body);
        if (body.size_bytes !== whole.length || typeof body.filename !== "string") throw new Error("bad multipart create body");
        return apiJson(201, {
          id: "u-1",
          state: "created",
          part_size_bytes: PART,
          complete_presigned_url: "https://storage.example/complete?X-Amz-Signature=s",
          part_presigned_urls: Array.from(
            { length: nParts },
            (_, i) => `https://storage.example/part/${i + 1}?X-Amz-SignedHeaders=${encodeURIComponent(signed)}&X-Amz-Signature=s`,
          ),
        });
      }
      if (u.pathname === "/v3/uploads/u-1/finalise") return apiJson(200, { id: "u-1", state: "created" });
      if (u.pathname === "/v3/uploads/u-1") return apiJson(200, { id: "u-1", state: "available" });
      throw new Error(`unexpected API call ${init.method} ${u.pathname}`);
    }
    if (u.pathname.startsWith("/part/")) {
      const n = Number(u.pathname.split("/")[2]);
      calls.push(`PUT part ${n}`);
      const body = Buffer.from(init.body);
      if (!body.equals(partBytes(n))) throw new Error(`part ${n}: wrong bytes`);
      if (signed.includes("content-md5") && init.headers["content-md5"] !== createHash("md5").update(body).digest("base64")) {
        return new Response("<Error><Code>BadDigest</Code></Error>", { status: 400 });
      }
      const custom = put === undefined ? undefined : await put(n, init);
      return custom ?? new Response("", { status: 200, headers: { etag: `"${md5hex(body)}"` } });
    }
    if (u.pathname === "/complete") {
      calls.push("POST complete");
      const parts = [...String(init.body).matchAll(/<PartNumber>(\d+)<\/PartNumber><ETag>([^<]*)<\/ETag>/g)];
      const exact = parts.length === nParts && parts.every(([, n, e], i) => Number(n) === i + 1 && e.replace(/"/g, "") === md5hex(partBytes(i + 1)));
      if (!exact) return new Response("<Error><Code>InvalidPart</Code></Error>", { status: 200 });
      const composite = `${md5hex(Buffer.concat(parts.map((_, i) => createHash("md5").update(partBytes(i + 1)).digest())))}-${nParts}`;
      const xml = complete ? complete(composite) : `<CompleteMultipartUploadResult><ETag>&quot;${composite}&quot;</ETag></CompleteMultipartUploadResult>`;
      return new Response(xml, { status: 200 });
    }
    throw new Error(`unexpected URL ${url}`);
  };
  return { fetchImpl, calls, nParts };
}

const client4 = (fetchImpl, extra = {}) => nexusClient({ apiKey: "KEY", fetchImpl, sleep: async () => undefined, random: () => 0, ...extra });
const upload = (client, file, opts = {}) => client.uploadArchiveFromDisk({ filePath: file, filename: "pkg.ehcoll", multipartAbove: PART, pollMs: 1, ...opts });
const puts = (calls) => calls.filter((c) => c.startsWith("PUT")).sort();

describe("nexusClient.uploadArchiveFromDisk (multipart)", () => {
  it("verifies every part and the assembled object, logs the whole file's digests, then finalises", async () => {
    const file = packageFile(2500);
    const { fetchImpl, calls } = fakeMultipart(file);
    const log = [];
    const id = await upload(client4(fetchImpl), file, { onState: (m) => log.push(m) });
    expect(id).toBe("u-1");
    expect(calls[0]).toBe("POST /uploads/multipart");
    expect(puts(calls)).toEqual(["PUT part 1", "PUT part 2", "PUT part 3"]);
    expect(calls.slice(-3)).toEqual(["POST complete", "POST /uploads/u-1/finalise", "GET /uploads/u-1"]);
    const bytes = fs.readFileSync(file);
    const sha = createHash("sha256").update(bytes).digest("hex");
    expect(log.some((m) => m.includes(`md5 ${md5hex(bytes)}`) && m.includes(`sha256 ${sha}`))).toBe(true);
    expect(log.some((m) => /assembled object's ETag [0-9a-f]{32}-3 is the one the 3 verified parts make/.test(m))).toBe(true);
  });

  it("retries a part whose ETag is not the MD5 of the bytes sent", async () => {
    const file = packageFile(2500);
    let lied = false;
    const { fetchImpl, calls } = fakeMultipart(file, {
      put: async (n) => {
        if (n !== 2 || lied) return undefined;
        lied = true;
        return new Response("", { status: 200, headers: { etag: `"${"0".repeat(32)}"` } });
      },
    });
    const log = [];
    await expect(upload(client4(fetchImpl), file, { onState: (m) => log.push(m) })).resolves.toBe("u-1");
    expect(puts(calls)).toEqual(["PUT part 1", "PUT part 2", "PUT part 2", "PUT part 3"]);
    expect(log.some((m) => /part 2\/3 attempt 1\/10 failed: the storage's ETag 0{32} is not the MD5/.test(m))).toBe(true);
  });

  it("waits out a 15-second outage instead of giving up after 12 seconds", async () => {
    const file = packageFile(2500);
    let now = 0;
    const waits = [];
    const { fetchImpl } = fakeMultipart(file, {
      put: async (n) => {
        if (n === 1 && now < 15_000) throw new Error("ECONNRESET");
        return undefined;
      },
    });
    const client = client4(fetchImpl, { sleep: async (ms) => { waits.push(ms); now += ms; } });
    await expect(upload(client, file)).resolves.toBe("u-1");
    expect(waits.slice(0, 4)).toEqual([1000, 2000, 4000, 8000]);
  });

  it("stops every part when a presigned URL has expired: no retry, no new part, no completion", async () => {
    const file = packageFile(4500);
    let part2Settled = false;
    let part2Aborted = false;
    let markPart2InFlight;
    const part2InFlight = new Promise((resolve) => (markPart2InFlight = resolve));
    const { fetchImpl, calls } = fakeMultipart(file, {
      put: async (n, init) => {
        // Part 1 fails only once part 2 is mid-PUT, so the abort is exercised.
        if (n === 1) {
          await part2InFlight;
          return new Response(EXPIRED, { status: 403 });
        }
        if (n === 2) {
          markPart2InFlight();
          await new Promise((resolve) => {
            const t = setTimeout(resolve, 300);
            init.signal?.addEventListener("abort", () => {
              clearTimeout(t);
              resolve();
            });
          });
          part2Settled = true;
          part2Aborted = init.signal?.aborted === true;
          if (part2Aborted) throw new Error("aborted");
        }
        return undefined;
      },
    });
    const log = [];
    await expect(upload(client4(fetchImpl), file, { concurrency: 2, onState: (m) => log.push(m) })).rejects.toThrow(/presigned URL has expired/);
    expect(calls.filter((c) => c === "PUT part 1")).toHaveLength(1);
    expect(calls.some((c) => /PUT part [345]/.test(c))).toBe(false);
    expect(calls).not.toContain("POST complete");
    expect(calls).not.toContain("POST /uploads/u-1/finalise");
    expect(part2Settled).toBe(true); // nothing still in flight once it threw
    expect(part2Aborted).toBe(true); // the PUT in flight was cut off, not waited out
    expect(log.some((m) => /stopped with \d\/5 parts stored.*nothing was added to any mod page/.test(m))).toBe(true);
  });

  it("refuses a concurrency that would start no worker, before creating anything", async () => {
    const file = packageFile(2500);
    for (const concurrency of [Number("abc"), 0, 1.5]) {
      const { fetchImpl, calls } = fakeMultipart(file);
      await expect(upload(client4(fetchImpl), file, { concurrency })).rejects.toThrow(/concurrency must be a whole number of at least 1/);
      expect(calls).toEqual([]);
    }
  });

  it("refuses a non-ASCII file name before the multipart session exists", async () => {
    const file = packageFile(2500);
    const { fetchImpl, calls } = fakeMultipart(file);
    await expect(upload(client4(fetchImpl), file, { filename: "Meridia’s Panties.ehcoll" })).rejects.toThrow(/U\+2019/);
    expect(calls).toEqual([]);
  });

  it("fails a part that neither a signed Content-MD5 nor an MD5 ETag can verify", async () => {
    const file = packageFile(2500);
    const { fetchImpl, calls } = fakeMultipart(file, {
      signed: "host",
      put: async () => new Response("", { status: 200, headers: { etag: '"opaque-etag"' } }),
    });
    await expect(upload(client4(fetchImpl), file)).rejects.toThrow(/cannot be verified/);
    expect(calls).not.toContain("POST complete");
  });

  it("does not finalise when the assembled object is not what the verified parts make", async () => {
    const file = packageFile(2500);
    const { fetchImpl, calls } = fakeMultipart(file, {
      complete: () => `<CompleteMultipartUploadResult><ETag>"${"f".repeat(32)}-3"</ETag></CompleteMultipartUploadResult>`,
    });
    await expect(upload(client4(fetchImpl), file)).rejects.toThrow(/refusing to finalise upload u-1/);
    expect(calls).not.toContain("POST /uploads/u-1/finalise");
  });

  it("does not complete when the file changed on disk during the upload", async () => {
    const file = packageFile(2500);
    const { fetchImpl, calls } = fakeMultipart(file, {
      put: async (n) => {
        if (n === 3) fs.utimesSync(file, new Date(), new Date(Date.now() + 60_000));
        return undefined;
      },
    });
    await expect(upload(client4(fetchImpl), file)).rejects.toThrow(/changed on disk during the upload/);
    expect(calls).not.toContain("POST complete");
  });
});

describe("findMainFile", () => {
  const client = (files, versionsById) => ({
    getModFiles: async () => ({ mod_files: files }),
    getModFileVersions: async (id) => ({ versions: versionsById[id] ?? [] }),
  });

  it("picks the single active file whose newest version is main", async () => {
    const found = await findMainFile(
      client(
        [{ id: "f-1", name: "Event Horizon" }, { id: "f-2", name: "Old", is_active: true }],
        {
          "f-1": [
            { id: "v1", version: "0.1.0-alpha.149", category: "archived", uploaded_at: "2026-09-01" },
            { id: "v2", version: "0.1.0-alpha.150", category: "main", uploaded_at: "2026-09-11" },
          ],
          "f-2": [{ id: "v0", version: "0.0.1", category: "archived", uploaded_at: "2026-01-01" }],
        },
      ),
      "m-1",
    );
    expect(found.file.id).toBe("f-1");
    expect(found.latest.version).toBe("0.1.0-alpha.150");
  });

  it("uses the only chain even when its newest version was archived — the real page's state", async () => {
    // site/mods/2235 as the API returned it: alpha.94 archived, alpha.85 old_version, alpha.20 archived.
    const found = await findMainFile(
      client([{ id: "7906317", name: "Event Horizon 0.1.0 Alpha.20", is_active: false }], {
        "7906317": [
          { id: "v94", version: "0.1.2", category: "archived", position: "3.0", uploaded_at: "2026-09-07T01:40:24.000+00:00" },
          { id: "v85", version: "0.1.1", category: "old_version", position: "2.0", uploaded_at: "2026-09-06T23:08:20.000+00:00" },
          { id: "v20", version: "0.1.0", category: "archived", position: "1.0", uploaded_at: "2026-09-03T19:51:31.000+00:00" },
        ],
      }),
      "m",
    );
    expect(found.file.id).toBe("7906317");
    expect(found.latest.id).toBe("v94");
  });

  it("orders a chain by position, not by upload time", async () => {
    const found = await findMainFile(
      client([{ id: "f-1", name: "A" }], {
        "f-1": [
          { id: "moved-later", category: "main", position: "2.0", uploaded_at: "2026-01-01" },
          { id: "uploaded-later", category: "old_version", position: "1.0", uploaded_at: "2026-09-01" },
        ],
      }),
      "m",
    );
    expect(found.latest.id).toBe("moved-later");
  });

  it("refuses when there is no chain, or several and not exactly one in Main Files", async () => {
    await expect(findMainFile(client([{ id: "f-1", name: "A" }], { "f-1": [] }), "m")).rejects.toThrow(/0 chain/);
    const two = { "f-1": [{ id: "a", category: "main", uploaded_at: "1" }], "f-2": [{ id: "b", category: "main", uploaded_at: "1" }] };
    await expect(findMainFile(client([{ id: "f-1", name: "A" }, { id: "f-2", name: "B" }], two), "m")).rejects.toThrow(/2 with a main/);
  });
});
