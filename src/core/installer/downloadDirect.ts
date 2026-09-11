/**
 * ──────────────────────────────────────────────────────────────────────
 * Fetch a file from a direct link, resumably, and say what arrived.
 *
 * Used for "paste this link" when the link is the file itself rather than
 * a Nexus page. Packages run to gigabytes and home connections drop, so:
 *
 *   - the bytes go to `<dest>.part` and a second attempt continues from
 *     wherever the first stopped (HTTP Range);
 *   - a part is continued only when it provably belongs to the same file:
 *     `<dest>.part.json` records the link, the server's version tag (ETag or
 *     Last-Modified) and the size, the tag goes out as If-Range, and every
 *     answer is checked against the part — a 206 must start exactly where
 *     the part ends, a 416 is "done" only when the part IS the whole file.
 *     Anything else discards the part and starts over (NS-1: two different
 *     files stitched together are not a package, however quickly they came);
 *   - the finished file is hashed and the SHA-256 returned, so the page's
 *     stated hash can be checked and the install log can name what was
 *     actually installed (NS-4: integrity is its own pass);
 *   - cancellation destroys the socket and keeps the part for next time.
 *
 * Node's http/https are used rather than the renderer's fetch: the renderer
 * applies CORS to cross-origin responses and a file host has no reason to
 * send the headers that would allow it.
 * ──────────────────────────────────────────────────────────────────────
 */

import { createHash } from "crypto";
import * as fs from "fs";
import * as http from "http";
import * as https from "https";
import * as path from "path";

import { ehLog } from "../logging/ehLog";
import { AbortError, isAbort } from "../../utils/abortError";
import { insecureLinkReason } from "./installLink";

export type DownloadProgress = {
  /** Bytes on disk so far, including what an earlier attempt left. */
  received: number;
  /** Total size when the server said; undefined when it did not. */
  total?: number;
};

export type DownloadedFile = {
  path: string;
  size: number;
  sha256: string;
  /** True when this run continued a part left by an earlier one. */
  resumed: boolean;
};

export type RequestImpl = (
  url: string,
  options: { headers: Record<string, string>; agent: false },
  onResponse: (res: http.IncomingMessage) => void,
) => http.ClientRequest;

const defaultRequest: RequestImpl = (url, options, onResponse) =>
  (url.startsWith("https:") ? https : http).request(url, options, onResponse);

const MAX_REDIRECTS = 5;

/** What `<part>.json` records about the bytes in `<part>`. */
type PartRecord = {
  /** The link the part was fetched from, as given (before redirects). */
  url: string;
  /** The response's strong ETag, sent back as If-Range. */
  etag?: string;
  /** The response's Last-Modified, the If-Range fallback. */
  lastModified?: string;
  /** Size of the whole file, when the server said. */
  total?: number;
};

/**
 * Download `url` to `destPath`.
 *
 * `onProgress` fires on every chunk with the running byte count; the caller
 * throttles its own rendering. Rejects with `AbortError` on cancel, and
 * with a plain Error naming the HTTP status otherwise.
 */
export async function downloadToFile(args: {
  url: string;
  destPath: string;
  signal?: AbortSignal;
  onProgress?: (p: DownloadProgress) => void;
  request?: RequestImpl;
}): Promise<DownloadedFile> {
  const partPath = `${args.destPath}.part`;
  // A cancelled run's file stream flushes AFTER the cancel returns; a new run
  // that opened the part before that flush would count bytes the old one was
  // still writing. One run per part, the next waits for the last to let go.
  const release = await lockPart(partPath);
  try {
    return await download(args, partPath);
  } finally {
    release();
  }
}

