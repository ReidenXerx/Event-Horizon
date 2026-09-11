/**
 * ──────────────────────────────────────────────────────────────────────
 * Publishing a release to Nexus Mods, so Vortex can auto-update it.
 *
 * Two facts decide the shape of this, both read out of Vortex's own bundle
 * (app.asar) rather than documentation:
 *
 *  1. Vortex auto-updates an installed extension only when the curated
 *     extension manifest (Nexus-Mods/Vortex-Backend, refreshed daily from
 *     Nexus) lists a NEWER version for the same modId.
 *  2. "Newer" is `!semver.gte(semver.coerce(installed), semver.coerce(listed))`.
 *     `semver.coerce` DROPS a prerelease suffix: 0.1.0-alpha.149 and
 *     0.1.0-alpha.150 both become 0.1.0, so no alpha release is ever offered as
 *     an update. Measured with semver 7.8.5; and none of the 807 listed
 *     extensions carries a prerelease version. Hence plain x.y.z only.
 *
 * The upload itself is Nexus API v3 (https://api.nexusmods.com/openapi.yaml):
 * create an upload session → PUT the bytes to the presigned URL (the
 * Content-Disposition and Content-MD5 headers are part of its signature) →
 * finalise → wait for `available` → add it as a new version of the existing
 * main file, archiving the previous one so the page keeps exactly one main
 * file.
 * ──────────────────────────────────────────────────────────────────────
 */

import { createHash } from "node:crypto";
import * as fs from "node:fs";
import { inflateRawSync } from "node:zlib";

export const API_BASE = "https://api.nexusmods.com/v3";
/** Single-part upload ceiling from the API docs; larger needs multipart. */
export const SINGLE_PART_LIMIT = 100 * 1024 * 1024;

// ── upload integrity ─────────────────────────────────────────────────────

/**
 * The presigned URL signs `Content-Disposition: attachment; filename="<name>"`
 * with the name from the create request, and an HTTP header value is a byte
 * string: undici throws on anything above U+00FF, and a quote or backslash
 * would end the quoted-string early. Checked BEFORE the upload session is
 * created, so a bad name costs nothing — measured before this guard, a name
 * with U+2019 created the multipart session and then died on the first PUT.
 * RFC 5987's `filename*=` is not an option: the header value is part of the
 * signature and the API documents only the plain form.
 */
export function assertHeaderSafeFilename(filename) {
  const s = String(filename ?? "");
  if (s.length === 0) throw new Error("The upload has no file name");
  const chars = [...s];
  const at = chars.findIndex((ch) => {
    const c = ch.codePointAt(0);
    return c < 0x20 || c > 0x7e || ch === '"' || ch === "\\";
  });
  if (at >= 0) {
    const code = chars[at].codePointAt(0).toString(16).toUpperCase().padStart(4, "0");
    throw new Error(
      `File name "${s}" cannot be uploaded: character ${at + 1} (U+${code}) cannot be sent in the signed ` +
        `Content-Disposition header (attachment; filename="<name>"), which takes printable ASCII without " or \\. ` +
        `Rename the file and run again; nothing was uploaded.`,
    );
  }
}

/**
 * MD5 and SHA-256 of a file in one streaming pass, with the size and mtime it
 * was read at. Refuses a file that changed while it was being read.
 */
export async function hashFile(filePath) {
  const before = await fs.promises.stat(filePath);
  const md5 = createHash("md5");
  const sha256 = createHash("sha256");
  let bytes = 0;
  await new Promise((resolve, reject) =>
    fs
      .createReadStream(filePath)
      .on("data", (chunk) => {
        md5.update(chunk);
        sha256.update(chunk);
        bytes += chunk.length;
      })
      .on("end", resolve)
      .on("error", reject),
  );
  const after = await fs.promises.stat(filePath);
  if (bytes !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs) {
    throw new Error(`${filePath} changed while it was being hashed (${before.size} bytes before, ${bytes} read, ${after.size} after); run again once nothing is writing it`);
  }
  return { size: bytes, mtimeMs: before.mtimeMs, md5: md5.digest("hex"), sha256: sha256.digest("hex") };
}

/**
 * Wait before retry `attempt` (1-based: the wait after the first failure is
 * attempt 1). Exponential from 2 s, capped at 2 min, with "equal jitter": at
 * least half the ceiling, so parallel parts do not retry in lockstep and a
 * short outage is always waited out. With the default 10 attempts a part
 * keeps trying for at least 4 minutes (at most ~8): the old 2+4+6 s schedule
 * gave up after 12 s, so a 15 s network drop killed a 10 GB upload.
 */
