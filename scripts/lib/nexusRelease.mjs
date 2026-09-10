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
import { inflateRawSync } from "node:zlib";

export const API_BASE = "https://api.nexusmods.com/v3";
/** Single-part upload ceiling from the API docs; larger needs multipart. */
export const SINGLE_PART_LIMIT = 100 * 1024 * 1024;

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

export function nexusClient({ apiKey, fetchImpl = fetch, userAgent, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
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
        headers: {
          "content-disposition": `attachment; filename="${filename}"`,
          "content-md5": md5.toString("base64"),
          "content-length": String(bytes.length),
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

    createModFileVersion: (fileId, body) => call("POST", `/mod-files/${encodeURIComponent(fileId)}/versions`, body),
    addChangelog: (modId, version, changelog) => call("POST", `/mods/${encodeURIComponent(modId)}/changelogs`, { version, changelog }),
  };
}

/**
 * The one active main file on the page, with its newest version.
 *
 * Nexus's review rule is exactly one file under Main Files; with none or
 * several there is no correct target, so this refuses rather than guesses.
 */
export async function findMainFile(client, modId) {
  const files = (await client.getModFiles(modId))?.mod_files ?? [];
  const candidates = [];
  for (const file of files) {
    if (file.is_active === false) continue;
    const versions = (await client.getModFileVersions(file.id))?.versions ?? [];
    const latest = [...versions].sort((a, b) => String(b.uploaded_at).localeCompare(String(a.uploaded_at)))[0];
    if (latest?.category === "main") candidates.push({ file, latest, versions });
  }
  if (candidates.length !== 1) {
    const listing = files.map((f) => `${f.name} (${f.id})`).join(", ") || "none";
    throw new Error(`Expected exactly one active main file on the mod page, found ${candidates.length}. Files: ${listing}`);
  }
  return candidates[0];
}