async function download(
  args: Parameters<typeof downloadToFile>[0],
  partPath: string,
): Promise<DownloadedFile> {
  const request = args.request ?? defaultRequest;
  await fs.promises.mkdir(path.dirname(args.destPath), { recursive: true });

  const part = await readPart(partPath);
  let existing = 0;
  let record = part.record;
  if (part.size > 0) {
    const refusal = resumeRefusal(part.size, part.record, args.url);
    if (refusal === undefined) {
      existing = part.size;
    } else {
      ehLog("info", "link.direct.part-discarded", { file: path.basename(partPath), partSize: part.size, why: refusal });
      await discardPart(partPath);
      record = undefined;
    }
  }
  ehLog("info", "link.direct.start", {
    host: hostOf(args.url),
    file: path.basename(args.destPath),
    partSize: part.size,
    resumeFrom: existing,
  });

  let resumed = false;
  let total: number | undefined;
  for (let attempt = 1; ; attempt += 1) {
    const ifRange = existing > 0 ? (record?.etag ?? record?.lastModified) : undefined;
    const opened = await openRange(
      request,
      args.url,
      existing > 0 ? `bytes=${existing}-` : undefined,
      args.signal,
      ifRange,
    );
    const { res } = opened;
    ehLog("info", "link.direct.response", {
      status: res.statusCode,
      contentRange: headerOf(res, "content-range"),
      contentLength: headerOf(res, "content-length"),
      finalHost: hostOf(opened.url),
      redirects: opened.hops.length,
      ...(opened.hops.length > 0 ? { redirectHosts: opened.hops } : {}),
      attempt,
    });
    const plan = planResponse(res, existing, record, args.url, opened.url);
    if (plan.kind === "fail") {
      res.resume();
      throw new Error(plan.message);
    }
    if (plan.kind === "restart") {
      res.resume();
      res.destroy();
      ehLog("warn", "link.direct.restart", { why: plan.why, partSize: existing, attempt });
      await discardPart(partPath);
      existing = 0;
      record = undefined;
      if (attempt >= 2) {
        throw new Error(
          `The server's answers about this file do not fit together (${plan.why}), even after starting over. Try the link again later.`,
        );
      }
      continue;
    }
    if (plan.kind === "complete") {
      res.resume();
      resumed = true;
      total = plan.total;
      break;
    }

    // plan.kind === "body"
    if (!plan.append && existing > 0) {
      ehLog("info", "link.direct.restart", {
        why: "the server sent the whole file (the Range was ignored, or If-Range saw a different version)",
        partSize: existing,
        attempt,
      });
      existing = 0;
    }
    resumed = plan.append;
    total = plan.total;
    record = plan.record;
    await writeRecord(partPath, record);

    let received = existing;
    // Piped by hand rather than through stream.pipeline: pipeline DESTROYS
    // the file stream on error, dropping whatever it had buffered, and a
    // part that is shorter than what was received is the resume's starting
    // point. Ending the file stream instead flushes it, so the next attempt
    // continues from what actually reached the disk.
    const failure = await new Promise<unknown>((resolve) => {
      const out = fs.createWriteStream(partPath, { flags: plan.append ? "a" : "w" });
      let failed: unknown;
      const onAbort = (): void => {
        res.destroy(new AbortError("download cancelled"));
      };
      args.signal?.addEventListener("abort", onAbort, { once: true });
      res.on("data", (chunk: Buffer) => {
        received += chunk.length;
        args.onProgress?.({ received, ...(total !== undefined ? { total } : {}) });
      });
      res.on("error", (err) => {
        failed = failed ?? err;
      });
      res.on("close", () => {
        if (!res.complete) {
          failed = failed ?? new Error("connection closed");
          out.end();
        }
      });
      out.on("error", (err) => {
        failed = failed ?? err;
        res.destroy();
      });
      out.on("close", () => {
        args.signal?.removeEventListener("abort", onAbort);
        resolve(failed);
      });
      res.pipe(out);
    });
    if (failure !== undefined) {
      if (isAbort(failure, args.signal)) {
        throw new AbortError("download cancelled");
      }
      // A connection that dropped mid-body is the resumable case, and the
      // message says so; the socket error underneath ("socket hang up",
      // ECONNRESET) would send someone diagnosing their network instead.
      if (total !== undefined && received < total) {
        throw new Error(
          `The connection closed after ${received} of ${total} bytes. Paste the link again to continue from there.`,
        );
      }
      throw failure instanceof Error ? failure : new Error(String(failure));
    }
    if (total !== undefined && received !== total) {
      throw new Error(
        `The connection closed after ${received} of ${total} bytes. Paste the link again to continue from there.`,
      );
    }
    break;
  }

  const size = (await fs.promises.stat(partPath)).size;
  if (total !== undefined && size !== total) {
    // The byte count said whole and the disk disagrees: never call it done.
    await discardPart(partPath);
    throw new Error(`The part on disk is ${size} bytes and the file is ${total}; it was discarded. Paste the link again.`);
  }
  const sha256 = await hashFile(partPath, args.signal);
  await fs.promises.rm(args.destPath, { force: true });
  await fs.promises.rename(partPath, args.destPath);
  await fs.promises.rm(recordPath(partPath), { force: true });
  return { path: args.destPath, size, sha256, resumed };
}