export function backoffMs(attempt, { baseMs = 2000, capMs = 120_000, random = Math.random } = {}) {
  const ceiling = Math.min(capMs, baseMs * 2 ** (attempt - 1));
  return Math.round(ceiling / 2 + random() * (ceiling / 2));
}

/** A part failure; `fatal` ones are not retried because the same request cannot succeed. */
class PartError extends Error {
  constructor(message, { fatal = false } = {}) {
    super(message);
    this.fatal = fatal;
  }
}

/** An ETag header or XML value without W/ and its quotes. */
function bareEtag(etag) {
  return String(etag).trim().replace(/^W\//, "").replace(/&quot;|&#34;/g, '"').replace(/^"(.*)"$/, "$1");
}

/** What a refused part PUT means, from S3's XML error body. */
function storageRefusal(status, text) {
  const code = /<Code>([^<]*)<\/Code>/.exec(text)?.[1];
  const message = /<Message>([^<]*)<\/Message>/.exec(text)?.[1];
  const detail = `HTTP ${status}${code ? ` ${code}` : ""}${message ? `: ${message}` : text ? ` ${text.slice(0, 300)}` : ""}`;
  if (status === 403 && /expired/i.test(text)) {
    return new PartError(
      `${detail} — the presigned URL has expired. Every part URL is signed when the upload is created, so no part of this ` +
        `session can be sent any more; run the command again for a new upload session`,
      { fatal: true },
    );
  }
  if (status === 403) return new PartError(`${detail} — the storage refused the signed request, and retrying the same URL cannot change that`, { fatal: true });
  return new PartError(detail);
}

// ── versions ─────────────────────────────────────────────────────────────

/** A release version Vortex can compare: digits only, no prerelease or build. */
export function isReleasableVersion(version) {
  return /^\d+\.\d+\.\d+$/.test(version);
}

/**
 * `semver.coerce` as Vortex uses it: the first `x`, `x.y` or `x.y.z` run of
 * digits, missing parts zero, everything else ignored. Returns [major, minor,
 * patch] or undefined when the string has no digits.
 */
export function coerceVersion(version) {
  const m = /(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(String(version ?? ""));
  if (m === null) return undefined;
  return [Number(m[1]), Number(m[2] ?? 0), Number(m[3] ?? 0)];
}

export function compareCoerced(a, b) {
  for (let i = 0; i < 3; i += 1) {
    if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  }
  return 0;
}

/**
 * Would Vortex offer `next` as an update to someone on `current`?
 * An unparseable current version (none published yet) is always superseded.
 */
export function vortexWouldOfferUpdate(current, next) {
  const n = coerceVersion(next);
  if (n === undefined) return false;
  const c = coerceVersion(current);
  return c === undefined || compareCoerced(c, n) < 0;
}

// ── the zip ──────────────────────────────────────────────────────────────

/**
 * Read one entry from a zip's central directory. Enough for `info.json`, which
 * is what Vortex reads from the archive ROOT.
 */
export function readZipEntry(buf, wanted) {
  const tail = Math.max(0, buf.length - 0xffff - 22);
  let eocd = -1;
  for (let i = buf.length - 22; i >= tail; i -= 1) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("not a zip: no end-of-central-directory record");
  const count = buf.readUInt16LE(eocd + 10);
  let at = buf.readUInt32LE(eocd + 16);
  for (let n = 0; n < count; n += 1) {
    if (buf.readUInt32LE(at) !== 0x02014b50) throw new Error("corrupt central directory");
    const method = buf.readUInt16LE(at + 10);
    const compressed = buf.readUInt32LE(at + 20);
    const nameLen = buf.readUInt16LE(at + 28);
    const extraLen = buf.readUInt16LE(at + 30);
    const commentLen = buf.readUInt16LE(at + 32);
    const localOffset = buf.readUInt32LE(at + 42);
    const name = buf.toString("utf8", at + 46, at + 46 + nameLen);
    if (name === wanted) {
      const lname = buf.readUInt16LE(localOffset + 26);
      const lextra = buf.readUInt16LE(localOffset + 28);
      const start = localOffset + 30 + lname + lextra;
      const data = buf.subarray(start, start + compressed);
      if (method === 0) return Buffer.from(data);
      if (method === 8) return inflateRawSync(data);
      throw new Error(`unsupported compression method ${method} for ${wanted}`);
    }
    at += 46 + nameLen + extraLen + commentLen;
  }
  return undefined;
}

// ── API ──────────────────────────────────────────────────────────────────

export class NexusApiError extends Error {
  constructor(method, path, status, body) {
    const detail =
      body && typeof body === "object"
        ? [body.title, body.detail].filter(Boolean).join(" — ")
        : String(body ?? "").slice(0, 400);
    super(`Nexus API ${method} ${path} → ${status}${detail ? `: ${detail}` : ""}`);
    this.status = status;
    this.body = body;
  }
}

export function nexusClient({ apiKey, fetchImpl = fetch, userAgent, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), random = Math.random }) {
  if (typeof apiKey !== "string" || apiKey.trim().length === 0) throw new Error("No Nexus API key");
  const call = async (method, path, body) => {
    const res = await fetchImpl(`${API_BASE}${path}`, {
      method,
      headers: {
        apikey: apiKey.trim(),
        accept: "application/json",
        ...(userAgent ? { "user-agent": userAgent } : {}),
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    let json;
    try {
      json = text.length > 0 ? JSON.parse(text) : undefined;
    } catch {
      json = text;
    }
    if (!res.ok) throw new NexusApiError(method, path, res.status, json);
    return json?.data;
  };

  return {
    getMod: (gameDomain, gameScopedId) => call("GET", `/games/${encodeURIComponent(gameDomain)}/mods/${encodeURIComponent(gameScopedId)}`),
    getModFiles: (modId) => call("GET", `/mods/${encodeURIComponent(modId)}/files`),
    getModFileVersions: (fileId) => call("GET", `/mod-files/${encodeURIComponent(fileId)}/versions`),

    /**
     * Upload bytes and wait until Nexus marks them `available`. Returns the
     * upload id. The presigned URL is never logged: it carries a signature.
     */
    async uploadArchive({ bytes, filename, onState = () => undefined, timeoutMs = 10 * 60 * 1000, pollMs = 2000 }) {
      assertHeaderSafeFilename(filename);
      if (bytes.length > SINGLE_PART_LIMIT) {
        throw new Error(`${filename} is ${bytes.length} bytes; single-part uploads stop at ${SINGLE_PART_LIMIT}. Multipart is not implemented.`);
      }
      const md5 = createHash("md5").update(bytes).digest();
      const created = await call("POST", "/uploads", {
        size_bytes: bytes.length,
        filename,
        md5: md5.toString("hex"),
      });
      if (!created?.id || !created?.presigned_url) throw new Error("Nexus did not return an upload id and presigned URL");
      onState(`created upload ${created.id}`);
      const put = await fetchImpl(created.presigned_url, {
        method: "PUT",
        // The presigned URL signs `content-disposition;content-md5;content-type;host`
        // (its X-Amz-SignedHeaders). The docs name only the first two; measured
        // against the live storage on 2026-09-11, only application/octet-stream
        // is accepted — application/zip and friends fail SignatureDoesNotMatch.
        headers: {
          "content-type": "application/octet-stream",
          "content-disposition": `attachment; filename="${filename}"`,
          "content-md5": md5.toString("base64"),
        },
        body: bytes,
      });
      if (!put.ok) {
        const text = await put.text().catch(() => "");
        throw new Error(`Uploading the bytes failed: HTTP ${put.status} ${text.slice(0, 400)}`);
      }
      onState("bytes uploaded");
      await call("POST", `/uploads/${encodeURIComponent(created.id)}/finalise`);
      onState("finalised");
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const upload = await call("GET", `/uploads/${encodeURIComponent(created.id)}`);
        onState(`state ${upload?.state}`);
        if (upload?.state === "available") return created.id;
        if (Date.now() > deadline) throw new Error(`Upload ${created.id} not available after ${timeoutMs} ms (last state ${upload?.state})`);
        await sleep(pollMs);
      }
    },

    /**
     * Upload a file of any size from disk and wait until Nexus marks it
     * `available`. Returns the upload id. Above SINGLE_PART_LIMIT this is the
     * S3 multipart flow: one presigned PUT per `part_size_bytes` slice, the
     * ETag of each, a CompleteMultipartUpload XML POST, then finalise.
     *
     * Each part's presigned URL says which headers it signed
     * (X-Amz-SignedHeaders); only those are sent, so a URL that signs
     * `content-md5` gets that part's own digest and one that does not gets
     * nothing it would reject.
     *
     * Byte-exactness, part by part and as a whole:
     *  - every part's MD5 is computed from the buffer that is sent, and the
     *    storage's ETag for it (S3: the part's MD5) must equal it — a mismatch
     *    is retried like a dropped connection. A part that can be verified
     *    neither by a signed Content-MD5 nor by an MD5 ETag fails the upload.
     *  - the assembled object's ETag from CompleteMultipartUpload, when it has
     *    S3's `<md5 of the part digests>-<parts>` shape, must be the one the
     *    verified parts make, or the upload is not finalised.
     *  - the file must not change on disk between hashing and completion.
     *  - the whole file's MD5 and SHA-256 are logged. The MD5 is NOT sent at
     *    create: the multipart create body in openapi.yaml (CreateUploadRequest,
     *    read 2026-09-11) has only size_bytes and filename; the 2026-12-01 md5
     *    requirement is documented for the single-part create only.
     *
     * Failure: exponential backoff with jitter per part (see backoffMs); the
     * first part that fails for good stops every other worker and aborts the
     * PUTs in flight. There is no resume and no abort call: the API returns no
     * abort URL and no way to reopen a session, so a failed run is started
     * again, and nothing is added to a mod page by an unfinished upload.
     *
     * `digests` is hashFile's result when the caller already hashed the file;
     * `multipartAbove` exists so tests can exercise multipart with small files.
     */
    async uploadArchiveFromDisk({
      filePath,
      filename,
      onState = () => undefined,
      concurrency = 3,
      attempts = 10,
      timeoutMs = 30 * 60 * 1000,
      pollMs = 5000,
      digests,
      multipartAbove = SINGLE_PART_LIMIT,
    }) {
      if (!Number.isInteger(concurrency) || concurrency < 1) throw new Error(`concurrency must be a whole number of at least 1, not ${concurrency}`);
      if (!Number.isInteger(attempts) || attempts < 1) throw new Error(`attempts must be a whole number of at least 1, not ${attempts}`);
      assertHeaderSafeFilename(filename);
      const { size, mtimeMs } = await fs.promises.stat(filePath);
      if (size <= multipartAbove) {
        return this.uploadArchive({ bytes: await fs.promises.readFile(filePath), filename, onState, timeoutMs, pollMs });
      }
      let whole = digests;
      if (whole === undefined) {
        onState(`hashing ${filename} (md5, sha256)`);
        whole = await hashFile(filePath);
      }
      if (whole.size !== size || (whole.mtimeMs !== undefined && whole.mtimeMs !== mtimeMs)) {
        throw new Error(`${filename} changed after it was hashed (${whole.size} bytes hashed, ${size} now); nothing was uploaded`);
      }
      onState(`whole file: ${size} bytes, md5 ${whole.md5}, sha256 ${whole.sha256} (the md5 is not sent: the multipart create request has no md5 field; every part is verified instead)`);
      const created = await call("POST", "/uploads/multipart", { size_bytes: size, filename });
      const partSize = Number(created?.part_size_bytes);
      const urls = created?.part_presigned_urls;
      if (!created?.id || !Array.isArray(urls) || !Number.isFinite(partSize) || partSize <= 0 || !created?.complete_presigned_url) {
        throw new Error("Nexus did not return a multipart upload (id, part size, part URLs, complete URL)");
      }
      const expected = Math.ceil(size / partSize);
      if (urls.length !== expected) throw new Error(`Nexus returned ${urls.length} part URLs for ${expected} parts of ${partSize} bytes`);
      onState(`created multipart upload ${created.id}: ${expected} parts of ${partSize} bytes`);

      const fh = await fs.promises.open(filePath, "r");
      const etags = new Array(expected);
      const partDigests = new Array(expected);
      let everyEtagIsMd5 = true;
      let next = 0;
      let done = 0;
      // The first part that fails for good stops everything: no worker takes
      // another part, no retry waits it out, and the PUTs in flight are aborted.
      let failure;
      const controller = new AbortController();
      let wake;
      const stopped = new Promise((resolve) => (wake = resolve));
      const stop = (err) => {
        if (failure !== undefined) return;
        failure = err;
        controller.abort();
        wake();
      };

      const uploadPart = async (i) => {
        const offset = i * partSize;
        const length = Math.min(partSize, size - offset);
        const buf = Buffer.allocUnsafe(length);
        const { bytesRead } = await fh.read(buf, 0, length, offset);
        if (bytesRead !== length) throw new PartError(`short read at part ${i + 1}: ${bytesRead} of ${length} bytes`, { fatal: true });
        const digest = createHash("md5").update(buf).digest();
        const md5hex = digest.toString("hex");
        partDigests[i] = digest;
        const url = urls[i];
        const signed = (new URL(url).searchParams.get("X-Amz-SignedHeaders") ?? "host").toLowerCase().split(";");
        const headers = {};
        if (signed.includes("content-type")) headers["content-type"] = "application/octet-stream";
        if (signed.includes("content-disposition")) headers["content-disposition"] = `attachment; filename="${filename}"`;
        if (signed.includes("content-md5")) headers["content-md5"] = digest.toString("base64");
        if (signed.includes("content-length")) headers["content-length"] = String(length);
        for (let attempt = 1; ; attempt += 1) {
          if (failure !== undefined) return false;
          try {
            const res = await fetchImpl(url, { method: "PUT", headers, body: buf, signal: controller.signal });
            if (!res.ok) throw storageRefusal(res.status, await res.text().catch(() => ""));
            const etag = res.headers.get("etag");
            if (!etag) throw new PartError("no ETag in the response");
            const bare = bareEtag(etag);
            if (/^[0-9a-f]{32}$/i.test(bare)) {
              if (bare.toLowerCase() !== md5hex) throw new PartError(`the storage's ETag ${bare} is not the MD5 of the ${length} bytes sent (${md5hex})`);
            } else if (headers["content-md5"] !== undefined) {
              everyEtagIsMd5 = false; // storage checked the signed Content-MD5 itself
            } else {
              throw new PartError(
                `part ${i + 1} cannot be verified: its URL does not sign Content-MD5 and the storage's ETag "${bare}" is not an MD5`,
                { fatal: true },
              );
            }
            etags[i] = etag;
            return true;
          } catch (err) {
            if (failure !== undefined) return false; // aborted because another part failed
            const fatal = err instanceof PartError && err.fatal;
            onState(`part ${i + 1}/${expected} attempt ${attempt}/${attempts} failed${fatal ? " (not retryable)" : ""}: ${err.message}`);
            if (fatal) throw new PartError(`Part ${i + 1}/${expected}: ${err.message}`, { fatal: true });
            if (attempt >= attempts) throw new PartError(`Part ${i + 1}/${expected} failed after ${attempts} attempts: ${err.message}`);
            const wait = backoffMs(attempt, { random });
            onState(`part ${i + 1}/${expected}: retrying in ${(wait / 1000).toFixed(1)} s`);
            await Promise.race([sleep(wait), stopped]);
          }
        }
      };

      const worker = async () => {
        while (failure === undefined) {
          const i = next;
          next += 1;
          if (i >= expected) return;
          try {
            if (!(await uploadPart(i))) return;
          } catch (err) {
            stop(err);
            return;
          }
          done += 1;
          onState(`part ${i + 1}/${expected} uploaded and verified (${done}/${expected} done)`);
        }
      };
      try {
        // Workers never reject; awaiting all of them means none is still
        // PUTting when this function returns or throws.
        await Promise.all(Array.from({ length: Math.min(concurrency, expected) }, worker));
      } finally {
        await fh.close();
      }
      if (failure !== undefined) {
        onState(
          `upload ${created.id} stopped with ${done}/${expected} parts stored. The API has no resume or abort for a multipart upload, ` +
            `so this session is abandoned; nothing was added to any mod page. Run the command again.`,
        );
        throw failure;
      }
      for (let i = 0; i < expected; i += 1) {
        if (typeof etags[i] !== "string") throw new Error(`Part ${i + 1}/${expected} has no ETag; refusing to complete upload ${created.id}`);
      }
      const now = await fs.promises.stat(filePath);
      if (now.size !== size || now.mtimeMs !== mtimeMs) {
        throw new Error(`${filename} changed on disk during the upload (${size} → ${now.size} bytes, mtime moved: ${now.mtimeMs !== mtimeMs}); refusing to complete upload ${created.id}`);
      }
      const xml =
        "<CompleteMultipartUpload>" +
        etags.map((e, i) => `<Part><PartNumber>${i + 1}</PartNumber><ETag>${e.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</ETag></Part>`).join("") +
        "</CompleteMultipartUpload>";
      const completed = await fetchImpl(created.complete_presigned_url, { method: "POST", headers: { "content-type": "application/xml" }, body: xml });
      const completedText = await completed.text().catch(() => "");
      // S3 answers 200 to a failed completion too, with <Error> in the body.
      if (!completed.ok || /<Error>/i.test(completedText)) {
        throw new Error(`Completing the multipart upload failed: HTTP ${completed.status} ${completedText.slice(0, 400)}`);
      }
      // S3's object ETag for a multipart upload is the MD5 of the concatenated
      // part digests, a dash, and the part count.
      const composite = `${createHash("md5").update(Buffer.concat(partDigests)).digest("hex")}-${expected}`;
      const returned = /<ETag>([^<]*)<\/ETag>/i.exec(completedText)?.[1];
      const assembled = returned === undefined ? undefined : bareEtag(returned);
      if (everyEtagIsMd5 && assembled !== undefined && /^[0-9a-f]{32}-\d+$/i.test(assembled)) {
        if (assembled.toLowerCase() !== composite) {
          throw new Error(`The storage assembled an object with ETag ${assembled}, but the verified parts make ${composite}; refusing to finalise upload ${created.id}`);
        }
        onState(`multipart completed; the assembled object's ETag ${assembled} is the one the ${expected} verified parts make`);
      } else {
        onState(`multipart completed; the assembled object was not cross-checked (${assembled === undefined ? "no ETag returned" : `ETag "${assembled}"`}), each of the ${expected} parts was`);
      }
      await call("POST", `/uploads/${encodeURIComponent(created.id)}/finalise`);
      onState("finalised");
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const upload = await call("GET", `/uploads/${encodeURIComponent(created.id)}`);
        onState(`state ${upload?.state}`);
        if (upload?.state === "available") return created.id;
        if (Date.now() > deadline) throw new Error(`Upload ${created.id} not available after ${timeoutMs} ms (last state ${upload?.state})`);
        await sleep(pollMs);
      }
    },

    /** A brand-new file on a mod page (not a new version of an existing file). */
    createModFile: (body) => call("POST", "/mod-files", body),
    createModFileVersion: (fileId, body) => call("POST", `/mod-files/${encodeURIComponent(fileId)}/versions`, body),
    addChangelog: (modId, version, changelog) => call("POST", `/mods/${encodeURIComponent(modId)}/changelogs`, { version, changelog }),
  };
}

/** A version's place in its chain: Nexus's `position` ("3.0"), falling back to upload time. */
function newestFirst(a, b) {
  const pa = Number(a.position);
  const pb = Number(b.position);
  if (Number.isFinite(pa) && Number.isFinite(pb) && pa !== pb) return pb - pa;
  return String(b.uploaded_at).localeCompare(String(a.uploaded_at));
}

/**
 * The file chain the extension ships in, with its newest version.
 *
 * In API v3 a "mod file" is an update chain; each upload is a version in it,
 * and archiving moves a version out of Main Files without leaving the chain.
 * Measured on site/mods/2235: one chain holding alpha.20 (archived),
 * alpha.85 (old_version) and alpha.94 (archived) — no main version at all,
 * which is still exactly the chain the next release belongs in.
 *
 * So: the only chain with versions is the target whatever its newest version's
 * category. With several, the one whose newest version is in Main Files; if
 * that is not exactly one, there is no correct target and this refuses.
 */
export async function findMainFile(client, modId) {
  const files = (await client.getModFiles(modId))?.mod_files ?? [];
  const chains = [];
  for (const file of files) {
    const versions = (await client.getModFileVersions(file.id))?.versions ?? [];
    if (versions.length === 0) continue;
    chains.push({ file, latest: [...versions].sort(newestFirst)[0], versions });
  }
  if (chains.length === 1) return chains[0];
  const main = chains.filter((c) => c.latest.category === "main");
  if (main.length === 1) return main[0];
  const listing = chains.map((c) => `${c.file.name} (${c.file.id}, newest ${c.latest.version} ${c.latest.category})`).join("; ") || "none";
  throw new Error(
    `Cannot tell which file chain on the mod page is the extension's: ${chains.length} chain(s) with versions, ${main.length} with a main version. Chains: ${listing}`,
  );
}
