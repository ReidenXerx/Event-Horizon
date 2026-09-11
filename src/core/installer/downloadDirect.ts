/**
 * ──────────────────────────────────────────────────────────────────────
 * Fetch a file from a direct link, resumably, and say what arrived.
 *
 * Used for "paste this link" when the link is the file itself rather than
 * a Nexus page. Packages run to gigabytes and home connections drop, so:
 *
 *   - the bytes go to `<dest>.part` and a second attempt continues from
 *     wherever the first stopped (HTTP Range; a server that ignores it
 *     answers 200 and the part is started over, never appended to);
 *   - the finished file is hashed and the SHA-256 returned, so the page's
 *     stated hash can be checked by eye and the install log can name what
 *     was actually installed (NS-4: integrity is its own pass);
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

import { AbortError, isAbort } from "../../utils/abortError";

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
  const request = args.request ?? defaultRequest;
  const partPath = `${args.destPath}.part`;
  await fs.promises.mkdir(path.dirname(args.destPath), { recursive: true });

  let existing = 0;
  try {
    existing = (await fs.promises.stat(partPath)).size;
  } catch {
    existing = 0;
  }

  const { res, url: finalUrl } = await open(request, args.url, existing, args.signal);
  const status = res.statusCode ?? 0;

  let append: boolean;
  let total: number | undefined;
  if (status === 206) {
    append = true;
    const range = /bytes \d+-\d+\/(\d+)/.exec(res.headers["content-range"] ?? "");
    total = range !== null ? Number(range[1]) : undefined;
  } else if (status === 200) {
    // The server ignored the Range (or there was none): start over.
    append = false;
    existing = 0;
    const len = Number(res.headers["content-length"]);
    total = Number.isFinite(len) && len > 0 ? len : undefined;
  } else if (status === 416) {
    // Nothing left to send: the part is already the whole file.
    res.resume();
    append = true;
    total = existing;
  } else {
    res.resume();
    throw new Error(`The link answered HTTP ${status}${res.statusMessage ? ` ${res.statusMessage}` : ""} (${finalUrl}).`);
  }

  if (status !== 416) {
    let received = existing;
    // Piped by hand rather than through stream.pipeline: pipeline DESTROYS
    // the file stream on error, dropping whatever it had buffered, and a
    // part that is shorter than what was received is the resume's starting
    // point. Ending the file stream instead flushes it, so the next attempt
    // continues from what actually reached the disk.
    const failure = await new Promise<unknown>((resolve) => {
      const out = fs.createWriteStream(partPath, { flags: append ? "a" : "w" });
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
  }

  const size = (await fs.promises.stat(partPath)).size;
  const sha256 = await hashFile(partPath, args.signal);
  await fs.promises.rm(args.destPath, { force: true });
  await fs.promises.rename(partPath, args.destPath);
  return { path: args.destPath, size, sha256, resumed: existing > 0 && status !== 200 };
}

function open(
  request: RequestImpl,
  url: string,
  from: number,
  signal: AbortSignal | undefined,
  hops = 0,
): Promise<{ res: http.IncomingMessage; url: string }> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(new AbortError("download cancelled"));
      return;
    }
    const headers: Record<string, string> = { "user-agent": "EventHorizon/collection-link" };
    if (from > 0) headers.range = `bytes=${from}-`;
    let req: http.ClientRequest;
    try {
      // No keep-alive pool: a gigabyte transfer gains nothing from one, and a
      // socket the far end dropped would otherwise be handed to the retry.
      req = request(url, { headers, agent: false }, (res) => {
        const status = res.statusCode ?? 0;
        const location = res.headers.location;
        if ([301, 302, 303, 307, 308].includes(status) && typeof location === "string") {
          res.resume();
          if (hops >= MAX_REDIRECTS) {
            reject(new Error(`The link redirects more than ${MAX_REDIRECTS} times.`));
            return;
          }
          let next: string;
          try {
            next = new URL(location, url).toString();
          } catch {
            reject(new Error(`The link redirected somewhere unreadable: ${location}`));
            return;
          }
          resolve(open(request, next, from, signal, hops + 1));
          return;
        }
        resolve({ res, url });
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