type ResponsePlan =
  | { kind: "body"; append: boolean; total?: number; record: PartRecord }
  | { kind: "complete"; total: number }
  | { kind: "restart"; why: string }
  | { kind: "fail"; message: string };

/** What an answer means for the part, before a byte of it is written. */
function planResponse(
  res: http.IncomingMessage,
  existing: number,
  record: PartRecord | undefined,
  url: string,
  finalUrl: string,
): ResponsePlan {
  const status = res.statusCode ?? 0;
  const etag = strongEtag(headerOf(res, "etag"));
  const lastModified = headerOf(res, "last-modified");
  const contentRange = (headerOf(res, "content-range") ?? "").trim();

  if (status === 200) {
    const len = Number(headerOf(res, "content-length"));
    const total = Number.isSafeInteger(len) && len > 0 ? len : undefined;
    return {
      kind: "body",
      append: false,
      ...(total !== undefined ? { total } : {}),
      record: { url, ...(etag !== undefined ? { etag } : {}), ...(lastModified !== undefined ? { lastModified } : {}), ...(total !== undefined ? { total } : {}) },
    };
  }

  if (status === 206) {
    const m = /^bytes (\d+)-(\d+)\/(\d+|\*)$/.exec(contentRange);
    if (m === null) return { kind: "restart", why: `unreadable Content-Range "${contentRange.slice(0, 60)}"` };
    const start = Number(m[1]);
    const total = m[3] === "*" ? undefined : Number(m[3]);
    if (start !== existing) {
      return { kind: "restart", why: `the server sent bytes from offset ${start}, and the part holds ${existing}` };
    }
    if (existing > 0) {
      if (record?.total !== undefined && total !== undefined && total !== record.total) {
        return { kind: "restart", why: `the file is ${total} bytes now, and the part was for ${record.total}` };
      }
      // A server that ignores If-Range but still names its version: a new
      // tag on the continuation is a different file.
      if (record?.etag !== undefined && etag !== undefined && etag !== record.etag) {
        return { kind: "restart", why: "the server's version tag (ETag) changed since the part was written" };
      }
      if (record?.etag === undefined && record?.lastModified !== undefined && lastModified !== undefined && lastModified !== record.lastModified) {
        return { kind: "restart", why: "the file's Last-Modified changed since the part was written" };
      }
    }
    const merged: PartRecord = {
      url,
      ...((etag ?? record?.etag) !== undefined ? { etag: etag ?? record?.etag } : {}),
      ...((lastModified ?? record?.lastModified) !== undefined ? { lastModified: lastModified ?? record?.lastModified } : {}),
      ...((total ?? record?.total) !== undefined ? { total: total ?? record?.total } : {}),
    };
    return { kind: "body", append: existing > 0, ...(merged.total !== undefined ? { total: merged.total } : {}), record: merged };
  }

  if (status === 416 && existing > 0) {
    // "Nothing left to send" is only true when the part is exactly the file.
    const m = /^bytes \*\/(\d+)$/.exec(contentRange);
    const size = m !== null ? Number(m[1]) : undefined;
    if (size !== undefined && size === existing && (record?.total === undefined || record.total === size)) {
      return { kind: "complete", total: size };
    }
    return {
      kind: "restart",
      why:
        size === undefined
          ? `the server refused the range without saying how large the file is (part holds ${existing})`
          : `the server says the file is ${size} bytes, and the part holds ${existing}`,
    };
  }

  return {
    kind: "fail",
    message: `The link answered HTTP ${status}${res.statusMessage ? ` ${res.statusMessage}` : ""} (${finalUrl}).`,
  };
}

/** Why a part on disk cannot be continued, or undefined when it can. */
function resumeRefusal(size: number, record: PartRecord | undefined, url: string): string | undefined {
  if (record === undefined) return "nothing records which link the part came from";
  if (record.url !== url) return "the part was downloaded from a different link";
  if (record.etag === undefined && record.lastModified === undefined) {
    return "the server named no version (ETag or Last-Modified) for it, so a changed file could not be told apart";
  }
  if (record.total !== undefined && size > record.total) {
    return `the part (${size} bytes) is larger than the file (${record.total})`;
  }
  return undefined;
}

function recordPath(partPath: string): string {
  return `${partPath}.json`;
}

async function readPart(partPath: string): Promise<{ size: number; record?: PartRecord }> {
  let size = 0;
  try {
    const st = await fs.promises.stat(partPath);
    // Not a file (a folder someone made): nothing to continue, and nothing
    // of ours to delete. Opening it for writing reports the real problem.
    size = st.isFile() ? st.size : 0;
  } catch {
    size = 0;
  }
  try {
    const parsed = JSON.parse(await fs.promises.readFile(recordPath(partPath), "utf8")) as Partial<PartRecord>;
    const ok =
      parsed !== null &&
      typeof parsed === "object" &&
      typeof parsed.url === "string" &&
      (parsed.etag === undefined || typeof parsed.etag === "string") &&
      (parsed.lastModified === undefined || typeof parsed.lastModified === "string") &&
      (parsed.total === undefined || (typeof parsed.total === "number" && Number.isSafeInteger(parsed.total)));
    return ok ? { size, record: parsed as PartRecord } : { size };
  } catch {
    return { size };
  }
}

async function writeRecord(partPath: string, record: PartRecord): Promise<void> {
  await fs.promises.writeFile(recordPath(partPath), JSON.stringify(record), "utf8");
}

async function discardPart(partPath: string): Promise<void> {
  await fs.promises.rm(partPath, { force: true });
  await fs.promises.rm(recordPath(partPath), { force: true });
}

const partLocks = new Map<string, Promise<void>>();

async function lockPart(partPath: string): Promise<() => void> {
  const resolved = path.resolve(partPath);
  const key = process.platform === "win32" ? resolved.toLowerCase() : resolved;
  for (;;) {
    const held = partLocks.get(key);
    if (held === undefined) break;
    await held;
  }
  let release!: () => void;
  const mine = new Promise<void>((resolve) => {
    release = resolve;
  });
  partLocks.set(key, mine);
  return (): void => {
    if (partLocks.get(key) === mine) partLocks.delete(key);
    release();
  };
}

function strongEtag(value: string | undefined): string | undefined {
  // A weak tag (W/"...") may not be used in If-Range: it promises
  // equivalent content, not identical bytes.
  return value !== undefined && value.length > 0 && !value.startsWith("W/") ? value : undefined;
}

function headerOf(res: http.IncomingMessage, name: string): string | undefined {
  const v = res.headers[name];
  if (Array.isArray(v)) return v[0];
  return typeof v === "string" ? v : undefined;
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "(unreadable)";
  }
}

/**
 * The file name the server would give the download, from Content-Disposition,
 * read with a one-byte Range request. Undefined when the server names nothing
 * or does not answer; the caller then names the file after the link.
 */
export async function probeFileName(
  url: string,
  signal?: AbortSignal,
  request: RequestImpl = defaultRequest,
): Promise<string | undefined> {
  let opened: { res: http.IncomingMessage; url: string };
  try {
    opened = await openRange(request, url, "bytes=0-0", signal);
  } catch {
    return undefined;
  }
  const { res } = opened;
  res.resume();
  res.destroy();
  const header = res.headers["content-disposition"];
  if (typeof header !== "string") return undefined;
  const star = /filename\*=(?:UTF-8|utf-8)''([^;]+)/.exec(header);
  if (star !== null) {
    try {
      return decodeURIComponent(star[1].trim());
    } catch {
      /* fall through to the plain form */
    }
  }
  const plain = /filename="?([^";]+)"?/.exec(header);
  return plain !== null ? plain[1].trim() : undefined;
}

function openRange(
  request: RequestImpl,
  url: string,
  range: string | undefined,
  signal: AbortSignal | undefined,
  ifRange?: string,
  hops: string[] = [],
): Promise<{ res: http.IncomingMessage; url: string; hops: string[] }> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(new AbortError("download cancelled"));
      return;
    }
    if (hops.length === 0) {
      let start: URL;
      try {
        start = new URL(url);
      } catch {
        reject(new Error("That is not a link."));
        return;
      }
      const insecure = insecureLinkReason(start);
      if (insecure !== undefined) {
        reject(new Error(insecure));
        return;
      }
    }
    const headers: Record<string, string> = { "user-agent": "EventHorizon/collection-link" };
    if (range !== undefined) headers.range = range;
    // "Send the rest only if it is still this version; otherwise the whole
    // file." Without it a changed file's tail is appended to the old head.
    if (range !== undefined && ifRange !== undefined) headers["if-range"] = ifRange;
    let req: http.ClientRequest;
    try {
      // No keep-alive pool: a gigabyte transfer gains nothing from one, and a
      // socket the far end dropped would otherwise be handed to the retry.
      req = request(url, { headers, agent: false }, (res) => {
        const status = res.statusCode ?? 0;
        const location = res.headers.location;
        if ([301, 302, 303, 307, 308].includes(status) && typeof location === "string") {
          res.resume();
          if (hops.length >= MAX_REDIRECTS) {
            reject(new Error(`The link redirects more than ${MAX_REDIRECTS} times.`));
            return;
          }
          let next: URL;
          try {
            next = new URL(location, url);
          } catch {
            reject(new Error("The link redirected somewhere unreadable."));
            return;
          }
          // An https link that redirects to plain http has handed the bytes
          // to anyone on the path; the https the user saw proves nothing then.
          if (next.protocol === "http:" && new URL(url).protocol === "https:") {
            reject(
              new Error(
                `The link redirected from https to plain http (${next.host}), and a package fetched over plain http ` +
                  "can be altered on the way. Refused; ask whoever published the link for one that stays on https.",
              ),
            );
            return;
          }
          const insecure = insecureLinkReason(next);
          if (insecure !== undefined) {
            reject(new Error(`The link redirected to ${next.host || next.protocol}: ${insecure}`));
            return;
          }
          resolve(openRange(request, next.toString(), range, signal, ifRange, [...hops, next.host]));
          return;
        }
        resolve({ res, url, hops });
      });
    } catch (err) {
      reject(err);
      return;
    }
    const onAbort = (): void => {
      req.destroy(new AbortError("download cancelled"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    req.on("error", (err) => {
      signal?.removeEventListener("abort", onAbort);
      reject(signal?.aborted === true ? new AbortError("download cancelled") : err);
    });
    req.on("response", () => signal?.removeEventListener("abort", onAbort));
    req.end();
  });
}

async function hashFile(filePath: string, signal?: AbortSignal): Promise<string> {
  const hash = createHash("sha256");
  const stream = fs.createReadStream(filePath);
  const onAbort = (): void => {
    stream.destroy(new AbortError("download cancelled"));
  };
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    for await (const chunk of stream) hash.update(chunk as Buffer);
  } finally {
    signal?.removeEventListener("abort", onAbort);
  }
  return hash.digest("hex");
}
